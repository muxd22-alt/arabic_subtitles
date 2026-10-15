const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, main } = require('../bin/arabic-subs.js');
const { parseNumbered, LlamaServer } = require('../src/llama.js');
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

test('the model is a standard quant any llama.cpp build can read', () => {
    const config = require('../src/config.js');
    // The 1.25-bit STQ1_0 and 2-bit Stride16 GGUFs are gated behind unmerged
    // llama.cpp PRs and abort with a tensor offset mismatch. We ship Q4_K_M.
    assert.match(config.MODEL_URL, /tencent\/Hy-MT2-1\.8B-GGUF/);
    assert.match(config.MODEL_FILE, /Q4_K_M/);
    assert.strictEqual(config.MODEL_BYTES, 1133080448);
    assert.doesNotMatch(config.MODEL_URL, /1\.25bit|2bit/);
});

test('model flavours expose the standard quant and the STQ alternative', () => {
    const config = require('../src/config.js');
    assert.strictEqual(config.MODEL_FLAVOR, 'q4_k_m');
    assert.strictEqual(config.MODEL_ENGINE, 'stock');

    const stq = config.resolveModel('stq');
    assert.match(stq.url, /Hy-MT1\.5-1\.8B-1\.25bit-GGUF/);
    assert.strictEqual(stq.engine, 'stq');
    assert.strictEqual(stq.bytes, 461860704);

    const q8 = config.resolveModel('q8_0');
    assert.match(q8.file, /Q8_0/);
    assert.strictEqual(q8.engine, 'stock');

    // an unknown flavour falls back to the active one
    assert.strictEqual(config.resolveModel('nope').flavor, config.MODEL_FLAVOR);
});

test('the engine is allowed to work on several videos at once', () => {
    const config = require('../src/config.js');
    assert.ok(config.JOB_CONCURRENCY >= 1);
    // llama-server must expose at least as many slots as one video issues
    assert.ok(config.LLAMA_PARALLEL >= config.CONCURRENCY);

    const llama = fs.readFileSync(path.join(__dirname, '..', 'src', 'llama.js'), 'utf8');
    assert.match(llama, /config\.LLAMA_PARALLEL/);

    const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'arabic-subs.js'), 'utf8');
    assert.match(bin, /concurrency: config\.JOB_CONCURRENCY/);
});

test('setup and run fetch the translation and whisper models at the same time', () => {
    const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'arabic-subs.js'), 'utf8');
    // both models are handed to one concurrent batch — not awaited one after the other
    assert.match(bin, /function runDownloads/);
    assert.match(bin, /Promise\.all\(specs\.map/);
    // cmdSetup queues both specs before the batch, so they download together
    assert.match(bin, /specs\.push\(\{ label: '\[Model\]'/);
    assert.match(bin, /specs\.push\(\{ label: '\[Whisper\]'/);
});

test('multiProgress tracks several downloads and stops cleanly', () => {
    const { multiProgress } = require('../bin/arabic-subs.js');
    const progress = multiProgress();
    const model = progress.track('[Model]');
    const whisper = progress.track('[Whisper]');
    model(1, 4);
    whisper(2, 4);
    model(4, 4);
    whisper(4, 4);
    // the tracked updater is a plain callback — calling it must never throw
    assert.strictEqual(typeof model, 'function');
    progress.stop();
});

test('setup-termux.sh keeps a source build available as a fallback', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-termux.sh'), 'utf8');
    // the shipped standard quant builds from mainline; the STQ fork is only the
    // opt-in alternative flavour (HYMT_MODEL_FLAVOR=stq)
    assert.match(sh, /github\.com\/ggml-org\/llama\.cpp/);
    assert.match(sh, /sjl623\/llama\.cpp/);
    assert.match(sh, /STQ_0/);
    assert.match(sh, /ARABIC_SUBS_FORCE_LLAMA_BUILD/);
    assert.match(sh, /llama-engine\.sha/);
    // setup ships its own verified engine; it never installs the Termux package
    assert.doesNotMatch(sh, /pkg install -y llama-cpp/);
});

test('setup-termux.sh prefers the prebuilt engine over a phone build', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-termux.sh'), 'utf8');
    // the prebuilt ships from the app release tag (2.2+): pinned hash, overridable
    assert.match(sh, /ARABIC_SUBS_PREBUILT_TAG:-v2\.2/);
    assert.match(sh, /arabic-subs-engine-android-arm64\.zip/);
    assert.match(sh, /ARABIC_SUBS_PREBUILT_URL/);
    assert.match(sh, /ARABIC_SUBS_PREBUILT_SHA256/);
    assert.match(sh, /ARABIC_SUBS_PREBUILT_DIR/);
    assert.match(sh, /42585d0b08b9156f28f06f9571f978b4d7fb1cba6f3763d7d37663b979e0756c/);
    // the archive is verified and the binary smoke-tested before it is trusted:
    // --version is the same probe that caught the broken engine on the phone
    assert.match(sh, /sha256_of/);
    assert.match(sh, /llama-cli" --version/);
    // the source build survives as a fallback, not as the first choice
    assert.match(sh, /if install_llama_prebuilt; then[\s\S]*build_llama_from_source/);
});

test('run offers the prebuilt engine install instead of a 15-40 minute build', () => {
    const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'arabic-subs.js'), 'utf8');
    assert.match(bin, /offerEngineInstall/);
    assert.match(bin, /modelStatus\(\)\.state === 'ready'/);
    // a forced phone build stays available, but not as what the engine asks for
    assert.match(bin, /ARABIC_SUBS_FORCE_LLAMA_BUILD/);
    assert.doesNotMatch(bin, /Run the full setup now \(repairs cmake, builds llama-server/);
    // installing the Termux package would produce a binary that cannot load the model
    assert.doesNotMatch(bin, /pkg install -y llama-cpp/);
});

test('findLlamaServer also looks in the prebuilt directory', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'binaries.js'), 'utf8');
    assert.match(src, /\.arabic-subs\/engine/);
    assert.match(src, /llama-stq/);
});

test('the prebuilt archive carries whisper-cli, so the one-liner compiles nothing', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-termux.sh'), 'utf8');
    assert.match(sh, /whisper-cli.*\$PREFIX\/bin\/whisper-cli|symlink to whisper-cli/);
    assert.match(sh, /whisper-cli/);
    // whisper's source build is explicitly labelled as the fallback path
    assert.match(sh, /building whisper from source/);
});

test('LlamaServer reports how the process died at startup', async () => {
    // a stand-in binary that rejects the llama flags and exits nonzero
    const server = new LlamaServer({ bin: process.execPath, modelPath: 'no-such-model.gguf', port: 1 });
    await assert.rejects(
        () => server.start({ startupTimeoutMs: 10000 }),
        /exited during startup[\s\S]*exited with code/
    );
});
