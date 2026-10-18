const { timeToMs } = require('../srt.js');

/**
 * The fit check every downloaded subtitle passes before it is adopted.
 *
 * A provider can return a "signs only" file, a preview, the wrong release, or
 * a plain HTML error page that happens to parse — none of which should replace
 * transcription. The rules are deliberately blunt: they only reject material
 * that is obviously not a full subtitle for this video, because the cost of a
 * false rejection is 20–40 minutes of whisper.
 *
 * Whisper output is exempt — it was generated against this exact file.
 */

const MIN_CUES = 8;
const MIN_CHARS = 300;
const TAIL_SLACK_MS = 90 * 1000;

const INVISIBLE_RE = /[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Characters a viewer would actually see (tags and bidi marks excluded). */
function visibleChars(cues) {
    return (cues || []).reduce(
        (sum, cue) => sum + String(cue.text || '').replace(INVISIBLE_RE, '').length,
        0
    );
}

/** The latest cue end, in milliseconds, or null when nothing parses. */
function lastEndMs(cues) {
    let max = null;
    for (const cue of cues || []) {
        const end = timeToMs(cue.end);
        if (end === null) continue;
        if (max === null || end > max) max = end;
    }
    return max;
}

function checkFit(cues, options = {}) {
    let list = cues;
    if (typeof cues === 'string') {
        const { parseSRT } = require('../srt.js');
        list = parseSRT(cues);
    }
    list = Array.isArray(list) ? list : [];
    const minCues = options.minCues !== undefined ? options.minCues : MIN_CUES;
    const minChars = options.minChars !== undefined ? options.minChars : MIN_CHARS;
    const tailSlackMs = options.tailSlackMs !== undefined ? options.tailSlackMs : TAIL_SLACK_MS;

    const stats = {
        cues: list.length,
        chars: visibleChars(list),
        lastEndMs: lastEndMs(list),
        durationMs: Number(options.durationMs) || null
    };

    if (list.length < minCues) {
        return { ok: false, reason: 'too-few-cues', stats };
    }
    if (stats.chars < minChars) {
        return { ok: false, reason: 'signs-only', stats };
    }
    if (stats.durationMs && stats.lastEndMs !== null && stats.lastEndMs > stats.durationMs + tailSlackMs) {
        return { ok: false, reason: 'out-of-range', stats };
    }
    return { ok: true, reason: null, stats };
}

function describeFit(fit) {
    if (!fit) return '';
    const { stats } = fit;
    const parts = [`${stats.cues} cues`, `${stats.chars} chars`];
    if (stats.durationMs && stats.lastEndMs !== null) {
        parts.push(`ends ${Math.round(stats.lastEndMs / 1000)}s of ${Math.round(stats.durationMs / 1000)}s`);
    }
    return parts.join(', ');
}

module.exports = { checkFit, describeFit, visibleChars, lastEndMs, MIN_CUES, MIN_CHARS, TAIL_SLACK_MS };
