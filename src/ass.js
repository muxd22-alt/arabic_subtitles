const { WATERMARK_TEXT, timeToMs } = require('./srt.js');

const STYLE_LINE = 'Style: Default,Thmanyah Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,40,1';

const HEADER = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 1',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    STYLE_LINE,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
];

const WATERMARK_START = 1000;
const WATERMARK_END = 4000;

function escapeAssText(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\r\n|\r|\n/g, '\\N');
}

function msToAss(ms) {
    const cs = Math.floor(ms / 10);
    const centis = cs % 100;
    const totalSeconds = Math.floor(cs / 100);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function dialogueLine(startMs, endMs, text) {
    return `Dialogue: 0,${msToAss(startMs)},${msToAss(endMs)},Default,,0,0,0,,${escapeAssText(text)}`;
}

function uuencodeFont(buffer) {
    if (!buffer || buffer.length === 0) return '';
    let out = '';
    let lineLen = 0;
    const len = buffer.length;
    for (let i = 0; i < len; i += 3) {
        const b0 = buffer[i];
        const b1 = i + 1 < len ? buffer[i + 1] : 0;
        const b2 = i + 2 < len ? buffer[i + 2] : 0;

        const c0 = (b0 >> 2) + 33;
        const c1 = (((b0 & 3) << 4) | (b1 >> 4)) + 33;
        const c2 = (((b1 & 15) << 2) | (b2 >> 6)) + 33;
        const c3 = (b2 & 63) + 33;

        out += String.fromCharCode(c0, c1, c2, c3);
        lineLen += 4;
        if (lineLen >= 80) {
            out += '\n';
            lineLen = 0;
        }
    }
    if (lineLen > 0) out += '\n';
    return out;
}

function embedFont(fontName, fontBuffer) {
    if (!fontBuffer || fontBuffer.length === 0) return '';
    return `[Fonts]\nfontname: ${fontName}\n${uuencodeFont(fontBuffer)}`;
}

/**
 * Build an ASS/SSA subtitle document styled with the Thmanyah Sans typeface.
 * Mirrors `buildSRT`: the watermark cue is always the first event. Cues whose
 * timestamps cannot be parsed are skipped rather than emitted broken.
 */
function buildASS(cues, options = {}) {
    const lines = HEADER.slice();
    lines.push(dialogueLine(WATERMARK_START, WATERMARK_END, WATERMARK_TEXT));

    for (const cue of cues || []) {
        const startMs = timeToMs(cue.start);
        const endMs = timeToMs(cue.end);
        if (startMs === null || endMs === null) continue;
        lines.push(dialogueLine(startMs, endMs, cue.text));
    }

    let out = `${lines.join('\n')}\n`;
    if (options.embeddedFont && options.embeddedFont.name && options.embeddedFont.buffer) {
        out += `\n${embedFont(options.embeddedFont.name, options.embeddedFont.buffer)}\n`;
    }
    return out;
}

module.exports = {
    buildASS,
    escapeAssText,
    msToAss,
    STYLE_LINE,
    embedFont,
    uuencodeFont
};
