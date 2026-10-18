#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const config = require('../src/config.js');
const { modelStatus, whisperStatus, downloadModel, downloadWhisperModel } = require('../src/model.js');
const { LlamaServer, findLlamaServer } = require('../src/llama.js');
const { findWhisper, transcribeMedia } = require('../src/asr.js');
const { processVideo, findSubtitleSource, outputPathFor, isDone } = require('../src/pipeline.js');
const { walkMedia, JobQueue, watchFolder } = require('../src/watcher.js');
const { startStatusServer } = require('../src/status-server.js');
const { logDecision, readDecisions } = require('../src/decision-log.js');
const { parseSRT, validateSRT, normalizeToUtf8, buildSRT } = require('../src/srt.js');
const { buildASS } = require('../src/ass.js');
const { translateTexts } = require('../src/translate.js');
const audio = require('../src/audio.js');
const Bazaar = require('../src/providers/index.js');
const embeddedProvider = require('../src/providers/embedded.js');
const providerHealth = require('../src/provider-health.js');
const { parseRelease } = require('../src/release.js');
const langsInfo = require('../src/langs.js');

function parseArgs(argv) {
    const args = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                args.flags[key] = next;
                i++;
            } else {
                args.flags[key] = true;
            }
        } else {
            args._.push(token);
        }
    }
    return args;
}

function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function progressLine(label) {
    let lastPrint = 0;
    return (received, total) => {
        const now = Date.now();
        if (now - lastPrint < 500 && received !== total) return;
        lastPrint = now;
        const pct = total ? ((received / total) * 100).toFixed(1) : '?';
        process.stderr.write(`\r${label}: ${pct}% (${fmtBytes(received)}${total ? ` / ${fmtBytes(total)}` : ''})   `);
        if (total && received >= total) process.stderr.write('\n');
    };
}

/**
 * Progress for one or many downloads at once. Two parallel downloads must not
 * fight over the same carriage return, so every tracked row is painted as a
 * block that is redrawn in place (ANSI cursor-up) on a TTY. On a dumb terminal
 * each row is printed on its own line, throttled.
 *
 * `stop()` drops the cursor below the block so ordinary logging resumes cleanly.
 */
function multiProgress() {
    const rows = [];
    const byLabel = new Map();
    const tty = Boolean(process.stderr.isTTY);
    let painted = 0;
    let lastPaint = 0;

    function paint(force) {
        const now = Date.now();
        if (!force && now - lastPaint < (tty ? 200 : 1000)) return;
        lastPaint = now;
        let out = '';
        if (tty && painted > 0) out += `\x1b[${painted}A`;
        for (const row of rows) {
            const pct = row.total ? ((row.received / row.total) * 100).toFixed(1) : '?';
            const text = `${row.label}: ${pct}% (${fmtBytes(row.received)}${row.total ? ` / ${fmtBytes(row.total)}` : ''})`;
            out += tty ? `\x1b[2K${text}\n` : `${text}\n`;
        }
        process.stderr.write(out);
        painted = rows.length;
    }

    return {
        track(label) {
            let row = byLabel.get(label);
            if (!row) {
                row = { label, received: 0, total: 0, done: false };
                byLabel.set(label, row);
                rows.push(row);
            }
            return (received, total) => {
                row.received = received;
                if (total) row.total = total;
                const done = Boolean(row.total) && received >= row.total;
                if (done && row.done) return;
                row.done = done;
                paint(done);
            };
        },
        stop() {
            if (tty && painted > 0) process.stderr.write('\n');
            painted = 0;
        }
    };
}

/**
 * Run several downloads concurrently and collect each outcome instead of
 * throwing: the translation model and the whisper model are independent files,
 * so fetching them together finishes in about the time of the slower one.
 */
async function runDownloads(specs, progress) {
    return Promise.all(specs.map((spec) =>
        spec.run({ onProgress: progress.track(spec.label) })
            .then(() => ({ spec, ok: true }))
            .catch((error) => ({ spec, ok: false, error }))
    ));
}

