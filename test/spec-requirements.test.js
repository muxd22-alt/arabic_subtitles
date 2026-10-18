const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'arabicsubs-spec-'));
process.env.ARABIC_SUBS_HOME = SCRATCH;
process.env.PROVIDERS_STATE = path.join(SCRATCH, 'providers.json');

const config = require('../src/config.js');
const { checkFit, describeFit } = require('../src/providers/fit.js');
const embedded = require('../src/providers/embedded.js');
const { processVideo, findEmbeddedSource, findSubtitleSource } = require('../src/pipeline.js');
const { embedFont, uuencodeFont } = require('../src/ass.js');

function tmpDir() {
    return fs.mkdtempSync(path.join(SCRATCH, 'dir-'));
}

function longSRT(linesCount = 12, text = 'A complete dialogue subtitle sentence with plenty of visible text') {
    const lines = [];
    for (let i = 0; i < linesCount; i++) {
        const start = `00:01:${String(i * 5 + 1).padStart(2, '0')},000`;
        const end = `00:01:${String(i * 5 + 4).padStart(2, '0')},000`;
        lines.push(`${i + 1}\n${start} --> ${end}\n${text} line ${i + 1}\n`);
    }
    return lines.join('\n');
}

function fakeServer() {
    return {
        async translate(texts) {
            return texts.map((t, i) => `مترجم ${i}: ${t}`);
        }
    };
}

// ── 1. Config Aliases ────────────────────────────────────────────────────────

test('config aliases support both modern and legacy/spec names', () => {
    assert.strictEqual(config.SUB_FETCH, config.PROVIDERS_ENABLED);
    assert.deepStrictEqual(config.SUB_FETCH_LANGS, config.PROVIDER_LANGUAGES);
    assert.strictEqual(config.SUB_FETCH_TIMEOUT_MS, config.PROVIDER_TIMEOUT_MS);
    assert.strictEqual(config.SUB_FETCH_MAX_TRIES, config.PROVIDER_MAX_TRIES);
    assert.strictEqual(config.SUB_FETCH_EMBEDDED, config.PROVIDER_EMBEDDED);
    assert.strictEqual(config.RESOLVE_IMDB, config.PROVIDER_RESOLVE_IMDB);
    assert.strictEqual(config.IMDB_RESOLVE, config.PROVIDER_RESOLVE_IMDB);

    assert.ok(config.CONFIG_ALIASES);
    assert.strictEqual(config.CONFIG_ALIASES.SUB_FETCH, 'ARABIC_SUBS_PROVIDERS');
    assert.strictEqual(config.CONFIG_ALIASES.SUB_FETCH_LANGS, 'PROVIDER_LANGUAGES');
    assert.strictEqual(config.CONFIG_ALIASES.SUB_FETCH_TIMEOUT_MS, 'PROVIDER_TIMEOUT_MS');
    assert.strictEqual(config.CONFIG_ALIASES.SUB_FETCH_MAX_TRIES, 'PROVIDER_MAX_TRIES');
    assert.strictEqual(config.CONFIG_ALIASES.SUB_FETCH_EMBEDDED, 'PROVIDER_EMBEDDED');
    assert.strictEqual(config.CONFIG_ALIASES.RESOLVE_IMDB, 'PROVIDER_RESOLVE_IMDB');
});

// ── 2. Embedded Partial-Track Heuristic ──────────────────────────────────────

test('extractFrameCount handles various tag casings and suffixes', () => {
    assert.strictEqual(embedded.extractFrameCount({ NUMBER_OF_FRAMES: '1420' }), 1420);
    assert.strictEqual(embedded.extractFrameCount({ 'number_of_frames-eng': '850' }), 850);
    assert.strictEqual(embedded.extractFrameCount({ NUMBER_OF_FRAMES_ARA: '1200' }), 1200);
    assert.strictEqual(embedded.extractFrameCount({ number_of_frames: '500' }), 500);
    assert.strictEqual(embedded.extractFrameCount({ unrelated: '100' }), null);
    assert.strictEqual(embedded.extractFrameCount(null), null);
});

test('markPartialStreams drops tracks with < 1/3 of max frames', () => {
    const streams = [
        { index: 0, frames: 1200, codec: 'subrip', text: true },
        { index: 1, frames: 1100, codec: 'subrip', text: true },
        { index: 2, frames: 150, codec: 'subrip', text: true } // 150 < 1200 / 3 = 400
    ];
    const marked = embedded.markPartialStreams(streams);
    assert.strictEqual(marked[0].partial, undefined);
    assert.strictEqual(marked[1].partial, undefined);
    assert.strictEqual(marked[2].partial, true);
    assert.strictEqual(marked[2].partialReason, 'low-frame-count');
});

