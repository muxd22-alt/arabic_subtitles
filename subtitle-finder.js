const fs = require('fs');
const path = require('path');
const { computeOsHash, OpenSubtitlesClient, QuotaExceededError } = require('./opensubtitles.js');
const { identifyMovie } = require('./movie-identifier.js');
const { validateSRT, normalizeToUtf8, looksArabic, probeDurationMs } = require('./srt-utils.js');
const { logDecision } = require('./decision-log.js');

const TMP_DIR_NAME = '.subarabify_tmp';
const MAX_REMOTE_CANDIDATES = 3; // download attempts per language per video

// Local lookup order. Arabic always wins over English (spec priority 2a → 2b);
// the historic `<base>.srt` then `eng.srt` behaviour is preserved inside the English tier.
const LOCAL_AR_NAMES = ['ar.srt', 'arabic.srt', 'sub.ar.srt', 'subtitle.ar.srt'];
const LOCAL_EN_NAMES = ['eng.srt', 'english.srt', 'sub.en.srt', 'subtitle.en.srt'];

function isOutputOrCacheFile(fileName, baseName) {
    return fileName === `${baseName}.SubArabify.ar.srt` ||
        (fileName.startsWith(`${baseName}.`) && fileName.includes('.os.'));
}

function listSubtitleFiles(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.srt'));
    } catch (e) {
        return [];
    }
}

function matchByName(files, wanted) {
    const lowerWanted = wanted.toLowerCase();
    return files.find((f) => f.toLowerCase() === lowerWanted) || null;
}

/**
 * Ordered local candidates for one language.
 * Named matches first, then (for Arabic) any subtitle that carries the video's
 * base name — content is verified by the caller, not just the file name.
 */
function localCandidates(dir, baseName, language) {
    const files = listSubtitleFiles(dir).filter((f) => !isOutputOrCacheFile(f, baseName));
    const baseLower = baseName.toLowerCase();
    const ordered = [];
    const push = (name) => {
        if (name && !ordered.includes(name)) ordered.push(name);
    };

    const suffixed = ['.ar.srt', '.arabic.srt', '.arab.srt', '.ara.srt'];
    if (language === 'ar') {
        suffixed.forEach((suffix) => push(matchByName(files, `${baseName}${suffix}`)));
        LOCAL_AR_NAMES.forEach((name) => push(matchByName(files, name)));
        files
            .filter((f) => f.toLowerCase().includes(baseLower))
            .filter((f) => !/\.(en|eng|english)\.srt$/i.test(f))
            .forEach(push);
    } else {
        push(matchByName(files, `${baseName}.srt`));
        push(matchByName(files, `${baseName}.en.srt`));
        push(matchByName(files, `${baseName}.eng.srt`));
        push(matchByName(files, `${baseName}.english.srt`));
        LOCAL_EN_NAMES.forEach((name) => push(matchByName(files, name)));
        files
            .filter((f) => f.toLowerCase().includes(baseLower))
            .filter((f) => !/\.(ar|arabic|arab|ara)\.srt$/i.test(f))
            .forEach(push);
    }

    return ordered.map((name) => path.join(dir, name));
}

function validateCandidate(filePath, durationMs) {
    try {
        const raw = fs.readFileSync(filePath);
        const { text, encoding, warnings } = normalizeToUtf8(raw);
        const result = validateSRT(text, { durationMs: durationMs || null });
        return Object.assign({}, result, { encoding, warnings, text, cueCount: result.cues.length });
    } catch (e) {
        return { ok: false, reason: `read error: ${e.message}`, cues: [], warnings: [], cueCount: 0, text: '' };
    }
}

function pickLocal(dir, baseName, language, durationMs, decisions) {
    for (const filePath of localCandidates(dir, baseName, language)) {
        const name = path.basename(filePath);
        const validation = validateCandidate(filePath, durationMs);

        if (!validation.ok) {
            decisions.push({ step: `local-${language}`, subtitle: name, result: 'invalid', reason: validation.reason });
            continue;
        }

        const contentIsArabic = looksArabic(validation.text);
        if (language === 'ar' && !contentIsArabic) continue;
        if (language === 'en' && contentIsArabic) continue;

        decisions.push({
            step: `local-${language}`,
            subtitle: name,
            result: 'match',
            match: 'local',
            cueCount: validation.cueCount,
            encoding: validation.encoding
        });

        return {
            status: 'found',
            language,
            source: 'local',
            match: 'local',
            provider: null,
            path: filePath,
            cueCount: validation.cueCount,
            validation
        };
    }

    return null;
}

function rankResults(results) {
    return results.slice().sort((a, b) => {
        if (a.moviehashMatch !== b.moviehashMatch) return a.moviehashMatch ? -1 : 1;
        if (a.machineTranslated !== b.machineTranslated) return a.machineTranslated ? 1 : -1;
        if (a.hearingImpaired !== b.hearingImpaired) return a.hearingImpaired ? 1 : -1;
        return (b.downloadCount || 0) - (a.downloadCount || 0);
    });
}

function persistDownload(ctx, language, text) {
    const cacheDir = path.join(ctx.dir, TMP_DIR_NAME);
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, `${ctx.baseName}.os.${language}.srt`);
    fs.writeFileSync(target, text, 'utf8');
    return target;
}

/**
 * Search OpenSubtitles for one language: moviehash first, then title+year.
 * Downloads and validates candidates until one passes.
 */
