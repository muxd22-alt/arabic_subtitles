const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const {
    readCues,
    normalizeToUtf8,
    looksArabic,
    validateCues,
    validateSRT,
    msToTime
} = require('./srt.js');
const audio = require('./audio.js');
const langs = require('./langs.js');
const { parseRelease } = require('./release.js');
const { logDecision } = require('./decision-log.js');
const { translateTexts } = require('./translate.js');
const { checkFit, describeFit } = require('./providers/fit.js');

const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa'];

function outputPathFor(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(dir, `${base}${config.OUTPUT_SUFFIX}`);
}

function legacyOutputPathFor(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(dir, `${base}${config.LEGACY_OUTPUT_SUFFIX}`);
}

function listSubtitleSiblings(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    let entries = [];
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
    const lowerBase = base.toLowerCase();
    const matches = [];
    for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        // never re-consume our own output (current or pre-2.4 SRT output)
        if (entry.endsWith(config.OUTPUT_SUFFIX) || entry.endsWith(config.LEGACY_OUTPUT_SUFFIX)) continue;
        const stem = entry.slice(0, entry.length - ext.length);
        if (stem.toLowerCase() === lowerBase || stem.toLowerCase().startsWith(`${lowerBase}.`)) {
            matches.push(path.join(dir, entry));
        }
    }
    return matches.sort((a, b) => scoreSibling(a, base) - scoreSibling(b, base));
}

function scoreSibling(filePath, base) {
    const stem = path.basename(filePath, path.extname(filePath));
    const rest = stem.slice(base.length).toLowerCase();
    if (rest === '.ar' || rest === '.arabic') return 0;
    if (rest === '' || rest === '.default') return 1;
    if (rest.includes('ar')) return 2;
    if (rest.includes('en') || rest.includes('eng')) return 3;
    return 4;
}

function readSubtitleFile(filePath) {
    const raw = fs.readFileSync(filePath);
    const { text, warnings } = normalizeToUtf8(raw);
    return { text, warnings };
}

/** Read any supported subtitle format next to a video into cues. */
function readCueFile(filePath, options = {}) {
    const { text, warnings } = readSubtitleFile(filePath);
    const cues = readCues(text, path.extname(filePath));
    const validation = validateCues(cues, options);
    return { cues: validation.ok ? validation.cues : [], validation, warnings, text };
}

/**
 * Decide what source material exists for a video locally:
 *   arabic  → a ready-made Arabic subtitle (brand only, no AI)
 *   english → any non-Arabic subtitle that must be translated
 *   none    → nothing found (the caller may try embedded tracks, the bazaar,
 *             then the audio pipeline)
 */
function findSubtitleSource(videoPath, options = {}) {
    const siblings = listSubtitleSiblings(videoPath);
    const seen = new Set();

    for (const sibling of siblings) {
        const resolved = path.resolve(sibling);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        let parsed;
        try {
            parsed = readCueFile(sibling, options);
        } catch (e) {
            continue;
        }
        if (!parsed.validation.ok) continue;

        const cues = parsed.validation.cues;
        const arabic = cues.filter((c) => looksArabic(c.text)).length;
        const ratio = cues.length ? arabic / cues.length : 0;
        const hint = /\.ar\b|\.arabic\b/i.test(sibling) ? 'ar' : 'und';
        const langCode = ratio >= 0.5 ? 'ar' : langs.detect(parsed.text, hint);
        const fit = checkFit(cues, { minCues: 1, minChars: 1, durationMs: options.durationMs });
        return {
            kind: ratio >= 0.5 ? 'arabic' : 'english',
            language: langs.nameFor(langCode),
            langCode,
            path: sibling,
            cues,
            fit: fit.ok ? fit : null,
            warnings: parsed.warnings,
            arabicRatio: ratio
        };
    }

    return { kind: 'none', language: null, langCode: 'und', path: null, cues: [], warnings: [], arabicRatio: 0 };
}

function isDone(videoPath) {
    return fs.existsSync(outputPathFor(videoPath)) || fs.existsSync(legacyOutputPathFor(videoPath));
}

