const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('./config.js');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function findLlamaServer() {
    if (process.env.LLAMA_SERVER_BIN) return process.env.LLAMA_SERVER_BIN;
    const candidates = ['llama-server', 'llama-server.exe', 'server'];
    for (const name of candidates) {
        try {
            const which = process.platform === 'win32' ? 'where' : 'which';
            const found = execFileSync(which, [name], { stdio: ['ignore', 'pipe', 'ignore'] })
                .toString().trim().split(/\r?\n/)[0];
            if (found) return found;
        } catch (e) { }
    }
    return null;
}

function httpJson(method, url, body, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('http://') ? http : require('https');
        const u = new URL(url);
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = mod.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method,
            headers: payload ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            } : {}
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                } catch (e) {
                    resolve(text);
                }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Manages a local llama-server process serving the Hy-MT2 GGUF model and
 * exposes a translation() helper using the OpenAI-compatible endpoint.
 */
class LlamaServer {
    constructor(options = {}) {
        this.bin = options.bin || findLlamaServer();
        this.modelPath = options.modelPath || config.MODEL_PATH;
        this.port = options.port || config.LLAMA_PORT;
        this.baseUrl = options.baseUrl || config.LLAMA_BASE_URL || `http://127.0.0.1:${this.port}`;
        this.external = Boolean(options.baseUrl || config.LLAMA_BASE_URL);
        this.gpuLayers = options.gpuLayers !== undefined ? options.gpuLayers : Number.parseInt(process.env.NGL || '-1', 10);
        this.threads = options.threads || Number.parseInt(process.env.THREADS || '0', 10) || 0;
        this.proc = null;
        this.logTail = [];
    }

    isUp() {
        return httpJson('GET', `${this.baseUrl}/health`, null, 3000)
            .then((r) => {
                const status = r && r.status;
                return status === 'ok' || status === 'no slot available';
            })
            .catch(() => false);
    }

    async start(options = {}) {
        if (await this.isUp()) return true;
        if (this.external) {
            throw new Error(`llama-server not reachable at ${this.baseUrl}`);
        }
        if (!this.bin) {
            throw new Error('llama-server binary not found. Install it (pkg install llama-cpp) or set LLAMA_SERVER_BIN.');
        }

        const args = [
            '-m', this.modelPath,
            '--port', String(this.port),
            '--host', '127.0.0.1',
            '--ctx-size', String(options.ctxSize || 4096),
            '-np', String(options.parallel || config.CONCURRENCY),
            '--no-warmup'
        ];

        if (this.gpuLayers >= 0) args.push('-ngl', String(this.gpuLayers));
        if (this.threads > 0) args.push('-t', String(this.threads));

        this.proc = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const capture = (chunk) => {
            const line = chunk.toString();
            this.logTail.push(line);
            if (this.logTail.length > 60) this.logTail.shift();
            if (options.verbose) process.stderr.write(line);
        };
        this.proc.stdout.on('data', capture);
        this.proc.stderr.on('data', capture);
        this.proc.on('error', (err) => {
            this.logTail.push(`spawn error: ${err.message}`);
        });
        this.proc.on('exit', (code) => {
            this.logTail.push(`exited with code ${code}`);
            this.proc = null;
        });

        const deadline = Date.now() + (options.startupTimeoutMs || 180000);
        while (Date.now() < deadline) {
            if (this.proc === null) {
                throw new Error(`llama-server exited during startup:\n${this.logTail.join('').slice(-2000)}`);
            }
            if (await this.isUp()) return true;
            await sleep(700);
        }
        await this.stop();
        throw new Error(`llama-server did not become ready in time:\n${this.logTail.join('').slice(-2000)}`);
    }

    async stop() {
        if (this.proc) {
            const proc = this.proc;
            this.proc = null;
            proc.kill('SIGTERM');
            await sleep(1500);
            try {
                proc.kill('SIGKILL');
            } catch (e) { }
        }
    }

    /**
     * Translate a batch of texts. Sends one request per chunk of lines using
     * the Hy-MT2 default translation prompt. Returns an array of strings in
     * the same order as the input.
     */
    async translate(texts, options = {}) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        const targetLang = options.targetLang || config.TARGET_LANG;
        const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');

        const prompt = [
            `Translate the following ${texts.length} numbered lines into ${targetLang}.`,
            `Note that you should only output the translated result for each line without any additional explanation, keeping the same numbering.`,
            '',
            numbered
        ].join('\n');

        const body = {
            prompt,
            n_predict: options.maxTokens || config.N_PREDICT,
            temperature: options.temperature !== undefined ? options.temperature : 0.2,
            top_p: 0.6,
            top_k: 20,
            repeat_penalty: 1.05,
            stop: ['\n\n', `\\n${texts.length + 1}.`]
        };

        const res = await httpJson('POST', `${this.baseUrl}/completion`, body, options.timeoutMs || 300000);

        const content = typeof res === 'string' ? res : (res.content || res.response || '');
        return parseNumbered(content, texts.length, texts);
    }
}

/**
 * Parse "1. foo\n2. bar" style model output back into an array. Falls back to
 * the original text for any line the model skipped, and handles models that
 * answer with a bare list (no numbering).
 */
function parseNumbered(content, expected, originals) {
    const out = new Array(expected).fill(null);
    const lines = String(content || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
        const m = line.match(/^(\d+)\s*[.)\-–:]\s*(.*)$/);
        if (m) {
            const idx = Number(m[1]) - 1;
            if (idx >= 0 && idx < expected && m[2]) out[idx] = m[2];
        }
    }

    const numberedCount = out.filter(Boolean).length;
    if (numberedCount < expected) {
        const bare = lines.filter((l) => !/^\d+\s*[.)\-–:]/.test(l));
        if (bare.length === expected) {
            for (let i = 0; i < expected; i++) out[i] = bare[i];
        }
    }

    for (let i = 0; i < expected; i++) {
        if (!out[i]) out[i] = originals[i];
    }
    return out;
}

module.exports = { LlamaServer, findLlamaServer, parseNumbered, httpJson };