async function cmdSetup(args) {
    config.ensureDirs();
    console.log(`[Setup] Arabic Subs v${config.VERSION}`);
    console.log(`[Setup] Home:        ${config.HOME}`);
    console.log(`[Setup] Model dir:   ${config.MODELS_DIR}`);

    const checks = [
        ['node', process.version],
        ['ffmpeg', audio.findFfmpeg() || null],
        ['llama-server', findLlamaServer() || null],
        ['whisper', findWhisper() || null]
    ];
    for (const [name, value] of checks) {
        console.log(`[Setup] ${name.padEnd(14)} ${value || 'NOT FOUND'}`);
    }

    const skipModel = Boolean(args.flags['skip-model']);
    const skipWhisper = Boolean(args.flags['skip-whisper']);

    console.log('[Setup] One model serves every path — subtitle translation and');
    console.log('[Setup] audio transcription both run through Hy-MT2:');

    const model = modelStatus();
    const whisper = whisperStatus();
    const specs = [];

    if (!skipModel) {
        if (model.state === 'ready') {
            console.log(`[Setup] ${config.MODEL_LABEL} already present (${fmtBytes(model.bytes)})`);
        } else {
            console.log(`[Setup] Downloading ${config.MODEL_LABEL} (~${fmtBytes(config.MODEL_BYTES)})`);
            console.log(`[Setup]   page:  ${config.MODEL_CARD}`);
            console.log(`[Setup]   file:  ${config.MODEL_REPO}`);
            specs.push({ label: '[Model]', run: (o) => downloadModel(o) });
        }
    }

    if (!skipWhisper) {
        if (whisper.state === 'ready') {
            console.log(`[Setup] Whisper model already present (${fmtBytes(whisper.bytes)})`);
        } else {
            console.log(`[Setup] Downloading whisper ggml-${config.WHISPER_MODEL} for the audio path (~150 MB)`);
            console.log(`[Setup]   page:  ${HF_WHISPER_REPO}`);
            specs.push({ label: '[Whisper]', run: (o) => downloadWhisperModel(o) });
        }
    }

    if (specs.length === 0) {
        console.log('[Setup] Nothing to download — everything is already in place.');
    } else {
        if (specs.length > 1) {
            console.log('[Setup] Fetching both models at once — resumable, so re-running');
            console.log('[Setup] picks up exactly where it stopped.');
        }
        const progress = multiProgress();
        const results = await runDownloads(specs, progress);
        progress.stop();

        let modelFailed = false;
        for (const { spec, ok, error } of results) {
            if (spec.label === '[Model]') {
                if (ok) {
                    console.log(`[Setup] Model ready: ${config.MODEL_PATH}`);
                } else {
                    modelFailed = true;
                    console.log(`[Setup] Model download failed: ${error.message}`);
                }
            } else if (ok) {
                console.log(`[Setup] Whisper model ready: ${config.WHISPER_PATH}`);
            } else {
                console.log(`[Setup] Whisper download failed: ${error.message} — the audio path stays disabled`);
            }
        }
        if (modelFailed) {
            console.log('[Setup] Re-run to resume: node bin/arabic-subs.js setup');
            return 1;
        }
    }

    console.log('[Setup] Done. Run: node bin/arabic-subs.js run --media /sdcard/Movies');
    return 0;
}

/**
 * Every source — an English subtitle, an embedded track, or whisper output —
 * is translated by the SAME model (Hy-MT2). Only the way we obtain the text
 * differs per video, so only ONE model ever needs to be on disk.
 *
 * Nothing is fetched silently: we list what is missing (with its Hugging Face
 * page) and ask the user for permission first, unless --yes was passed.
 */
const HF_MODEL_CARD = config.MODEL_CARD;
const HF_MODEL_REPO = config.MODEL_REPO;
const HF_WHISPER_REPO = 'https://huggingface.co/ggerganov/whisper.cpp';

/** The one line that installs/repairs everything — same string the app copies. */
const SETUP_ONE_LINER = 'pkg install -y curl; curl -fsSL -o ArabicSubs.sh '
    + 'https://raw.githubusercontent.com/muxd22-alt/arabic_subtitles/main/ArabicSubs.sh; bash ArabicSubs.sh';

function printSetupHint() {
    console.log('[Engine] Fix everything with one line:');
    console.log(`[Engine]   ${SETUP_ONE_LINER}`);
}

function isYes(value) {
    return value === true || value === 'true' || value === 'y' || value === 'yes';
}

/** Ask a y/N question on the terminal. Resolves 'y' | 'n' | null when there is no tty. */
function ask(question) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve(null);
        process.stdout.write(question);
        const onData = (buf) => {
            process.stdin.off('data', onData);
            process.stdin.pause();
            const text = buf.toString('utf8').trim().toLowerCase();
            resolve(text.startsWith('y') ? 'y' : 'n');
        };
        process.stdin.on('data', onData);
        process.stdin.resume();
    });
}

