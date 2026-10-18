const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');

let spawned = [];
cp.spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => { };
    process.nextTick(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('exit', 0);
    });
    return proc;
};

const audio = require('../src/audio.js');
const asr = require('../src/asr.js');

test('extractChunk seeks with -ss BEFORE -i so ffmpeg does not decode from 0:00', async () => {
    spawned = [];
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

test('threadsPerChunk divides the CPU budget across concurrent chunks and never returns 0', () => {
    assert.strictEqual(asr.threadsPerChunk({ threads: 8 }, 2), 4);
    assert.strictEqual(asr.threadsPerChunk({ threads: 8 }, 1), 8);
    assert.strictEqual(asr.threadsPerChunk({ threads: 8 }, 8), 1);
    assert.strictEqual(asr.threadsPerChunk({ threads: 1 }, 4), 1);
    assert.strictEqual(asr.threadsPerChunk({ threads: 2 }, 100), 1);
});
