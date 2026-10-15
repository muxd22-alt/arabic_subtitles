const test = require('node:test');
const assert = require('node:assert');

const { batchTexts, mapPool, translateTexts, looksTranslated } = require('../src/translate.js');

test('batchTexts respects maxLines', () => {
    const texts = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const batches = batchTexts(texts, { maxLines: 4, maxChars: 100000 });
    assert.deepStrictEqual(batches.map((b) => b.length), [4, 4, 2]);
});

test('batchTexts respects maxChars', () => {
    const texts = ['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(400)];
    const batches = batchTexts(texts, { maxLines: 16, maxChars: 800 });
    assert.deepStrictEqual(batches.map((b) => b.length), [2, 1]);
});

test('batchTexts never drops text', () => {
    const texts = Array.from({ length: 37 }, (_, i) => `x${i}`);
    const batches = batchTexts(texts, { maxLines: 5, maxChars: 50 });
    assert.strictEqual(batches.flat().length, 37);
    assert.deepStrictEqual(batches.flat(), texts);
});

test('batchTexts handles empty input', () => {
    assert.deepStrictEqual(batchTexts([]), []);
});

test('mapPool runs everything with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    const results = await mapPool(items, 3, async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return n * 2;
    });

    assert.strictEqual(peak <= 3, true, `peak concurrency was ${peak}`);
    assert.deepStrictEqual(results, items.map((n) => n * 2));
});

test('mapPool preserves order', async () => {
    const items = [5, 4, 3, 2, 1];
    const results = await mapPool(items, 2, async (n) => {
        await new Promise((r) => setTimeout(r, (n % 3) * 5));
        return n;
    });
    assert.deepStrictEqual(results, items);
});

const DICT = {
    Hello: 'مرحبا',
    World: 'عالم',
    'How are you': 'كيف حالك',
    'I am fine': 'أنا بخير',
    'Thank you': 'شكرا لك',
    Goodbye: 'إلى اللقاء'
};

/**
 * Fake llama server: always answers with the dictionary translation of each
 * line it receives, unless a hook says otherwise. Handles any group size,
 * which is what the retry/split logic exercises.
 */
function keyedServer(hook) {
    const state = { calls: 0, received: [] };
    return {
        state,
        async translate(texts) {
            state.calls++;
            state.received.push(texts.slice());
            if (hook) {
                const custom = hook(texts, state.calls);
                if (custom !== undefined) return custom;
            }
            return texts.map((t) => DICT[t] || `ترجمة ${t}`);
        }
    };
}

test('translateTexts returns Arabic for every line', async () => {
    const texts = Object.keys(DICT);
    const server = keyedServer();

    const { texts: out, stats } = await translateTexts(texts, server, { maxLines: 2, concurrency: 2 });

    assert.deepStrictEqual(out, texts.map((t) => DICT[t]));
    assert.strictEqual(stats.total, texts.length);
    assert.strictEqual(stats.keptSource, 0);
    assert.strictEqual(stats.batches, Math.ceil(texts.length / 2));
});

test('translateTexts keeps original order across parallel batches', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const server = keyedServer();

    const { texts: out } = await translateTexts(texts, server, { maxLines: 3, concurrency: 4 });
    assert.deepStrictEqual(out, texts.map((t) => `ترجمة ${t}`));
});

test('translateTexts retries a failing batch then succeeds', async () => {
    const texts = ['Hello', 'World'];
    const server = keyedServer((batch, call) => {
        if (call === 1) throw new Error('boom');
    });

    const { texts: out, stats } = await translateTexts(texts, server, { maxLines: 16, concurrency: 1 });
    assert.deepStrictEqual(out, ['مرحبا', 'عالم']);
    assert.ok(stats.retried >= 1);
});

test('translateTexts falls back to source text when the model keeps failing', async () => {
    const texts = ['Only line'];
    const server = keyedServer(() => { throw new Error('always down'); });

    const { texts: out, stats } = await translateTexts(texts, server, { maxLines: 16, concurrency: 1 });
    assert.deepStrictEqual(out, texts);
    assert.strictEqual(stats.keptSource, 1);
});

test('translateTexts splits oversized batches when the model answers in English', async () => {
    const texts = ['Hello', 'World'];
    const server = keyedServer((batch, call) => {
        if (call === 1) return ['not arabic', 'still not arabic'];
    });

    const { texts: out, stats } = await translateTexts(texts, server, { maxLines: 16, concurrency: 1 });
    assert.deepStrictEqual(out, ['مرحبا', 'عالم']);
    assert.ok(stats.retried >= 1);
});

test('translateTexts reports progress exactly once per line', async () => {
    const texts = Object.keys(DICT);
    const progress = [];
    await translateTexts(texts, keyedServer(), {
        maxLines: 2,
        concurrency: 2,
        onProgress: (p) => progress.push(p)
    });
    const last = progress[progress.length - 1];
    assert.strictEqual(last.done, texts.length);
    assert.strictEqual(last.total, texts.length);
});

test('looksTranslated validates shape and language', () => {
    assert.ok(looksTranslated(['Hello'], ['مرحبا']));
    assert.ok(!looksTranslated(['Hello'], ['Hello']), 'echoed source is rejected');
    assert.ok(!looksTranslated(['Hello'], []), 'wrong length rejected');
    assert.ok(!looksTranslated(['Hello'], ['   ']), 'blank rejected');
    assert.ok(looksTranslated(['1234'], ['1234']), 'numbers pass through');
    assert.ok(!looksTranslated(['   '], ['   ']), 'blank stays blank, never counts as a translation');
    assert.ok(looksTranslated(['...'], ['...']));
});
