/**
 * Tiny HTML helpers for the scraping providers. Deliberately regex-based: the
 * engine has zero dependencies by design, and the pages we read are simple
 * tables, not applications.
 */

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
    agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
    auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü',
    aring: 'å', oslash: 'ø', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß',
    ocirc: 'ô', ecirc: 'ê', acirc: 'â', icirc: 'î', ucirc: 'û',
    uogon: 'ų', aogon: 'ą', eogon: 'ę', lslash: 'ł', zdot: 'ż', sacute: 'ś', cacute: 'ć', nacute: 'ń',
    hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·',
    oelig: 'œ', aelig: 'æ', idquo: '"', rdquo: '"', lsquo: '‘', rsquo: '’'
};

function decodeEntities(text) {
    return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, entity) => {
        if (entity[0] === '#') {
            const code = entity[1] === 'x' || entity[1] === 'X'
                ? Number.parseInt(entity.slice(2), 16)
                : Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : all;
        }
        const key = entity.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : all;
    });
}

/** HTML → plain text (tags removed, entities decoded, whitespace collapsed). */
function text(html) {
    return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

/** Read an attribute from a single tag string. */
function attr(tag, name) {
    const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(String(tag || ''));
    return m ? decodeEntities(m[1]) : null;
}

/** All capture groups of a regex over the html, e.g. all(/class="x"([^>]*)/g, html). */
function all(regex, html) {
    return [...String(html || '').matchAll(regex)].map((m) => m[1]);
}

/**
 * Split a page into row blocks by a marker regex, keeping each block as its own
 * string: `blocks(html, /<tr[^>]*data-id=/g)` → one string per row.
 */
function blocks(html, marker, hardCap = 500) {
    const source = String(html || '');
    const starts = [];
    const re = new RegExp(marker.source, marker.flags.includes('g') ? marker.flags : marker.flags + 'g');
    let m;
    while ((m = re.exec(source)) && starts.length < hardCap) {
        starts.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;
    }
    const out = [];
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : source.length;
        out.push(source.slice(starts[i], end));
    }
    return out;
}

/** Query string builder: skips null/undefined/empty values. */
function qs(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params || {})) {
        if (value === null || value === undefined || value === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.join('&');
}

/** Loose title match used to pick the right show/movie out of search results. */
function titleMatch(a, b) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
    const left = norm(a);
    const right = norm(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.8;
    const words = new Set(left.split(' '));
    const other = right.split(' ');
    let hits = 0;
    for (const word of other) if (words.has(word)) hits++;
    return hits / Math.max(other.length, 1);
}

/**
 * True when a row mentions years but never the release's own year — the
 * "The Matrix Resurrections (2021)" attached to a 1999 release case.
 */
function yearConflict(haystack, release) {
    const wanted = Number(release && release.year);
    if (!wanted) return false;
    const years = [...String(haystack || '').matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
    if (years.length === 0) return false;
    return !years.includes(wanted);
}

module.exports = { decodeEntities, text, attr, all, blocks, qs, titleMatch, yearConflict };
