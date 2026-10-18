const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let spawned = [];
let responder = () => ({ code: 0, stdout: '', stderr: '' });

cp.spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => { };
    process.nextTick(() => {
        const out = responder(cmd, args) || {};
        if (out.error) {
            proc.emit('error', new Error(out.error));
            return;
        }
        if (out.stdout) proc.stdout.write(out.stdout);
        if (out.stderr) proc.stderr.write(out.stderr);
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('exit', out.code === undefined ? 0 : out.code);
    });
    return proc;
};

const audio = require('../src/audio.js');
const asr = require('../src/asr.js');

function fakeModel() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-model-'));
    const file = path.join(dir, 'ggml-base.bin');
    fs.writeFileSync(file, '');
    return file;
}

test('extractChunk seeks with -ss BEFORE -i so ffmpeg does not decode from 0:00', async () => {
    spawned = [];
    responder = () => ({ code: 0 });
    await audio.extractChunk('/movies/a.mp4', { index: 3, startMs: 900000, endMs: 1200000 }, 'chunk.wav');
    assert.strictEqual(spawned.length, 1);
    const args = spawned[0].args;
    const ss = args.indexOf('-ss');
    const i = args.indexOf('-i');
    assert.ok(ss !== -1, '-ss present');
    assert.ok(i !== -1, '-i present');
    assert.ok(ss < i, '-ss must come before -i');
    assert.ok(args.includes('-nostdin'), '-nostdin present so ffmpeg never waits on stdin');
    assert.strictEqual(args[args.indexOf('-t') + 1], '300.000');
});

test('extractChunk with endMs === null extracts the whole file (no -ss/-t)', async () => {
    spawned = [];
    responder = () => ({ code: 0 });
    await audio.extractChunk('/movies/a.mkv', { index: 0, startMs: 0, endMs: null }, 'whole.wav');
    assert.strictEqual(spawned.length, 1);
    const args = spawned[0].args;
    assert.ok(!args.includes('-ss'), 'no -ss when extracting the whole file');
    assert.ok(!args.includes('-t'), 'no -t when extracting the whole file');
    assert.strictEqual(args[args.indexOf('-i') + 1], '/movies/a.mkv');
    assert.strictEqual(args[args.length - 1], 'whole.wav');
});

test('threadsPerChunk divides the CPU budget across concurrent chunks and never returns 0', () => {
    assert.strictEqual(asr.threadsPerChunk({ threads: 8 }, 2), 4);
    assert.strictEqual(asr.threadsPerChunk({ threads: 8 }, 1), 8);
    assert.strictEqual(asr.threadsPerChunk({ threads: 8 }, 8), 1);
    assert.strictEqual(asr.threadsPerChunk({ threads: 1 }, 4), 1);
    assert.strictEqual(asr.threadsPerChunk({ threads: 2 }, 100), 1);
});

test('probeDurationDetailed: per-stream duration is used when format duration is empty', async () => {
    responder = () => ({ code: 0, stdout: '\nN/A\n5400.000000\n' });
    const r = await audio.probeDurationDetailed('/movies/a.mkv');
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.ms, 5400000);
});

test('probeDurationDetailed: falls back to ffmpeg when ffprobe reports no duration', async () => {
    responder = (cmd, args) => {
        if (args.includes('-show_entries')) return { code: 0, stdout: 'N/A\n' };
        return {
            code: 1,
            stderr: 'ffmpeg version 6.1\n  Duration: 01:02:03.50, start: 0.000000, bitrate: 1234 kb/s\nAt least one output file must be specified\n'
        };
    };
    const r = await audio.probeDurationDetailed('/movies/a.mkv');
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.ms, Math.round((1 * 3600 + 2 * 60 + 3.5) * 1000));
});

test('probeDurationDetailed: reports the failing binary instead of throwing', async () => {
    responder = (cmd, args) => args.includes('-show_entries')
        ? { code: 1, stderr: 'libffprobe.so: cannot open file' }
        : { code: 1, stderr: 'No such file or directory' };
    const r = await audio.probeDurationDetailed('/movies/missing.mkv');
    assert.strictEqual(r.ms, null);
    assert.match(r.error, /cannot open file/);
});

test('probeDurationMs still resolves to a number or null (never rejects)', async () => {
    responder = () => ({ code: 1, stderr: 'boom' });
    assert.strictEqual(await audio.probeDurationMs('/movies/missing.mkv'), null);
});

test('transcribeMedia fails fast with a clear message when the media file is missing', async () => {
    spawned = [];
    await assert.rejects(
        () => asr.transcribeMedia(path.join(os.tmpdir(), 'definitely-missing-xyz.mkv'), {}),
        /media file not found/
    );
    assert.strictEqual(spawned.length, 0, 'no subprocess should be spawned for a missing file');
});

test('transcribeMedia falls back to a single whole-file pass when the duration is unknown', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-whole-'));
    const media = path.join(tmpDir, 'movie.mkv');
    fs.writeFileSync(media, 'not really a movie');
    const seen = { durations: [] };

    responder = (cmd, args) => {
        if (args.includes('-show_entries')) return { code: 1, stderr: 'ffprobe: no duration' };
        if (args.includes('-hide_banner')) return { code: 1, stderr: 'Duration: N/A\nAt least one output file must be specified' };
        if (args.includes('-osrt')) {
            fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.srt`, '1\n00:00:01,000 --> 00:00:02,000\nhello\n');
            return { code: 0 };
        }
        return { code: 0 };
    };

    spawned = [];
    const cues = await asr.transcribeMedia(media, {
        tmpDir,
        bin: path.join(os.tmpdir(), 'fake-whisper'),
        modelPath: fakeModel(),
        onProgress: () => { },
        onDuration: (ms) => seen.durations.push(ms)
    });

    assert.deepStrictEqual(seen.durations, [null], 'unknown duration is reported back as null');
    const extraction = spawned.find((s) => s.args.includes('-nostdin'));
    assert.ok(extraction, 'ffmpeg extraction happened');
    assert.ok(!extraction.args.includes('-ss'), 'whole-file mode does not seek');
    assert.ok(!extraction.args.includes('-t'), 'whole-file mode has no duration limit');
    assert.strictEqual(cues.length, 1);
    assert.strictEqual(cues[0].text, 'hello');
    assert.strictEqual(cues[0].start, '00:00:01,000', 'whole-file cues keep absolute timestamps');
    assert.strictEqual(cues[0].index, '1');
});