async function searchRemote(client, ctx, language, decisions) {
    const searches = [];

    if (ctx.hash) {
        searches.push({
            match: 'hash',
            params: { moviehash: ctx.hash, languages: language, year: ctx.movie.year || undefined }
        });
    }

    if (ctx.movie.title) {
        searches.push({
            match: 'title',
            params: {
                query: ctx.movie.title,
                languages: language,
                year: ctx.movie.year || undefined,
                season: ctx.movie.season,
                episode: ctx.movie.episode,
                type: ctx.movie.type === 'episode' ? 'episode' : 'movie'
            }
        });
    }

    let attempts = 0;

    for (const search of searches) {
        let results;
        try {
            const res = await client.search(search.params);
            results = rankResults(res.results || []);
            decisions.push({
                step: `remote-${language}`,
                match: search.match,
                result: 'search',
                hits: results.length,
                total: res.totalCount
            });
        } catch (e) {
            if (e instanceof QuotaExceededError) throw e;
            decisions.push({ step: `remote-${language}`, match: search.match, result: 'error', reason: e.message });
            if (e.code === 'auth_failed') throw e;
            continue;
        }

        for (const candidate of results) {
            if (candidate.language && candidate.language !== language) continue;
            if (attempts >= MAX_REMOTE_CANDIDATES) break;
            attempts++;

            let downloaded;
            try {
                downloaded = await client.downloadSubtitle(candidate.fileId);
            } catch (e) {
                if (e instanceof QuotaExceededError) throw e;
                decisions.push({
                    step: `remote-${language}`,
                    match: search.match,
                    result: 'download-failed',
                    fileId: candidate.fileId,
                    reason: e.message
                });
                if (e.code === 'auth_failed') throw e;
                continue;
            }

            const { text, encoding, warnings } = normalizeToUtf8(downloaded.content);
            const validation = validateSRT(text, { durationMs: ctx.durationMs || null });

            if (!validation.ok) {
                decisions.push({
                    step: `remote-${language}`,
                    match: search.match,
                    result: 'invalid',
                    fileId: candidate.fileId,
                    reason: validation.reason
                });
                continue;
            }

            const savedTo = persistDownload(ctx, language, text);

            decisions.push({
                step: `remote-${language}`,
                match: search.match,
                result: 'match',
                provider: 'opensubtitles',
                fileId: candidate.fileId,
                cueCount: validation.cues.length,
                moviehashMatch: candidate.moviehashMatch,
                machineTranslated: candidate.machineTranslated,
                encoding,
                quotaRemaining: downloaded.remaining,
                savedTo: path.basename(savedTo)
            });

            return {
                status: 'found',
                language,
                source: 'opensubtitles',
                match: search.match,
                provider: 'opensubtitles',
                path: savedTo,
                cueCount: validation.cues.length,
                fileId: candidate.fileId,
                moviehashMatch: candidate.moviehashMatch,
                machineTranslated: candidate.machineTranslated,
                quotaRemaining: downloaded.remaining,
                validation,
                warnings: warnings.concat(validation.warnings)
            };
        }
    }

    return null;
}

/**
 * Find the best ready-made subtitle for a video.
 *
 * Priority (spec): Arabic → English; within each tier local files first,
 * then OpenSubtitles (moviehash, then title+year). Returns null when nothing
 * is found so the caller can fall back to audio transcription.
 *
 * Extension point: `options.providers` may append secondary provider layers
 * (e.g. a subliminal_patch Python subprocess) — they run after OpenSubtitles
 * and must return the same result shape or null.
 *
 * @returns {Promise<object>} descriptor: status/language/source/match/path/…
 */
async function findSubtitle(videoPath, options = {}) {
    const dir = path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const decisions = [];

    const movie = options.movie || identifyMovie(baseName);
    const durationMs = options.durationMs !== undefined ? options.durationMs : probeDurationMs(videoPath);

    let hash = null;
    try {
        hash = await computeOsHash(videoPath);
    } catch (e) {
        decisions.push({ step: 'hash', result: 'error', reason: e.message });
    }

    const ctx = { dir, baseName, movie, hash, durationMs };
    const providers = Array.isArray(options.providers) ? options.providers : [];
    const client = options.client || new OpenSubtitlesClient();

    const finish = (result) => {
        decisions.forEach((d) => logDecision(Object.assign({ file: videoPath, movie: movie.title, year: movie.year }, d)));
        return Object.assign(result, { movie, hash, decisions });
    };

    for (const language of ['ar', 'en']) {
        if (!options.skipLocal) {
            const local = pickLocal(dir, baseName, language, durationMs, decisions);
            if (local) return finish(local);
        }

        const remoteDisabled = options.remote === false;

        if (remoteDisabled || !client.enabled()) {
            if (language === 'ar') {
                decisions.push({
                    step: 'remote',
                    result: 'skipped',
                    reason: remoteDisabled ? 'remote disabled' : 'no OPENSUBTITLES_API_KEY'
                });
            }
        } else {
            try {
                const remote = await searchRemote(client, ctx, language, decisions);
                if (remote) return finish(remote);
            } catch (e) {
                const fatal = e instanceof QuotaExceededError || e.code === 'auth_failed';
                decisions.push({ step: `remote-${language}`, result: fatal ? 'aborted' : 'error', reason: e.message });
                if (fatal) break;
            }
        }

        for (const provider of providers) {
            try {
                const extra = await provider(ctx, language, decisions);
                if (extra) return finish(extra);
            } catch (e) {
                decisions.push({ step: `provider-${provider.name || 'extra'}-${language}`, result: 'error', reason: e.message });
            }
        }
    }

    return finish({
        status: 'not_found',
        language: null,
        source: null,
        match: null,
        provider: null,
        path: null
    });
}

module.exports = {
    findSubtitle,
    localCandidates,
    validateCandidate,
    searchRemote,
    rankResults,
    TMP_DIR_NAME
};
