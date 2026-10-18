const net = require('../net.js');
const langs = require('../langs.js');

/**
 * Subdl — a free aggregator (opensubtitles + subscene archives) that indexes
 * Arabic well. It only asks for a free API key from an account, never payment;
 * without `SUBDL_API_KEY` the stall simply stays closed and is reported as
 * "Not configured" instead of failing the run.
 *
 * https://subdl.com  →  API: https://api.subdl.com/api/v1/subtitles
 */

const API = 'https://api.subdl.com/api/v1/subtitles';
const DOWNLOAD = 'https://dl.subdl.com';

function apiKey(ctx = {}) {
    return ctx.apiKey || process.env.SUBDL_API_KEY || '';
}

function languageList(codes) {
    return codes.map((c) => String(c).toUpperCase()).join(',');
}

async function search(release, ctx = {}) {
    const key = apiKey(ctx);
    if (!key) return [];
    const http = ctx.http || net;

    const query = (release.queries[0] || {}).title || release.title;
    if (!query) return [];

    const languageCodes = (ctx.sourceLanguages && ctx.sourceLanguages.length ? ctx.sourceLanguages : ['ar', 'en'])
        .map((c) => String(c).toLowerCase());

    const params = new URLSearchParams({
        api_key: key,
        languages: languageList(languageCodes),
        subs_per_page: '30',
        type: release.isSeries ? 'tv' : 'movie'
    });
    if (release.isSeries) {
        params.set('tv_name', query);
        if (release.season != null) params.set('season_number', String(release.season));
        if (release.episode != null) params.set('episode_number', String(release.episode));
    } else {
        params.set('film_name', query);
        if (release.year) params.set('year', String(release.year));
    }
    if (release.imdb) params.set('imdb_id', release.imdb);
    if (release.tmdb) params.set('tmdb_id', String(release.tmdb));

    let data;
    try {
        data = await http.httpGetJson(`${API}?${params.toString()}`, {
            timeoutMs: ctx.timeoutMs,
            headers: { Accept: 'application/json' }
        });
    } catch (e) {
        if (/HTTP 404/.test(e.message)) return [];
        throw e;
    }
    if (data && data.status === false) {
        throw new Error(`subdl rejected the request: ${data.error || data.message || 'unknown error'}`);
    }

    const list = Array.isArray(data.subtitles) ? data.subtitles : (Array.isArray(data.results) ? data.results : []);
    return list.map((item) => {
        const url = item.url || item.download_url || null;
        const language = item.language || item.lang || '';
        return {
            provider: 'subdl',
            id: String(item.sd_id || item.id || url || ''),
            language,
            langCode: langs.codeFor(language),
            releaseName: item.release_name || item.name || null,
            downloads: Number(item.downloads || item.download_count || 0),
            season: item.season != null ? Number(item.season) : release.season,
            episode: item.episode != null ? Number(item.episode) : release.episode,
            extra: { url }
        };
    }).filter((c) => c.extra.url);
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const url = String(candidate.extra.url);
    const full = /^https?:/i.test(url) ? url : `${DOWNLOAD}${url.startsWith('/') ? '' : '/'}${url}`;
    const res = await http.httpGet(full, { timeoutMs: ctx.timeoutMs });
    return { name: `subdl-${candidate.id}.zip`, data: res.buffer };
}

module.exports = {
    id: 'subdl',
    label: 'subdl',
    kind: 'network',
    requires: ['SUBDL_API_KEY'],
    priority: 7,
    supports: { movies: true, series: true },
    available(ctx = {}) {
        return apiKey(ctx)
            ? { ok: true }
            : { ok: false, reason: 'free API key missing — set SUBDL_API_KEY (subdl.com → profile → API)' };
    },
    search,
    download
};
