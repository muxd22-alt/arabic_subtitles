const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSubtitle, localCandidates, TMP_DIR_NAME } = require('../subtitle-finder.js');
const { QuotaExceededError } = require('../opensubtitles.js');
const { computeOsHash } = require('../opensubtitles.js');

const EN_SRT = `1
00:00:01,000 --> 00:00:03,000
We need to leave before sunrise.

2
00:00:04,000 --> 00:00:06,000
You said we had time.

3
00:00:07,000 --> 00:00:09,000
I was wrong about the storm.

4
00:00:10,000 --> 00:00:12,000
Grab the radio and follow me.

5
00:00:13,000 --> 00:00:15,000
And if we get separated?

6
00:00:16,000 --> 00:00:18,000
Head for the bridge.`;

const AR_SRT = `1
00:00:01,000 --> 00:00:03,000
يجب أن نغادر قبل شروق الشمس.

2
00:00:04,000 --> 00:00:06,000
قلتَ إن لدينا وقتاً.

3
00:00:07,000 --> 00:00:09,000
كنتُ مخطئاً بشأن العاصفة.

4
00:00:10,000 --> 00:00:12,000
خذ الراديو واتبعني.

5
00:00:13,000 --> 00:00:15,000
وإذا انفصلنا؟

6
00:00:16,000 --> 00:00:18,000
توجه إلى الجسر.`;

const VIDEO = 'Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv';

function makeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-finder-'));
    process.env.SUBARABIFY_DECISION_LOG = path.join(dir, 'decisions.jsonl');
    return dir;
}

function makeVideo(dir, name = VIDEO) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(140000, 1));
    return file;
}

function noopClient() {
    return {
        enabled: () => true,
        search: async () => { throw new Error('remote should not be consulted'); },
        downloadSubtitle: async () => { throw new Error('remote should not be consulted'); }
    };
}

