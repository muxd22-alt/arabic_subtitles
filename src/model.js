const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const config = require('./config.js');

function statOrNull(p) {
    try {
        return fs.statSync(p);
    } catch (e) {
        return null;
    }
}

function modelStatus() {
    const st = statOrNull(config.MODEL_PATH);
    if (!st) return { state: 'missing', path: config.MODEL_PATH, bytes: 0 };
    if (st.size < config.MODEL_BYTES) {
        return { state: 'partial', path: config.MODEL_PATH, bytes: st.size, total: config.MODEL_BYTES };
    }
    return { state: 'ready', path: config.MODEL_PATH, bytes: st.size, total: config.MODEL_BYTES };
}

function whisperStatus() {
    const st = statOrNull(config.WHISPER_PATH);
    if (!st) return { state: 'missing', path: config.WHISPER_PATH, bytes: 0 };
    return { state: 'ready', path: config.WHISPER_PATH, bytes: st.size };
}

function fetchResponse(url, headers = {}, redirects = 5, attempts = 0) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('http://') ? http : https;
        const req = mod.get(url, { headers }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                resolve(fetchResponse(next, headers, redirects - 1, attempts));
                return;
            }
            if (status !== 200 && status !== 206) {
                res.resume();
                if ((status === 5 || status >= 500) && attempts < 3) {
                    setTimeout(() => {
                        resolve(fetchResponse(url, headers, redirects, attempts + 1));
                    }, 1500 * (attempts + 1));
                    return;
                }
                reject(new Error(`HTTP ${status} for ${url}`));
                return;
            }
            resolve(res);
        });
        req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
        req.on('error', (err) => {
            if (attempts < 3) {
                setTimeout(() => {
                    resolve(fetchResponse(url, headers, redirects, attempts + 1));
                }, 1500 * (attempts + 1));
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Download a file with resume support. Appends to a .part file until the
 * expected byte count is reached, then atomically renames into place.
 */
async function downloadFile(url, destPath, options = {}) {
    const total = options.totalBytes || 0;
    const onProgress = options.onProgress || (() => { });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const partPath = `${destPath}.part`;
    let offset = 0;
    const existing = statOrNull(partPath);
    if (existing && existing.size > 0) {
        offset = existing.size;
        if (total && offset >= total) {
            fs.renameSync(partPath, destPath);
            onProgress(total, total);
            return destPath;
        }
    }

    const headers = { 'User-Agent': config.USER_AGENT };
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    const res = await fetchResponse(url, headers);
    const mode = offset > 0 && res.statusCode === 206 ? 'a' : 'w';
    if (mode === 'w') offset = 0;

    const out = fs.createWriteStream(partPath, { flags: mode });
    let received = offset;
    res.on('data', (chunk) => {
        received += chunk.length;
        onProgress(received, total);
    });

    let streamError = null;
    try {
        await pipeline(res, out);
    } catch (err) {
        // premature close / socket abort: fall through to the size check so the
        // caller gets an actionable "incomplete download" message instead.
        streamError = err;
    }

    const finalSize = (statOrNull(partPath) || {}).size || 0;
    if (streamError) {
        throw new Error(`incomplete download: ${finalSize}/${total || '?'} bytes (${streamError.message})`);
    }
    if (total && finalSize < total) {
        throw new Error(`incomplete download: ${finalSize}/${total} bytes`);
    }
    if (total && finalSize > total) {
        throw new Error(`download too large: ${finalSize} > ${total} bytes`);
    }
    fs.renameSync(partPath, destPath);
    onProgress(finalSize, total || finalSize);
    return destPath;
}

async function downloadModel(options = {}) {
    const status = modelStatus();
    if (status.state === 'ready') return status;
    config.ensureDirs();
    return downloadFile(config.MODEL_URL, config.MODEL_PATH, {
        totalBytes: config.MODEL_BYTES,
        onProgress: options.onProgress
    }).then(() => modelStatus());
}

async function downloadWhisperModel(options = {}) {
    const status = whisperStatus();
    if (status.state === 'ready') return status;
    config.ensureDirs();
    return downloadFile(config.WHISPER_URL, config.WHISPER_PATH, {
        onProgress: options.onProgress
    }).then(() => whisperStatus());
}

module.exports = {
    modelStatus,
    whisperStatus,
    downloadFile,
    downloadModel,
    downloadWhisperModel
};