function writeOutput(videoPath, cues, options = {}) {
    const outPath = outputPathFor(videoPath);
    const { buildASS } = require('./ass.js');
    const tmpPath = `${outPath}.tmp`;
    fs.writeFileSync(tmpPath, buildASS(cues, options), 'utf8');
    fs.renameSync(tmpPath, outPath);
    return outPath;
}

/**
 * Translate source cues → Arabic through the llama server (in parallel chunks)
 * and return the translated cue list, preserving all timings.
 */
async function translateCues(cues, server, options = {}) {
    const texts = cues.map((c) => c.text);
    const { texts: translated, stats } = await translateTexts(texts, server, options);

    const out = cues.map((cue, i) => ({
        index: null,
        start: cue.start,
        end: cue.end,
        text: translated[i] || cue.text
    }));
    return { cues: out, stats };
}

/**
 * The local-first stages: subtitles beside the video, then tracks inside it.
 * Both are free and offline, which is why they run before anything else.
 */
async function findEmbeddedSource(videoPath, options = {}) {
    const embedded = options.embeddedModule || require('./providers/embedded.js');
    let streams;
    try {
        streams = await embedded.listSubtitleStreams(videoPath, { timeoutMs: options.probeTimeoutMs });
    } catch (e) {
        return { kind: 'none', reason: e.message, streams: [] };
    }
    if (streams.length === 0) return { kind: 'none', streams: [] };

    const ranked = embedded.rankStreams(streams);
    const skippedImages = streams.filter((s) => s.image && !s.text);

    for (const stream of ranked) {
        const outPath = path.join(
            config.TMP_DIR,
            `embedded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.srt`
        );
        try {
            fs.mkdirSync(config.TMP_DIR, { recursive: true });
            options.onStage && options.onStage({
                stage: 'embedded',
                source: `${stream.codec}${stream.language ? `/${stream.language}` : ''}`
            });
            await embedded.extractStream(videoPath, stream.index, outPath, options);
            const text = fs.readFileSync(outPath, 'utf8');
            const cues = readCues(text, '.srt');
            const validation = validateCues(cues, { durationMs: options.durationMs });
            if (!validation.ok || validation.cues.length === 0) continue;

            const fit = checkFit(validation.cues, { durationMs: options.durationMs });
            if (!fit.ok && !options.skipFit) {
                options.onNote && options.onNote(`[Embedded] track #${stream.index} rejected (${fit.reason}) — ${describeFit(fit)}`);
                continue;
            }

            const arabic = validation.cues.filter((c) => looksArabic(c.text)).length;
            const ratio = arabic / validation.cues.length;
            return {
                kind: ratio >= 0.5 ? 'arabic' : 'english',
                language: stream.language || langs.nameFor(stream.langCode),
                langCode: ratio >= 0.5 ? 'ar' : (stream.langCode !== 'und' ? stream.langCode : langs.detect(text, 'und')),
                cues: validation.cues,
                text,
                stream,
                streams,
                fit,
                arabicRatio: ratio
            };
        } catch (e) {
            options.onNote && options.onNote(`embedded stream ${stream.index} (${stream.codec}): ${e.message}`);
        } finally {
            try { fs.rmSync(outPath, { force: true }); } catch (e) { }
        }
    }

    return {
        kind: 'none',
        streams,
        reason: skippedImages.length
            ? `${skippedImages.length} image-based track(s) (need OCR)`
            : 'no readable text track'
    };
}

/**
 * Core per-video pipeline — fastest and cheapest first, the model last:
 *
 *   existing output          → skip
 *   local ready-made Arabic  → brand only
 *   local subtitle (any lang)→ translate
 *   embedded track (in file) → brand (Arabic) or translate
 *   the bazaar (free sites)  → save + brand (Arabic) or translate
 *   no subtitle + audio      → whisper transcription → translate
 *   neither                  → skip (reason logged)
 */
