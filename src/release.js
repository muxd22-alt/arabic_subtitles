const fs = require('fs');
const path = require('path');

/**
 * Offline release-name parser — the "guessit" the bazaar needs to ask the right
 * question. Everything here runs from the file name plus, when present, the NFO
 * and folder metadata a media library already has around the video; nothing is
 * fetched, so it can never fail a run.
 */

const RESOLUTION = /\b(?:2160p|1440p|1080p|720p|576p|480p|4k|uhd|8k|sd)\b/;
const SOURCE = /\b(?:bluray|blu-?ray|bdremux|bdr|brrip|bdrip|web-?dl|web-?rip|web|hdrip|hdtv|dvdrip|dvdscr|dvd|remux|vhsrip|tvrip|satrip|ppvrip|cam|ts|tc|r5|vodrip|webcap)\b/;
const CODEC = /\b(?:x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|av1|vp9|mpeg-?2|10bit|8bit)\b/;
const AUDIO = /\b(?:aac|ac3|eac3|ddp?|dts(?:-hd)?|truehd|atmos|flac|mp3|opus|dd5\.?1|5\.1|7\.1|2\.0|6ch|8ch)\b/;
const MISC = /\b(?:proper|repack|rerip|internal|extended|remastered|unrated|uncut|directors?[ .-]?cut|imax|multi|dual|dual[ .-]?audio|subbed|dubbed|hdr|hdr10|dv|dolby[ .-]?vision|complete|limited|festival|anniversary|edition|final|season\s?\d+\s?(?:complete|pack)|hdtc|nf|amzn|dsnp|atvp|hmax|pcok|stan|itunes|it|repack)\b/;

const TITLE_CUT = new RegExp(
    `(${[RESOLUTION, SOURCE, CODEC, AUDIO, MISC].map((re) => re.source).join('|')})`
);

const SEASON_EPISODE_PATTERNS = [
    /\bS(\d{1,2})[\s._-]*E(\d{1,3})(?:[\s._-]*E(\d{1,3}))?(?:[\s._-]*E(\d{1,3}))?\b/i,
    /\b(\d{1,2})x(\d{2,3})\b/,
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i,
    /\bS(\d{1,2})\b/,
    /\bEpisode[\s._-]*(\d{1,3})\b/i
];

function stripBrackets(name) {
    // [Group] Movie ... — leading bracket tags are always noise, not title
    let out = String(name || '');
    for (let i = 0; i < 3; i++) {
        const next = out.replace(/^\s*[[({][^\])}]{0,40}[\])}]\s*/, '');
        if (next === out) break;
        out = next;
    }
    return out;
}

