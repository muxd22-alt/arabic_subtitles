const test = require('node:test');
const assert = require('node:assert');

const { buildASS, escapeAssText, STYLE_LINE } = require('../src/ass.js');
const { WATERMARK_TEXT } = require('../src/srt.js');

const STYLE = 'Style: Default,Thmanyah Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,40,1';

function dialogues(out) {
    return out.split('\n').filter((line) => line.startsWith('Dialogue:'));
}

test('buildASS emits an ASS v4.00+ header naming Thmanyah Sans', () => {
    const out = buildASS([]);
    assert.match(out, /\[Script Info\]/);
    assert.match(out, /ScriptType: v4\.00\+/);
    assert.match(out, /WrapStyle: 1/);
    assert.match(out, /ScaledBorderAndShadow: yes/);
    assert.match(out, /PlayResX: 1920/);
    assert.match(out, /PlayResY: 1080/);
    assert.match(out, /\[V4\+ Styles\]/);
    assert.ok(out.includes('Thmanyah Sans'));
    assert.ok(out.includes(STYLE));
    assert.strictEqual(STYLE, STYLE_LINE);
    assert.match(out, /\[Events\]/);
});

test('buildASS keeps the watermark as event #1', () => {
    const out = buildASS([{ start: '00:00:05,000', end: '00:00:06,000', text: 'مرحبا' }]);
    const lines = dialogues(out);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].endsWith(WATERMARK_TEXT));
    assert.match(lines[0], /^Dialogue: 0,0:00:01\.00,0:00:04\.00,Default,,0,0,0,,/);
});

test('buildASS renders timestamps as H:MM:SS.cc', () => {
    const out = buildASS([{ start: '01:02:03,456', end: '01:02:05,000', text: 'x' }]);
    const line = dialogues(out)[1];
    assert.match(line, /^Dialogue: 0,1:02:03\.45,1:02:05\.00,Default,,0,0,0,,x$/);
});

test('buildASS turns multi-line cue text into \\N', () => {
    const out = buildASS([{ start: '00:00:01,000', end: '00:00:02,000', text: 'first\nsecond' }]);
    assert.match(dialogues(out)[1], /,first\\Nsecond$/);
});

test('buildASS escapes braces and backslashes so cues cannot inject ASS tags', () => {
    assert.strictEqual(escapeAssText('{\\b1}bold{\\b0}'), '\\{\\\\b1\\}bold\\{\\\\b0\\}');

    const out = buildASS([{ start: '00:00:01,000', end: '00:00:02,000', text: '{\\b1}bold' }]);
    const line = dialogues(out)[1];
    assert.ok(line.endsWith('\\{\\\\b1\\}bold'));
    assert.ok(!line.includes('{\\b1}'));
});

test('buildASS skips unparsable cues instead of emitting broken lines', () => {
    const out = buildASS([
        { start: 'garbage', end: '00:00:02,000', text: 'drop me' },
        { start: '00:00:03,000', end: 'nope', text: 'drop me too' },
        { start: '00:00:04,000', end: '00:00:05,000', text: 'keep me' }
    ]);
    const lines = dialogues(out);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].endsWith('keep me'));
    assert.ok(!out.includes('drop me'));
    assert.match(lines[1], /,0:00:04\.00,0:00:05\.00,Default,,0,0,0,,keep me$/);
});