async function ensureDownloads(flags) {
    let model = modelStatus();
    let needModel = model.state !== 'ready';
    let needWhisper = Boolean(findWhisper()) && whisperStatus().state !== 'ready';

    // whisper-cli missing → offer the setup that builds it (y/N, never forced)
    if (!findWhisper() && flags['no-download'] !== true) {
        console.log('[Engine] whisper-cli not found — videos with no subtitle at all will be skipped.');
        if (await offerFullSetup(flags)) {
            console.log(findWhisper()
                ? '[Engine] whisper-cli installed.'
                : '[Engine] whisper-cli still missing — the audio path stays disabled.');
        }
        model = modelStatus();
        needModel = model.state !== 'ready';
        needWhisper = Boolean(findWhisper()) && whisperStatus().state !== 'ready';
    }

    if (!needModel && !needWhisper) return true;

    if (flags['no-download'] === true) {
        if (needModel) {
            console.log(`[Engine] Model not ready (${model.state}). Run: node bin/arabic-subs.js setup`);
            return false;
        }
        return true;
    }

    console.log('[Engine] Missing downloads:');
    if (needModel) {
        console.log(`[Engine]   ${config.MODEL_LABEL}  ${fmtBytes(config.MODEL_BYTES)}  ${HF_MODEL_REPO}`);
        if (model.state === 'corrupt') {
            console.log(`[Engine]   the file on disk is corrupt (${model.bytes} bytes) — it is deleted and fetched again`);
        } else if (model.state === 'partial') {
            console.log(`[Engine]   partially downloaded: ${model.bytes}/${model.total} bytes (resumes)`);
        }
        console.log(`[Engine]   model card: ${HF_MODEL_CARD}`);
        console.log('[Engine]   used for every path: subtitle translation and audio transcription alike');
    }
    if (needWhisper) {
        console.log(`[Engine]   whisper ggml-${config.WHISPER_MODEL}  ~150 MB  ${HF_WHISPER_REPO}`);
    }

    let allowed = isYes(flags.yes);
    if (!allowed) {
        const answer = await ask('[Engine] Download now? [y/N] ');
        if (answer === null) {
            console.log('[Engine] Nothing downloaded — no terminal to ask.');
            console.log('[Engine] Allow it with: node bin/arabic-subs.js run --media <dir> --yes');
            return !needModel;
        }
        allowed = answer === 'y';
    }

    if (!allowed) {
        console.log('[Engine] Download cancelled.');
        console.log('[Engine] Get them yourself: node bin/arabic-subs.js setup');
        return !needModel;
    }

    const specs = [];
    if (needModel) {
        console.log(`[Engine] Downloading ${config.MODEL_LABEL} from ${HF_MODEL_REPO} (resumable)…`);
        specs.push({ label: '[Model]', run: (o) => downloadModel(o) });
    }
    if (needWhisper) {
        console.log('[Engine] Downloading whisper model for the audio path…');
        specs.push({ label: '[Whisper]', run: (o) => downloadWhisperModel(o) });
    }
    if (specs.length > 1) {
        console.log('[Engine] Fetching both models at once — resumable, so a retry resumes.');
    }

    const progress = multiProgress();
    const results = await runDownloads(specs, progress);
    progress.stop();

    let modelOk = !needModel;
    for (const { spec, ok, error } of results) {
        if (spec.label === '[Model]') {
            if (ok) {
                modelOk = true;
                console.log(`[Engine] Model ready: ${config.MODEL_PATH}`);
            } else {
                modelOk = false;
                console.log(`[Engine] Model download failed: ${error.message}`);
                console.log('[Engine] Retry: node bin/arabic-subs.js setup   (resumes from where it stopped)');
            }
        } else if (ok) {
            console.log('[Engine] Whisper model ready.');
        } else {
            console.log(`[Engine] Whisper download failed: ${error.message} — audio path disabled for now`);
        }
    }

    return modelOk;
}

/** Start llama-server, translating the "binary not found" failure into a next step. */
async function runCommand(cmd, args, env) {
    const { spawn } = require('child_process');
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            stdio: 'inherit',
            env: env ? { ...process.env, ...env } : process.env
        });
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(typeof code === 'number' ? code : -1));
    });
}

/**
 * Run scripts/setup-termux.sh: installs the prebuilt engine, repairs a broken
 * cmake when a source build is needed, builds whisper.cpp and asks before the
 * model downloads. y/N, never forced, skipped entirely with --no-download.
 */
async function offerFullSetup(flags) {
    const setup = path.join(config.ROOT, 'scripts', 'setup-termux.sh');
    if (flags['no-download'] === true) return false;
    if (!fs.existsSync(setup)) {
        console.log(`[Engine] Setup script not found: ${setup}`);
        printSetupHint();
        return false;
    }
    if (!isYes(flags.yes)) {
        const answer = await ask('[Engine] Run the full setup now (installs the prebuilt llama-server + whisper)? [y/N] ');
        if (answer === null) {
            printSetupHint();
            return false;
        }
        if (answer !== 'y') return false;
    }
    console.log('[Engine] Running: bash scripts/setup-termux.sh');
    const code = await runCommand('bash', [setup]);
    if (code !== 0) {
        console.log(`[Engine] Setup exited with code ${code}.`);
        printSetupHint();
    }
    return code === 0;
}

/**
 * The model file can be perfect and the engine still refuse it — a stale or
 * missing llama-server. The setup installs the prebuilt engine (with a source
 * build as fallback), so offer it instead of asking the user to compile anything.
 */
async function offerEngineInstall(flags) {
    console.error('[Engine] llama-server could not load the model — the engine is missing,');
    console.error('[Engine] stale, or built without the right kernels.');

    const onTermux = Boolean(process.env.PREFIX) && process.platform !== 'win32';
    if (!onTermux) {
        console.error('[Engine] Install llama.cpp and put llama-server on PATH, or set LLAMA_SERVER_BIN.');
        return false;
    }

    const setup = path.join(config.ROOT, 'scripts', 'setup-termux.sh');
    if (!fs.existsSync(setup)) {
        printSetupHint();
        return false;
    }

    const answer = isYes(flags.yes) ? 'y'
        : await ask('[Engine] Install the prebuilt engine now (llama-server, ~16 MB)? [y/N] ');
    if (answer !== 'y') {
        console.log('[Engine] Install it later with:');
        console.log('[Engine]   bash scripts/setup-termux.sh');
        console.log('[Engine] Build from source instead (15-40 min):');
        console.log('[Engine]   ARABIC_SUBS_FORCE_LLAMA_BUILD=1 bash scripts/setup-termux.sh');
        return false;
    }

    console.log('[Engine] Running: bash scripts/setup-termux.sh');
    const code = await runCommand('bash', [setup, ...(isYes(flags.yes) ? ['--yes'] : [])], {
        ARABIC_SUBS_SKIP_UPDATE: '1'
    });
    if (code !== 0) {
        console.log(`[Engine] Setup exited with code ${code}.`);
        return false;
    }
    return Boolean(findLlamaServer());
}

