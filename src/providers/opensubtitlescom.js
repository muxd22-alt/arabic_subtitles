const net = require('../net.js');
const langs = require('../langs.js');
const config = require('../config.js');

/**
 * OpenSubtitles.com — the largest subtitle database, including Arabic. The
 * REST API is free but needs two things: a free API key (`OPENSUBTITLES_API_KEY`,
 * from opensubtitles.com → profile) and, for the download step, a free account
 * (`OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD`). Nothing here is paid:
 * without the credentials the stall reports "Not configured" and the rest of the
 * bazaar carries on.
 *
 * API: https://api.opensubtitles.com/api/v1
 */

const API = 'https://api.opensubtitles.com/api/v1';

function credentials(ctx = {}) {
    return {
        apiKey: ctx.apiKey || process.env.OPENSUBTITLES_API_KEY || '',
        username: ctx.username || process.env.OPENSUBTITLES_USERNAME || '',
        password: ctx.password || process.env.OPENSUBTITLES_PASSWORD || ''
    };
}

function baseHeaders(apiKey) {
    return {
        'Api-Key': apiKey,
        'User-Agent': config.USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
}

async function login(ctx = {}) {
    const http = ctx.http || net;
    const { apiKey, username, password } = credentials(ctx);
    if (!apiKey || !username || !password) throw new Error('opensubtitles.com needs an API key and account credentials');
    const res = await http.httpRequest(`${API}/login`, {
        method: 'POST',
        headers: baseHeaders(apiKey),
        body: JSON.stringify({ username, password }),
        timeoutMs: ctx.timeoutMs
    });
    if (!res.ok) throw new Error(`opensubtitles.com login failed: HTTP ${res.status} ${net.snippet(res.buffer.toString('utf8'))}`);
    const data = JSON.parse(res.buffer.toString('utf8'));
    if (!data.token) throw new Error('opensubtitles.com login returned no token');
    return data.token;
}

async function search(release, ctx = {}) {
    const { apiKey } = credentials(ctx);
    if (!apiKey) return [];
    const http = ctx.http || net;

    const query = (release.queries[0] || {}).title || release.title;
    if (!query && !release.imdb && !release.tmdb) return [];

    const params = new URLSearchParams({ order_by: 'download_count', order_direction: 'desc' });
    const languageCodes = (ctx.sourceLanguages && ctx.sourceLanguages.length ? ctx.sourceLanguages : ['ar', 'en'])
        .map((c) => String(c).toLowerCase());
    params.set('languages', languageCodes.join(','));
    if (query) params.set('query', query);
    if (release.year) params.set('year', String(release.year));
    if (release.imdb) params.set('imdb_id', String(release.imdb).replace(/^tt/, ''));
    if (release.tmdb) params.set('tmdb_id', String(release.tmdb));
    if (release.isSeries && release.season != null) params.set('season_number', String(release.season));
    if (release.isSeries && release.episode != null) params.set('episode_number', String(release.episode));
    params.set('type', release.isSeries ? 'episode' : 'movie');

    let data;
    try {
        data = await http.httpGetJson(`${API}/subtitles?${params.toString()}`, {
            timeoutMs: ctx.timeoutMs,
            headers: baseHeaders(apiKey)
        });
    } catch (e) {
        if (/HTTP 404/.test(e.message)) return [];
        throw e;
    }

    const rows = Array.isArray(data.data) ? data.data : [];
    return rows.map((row) => {
        const attrs = row.attributes || {};
        const file = (attrs.files || [])[0] || {};
        const details = attrs.feature_details || {};
        const language = attrs.language || '';
        return {
            provider: 'opensubtitlescom',
            id: String(row.id),
            fileId: file.file_id,
            language,
            langCode: langs.codeFor(language),
            releaseName: attrs.release || file.file_name || details.title || null,
            downloads: Number(attrs.download_count || 0),
            hd: Boolean(attrs.hd),
            hearingImpaired: Boolean(attrs.hearing_impaired),
            machineTranslated: Boolean(attrs.machine_translated),
            season: details.season_number != null ? Number(details.season_number) : release.season,
            episode: details.episode_number != null ? Number(details.episode_number) : release.episode,
            extra: { fileId: file.file_id, subtitleId: row.id, remaining: null }
        };
    }).filter((c) => c.extra.fileId);
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const { apiKey, username, password } = credentials(ctx);
    if (!apiKey) throw new Error('opensubtitles.com API key missing');

    const headers = baseHeaders(apiKey);
    if (username && password) {
        const token = await login(ctx);
        headers.Authorization = `Bearer ${token}`;
    }

    const res = await http.httpRequest(`${API}/download`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_id: candidate.extra.fileId, sub_format: 'srt' }),
        timeoutMs: ctx.timeoutMs
    });
    if (!res.ok) {
        throw new Error(`opensubtitles.com download failed: HTTP ${res.status} ${net.snippet(res.buffer.toString('utf8'))}`);
    }
    const data = JSON.parse(res.buffer.toString('utf8'));
    if (!data.link) throw new Error('opensubtitles.com returned no download link');
    if (data.remaining !== undefined) candidate.extra.remaining = data.remaining;

    const file = await http.httpGet(data.link, {
        timeoutMs: ctx.timeoutMs,
        headers: { 'User-Agent': config.USER_AGENT, 'Api-Key': apiKey }
    });
    return { name: data.file_name || `opensubtitles-${candidate.id}.srt`, data: file.buffer };
}

module.exports = {
    id: 'opensubtitlescom',
    label: 'opensubtitlescom',
    kind: 'network',
    requires: ['OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD'],
    priority: 8,
    supports: { movies: true, series: true },
    available(ctx = {}) {
        const { apiKey, username, password } = credentials(ctx);
        if (!apiKey) return { ok: false, reason: 'free API key missing — set OPENSUBTITLES_API_KEY (opensubtitles.com → profile)' };
        if (!username || !password) return { ok: false, reason: 'free account missing — set OPENSUBTITLES_USERNAME / OPENSUBTITLES_PASSWORD' };
        return { ok: true };
    },
    search,
    download,
    login
};
