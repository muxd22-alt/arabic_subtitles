const path = require('path');
const torrentTitle = require('parse-torrent-title');

// Noise that commonly survives a failed parse: release tags, quality, codec, group names.
const NOISE_TOKENS = new Set([
    '480p', '576p', '720p', '1080p', '2160p', '4k', '8k', 'uhd', 'hd', 'sd',
    'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'hddvd',
    'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'dvdrip', 'dvd', 'dvdscr', 'scr', 'cam', 'hdcam', 'tc',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', '10bit', '8bit', 'hdr', 'hdr10', 'dv',
    'aac', 'ac3', 'eac3', 'dts', 'ddp', 'dd5', 'atmos', 'truehd', 'flac', 'mp3',
    'proper', 'repack', 'extended', 'unrated', 'theatrical', 'limited', 'internal', 'complete', 'multi',
    'sub', 'subs', 'subbed', 'dubbed', 'dual', 'hc', 'hardcoded', 'crf',
    'mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'webm', 'ts'
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.flv', '.mpg', '.mpeg', '.webm']);

// A "title" made only of release/container tokens is not a title at all.
function isNoiseTitle(title) {
    const tokens = title.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => NOISE_TOKENS.has(t) || /^\d{3,4}p$/.test(t));
}

function stripExtension(name) {
    const ext = path.extname(name);
    return VIDEO_EXTENSIONS.has(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}

function stripDirectory(name) {
    return path.basename(name);
}

function normalizeWhitespace(text) {
    return text.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isValidYear(year) {
    if (!Number.isInteger(year)) return false;
    return year >= 1888 && year <= new Date().getFullYear() + 2;
}

// Fuzzy fallback: keep words, drop bracketed chunks and known release tags.
function cleanTitleFallback(raw) {
    let text = raw
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\{[^}]*\}/g, ' ');

    text = normalizeWhitespace(text);

    text = text
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/S\d{1,2}\s?E\d{1,3}/gi, ' ')
        .replace(/\b(?:x|h|avc|hevc|mpeg)[\s.-]?26[45]\b/gi, ' ')
        .replace(/[a-zA-Z]+[0-9]{2,4}\b/g, (m) => (NOISE_TOKENS.has(m.toLowerCase()) ? ' ' : m));

    text = normalizeWhitespace(text);
    const words = text
        .split(' ')
        .filter((word) => {
            const lower = word.toLowerCase();
            if (NOISE_TOKENS.has(lower)) return false;
            if (/^\d{1,4}p$/.test(lower)) return false;
            if (/^-|[.-]$/.test(lower)) return false;
            if (NOISE_TOKENS.has(lower.replace(/[^a-z0-9]/g, ''))) return false;
            return true;
        });

    // Drop bare numeric leftovers ("264", "2013") unless that would empty the title
    const meaningful = words.filter((word) => !/^\d{2,4}$/.test(word));
    const kept = meaningful.length > 0 ? meaningful : words;

    return kept.join(' ').replace(/[\s\-.\[(]+$/, '').replace(/^[\s\-.\[(]+/, '').trim();
}

/**
 * Identify a movie (or episode) from a filename or path.
 * Primary path uses parse-torrent-title (proven release-name parser);
 * falls back to a cleaned/fuzzy title when the parser finds nothing.
 *
 * @param {string} input file name, full path, or already-stripped release name
 * @returns {{title: string|null, year: number|null, season: number|null,
 *            episode: number|null, type: string, source: string, raw: string}}
 */
function identifyMovie(input) {
    const raw = normalizeWhitespace(stripExtension(stripDirectory(String(input || ''))));
    const empty = { title: null, year: null, season: null, episode: null, type: 'unknown', source: 'none', raw };

    if (!raw) return empty;

    let parsed = {};
    try {
        parsed = torrentTitle.parse(raw) || {};
    } catch (e) {
        parsed = {};
    }

    let title = typeof parsed.title === 'string' ? normalizeWhitespace(parsed.title) : '';
    let source = 'parse-torrent-title';
    if (!title || title.length < 2 || isNoiseTitle(title)) {
        title = cleanTitleFallback(raw);
        source = 'fallback';
        if (isNoiseTitle(title)) title = '';
    }

    const year = isValidYear(parsed.year) ? parsed.year : null;
    const season = Number.isInteger(parsed.season) ? parsed.season : null;
    const episode = Number.isInteger(parsed.episode) ? parsed.episode : null;

    if (!title || title.length < 2) {
        return Object.assign({}, empty, { source: 'fallback' });
    }

    return {
        title,
        year,
        season,
        episode,
        type: season !== null && episode !== null ? 'episode' : 'movie',
        source,
        raw
    };
}

module.exports = { identifyMovie, cleanTitleFallback, isValidYear };