/** llama-server runs the translation model; setup installs a prebuilt one. */
async function ensureLlamaServer(flags) {
    if (findLlamaServer()) return true;

    const onTermux = Boolean(process.env.PREFIX) && process.platform !== 'win32';
    console.log(`[Engine] llama-server is not installed yet — it runs ${config.MODEL_LABEL}.`);
    if (!onTermux) {
        console.log('[Engine] Install llama.cpp and put llama-server on PATH, or set LLAMA_SERVER_BIN.');
        printSetupHint();
        return false;
    }

    console.log('[Engine] Setup installs a prebuilt llama-server (~16 MB) — no compiling on the phone.');
    if (await offerFullSetup(flags) && findLlamaServer()) {
        console.log('[Engine] llama-server installed.');
        return true;
    }

    printSetupHint();
    return false;
}

/** llama-server refused the file on disk — fetch the model again and say how big it is. */
async function redownloadModel(flags) {
    const st = modelStatus();
    console.log(`[Engine] model on disk: ${st.state}, ${st.bytes} bytes (expected ${config.MODEL_BYTES})`);
    const answer = isYes(flags.yes) ? 'y'
        : await ask(`[Engine] Delete it and download ${config.MODEL_LABEL} again (${fmtBytes(config.MODEL_BYTES)}, resumable)? [y/N] `);
    if (answer !== 'y') return false;

    for (const f of [config.MODEL_PATH, `${config.MODEL_PATH}.part`]) {
        try { fs.unlinkSync(f); } catch (e) { }
    }
    console.log(`[Engine] Downloading ${config.MODEL_LABEL} from ${HF_MODEL_REPO} (resumable)…`);
    try {
        await downloadModel({ onProgress: progressLine('[Model]') });
        console.log(`[Engine] Model ready: ${config.MODEL_PATH}`);
        return true;
    } catch (err) {
        console.log(`[Engine] Model download failed: ${err.message}`);
        console.log('[Engine] Retry: node bin/arabic-subs.js setup   (resumes from where it stopped)');
        return false;
    }
}

async function startServer(flags, attempt = 0) {
    const server = new LlamaServer();
    console.log(`[Engine] Starting llama-server with ${config.MODEL_LABEL}…`);
    try {
        await server.start({ verbose: Boolean(flags.verbose) });
    } catch (err) {
        if (/binary not found/i.test(err.message)) {
            console.error('[Engine] llama-server is not installed yet.');
            console.error('[Engine] If cmake fails with a missing symbol, first run: pkg upgrade -y');
            printSetupHint();
            return null;
        }
        if (attempt === 0 && /gguf|tensor|failed to load model|error loading model|read tensor data|unknown model architecture/i.test(err.message)) {
            if (modelStatus().state === 'ready') {
                console.error(`[Engine] The model file is intact — llama-server cannot run ${config.MODEL_LABEL}.`);
                if (config.MODEL_ENGINE === 'stq') {
                    console.error('[Engine] The 1.25-bit flavour needs the STQ1_0 fork engine (PR #22836).');
                } else {
                    console.error('[Engine] A standard quant needs any recent llama.cpp — reinstalling the engine.');
                }
                if (await offerEngineInstall(flags)) return startServer(flags, 1);
            } else {
                console.error('[Engine] llama.cpp cannot read the model file — it is corrupt or truncated.');
                if (await redownloadModel(flags)) return startServer(flags, 1);
            }
            printSetupHint();
            return null;
        }
        throw err;
    }
    console.log(`[Engine] Ready at ${server.baseUrl}`);
    return server;
}

function isTruthyFlag(value) {
    return value === true || value === 'true' || value === '1' || value === 'yes';
}

/** The provider table in the shape Bazarr users already know. */
function providerTableLines(options = {}) {
    const rows = Bazaar.statusRows();
    const nameWidth = Math.max(20, ...rows.map((r) => String(r.name).length + 2));
    const lines = [
        `${'Name'.padEnd(nameWidth)}${'Status'.padEnd(18)}Next Retry`
    ];
    for (const row of rows) {
        lines.push(`${String(row.name).padEnd(nameWidth)}${String(row.status).padEnd(18)}${row.nextRetry}`);
        if (row.status !== 'Good' && row.lastError && options.explain !== false) {
            lines.push(`${' '.repeat(nameWidth)}↳ ${row.lastError}`);
        }
    }
    return lines;
}

function printProviderTable(options = {}) {
    console.log('[Providers] Free subtitle sources (local first, then the web):');
    for (const line of providerTableLines(options)) console.log(`  ${line}`);
    const missing = Bazaar.availability().filter((entry) => !entry.ok);
    if (missing.length > 0) {
        console.log('[Providers] Key-based providers stay off until you add their free keys to .env:');
        for (const entry of missing) {
            console.log(`  ${entry.provider.label}: ${entry.reason}`);
        }
    }
}

