const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config.js');

function run(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        proc.stdout.on('data', (c) => (out += c));
        proc.stderr.on('data', (c) => (err += c));
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) resolve(out);
            else reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
        });
        if (options.timeoutMs) {
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (e) { }
                reject(new Error(`${cmd} timed out`));
            }, options.timeoutMs);
        }
    });
}

function findFfmpeg() {
    if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
    return 'ffmpeg';
}

function findFfprobe() {
    if (process.env.FFPROBE_BIN) return process.env.FFPROBE_BIN;
    return 'ffprobe';
}

function probeDurationMs(mediaPath) {
    return run(findFfprobe(), [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mediaPath
    ], { timeoutMs: 20000 })
        .then((out) => {
            const seconds = Number(String(out).trim());
            if (!Number.isFinite(seconds) || seconds <= 0) return null;
            return Math.round(seconds * 1000);
        })
        .catch(() => null);
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
 * Extract one 16 kHz mono WAV segment in parallel-safe fashion.
 * -ss is placed after -i for accurate seeks.
 */
async function extractChunk(mediaPath, chunk, outPath) {
    await run(findFfmpeg(), [
        '-y',
        '-i', mediaPath,
        '-ss', (chunk.startMs / 1000).toFixed(3),
        '-t', ((chunk.endMs - chunk.startMs) / 1000).toFixed(3),
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        outPath
    ], { timeoutMs: 600000 });
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
    findFfmpeg,
    findFfprobe,
    probeDurationMs,
    planChunks,
    extractChunk,
    extractChunks,
    cleanup
};
