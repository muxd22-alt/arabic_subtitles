const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config.js');
const { findFfmpeg, findFfprobe } = require('./binaries.js');

/**
 * Run a child process and resolve with its full outcome, including a non-zero
 * exit. Never rejects for a non-zero code (only for a spawn failure such as a
 * missing binary) because ffprobe/ffmpeg report useful diagnostics on failure.
 */
function runResult(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            reject(e);
            return;
        }
        let stdout = '';
        let stderr = '';
        let timer = null;
        let settled = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) { clearTimeout(timer); timer = null; }
            fn(value);
        };
        proc.stdout.on('data', (c) => (stdout += c));
        proc.stderr.on('data', (c) => (stderr += c));
        proc.on('error', (e) => settle(reject, e));
        proc.on('exit', (code) => settle(resolve, { code, stdout, stderr, timedOut: false }));
        if (options.timeoutMs) {
            timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (e) { }
                settle(resolve, { code: null, stdout, stderr, timedOut: true });
            }, options.timeoutMs);
        }
    });
}

function run(cmd, args, options = {}) {
    return runResult(cmd, args, options).then((r) => {
        if (r.timedOut) throw new Error(`${cmd} timed out after ${options.timeoutMs}ms`);
        if (r.code !== 0) {
            throw new Error(`${cmd} exited ${r.code}: ${r.stderr.slice(-800) || '(no stderr)'}`);
        }
        return r.stdout;
    });
}

/** Largest positive number in some command output (`N/A`, empty and 0 are skipped). */
function parseDurationNumber(text) {
    let best = null;
    for (const token of String(text).split(/[\s,]+/)) {
        const n = Number(token);
        if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
    }
    return best;
}

/**
 * Read the media duration, trying hard not to give up:
 *   1. ffprobe, asking for BOTH the format and the per-stream durations — some
 *      containers populate only one of them;
 *   2. ffmpeg's own "Duration: H:MM:SS.ss" summary, which still works when a
 *      container's trailing metadata is unavailable (MKV keeps its cues and
 *      often its duration at the END of the file, so a partially downloaded or
 *      streamed MKV probes as unknown while its audio still decodes fine).
 * Resolves with { ms, error } and never throws, so callers can decide whether an
 * unknown duration is fatal or just means "process the file in one pass".
 */
async function probeDurationDetailed(mediaPath) {
    const ffprobeBin = findFfprobe();
    let ffprobeError = null;
    try {
        const out = await run(ffprobeBin, [
            '-v', 'error',
            '-show_entries', 'format=duration:stream=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            mediaPath
        ], { timeoutMs: 20000 });
        const seconds = parseDurationNumber(out);
        if (seconds) return { ms: Math.round(seconds * 1000), error: null };
        ffprobeError = `${ffprobeBin} reported no duration`;
    } catch (e) {
        ffprobeError = `${ffprobeBin}: ${e.message}`;
    }

    const ffmpegBin = findFfmpeg();
    try {
        const r = await runResult(ffmpegBin, ['-hide_banner', '-i', mediaPath], { timeoutMs: 30000 });
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(`${r.stderr}\n${r.stdout}`);
        if (m) {
            const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
            if (seconds > 0) return { ms: Math.round(seconds * 1000), error: null };
        }
        const tail = (r.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-300);
        return { ms: null, error: `${ffprobeError}; ${ffmpegBin} found no duration${tail ? ` (${tail})` : ''}` };
    } catch (e) {
        return { ms: null, error: `${ffprobeError}; ${ffmpegBin} fallback failed: ${e.message}` };
    }
}

function probeDurationMs(mediaPath) {
    return probeDurationDetailed(mediaPath).then((r) => r.ms);
}

/**
 * Split a media timeline into overlapping chunks for parallel processing.
 */
function planChunks(durationMs, chunkMs = config.CHUNK_MS, overlapMs = config.CHUNK_OVERLAP_MS) {
    if (!durationMs || durationMs <= 0) return [];
    const chunks = [];
    let start = 0;
    let index = 0;
    while (start < durationMs) {
        const end = Math.min(durationMs, start + chunkMs);
        chunks.push({ index, startMs: start, endMs: end });
        if (end >= durationMs) break;
        start = end - overlapMs;
        if (start < 0) start = 0;
        index++;
        if (index > 500) break;
    }
    return chunks;
}

/**
/**
 * Extract one 16 kHz mono WAV segment in parallel-safe fashion.
 * -ss is placed BEFORE -i so ffmpeg seeks to the chunk instead of decoding the
 * whole file from 0:00 for every chunk (that made later chunks take longer and
 * longer). Input seeking keeps -accurate_seek on, so the WAV still starts at the
 * exact chunk timestamp and chunk-relative cue times stay correct.
 * A chunk with endMs === null means "to the end of the file", which is how the
 * whole track is extracted when the duration cannot be probed.
 */
async function extractChunk(mediaPath, chunk, outPath) {
    const wholeFile = chunk.endMs == null;
    const args = ['-nostdin', '-loglevel', 'error', '-y'];
    if (chunk.startMs > 0) args.push('-ss', (chunk.startMs / 1000).toFixed(3));
    args.push('-i', mediaPath);
    if (!wholeFile) args.push('-t', ((chunk.endMs - chunk.startMs) / 1000).toFixed(3));
    args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath);
    await run(findFfmpeg(), args, { timeoutMs: wholeFile ? 1800000 : 600000 });
    return outPath;
}

/**
 * Extract all audio chunks with a bounded worker pool so a phone never runs
 * more than `concurrency` ffmpeg processes at once.
 */
async function extractChunks(mediaPath, chunks, outDir, options = {}) {
    const concurrency = options.concurrency || config.AUDIO_CONCURRENCY;
    const onProgress = options.onProgress || (() => { });
    fs.mkdirSync(outDir, { recursive: true });

    const results = new Array(chunks.length).fill(null);
    let cursor = 0;
    let done = 0;

    async function worker() {
        while (cursor < chunks.length) {
            const i = cursor++;
            const chunk = chunks[i];
            const outPath = path.join(outDir, `chunk_${String(i).padStart(4, '0')}.wav`);
            await extractChunk(mediaPath, chunk, outPath);
            results[i] = { chunk, path: outPath };
            done++;
            onProgress(done, chunks.length);
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
    return results;
}

function cleanup(files) {
    for (const file of files) {
        try {
            fs.rmSync(file, { force: true });
        } catch (e) { }
    }
}

module.exports = {
    run,
    runResult,
    findFfmpeg,
    findFfprobe,
    probeDurationMs,
    probeDurationDetailed,
    planChunks,
    extractChunk,
    extractChunks,
    cleanup
};
