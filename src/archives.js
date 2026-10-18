const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('./config.js');
const { findExecutable } = require('./binaries.js');

/**
 * Unpacking whatever a subtitle provider hands back. SRTs arrive plain, zipped,
 * gzipped, tarred, and — mostly on older mirrors — inside RAR archives. Zip,
 * gzip and tar are handled with Node's own zlib (no dependency, works on the
 * phone); RAR is delegated to `unrar`/`7z` when the system happens to have one,
 * and skipped with a note otherwise.
 */

const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.txt']);
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

function extensionOf(name) {
    return path.extname(String(name || '').toLowerCase());
}

function isSubtitleName(name) {
    return SUBTITLE_EXTS.has(extensionOf(name));
}

function isProbablyText(buf) {
    if (!buf || buf.length === 0) return false;
    const sample = buf.slice(0, 2048);
    if (sample.includes(0)) return false;
    let printable = 0;
    for (const byte of sample) {
        if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128) printable++;
    }
    return printable / sample.length > 0.85;
}

function looksLikeSubtitle(buf) {
    if (!isProbablyText(buf)) return false;
    const head = buf.toString('utf8', 0, Math.min(buf.length, 4000));
    if (/^\s*WEBVTT/i.test(head)) return true;
    if (/\[Script Info\]/i.test(head)) return true;
    if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return true;
    if (/^\{\d+\}\{\d+\}/.test(head)) return true; // MicroDVD
    const lines = head.split(/\r?\n/).filter((l) => l.trim());
    return lines.length > 3 && lines.slice(0, 12).some((l) => /^[^\d]{1,120}$/.test(l.trim()));
}

/** Read a ZIP archive (stored + deflate entries). Returns [{name, data}] for subtitle entries. */
function readZip(buffer) {
    const eo = findEndOfCentralDirectory(buffer);
    if (!eo) throw new Error('not a zip archive (no end-of-central-directory)');

    const entries = [];
    let offset = eo.centralOffset;
    let total = 0;

    for (let i = 0; i < eo.count; i++) {
        if (offset + 46 > buffer.length) break;
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(offset + 10);
        const compressed = buffer.readUInt32LE(offset + 20);
        const uncompressed = buffer.readUInt32LE(offset + 24);
        const nameLen = buffer.readUInt16LE(offset + 28);
        const extraLen = buffer.readUInt16LE(offset + 30);
        const commentLen = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
        offset += 46 + nameLen + extraLen + commentLen;

        if (!isSubtitleName(name)) continue;
        if (uncompressed > MAX_ENTRY_BYTES || total + uncompressed > MAX_TOTAL_BYTES) continue;
        const data = readZipEntry(buffer, localOffset, method, compressed, uncompressed);
        if (!data) continue;
        total += data.length;
        entries.push({ name, data });
    }
    return entries;
}

function readZipEntry(buffer, localOffset, method, compressed, uncompressed) {
    try {
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
        const nameLen = buffer.readUInt16LE(localOffset + 26);
        const extraLen = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + nameLen + extraLen;
        const raw = buffer.slice(start, start + compressed);
        if (method === 0) return Buffer.from(raw.slice(0, uncompressed || raw.length));
        if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
        return null;
    } catch (e) {
        return null;
    }
}

function findEndOfCentralDirectory(buffer) {
    const min = Math.max(0, buffer.length - 65558);
    for (let i = buffer.length - 22; i >= min; i--) {
        if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
        return {
            count: buffer.readUInt16LE(i + 10),
            centralOffset: buffer.readUInt32LE(i + 16)
        };
    }
    return null;
}

