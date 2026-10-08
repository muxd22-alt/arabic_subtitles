const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { walkMedia, JobQueue, watchFolder } = require('../src/watcher.js');
const config = require('../src/config.js');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'arabicsubs-watch-'));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

test('walkMedia finds videos recursively, skips hidden and non-video files', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'Season1'));
    fs.mkdirSync(path.join(dir, '.hidden'));
    fs.writeFileSync(path.join(dir, 'a.mp4'), '');
    fs.writeFileSync(path.join(dir, 'Season1', 'e01.mkv'), '');
    fs.writeFileSync(path.join(dir, 'Season1', 'notes.txt'), '');
    fs.writeFileSync(path.join(dir, '.hidden', 'b.mp4'), '');
    fs.writeFileSync(path.join(dir, 'cover.jpg'), '');

    const found = walkMedia(dir).map((f) => path.basename(f)).sort();
    assert.deepStrictEqual(found, ['a.mp4', 'e01.mkv']);
});

test('walkMedia respects a depth limit', () => {
    const dir = tmpDir();
    let deep = dir;
    for (let i = 0; i < 12; i++) {
        deep = path.join(deep, `d${i}`);
    }
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'far.mp4'), '');
    fs.writeFileSync(path.join(dir, 'near.mp4'), '');

    const found = walkMedia(dir, { maxDepth: 3 }).map((f) => path.basename(f));
    assert.deepStrictEqual(found, ['near.mp4']);
});

test('JobQueue processes jobs one at a time in order', async () => {
    const order = [];
    let active = 0;
    let peak = 0;

    const queue = new JobQueue({
        process: async (file) => {
            active++;
            peak = Math.max(peak, active);
            await sleep(10);
            order.push(path.basename(file));
            active--;
            return { status: 'translated' };
        }
    });

    queue.enqueueAll(['/m/a.mp4', '/m/b.mp4', '/m/c.mp4']);
    await sleep(120);

    assert.deepStrictEqual(order, ['a.mp4', 'b.mp4', 'c.mp4']);
    assert.strictEqual(peak, 1);
    const status = queue.status();
    assert.strictEqual(status.done, 3);
    assert.strictEqual(status.pending, 0);
});

test('JobQueue de-duplicates enqueues and records failures', async () => {
    const runs = [];
    const queue = new JobQueue({
        process: async (file) => {
            runs.push(file);
            if (file.includes('bad')) throw new Error('boom');
            return { status: 'ok' };
        }
    });

    queue.enqueue('/m/good.mp4');
    queue.enqueue('/m/good.mp4');
    queue.enqueue('/m/bad.mp4');
    await sleep(80);

    assert.strictEqual(runs.filter((f) => f.includes('good')).length, 1);
    const status = queue.status();
    assert.strictEqual(status.done, 1);
    assert.strictEqual(status.failed, 1);

    // failures are not re-enqueued automatically
    queue.enqueue('/m/bad.mp4');
    await sleep(30);
    assert.strictEqual(runs.filter((f) => f.includes('bad')).length, 1);

    queue.requeueFailures();
    await sleep(60);
    assert.strictEqual(runs.filter((f) => f.includes('bad')).length, 2);
});

test('JobQueue emits lifecycle events', async () => {
    const events = [];
    const queue = new JobQueue({ process: async () => ({ status: 'ok' }) });
    queue.onEvent((e) => events.push(e.type));

    queue.enqueue('/m/x.mp4');
    await sleep(50);

    assert.deepStrictEqual(events, ['enqueue', 'start', 'done']);
});

test('watchFolder enqueues new videos and skips finished ones', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'one.mp4'), '');
    fs.writeFileSync(path.join(dir, 'two.mp4'), '');

    const processed = [];
    const queue = new JobQueue({ process: async (f) => { processed.push(f); return { status: 'ok' }; } });

    const watcher = watchFolder(dir, queue, { intervalMs: 10000 });
    watcher.scanOnce();
    await sleep(40);

    assert.strictEqual(processed.length, 2);

    // a video with an output sidecar is never queued
    fs.writeFileSync(path.join(dir, 'three.mp4'), '');
    fs.writeFileSync(path.join(dir, 'three' + config.OUTPUT_SUFFIX), 'x');
    watcher.scanOnce();
    await sleep(40);
    assert.strictEqual(processed.length, 2);

    watcher.stop();
});