test('rankStreams filters out partial tracks and penalizes forced/signs tracks', () => {
    const streams = [
        { index: 0, frames: 150, partial: true, text: true, langCode: 'en' },
        { index: 1, frames: 1200, text: true, langCode: 'en', forced: true },
        { index: 2, frames: 1200, text: true, langCode: 'en', default: true },
        { index: 3, frames: 1200, text: true, langCode: 'ar' }
    ];
    const ranked = embedded.rankStreams(streams);
    assert.strictEqual(ranked.length, 3);
    assert.ok(!ranked.some((s) => s.partial));
    assert.strictEqual(ranked[0].langCode, 'ar');
    assert.strictEqual(ranked[1].index, 2); // default non-forced en
    assert.strictEqual(ranked[2].index, 1); // forced en
});

// ── 3. Fit Check ─────────────────────────────────────────────────────────────

test('checkFit accepts raw SRT string as well as cue objects', () => {
    const srt = longSRT(10);
    const fit = checkFit(srt);
    assert.strictEqual(fit.ok, true);
    assert.strictEqual(fit.stats.cues, 10);
    assert.ok(fit.stats.chars > 300);
});

test('checkFit rejects too few cues', () => {
    const fit = checkFit([{ start: '00:00:01,000', end: '00:00:02,000', text: 'short' }]);
    assert.strictEqual(fit.ok, false);
    assert.strictEqual(fit.reason, 'too-few-cues');
});

test('checkFit rejects signs-only / short content below character threshold', () => {
    const cues = [];
    for (let i = 0; i < 10; i++) cues.push({ start: `00:0${i}:01,000`, end: `00:0${i}:02,000`, text: 'x' });
    const fit = checkFit(cues);
    assert.strictEqual(fit.ok, false);
    assert.strictEqual(fit.reason, 'signs-only');
});

test('checkFit rejects out of range subtitles when video duration is known', () => {
    const srt = longSRT(10);
    // last cue ends at 00:01:49 (~109s)
    const fitPast = checkFit(srt, { durationMs: 10 * 1000 }); // video is only 10s, 109s > 10s + 90s (100s)
    assert.strictEqual(fitPast.ok, false);
    assert.strictEqual(fitPast.reason, 'out-of-range');

    const fitOk = checkFit(srt, { durationMs: 120 * 1000 });
    assert.strictEqual(fitOk.ok, true);
});

test('describeFit formats descriptive statistics string', () => {
    const srt = longSRT(10);
    const fit = checkFit(srt, { durationMs: 120 * 1000 });
    const desc = describeFit(fit);
    assert.ok(desc.includes('10 cues'));
    assert.ok(desc.includes('chars'));
    assert.ok(desc.includes('ends'));
});

// ── 4. Provenance Fields in Pipeline and Decisions Log ───────────────────────

test('processVideo populates provenance fields when branding embedded Arabic', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'movie.mkv');
    fs.writeFileSync(video, 'fake-mkv');

    const fakeEmbeddedModule = {
        async listSubtitleStreams() {
            return [{ index: 0, codec: 'subrip', text: true, langCode: 'ar', language: 'ara', frames: 900 }];
        },
        rankStreams(streams) { return streams; },
        async extractStream(vPath, idx, outPath) {
            fs.writeFileSync(outPath, longSRT(10, 'مرحبا يا أصدقائي هذه ترجمة عربية مدمجة بالكامل'));
        }
    };

    const logs = [];
    const notes = [];
    const res = await processVideo(video, {
        server: fakeServer(),
        embeddedModule: fakeEmbeddedModule,
        durationMs: 120000,
        log: (entry) => logs.push(entry),
        onNote: (n) => notes.push(n)
    });

    assert.strictEqual(res.status, 'branded');
    assert.strictEqual(res.source, 'embedded');
    assert.strictEqual(logs.length, 1);
    const entry = logs[0];
    assert.strictEqual(entry.action, 'brand-embedded');
    assert.strictEqual(entry.provider, 'embedded');
    assert.strictEqual(entry.providerId, 'embeddedsubtitles');
    assert.strictEqual(entry.sourceLanguage, 'ar');
    assert.ok(entry.downloadedAs && entry.downloadedAs.endsWith('.srt'));
    assert.ok(entry.fit && entry.fit.cues === 10);
    assert.ok(Array.isArray(entry.attempts) && entry.attempts.length > 0);

    // Verify [Embedded] and [Fetch] log lines
    assert.ok(notes.some((n) => n.startsWith('[Embedded]')));
    assert.ok(notes.some((n) => n.startsWith('[Fetch] → saved')));
});

