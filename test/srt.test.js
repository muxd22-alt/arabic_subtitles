const test = require('node:test');
const assert = require('node:assert');

const {
    WATERMARK_TEXT,
    parseSRT,
    buildSRT,
    timeToMs,
    msToTime,
    normalizeToUtf8,
    arabicRatio,
    looksArabic,
    validateSRT
} = require('../src/srt.js');

const SAMPLE = `1
00:00:01,000 --> 00:00:04,000
Hello there

2
00:00:05,500 --> 00:00:07,000
Second line
with two rows
`;

test('parseSRT reads cues with indices, times and text', () => {
    const cues = parseSRT(SAMPLE);
    assert.strictEqual(cues.length, 2);
    assert.strictEqual(cues[0].index, '1');
    assert.strictEqual(cues[0].start, '00:00:01,000');
    assert.strictEqual(cues[0].end, '00:00:04,000');
    assert.strictEqual(cues[0].text, 'Hello there');
    assert.strictEqual(cues[1].text, 'Second line\nwith two rows');
});

test('parseSRT tolerates BOM, CRLF and dot separators', () => {
    const cues = parseSRT('\uFEFF1\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n\r\n');
    assert.strictEqual(cues.length, 1);
    assert.strictEqual(cues[0].start, '00:00:01,000');
    assert.strictEqual(cues[0].text, 'Hi');
});

test('parseSRT returns [] for junk input', () => {
    assert.deepStrictEqual(parseSRT(''), []);
    assert.deepStrictEqual(parseSRT(null), []);
    assert.deepStrictEqual(parseSRT('<html><body>nope</body></html>'), []);
});

test('buildSRT emits watermark first, then renumbered cues', () => {
    const out = buildSRT(parseSRT(SAMPLE));
    assert.ok(out.includes(WATERMARK_TEXT));
    const cues = parseSRT(out);
    assert.strictEqual(cues.length, 3);
    assert.strictEqual(cues[0].text, WATERMARK_TEXT);
    assert.strictEqual(cues[1].text, 'Hello there');
    assert.strictEqual(cues[1].index, '2');
});

test('timeToMs / msToTime round-trip', () => {
    assert.strictEqual(timeToMs('01:02:03,004'), 3723004);
    assert.strictEqual(timeToMs('00:00:01.500'), 1500);
    assert.strictEqual(msToTime(3723004), '01:02:03,004');
    assert.strictEqual(msToTime(0), '00:00:00,000');
    assert.strictEqual(timeToMs('garbage'), null);
});

test('normalizeToUtf8 handles BOM and utf16', () => {
    assert.strictEqual(normalizeToUtf8(Buffer.from('\uFEFFhi', 'utf8')).text, 'hi');

    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('مرحبا', 'utf16le')]);
    const res = normalizeToUtf8(utf16);
    assert.ok(res.text.includes('مرحبا'));
    assert.strictEqual(res.encoding, 'utf16le-bom');
});

test('normalizeToUtf8 falls back to latin1 for invalid utf-8', () => {
    const bad = Buffer.from([0x68, 0x69, 0xff, 0xfe80 & 0xff]);
    const res = normalizeToUtf8(bad);
    assert.ok(typeof res.text === 'string');
    assert.ok(res.text.startsWith('hi'));
});

test('arabicRatio separates Arabic from Latin', () => {
    assert.ok(arabicRatio('مرحبا بالعالم') >= 0.9);
    assert.ok(arabicRatio('Hello world') <= 0.01);
    assert.strictEqual(arabicRatio(''), 0);
    assert.strictEqual(arabicRatio('123 !!'), 0);
    assert.ok(arabicRatio('Hello مرحبا mix') > 0.3);
});

test('looksArabic threshold', () => {
    assert.ok(looksArabic('أهلاً وسهلاً'));
    assert.ok(!looksArabic('just english'));
});

test('validateSRT accepts a well formed file', () => {
    const res = validateSRT(SAMPLE);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cues.length, 2);
});

test('validateSRT rejects empty/html/short-cue files', () => {
    assert.strictEqual(validateSRT('').ok, false);
    assert.strictEqual(validateSRT('<!DOCTYPE html>').ok, false);
    assert.strictEqual(validateSRT('{"a":1}').ok, false);
    assert.strictEqual(validateSRT('not an srt at all').ok, false);

    const inverted = validateSRT('1\n00:00:05,000 --> 00:00:01,000\nbad\n');
    assert.strictEqual(inverted.ok, false);
    assert.match(inverted.reason, /end <= start/);
});

test('validateSRT checks cue count against runtime duration', () => {
    const tiny = validateSRT(SAMPLE, { durationMs: 7200000 });
    assert.strictEqual(tiny.ok, false);
    assert.match(tiny.reason, /runtime/);

    const ok = validateSRT(SAMPLE, { durationMs: 8000 });
    assert.strictEqual(ok.ok, true);
});