async function cmdProviders(args) {
    if (isTruthyFlag(args.flags.reset)) {
        const id = args.flags.reset === true ? null : String(args.flags.reset);
        providerHealth.reset(id);
        console.log(id ? `[Providers] Health reset for ${id}.` : '[Providers] Health reset for all providers.');
    }
    const rows = Bazaar.statusRows();
    const nameWidth = Math.max(20, ...rows.map((r) => String(r.name).length + 2));
    console.log(`${'Name'.padEnd(nameWidth)}${'Status'.padEnd(20)}Next Retry`);
    for (const row of rows) {
        console.log(`${String(row.name).padEnd(nameWidth)}${String(row.status).padEnd(20)}${row.nextRetry}`);
        if (row.lastError && row.status !== 'Good') {
            console.log(`${' '.repeat(nameWidth)}↳ ${row.lastError}`);
        }
    }
    const missing = Bazaar.availability().filter((entry) => !entry.ok);
    if (missing.length > 0) {
        console.log('\nNot configured (free, but needs an account key — add to .env):');
        for (const entry of missing) console.log(`  ${entry.provider.label}: ${entry.reason}`);
    }
    console.log(`\nHealth file: ${providerHealth.storePath()}`);
    return 0;
}

/**
 * `fetch` is the bazaar on its own: for each video it prints what every
 * provider offers, then (with --download) saves the best match next to the
 * video using the same name the local scan reads back.
 */
async function cmdFetch(args) {
    const files = args._.slice(1);
    if (files.length === 0) {
        console.error('Usage: arabic-subs fetch <video>… [--provider id] [--download] [--langs ar,en]');
        return 1;
    }
    const only = args.flags.provider ? [String(args.flags.provider)] : null;
    const sourceLanguages = args.flags.langs
        ? String(args.flags.langs).split(',').map((c) => c.trim()).filter(Boolean)
        : config.PROVIDER_LANGUAGES;

    let failures = 0;
    for (const file of files) {
        if (!fs.existsSync(file)) {
            console.error(`[Fetch] Not found: ${file}`);
            failures++;
            continue;
        }
        const release = parseRelease(file);
        const episode = release.season != null ? ` S${String(release.season).padStart(2, '0')}E${String(release.episode).padStart(2, '0')}` : '';
        console.log(`[Fetch] ${path.basename(file)} → "${release.title}"${release.year ? ` (${release.year})` : ''}${episode}` +
            `${release.imdb ? ` [${release.imdb}]` : ''}`);

        const search = await Bazaar.searchAll(release, { only, sourceLanguages });
        for (const [id, info] of Object.entries(search.perProvider)) {
            const note = info.error ? ` — ${info.error}` : (info.skipped ? ` — ${info.skipped}` : '');
            console.log(`  ${id.padEnd(18)} ${String(info.count).padStart(3)} candidate(s)${note}`);
        }

        const ranked = Bazaar.rankCandidates(search.candidates, release, { sourceLanguages });
        for (const candidate of ranked.slice(0, 12)) {
            const lang = `${candidate.langCode || 'und'}`.padEnd(5);
            console.log(`  • ${String(candidate.provider).padEnd(16)} ${lang} ${candidate.releaseName || ''}${candidate.downloads ? ` [${candidate.downloads} dl]` : ''}`);
        }
        if (ranked.length === 0) {
            console.log('  (the bazaar found nothing — the on-device transcript would be next)');
            failures++;
            continue;
        }

        if (isTruthyFlag(args.flags.download)) {
            const acquired = await Bazaar.acquire(release, { searchResult: search, sourceLanguages });
            if (acquired.ok) {
                const saved = Bazaar.saveSidecar(file, acquired.langCode, acquired.provider, acquired.cues);
                const note = acquired.langCode === 'ar' ? 'ready-made Arabic' : `translate from ${acquired.language}`;
                console.log(`  ↓ saved ${path.basename(saved)} (${acquired.provider}, ${acquired.cueCount || acquired.cues.length} cues) — ${note}`);
            } else {
                console.log(`  ↓ every download failed: ${(acquired.notes || []).slice(0, 3).join('; ')}`);
                failures++;
            }
        }
    }
    return failures > 0 ? 1 : 0;
}

