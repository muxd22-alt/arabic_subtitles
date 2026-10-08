const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.ARABIC_SUBS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'arabicsubs-home-'));
const config = require('../src/config.js');
const { modelStatus, whisperStatus, downloadFile } = require('../src/model.js');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'arabicsubs-dl-'));
}

function serve(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

test('modelStatus reports missing when no file exists', () => {
    const status = modelStatus();
    assert.ok(['missing', 'partial', 'ready'].includes(status.state));
    if (status.state === 'missing') assert.strictEqual(status.bytes, 0);
});

test('modelStatus reports partial for a short file', () => {
    const shortPath = path.join(tmpDir(), 'short.gguf');
    fs.writeFileSync(shortPath, Buffer.alloc(1024));
    const prev = process.env.HYMT2_MODEL;
    process.env.HYMT2_MODEL = shortPath;
    delete require.cache[require.resolve('../src/config.js')];
    delete require.cache[require.resolve('../src/model.js')];
    const cfg = require('../src/config.js');
    const mod = require('../src/model.js');
    const status = mod.modelStatus();
    assert.strictEqual(status.state, 'partial');
    assert.strictEqual(status.bytes, 1024);
    assert.strictEqual(status.total, cfg.MODEL_BYTES);

    process.env.HYMT2_MODEL = prev;
    if (prev === undefined) delete process.env.HYMT2_MODEL;
    delete require.cache[require.resolve('../src/config.js')];
    delete require.cache[require.resolve('../src/model.js')];
});

test('whisperStatus reports missing/ready', () => {
    const status = whisperStatus();
    assert.ok(['missing', 'ready'].includes(status.state));
});

test('downloadFile fetches a full file with progress', async () => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const { server, port } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Length': payload.length });
        res.end(payload);
    });

    const dest = path.join(tmpDir(), 'model.gguf');
    const progress = [];
    await downloadFile(`http://127.0.0.1:${port}/model.gguf`, dest, {
        totalBytes: payload.length,
        onProgress: (received, total) => progress.push([received, total])
    });

    const stat = fs.statSync(dest);
    assert.strictEqual(stat.size, payload.length);
    assert.ok(progress.length > 0);
    assert.strictEqual(progress[progress.length - 1][0], payload.length);
    server.close();
});

test('downloadFile resumes a partial file via a Range request', async () => {
    const payload = Buffer.alloc(32 * 1024, 3);
    const seenRange = { value: null };
    const { server, port } = await serve((req, res) => {
        if (req.headers.range) {
            seenRange.value = req.headers.range;
            const start = Number(req.headers.range.replace('bytes=', '').replace('-', ''));
            const slice = payload.slice(start);
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
                'Content-Length': slice.length
            });
            res.end(slice);
        } else {
            res.writeHead(200, { 'Content-Length': payload.length });
            res.end(payload);
        }
    });

    const dest = path.join(tmpDir(), 'resume.gguf');
    fs.writeFileSync(`${dest}.part`, payload.slice(0, 10000));

    await downloadFile(`http://127.0.0.1:${port}/resume.gguf`, dest, {
        totalBytes: payload.length
    });

    assert.strictEqual(seenRange.value, 'bytes=10000-');
    assert.strictEqual(fs.statSync(dest).size, payload.length);
    assert.strictEqual(fs.existsSync(`${dest}.part`), false);
    server.close();
});

test('downloadFile rejects when the download is incomplete', async () => {
    const { server, port } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Length': 1000 });
        res.end(Buffer.alloc(10));
    });

    const dest = path.join(tmpDir(), 'short.gguf');
    await assert.rejects(
        () => downloadFile(`http://127.0.0.1:${port}/short.gguf`, dest, { totalBytes: 1000 }),
        /incomplete download/
    );
    server.close();
});

test('downloadFile follows redirects', async () => {
    const payload = Buffer.from('final payload');
    let targetPort = 0;
    const { server: target, port: tp } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Length': payload.length });
        res.end(payload);
    });
    targetPort = tp;

    const { server: front, port: fp } = await serve((req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/file` });
        res.end();
    });

    const dest = path.join(tmpDir(), 'redirected.gguf');
    await downloadFile(`http://127.0.0.1:${fp}/file`, dest, {});
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'final payload');

    front.close();
    target.close();
});
