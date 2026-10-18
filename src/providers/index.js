const path = require('path');
const fs = require('fs');
const config = require('../config.js');
const net = require('../net.js');
const langs = require('../langs.js');
const health = require('../provider-health.js');
const { extractSubtitles, pickSubtitle } = require('../archives.js');
const { parseSRT, parseASS, parseVTT, validateSRT, looksArabic, serializeSRT, normalizeToUtf8 } = require('../srt.js');
const { titleMatch } = require('../scrape.js');
const imdbLookup = require('../imdb.js');
const { checkFit, describeFit } = require('./fit.js');

const embedded = require('./embedded.js');
const gestdown = require('./gestdown.js');
const subf2m = require('./subf2m.js');
const yifysubtitles = require('./yifysubtitles.js');
const supersubtitles = require('./supersubtitles.js');
const podnapisi = require('./podnapisi.js');
const subdl = require('./subdl.js');
const opensubtitlescom = require('./opensubtitlescom.js');

/**
 * The bazaar: every free stall in one market place.
 *
 * Search runs across all reachable providers at once, candidates are ranked
 * (Arabic first — brand it; then a source language we translate from), and only
 * then is anything downloaded: one file at a time, best candidate first, until
 * something parses as a real subtitle. Providers that throw sit out a growing
 * cooldown, which is why one dead website never slows the whole library down.
 *
 * Order is "fastest to hardest": embedded tracks, then keyless web APIs (JSON
 * before HTML), then key-based APIs. Anything a provider hands back is saved
 * next to the video with the same name the local scan looks for, so a later run
 * finds it offline.
 */

const REGISTRY = [
    embedded,
    gestdown,
    subf2m,
    yifysubtitles,
    supersubtitles,
    podnapisi,
    subdl,
    opensubtitlescom
];

const PROVIDER_TIMEOUT_MS = Number.parseInt(process.env.PROVIDER_TIMEOUT_MS || '15000', 10);

function sourceLanguages(options = {}) {
    if (options.sourceLanguages) return options.sourceLanguages;
    const raw = process.env.PROVIDER_LANGUAGES || 'ar,en,es';
    return raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
}

function providers() {
    return REGISTRY;
}

function providerById(id) {
    return REGISTRY.find((p) => p.id === id) || null;
}

/**
 * Availability of every stall, health included. `available()` reads env vars
 * (API keys), so this is also what the `providers` command prints.
 */
function availability() {
    return REGISTRY.map((provider) => {
        let availabilityResult = { ok: true };
        try {
            availabilityResult = provider.available({}) || { ok: true };
        } catch (e) {
            availabilityResult = { ok: false, reason: e.message };
        }
        const cooling = health.cooldown(provider.id);
        return {
            provider,
            ok: availabilityResult.ok,
            reason: availabilityResult.reason || null,
            cooling: cooling.cooling,
            cooldownMs: cooling.msLeft
        };
    });
}

/** Human table: Name | Status | Next Retry — the shape Bazarr users know. */
function statusRows() {
    const rows = health.snapshot(REGISTRY.map((p) => ({ id: p.id, label: p.label })));
    const byId = new Map(rows.map((r) => [r.name, r]));
    for (const entry of availability()) {
        const row = byId.get(entry.provider.label);
        if (!row) continue;
        if (!entry.ok) {
            row.status = 'Not configured';
            row.lastError = entry.reason;
            row.nextRetry = '-';
        } else if (entry.cooling) {
            row.status = 'ConnectionError';
            row.nextRetry = health.formatDelay(entry.cooldownMs);
        }
    }
    return rows;
}

async function withTimeout(promise, ms, label) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
                if (timer.unref) timer.unref();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Search every reachable provider in parallel. Never throws: each provider's
 * outcome is reported, its health updated, and the caller gets the union of
 * candidates plus any notes worth logging.
 */
