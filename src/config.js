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

const MODEL_FILE = 'Hy-MT2-1.8B-1.25Bit.gguf';
const MODEL_URL = `https://huggingface.co/tencent/Hy-MT2-1.8B-1.25bit-GGUF/resolve/main/${MODEL_FILE}`;
const MODEL_BYTES = 461860800;
const MODEL_PATH = process.env.HYMT2_MODEL || path.join(MODELS_DIR, MODEL_FILE);

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
const BATCH_LINES = intEnv('TRANSLATE_BATCH_LINES', 16);
const BATCH_CHARS = intEnv('TRANSLATE_BATCH_CHARS', 800);
const N_PREDICT = intEnv('TRANSLATE_MAX_TOKENS', 1024);

const CHUNK_MS = intEnv('AUDIO_CHUNK_MINUTES', 5) * 60 * 1000;
const CHUNK_OVERLAP_MS = 1000;
const AUDIO_CONCURRENCY = intEnv('AUDIO_CONCURRENCY', 2);

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.webm', '.ts', '.m2ts'];

const OUTPUT_SUFFIX = '.ArabicSubs.ar.srt';
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
    isVideoFile
};
