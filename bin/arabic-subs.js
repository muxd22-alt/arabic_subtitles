#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const config = require('../src/config.js');
const { modelStatus, whisperStatus, downloadModel, downloadWhisperModel } = require('../src/model.js');
const { LlamaServer, findLlamaServer } = require('../src/llama.js');
const { findWhisper, transcribeMedia } = require('../src/asr.js');
const { processVideo, findSubtitleSource, outputPathFor } = require('../src/pipeline.js');
const { walkMedia, JobQueue, watchFolder } = require('../src/watcher.js');
const { startStatusServer } = require('../src/status-server.js');
const { logDecision, readDecisions } = require('../src/decision-log.js');
const { parseSRT, validateSRT, normalizeToUtf8, buildSRT } = require('../src/srt.js');
const { translateTexts } = require('../src/translate.js');
const audio = require('../src/audio.js');

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

async function cmdSetup(args) {
    config.ensureDirs();
    console.log(`[Setup] Arabic Subs v${config.VERSION}`);
    console.log(`[Setup] Home:        ${config.HOME}`);
    console.log(`[Setup] Model dir:   ${config.MODELS_DIR}`);

    const checks = [
        ['node', process.version],
        ['ffmpeg', null],
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

    if (!skipModel) {
        const before = modelStatus();
        if (before.state === 'ready') {
            console.log(`[Setup] Hy-MT2 model already present (${fmtBytes(before.bytes)})`);
        } else {
            console.log(`[Setup] Downloading Hy-MT2-1.8B (1.25-bit, ~440 MB)`);
            console.log(`[Setup]   page:  ${HF_MODEL_CARD}`);
            console.log(`[Setup]   file:  ${HF_MODEL_REPO}`);
            await downloadModel({ onProgress: progressLine('[Model]') });
            console.log(`[Setup] Model ready: ${config.MODEL_PATH}`);
        }
    }

    if (!skipWhisper) {
        const before = whisperStatus();
        if (before.state === 'ready') {
            console.log(`[Setup] Whisper model already present (${fmtBytes(before.bytes)})`);
        } else {
            console.log(`[Setup] Downloading whisper ggml-${config.WHISPER_MODEL} for the audio path (~150 MB)`);
            console.log(`[Setup]   page:  ${HF_WHISPER_REPO}`);
            await downloadWhisperModel({ onProgress: progressLine('[Whisper]') });
            console.log(`[Setup] Whisper model ready: ${config.WHISPER_PATH}`);
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
const HF_MODEL_CARD = 'https://huggingface.co/tencent/Hy-MT2-1.8B';
const HF_MODEL_REPO = 'https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF';
const HF_WHISPER_REPO = 'https://huggingface.co/ggerganov/whisper.cpp';

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
    const model = modelStatus();
    const needModel = model.state !== 'ready';
    const haveWhisperBin = Boolean(findWhisper());
    const needWhisper = haveWhisperBin && whisperStatus().state !== 'ready';

    if (!haveWhisperBin) {
        console.log('[Engine] whisper-cli not found — videos with no subtitle at all will be skipped.');
        console.log('[Engine] Install it with: bash scripts/setup-termux.sh');
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
        console.log(`[Engine]   Hy-MT2-1.8B (1.25-bit GGUF)  ${fmtBytes(config.MODEL_BYTES)}  ${HF_MODEL_REPO}`);
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

    if (needModel) {
        console.log(`[Engine] Downloading Hy-MT2 from ${HF_MODEL_REPO} (resumable)…`);
        try {
            await downloadModel({ onProgress: progressLine('[Model]') });
            console.log(`[Engine] Model ready: ${config.MODEL_PATH}`);
        } catch (err) {
            console.log(`[Engine] Model download failed: ${err.message}`);
            console.log('[Engine] Retry: node bin/arabic-subs.js setup   (resumes from where it stopped)');
            return false;
        }
    }

    if (needWhisper) {
        console.log('[Engine] Downloading whisper model for the audio path…');
        try {
            await downloadWhisperModel({ onProgress: progressLine('[Whisper]') });
            console.log('[Engine] Whisper model ready.');
        } catch (err) {
            console.log(`[Engine] Whisper download failed: ${err.message} — audio path disabled for now`);
        }
    }

    return true;
}

/** Start llama-server, translating the "binary missing" failure into a next step. */
async function startServer(flags) {
    const server = new LlamaServer();
    console.log('[Engine] Starting llama-server with Hy-MT2…');
    try {
        await server.start({ verbose: Boolean(flags.verbose) });
    } catch (err) {
        if (/binary not found/i.test(err.message)) {
            console.error('[Engine] llama-server is not installed yet.');
            console.error('[Engine] Run: bash scripts/setup-termux.sh');
            console.error('[Engine] If cmake fails with a missing symbol, first run: pkg upgrade -y');
            return null;
        }
        throw err;
    }
    console.log(`[Engine] Ready at ${server.baseUrl}`);
    return server;
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

    const server = await startServer(args.flags);
    if (!server) return 1;

    const queue = new JobQueue({
        process: async (file) => {
            return processVideo(file, {
                server,
                onStage: (s) => console.log(`[Stage] ${path.basename(file)} → ${s.stage}${s.source ? ` (${s.source})` : ''}${s.cueCount ? ` (${s.cueCount} cues)` : ''}`),
                onProgress: (p) => {
                    if (p.stage === 'transcribe') {
                        process.stderr.write(`\r[ASR] ${p.done}/${p.total} chunks   `);
                        if (p.done === p.total) process.stderr.write('\n');
                    } else if (p.total && p.done === p.total) {
                        console.log(`[Translate] ${p.done} lines done`);
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
            intervalMs: Number.parseInt(args.flags['scan-interval'], 10) || 15000
        }));
    }

    if (watchers.length === 0) {
        console.error('[Engine] No valid media folders.');
        await server.stop();
        return 1;
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
                : file.replace(/(\.srt)?$/i, '.ar.srt');
            fs.writeFileSync(out, buildSRT(translatedCues), 'utf8');
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
    let total = 0;
    for (const dir of dirs) {
        const files = walkMedia(dir);
        console.log(`[Scan] ${dir}`);
        for (const file of files) {
            const done = require('../src/pipeline.js').isDone(file);
            const source = findSubtitleSource(file);
            console.log(`  ${done ? '✓' : ' '} ${path.basename(file)}  [${source.kind}]`);
            total++;
        }
    }
    console.log(`[Scan] ${total} video(s)`);
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

function cmdHelp() {
    console.log(`Arabic Subs v${config.VERSION} — offline EN→AR subtitles powered by Hy-MT2

Usage: arabic-subs <command> [options]

Commands:
  setup                      Download the Hy-MT2 model (1.25-bit, ~440 MB) + whisper model
  run --media <dir>          Watch folders and translate everything (the main engine)
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
  --skip-model               setup: skip the Hy-MT2 download
  --skip-whisper             setup: skip the whisper model download
  --out <file>               translate/transcribe output path
  --verbose                  Show llama-server logs
  --scan-interval <sec>      Folder rescan interval (default 15)

Environment:
  HYMT2_MODEL, WHISPER_MODEL, LLAMA_PORT, STATUS_PORT, LLAMA_BASE_URL,
  TRANSLATE_CONCURRENCY, TRANSLATE_BATCH_LINES, AUDIO_CONCURRENCY, NGL, THREADS
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

module.exports = { parseArgs, main };