function cleanName(name) {
    return stripBrackets(String(name || '').replace(/\.[a-z0-9]{2,4}$/i, ''))
        .replace(/[._]+/g, ' ')
        .replace(/\s*-\s*/g, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractYear(text, after = 0) {
    const re = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;
    re.lastIndex = after;
    const m = re.exec(text);
    return m ? { year: Number(m[1]), index: m.index } : { year: null, index: -1 };
}

function extractSeasonEpisode(text) {
    for (const re of SEASON_EPISODE_PATTERNS) {
        const m = re.exec(text);
        if (!m) continue;
        if (re === SEASON_EPISODE_PATTERNS[0]) {
            const episodes = [m[2], m[3], m[4]].filter(Boolean).map(Number);
            return { season: Number(m[1]), episode: episodes[0], episodes, index: m.index };
        }
        if (re === SEASON_EPISODE_PATTERNS[1]) {
            return { season: Number(m[1]), episode: Number(m[2]), episodes: [Number(m[2])], index: m.index };
        }
        if (re === SEASON_EPISODE_PATTERNS[2]) {
            return { season: Number(m[1]), episode: Number(m[2]), episodes: [Number(m[2])], index: m.index };
        }
        if (re === SEASON_EPISODE_PATTERNS[3]) {
            return { season: Number(m[1]), episode: null, episodes: [], index: m.index };
        }
        return { season: null, episode: Number(m[1]), episodes: [Number(m[1])], index: m.index };
    }
    return { season: null, episode: null, episodes: [], index: -1 };
}

function readNfo(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const candidates = [`${base}.nfo`, 'movie.nfo', 'tvshow.nfo'];

    for (const name of candidates) {
        const file = path.join(dir, name);
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (e) {
            continue;
        }
        const info = { file, title: null, originalTitle: null, year: null, imdb: null, tmdb: null, season: null, episode: null };
        const tag = (name2) => {
            const m = new RegExp(`<${name2}[^>]*>\\s*([^<]+?)\\s*</${name2}>`, 'i').exec(raw);
            return m ? m[1].trim() : null;
        };
        info.title = tag('title');
        info.originalTitle = tag('originaltitle');
        const y = tag('year') || tag('premiered') || tag('releasedate');
        const ym = y ? /((?:19|20)\d{2})/.exec(y) : null;
        info.year = ym ? Number(ym[1]) : null;
        info.imdb = tag('imdbid') || tag('imdb');
        const unique = /<uniqueid[^>]*type="imdb"[^>]*>\s*([^<]+?)\s*</i.exec(raw);
        if (!info.imdb && unique) info.imdb = unique[1].trim();
        info.tmdb = tag('tmdbid') || tag('tmdb');
        const uniqueTmdb = /<uniqueid[^>]*type="tmdb"[^>]*>\s*([^<]+?)\s*</i.exec(raw);
        if (!info.tmdb && uniqueTmdb) info.tmdb = uniqueTmdb[1].trim();
        info.season = tag('season');
        info.episode = tag('episode');
        if (info.imdb && !/^tt\d+/.test(info.imdb)) info.imdb = null;
        return info;
    }
    return null;
}

/**
 * Parse a video path into everything a subtitle provider needs:
 * title, year, season/episode, imdb/tmdb ids and a couple of search queries.
 *
 * `options.metadata` may carry ffprobe container tags ({title, date, show,
 * season, episode}); they are used only to fill gaps the file name left.
 */
function parseRelease(videoPath, options = {}) {
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const cleaned = cleanName(baseName);
    const nfo = options.nfo !== undefined ? options.nfo : readNfo(videoPath);
    const metadata = options.metadata || {};

    const se = extractSeasonEpisode(cleaned);
    const yearMatch = extractYear(cleaned);
    const titleEnd = [se.index, yearMatch.index].filter((i) => i > 0).sort((a, b) => a - b)[0];
    let title = titleEnd ? cleaned.slice(0, titleEnd) : cleaned;
    const cutMatch = TITLE_CUT.exec(title);
    if (cutMatch && cutMatch.index > 0) title = title.slice(0, cutMatch.index);
    title = title.replace(/\s*-\s*$/, '').replace(/[-–\s]+$/, '').trim();

    // A folder that looks like a show ("Show/Season 02/…") is stronger evidence
    // than a file name that forgot the season.
    const parent = path.basename(path.dirname(videoPath));
    const parentSe = /season[\s._-]*(\d{1,2})/i.exec(parent);
    const parentTitle = parent && !/^(movies?|tv|series|shows?|video|downloads?|media)$/i.test(parent)
        ? cleanName(parent.replace(/season[\s._-]*\d{1,2}.*$/i, ''))
        : null;

    const metaTitle = metadata.title || metadata.show || null;
    const metaYear = metadata.date ? (extractYear(String(metadata.date)) || {}).year : null;

    let finalTitle = title;
    let titleSource = 'file';
    if (metaTitle && (!title || title.length < 2)) { finalTitle = cleanName(metaTitle); titleSource = 'metadata'; }
    if (nfo && nfo.title) { finalTitle = nfo.title; titleSource = 'nfo'; }
    if (!finalTitle && parentTitle) { finalTitle = parentTitle; titleSource = 'folder'; }

    const season = se.season != null ? se.season
        : (parentSe ? Number(parentSe[1]) : (nfo && nfo.season ? Number(nfo.season) : (metadata.season ? Number(metadata.season) : null)));
    const episode = se.episode != null ? se.episode
        : (nfo && nfo.episode ? Number(nfo.episode) : (metadata.episode ? Number(metadata.episode) : null));
    const year = yearMatch.year || (nfo && nfo.year) || metaYear || null;

    const isSeries = Boolean(season != null || episode != null);
    const altTitles = [];
    if (nfo && nfo.originalTitle && nfo.originalTitle !== finalTitle) altTitles.push(nfo.originalTitle);
    if (parentTitle && parentTitle !== finalTitle && isSeries) altTitles.push(parentTitle);

    // Trim the " - Group" tail that survived when no tag preceded it.
    const queries = [];
    const seen = new Set();
    for (const t of [finalTitle, ...altTitles]) {
        const key = `${t}`.toLowerCase();
        if (!t || t.length < 2 || seen.has(key)) continue;
        seen.add(key);
        queries.push({ title: t, year });
    }

    return {
        videoPath,
        baseName,
        title: finalTitle,
        year,
        isSeries,
        season,
        episode,
        episodes: se.episodes,
        imdb: (nfo && nfo.imdb) || metadata.imdb || null,
        tmdb: (nfo && nfo.tmdb) || metadata.tmdb || null,
        queries,
        nfoFile: nfo ? nfo.file : null,
        source: { title: titleSource, nfo: Boolean(nfo) },
        cleaned
    };
}

module.exports = {
    parseRelease,
    cleanName,
    extractYear,
    extractSeasonEpisode,
    readNfo
};
