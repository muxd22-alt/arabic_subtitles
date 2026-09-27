const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Minimal .env loader — keeps the project dependency-free on Termux.
// Real process environment always wins over the file.
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
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
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

const VERSION = readVersion();

function getOpenSubtitlesConfig() {
    return {
        apiKey: process.env.OPENSUBTITLES_API_KEY || '',
        username: process.env.OPENSUBTITLES_USERNAME || '',
        password: process.env.OPENSUBTITLES_PASSWORD || ''
    };
}

function getTmdbConfig() {
    return {
        apiKey: process.env.TMDB_API_KEY || ''
    };
}

function getDecisionLogPath() {
    return process.env.SUBARABIFY_DECISION_LOG || path.join(ROOT, 'logs', 'decisions.jsonl');
}

// Remote subtitle search only runs when a free OpenSubtitles.com consumer key exists.
function isRemoteSearchEnabled() {
    return Boolean(getOpenSubtitlesConfig().apiKey);
}

module.exports = {
    ROOT,
    VERSION,
    USER_AGENT: `SubArabify v${VERSION}`,
    loadDotEnv,
    getOpenSubtitlesConfig,
    getTmdbConfig,
    getDecisionLogPath,
    isRemoteSearchEnabled
};
