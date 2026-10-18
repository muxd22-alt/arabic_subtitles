const net = require('../net.js');
const langs = require('../langs.js');
const { text, blocks, all } = require('../scrape.js');

/**
 * YIFYSubtitles — free and keyless, movies only, and unusually strong on
 * Arabic: the community there uploads Arabic translations for most mainstream
 * releases. Every subtitle sits on a per-movie page and downloads as a zip.
 *
 * The site only lets the download through with the details page as Referer, so
 * both requests go out together.
 */

const SERVER = process.env.YIFYSUB_URL || 'https://yifysubtitles.ch';

function parseMoviePage(html) {
    const out = [];
    for (const row of blocks(html, /<tr[^>]*data-id="/g)) {
        const hrefMatch = /<a[^>]*href="(\/subtitles\/[^"]+)"[^>]*>/i.exec(row);
        if (!hrefMatch) continue;
        const href = hrefMatch[1];
        const langLabel = text((/<span class="sub-lang">([\s\S]*?)<\/span>/i.exec(row) || [])[1] || '');
        const rating = Number((/<span class="label[^"]*">\s*(-?\d+)\s*<\/span>/i.exec(row) || [])[1]);
        const releases = [...all(/<br\s*\/?>([^<]+)/gi, row)].map(text).filter(Boolean);
        const mainRelease = text((/<\/span>([\s\S]*?)<\/a>/i.exec(row) || [])[1] || '');
        const slug = href.replace('/subtitles/', '');
        out.push({
            provider: 'yifysubtitles',
            id: slug,
            language: langLabel,
            langCode: langs.codeFor(langLabel),
            releaseName: mainRelease || releases[0] || null,
            releases,
            downloads: 0,
            rating: Number.isFinite(rating) ? rating : 0,
            extra: { slug, detailsUrl: `${SERVER}${href}`, downloadUrl: `${SERVER}/subtitle/${slug}.zip` }
        });
    }
    return out;
}

async function search(release, ctx = {}) {
    if (release.isSeries) return [];
    // The site's own title search is rendered client-side, so the movie-imdb
    // page is the only reliable door — and for that an id from the NFO (or the
    // free IMDb suggestion lookup the bazaar runs earlier) is required.
    if (!release.imdb) return [];
    const http = ctx.http || net;

    const pageUrl = `${SERVER}/movie-imdb/${release.imdb}`;
    let res;
    try {
        res = await http.httpGet(pageUrl, { timeoutMs: ctx.timeoutMs });
    } catch (e) {
        if (/HTTP 404/.test(e.message)) return [];
        throw e;
    }
    const candidates = parseMoviePage(res.buffer.toString('utf8'));

    return candidates
        .filter((c) => c.langCode !== 'und')
        .map((candidate) => {
            const wantedTitle = String(release.title || '').toLowerCase();
            const hay = `${candidate.releaseName || ''} ${(candidate.releases || []).join(' ')}`.toLowerCase();
            let boost = 0;
            if (wantedTitle && hay.includes(wantedTitle.split(' ')[0])) boost += 0.2;
            if (release.year && hay.includes(String(release.year))) boost += 0.2;
            return Object.assign(candidate, { scoreBoost: boost + Math.min(1, candidate.rating / 100) * 0.3 });
        });
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const res = await http.httpGet(candidate.extra.downloadUrl, {
        timeoutMs: ctx.timeoutMs,
        headers: {
            Referer: candidate.extra.detailsUrl,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
    });
    return { name: `${candidate.extra.slug}.zip`, data: res.buffer };
}

module.exports = {
    id: 'yifysubtitles',
    label: 'yifysubtitles',
    kind: 'network',
    requires: [],
    priority: 4,
    supports: { movies: true, series: false },
    available: () => ({ ok: true }),
    search,
    download,
    parseMoviePage
};