async function processVideo(videoPath, options = {}) {
    const server = options.server || null;
    const log = options.log || logDecision;
    const useAudio = options.audio !== false;
    const useEmbedded = options.embedded !== false;
    const useProviders = options.providers === undefined ? config.PROVIDERS_ENABLED : Boolean(options.providers);
    const Bazaar = options.bazaar || require('./providers/index.js');

    if (isDone(videoPath)) {
        log({ file: videoPath, action: 'skip', reason: 'existing-output' });
        return { status: 'skipped', reason: 'existing-output' };
    }

    // Probed lazily (and asynchronously) so files that are already done are never
    // probed and a stuck ffprobe can never block the whole engine.
    let durationMs = options.durationMs !== undefined && options.durationMs !== null
        ? options.durationMs
        : await audio.probeDurationMs(videoPath);

    const source = findSubtitleSource(videoPath, { durationMs });

    if (source.kind === 'arabic') {
        const outPath = writeOutput(videoPath, source.cues, options);
        log({
            file: videoPath,
            action: 'brand-arabic',
            source: source.path ? path.basename(source.path) : 'local',
            language: source.langCode || 'ar',
            sourceLanguage: source.langCode || 'ar',
            fit: source.fit ? source.fit.stats : undefined,
            cueCount: source.cues.length
        });
        return { status: 'branded', output: outPath, cueCount: source.cues.length };
    }

    let cues = source.kind === 'english' ? source.cues : [];
    let origin = source.kind === 'english' ? path.basename(source.path) : null;
    let sourceLang = source.kind === 'english' ? source.langCode : 'und';
    let stage = source.kind === 'english' ? 'local-subtitle' : null;
    let providerId = null;
    let bazaarResult = null;
    let embeddedSource = null;
    let embeddedSavedAs = null;
    let downloadedSavedAs = null;
    const notes = [];
    const note = typeof options.onNote === 'function' ? options.onNote : () => { };
    const fileTag = path.basename(videoPath);

    const saveSidecarQuietly = (langCode, provider, cueList) => {
        if (!useProviders && provider !== 'embedded') return null;
        try {
            const saved = Bazaar.saveSidecar(videoPath, langCode, provider, cueList);
            if (saved) {
                note(`[Fetch] → saved ${path.basename(saved)} (from ${provider})`);
            }
            return saved;
        } catch (e) {
            notes.push(`could not save ${langCode} sidecar: ${e.message}`);
            return null;
        }
    };

    // ── 2. subtitle tracks inside the file (free, offline) ──────────────────
    if (cues.length === 0 && useEmbedded) {
        embeddedSource = await findEmbeddedSource(videoPath, {
            durationMs,
            onStage: options.onStage,
            onNote: (message) => notes.push(message),
            embeddedModule: options.embeddedModule,
            probeTimeoutMs: options.probeTimeoutMs
        });

        if (embeddedSource.kind === 'arabic' || embeddedSource.kind === 'english') {
            const stream = embeddedSource.stream || {};
            const langDisplay = stream.language || stream.langCode || 'und';
            note(`[Embedded] ${fileTag} → track #${stream.index != null ? stream.index : '?'}` +
                ` (${langDisplay}, ${stream.codec || 'text'})` +
                ` → ${embeddedSource.cues.length} cues`);
        }

        if (embeddedSource.kind === 'arabic') {
            const savedAs = saveSidecarQuietly('ar', 'embedded', embeddedSource.cues);
            const outPath = writeOutput(videoPath, embeddedSource.cues, options);
            log({
                file: videoPath,
                action: 'brand-embedded',
                source: `embedded:${embeddedSource.stream.codec}`,
                language: 'ar',
                provider: 'embedded',
                providerId: 'embeddedsubtitles',
                downloadedAs: savedAs ? path.basename(savedAs) : undefined,
                sourceLanguage: embeddedSource.langCode || 'ar',
                fit: embeddedSource.fit ? embeddedSource.fit.stats : undefined,
                attempts: [{
                    source: 'embeddedsubtitles',
                    outcome: 'extracted',
                    language: embeddedSource.langCode || 'ar',
                    track: embeddedSource.stream.index,
                    codec: embeddedSource.stream.codec
                }],
                cueCount: embeddedSource.cues.length
            });
            return { status: 'branded', output: outPath, cueCount: embeddedSource.cues.length, source: 'embedded' };
        }

        if (embeddedSource.kind === 'english') {
            cues = embeddedSource.cues;
            sourceLang = embeddedSource.langCode;
            origin = `embedded:${embeddedSource.stream.codec}${embeddedSource.stream.language ? `/${embeddedSource.stream.language}` : ''}`;
            stage = 'embedded-subtitle';
            providerId = 'embeddedsubtitles';
            embeddedSavedAs = saveSidecarQuietly(sourceLang, 'embedded', cues);
        } else if (embeddedSource.reason) {
            notes.push(`embedded: ${embeddedSource.reason}`);
        }
    }

    // ── 3. the bazaar: free providers, any language ─────────────────────────
    if (cues.length === 0 && useProviders) {
        const release = options.release || parseRelease(videoPath, { metadata: options.metadata });
        if (options.onStage) options.onStage({ stage: 'search', source: release.title || undefined });

        let result = null;
        try {
            result = await Bazaar.acquire(release, {
                sourceLanguages: options.providerLanguages,
                skip: options.skipProviders,
                only: options.onlyProviders,
                timeoutMs: options.providerTimeoutMs,
                ignoreCooldown: options.ignoreProviderCooldown,
                durationMs
            });
        } catch (e) {
            notes.push(`bazaar: ${e.message}`);
        }
        bazaarResult = result;

        if (result && result.search && result.search.perProvider) {
            for (const [pId, pRes] of Object.entries(result.search.perProvider)) {
                if (pRes.error && /timed out/i.test(pRes.error)) {
                    note(`[Fetch] ${fileTag} → ${pId}: timeout (${Math.round((options.providerTimeoutMs || config.PROVIDER_TIMEOUT_MS) / 1000)}s)`);
                }
            }
        }

        if (result && result.ok) {
            providerId = result.provider;
            const label = `${result.provider}/${result.langCode}`;
            const provCandidates = ((result.search && result.search.candidates) || []).filter((c) => c.provider === result.provider);
            const langCounts = {};
            for (const c of provCandidates) {
                const code = c.langCode || 'und';
                langCounts[code] = (langCounts[code] || 0) + 1;
            }
            const langBreakdown = Object.entries(langCounts).map(([l, cnt]) => `${l} ${cnt}`).join(', ');
            const candidateSummary = provCandidates.length > 0
                ? `${provCandidates.length} candidates (${langBreakdown}), `
                : '';
            const candidateName = result.candidate && result.candidate.releaseName
                ? `"${String(result.candidate.releaseName).slice(0, 50)}"`
                : `"${result.langCode}"`;
            note(`[Fetch] ${fileTag} → ${result.provider}: ${candidateSummary}best: ${result.langCode} ${candidateName}` +
                ` ✓ ${result.cues.length} cues`);
            if (options.onStage) options.onStage({ stage: 'download', source: label, cueCount: result.cues.length });

            if (result.langCode === 'ar') {
                downloadedSavedAs = saveSidecarQuietly('ar', result.provider, result.cues);
                const outPath = writeOutput(videoPath, result.cues, options);
                log({
                    file: videoPath,
                    action: 'brand-downloaded',
                    source: label,
                    language: 'ar',
                    provider: result.provider,
                    providerId: result.provider,
                    downloadedAs: result.downloadedAs ? path.basename(result.downloadedAs) : (downloadedSavedAs ? path.basename(downloadedSavedAs) : undefined),
                    sourceLanguage: result.sourceLanguage,
                    fit: result.fit ? result.fit.stats : undefined,
                    attempts: result.attempts,
                    cueCount: result.cues.length,
                    tried: (result.tried || []).length
                });
                return {
                    status: 'branded',
                    output: outPath,
                    cueCount: result.cues.length,
                    source: 'provider',
                    provider: result.provider
                };
            }

            cues = result.cues;
            sourceLang = result.langCode;
            origin = label;
            stage = 'downloaded';
            downloadedSavedAs = saveSidecarQuietly(sourceLang, result.provider, cues);
        } else if (result) {
            for (const noteLine of (result.notes || []).slice(0, 4)) notes.push(noteLine);
            if (result.tried && result.tried.length === 0) notes.push('no provider had a match');
            note(`[Fetch] ${fileTag} → nothing usable` +
                `${result.tried && result.tried.length ? ` (${result.tried.length} candidates tried)` : ''}` +
                ` → ${useAudio ? 'whisper' : 'skip'}`);
        }
    }

    // ── 4. last resort: transcribe the audio on device ──────────────────────
    if (cues.length === 0) {
        if (!useAudio) {
            log({
                file: videoPath,
                action: 'skip',
                reason: 'no-subtitle',
                attempts: bazaarResult ? bazaarResult.attempts : undefined,
                notes: notes.length ? notes : undefined
            });
            return { status: 'skipped', reason: 'no-subtitle' };
        }

        if (options.onStage) options.onStage({ stage: 'transcribe', source: 'whisper' });
        const { transcribeMedia } = require('./asr.js');
        const transcribed = await transcribeMedia(videoPath, {
            durationMs,
            onProgress: options.onProgress,
            threads: options.threads,
            concurrency: options.concurrency,
            bin: options.whisperBin
        });

        if (!transcribed || transcribed.length === 0) {
            log({
                file: videoPath,
                action: 'skip',
                reason: 'no-speech',
                attempts: bazaarResult ? bazaarResult.attempts : undefined,
                notes: notes.length ? notes : undefined
            });
            return { status: 'skipped', reason: 'no-speech' };
        }

        cues = transcribed;
        sourceLang = 'en';
        origin = 'whisper';
        stage = 'transcribed';
    }

    // ── translate whatever source won, then brand it Arabic ─────────────────
    if (!server) {
        throw new Error('translation needed but no llama server was provided');
    }

    if (options.onStage) options.onStage({ stage: 'translate', source: origin || undefined, cueCount: cues.length });
    const translated = await translateCues(cues, server, {
        onProgress: options.onProgress,
        ...(options.translate || {})
    });

    let decisionProvider = undefined;
    let decisionProviderId = undefined;
    let decisionDownloadedAs = undefined;
    let decisionSourceLanguage = sourceLang;
    let decisionFit = undefined;
    let decisionAttempts = bazaarResult ? bazaarResult.attempts : undefined;

    if (stage === 'downloaded' && bazaarResult && bazaarResult.ok) {
        decisionProvider = bazaarResult.provider;
        decisionProviderId = bazaarResult.provider;
        decisionDownloadedAs = bazaarResult.downloadedAs ? path.basename(bazaarResult.downloadedAs) : (downloadedSavedAs ? path.basename(downloadedSavedAs) : undefined);
        decisionSourceLanguage = bazaarResult.sourceLanguage || sourceLang;
        decisionFit = bazaarResult.fit ? bazaarResult.fit.stats : undefined;
    } else if (stage === 'embedded-subtitle') {
        decisionProvider = 'embedded';
        decisionProviderId = 'embeddedsubtitles';
        decisionDownloadedAs = embeddedSavedAs ? path.basename(embeddedSavedAs) : undefined;
        decisionSourceLanguage = sourceLang;
        decisionFit = (embeddedSource && embeddedSource.fit) ? embeddedSource.fit.stats : undefined;
        decisionAttempts = [{
            source: 'embeddedsubtitles',
            outcome: 'extracted',
            language: sourceLang
        }];
    } else if (stage === 'local-subtitle') {
        decisionProvider = undefined;
        decisionProviderId = undefined;
        decisionFit = source.fit ? source.fit.stats : undefined;
    } else if (stage === 'transcribed') {
        decisionProvider = 'whisper';
        decisionProviderId = 'whisper';
    }

    const outPath = writeOutput(videoPath, translated.cues, options);
    log({
        file: videoPath,
        action: 'translate',
        source: origin,
        language: sourceLang,
        stage,
        provider: decisionProvider,
        providerId: decisionProviderId,
        downloadedAs: decisionDownloadedAs,
        sourceLanguage: decisionSourceLanguage,
        fit: decisionFit,
        attempts: decisionAttempts,
        cueCount: translated.cues.length,
        batches: translated.stats ? translated.stats.batches : undefined,
        notes: notes.length ? notes : undefined
    });

    return {
        status: 'translated',
        output: outPath,
        cueCount: translated.cues.length,
        language: sourceLang,
        source: stage,
        provider: providerId || undefined
    };
}

module.exports = {
    SUBTITLE_EXTS,
    outputPathFor,
    legacyOutputPathFor,
    listSubtitleSiblings,
    scoreSibling,
    readSubtitleFile,
    readCueFile,
    findSubtitleSource,
    findEmbeddedSource,
    isDone,
    writeOutput,
    translateCues,
    processVideo
};
