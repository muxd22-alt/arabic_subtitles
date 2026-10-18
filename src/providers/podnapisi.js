const net = require('../net.js');
const langs = require('../langs.js');
const { text, all } = require('../scrape.js');

/**
 * Podnapisi — an old-fashioned, keyless XML search endpoint. Asking for every
 * language and filtering locally keeps it to a single request per title (their
 * numeric language ids are not worth trusting).
 *
 * https://www.podnapisi.net
 */

const SERVER = 'https://www.podnapisi.net';

function tag(block, ...names) {
    for (const name of names) {
        const m = new RegExp(`<${name}[^>]*>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i').exec(block);
        if (m) return m[1].trim();
    }
    return null;
}

function parseResults(xml) {
    const blocks = all(/<subtitle>([\s\S]*?)<\/subtitle>/gi, xml);
    return blocks.map((block) => {
        const pid = tag(block, 'pid', 'id');
        if (!pid) return null;
        const langName = tag(block, 'language_name', 'languageName', 'language');
        const releases = all(/<release>([\s\S]*?)<\/release>/gi, block).map(text).filter(Boolean);
        return {
            provider: 'podnapisi',
            id: pid,
            language: langName,
            langCode: langs.codeFor(langName),
            title: tag(block, 'title'),
            year: Number(tag(block, 'year')) || null,
            releaseName: releases[0] || null,
            releases,
            downloads: Number(tag(block, 'downloads', 'download_count')) || 0,
            pageUrl: tag(block, 'url'),
            extra: { pid, pageUrl: tag(block, 'url') }
        };
    }).filter(Boolean);
}

async function search(release, ctx = {}) {
    const http = ctx.http || net;
    const query = (release.queries[0] || {}).title || release.title;
    if (!query) return [];

    const url = `${SERVER}/subtitles/search/old?sXML=1&sK=${encodeURIComponent(query)}` +
        (release.year ? `&sY=${release.year}` : '');
    let res;
    try {
        res = await http.httpGet(url, { timeoutMs: ctx.timeoutMs, headers: { Accept: 'application/xml,text/xml,*/*' } });
    } catch (e) {
        if (/HTTP 404/.test(e.message)) return [];
        throw e;
    }
    const xml = res.buffer.toString('utf8');
    if (!/<subtitle>/i.test(xml)) return [];

    const wantedTitle = String(release.title || query).toLowerCase();
    return parseResults(xml)
        .filter((c) => !c.title || c.title.toLowerCase().includes(wantedTitle) || wantedTitle.includes(c.title.toLowerCase()))
        .map((c) => Object.assign(c, {
            season: release.season,
            episode: release.episode
        }));
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const pid = candidate.extra.pid;
    const attempts = [
        `${SERVER}/subtitles/${encodeURIComponent(pid)}/download`,
        `${SERVER}/en/subtitles/${encodeURIComponent(pid)}/download`
    ];

    let lastError = null;
    for (const url of attempts) {
        try {
            const res = await http.httpGet(url, { timeoutMs: ctx.timeoutMs });
            return { name: `podnapisi-${pid}.zip`, data: res.buffer };
        } catch (e) {
            lastError = e;
        }
    }

    // The detail page usually carries the same download link; using it is a
    // slower but more durable path than guessing ids.
    if (candidate.extra.pageUrl) {
        const page = await http.httpGet(candidate.extra.pageUrl, { timeoutMs: ctx.timeoutMs });
        const html = page.buffer.toString('utf8');
        const href = all(/href="([^"]*\/download[^"]*)"/gi, html)[0];
        if (href) {
            const res = await http.httpGet(new URL(href, SERVER).toString(), { timeoutMs: ctx.timeoutMs });
            return { name: `podnapisi-${pid}.zip`, data: res.buffer };
        }
    }
    throw lastError || new Error('podnapisi download link not found');
}

module.exports = {
    id: 'podnapisi',
    label: 'podnapisi',
    kind: 'network',
    requires: [],
    priority: 6,
    supports: { movies: true, series: true },
    available: () => ({ ok: true }),
    search,
    download,
    parseResults
};
