const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config.js');
const { parseSRT, timeToMs } = require('./srt.js');
const audio = require('./audio.js');
const { findWhisper } = require('./binaries.js');

/**
 * Threads to hand a single whisper process. When several chunks run at once we
 * divide the budget instead of letting N x THREADS oversubscribe the CPU (which
 * on a phone means everything crawls and the run looks frozen).
 */
function threadsPerChunk(options = {}, concurrency = 1) {
    const base = options.threads
        || Number.parseInt(process.env.THREADS || '0', 10)
        || os.cpus().length
        || 4;
    return Math.max(1, Math.floor(base / Math.max(1, concurrency)));
}

/**
 * Transcribe a single wav chunk with whisper.cpp into SRT cues.
 * Timestamps are relative to the chunk.
 */
async function transcribeChunk(wavPath, options = {}) {
    const bin = options.bin || findWhisper();
    if (!bin) throw new Error('whisper binary not found. Build whisper.cpp or set WHISPER_BIN.');

    const modelPath = options.modelPath || config.WHISPER_PATH;
    if (!fs.existsSync(modelPath)) {
        throw new Error(`whisper model missing at ${modelPath} — run: node bin/arabic-subs.js setup`);
    }

    const outBase = wavPath.replace(/\.wav$/i, '');
    await audio.run(bin, [
        '-m', modelPath,
        '-f', wavPath,
        '-l', options.language || 'en',
        '-osrt',
        '-of', outBase,
        '-t', String(options.threads || 4)
    ], { timeoutMs: options.timeoutMs || 900000 });

    const srtPath = `${outBase}.srt`;
    const raw = fs.readFileSync(srtPath, 'utf8');
    try {
        fs.rmSync(srtPath, { force: true });
    } catch (e) { }
    return parseSRT(raw);
}

/**
 * Shift chunk-relative cues into absolute timeline positions.
 * A cue is kept only when its midpoint falls inside the chunk's exclusive
 * ownership window, which de-duplicates the overlap between chunks.
 */
function mergeChunkCues(chunk, cues, chunks, isLast) {
    const startMs = chunk.startMs;
    const nextStart = isLast ? chunk.endMs : (chunks[chunk.index + 1] ? chunks[chunk.index + 1].startMs : chunk.endMs);
    const shifted = [];
    for (const cue of cues) {
        const relStart = timeToMs(cue.start);
        const relEnd = timeToMs(cue.end);
        if (relStart === null || relEnd === null) continue;
        const absStart = startMs + relStart;
        const absEnd = startMs + relEnd;
        const mid = (absStart + absEnd) / 2;
        if (mid < startMs || mid >= nextStart) continue;
        shifted.push({
            index: null,
            start: require('./srt.js').msToTime(absStart),
            end: require('./srt.js').msToTime(absEnd),
            text: cue.text
        });
    }
    return shifted;
}

/**
 * Full "sound → English cues" path: probe duration, split the timeline into
 * chunks, extract + transcribe them with a bounded pool, merge, sort.
 * Returns an array of cues with absolute timestamps.
 */
async function transcribeMedia(mediaPath, options = {}) {
    const concurrency = options.concurrency || config.AUDIO_CONCURRENCY;
    const onProgress = options.onProgress || (() => { });
    const tmpDir = options.tmpDir || path.join(config.TMP_DIR, `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

    const durationMs = options.durationMs || await audio.probeDurationMs(mediaPath);
    if (!durationMs) {
        throw new Error(`could not probe duration of ${mediaPath} (is ffprobe installed?)`);
    }

    const chunks = audio.planChunks(durationMs, options.chunkMs || config.CHUNK_MS, config.CHUNK_OVERLAP_MS);
    const extracted = await audio.extractChunks(mediaPath, chunks, tmpDir, {
        concurrency,
        onProgress: (done, total) => onProgress({ stage: 'extract', done, total })
    });

    const threads = options.threads || threadsPerChunk(options, concurrency);
    const results = new Array(extracted.length).fill(null);
    let cursor = 0;

    async function worker() {
        while (cursor < extracted.length) {
            const i = cursor++;
            const { chunk, path: wavPath } = extracted[i];
            onProgress({
                stage: 'transcribe',
                phase: 'start',
                chunk: i + 1,
                done: results.filter(Boolean).length,
                total: extracted.length
            });
            const cues = await transcribeChunk(wavPath, { ...options, threads });
            results[i] = mergeChunkCues(chunk, cues, chunks, i === extracted.length - 1);
            onProgress({
                stage: 'transcribe',
                phase: 'done',
                chunk: i + 1,
                done: results.filter(Boolean).length,
                total: extracted.length
            });
        }
    }

    try {
        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
    } finally {
        const files = extracted.map((e) => e.path);
        audio.cleanup(files);
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) { }
    }

    const merged = results.flat().filter(Boolean);
    merged.sort((a, b) => timeToMs(a.start) - timeToMs(b.start));
    merged.forEach((cue, i) => { cue.index = String(i + 1); });
    return merged;
}

module.exports = {
    findWhisper,
    threadsPerChunk,
    transcribeChunk,
    transcribeMedia,
    mergeChunkCues
};
