const net = require('../net.js');
const langs = require('../langs.js');
const { titleMatch } = require('../scrape.js');

/**
 * Gestdown — a free, keyless JSON API over the Addic7ed library, so it covers
 * series (and only series). Two calls: find the show, list the episode's
 * subtitles per language. Responses are plain SRT — nothing to unpack.
 *
 * https://api.gestdown.info
 */

const SERVER = 'https://api.gestdown.info';

// Gestdown searches by the English language name; anything not in this map is
// simply not offered by their API.
const API_LANGUAGES = {
    ar: 'arabic', en: 'english', es: 'spanish', fr: 'french', de: 'german', it: 'italian',
    pt: 'portuguese', 'pt-br': 'brazilian-portuguese', nl: 'dutch', pl: 'polish', ru: 'russian',
    tr: 'turkish', fa: 'farsi', he: 'hebrew', el: 'greek', zh: 'chinese', ja: 'japanese',
    ko: 'korean', ar_eg: 'arabic', sv: 'swedish', no: 'norwegian', da: 'danish', fi: 'finnish',
    cs: 'czech', hu: 'hungarian', ro: 'romanian', bg: 'bulgarian', hr: 'croatian', sr: 'serbian',
    sl: 'slovenian', uk: 'ukrainian', vi: 'vietnamese', id: 'indonesian', th: 'thai'
};

async function findShow(release, ctx) {
    const http = ctx.http || net;
    const query = (release.queries[0] || {}).title || release.title;
    if (!query) return null;
    const data = await http.httpGetJson(`${SERVER}/shows/search/${encodeURIComponent(query)}`, {
        timeoutMs: ctx.timeoutMs
    });
    const shows = Array.isArray(data.shows) ? data.shows : [];
    if (shows.length === 0) return null;

    const scored = shows.map((show) => {
        let score = titleMatch(show.name, query);
        if (release.imdb && show.imdbId && `tt${String(show.imdbId).replace(/^tt/, '')}` === release.imdb) score += 1;
        if (release.tmdb && show.tmdbId && String(show.tmdbId) === String(release.tmdb)) score += 1;
        if (release.season != null && Array.isArray(show.seasons) && !show.seasons.includes(Number(release.season))) score -= 0.3;
        return { show, score };
    }).sort((a, b) => b.score - a.score);

    return scored[0].score >= 0.5 ? scored[0].show : null;
}

async function search(release, ctx = {}) {
    if (!release.isSeries || release.season == null || release.episode == null) return [];
    const http = ctx.http || net;

    const show = await findShow(release, ctx);
    if (!show) return [];

    const wanted = [];
    for (const code of ctx.sourceLanguages || ['ar', 'en']) {
        const apiLang = API_LANGUAGES[String(code).toLowerCase()];
        if (apiLang && !wanted.includes(apiLang)) wanted.push(apiLang);
    }
    if (wanted.length === 0) wanted.push('english');

    const results = await Promise.all(wanted.map(async (apiLang) => {
        try {
            const data = await http.httpGetJson(
                `${SERVER}/subtitles/get/${show.id}/${release.season}/${release.episode}/${apiLang}`,
                { timeoutMs: ctx.timeoutMs }
            );
            return { apiLang, list: Array.isArray(data.matchingSubtitles) ? data.matchingSubtitles : [] };
        } catch (e) {
            if (/HTTP 404/.test(e.message)) return { apiLang, list: [] };
            throw e;
        }
    }));

    const candidates = [];
    for (const { apiLang, list } of results) {
        for (const sub of list) {
            candidates.push({
                provider: 'gestdown',
                id: sub.subtitleId,
                language: sub.language || apiLang,
                langCode: langs.codeFor(sub.language || apiLang),
                releaseName: sub.version || null,
                show: show.name,
                season: release.season,
                episode: release.episode,
                downloads: sub.downloadCount || 0,
                corrected: Boolean(sub.corrected),
                hd: Boolean(sub.hd),
                source: sub.source || 'Addic7ed',
                extra: { subtitleId: sub.subtitleId }
            });
        }
    }
    return candidates;
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const res = await http.httpGet(`${SERVER}/subtitles/download/${encodeURIComponent(candidate.id)}`, {
        timeoutMs: ctx.timeoutMs
    });
    return { name: `${candidate.provider}-${candidate.id}.srt`, data: res.buffer };
}

module.exports = {
    id: 'gestdown',
    label: 'gestdown',
    kind: 'network',
    requires: [],
    priority: 2,
    supports: { movies: false, series: true },
    available: () => ({ ok: true }),
    search,
    download
};
