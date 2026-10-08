const config = require('./config.js');
const { arabicRatio } = require('./srt.js');

/**
 * Split an array into batches limited by both item count and total chars.
 */
function batchTexts(texts, options = {}) {
    const maxLines = options.maxLines || config.BATCH_LINES;
    const maxChars = options.maxChars || config.BATCH_CHARS;
    const batches = [];
    let current = [];
    let chars = 0;

    for (const text of texts) {
        const len = String(text).length;
        if (current.length >= maxLines || (current.length > 0 && chars + len > maxChars)) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(text);
        chars += len;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * A tiny fixed-size promise pool used for parallel chunk translation.
 */
async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runner() {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await worker(items[i], i);
        }
    }

    const size = Math.max(1, Math.min(limit, items.length || 1));
    await Promise.all(Array.from({ length: size }, () => runner()));
    return results;
}

/**
 * Does this output actually look like the translation we asked for?
 * Guards against the model echoing the source or answering in English.
 */
function looksTranslated(sources, outputs) {
    if (!Array.isArray(outputs) || outputs.length !== sources.length) return false;
    if (outputs.some((t) => !t || !String(t).trim())) return false;
    const wantsText = sources.some((t) => /[A-Za-z\u0600-\u06FF]/.test(String(t)));
    if (!wantsText) return true;
    return outputs.some((t) => arabicRatio(t) >= 0.3);
}

/**
 * Translate an ordered list of cue texts through the llama server in parallel
 * chunks. Each chunk is validated; a failing chunk is split into smaller
 * groups and retried, and lines the model never renders in Arabic keep their
 * source text instead of failing the whole run.
 *
 * Returns { texts, stats }.
 */
async function translateTexts(texts, server, options = {}) {
    const concurrency = options.concurrency || config.CONCURRENCY;
    const onProgress = options.onProgress || (() => { });
    const targetLang = options.targetLang || config.TARGET_LANG;
    const maxAttempts = options.maxAttempts || 3;

    const batches = batchTexts(texts, options);
    let done = 0;
    let retried = 0;
    let keptSource = 0;

    const translatedBatches = await mapPool(batches, concurrency, async (batch) => {
        // groups hold indices into the original batch so order survives splitting
        let groups = [batch.map((_, i) => i)];
        const out = new Array(batch.length).fill(null);

        const assign = (group, values) => {
            group.forEach((idx, i) => { out[idx] = values[i]; });
        };

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const sources = groups.map((g) => g.map((i) => batch[i]));
            let settled = null;
            try {
                settled = await Promise.all(
                    sources.map((s) => server.translate(s, { targetLang, maxTokens: options.maxTokens }))
                );
            } catch (e) {
                settled = null;
            }

            const failed = new Set();
            if (settled === null) {
                groups.forEach((_, i) => failed.add(i));
            } else {
                groups.forEach((g, i) => {
                    if (looksTranslated(sources[i], settled[i])) assign(g, settled[i]);
                    else failed.add(i);
                });
            }

            if (failed.size === 0) break;
            retried++;

            const next = [];
            let splittable = false;
            groups.forEach((g, i) => {
                if (!failed.has(i)) {
                    next.push(g);
                } else if (g.length > 1) {
                    const mid = Math.ceil(g.length / 2);
                    next.push(g.slice(0, mid), g.slice(mid));
                    splittable = true;
                } else {
                    next.push(g);
                }
            });

            if (!splittable) {
                // singles that still fail: keep the source text for them
                groups.forEach((g, i) => {
                    if (failed.has(i)) {
                        keptSource += g.length;
                        assign(g, g.map((idx) => batch[idx]));
                    }
                });
                break;
            }
            groups = next;
        }

        // anything still untranslated (e.g. ran out of attempts) keeps its source
        out.forEach((v, i) => {
            if (v === null) {
                keptSource++;
                out[i] = batch[i];
            }
        });

        done += batch.length;
        onProgress({ done, total: texts.length, batchesDone: done, batchesTotal: texts.length });
        return out;
    });

    const flat = translatedBatches.flat();
    return {
        texts: flat,
        stats: { batches: batches.length, retried, keptSource, total: texts.length }
    };
}

module.exports = { batchTexts, mapPool, translateTexts, looksTranslated };
