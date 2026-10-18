const fs = require('fs');
const path = require('path');
const config = require('./config.js');

/**
 * Provider health, kept exactly the way a bazaar keeps its stalls: a provider
 * that answers is trusted, a provider that throws is put on a cooldown that
 * doubles with every consecutive failure (1, 2, 4, 8 … up to an hour) so one
 * dead site cannot slow down every film in the library. The table lives in
 * `<home>/providers.json` and is printed by `arabic-subs providers`.
 */

const STATUS_GOOD = 'good';
const STATUS_ERROR = 'error';
const STATUS_MISSING = 'missing-config';
const STATUS_DISABLED = 'disabled';

const MAX_FILES = 200;
const BASE_DELAY_MS = 60 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;

let cache = null;

function storePath() {
    return process.env.PROVIDERS_STATE || path.join(config.HOME, 'providers.json');
}

function load(force = false) {
    if (cache && !force) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        cache = raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
        cache = {};
    }
    return cache;
}

function save() {
    const file = storePath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) {
        // health is a convenience — never fail a run because it could not be written
    }
}

function entryFor(id) {
    const state = load();
    if (!state[id]) {
        state[id] = { status: STATUS_GOOD, fails: 0, lastError: null, lastSuccess: null, nextRetryAt: null };
    }
    return state[id];
}

function backoffMs(fails) {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.max(0, fails - 1)));
}

function markSuccess(id, note = null) {
    const entry = entryFor(id);
    entry.status = STATUS_GOOD;
    entry.fails = 0;
    entry.lastError = null;
    entry.nextRetryAt = null;
    entry.lastSuccess = new Date().toISOString();
    if (note) entry.note = note;
    save();
}

function markFailure(id, error) {
    const entry = entryFor(id);
    entry.fails = (entry.fails || 0) + 1;
    entry.status = STATUS_ERROR;
    entry.lastError = String(error && error.message ? error.message : error || 'unknown error').slice(0, 300);
    entry.lastFailure = new Date().toISOString();
    entry.nextRetryAt = new Date(Date.now() + backoffMs(entry.fails)).toISOString();
    save();
}

/** A provider that cannot run at all here: no key configured, or switched off. */
function markUnavailable(id, reason, status = STATUS_MISSING) {
    const entry = entryFor(id);
    entry.status = status;
    entry.fails = 0;
    entry.nextRetryAt = null;
    entry.lastError = reason ? String(reason).slice(0, 300) : null;
    save();
}

function reset(id = null) {
    const state = load(true);
    if (id) delete state[id];
    else for (const key of Object.keys(state)) delete state[key];
    save();
}

/** { cooling: bool, msLeft } — providers in cooldown are skipped, not failed. */
function cooldown(id, now = Date.now()) {
    const entry = entryFor(id);
    if (!entry.nextRetryAt || entry.status !== STATUS_ERROR) return { cooling: false, msLeft: 0 };
    const left = Date.parse(entry.nextRetryAt) - now;
    return { cooling: left > 0, msLeft: Math.max(0, left) };
}

function statusLabel(entry) {
    if (!entry) return 'Good';
    switch (entry.status) {
        case STATUS_ERROR: return 'ConnectionError';
        case STATUS_MISSING: return 'Not configured';
        case STATUS_DISABLED: return 'Disabled';
        default: return 'Good';
    }
}

function formatDelay(ms) {
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 1) return 'in under a minute';
    if (minutes === 1) return 'in 1 minute';
    if (minutes < 60) return `in ${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
}

function retryText(id, now = Date.now()) {
    const entry = entryFor(id);
    if (!entry || entry.status !== STATUS_ERROR || !entry.nextRetryAt) return '-';
    const left = Date.parse(entry.nextRetryAt) - now;
    if (left <= 0) return 'now';
    return formatDelay(left);
}

/** Rows for the `providers` command, in registry order. */
function snapshot(ids, now = Date.now()) {
    return ids.map(({ id, label }) => {
        const entry = entryFor(id);
        return {
            name: label || id,
            status: statusLabel(entry),
            nextRetry: retryText(id, now),
            fails: entry.fails || 0,
            lastError: entry.lastError || null,
            lastSuccess: entry.lastSuccess || null
        };
    });
}

/** Keep the file from growing forever with ids of providers that were removed. */
function prune(knownIds) {
    const state = load(true);
    const keep = new Set(knownIds);
    let changed = false;
    for (const id of Object.keys(state)) {
        if (!keep.has(id)) { delete state[id]; changed = true; }
    }
    if (changed) save();
    if (Object.keys(state).length > MAX_FILES) {
        cache = {};
        save();
    }
}

module.exports = {
    STATUS_GOOD,
    STATUS_ERROR,
    STATUS_MISSING,
    STATUS_DISABLED,
    storePath,
    load,
    markSuccess,
    markFailure,
    markUnavailable,
    reset,
    cooldown,
    backoffMs,
    statusLabel,
    retryText,
    formatDelay,
    snapshot,
    prune
};
