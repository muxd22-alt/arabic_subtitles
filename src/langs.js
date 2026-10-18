/**
 * Language bookkeeping for the subtitle bazaar.
 *
 * Providers speak a dozen dialects of "English": gestdown says `english`,
 * feliratok says `Angol`, YIFY says `Brazillian Portuguese` (their spelling),
 * opensubtitles says `pt-BR`. This module turns all of that into one short
 * code, names files with it, and detects the language of a downloaded subtitle
 * from its own text when the metadata lies.
 */

const { arabicRatio } = require('./srt.js');

// [code, english name, aliases…]. Aliases are matched case-insensitively after
// punctuation is normalised ("Farsi/Persian", "pt-BR", "big 5 code").
const LANGUAGES = [
    ['ar', 'Arabic', 'arabic', 'ara', 'ar', 'العربية', 'arab', 'arabisch', 'arabe'],
    ['en', 'English', 'english', 'eng', 'en', 'anglais', 'ingles', '영어'],
    ['es', 'Spanish', 'spanish', 'spa', 'es', 'espanol', 'español', 'castellano', 'spanyol', 'espagnol'],
    ['fr', 'French', 'french', 'fre', 'fra', 'fr', 'francais', 'français', 'franzosisch', 'frances'],
    ['de', 'German', 'german', 'ger', 'deu', 'de', 'deutsch', 'aleman'],
    ['it', 'Italian', 'italian', 'ita', 'it', 'italiano'],
    ['pt', 'Portuguese', 'portuguese', 'por', 'pt', 'portugues', 'português'],
    ['pt-br', 'Brazilian Portuguese', 'brazilian portuguese', 'brazillian portuguese', 'brazil portuguese', 'pt-br', 'pob', 'portugues brasileiro'],
    ['nl', 'Dutch', 'dutch', 'nld', 'dut', 'nl', 'nederlands', 'flamand', 'flemish', 'holandes'],
    ['pl', 'Polish', 'polish', 'pol', 'pl', 'polski'],
    ['ru', 'Russian', 'russian', 'rus', 'ru', 'russkiy'],
    ['tr', 'Turkish', 'turkish', 'tur', 'tr', 'turkce', 'türkçe'],
    ['fa', 'Persian', 'persian', 'farsi', 'farsi/persian', 'fas', 'per', 'fa'],
    ['hi', 'Hindi', 'hindi', 'hin', 'hi'],
    ['ur', 'Urdu', 'urdu', 'urd', 'ur'],
    ['he', 'Hebrew', 'hebrew', 'heb', 'he', 'iw', 'עברית'],
    ['el', 'Greek', 'greek', 'gre', 'ell', 'el', 'ellinika'],
    ['zh', 'Chinese', 'chinese', 'chi', 'zho', 'zh', 'big 5 code', 'big5', 'chinese bg code', 'bg code', 'mandarin', 'cantonese', '中文'],
    ['ja', 'Japanese', 'japanese', 'jpn', 'ja', '日本語'],
    ['ko', 'Korean', 'korean', 'kor', 'ko', '한국어'],
    ['da', 'Danish', 'danish', 'dan', 'da', 'dansk'],
    ['sv', 'Swedish', 'swedish', 'swe', 'sv', 'svenska'],
    ['no', 'Norwegian', 'norwegian', 'nor', 'no', 'norsk', 'bokmal'],
    ['fi', 'Finnish', 'finnish', 'fin', 'fi', 'suomi'],
    ['cs', 'Czech', 'czech', 'cze', 'ces', 'cs', 'cesky'],
    ['sk', 'Slovak', 'slovak', 'slo', 'slk', 'sk', 'slovencina'],
    ['hu', 'Hungarian', 'hungarian', 'hun', 'hu', 'magyar'],
    ['ro', 'Romanian', 'romanian', 'rum', 'ron', 'ro', 'romana'],
    ['bg', 'Bulgarian', 'bulgarian', 'bul', 'bg'],
    ['hr', 'Croatian', 'croatian', 'hrv', 'hr', 'hrvatski'],
    ['sr', 'Serbian', 'serbian', 'srp', 'sr', 'srpski'],
    ['sl', 'Slovenian', 'slovenian', 'slv', 'sl', 'slovenscina'],
    ['uk', 'Ukrainian', 'ukrainian', 'ukr', 'uk'],
    ['sq', 'Albanian', 'albanian', 'sqi', 'alb', 'sq', 'shqip'],
    ['vi', 'Vietnamese', 'vietnamese', 'vie', 'vi', 'tieng viet'],
    ['th', 'Thai', 'thai', 'tha', 'th'],
    ['id', 'Indonesian', 'indonesian', 'ind', 'id', 'bahasa indonesia'],
    ['ms', 'Malay', 'malay', 'msa', 'may', 'ms', 'bahasa melayu'],
    ['bn', 'Bengali', 'bengali', 'ben', 'bn', 'bangla'],
    ['ta', 'Tamil', 'tamil', 'tam', 'ta'],
    ['te', 'Telugu', 'telugu', 'tel', 'te'],
    ['ml', 'Malayalam', 'malayalam', 'mal', 'ml'],
    ['kn', 'Kannada', 'kannada', 'kan', 'kn'],
    ['mr', 'Marathi', 'marathi', 'mar', 'mr'],
    ['gu', 'Gujarati', 'gujarati', 'guj', 'gu'],
    ['pa', 'Punjabi', 'punjabi', 'pan', 'pa'],
    ['ne', 'Nepali', 'nepali', 'nep', 'ne'],
    ['si', 'Sinhala', 'sinhala', 'sin', 'si', 'sinhalese'],
    ['km', 'Khmer', 'khmer', 'khm', 'km'],
    ['my', 'Burmese', 'burmese', 'mya', 'bur', 'my'],
    ['ka', 'Georgian', 'georgian', 'kat', 'geo', 'ka'],
    ['hy', 'Armenian', 'armenian', 'hye', 'arm', 'hy'],
    ['az', 'Azerbaijani', 'azerbaijani', 'aze', 'az'],
    ['kk', 'Kazakh', 'kazakh', 'kaz', 'kk'],
    ['uz', 'Uzbek', 'uzbek', 'uzb', 'uz'],
    ['ku', 'Kurdish', 'kurdish', 'kur', 'ku'],
    ['ps', 'Pashto', 'pashto', 'pus', 'ps'],
    ['sw', 'Swahili', 'swahili', 'swa', 'sw', 'kiswahili'],
    ['am', 'Amharic', 'amharic', 'amh', 'am'],
    ['so', 'Somali', 'somali', 'som', 'so'],
    ['tl', 'Tagalog', 'tagalog', 'fil', 'phi', 'filipino', 'tl'],
    ['af', 'Afrikaans', 'afrikaans', 'afr', 'af'],
    ['lt', 'Lithuanian', 'lithuanian', 'lit', 'lt'],
    ['lv', 'Latvian', 'latvian', 'lav', 'lv'],
    ['et', 'Estonian', 'estonian', 'est', 'et'],
    ['is', 'Icelandic', 'icelandic', 'ice', 'isl', 'is'],
    ['mk', 'Macedonian', 'macedonian', 'mac', 'mkd', 'mk'],
    ['bs', 'Bosnian', 'bosnian', 'bos', 'bs'],
    ['mt', 'Maltese', 'maltese', 'mlt', 'mt'],
    ['la', 'Latin', 'latin', 'lat', 'la'],
    ['und', 'Unknown', 'unknown', 'und', 'undefined']
];