test('processVideo populates provenance fields when translating embedded non-Arabic track', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'movie.mkv');
    fs.writeFileSync(video, 'fake-mkv');

    const fakeEmbeddedModule = {
        async listSubtitleStreams() {
            return [{ index: 0, codec: 'subrip', text: true, langCode: 'en', language: 'eng', frames: 900 }];
        },
        rankStreams(streams) { return streams; },
        async extractStream(vPath, idx, outPath) {
            fs.writeFileSync(outPath, longSRT(10, 'Hello friends, this is an embedded English subtitle'));
        }
    };

    const logs = [];
    const notes = [];
    const res = await processVideo(video, {
        server: fakeServer(),
        embeddedModule: fakeEmbeddedModule,
        durationMs: 120000,
        log: (entry) => logs.push(entry),
        onNote: (n) => notes.push(n)
    });

    assert.strictEqual(res.status, 'translated');
    assert.strictEqual(res.source, 'embedded-subtitle');
    assert.strictEqual(logs.length, 1);
    const entry = logs[0];
    assert.strictEqual(entry.action, 'translate');
    assert.strictEqual(entry.provider, 'embedded');
    assert.strictEqual(entry.providerId, 'embeddedsubtitles');
    assert.strictEqual(entry.sourceLanguage, 'en');
    assert.ok(entry.downloadedAs && entry.downloadedAs.endsWith('.srt'));
    assert.ok(entry.fit && entry.fit.cues === 10);
    assert.ok(Array.isArray(entry.attempts));
});

test('processVideo populates provenance fields when branding downloaded Arabic from bazaar', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'Inception.2010.mkv');
    fs.writeFileSync(video, 'fake-video');

    const fakeBazaar = {
        async acquire() {
            const cues = [];
            for (let i = 0; i < 10; i++) {
                cues.push({
                    start: `00:01:${String(i * 5 + 1).padStart(2, '0')},000`,
                    end: `00:01:${String(i * 5 + 4).padStart(2, '0')},000`,
                    text: `سطر عربي كامل للترجمة ${i + 1}`
                });
            }
            return {
                ok: true,
                provider: 'yifysubtitles',
                langCode: 'ar',
                sourceLanguage: 'ar',
                cues,
                format: 'srt',
                fit: { ok: true, stats: { cues: 10, chars: 400, lastEndMs: 60000, durationMs: 120000 } },
                downloadedAs: path.join(dir, 'Inception.2010.ar.srt'),
                candidate: { releaseName: 'Inception.2010.1080p.BluRay' },
                attempts: [{ source: 'yifysubtitles', outcome: 'downloaded', language: 'ar' }],
                tried: [{ provider: 'yifysubtitles', language: 'ar' }]
            };
        },
        saveSidecar(vPath, lang, prov, cueList) {
            const p = path.join(path.dirname(vPath), `Inception.2010.${lang}.srt`);
            fs.writeFileSync(p, '1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n');
            return p;
        }
    };

    const logs = [];
    const notes = [];
    const res = await processVideo(video, {
        server: fakeServer(),
        embedded: false,
        bazaar: fakeBazaar,
        log: (entry) => logs.push(entry),
        onNote: (n) => notes.push(n)
    });

    assert.strictEqual(res.status, 'branded');
    assert.strictEqual(res.source, 'provider');
    assert.strictEqual(res.provider, 'yifysubtitles');
    assert.strictEqual(logs.length, 1);
    const entry = logs[0];
    assert.strictEqual(entry.action, 'brand-downloaded');
    assert.strictEqual(entry.provider, 'yifysubtitles');
    assert.strictEqual(entry.providerId, 'yifysubtitles');
    assert.strictEqual(entry.sourceLanguage, 'ar');
    assert.ok(entry.downloadedAs && entry.downloadedAs.includes('Inception.2010.ar.srt'));
    assert.ok(entry.fit && entry.fit.cues === 10);
    assert.ok(Array.isArray(entry.attempts));
    assert.ok(notes.some((n) => n.startsWith('[Fetch] Inception.2010.mkv → yifysubtitles:')));
});

test('processVideo populates attempts in skip log when bazaar finds nothing', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'empty.mkv');
    fs.writeFileSync(video, 'fake');

    const fakeBazaar = {
        async acquire() {
            return {
                ok: false,
                tried: [{ provider: 'yifysubtitles' }, { provider: 'subf2m' }],
                attempts: [
                    { source: 'yifysubtitles', outcome: 'rejected', reason: 'no-subtitle-in-payload' },
                    { source: 'subf2m', outcome: 'failed', reason: 'HTTP 404' }
                ],
                notes: ['nothing usable']
            };
        },
        saveSidecar() { return null; }
    };

    const logs = [];
    const res = await processVideo(video, {
        server: fakeServer(),
        embedded: false,
        audio: false,
        bazaar: fakeBazaar,
        log: (entry) => logs.push(entry)
    });

    assert.strictEqual(res.status, 'skipped');
    assert.strictEqual(logs.length, 1);
    const entry = logs[0];
    assert.strictEqual(entry.action, 'skip');
    assert.ok(Array.isArray(entry.attempts));
    assert.strictEqual(entry.attempts.length, 2);
});

// ── 5. Font Embedding in ASS ─────────────────────────────────────────────────

test('ass.embedFont uuencodes font buffer into [Fonts] section', () => {
    const fontBuf = Buffer.from('TEST_FONT_DATA_BYTES');
    const encoded = embedFont('CustomFont.ttf', fontBuf);
    assert.ok(encoded.startsWith('[Fonts]\nfontname: CustomFont.ttf\n'));
    assert.ok(uuencodeFont(fontBuf).length > 0);
});