async function searchAll(release, options = {}) {
    const ctx = {
        http: options.http || net,
        timeoutMs: options.timeoutMs || PROVIDER_TIMEOUT_MS,
        sourceLanguages: sourceLanguages(options),
        log: options.log || (() => { })
    };
    const only = options.only ? new Set([].concat(options.only)) : null;
    const skip = options.skip ? new Set([].concat(options.skip)) : null;
    const perProvider = {};
    const notes = [];

    // One free IMDb lookup per title makes the id-based stalls (YIFY, subdl,
    // opensubtitles.com) exact instead of guesswork. Cached across runs.
    if (!release.imdb && options.resolveImdb !== false && process.env.PROVIDER_RESOLVE_IMDB !== '0') {
        try {
            const id = await imdbLookup.resolveImdbId(release, { http: ctx.http, timeoutMs: Math.min(ctx.timeoutMs, 8000) });
            if (id) {
                release.imdb = id;
                notes.push(`imdb:${id}`);
            }
        } catch (e) {
            // never a reason to fail the search
        }
    }

    const tasks = REGISTRY.map(async (provider) => {
        if (only && !only.has(provider.id)) return;
        if (skip && skip.has(provider.id)) {
            perProvider[provider.id] = { ok: true, count: 0, skipped: 'disabled by options' };
            return;
        }

        let availabilityResult;
        try {
            availabilityResult = provider.available(ctx) || { ok: true };
        } catch (e) {
            availabilityResult = { ok: false, reason: e.message };
        }
        if (!availabilityResult.ok) {
            health.markUnavailable(provider.id, availabilityResult.reason || 'unavailable');
            perProvider[provider.id] = { ok: false, count: 0, error: availabilityResult.reason, unavailable: true };
            return;
        }

        const cooling = health.cooldown(provider.id);
        if (cooling.cooling && !options.ignoreCooldown) {
            perProvider[provider.id] = { ok: false, count: 0, skipped: `retry ${health.formatDelay(cooling.msLeft)}`, cooling: true };
            return;
        }

        try {
            const found = await withTimeout(
                Promise.resolve(provider.search(release, ctx)),
                ctx.timeoutMs + 5000,
                provider.id
            );
            health.markSuccess(provider.id);
            perProvider[provider.id] = { ok: true, count: (found || []).length };
            return { provider, found: found || [] };
        } catch (e) {
            health.markFailure(provider.id, e);
            perProvider[provider.id] = { ok: false, count: 0, error: net.snippet(e.message, 200) };
            return;
        }
    });

    const results = await Promise.all(tasks);
    const candidates = [];
    for (const result of results) {
        if (!result) continue;
        for (const candidate of result.found) {
            candidates.push(Object.assign({}, candidate, {
                providerPriority: result.provider.priority
            }));
        }
    }
    return { candidates, perProvider, notes, ctx };
}

/**
 * Candidate order: Arabic first (no model needed at all), then the translation
 * source languages in the order config asks for, then everything else. Within a
 * language, the release-name match, the provider's own signals and the stall
 * order decide.
 */
function rankCandidates(candidates, release, options = {}) {
    const sourceLangs = sourceLanguages(options);
    const baseName = release.baseName || release.title || '';

    return candidates.map((candidate) => {
        const pref = langs.preferenceScore(candidate.langCode, {
            prefer: ['ar'],
            accept: sourceLangs
        });
        let score = 1000 - pref * 100;
        const boost = Number(candidate.scoreBoost || 0);
        score += Math.min(60, Math.max(0, boost) * 30);
        if (candidate.releaseName) {
            const similarity = titleMatch(candidate.releaseName, baseName);
            score += similarity * 25;
            if (release.year && String(candidate.releaseName).includes(String(release.year))) score += 5;
        }
        score += Math.min(15, (Number(candidate.downloads) || 0) / 100);
        score -= (Number(candidate.providerPriority) || 99) * 0.5;
        score -= (Number(candidate.rating) || 0) < 0 ? 10 : 0;
        return Object.assign({}, candidate, { score });
    }).sort((a, b) => b.score - a.score);
}

/** Parse whatever the provider returned and decide which language it really is. */
function toCues(text, candidate) {
    const srt = parseSRT(text);
    if (srt.length > 0) {
        const validation = validateSRT(text);
        if (!validation.ok) throw new Error(`downloaded subtitle is not valid (${validation.reason})`);
        return { cues: validation.cues, format: 'srt' };
    }
    const ass = parseASS(text);
    if (ass.length > 0) {
        return {
            cues: ass.map((cue, i) => ({ index: String(i + 1), start: cue.start, end: cue.end, text: cue.text })),
            format: 'ass'
        };
    }
    const vtt = parseVTT(text);
    if (vtt.length > 0) {
        return {
            cues: vtt.map((cue, i) => ({ index: String(i + 1), start: cue.start, end: cue.end, text: cue.text })),
            format: 'vtt'
        };
    }
    throw new Error('no parseable cues');
}

/**
 * Download from the top candidates (best first) until one yields a real,
 * parseable subtitle. Returns `{ ok:false, tried, notes }` when the bazaar
 * comes up empty — the caller then falls back to the on-device transcript.
 */
