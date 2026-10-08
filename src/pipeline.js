const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const { parseSRT, normalizeToUtf8, looksArabic, validateSRT, probeDurationMs } = require('./srt.js');
const { logDecision } = require('./decision-log.js');
const { translateTexts } = require('./translate.js');

const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa'];

function outputPathFor(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(dir, `${base}${config.OUTPUT_SUFFIX}`);
}

function listSubtitleSiblings(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
    const lowerBase = base.toLowerCase();
    const matches = [];
    for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        // never re-consume our own output
        if (entry.endsWith(config.OUTPUT_SUFFIX)) continue;
        const stem = entry.slice(0, entry.length - ext.length);
        if (stem.toLowerCase() === lowerBase || stem.toLowerCase().startsWith(`${lowerBase}.`)) {
            matches.push(path.join(dir, entry));
        }
    }
    return matches.sort((a, b) => scoreSibling(a, base) - scoreSibling(b, base));
}

function scoreSibling(filePath, base) {
    const stem = path.basename(filePath, path.extname(filePath));
    const rest = stem.slice(base.length).toLowerCase();
    if (rest === '.ar' || rest === '.arabic') return 0;
    if (rest === '' || rest === '.default') return 1;
    if (rest.includes('ar')) return 2;
    if (rest.includes('en') || rest.includes('eng')) return 3;
    return 4;
}

function readSubtitleFile(filePath) {
    const raw = fs.readFileSync(filePath);
    const { text, warnings } = normalizeToUtf8(raw);
    return { text, warnings };
}

/**
 * Decide what source material exists for a video:
 *   arabic  → a ready-made Arabic subtitle (brand only, no AI)
 *   english → a non-Arabic subtitle that must be translated
 *   none    → nothing found (caller may fall back to the audio pipeline)
 */
function findSubtitleSource(videoPath) {
    const siblings = listSubtitleSiblings(videoPath);
    const seen = new Set();

    for (const sibling of siblings) {
        const resolved = path.resolve(sibling);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        let parsed;
        try {
            parsed = readSubtitleFile(sibling);
        } catch (e) {
            continue;
        }
        const validation = validateSRT(parsed.text, {});
        if (!validation.ok) continue;

        const arabic = validation.cues.filter((c) => looksArabic(c.text)).length;
        const ratio = validation.cues.length ? arabic / validation.cues.length : 0;
        return {
            kind: ratio >= 0.5 ? 'arabic' : 'english',
            path: sibling,
            cues: validation.cues,
            warnings: parsed.warnings,
            arabicRatio: ratio
        };
    }

    return { kind: 'none', path: null, cues: [], warnings: [], arabicRatio: 0 };
}

function isDone(videoPath) {
    return fs.existsSync(outputPathFor(videoPath));
}

function writeOutput(videoPath, cues) {
    const outPath = outputPathFor(videoPath);
    const { buildSRT } = require('./srt.js');
    const tmpPath = `${outPath}.tmp`;
    fs.writeFileSync(tmpPath, buildSRT(cues), 'utf8');
    fs.renameSync(tmpPath, outPath);
    return outPath;
}

/**
 * Translate English cues → Arabic through the llama server (in parallel
 * chunks) and return the translated cue list, preserving all timings.
 */
async function translateCues(cues, server, options = {}) {
    const texts = cues.map((c) => c.text);
    const { texts: translated, stats } = await translateTexts(texts, server, options);

    const out = cues.map((cue, i) => ({
        index: null,
        start: cue.start,
        end: cue.end,
        text: translated[i] || cue.text
    }));
    return { cues: out, stats };
}

/**
 * Core per-video pipeline:
 *   existing output        → skip
 *   ready-made Arabic      → brand only
 *   English subtitle       → translate with Hy-MT2
 *   no subtitle + audio    → whisper transcription → translate
 *   no subtitle + no audio → skip (reason logged)
 */
async function processVideo(videoPath, options = {}) {
    const server = options.server || null;
    const log = options.log || logDecision;
    const useAudio = options.audio !== false;
    const durationMs = options.durationMs !== undefined ? options.durationMs : probeDurationMs(videoPath);

    if (isDone(videoPath)) {
        log({ file: videoPath, action: 'skip', reason: 'existing-output' });
        return { status: 'skipped', reason: 'existing-output' };
    }

    const source = findSubtitleSource(videoPath);

    if (source.kind === 'arabic') {
        const outPath = writeOutput(videoPath, source.cues);
        log({
            file: videoPath,
            action: 'brand-arabic',
            source: source.path ? path.basename(source.path) : 'local',
            cueCount: source.cues.length
        });
        return { status: 'branded', output: outPath, cueCount: source.cues.length };
    }

    let cues = source.kind === 'english' ? source.cues : [];
    let origin = source.kind === 'english' ? path.basename(source.path) : null;

    if (cues.length === 0 && useAudio) {
        const asr = require('./asr.js');
        if (asr.findWhisper() && fs.existsSync(config.WHISPER_PATH)) {
            options.onStage && options.onStage({ stage: 'transcribe' });
            cues = await asr.transcribeMedia(videoPath, {
                onProgress: options.onProgress,
                durationMs
            });
            origin = 'audio';
            if (cues.length === 0) {
                log({ file: videoPath, action: 'no-speech', reason: 'whisper returned no cues' });
                return { status: 'skipped', reason: 'no-speech' };
            }
        }
    }

    if (cues.length === 0) {
        const reason = useAudio ? 'no-subtitle-or-audio' : 'no-subtitle';
        log({ file: videoPath, action: 'no-subtitle', reason });
        return { status: 'skipped', reason };
    }

    if (!server) {
        throw new Error('translate requested but no llama server provided');
    }

    options.onStage && options.onStage({ stage: 'translate', cueCount: cues.length });
    const { cues: translated, stats } = await translateCues(cues, server, options);

    const validation = validateSRT(
        translated.map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}`).join('\n\n'),
        { durationMs: durationMs || undefined }
    );

    if (!validation.ok) {
        log({ file: videoPath, action: 'translate-failed', reason: validation.reason, cueCount: cues.length });
        return { status: 'failed', reason: validation.reason };
    }

    const outPath = writeOutput(videoPath, validation.cues);
    log({
        file: videoPath,
        action: 'translate',
        source: origin,
        cueCount: validation.cues.length,
        chunks: stats.batches,
        keptSource: stats.keptSource,
        output: path.basename(outPath)
    });
    return { status: 'translated', output: outPath, cueCount: validation.cues.length, stats };
}

module.exports = {
    outputPathFor,
    listSubtitleSiblings,
    findSubtitleSource,
    isDone,
    writeOutput,
    translateCues,
    processVideo
};