/** Read a tar archive. Returns [{name, data}] for subtitle entries. */
function readTar(buffer) {
    const entries = [];
    let offset = 0;
    let total = 0;
    while (offset + 512 <= buffer.length) {
        const header = buffer.slice(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const sizeText = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
        const size = Number.parseInt(sizeText, 8) || 0;
        const type = String.fromCharCode(header[156] || 0);
        const dataStart = offset + 512;
        if ((type === '0' || type === '\0' || type === '') && isSubtitleName(name) && size <= MAX_ENTRY_BYTES && total + size <= MAX_TOTAL_BYTES) {
            entries.push({ name, data: Buffer.from(buffer.slice(dataStart, dataStart + size)) });
            total += size;
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    return entries;
}

function rarTool() {
    return findExecutable(
        process.platform === 'win32' ? ['unrar.exe', 'UnRAR.exe', '7z.exe', '7za.exe', '7zz.exe'] : ['unrar', '7z', '7za', 'unar', 'bsdtar'],
        'UNRAR_BIN'
    );
}

/** RAR needs an external tool; returns [] (with a note for the caller) when absent. */
function readRar(buffer, name) {
    const tool = rarTool();
    if (!tool) return { entries: [], note: 'rar archive — no unrar/7z on this system' };

    let dir;
    try {
        fs.mkdirSync(config.TMP_DIR, { recursive: true });
        dir = fs.mkdtempSync(path.join(config.TMP_DIR, 'rar-'));
        const archive = path.join(dir, name || 'subs.rar');
        fs.writeFileSync(archive, buffer);
        const { execFileSync } = require('child_process');
        const base = path.basename(tool).toLowerCase();
        const outDir = path.join(dir, 'out');
        fs.mkdirSync(outDir, { recursive: true });
        if (base.startsWith('unrar')) execFileSync(tool, ['x', '-o+', '-p-', archive, `${outDir}${path.sep}`], { stdio: 'ignore', timeout: 60000 });
        else if (base.startsWith('unar')) execFileSync(tool, ['-o', outDir, archive], { stdio: 'ignore', timeout: 60000 });
        else execFileSync(tool, ['x', '-y', `-o${outDir}`, archive], { stdio: 'ignore', timeout: 60000 });

        const entries = [];
        for (const entry of fs.readdirSync(outDir)) {
            if (!isSubtitleName(entry)) continue;
            const data = fs.readFileSync(path.join(outDir, entry));
            if (data.length <= MAX_ENTRY_BYTES) entries.push({ name: entry, data });
        }
        return { entries, note: entries.length ? null : 'rar archive contained no subtitle files' };
    } catch (e) {
        return { entries: [], note: `rar extraction failed: ${e.message}` };
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
    }
}

/**
 * Turn a provider response into subtitle files. Accepts a plain subtitle, a
 * zip/gzip/tar/rar archive, or a bare text payload that was never named —
 * the caller passes the file name from the provider when it has one.
 */
function extractSubtitles(buffer, fileName = '') {
    if (!buffer || buffer.length === 0) return { files: [], note: 'empty response' };
    const name = String(fileName || '');
    const magic = buffer.slice(0, 8);

    if (magic.slice(0, 2).toString('latin1') === 'PK') {
        try {
            return { files: readZip(buffer), note: null };
        } catch (e) {
            return { files: [], note: `zip error: ${e.message}` };
        }
    }
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
        try {
            const unpacked = zlib.gunzipSync(buffer, { maxOutputLength: MAX_TOTAL_BYTES });
            if (unpacked.slice(0, 2).toString('latin1') === 'PK') return { files: readZip(unpacked), note: null };
            if (unpacked.length > 262 && unpacked.toString('utf8', 257, 262) === 'ustar') return { files: readTar(unpacked), note: null };
            return { files: [{ name: name.replace(/\.gz$/i, '') || 'subtitle.srt', data: unpacked }], note: null };
        } catch (e) {
            return { files: [], note: `gzip error: ${e.message}` };
        }
    }
    if (magic.slice(0, 4).toString('latin1') === 'Rar!') {
        return readRar(buffer, name);
    }
    if (buffer.length > 262 && buffer.toString('utf8', 257, 262) === 'ustar') {
        return { files: readTar(buffer), note: null };
    }

    if (isSubtitleName(name) || looksLikeSubtitle(buffer)) {
        return { files: [{ name: name || 'subtitle.srt', data: buffer }], note: null };
    }
    return { files: [], note: 'response is not a recognised subtitle' };
}

/**
 * Pick the subtitle file a human would pick. Language tokens in the entry name
 * win first (`.ar.` beats `.en.` when Arabic is preferred), then the shortest
 * non-"forced" name — the main track, not the partial one.
 */
function pickSubtitle(files, options = {}) {
    const prefer = (options.prefer || []).map((c) => String(c).toLowerCase());
    const scored = files
        .filter((f) => isProbablyText(f.data))
        .map((f, i) => {
            const lower = f.name.toLowerCase();
            let score = 100 - i;
            const tokens = lower.split(/[^a-z]+/i).filter(Boolean);
            for (const code of prefer) {
                if (tokens.includes(code)) { score += 1000; break; }
            }
            if (/forced/.test(lower)) score -= 60;
            if (/\b(sdh|cc|hi)\b/.test(lower)) score -= 20;
            if (/\.(srt|ass|ssa)$/.test(lower)) score += 5;
            score -= Math.min(30, f.name.length / 6);
            return { file: f, score };
        })
        .sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].file : null;
}

module.exports = {
    extractSubtitles,
    pickSubtitle,
    readZip,
    readTar,
    isSubtitleName,
    isProbablyText,
    looksLikeSubtitle,
    SUBTITLE_EXTS
};
