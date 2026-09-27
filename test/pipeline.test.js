const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    processVideoFile,
    setSubtitleFinder,
    findSubtitle,
    identifyMovie
} = require('../subarabify.js');
const { WATERMARK_TEXT, parseSRT } = require('../srt-utils.js');

const EN_SRT = `1
00:00:01,000 --> 00:00:03,000
We need to leave before sunrise.

2
00:00:04,000 --> 00:00:06,000
You said we had time.`;

const AR_SRT = `1
00:00:01,000 --> 00:00:03,000
يجب أن نغادر قبل شروق الشمس.

2
00:00:04,000 --> 00:00:06,000
قلتَ إن لدينا وقتاً.`;

const VIDEO = 'Zombieland.2009.720p.BluRay.x264-REFINE.mkv';

function makeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-pipeline-'));
    process.env.SUBARABIFY_DECISION_LOG = path.join(dir, 'decisions.jsonl');
    return dir;
}

function makeVideo(dir) {
    const file = path.join(dir, VIDEO);
    fs.writeFileSync(file, Buffer.alloc(140000, 2));
    return file;
}

function readDecisions(dir) {
    const p = path.join(dir, 'decisions.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function restoreHooks() {
    setSubtitleFinder(findSubtitle);
}

test('an existing branded output is skipped without touching the finder', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.SubArabify.ar.srt`), AR_SRT, 'utf8');

    let finderCalled = false;
    setSubtitleFinder(async () => { finderCalled = true; return null; });

    await processVideoFile(video);
    assert.equal(finderCalled, false);
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('ready-made Arabic subtitle is branded and never translated (real finder)', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.ar.srt`), AR_SRT, 'utf8');

    setSubtitleFinder(findSubtitle); // real finder: local Arabic short-circuits before any network use

    await processVideoFile(video);

    const outPath = path.join(dir, `${base}.SubArabify.ar.srt`);
    assert.ok(fs.existsSync(outPath), 'branded output should exist');
    const out = fs.readFileSync(outPath, 'utf8');
    assert.ok(out.includes(WATERMARK_TEXT));
    assert.ok(!out.includes('Puter'), 'watermark must no longer claim Puter.js');
    assert.equal(parseSRT(out).length, 3); // watermark + 2 source cues

    const action = readDecisions(dir).find((d) => d.action === 'brand-arabic');
    assert.ok(action, 'expected a brand-arabic decision');
    assert.equal(action.language, 'ar');
    assert.equal(action.source, 'local');
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('ready-made English subtitle is skipped with a decision (no AI translation)', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    const enPath = path.join(dir, `${base}.srt`);
    fs.writeFileSync(enPath, EN_SRT, 'utf8');

    const outPath = path.join(dir, `${base}.SubArabify.ar.srt`);
    setSubtitleFinder(async () => ({
        status: 'found', language: 'en', source: 'local', match: 'local', provider: null,
        path: enPath, cueCount: 2, movie: identifyMovie(base), hash: '0'.repeat(16), decisions: []
    }));

    await processVideoFile(video);

    assert.ok(!fs.existsSync(outPath), 'English-only videos must produce no output without AI');
    const decision = readDecisions(dir).find((d) => d.action === 'skip-english');
    assert.ok(decision, 'expected a skip-english decision');
    assert.equal(decision.language, 'en');
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('no ready-made subtitle anywhere produces no output and logs it', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');

    setSubtitleFinder(async () => ({
        status: 'not_found', language: null, source: null, match: null, provider: null,
        path: null, movie: identifyMovie(base), hash: '0'.repeat(16), decisions: []
    }));

    await processVideoFile(video);

    assert.ok(!fs.existsSync(path.join(dir, `${base}.SubArabify.ar.srt`)), 'no audio fallback anymore');
    assert.ok(readDecisions(dir).some((d) => d.action === 'no-subtitle'));
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a broken finder still degrades gracefully (no crash, no output)', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);

    setSubtitleFinder(async () => { throw new Error('provider exploded'); });

    await processVideoFile(video);
    assert.ok(!fs.existsSync(path.join(dir, `${path.basename(video, '.mkv')}.SubArabify.ar.srt`)));

    const decisions = readDecisions(dir);
    assert.ok(decisions.some((d) => d.action === 'finder-error'));
    assert.ok(decisions.some((d) => d.action === 'no-subtitle'));
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});