async function cmdRun(args) {
    config.ensureDirs();

    const mediaArgs = [];
    if (args.flags.media) mediaArgs.push(String(args.flags.media));
    for (const positional of args._) {
        if (positional !== 'run') mediaArgs.push(positional);
    }
    if (mediaArgs.length === 0) mediaArgs.push('/sdcard/Movies');

    if (!(await ensureDownloads(args.flags))) return 1;
    if (!(await ensureLlamaServer(args.flags))) return 1;

    const useProviders = !isTruthyFlag(args.flags['no-providers']) && !isTruthyFlag(args.flags['no-fetch']);
    const useEmbedded = !isTruthyFlag(args.flags['no-embedded']);
    const once = isTruthyFlag(args.flags.once);

    printProviderTable();

    const server = await startServer(args.flags);
    if (!server) return 1;

    const queue = new JobQueue({
        concurrency: config.JOB_CONCURRENCY,
        process: async (file) => {
            return processVideo(file, {
                server,
                providers: useProviders,
                embedded: useEmbedded,
                onNote: (line) => console.log(line),
                onStage: (s) => console.log(`[Stage] ${path.basename(file)} → ${s.stage}${s.source ? ` (${s.source})` : ''}${s.cueCount ? ` (${s.cueCount} cues)` : ''}`),
                onProgress: (p) => {
                    if (p.stage === 'extract') {
                        process.stderr.write(`\r[ASR] extract ${p.done}/${p.total}   `);
                        if (p.done === p.total) process.stderr.write('\n');
                    } else if (p.stage === 'transcribe') {
                        process.stderr.write(`\r[ASR] ${p.done}/${p.total} chunks   `);
                        if (p.done === p.total) process.stderr.write('\n');
                    } else if (p.total) {
                        process.stderr.write(`\r[Translate] ${p.done}/${p.total} lines   `);
                        if (p.done === p.total) process.stderr.write('\n');
                    }
                }
            });
        }
    });

    const watchers = [];
    for (const dir of mediaArgs) {
        if (!fs.existsSync(dir)) {
            console.warn(`[Engine] Media folder not found, skipping: ${dir}`);
            continue;
        }
        console.log(`[Engine] Watching ${dir}`);
        watchers.push(watchFolder(dir, queue, {
            intervalMs: Number.parseInt(args.flags['scan-interval'], 10) || 15000,
            onScan: (r) => console.log(
                `[Library] ${r.dir}: ${r.total} video(s) — ${r.done} done, ${r.fresh} new` +
                (r.changed ? `, ${r.changed} re-queued (new subtitle)` : '')
            )
        }));
    }

    if (watchers.length === 0) {
        console.error('[Engine] No valid media folders.');
        await server.stop();
        return 1;
    }

    if (once) {
        for (const w of watchers) w.stop();
        console.log('[Engine] --once: scanning everything, then exiting.');
        await queue.whenIdle();
        const finalStatus = queue.status();
        console.log(`[Library] finished — done: ${finalStatus.done}, failed: ${finalStatus.failed}`);
        await server.stop();
        return finalStatus.failed > 0 ? 1 : 0;
    }

    const state = () => ({
        engine: 'running',
        model: modelStatus().state,
        server: 'up',
        queue: queue.status(),
        media: mediaArgs,
        uptimeSec: Math.round(process.uptime())
    });

    let statusHandle = null;
    const noStatus = args.flags['no-status'] === true || args.flags['no-status'] === 'true';
    if (!noStatus) {
        try {
            statusHandle = await startStatusServer(state, { port: config.STATUS_PORT });
            console.log(`[Engine] Status API: http://127.0.0.1:${statusHandle.port}/status`);
        } catch (e) {
            console.warn(`[Engine] Status API unavailable: ${e.message}`);
        }
    }

    queue.onEvent((event) => {
        if (event.type === 'start') console.log(`[Queue] → ${path.basename(event.file)} (${event.pending} waiting)`);
        if (event.type === 'done') {
            const r = event.result || {};
            console.log(`[Queue] ✓ ${path.basename(event.file)} [${r.status || 'ok'}]`);
        }
        if (event.type === 'error') console.error(`[Queue] ✗ ${path.basename(event.file)}: ${event.error}`);
    });

    const shutdown = async () => {
        console.log('\n[Engine] Shutting down…');
        for (const w of watchers) w.stop();
        if (statusHandle) await statusHandle.close();
        await server.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log(`[Engine] Working on ${config.JOB_CONCURRENCY} video(s) at once — ` +
        `each translating ${config.CONCURRENCY} chunks, ${config.LLAMA_PARALLEL} engine slots.`);
    console.log('[Engine] Running. Press Ctrl+C to stop.');
    return new Promise(() => { });
}

async function cmdTranslate(args) {
    const files = args._.slice(1);
    if (files.length === 0) {
        console.error('Usage: arabic-subs translate <file.srt> [more.srt…]');
        return 1;
    }

    if (!(await ensureDownloads(args.flags))) return 1;
    if (!(await ensureLlamaServer(args.flags))) return 1;

    const server = await startServer(args.flags);
    if (!server) return 1;

    try {
        for (const file of files) {
            const raw = fs.readFileSync(file);
            const { text } = normalizeToUtf8(raw);
            const validation = validateSRT(text);
            if (!validation.ok) {
                console.error(`[Translate] ${file}: invalid SRT (${validation.reason})`);
                continue;
            }

            console.log(`[Translate] ${file}: ${validation.cues.length} cues`);
            const { texts, stats } = await translateTexts(
                validation.cues.map((c) => c.text),
                server,
                {
                    onProgress: (p) => {
                        if (p.done === p.total) console.log(`[Translate] ${p.done}/${p.total} lines`);
                    }
                }
            );

            const translatedCues = validation.cues.map((cue, i) => ({
                start: cue.start,
                end: cue.end,
                text: texts[i]
            }));

            const out = args.flags.out
                ? String(args.flags.out)
                : file.replace(/(\.srt)?$/i, '.ar.ass');
            fs.writeFileSync(out, buildASS(translatedCues), 'utf8');
            logDecision({ file, action: 'translate-cli', source: file, cueCount: translatedCues.length, output: out, chunks: stats.batches });
            console.log(`[Translate] → ${out}`);
        }
    } finally {
        await server.stop();
    }
    return 0;
}

async function cmdTranscribe(args) {
    const files = args._.slice(1);
    if (files.length === 0) {
        console.error('Usage: arabic-subs transcribe <media file> [--out out.srt]');
        return 1;
    }
    if (!findWhisper()) {
        console.error('[ASR] whisper binary not found (pkg install / build whisper.cpp, or set WHISPER_BIN)');
        return 1;
    }
    for (const file of files) {
        console.log(`[ASR] Transcribing ${file}…`);
        const durationMs = await audio.probeDurationMs(file);
        if (!durationMs) {
            console.error(`[ASR] Could not probe ${file} — is ffmpeg/ffprobe installed?`);
            continue;
        }
        const cues = await transcribeMedia(file, {
            durationMs,
            onProgress: (p) => {
                if (p.stage === 'extract') process.stderr.write(`\r[ASR] extract ${p.done}/${p.total}   `);
                else if (p.stage === 'transcribe' && p.phase === 'progress') console.log(`[ASR] whisper chunk ${p.chunk}/${p.total} ${p.percent}%`);
                else if (p.stage === 'transcribe') process.stderr.write(`\r[ASR] whisper ${p.done}/${p.total}   `);
            }
        });
        process.stderr.write('\n');
        const out = args.flags.out ? String(args.flags.out) : file.replace(/\.[^.]+$/, '.en.srt');
        fs.writeFileSync(out, buildSRT(cues), 'utf8');
        console.log(`[ASR] → ${out} (${cues.length} cues)`);
    }
    return 0;
}

async function cmdScan(args) {
    const dirs = args._.slice(1);
    if (dirs.length === 0) dirs.push('/sdcard/Movies');
    const doSearch = isTruthyFlag(args.flags.search);
    const langs = args.flags.langs
        ? String(args.flags.langs).split(',').map((c) => c.trim()).filter(Boolean)
        : config.PROVIDER_LANGUAGES;

    let total = 0;
    let doneCount = 0;
    for (const dir of dirs) {
        const files = walkMedia(dir);
        console.log(`[Scan] ${dir}`);
        for (const file of files) {
            total++;
            const done = isDone(file);
            if (done) doneCount++;
            const source = findSubtitleSource(file);

            let plan;
            if (done) {
                plan = 'done';
            } else if (source.kind === 'arabic') {
                plan = `brand (${source.langCode}, already Arabic)`;
            } else if (source.kind === 'english') {
                plan = `translate ${source.langCode} ← ${path.basename(source.path)}`;
            } else {
                let streams = [];
                if (config.PROVIDER_EMBEDDED && audio.findFfprobe()) {
                    try {
                        streams = await embeddedProvider.listSubtitleStreams(file, { timeoutMs: 8000 });
                    } catch (e) { }
                }
                const textTracks = embeddedProvider.rankStreams(streams);
                if (textTracks.length > 0) {
                    plan = `embedded (${embeddedProvider.summarize(textTracks)})`;
                } else if (streams.length > 0) {
                    plan = 'embedded image-only track (needs OCR)';
                } else {
                    plan = 'bazaar → whisper (last resort)';
                }
            }
            console.log(`  ${done ? '✓' : ' '} ${path.basename(file)}  [${plan}]`);

            if (doSearch && !done && source.kind === 'none') {
                const release = parseRelease(file);
                try {
                    const search = await Bazaar.searchAll(release, { sourceLanguages: langs });
                    const ranked = Bazaar.rankCandidates(search.candidates, release, { sourceLanguages: langs });
                    if (ranked.length === 0) {
                        console.log('      └ bazaar: nothing found');
                    } else {
                        for (const candidate of ranked.slice(0, 5)) {
                            console.log(`      └ ${candidate.provider}/${candidate.langCode}` +
                                ` — ${candidate.releaseName || '(no release name)'}` +
                                `${candidate.downloads ? ` [${candidate.downloads} dl]` : ''}`);
                        }
                    }
                } catch (e) {
                    console.log(`      └ bazaar error: ${e.message}`);
                }
            }
        }
    }
    console.log(`[Scan] ${total} video(s), ${doneCount} already done`);
    return 0;
}

function cmdStatus() {
    const url = `http://127.0.0.1:${config.STATUS_PORT}/status`;
    return new Promise((resolve) => {
        const req = require('http').get(url, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                console.log(JSON.stringify(JSON.parse(body), null, 2));
                resolve(0);
            });
        });
        req.on('error', () => {
            const m = modelStatus();
            console.log(JSON.stringify({
                engine: 'not running',
                model: m.state,
                modelBytes: m.bytes,
                whisper: whisperStatus().state
            }, null, 2));
            resolve(1);
        });
    });
}

