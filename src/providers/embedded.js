const fs = require('fs');
const path = require('path');
const config = require('../config.js');
const langs = require('../langs.js');
const { run, findFfmpeg, findFfprobe } = require('../audio.js');
const { parseSRT, looksArabic } = require('../srt.js');

/**
 * The local stall of the bazaar: subtitle tracks already inside the file.
 *
 * These are the fastest — no network, no model — so they are always tried
 * before any website. Text tracks (SubRip, ASS/SSA, mov_text, WebVTT and the
 * like) convert straight to SRT with the bundled ffmpeg; image-based tracks
 * (PGS, VobSub, DVB) need OCR the engine does not ship, so they are reported
 * and skipped rather than silently ignored.
 */

const TEXT_CODECS = new Set([
    'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'subviewer',
    'subviewer1', 'microdvd', 'eia_608', 'eia_708', 'sami', 'realtext', 'dvb_teletext'
]);

const IMAGE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext']);

function languageHint(stream) {
    const raw = (stream.tags && (stream.tags.language || stream.tags.LANGUAGE)) || '';
    const title = (stream.tags && (stream.tags.title || stream.tags.TITLE)) || '';
    const code = langs.codeFor(raw) !== 'und' ? langs.codeFor(raw) : langs.codeFor(title);
    return { code, raw: raw || title || null };
}

function extractFrameCount(tags) {
    if (!tags) return null;
    for (const [k, v] of Object.entries(tags)) {
        if (/^number_of_frames/i.test(k)) {
            const num = Number(v);
            if (Number.isFinite(num) && num > 0) return num;
        }
    }
    return null;
}

/** Probe the file for subtitle streams (no ffmpeg decode, just metadata). */
async function listSubtitleStreams(videoPath, options = {}) {
    let raw;
    try {
        const out = await run(findFfprobe(), [
            '-v', 'error',
            '-select_streams', 's',
            '-show_streams',
            '-of', 'json',
            videoPath
        ], { timeoutMs: options.timeoutMs || 20000 });
        raw = JSON.parse(out);
    } catch (e) {
        throw new Error(`ffprobe could not list subtitle tracks: ${e.message}`);
    }

    return markPartialStreams((raw.streams || [])
        .filter((s) => s.codec_type === 'subtitle')
        .map((s) => {
            const { code, raw: rawLang } = languageHint(s);
            const frames = extractFrameCount(s.tags);
            const title = (s.tags && (s.tags.title || s.tags.TITLE)) || '';
            const isForced = Boolean(s.disposition && s.disposition.forced);
            const isDefault = Boolean(s.disposition && s.disposition.default);
            const isHearingImpaired = (s.tags && /hearing|sdh|hi/i.test(title)) || Boolean(s.disposition && s.disposition.hearing_impaired);
            return {
                type: 'embedded',
                index: s.index,
                codec: s.codec_name,
                codecLong: s.codec_long_name || null,
                text: TEXT_CODECS.has(s.codec_name),
                image: IMAGE_CODECS.has(s.codec_name),
                langCode: code,
                language: rawLang,
                title: title || null,
                default: isDefault,
                forced: isForced,
                hearingImpaired: isHearingImpaired,
                frames
            };
        }));
}

/**
 * Incomplete-track heuristic (per the bazaar design): when several tracks report
 * a frame count and one holds less than a third of the biggest, it is a signs /
 * partial track — a preview of the film, not a subtitle. Such tracks are marked
 * and ranked out, never extracted.
 */
function markPartialStreams(streams) {
    const counts = streams.map((s) => s.frames).filter((n) => Number.isFinite(n) && n > 0);
    if (counts.length < 2) return streams;
    const biggest = Math.max(...counts);
    return streams.map((s) => (
        s.frames && s.frames < biggest / 3 ? Object.assign({}, s, { partial: true, partialReason: 'low-frame-count' }) : s
    ));
}

/**
 * Which embedded track would a human pick? Arabic first (brand it, no model),
 * then a default/non-forced track, then English, then anything text-based.
 */
