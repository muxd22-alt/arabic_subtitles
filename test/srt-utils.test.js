const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseSRT,
    buildSRT,
    timeToMs,
    msToTime,
    normalizeToUtf8,
    looksArabic,
    validateSRT,
    probeDurationMs,
    WATERMARK_TEXT
} = require('../srt-utils.js');

const EN_SRT = `1
00:00:01,000 --> 00:00:04,000
We need to go, now.

2
00:00:05,500 --> 00:00:08,000
I'm not leaving without her.
Second line of the same cue.`;

const AR_SRT = `1
00:00:01,000 --> 00:00:04,000
يجب أن نذهب الآن.

2
00:00:05,500 --> 00:00:08,000
لن أتركها هنا.`;

test('parseSRT handles indexes, multi-line cues and CRLF', () => {
    const cues = parseSRT(EN_SRT.replace(/\n/g, '\r\n'));
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, '00:00:01,000');
    assert.equal(cues[0].end, '00:00:04,000');
    assert.equal(cues[1].text, "I'm not leaving without her.\nSecond line of the same cue.");
    assert.equal(cues[0].index, '1');
});

test('parseSRT accepts cues without sequence numbers and dot milliseconds', () => {
    const srt = `00:00:01.000 --> 00:00:04.000
Hello

00:00:05,000 --> 00:00:06,000
World`;
    const cues = parseSRT(srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, '00:00:01,000');
    assert.equal(cues[1].text, 'World');
});

test('buildSRT watermarks first and renumbers cues', () => {
    const cues = parseSRT(EN_SRT);
    const built = buildSRT(cues);
    assert.ok(built.includes(WATERMARK_TEXT));
    assert.ok(built.startsWith('1\n00:00:01,000 --> 00:00:04,000\n[ ترجمت'));
    assert.ok(built.includes('\n2\n00:00:01,000 --> 00:00:04,000\nWe need to go, now.'));
    assert.equal(parseSRT(built).length, 3); // watermark + 2 source cues
});

test('timeToMs and msToTime round-trip and reject junk', () => {
    assert.equal(timeToMs('01:02:03,456'), 3723456);
    assert.equal(msToTime(3723456), '01:02:03,456');
    assert.equal(timeToMs('not-a-time'), null);
    assert.equal(timeToMs('1:2:3.500'), 3723500);
});

test('normalizeToUtf8 strips UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('مرحبا', 'utf8')]);
    const out = normalizeToUtf8(buf);
    assert.equal(out.encoding, 'utf8-bom');
    assert.equal(out.text, 'مرحبا');
    assert.ok(!out.text.includes('\uFEFF'));
});

test('normalizeToUtf8 decodes UTF-16 LE and BE', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello', 'utf16le')]);
    const leOut = normalizeToUtf8(le);
    assert.equal(leOut.encoding, 'utf16le-bom');
    assert.equal(leOut.text, 'Hello');

    const beBody = Buffer.from('Hello', 'utf16le');
    beBody.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    const beOut = normalizeToUtf8(be);
    assert.equal(beOut.encoding, 'utf16be-bom');
    assert.equal(beOut.text, 'Hello');
});

test('normalizeToUtf8 falls back to latin1 on invalid utf-8', () => {
    const buf = Buffer.from([0x68, 0x69, 0x20, 0xE9]); // "hi " + é in latin1
    const out = normalizeToUtf8(buf);
    assert.equal(out.encoding, 'latin1-fallback');
    assert.ok(out.warnings.length > 0);
    assert.ok(out.text.startsWith('hi '));
});

test('looksArabic detects Arabic dialogue', () => {
    assert.equal(looksArabic('يجب أن نذهب الآن.'), true);
    assert.equal(looksArabic("I'm not leaving without her."), false);
    assert.equal(looksArabic('يجب أن نذهب الآن. Hello.'), true);      // Arabic-dominant with an English word
    assert.equal(looksArabic('Dialogue with مرحبا mixed in'), false); // English-dominant stays English
    assert.equal(looksArabic(''), false);
});

test('validateSRT accepts a healthy English subtitle', () => {
    const result = validateSRT(EN_SRT, { durationMs: 60000 });
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.equal(result.cues.length, 2);
});

test('validateSRT accepts a healthy Arabic subtitle', () => {
    const result = validateSRT(AR_SRT, { durationMs: 60000 });
    assert.equal(result.ok, true);
});

test('validateSRT rejects HTML/JSON payloads and empty input', () => {
    assert.equal(validateSRT('<html><body>404</body></html>').ok, false);
    assert.equal(validateSRT('{"message":"rate limited"}').ok, false);
    assert.equal(validateSRT('').ok, false);
    assert.equal(validateSRT('just some prose without timestamps').ok, false);
});

test('validateSRT rejects broken timing', () => {
    const backwards = `1
00:00:10,000 --> 00:00:05,000
Backwards cue`;
    assert.equal(validateSRT(backwards).ok, false);

    const garbage = `1
aa:bb:cc,ddd --> 00:00:05,000
Bad stamp`;
    assert.equal(validateSRT(garbage).ok, false);
});

test('validateSRT enforces cue-count sanity against runtime', () => {
    // 2-hour movie with a single cue = transcript dropout, not a subtitle
    assert.equal(validateSRT(EN_SRT, { durationMs: 7200000 }).ok, false);

    // 5-second clip with 2 cues is fine; the same clip with cues far in the future is not
    const farFuture = `1
00:40:00,000 --> 00:40:02,000
Way past the end`;
    assert.equal(validateSRT(farFuture, { durationMs: 5000 }).ok, false);
});

test('validateSRT flags cue flood beyond runtime', () => {
    const cues = [];
    for (let i = 0; i < 40; i++) {
        const start = msToTime(i * 1000);
        const end = msToTime(i * 1000 + 500);
        cues.push(`${i + 1}\n${start} --> ${end}\nline ${i}`);
    }
    const srt = cues.join('\n\n');
    assert.equal(validateSRT(srt, { durationMs: 10000 }).ok, false); // 40 cues for a 10s clip
    assert.equal(validateSRT(srt).ok, true); // no runtime known → still parseable
});

test('probeDurationMs returns null when ffprobe cannot read the file', () => {
    assert.equal(probeDurationMs('/nonexistent/video.mkv'), null);
});
