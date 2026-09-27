const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    processVideoFile,
    setSubtitleFinder,
    setSrtTranslator,
    setAudioTranscriber,
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

function restoreHooks() {
    setSubtitleFinder(findSubtitle);
    setSrtTranslator(null);
    setAudioTranscriber(null);
}

test('an existing branded output is skipped without touching the finder', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    fs.writeFileSync(path.join(dir, `${base}.SubArabify.ar.srt`), AR_SRT, 'utf8');

    let finderCalled = false;
    setSubtitleFinder(async () => { finderCalled = true; return null; });
    setSrtTranslator(async () => { throw new Error('translator must not run'); });
    setAudioTranscriber(async () => { throw new Error('transcriber must not run'); });

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
    setSrtTranslator(async () => { throw new Error('translator must not run'); });
    setAudioTranscriber(async () => { throw new Error('transcriber must not run'); });

    await processVideoFile(video);

    const outPath = path.join(dir, `${base}.SubArabify.ar.srt`);
    assert.ok(fs.existsSync(outPath), 'branded output should exist');
    const out = fs.readFileSync(outPath, 'utf8');
    assert.ok(out.includes(WATERMARK_TEXT));
    assert.equal(parseSRT(out).length, 3); // watermark + 2 source cues

    const decisions = fs.readFileSync(process.env.SUBARABIFY_DECISION_LOG, 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
    const action = decisions.find((d) => d.action === 'brand-arabic');
    assert.ok(action, 'expected a brand-arabic decision');
    assert.equal(action.language, 'ar');
    assert.equal(action.source, 'local');
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('ready-made English subtitle is handed to the translator', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');
    const enPath = path.join(dir, `${base}.srt`);
    fs.writeFileSync(enPath, EN_SRT, 'utf8');

    const outPath = path.join(dir, `${base}.SubArabify.ar.srt`);
    const translated = [];
    setSubtitleFinder(async () => ({
        status: 'found', language: 'en', source: 'local', match: 'local', provider: null,
        path: enPath, cueCount: 2, movie: identifyMovie(base), hash: '0'.repeat(16), decisions: []
    }));
    setSrtTranslator(async (src, dst) => { translated.push({ src, dst }); fs.writeFileSync(dst, AR_SRT, 'utf8'); });
    setAudioTranscriber(async () => { throw new Error('transcriber must not run'); });

    await processVideoFile(video);

    assert.equal(translated.length, 1);
    assert.equal(translated[0].src, enPath);
    assert.equal(translated[0].dst, outPath);
    assert.ok(fs.existsSync(outPath));
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('no ready-made subtitle anywhere falls back to audio transcription', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);
    const base = path.basename(video, '.mkv');

    const transcribed = [];
    setSubtitleFinder(async () => ({
        status: 'not_found', language: null, source: null, match: null, provider: null,
        path: null, movie: identifyMovie(base), hash: '0'.repeat(16), decisions: []
    }));
    setSrtTranslator(async () => { throw new Error('translator must not run'); });
    setAudioTranscriber(async (src, dst) => { transcribed.push({ src, dst }); });

    await processVideoFile(video);

    assert.equal(transcribed.length, 1);
    assert.equal(transcribed[0].src, video);
    assert.equal(transcribed[0].dst, path.join(dir, `${base}.SubArabify.ar.srt`));

    const decisions = fs.readFileSync(process.env.SUBARABIFY_DECISION_LOG, 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(decisions.some((d) => d.action === 'audio-fallback'));
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a broken finder still degrades to the audio fallback', async () => {
    const dir = makeDir();
    const video = makeVideo(dir);

    const transcribed = [];
    setSubtitleFinder(async () => { throw new Error('provider exploded'); });
    setSrtTranslator(async () => { throw new Error('translator must not run'); });
    setAudioTranscriber(async (src, dst) => { transcribed.push(src); });

    await processVideoFile(video);
    assert.equal(transcribed.length, 1);

    const decisions = fs.readFileSync(process.env.SUBARABIFY_DECISION_LOG, 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(decisions.some((d) => d.action === 'finder-error'));
    assert.ok(decisions.some((d) => d.action === 'audio-fallback'));
    restoreHooks();
    fs.rmSync(dir, { recursive: true, force: true });
});