function rankStreams(streams) {
    return streams
        .filter((s) => s.text && !s.partial)
        .map((s, i) => {
            let score = 0;
            if (s.langCode === 'ar') score += 100;
            else if (s.langCode === 'en') score += 40;
            else if (s.langCode !== 'und') score += 25;
            if (s.default) score += 12;
            if (!s.forced) score += 8;
            if (s.forced) score -= 15;
            if (s.hearingImpaired) score -= 6;
            if (/signs|songs/i.test(s.title || '')) score -= 20;
            score -= i / 100;
            return { stream: s, score };
        })
        .sort((a, b) => b.score - a.score)
        .map((x) => x.stream);
}

async function extractStream(videoPath, index, outPath, options = {}) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await run(findFfmpeg(), [
        '-nostdin', '-loglevel', 'error', '-y',
        '-i', videoPath,
        '-map', `0:${index}`,
        '-c:s', 'srt',
        outPath
    ], { timeoutMs: options.timeoutMs || 180000 });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        throw new Error(`ffmpeg produced no subtitle output for stream ${index}`);
    }
    return outPath;
}

/** Extract a stream and return it as cues (SRT is the lingua franca). */
async function readStreamCues(videoPath, stream, options = {}) {
    const outPath = path.join(
        options.tmpDir || config.TMP_DIR,
        `embedded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.srt`
    );
    try {
        await extractStream(videoPath, stream.index, outPath, options);
        const text = fs.readFileSync(outPath, 'utf8');
        return parseSRT(text);
    } finally {
        try { fs.rmSync(outPath, { force: true }); } catch (e) { }
    }
}

function summarize(streams) {
    return streams.map((s) => {
        const bits = [s.codec];
        if (s.language) bits.push(s.language);
        if (s.forced) bits.push('forced');
        if (s.default) bits.push('default');
        if (s.partial) bits.push('partial');
        return bits.join('/');
    }).join(', ');
}

/** The entry the bazaar sees: search = find candidate tracks, download = extract one. */
const provider = {
    id: 'embeddedsubtitles',
    label: 'embeddedsubtitles',
    kind: 'local',
    requires: [],
    priority: 0,
    supports: { movies: true, series: true, imageTracks: false },

    available() {
        try {
            findFfprobe();
            findFfmpeg();
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: 'ffprobe/ffmpeg not found' };
        }
    },

    async search(release, ctx = {}) {
        const videoPath = release.videoPath;
        if (!videoPath || !fs.existsSync(videoPath)) return [];
        const streams = await listSubtitleStreams(videoPath, { timeoutMs: ctx.timeoutMs });
        const ranked = rankStreams(streams);
        return ranked.map((stream) => ({
            provider: 'embeddedsubtitles',
            id: String(stream.index),
            language: stream.language || langs.nameFor(stream.langCode),
            langCode: stream.langCode,
            releaseName: `${stream.codec}${stream.title ? ` "${stream.title}"` : ''}`,
            downloads: 0,
            embedded: true,
            extra: { stream, videoPath }
        }));
    },

    async download(candidate) {
        const { stream, videoPath } = candidate.extra;
        const outPath = path.join(
            config.TMP_DIR,
            `embedded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.srt`
        );
        try {
            await extractStream(videoPath, stream.index, outPath);
            const base = path.basename(videoPath, path.extname(videoPath));
            return { name: `${base}.${candidate.langCode}.srt`, data: fs.readFileSync(outPath) };
        } finally {
            try { fs.rmSync(outPath, { force: true }); } catch (e) { }
        }
    }
};

module.exports = {
    ...provider,
    listSubtitleStreams,
    rankStreams,
    markPartialStreams,
    extractFrameCount,
    extractStream,
    readStreamCues,
    summarize,
    looksArabicCue: (cues) => cues.some((c) => looksArabic(c.text)),
    TEXT_CODECS,
    IMAGE_CODECS
};
