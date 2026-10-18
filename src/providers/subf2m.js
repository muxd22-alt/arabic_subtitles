const net = require('../net.js');
const langs = require('../langs.js');
const { text, blocks, all, titleMatch } = require('../scrape.js');

/**
 * Subf2m — a large keyless mirror (opensubtitles + community uploads) with a
 * plain server-rendered catalogue. One page lists every language for a title,
 * one page lists that language's versions, and the details page finally hands
 * over the file. It is the deepest free source for Arabic movies after
 * OpenSubtitles itself.
 */

const SERVER = process.env.SUBF2M_URL || 'https://subf2m.co';

// Their URL slugs for the language pages.
const PAGE_NAMES = {
    ar: 'arabic', en: 'english', es: 'spanish', fr: 'french', de: 'german', it: 'italian',
    pt: 'portuguese', 'pt-br': 'brazillian-portuguese', nl: 'dutch', pl: 'polish', ru: 'russian',
    tr: 'turkish', fa: 'farsi_persian', he: 'hebrew', el: 'greek', zh: 'chinese', ja: 'japanese',
    ko: 'korean', sv: 'swedish', no: 'norwegian', da: 'danish', fi: 'finnish', cs: 'czech',
    hu: 'hungarian', ro: 'romanian', bg: 'bulgarian', hr: 'croatian', sr: 'serbian',
    sl: 'slovenian', uk: 'ukrainian', vi: 'vietnamese', id: 'indonesian', th: 'thai',
    bn: 'bengali', hi: 'hindi', ur: 'urdu', ta: 'tamil', te: 'telugu', ml: 'malayalam',
    sq: 'albanian', af: 'afrikaans', sq_2: 'albanian'
};

function slugify(title) {
    return String(title || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Language tabs on the title page: /subtitles/<slug>/<page> + a count. */
function parseLanguageTabs(html, slug) {
    const tabs = [];
    const re = new RegExp(`href=['"]?\\/subtitles\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/([a-z0-9_-]+)['"]?[^>]*>([\\s\\S]{0,200}?)<\\/a>`, 'gi');
    let m;
    while ((m = re.exec(html))) {
        const page = m[1];
        const label = text(m[2]).replace(/\d+$/, '').trim();
        const count = Number((/(\d+)\s*$/.exec(text(m[2])) || [])[1]) || 0;
        tabs.push({ page, label, count, code: langs.codeFor(label || page.replace(/_/g, ' ')) });
    }
    return tabs;
}

function parseLanguagePage(html, slug, page) {
    const out = [];
    for (const item of blocks(html, /<li[^>]*class=['"]item/gi)) {
        const href = (/href='(\/subtitles\/[^']+\/\d+)'/.exec(item) || [])[1] || (/href="(\/subtitles\/[^"]+\/\d+)"/.exec(item) || [])[1];
        if (!href) continue;
        const langLabel = text((/<span class='language[^']*'>([\s\S]*?)<\/span>/i.exec(item) || [])[1] || '');
        const releases = all(/<li[^>]*>([^<]{2,200})<\/li>/gi, item).map(text).filter(Boolean);
        const rateClass = (/class='rate([^']*)'/i.exec(item) || [])[1] || '';
        const id = href.split('/').pop();
        out.push({
            provider: 'subf2m',
            id,
            language: langLabel || page,
            langCode: langs.codeFor(langLabel || page.replace(/_/g, ' ')),
            releaseName: releases[0] || null,
            releases,
            downloads: 0,
            rating: /good/.test(rateClass) ? 1 : (/bad/.test(rateClass) ? -1 : 0),
            extra: { detailsUrl: `${SERVER}${href}`, slug, page }
        });
    }
    return out;
}

async function search(release, ctx = {}) {
    const http = ctx.http || net;
    const query = (release.queries[0] || {}).title || release.title;
    if (!query) return [];

    const slug = slugify(query);
    if (!slug) return [];

    // Titles live under a plain slug; a year suffix exists for remakes.
    const variants = [slug];
    if (release.year) variants.push(`${slug}-${release.year}`);

    let titleHtml = null;
    let usedSlug = slug;
    for (const variant of variants) {
        try {
            const res = await http.httpGet(`${SERVER}/subtitles/${variant}`, { timeoutMs: ctx.timeoutMs });
            titleHtml = res.buffer.toString('utf8');
            usedSlug = variant;
            break;
        } catch (e) {
            if (!/HTTP 404/.test(e.message)) throw e;
        }
    }
    if (!titleHtml) return [];

    const tabs = parseLanguageTabs(titleHtml, usedSlug);
    if (tabs.length === 0) return [];

    // Pick the best language tabs to visit: Arabic first (brand it), then the
    // source languages we translate from, then whatever is most plentiful.
    const wantedPages = [];
    for (const code of ctx.sourceLanguages || ['ar', 'en']) {
        const pageName = PAGE_NAMES[String(code).toLowerCase()] || String(code).toLowerCase();
        const tab = tabs.find((t) => t.page === pageName || t.code === code);
        if (tab && !wantedPages.includes(tab.page)) wantedPages.push(tab.page);
    }
    if (wantedPages.length === 0) {
        const best = tabs.slice().sort((a, b) => b.count - a.count)[0];
        if (best) wantedPages.push(best.page);
    }

    const episodeTag = release.isSeries && release.season != null && release.episode != null
        ? `s${String(release.season).padStart(2, '0')}e${String(release.episode).padStart(2, '0')}`
        : null;

    const pages = await Promise.all(wantedPages.slice(0, 3).map(async (page) => {
        try {
            const res = await http.httpGet(`${SERVER}/subtitles/${usedSlug}/${page}`, { timeoutMs: ctx.timeoutMs });
            return parseLanguagePage(res.buffer.toString('utf8'), usedSlug, page);
        } catch (e) {
            if (/HTTP 404/.test(e.message)) return [];
            throw e;
        }
    }));

    return pages.flat()
        .filter((c) => c.langCode !== 'und')
        .filter((c) => {
            if (!episodeTag) return true;
            const hay = `${c.releaseName || ''} ${(c.releases || []).join(' ')}`.toLowerCase().replace(/[^a-z0-9]/g, '');
            return hay.includes(episodeTag);
        })
        .map((c) => Object.assign(c, {
            season: release.season,
            episode: release.episode,
            scoreBoost: Math.max(0, c.rating) * 0.3
        }));
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const details = await http.httpGet(candidate.extra.detailsUrl, { timeoutMs: ctx.timeoutMs });
    const html = details.buffer.toString('utf8');
    const link = (/(<a[^>]*href=['"]([^'"]*\/download)['"][^>]*>)/i.exec(html) || [])[2];
    if (!link) throw new Error('subf2m details page carried no download link');
    const url = new URL(link, SERVER).toString();
    const res = await http.httpGet(url, {
        timeoutMs: ctx.timeoutMs,
        headers: { Referer: candidate.extra.detailsUrl }
    });
    return { name: `subf2m-${candidate.id}.zip`, data: res.buffer };
}

module.exports = {
    id: 'subf2m',
    label: 'subf2m',
    kind: 'network',
    requires: [],
    priority: 3,
    supports: { movies: true, series: true },
    available: () => ({ ok: true }),
    search,
    download,
    parseLanguageTabs,
    parseLanguagePage,
    slugify
};
