const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const net = require('./net.js');
const { titleMatch } = require('./scrape.js');

/**
 * Title → IMDb id, the free way.
 *
 * Several providers (YIFYSubtitles, and the download APIs that prefer exact
 * ids) are only accurate when asked by IMDb id. IMDb's own public suggestion
 * endpoint answers that question without a key or an account, so the bazaar
 * uses it once per title and caches the answer on disk — the same lookup is
 * never paid for twice, even across restarts.
 */

const SUGGESTION_HOST = 'https://v3.sg.media-imdb.com';
const CACHE_FILE = 'imdb-cache.json';
const MAX_ENTRIES = 2000;

let memory = null;

function cachePath() {
    return process.env.IMDB_CACHE || path.join(config.HOME, CACHE_FILE);
}

function load() {
    if (memory) return memory;
    try {
        const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
        memory = raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
        memory = {};
    }
    return memory;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
        const entries = Object.entries(memory || {}).slice(-MAX_ENTRIES);
        fs.writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n', 'utf8');
    } catch (e) {
        // the cache is an optimisation only
    }
}

function cacheKey(release) {
    return `${String(release.title || '').toLowerCase()}|${release.year || ''}|${release.isSeries ? 'tv' : 'movie'}`;
}

function scoreEntry(entry, release) {
    if (!entry || !/^tt\d+/.test(String(entry.id || ''))) return -1;
    let score = titleMatch(entry.l, release.title);
    const qid = String(entry.qid || entry.q || '');
    if (release.isSeries) {
        if (/tvSeries|tvMiniSeries|tvEpisode/.test(qid)) score += 0.5;
        else if (/movie|video|short/.test(qid)) score -= 0.35;
    } else if (/movie|video/.test(qid)) {
        score += 0.35;
    } else if (/tvSeries|tvMiniSeries/.test(qid)) {
        score -= 0.2;
    }
    if (release.year && entry.y) {
        if (Number(entry.y) === Number(release.year)) score += 0.4;
        else score -= Math.min(0.5, Math.abs(Number(entry.y) - Number(release.year)) / 20);
    }
    return score;
}

/**
 * Resolve an IMDb id for a parsed release. Returns null when nothing convincing
 * comes back — callers treat that as "no id", never as an error.
 */
async function resolveImdbId(release, options = {}) {
    if (!release) return null;
    if (release.imdb) return release.imdb;

    const cache = load();
    const key = cacheKey(release);
    if (cache[key] && options.refresh !== true) return cache[key];

    const http = options.http || net;
    const queries = [release.title, ...((release.queries || []).map((q) => q.title))].filter(Boolean);
    let best = null;

    for (const query of queries.slice(0, 2)) {
        let data;
        try {
            data = await http.httpGetJson(
                `${SUGGESTION_HOST}/suggestion/x/${encodeURIComponent(query)}.json?includeVideos=0`,
                { timeoutMs: options.timeoutMs || 12000, headers: { Accept: 'application/json' } }
            );
        } catch (e) {
            continue;
        }
        for (const entry of (data && data.d) || []) {
            const score = scoreEntry(entry, release);
            if (score > 0 && (!best || score > best.score)) best = { score, id: entry.id, title: entry.l, year: entry.y };
        }
        if (best && best.score >= 1.2) break;
    }

    if (!best || best.score < 0.8) return null;
    cache[key] = best.id;
    memory = cache;
    save();
    return best.id;
}

function clearCache() {
    memory = {};
    save();
}

module.exports = { resolveImdbId, clearCache, cachePath, scoreEntry };