async function acquire(release, options = {}) {
    const search = options.searchResult || await searchAll(release, options);
    const ranked = rankCandidates(search.candidates, release, options);
    const maxTries = options.maxTries || Number.parseInt(process.env.PROVIDER_MAX_TRIES || '6', 10);
    const preferCodes = ['ar', ...sourceLanguages(options)];
    const notes = [];
    const tried = [];
    const attempts = [];
    const providerFailures = new Map();

    for (const candidate of ranked) {
        if (tried.length >= maxTries) break;
        if ((providerFailures.get(candidate.provider) || 0) >= 2) continue;

        const provider = providerById(candidate.provider);
        if (!provider) continue;

        tried.push({ provider: candidate.provider, language: candidate.langCode, release: candidate.releaseName || null });
        try {
            const downloaded = await withTimeout(
                Promise.resolve(provider.download(candidate, search.ctx || { http: net })),
                (options.timeoutMs || PROVIDER_TIMEOUT_MS) * 2 + 5000,
                `${candidate.provider} download`
            );
            const { files, note } = extractSubtitles(downloaded.data, downloaded.name || '');
            if (note) notes.push(`${candidate.provider}: ${note}`);
            const file = pickSubtitle(files, { prefer: preferCodes });
            if (!file) {
                notes.push(`${candidate.provider}: no subtitle file inside ${downloaded.name || 'payload'}`);
                attempts.push({ source: candidate.provider, outcome: 'rejected', reason: 'no-subtitle-in-payload', language: candidate.langCode });
                continue;
            }

            const decoded = normalizeToUtf8(file.data);
            const text = decoded.text;
            const parsed = toCues(text, candidate);

            // "Found but bad" is not a stop: a candidate that cannot be a full
            // subtitle for this video is discarded and the ladder marches on.
            const fit = checkFit(parsed.cues, { durationMs: options.durationMs });
            if (!fit.ok && !options.skipFit) {
                notes.push(`${candidate.provider}: rejected (${fit.reason}) — ${describeFit(fit)}`);
                attempts.push({
                    source: candidate.provider,
                    outcome: 'rejected',
                    reason: `${fit.reason} (${describeFit(fit)})`,
                    language: candidate.langCode,
                    file: file.name
                });
                continue;
            }

            const detected = langs.detect(text, candidate.langCode);
            const arabic = looksArabic(text) || parsed.cues.some((c) => looksArabic(c.text));
            const langCode = arabic ? 'ar' : (detected !== 'und' ? detected : (candidate.langCode || 'und'));

            attempts.push({ source: candidate.provider, outcome: 'downloaded', language: langCode, file: file.name });

            health.markSuccess(candidate.provider);
            return {
                ok: true,
                provider: candidate.provider,
                candidate,
                language: langs.nameFor(langCode),
                langCode,
                sourceLanguage: candidate.langCode,
                cues: parsed.cues,
                format: parsed.format,
                fit,
                attempts,
                text,
                fileName: file.name,
                downloadedAs: sidecarName(release.videoPath, langCode, candidate.provider),
                saveName: sidecarName(release.videoPath, langCode, candidate.provider),
                tried,
                notes,
                search
            };
        } catch (e) {
            providerFailures.set(candidate.provider, (providerFailures.get(candidate.provider) || 0) + 1);
            health.markFailure(candidate.provider, e);
            const reason = net.snippet(e.message, 200);
            notes.push(`${candidate.provider}: ${reason}`);
            attempts.push({ source: candidate.provider, outcome: 'failed', reason, language: candidate.langCode });
        }
    }

    return { ok: false, tried, attempts, notes, search, ranked };
}

/**
 * The sidecar name a downloaded (or extracted) subtitle gets. It matches what
 * the local scan already recognises — `Movie.<lang>.srt` next to the video — so
 * the bazaar pays for itself on the very next run, and the user can see and
 * edit exactly what was fetched.
 */
function sidecarName(videoPath, langCode, providerId = null, exists = fs.existsSync) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const tag = langs.fileTag(langCode);
    const plain = path.join(dir, `${base}.${tag}.srt`);
    if (!exists(plain)) return plain;
    if (providerId) {
        const tagged = path.join(dir, `${base}.${tag}.${providerId}.srt`);
        if (!exists(tagged)) return tagged;
        const stamped = path.join(dir, `${base}.${tag}.${providerId}.${Date.now()}.srt`);
        return stamped;
    }
    return path.join(dir, `${base}.${tag}.${Date.now()}.srt`);
}

/** Write the raw subtitle next to the video under the local-scan name. */
function saveSidecar(videoPath, langCode, providerId, cues) {
    const target = sidecarName(videoPath, langCode, providerId);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, serializeSRT(cues), 'utf8');
    fs.renameSync(tmp, target);
    return target;
}

module.exports = {
    REGISTRY,
    providers,
    providerById,
    availability,
    statusRows,
    searchAll,
    rankCandidates,
    acquire,
    toCues,
    checkFit,
    describeFit,
    sidecarName,
    serializeSRT,
    saveSidecar,
    sourceLanguages,
    PROVIDER_TIMEOUT_MS
};
