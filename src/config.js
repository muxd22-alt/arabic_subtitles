const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file = path.join(ROOT, '.env')) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return {};
    }
    const loaded = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
            (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
            value = value.slice(1, -1);
        }
        loaded[key] = value;
        if (process.env[key] === undefined) process.env[key] = value;
    }
    return loaded;
}

loadDotEnv();

function readVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    } catch (e) {
        return '0.0.0';
    }
}

function intEnv(name, fallback) {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const VERSION = readVersion();

const HOME = process.env.ARABIC_SUBS_HOME || path.join(os.homedir(), '.arabic-subs');
const MODELS_DIR = process.env.ARABIC_SUBS_MODELS || path.join(HOME, 'models');
const TMP_DIR = path.join(HOME, 'tmp');

// Model flavours. The default is a standard, ordinary quant (Q4_K_M) from
// Tencent's own GGUF repo, which any recent llama.cpp reads — so the engine no
// longer needs a pinned fork commit.
//
// The extreme-bit files (STQ1_0 1.25-bit "Sherry", or 2-bit "Stride16") are
// gated behind unmerged llama.cpp PRs — #22836 and draft #19357 — and abort at
// load with "tensor 'blk.0.attn_k_norm.weight' has offset …, expected …".
// They stay available as an opt-in alternative via HYMT_MODEL_FLAVOR=stq (the
// small 440 MB file needs the STQ1_0 fork engine).
//
// Every entry pins the exact byte count, so a partial/corrupt download is
// caught before llama-server is ever handed the file.
const MODEL_FLAVORS = {
    q4_k_m: {
        label: 'Hy-MT2 1.8B Q4_K_M',
        file: 'Hy-MT2-1.8B-Q4_K_M.gguf',
        url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf',
        bytes: 1133080448,
        repo: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF',
        card: 'https://huggingface.co/tencent/Hy-MT2-1.8B',
        engine: 'stock'
    },
    q6_k: {
        label: 'Hy-MT2 1.8B Q6_K',
        file: 'Hy-MT2-1.8B-Q6_K.gguf',
        url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q6_K.gguf',
        bytes: 1474785120,
        repo: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF',
        card: 'https://huggingface.co/tencent/Hy-MT2-1.8B',
        engine: 'stock'
    },
    q8_0: {
        label: 'Hy-MT2 1.8B Q8_0',
        file: 'Hy-MT2-1.8B-Q8_0.gguf',
        url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q8_0.gguf',
        bytes: 1908528192,
        repo: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF',
        card: 'https://huggingface.co/tencent/Hy-MT2-1.8B',
        engine: 'stock'
    },
    stq: {
        label: 'Hy-MT1.5 1.8B 1.25-bit (STQ1_0)',
        file: 'Hy-MT1.5-1.8B-1.25bit.gguf',
        url: 'https://huggingface.co/tencent/Hy-MT1.5-1.8B-1.25bit-GGUF/resolve/main/Hy-MT1.5-1.8B-1.25bit.gguf',
        bytes: 461860704,
        repo: 'https://huggingface.co/tencent/Hy-MT1.5-1.8B-1.25bit-GGUF',
        card: 'https://huggingface.co/tencent/Hy-MT1.5-1.8B',
        engine: 'stq'
    }
};

const DEFAULT_FLAVOR = 'q4_k_m';
const MODEL_FLAVOR = (process.env.HYMT_MODEL_FLAVOR || DEFAULT_FLAVOR).toLowerCase();
const _flavor = MODEL_FLAVORS[MODEL_FLAVOR] || MODEL_FLAVORS[DEFAULT_FLAVOR];

const MODEL_FILE = process.env.HYMT2_MODEL_FILE || _flavor.file;
const MODEL_URL = process.env.HYMT2_MODEL_URL || _flavor.url;
const MODEL_BYTES = Number(process.env.HYMT2_MODEL_BYTES || _flavor.bytes);
const MODEL_PATH = process.env.HYMT2_MODEL || path.join(MODELS_DIR, MODEL_FILE);
const MODEL_LABEL = _flavor.label;
const MODEL_ENGINE = _flavor.engine;
const MODEL_CARD = _flavor.card;
const MODEL_REPO = _flavor.repo;

/**
 * Resolve a flavour to a concrete model. With no argument it returns the active
 * flavour (honouring the HYMT2_MODEL* overrides); any known name returns that
 * preset's own file/url/bytes/path.
 */
function resolveModel(flavor) {
    const name = (flavor || MODEL_FLAVOR).toLowerCase();
    if (name === MODEL_FLAVOR || !MODEL_FLAVORS[name]) {
        return {
            flavor: MODEL_FLAVOR,
            label: MODEL_LABEL,
            file: MODEL_FILE,
            url: MODEL_URL,
            bytes: MODEL_BYTES,
            path: MODEL_PATH,
            engine: MODEL_ENGINE,
            repo: MODEL_REPO,
            card: MODEL_CARD
        };
    }
    const spec = MODEL_FLAVORS[name];
    return { flavor: name, ...spec, path: path.join(MODELS_DIR, spec.file) };
}

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_FILE = `ggml-${WHISPER_MODEL}.bin`;
const WHISPER_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_FILE}`;
const WHISPER_PATH = path.join(MODELS_DIR, WHISPER_FILE);

const TARGET_LANG = process.env.TARGET_LANG || 'Arabic';
const SOURCE_LANG = process.env.SOURCE_LANG || 'English';

const LLAMA_PORT = intEnv('LLAMA_PORT', 18434);
const STATUS_PORT = intEnv('STATUS_PORT', 18435);
const LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || '';

const CONCURRENCY = intEnv('TRANSLATE_CONCURRENCY', 4);
// How many videos the engine works on at once. The on-device engine (llama and
// whisper) is CPU-bound, so 2 overlaps the next video's transcription with the
// current one's translation without cooking the phone. Set 1 for the old
// strictly-sequential behaviour; raise it on a fast device.
const JOB_CONCURRENCY = intEnv('JOB_CONCURRENCY', 2);
// llama-server slots: every concurrent video issues up to `CONCURRENCY`
// requests at once, so the server needs that many slots to serve them truly in
// parallel instead of queueing them behind each other.
const LLAMA_PARALLEL = intEnv('LLAMA_PARALLEL', CONCURRENCY * JOB_CONCURRENCY);
const BATCH_LINES = intEnv('TRANSLATE_BATCH_LINES', 16);
const BATCH_CHARS = intEnv('TRANSLATE_BATCH_CHARS', 800);
const N_PREDICT = intEnv('TRANSLATE_MAX_TOKENS', 1024);

const CHUNK_MS = intEnv('AUDIO_CHUNK_MINUTES', 5) * 60 * 1000;
const CHUNK_OVERLAP_MS = 1000;
const AUDIO_CONCURRENCY = intEnv('AUDIO_CONCURRENCY', 2);

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.webm', '.ts', '.m2ts'];

const OUTPUT_SUFFIX = '.ArabicSubs.ar.ass';
const BRANDED_NAME_MARKER = 'ArabicSubs';

function ensureDirs() {
    for (const dir of [HOME, MODELS_DIR, TMP_DIR, path.dirname(getDecisionLogPath())]) {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) { }
    }
}

function getDecisionLogPath() {
    return process.env.ARABIC_SUBS_LOG || path.join(ROOT, 'logs', 'decisions.jsonl');
}

function isVideoFile(filePath) {
    return VIDEO_EXTS.includes(path.extname(filePath).toLowerCase());
}

module.exports = {
    ROOT,
    VERSION,
    USER_AGENT: `ArabicSubs v${VERSION}`,
    HOME,
    MODELS_DIR,
    TMP_DIR,
    MODEL_FLAVORS,
    MODEL_FLAVOR,
    DEFAULT_FLAVOR,
    MODEL_LABEL,
    MODEL_ENGINE,
    MODEL_CARD,
    MODEL_REPO,
    MODEL_FILE,
    MODEL_URL,
    MODEL_BYTES,
    MODEL_PATH,
    WHISPER_MODEL,
    WHISPER_URL,
    WHISPER_PATH,
    TARGET_LANG,
    SOURCE_LANG,
    LLAMA_PORT,
    STATUS_PORT,
    LLAMA_BASE_URL,
    CONCURRENCY,
    JOB_CONCURRENCY,
    LLAMA_PARALLEL,
    BATCH_LINES,
    BATCH_CHARS,
    N_PREDICT,
    CHUNK_MS,
    CHUNK_OVERLAP_MS,
    AUDIO_CONCURRENCY,
    VIDEO_EXTS,
    OUTPUT_SUFFIX,
    BRANDED_NAME_MARKER,
    loadDotEnv,
    ensureDirs,
    getDecisionLogPath,
    isVideoFile,
    resolveModel
};