const BY_ALIAS = new Map();
const BY_CODE = new Map();
for (const [code, name, ...aliases] of LANGUAGES) {
    const entry = { code, name, aliases };
    BY_CODE.set(code, entry);
    for (const alias of aliases) BY_ALIAS.set(normalizeToken(alias), entry);
    BY_ALIAS.set(normalizeToken(name), entry);
}

function normalizeToken(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\u2010-\u2015/]/g, ' ')
        .replace(/[_.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Turn any provider spelling into a language code. `pt-BR`, `Brazilian
 * Portuguese`, `Angol`(hun labels are translated before this) and `eng` all
 * resolve; anything unknown becomes `und`.
 */
function codeFor(raw) {
    if (!raw) return 'und';
    const token = normalizeToken(raw);
    if (BY_ALIAS.has(token)) return BY_ALIAS.get(token).code;
    // "en-US" style tags and provider suffixes like "english (cc)"
    const short = token.split(/[\s(]/)[0];
    if (BY_ALIAS.has(short)) return BY_ALIAS.get(short).code;
    const stripped = short.replace(/-.*$/, '');
    if (BY_ALIAS.has(stripped)) return BY_ALIAS.get(stripped).code;
    return 'und';
}

function nameFor(code) {
    const entry = BY_CODE.get(String(code || '').toLowerCase());
    return entry ? entry.name : 'Unknown';
}

function isKnown(code) {
    return BY_CODE.has(String(code || '').toLowerCase());
}

/** The two-letter tag used in sidecar file names: Movie.<ar|en|es>.srt */
function fileTag(code) {
    const c = String(code || 'und').toLowerCase();
    return isKnown(c) ? c : 'und';
}

/** Scripts a subtitle can be written in — enough for a first, cheap guess. */
const SCRIPTS = [
    ['arabic', /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g],
    ['hebrew', /[\u0590-\u05ff]/g],
    ['cyrillic', /[\u0400-\u04ff]/g],
    ['greek', /[\u0370-\u03ff\u1f00-\u1fff]/g],
    ['korean', /[\uac00-\ud7af]/g],
    ['japanese', /[\u3040-\u30ff]/g],
    ['cjk', /[\u4e00-\u9fff]/g],
    ['thai', /[\u0e00-\u0e7f]/g],
    ['devanagari', /[\u0900-\u097f]/g],
    ['latin', /[A-Za-z\u00c0-\u024f]/g]
];

const SCRIPT_LANGUAGE = {
    arabic: 'ar',
    hebrew: 'he',
    greek: 'el',
    korean: 'ko',
    japanese: 'ja',
    cjk: 'zh',
    thai: 'th',
    devanagari: 'hi'
};

// Small stop-word sets: cheap, offline and plenty to separate the handful of
// Latin languages that actually show up in the bazaar.
const STOPWORDS = {
    en: ['the', 'you', 'and', 'that', 'what', 'is', 'it', 'to', 'of', 'i'],
    es: ['que', 'de', 'no', 'la', 'el', 'es', 'y', 'en', 'los', 'se', 'por'],
    fr: ['que', 'je', 'tu', 'pas', 'les', 'des', 'est', 'vous', 'pour', 'dans'],
    de: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'ich', 'sie', 'was', 'wir'],
    it: ['che', 'non', 'di', 'per', 'una', 'sono', 'gli', 'con', 'questo'],
    pt: ['que', 'nao', 'não', 'uma', 'para', 'com', 'voce', 'você', 'os', 'do'],
    nl: ['het', 'een', 'niet', 'van', 'dat', 'zijn', 'maar', 'voor', 'met'],
    pl: ['nie', 'sie', 'jest', 'jak', 'ale', 'tak', 'co', 'to', 'na', 'do'],
    tr: ['bir', 'bu', 'ne', 'ben', 'sen', 'ama', 'icin', 'için', 'var', 'yok'],
    id: ['yang', 'dan', 'ini', 'itu', 'tidak', 'dengan', 'untuk', 'aku'],
    vi: ['khong', 'không', 'cua', 'của', 'toi', 'tôi', 'ban', 'bạn', 'la', 'là'],
    ro: ['nu', 'este', 'sunt', 'care', 'pentru', 'astă', 'asta', 'dar'],
    sv: ['jag', 'inte', 'det', 'och', 'att', 'är', 'som', 'for', 'med'],
    da: ['jeg', 'ikke', 'det', 'og', 'at', 'er', 'som', 'for', 'med'],
    fi: ['minä', 'en', 'ei', 'se', 'ja', 'on', 'että', 'kun', 'niin'],
    cs: ['já', 'není', 'to', 'se', 'na', 'je', 'ale', 'jako', 'pro']
};

function scriptOf(text) {
    const sample = String(text || '').slice(0, 200000);
    let best = null;
    for (const [script, re] of SCRIPTS) {
        const matches = sample.match(re);
        const count = matches ? matches.length : 0;
        if (count > 0 && (!best || count > best.count)) best = { script, count };
    }
    return best ? best.script : null;
}

/**
 * Best-effort language of a subtitle's text: the script is decisive when it is
 * non-Latin, and Latin text falls back to stop-word voting and then to the
 * caller's hint (what the provider claimed).
 */
function detect(text, hint = 'und') {
    const script = scriptOf(text);
    if (script && SCRIPT_LANGUAGE[script]) return SCRIPT_LANGUAGE[script];

    if (script === 'latin' || script === 'cyrillic') {
        const words = String(text || '')
            .toLowerCase()
            .split(/[^a-z\u00c0-\u04ff']+/)
            .filter(Boolean);
        const counts = new Map();
        for (const [code, list] of Object.entries(STOPWORDS)) {
            let hits = 0;
            for (const stop of list) if (words.includes(stop)) hits++;
            if (hits > 0) counts.set(code, hits);
        }
        if (counts.size > 0) {
            const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            // Two hits make a language; one hit is also trusted when nothing
            // else scored at all (short samples, single-word subtitles).
            if (best[1] >= 2 || counts.size === 1) return best[0];
        }
        if (script === 'cyrillic') return hint === 'und' ? 'ru' : hint;
    }
    return hint || 'und';
}

/** True when enough of the text is Arabic that branding beats translating. */
function looksArabic(text) {
    return arabicRatio(text) >= 0.3;
}

/**
 * Ranking a candidate for "which subtitle do I actually want?":
 *   0  Arabic — brand it, no model needed at all
 *   1  a language we already prefer as a translation source (English first)
 *   2  anything else that is text
 *   -1  image-based or unknown
 */
function preferenceScore(langCode, options = {}) {
    const prefer = (options.prefer || ['ar']).map((l) => String(l).toLowerCase());
    const accept = (options.accept || ['en', 'es', 'fr']).map((l) => String(l).toLowerCase());
    const code = String(langCode || 'und').toLowerCase();
    if (prefer[0] === code) return 0;
    if (prefer.includes(code)) return 1;
    const acceptIdx = accept.indexOf(code);
    if (acceptIdx >= 0) return 2 + acceptIdx * 0.1;
    if (code === 'und') return 9;
    return 5;
}

module.exports = {
    LANGUAGES,
    codeFor,
    nameFor,
    isKnown,
    fileTag,
    scriptOf,
    detect,
    looksArabic,
    preferenceScore,
    normalizeToken
};