function cmdLog(args) {
    const entries = readDecisions();
    const limit = Number.parseInt(args.flags.limit, 10) || 30;
    for (const entry of entries.slice(-limit)) {
        console.log(`${entry.ts}  ${entry.action || ''}  ${entry.file ? path.basename(entry.file) : ''}  ${entry.reason || ''}`);
    }
    return 0;
}

async function cmdProcess(args) {
    const files = args._.slice(1);
    if (files.length === 0) {
        console.error('Usage: arabic-subs process <video1.mp4> [video2.mkv…]');
        return 1;
    }
    if (!(await ensureDownloads(args.flags))) return 1;
    if (!(await ensureLlamaServer(args.flags))) return 1;

    const useProviders = !isTruthyFlag(args.flags['no-providers']) && !isTruthyFlag(args.flags['no-fetch']);
    const useEmbedded = !isTruthyFlag(args.flags['no-embedded']);

    const server = await startServer(args.flags);
    if (!server) return 1;

    try {
        for (const file of files) {
            if (!fs.existsSync(file)) {
                console.error(`[Process] File not found: ${file}`);
                continue;
            }
            console.log(`[Process] Processing ${path.basename(file)}…`);
            const res = await processVideo(file, {
                server,
                providers: useProviders,
                embedded: useEmbedded,
                onNote: (line) => console.log(line),
                onStage: (s) => console.log(`[Stage] ${path.basename(file)} → ${s.stage}${s.source ? ` (${s.source})` : ''}${s.cueCount ? ` (${s.cueCount} cues)` : ''}`),
                onProgress: (p) => {
                    if (p.stage === 'extract') {
                        process.stderr.write(`\r[ASR] extract ${p.done}/${p.total}   `);
                        if (p.done === p.total) process.stderr.write('\n');
                    } else if (p.stage === 'transcribe') {
                        if (p.phase === 'start') {
                            console.log(`[ASR] whisper chunk ${p.chunk}/${p.total}`);
                        } else if (p.phase === 'progress') {
                            console.log(`[ASR] whisper chunk ${p.chunk}/${p.total} ${p.percent}%`);
                        } else {
                            process.stderr.write(`\r[ASR] ${p.done}/${p.total} chunks   `);
                            if (p.done === p.total) process.stderr.write('\n');
                        }
                    } else if (p.total) {
                        process.stderr.write(`\r[Translate] ${p.done}/${p.total} lines   `);
                        if (p.done === p.total) process.stderr.write('\n');
                    }
                }
            });
            console.log(`[Process] ✓ ${path.basename(file)} [${res.status}] ${res.output ? `→ ${path.basename(res.output)}` : ''}`);
        }
    } finally {
        await server.stop();
    }
    return 0;
}

