const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, main } = require('../bin/arabic-subs.js');
const { parseNumbered } = require('../src/llama.js');
const { planChunks } = require('../src/audio.js');
const { mergeChunkCues } = require('../src/asr.js');
const { startStatusServer } = require('../src/status-server.js');
const { msToTime } = require('../src/srt.js');

test('parseArgs handles flags with and without values', () => {
    const args = parseArgs(['run', '--media', '/sdcard/Movies', '--verbose', '--limit', '5']);
    assert.deepStrictEqual(args._, ['run']);
    assert.strictEqual(args.flags.media, '/sdcard/Movies');
    assert.strictEqual(args.flags.verbose, true);
    assert.strictEqual(args.flags.limit, '5');
});

test('parseArgs collects repeated positional args', () => {
    const args = parseArgs(['translate', 'a.srt', 'b.srt']);
    assert.deepStrictEqual(args._, ['translate', 'a.srt', 'b.srt']);
});

test('main help returns 0', async () => {
    const code = await main(['help']);
    assert.strictEqual(code, 0);
});

test('main rejects an unknown command', async () => {
    const code = await main(['frobnicate']);
    assert.strictEqual(code, 1);
});

test('parseNumbered restores numbering', () => {
    const out = parseNumbered('1. مرحبا\n2. عالم', 2, ['Hello', 'World']);
    assert.deepStrictEqual(out, ['مرحبا', 'عالم']);
});

test('parseNumbered accepts punctuation variants', () => {
    const out = parseNumbered('1) one\n2: two\n3 - three', 3, ['a', 'b', 'c']);
    assert.deepStrictEqual(out, ['one', 'two', 'three']);
});

test('parseNumbered falls back to a bare list', () => {
    const out = parseNumbered('alpha\nbeta', 2, ['x', 'y']);
    assert.deepStrictEqual(out, ['alpha', 'beta']);
});

test('parseNumbered keeps originals for missing lines', () => {
    const out = parseNumbered('1. فقط الأولى', 3, ['a', 'b', 'c']);
    assert.strictEqual(out[0], 'فقط الأولى');
    assert.strictEqual(out[1], 'b');
    assert.strictEqual(out[2], 'c');
});

test('planChunks covers the full timeline with overlap', () => {
    const chunkMs = 10000;
    const overlap = 1000;
    const chunks = planChunks(25000, chunkMs, overlap);

    assert.strictEqual(chunks[0].startMs, 0);
    assert.strictEqual(chunks[0].endMs, 10000);
    assert.strictEqual(chunks[1].startMs, 9000);
    assert.strictEqual(chunks[chunks.length - 1].endMs, 25000);
    for (let i = 1; i < chunks.length; i++) {
        assert.ok(chunks[i].startMs < chunks[i - 1].endMs, 'chunks must overlap');
        assert.ok(chunks[i].endMs > chunks[i - 1].startMs);
    }
});

test('planChunks for a short clip returns a single chunk', () => {
    const chunks = planChunks(3000);
    assert.strictEqual(chunks.length, 1);
    assert.deepStrictEqual(chunks[0], { index: 0, startMs: 0, endMs: 3000 });
});

test('planChunks handles zero/unknown duration', () => {
    assert.deepStrictEqual(planChunks(0), []);
    assert.deepStrictEqual(planChunks(null), []);
});

test('mergeChunkCues offsets timestamps and drops overlap duplicates', () => {
    const chunks = [
        { index: 0, startMs: 0, endMs: 10000 },
        { index: 1, startMs: 9000, endMs: 20000 }
    ];

    const chunk0 = [
        { index: '1', start: '00:00:01,000', end: '00:00:02,000', text: 'first' },
        { index: '2', start: '00:00:09,700', end: '00:00:09,900', text: 'late' }
    ];
    const out0 = mergeChunkCues(chunks[0], chunk0, chunks, false);
    // chunk 0 owns [0, 9000): 'first' stays, 'late' (mid 9700) is chunk 1's
    assert.strictEqual(out0.length, 1);
    assert.strictEqual(out0[0].start, msToTime(1000));
    assert.strictEqual(out0[0].text, 'first');

    const chunk1 = [
        { index: '1', start: '00:00:00,100', end: '00:00:00,400', text: 'overlap' },
        { index: '2', start: '00:00:00,700', end: '00:00:00,900', text: 'late' },
        { index: '3', start: '00:00:05,000', end: '00:00:06,000', text: 'second' }
    ];
    const out1 = mergeChunkCues(chunks[1], chunk1, chunks, true);
    // chunk 1 owns [9000, 20000): absorbs the overlap region plus the tail
    assert.strictEqual(out1.length, 3);
    assert.strictEqual(out1[0].start, msToTime(9100));
    assert.strictEqual(out1[1].text, 'late');
    assert.strictEqual(out1[1].start, msToTime(9700));
    assert.strictEqual(out1[2].text, 'second');
});

test('status-server serves /health and /status', async () => {
    const handle = await startStatusServer(() => ({ engine: 'running', queue: { done: 2 } }), { port: 0 });
    const base = `http://127.0.0.1:${handle.port}`;

    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.strictEqual(health.ok, true);

    const status = await fetch(`${base}/status`).then((r) => r.json());
    assert.strictEqual(status.engine, 'running');
    assert.strictEqual(status.queue.done, 2);
    assert.ok(status.version);

    const missing = await fetch(`${base}/nope`);
    assert.strictEqual(missing.status, 404);

    await handle.close();
});
