const { execFileSync } = require('child_process');

const WATERMARK_TEXT = '[ ترجمة الأداة عربي سبس ]';
const TIMESTAMP_RE = /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

function timeToMs(t) {
    const normalized = String(t).trim().replace('.', ',');
    const [hms, ms] = normalized.split(',');
    const [h, m, s] = hms.split(':').map(Number);
    if ([h, m, s, Number(ms)].some((n) => Number.isNaN(n))) return null;
    return ((h * 3600 + m * 60 + s) * 1000) + Number(ms);
}

function msToTime(d) {
    const ms = d % 1000;
    const s = Math.floor((d / 1000) % 60);
    const m = Math.floor((d / (1000 * 60)) % 60);
    const h = Math.floor(d / (1000 * 60 * 60));
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseSRT(data) {
    if (data === null || data === undefined) return [];

    const normalized = String(data).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
        const lines = block.split('\n');
        const tsIdx = lines.findIndex((line) => TIMESTAMP_RE.test(line.trim()));
        if (tsIdx === -1) continue;

        const match = lines[tsIdx].trim().match(TIMESTAMP_RE);
        const start = match[1].replace('.', ',');
        const end = match[2].replace('.', ',');

        const text = lines.slice(tsIdx + 1).join('\n').trim();
        if (!text) continue;

        const indexLine = lines.slice(0, tsIdx).find((l) => /^\d+$/.test(l.trim()));

        cues.push({
            index: indexLine ? indexLine.trim() : null,
            start,
            end,
            text
        });
    }

    return cues;
}

function buildSRT(cues) {
    let srt = `1\n00:00:01,000 --> 00:00:04,000\n${WATERMARK_TEXT}\n\n`;
    cues.forEach((cue, idx) => {
        srt += `${idx + 2}\n${cue.start} --> ${cue.end}\n${cue.text}\n\n`;
    });
    return srt;
}

function normalizeToUtf8(input) {
    const warnings = [];

    if (typeof input === 'string') {
        const text = input.replace(/^\uFEFF/, '');
        return { text, encoding: 'utf8', warnings };
    }

    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { text: buf.slice(3).toString('utf8'), encoding: 'utf8-bom', warnings };
    }

    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le-bom', warnings };
    }

    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf.slice(2));
        swapped.swap16();
        return { text: swapped.toString('utf16le'), encoding: 'utf16be-bom', warnings };
    }

    if (buf.length >= 4) {
        let evenNulls = 0;
        let oddNulls = 0;
        const sample = Math.min(buf.length, 4096);
        for (let i = 0; i < sample; i++) {
            if (buf[i] === 0) (i % 2 === 0 ? evenNulls++ : oddNulls++);
        }
        const pairs = Math.floor(sample / 2);
        if (pairs > 0 && oddNulls / pairs > 0.6) {
            warnings.push('assumed utf16le (no BOM)');
            return { text: buf.swap16().toString('utf16le'), encoding: 'utf16le', warnings };
        }
        if (pairs > 0 && evenNulls / pairs > 0.6) {
            const swapped = Buffer.from(buf);
            swapped.swap16();
            warnings.push('assumed utf16be (no BOM)');
            return { text: swapped.toString('utf16le'), encoding: 'utf16be', warnings };
        }
    }

    const decoded = buf.toString('utf8');
    if (decoded.includes('\uFFFD')) {
        warnings.push('invalid utf-8 sequences replaced using latin1 fallback');
        return { text: buf.toString('latin1'), encoding: 'latin1-fallback', warnings };
    }

    return { text: decoded, encoding: 'utf8', warnings };
}

function arabicRatio(text) {
    if (!text) return 0;
    let arabic = 0;
    let letters = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        const isArabic =
            (code >= 0x0600 && code <= 0x06ff) ||
            (code >= 0x0750 && code <= 0x077f) ||
            (code >= 0xfb50 && code <= 0xfdff) ||
            (code >= 0xfe70 && code <= 0xfeff);
        const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || isArabic;
        if (isArabic) arabic++;
        if (isLetter) letters++;
    }
    return letters === 0 ? 0 : arabic / letters;
}

function looksArabic(text) {
    return arabicRatio(text) >= 0.3;
}

function validateSRT(rawText, options = {}) {
    const warnings = [];

    if (!rawText || !String(rawText).trim()) {
        return { ok: false, reason: 'empty', cues: [], warnings };
    }

    const head = String(rawText).trimStart().slice(0, 200).toLowerCase();
    if (head.startsWith('<html') || head.startsWith('<!doctype html') || head.startsWith('{')) {
        return { ok: false, reason: 'not-an-srt (html/json payload)', cues: [], warnings };
    }

    const cues = parseSRT(rawText);
    if (cues.length === 0) {
        return { ok: false, reason: 'no-parseable-cues', cues: [], warnings };
    }

    let maxEndMs = 0;
    let outOfOrder = 0;
    let previousStart = -1;
    let totalChars = 0;

    for (const cue of cues) {
        const startMs = timeToMs(cue.start);
        const endMs = timeToMs(cue.end);

        if (startMs === null || endMs === null) {
            return { ok: false, reason: `unparsable timestamp: ${cue.start} --> ${cue.end}`, cues, warnings };
        }
        if (endMs <= startMs) {
            return { ok: false, reason: `end <= start at ${cue.start}`, cues, warnings };
        }
        if (startMs < previousStart) outOfOrder++;
        previousStart = startMs;
        maxEndMs = Math.max(maxEndMs, endMs);
        totalChars += cue.text.length;
    }

    const avgChars = totalChars / cues.length;
    if (avgChars > 300) {
        return { ok: false, reason: `avg cue length ${Math.round(avgChars)} chars looks wrong`, cues, warnings };
    }
    if (outOfOrder > cues.length * 0.1) {
        return { ok: false, reason: `${outOfOrder}/${cues.length} cues out of chronological order`, cues, warnings };
    }
    if (outOfOrder > 0) {
        warnings.push(`${outOfOrder} cue(s) out of order`);
    }

    if (options.durationMs && options.durationMs > 0) {
        const runtimeSec = options.durationMs / 1000;
        const minCues = Math.floor(runtimeSec / 120);
        const maxCues = Math.ceil(runtimeSec);
        if (cues.length < Math.max(minCues, 1)) {
            return { ok: false, reason: `only ${cues.length} cues for ${Math.round(runtimeSec)}s runtime`, cues, warnings };
        }
        if (cues.length > maxCues) {
            return { ok: false, reason: `${cues.length} cues exceed ${Math.round(runtimeSec)}s runtime`, cues, warnings };
        }
        if (maxEndMs > options.durationMs + 60000) {
            return { ok: false, reason: `last cue ends at ${maxEndMs}ms, beyond runtime`, cues, warnings };
        }
    }

    return { ok: true, reason: null, cues, warnings };
}

function probeDurationMs(videoPath) {
    try {
        const out = execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
            { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString().trim();
        const seconds = Number(out);
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        return Math.round(seconds * 1000);
    } catch (e) {
        return null;
    }
}

module.exports = {
    WATERMARK_TEXT,
    parseSRT,
    buildSRT,
    timeToMs,
    msToTime,
    normalizeToUtf8,
    looksArabic,
    arabicRatio,
    validateSRT,
    probeDurationMs
};
