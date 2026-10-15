const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    outputPathFor,
    listSubtitleSiblings,
    findSubtitleSource,
    isDone,
    translateCues,
    processVideo
} = require('../src/pipeline.js');
const { WATERMARK_TEXT, parseSRT, validateSRT } = require('../src/srt.js');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'arabicsubs-test-'));
}

const EN_SRT = `1
00:00:01,000 --> 00:00:03,000
Hello my friend

2
00:00:04,000 --> 00:00:06,000
How are you today
`;

const AR_SRT = `1
00:00:01,000 --> 00:00:03,000
مرحبا يا صديقي

2
00:00:04,000 --> 00:00:06,000
كيف حالك اليوم
`;

function fakeServer() {
    return {
        async translate(texts) {
            return texts.map((t, i) => `مرحبا رقم ${i} من النص`);
        }
    };
}

test('outputPathFor uses the ArabicSubs suffix', () => {
    const p = outputPathFor('/movies/Show/S01E01.mkv');
    assert.strictEqual(path.basename(p), 'S01E01.ArabicSubs.ar.srt');
});

test('listSubtitleSiblings finds exact and language-tagged matches only', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'movie.mkv'), '');
    fs.writeFileSync(path.join(dir, 'movie.srt'), EN_SRT);
    fs.writeFileSync(path.join(dir, 'movie.en.srt'), EN_SRT);
    fs.writeFileSync(path.join(dir, 'unrelated.srt'), EN_SRT);

    const found = listSubtitleSiblings(path.join(dir, 'movie.mkv')).map((f) => path.basename(f));
    assert.deepStrictEqual(found.sort(), ['movie.en.srt', 'movie.srt'].sort());
});

test('findSubtitleSource classifies arabic vs english', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.mkv'), '');
    fs.writeFileSync(path.join(dir, 'a.srt'), EN_SRT);
    assert.strictEqual(findSubtitleSource(path.join(dir, 'a.mkv')).kind, 'english');

    fs.writeFileSync(path.join(dir, 'b.mkv'), '');
    fs.writeFileSync(path.join(dir, 'b.srt'), AR_SRT);
    assert.strictEqual(findSubtitleSource(path.join(dir, 'b.mkv')).kind, 'arabic');

    fs.writeFileSync(path.join(dir, 'c.mkv'), '');
    assert.strictEqual(findSubtitleSource(path.join(dir, 'c.mkv')).kind, 'none');
});

test('isDone detects an existing output', () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.mkv');
    fs.writeFileSync(video, '');
    assert.strictEqual(isDone(video), false);
    fs.writeFileSync(outputPathFor(video), '1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n');
    assert.strictEqual(isDone(video), true);
});

test('translateCues preserves timings and count', async () => {
    const cues = validateSRT(EN_SRT).cues;
    const { cues: out, stats } = await translateCues(cues, fakeServer());
    assert.strictEqual(out.length, cues.length);
    assert.strictEqual(out[0].start, cues[0].start);
    assert.strictEqual(out[0].end, cues[0].end);
    assert.match(out[0].text, /مرحبا رقم 0/);
    assert.strictEqual(stats.total, 2);
});

test('processVideo skips when the output already exists', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'done.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(outputPathFor(video), '1\n00:00:01,000 --> 00:00:02,000\nx\n');

    const res = await processVideo(video, { audio: false, log: () => { } });
    assert.strictEqual(res.status, 'skipped');
    assert.strictEqual(res.reason, 'existing-output');
});

test('processVideo brands a ready-made Arabic subtitle without the model', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'ar.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(path.join(dir, 'ar.srt'), AR_SRT);

    const logged = [];
    const res = await processVideo(video, { audio: false, log: (e) => logged.push(e) });

    assert.strictEqual(res.status, 'branded');
    assert.ok(fs.existsSync(outputPathFor(video)));
    const out = parseSRT(fs.readFileSync(outputPathFor(video), 'utf8'));
    assert.strictEqual(out[0].text, WATERMARK_TEXT);
    assert.strictEqual(logged[0].action, 'brand-arabic');
});

test('processVideo translates an English subtitle through the fake server', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'en.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(path.join(dir, 'en.srt'), EN_SRT);

    const res = await processVideo(video, {
        audio: false,
        server: fakeServer(),
        log: () => { }
    });

    assert.strictEqual(res.status, 'translated');
    assert.strictEqual(res.cueCount, 2);
    const out = parseSRT(fs.readFileSync(outputPathFor(video), 'utf8'));
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].text, WATERMARK_TEXT);
    assert.match(out[1].text, /مرحبا رقم 0/);
    assert.match(out[2].text, /مرحبا رقم 1/);
});

test('processVideo skips when there is no subtitle and audio is disabled', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'bare.mkv');
    fs.writeFileSync(video, '');

    const res = await processVideo(video, { audio: false, log: () => { } });
    assert.strictEqual(res.status, 'skipped');
    assert.strictEqual(res.reason, 'no-subtitle');
});

test('processVideo fails loudly without a server when translation is needed', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'noserver.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(path.join(dir, 'noserver.srt'), EN_SRT);

    await assert.rejects(
        () => processVideo(video, { audio: false, server: null, log: () => { } }),
        /no llama server/
    );
});

test('processVideo logs a decision for every outcome', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'logged.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(path.join(dir, 'logged.srt'), EN_SRT);

    const logged = [];
    await processVideo(video, { audio: false, server: fakeServer(), log: (e) => logged.push(e) });
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].action, 'translate');
    assert.strictEqual(logged[0].source, 'logged.srt');
});