function cmdHelp() {
    console.log(`Arabic Subs v${config.VERSION} — offline EN→AR subtitles powered by Hy-MT2

Usage: arabic-subs <command> [options]

Commands:
  setup                      Download the translation + whisper models (both at once)
  run --media <dir>          Watch folders and translate everything (the main engine)
  run --media <dir> --once   Scan everything now, then exit (good for cron)
  process <video>…           Process specific video file(s) one-shot through the pipeline
  fetch <video>…             Ask the subtitle bazaar what it can find for a video
  providers                  Show provider health (status + next retry)
  translate <file.srt>…      Translate SRT files with the local model
  transcribe <media>…        Extract speech from video/audio into an English SRT (ffmpeg + whisper)
  scan [dir]…                List videos and which subtitle source each would use
  status                     Show engine/model status
  log                        Show recent decisions
  help                       This help

Options:
  --media <dir>              Media folder to watch (repeatable via multiple dirs)
  --yes                      Allow the model download without being asked
  --no-download              Never download; fail if a model is missing
  --skip-model               setup: skip the translation model download
  --skip-whisper             setup: skip the whisper model download
  --no-providers             Disable the online subtitle bazaar (local sidecars + whisper only)
  --no-embedded              Do not read subtitle tracks stored inside the video file
  --once                     run: scan the folders once, process everything, then exit
  --search                   scan: also ask the providers what they have (network)
  --provider <id>            fetch: use only one provider
  --langs ar,en,es           Languages to ask providers for (Arabic first = brand, no AI)
  --download                 fetch: save the best match next to the video
  --out <file>               translate/transcribe output path
  --verbose                  Show llama-server logs
  --scan-interval <sec>      Folder rescan interval (default 15)

Environment:
  HYMT_MODEL_FLAVOR          model to use: q4_k_m (default), q6_k, q8_0, stq
  HYMT2_MODEL, WHISPER_MODEL, LLAMA_PORT, STATUS_PORT, LLAMA_BASE_URL,
  TRANSLATE_CONCURRENCY, TRANSLATE_BATCH_LINES, AUDIO_CONCURRENCY, NGL, THREADS
  ARABIC_SUBS_PROVIDERS      set 0 to keep the bazaar offline (default 1)
  PROVIDER_LANGUAGES         languages to ask for (default ar,en,es)
  PROVIDER_TIMEOUT_MS        per-provider search timeout (default 15000)
  SUBDL_API_KEY              free key from subdl.com (optional)
  OPENSUBTITLES_API_KEY      free key from opensubtitles.com (optional)
  OPENSUBTITLES_USERNAME / OPENSUBTITLES_PASSWORD   free account for downloads (optional)
`);
    return 0;
}

async function main(argv0) {
    const argv = Array.isArray(argv0) && argv0.length > 0 ? argv0 : process.argv.slice(2);
    const args = parseArgs(argv);
    const command = args._[0] || (args.flags.help ? 'help' : 'help');

    try {
        switch (command) {
            case 'setup': return await cmdSetup(args);
            case 'run': return await cmdRun(args);
            case 'process': return await cmdProcess(args);
            case 'fetch': return await cmdFetch(args);
            case 'providers': return await cmdProviders(args);
            case 'translate': return await cmdTranslate(args);
            case 'transcribe': return await cmdTranscribe(args);
            case 'scan': return await cmdScan(args);
            case 'status': return await cmdStatus(args);
            case 'log': return await cmdLog(args);
            case 'help':
            case '--help':
            case '-h':
                return cmdHelp();
            default:
                console.error(`Unknown command: ${command}`);
                cmdHelp();
                return 1;
        }
    } catch (err) {
        console.error(`[Error] ${err.message}`);
        if (process.env.DEBUG) console.error(err.stack);
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => {
        if (typeof code === 'number' && code !== 0) process.exit(code);
    });
}

module.exports = { parseArgs, main, multiProgress };
