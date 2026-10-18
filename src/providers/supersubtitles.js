const net = require('../net.js');
const langs = require('../langs.js');
const { text, blocks, all, titleMatch, yearConflict } = require('../scrape.js');

/**
 * SuperSubtitles — the feliratok.eu catalogue. Free and keyless; search is a
 * plain table and each row carries a direct download link whose file name
 * already says which language it is.
 *
 * The site labels languages in Hungarian ("Angol" = English, "Magyar" =
 * Hungarian, "Arab" = Arabic…), so the rows are translated here before the
 * bazaar ever sees them.
 */

const SERVER = 'https://feliratok.eu';

const HUNGARIAN_LANGUAGES = {
    'magyar': 'hu',
    'angol': 'en',
    'alban': 'sq',
    'albán': 'sq',
    'arab': 'ar',
    'bolgar': 'bg',
    'bolgár': 'bg',
    'braziliai portugal': 'pt-br',
    'brazíliai portugál': 'pt-br',
    'cseh': 'cs',
    'dan': 'da',
    'dán': 'da',
    'finn': 'fi',
    'flamand': 'nl',
    'francia': 'fr',
    'gorog': 'el',
    'görög': 'el',
    'heber': 'he',
    'héber': 'he',
    'holland': 'nl',
    'horvat': 'hr',
    'horvát': 'hr',
    'koreai': 'ko',
    'lengyel': 'pl',
    'nemet': 'de',
    'német': 'de',
    'norveg': 'no',
    'norvég': 'no',
    'olasz': 'it',
    'orosz': 'ru',
    'portugal': 'pt',
    'portugál': 'pt',
    'roman': 'ro',
    'román': 'ro',
    'spanyol': 'es',
    'sved': 'sv',
    'svéd': 'sv',
    'szerb': 'sr',
    'szloven': 'sl',
    'szlovén': 'sl',
    'szlovak': 'sk',
    'szlovák': 'sk',
    'torok': 'tr',
    'török': 'tr'
};

function hungarianCode(label) {
    const key = String(label || '').toLowerCase().trim();
    if (HUNGARIAN_LANGUAGES[key]) return HUNGARIAN_LANGUAGES[key];
    const code = langs.codeFor(label);
    return code;
}

function parseRows(html) {
    const rows = blocks(html, /<tr[^>]*id="vilagit"/g);
    const out = [];

    for (const row of rows) {
        const languageLabel = text((/<small>([\s\S]*?)<\/small>/i.exec(row) || [])[1] || '');
        const linkTag = (/<a[^>]*href="([^"]*action=letolt[^"]*)"[^>]*>/i.exec(row) || [])[1];
        if (!linkTag) continue;

        const release = text((/<div class="eredeti">([\s\S]*?)<\/div>/i.exec(row) || [])[1] || '');
        const hungarianTitle = text((/<div class="magyar">([\s\S]*?)<\/div>/i.exec(row) || [])[1] || '');
        const uploader = text((/<td align="center"[^>]*>\s*([^<]{2,60}?)\s*<\/td>\s*<td align="center"[^>]*>\s*\d{4}-\d{2}-\d{2}/i.exec(row) || [])[1] || '');
        const date = (/(\d{4}-\d{2}-\d{2})/.exec(row) || [])[1] || null;

        const url = new URL(linkTag.replace(/&amp;/g, '&'), SERVER);
        const fileName = url.searchParams.get('fnev') || '';
        const id = url.searchParams.get('felirat') || '';

        const extMatch = /(?:^|[.\-_])([a-z]{2,3})\.(?:srt|ass|ssa|vtt|sub|zip)$/i.exec(fileName);
        const fileCode = extMatch ? langs.codeFor(extMatch[1]) : 'und';
        const labelCode = hungarianCode(languageLabel);

        out.push({
            provider: 'supersubtitles',
            id,
            language: languageLabel || langs.nameFor(labelCode),
            langCode: labelCode !== 'und' ? labelCode : fileCode,
            title: hungarianTitle || release,
            releaseName: release || fileName,
            fileName,
            downloads: 0,
            uploader: uploader || null,
            date,
            extra: { url: url.toString(), fileName, id }
        });
    }
    return out;
}

async function search(release, ctx = {}) {
    const http = ctx.http || net;
    const query = (release.queries[0] || {}).title || release.title;
    if (!query) return [];

    const url = `${SERVER}/index.php?sorrend=ido&irany=desc&search=${encodeURIComponent(query)}&sid=1`;
    let res;
    try {
        res = await http.httpGet(url, { timeoutMs: ctx.timeoutMs });
    } catch (e) {
        if (/HTTP 404/.test(e.message)) return [];
        throw e;
    }
    const html = res.buffer.toString('utf8');

    const episodeTag = release.isSeries && release.season != null && release.episode != null
        ? `s${String(release.season).padStart(2, '0')}e${String(release.episode).padStart(2, '0')}`
        : null;

    return parseRows(html).filter((candidate) => {
        const haystack = `${candidate.title || ''} ${candidate.releaseName || ''}`;
        const compact = haystack.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (episodeTag && !compact.includes(episodeTag)) return false;
        if (!candidate.langCode || candidate.langCode === 'und') return false;
        if (!release.isSeries) {
            // the search is fuzzy: keep only rows that really talk about this film
            if (yearConflict(haystack, release)) return false;
            const similar = titleMatch(candidate.title || candidate.releaseName, release.title);
            if (similar < 0.45 && !(release.year && haystack.includes(String(release.year)))) return false;
        }
        return true;
    }).map((candidate) => Object.assign(candidate, {
        season: release.season,
        episode: release.episode,
        scoreBoost: titleMatch(candidate.title, release.title)
    }));
}

async function download(candidate, ctx = {}) {
    const http = ctx.http || net;
    const res = await http.httpGet(candidate.extra.url, {
        timeoutMs: ctx.timeoutMs,
        headers: { Referer: `${SERVER}/index.php?search=` }
    });
    return { name: candidate.extra.fileName || `feliratok-${candidate.id}.srt`, data: res.buffer };
}

module.exports = {
    id: 'supersubtitles',
    label: 'supersubtitles',
    kind: 'network',
    requires: [],
    priority: 5,
    supports: { movies: true, series: true },
    available: () => ({ ok: true }),
    search,
    download,
    parseRows,
    hungarianCode
};
