const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const config = require('./config.js');

function statOrNull(p) {
    try {
        return fs.statSync(p);
    } catch (e) {
        return null;
    }
}

/** First 4 bytes of a GGUF file must be the magic — a cheap corruption check. */
function hasGgufMagic(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        return buf.toString('latin1') === 'GGUF';
    } catch (e) {
        return false;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { } }
    }
}

/**
 * `ready` only when the size matches the expected byte count exactly AND the
 * file opens as a GGUF. Anything else is partial or corrupt — both of which
 * mean "download it again", never "hand it to llama-server".
 */
function modelStatus(flavor) {
    const spec = config.resolveModel(flavor);
    const expected = spec.bytes;
    const st = statOrNull(spec.path);
    if (!st) return { state: 'missing', path: spec.path, bytes: 0, total: expected };
    if (expected > 0 && st.size !== expected) {
        const state = st.size < expected ? 'partial' : 'corrupt';
        return { state, path: spec.path, bytes: st.size, total: expected };
    }
    if (!hasGgufMagic(spec.path)) {
        return { state: 'corrupt', path: spec.path, bytes: st.size, total: expected };
    }
    return { state: 'ready', path: spec.path, bytes: st.size, total: expected };
}

function whisperStatus() {
    const st = statOrNull(config.WHISPER_PATH);
    if (!st) return { state: 'missing', path: config.WHISPER_PATH, bytes: 0 };
    return { state: 'ready', path: config.WHISPER_PATH, bytes: st.size };
}

function fetchResponse(url, headers = {}, redirects = 5, attempts = 0) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('http://') ? http : https;
        const req = mod.get(url, { headers }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                resolve(fetchResponse(next, headers, redirects - 1, attempts));
                return;
            }
            if (status !== 200 && status !== 206) {
                res.resume();
                if ((status === 5 || status >= 500) && attempts < 3) {
                    setTimeout(() => {
                        resolve(fetchResponse(url, headers, redirects, attempts + 1));
                    }, 1500 * (attempts + 1));
                    return;
                }
                reject(new Error(`HTTP ${status} for ${url}`));
                return;
            }
            resolve(res);
        });
        req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
        req.on('error', (err) => {
            if (attempts < 3) {
                setTimeout(() => {
                    resolve(fetchResponse(url, headers, redirects, attempts + 1));
                }, 1500 * (attempts + 1));
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Download a file with resume support. Appends to a .part file until the
 * expected byte count is reached, then atomically renames into place.
 */
async function downloadFile(url, destPath, options = {}) {
    const total = options.totalBytes || 0;
    const onProgress = options.onProgress || (() => { });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const partPath = `${destPath}.part`;
    let offset = 0;
    const existing = statOrNull(partPath);
    if (existing && existing.size > 0) {
        offset = existing.size;
        if (total && offset === total) {
            fs.renameSync(partPath, destPath);
            onProgress(total, total);
            return destPath;
        }
        if (total && offset > total) {
            // a .part that overshot: promoting it would ship a corrupt file
            try { fs.unlinkSync(partPath); } catch (e) { }
            offset = 0;
        }
    }

    const headers = { 'User-Agent': config.USER_AGENT };
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    const res = await fetchResponse(url, headers);
    let mode = offset > 0 && res.statusCode === 206 ? 'a' : 'w';
    if (mode === 'w') offset = 0;

    // a 206 that does not start exactly where we asked would splice the file
    // into nonsense (right size, wrong bytes) — that is what broke the model
    if (mode === 'a') {
        const m = /bytes\s+(\d+)-/.exec(String(res.headers['content-range'] || ''));
        if (!m || Number(m[1]) !== offset) {
            res.resume();
            try { fs.unlinkSync(partPath); } catch (e) { }
            return downloadFile(url, destPath, options);
        }
    }

    const out = fs.createWriteStream(partPath, { flags: mode });
    let received = offset;
    res.on('data', (chunk) => {
        received += chunk.length;
        onProgress(received, total);
    });

    let streamError = null;
    try {
        await pipeline(res, out);
    } catch (err) {
        // premature close / socket abort: fall through to the size check so the
        // caller gets an actionable "incomplete download" message instead.
        streamError = err;
    }

    const finalSize = (statOrNull(partPath) || {}).size || 0;
    if (streamError) {
        throw new Error(`incomplete download: ${finalSize}/${total || '?'} bytes (${streamError.message})`);
    }
    if (total && finalSize < total) {
        throw new Error(`incomplete download: ${finalSize}/${total} bytes`);
    }
    if (total && finalSize > total) {
        // never leave an oversized .part behind: the next run would promote it
        try { fs.unlinkSync(partPath); } catch (e) { }
        throw new Error(`download too large: ${finalSize} > ${total} bytes`);
    }
    fs.renameSync(partPath, destPath);
    onProgress(finalSize, total || finalSize);
    return destPath;
}

async function downloadModel(options = {}) {
    const spec = config.resolveModel(options.flavor);
    const status = modelStatus(options.flavor);
    if (status.state === 'ready') return status;
    config.ensureDirs();
    if (status.state === 'corrupt') {
        // start from a clean slate rather than resume around bad bytes
        for (const f of [spec.path, `${spec.path}.part`]) {
            try { fs.unlinkSync(f); } catch (e) { }
        }
    }
    return downloadFile(spec.url, spec.path, {
        totalBytes: spec.bytes,
        onProgress: options.onProgress
    }).then(() => modelStatus(options.flavor));
}

async function downloadWhisperModel(options = {}) {
    const status = whisperStatus();
    if (status.state === 'ready') return status;
    config.ensureDirs();
    return downloadFile(config.WHISPER_URL, config.WHISPER_PATH, {
        onProgress: options.onProgress
    }).then(() => whisperStatus());
}

module.exports = {
    modelStatus,
    whisperStatus,
    downloadFile,
    downloadModel,
    downloadWhisperModel
};