test('finds a ready-made local Arabic subtitle first', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.ar.srt`), AR_SRT, 'utf8');

    const result = await findSubtitle(video, { durationMs: null, client: noopClient() });
    assert.equal(result.status, 'found');
    assert.equal(result.language, 'ar');
    assert.equal(result.source, 'local');
    assert.equal(result.match, 'local');
    assert.equal(result.path, path.join(dir, `${base}.ar.srt`));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('uses a local English subtitle when no Arabic exists', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.srt`), EN_SRT, 'utf8');

    const result = await findSubtitle(video, { durationMs: null, client: noopClient() });
    assert.equal(result.status, 'found');
    assert.equal(result.language, 'en');
    assert.equal(result.source, 'local');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Arabic outranks English when both are present locally', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.srt`), EN_SRT, 'utf8');
    fs.writeFileSync(path.join(dir, `${base}.ar.srt`), AR_SRT, 'utf8');

    const result = await findSubtitle(video, { durationMs: null, client: noopClient() });
    assert.equal(result.language, 'ar');
    assert.ok(result.path.endsWith('.ar.srt'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('classifies a mislabeled Arabic subtitle by content, not file name', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.srt`), AR_SRT, 'utf8');

    const result = await findSubtitle(video, { durationMs: null, client: noopClient() });
    assert.equal(result.language, 'ar');
    assert.equal(result.source, 'local');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('ignores its own previous output and cache files', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.SubArabify.ar.srt`), AR_SRT, 'utf8');
    fs.mkdirSync(path.join(dir, TMP_DIR_NAME));
    fs.writeFileSync(path.join(dir, TMP_DIR_NAME, `${base}.os.ar.srt`), AR_SRT, 'utf8');

    const result = await findSubtitle(video, { durationMs: null, client: noopClient(), remote: false });
    assert.equal(result.status, 'not_found');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('remote search starts with moviehash for Arabic', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const calls = [];
    const client = {
        enabled: () => true,
        search: async (params) => {
            calls.push(params);
            return {
                totalCount: 1,
                results: [{
                    fileId: 777,
                    language: 'ar',
                    downloadCount: 500,
                    title: 'Interstellar',
                    year: 2014,
                    moviehashMatch: true,
                    machineTranslated: false,
                    hearingImpaired: false
                }]
            };
        },
        downloadSubtitle: async (fileId) => {
            assert.equal(fileId, 777);
            return { content: Buffer.from(AR_SRT, 'utf8'), remaining: 18, fileName: 'x.srt' };
        }
    };

    const result = await findSubtitle(video, { durationMs: null, client });
    assert.equal(result.status, 'found');
    assert.equal(result.language, 'ar');
    assert.equal(result.source, 'opensubtitles');
    assert.equal(result.match, 'hash');
    assert.equal(result.provider, 'opensubtitles');
    assert.equal(calls[0].moviehash, await computeOsHash(video));
    assert.equal(calls[0].languages, 'ar');
    assert.ok(fs.existsSync(result.path));
    assert.ok(result.path.includes(TMP_DIR_NAME));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('falls back to title+year search when the hash finds nothing', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const calls = [];
    const client = {
        enabled: () => true,
        search: async (params) => {
            calls.push(params);
            if (params.moviehash) return { totalCount: 0, results: [] };
            return {
                totalCount: 1,
                results: [{
                    fileId: 888,
                    language: 'ar',
                    downloadCount: 42,
                    title: 'Interstellar',
                    year: 2014,
                    moviehashMatch: false,
                    machineTranslated: false,
                    hearingImpaired: false
                }]
            };
        },
        downloadSubtitle: async () => ({ content: Buffer.from(AR_SRT, 'utf8'), remaining: 17, fileName: 'x.srt' })
    };

    const result = await findSubtitle(video, { durationMs: null, client });
    assert.equal(result.status, 'found');
    assert.equal(result.match, 'title');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].query, 'Interstellar');
    assert.equal(calls[1].year, 2014);
    assert.equal(calls[1].type, 'movie');
    assert.equal(calls[1].languages, 'ar');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a downloaded payload that is not a real subtitle', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const client = {
        enabled: () => true,
        search: async () => ({
            totalCount: 1,
            results: [{ fileId: 1, language: 'ar', downloadCount: 10, moviehashMatch: false, machineTranslated: false, hearingImpaired: false }]
        }),
        downloadSubtitle: async () => ({ content: Buffer.from('<html>Access denied</html>', 'utf8'), remaining: 16, fileName: 'x.srt' })
    };

    const result = await findSubtitle(video, { durationMs: null, client });
    assert.equal(result.status, 'not_found');
    const invalid = result.decisions.filter((d) => d.result === 'invalid');
    assert.ok(invalid.length > 0, 'expected an invalid-download decision');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('quota exhaustion aborts remote search but not the run', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const client = {
        enabled: () => true,
        search: async () => ({
            totalCount: 1,
            results: [{ fileId: 2, language: 'ar', downloadCount: 10, moviehashMatch: false, machineTranslated: false, hearingImpaired: false }]
        }),
        downloadSubtitle: async () => { throw new QuotaExceededError('You have downloaded your allowed 20 subtitles for 24h'); }
    };

    const result = await findSubtitle(video, { durationMs: null, client });
    assert.equal(result.status, 'not_found');
    assert.ok(result.decisions.some((d) => d.result === 'aborted'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('skips remote search gracefully without an API key', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const client = { enabled: () => false };

    const result = await findSubtitle(video, { durationMs: null, client });
    assert.equal(result.status, 'not_found');
    assert.ok(result.decisions.some((d) => d.step === 'remote' && d.result === 'skipped'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('every decision is appended to the JSONL log', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const logPath = path.join(dir, 'decisions.jsonl');
    process.env.SUBARABIFY_DECISION_LOG = logPath;

    const client = { enabled: () => false };
    await findSubtitle(video, { durationMs: null, client });

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 1);
    lines.forEach((line) => {
        const entry = JSON.parse(line);
        assert.ok(entry.ts);
        assert.equal(entry.file, video);
        assert.ok('result' in entry || 'step' in entry);
    });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('localCandidates prefers Arabic suffixes then English names', () => {
    const dir = makeDir();
    const base = 'Movie.2020.1080p.mkv';
    fs.writeFileSync(path.join(dir, 'Movie.2020.1080p.ar.srt'), AR_SRT, 'utf8');
    fs.writeFileSync(path.join(dir, 'Movie.2020.1080p.srt'), EN_SRT, 'utf8');
    fs.writeFileSync(path.join(dir, 'eng.srt'), EN_SRT, 'utf8');

    const ar = localCandidates(dir, 'Movie.2020.1080p', 'ar');
    assert.ok(ar[0].endsWith('Movie.2020.1080p.ar.srt'));

    const en = localCandidates(dir, 'Movie.2020.1080p', 'en');
    assert.ok(en[0].endsWith('Movie.2020.1080p.srt'));
    assert.ok(en.some((p) => p.endsWith('eng.srt')));
    fs.rmSync(dir, { recursive: true, force: true });
});
