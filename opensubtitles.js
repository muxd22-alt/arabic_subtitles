const fs = require('fs');
const { USER_AGENT, getOpenSubtitlesConfig } = require('./config.js');

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const HASH_CHUNK = 64 * 1024;
const MASK64 = (1n << 64n) - 1n;
const DEFAULT_TIMEOUT_MS = 20000;

class OpenSubtitlesError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'OpenSubtitlesError';
        this.status = options.status || null;
        this.code = options.code || 'opensubtitles_error';
    }
}

class QuotaExceededError extends OpenSubtitlesError {
    constructor(message, options = {}) {
        super(message, Object.assign({}, options, { code: 'quota_exceeded' }));
        this.name = 'QuotaExceededError';
    }
}

function sumChunk(buf) {
    let sum = 0n;
    const usable = buf.length - (buf.length % 8);
    for (let i = 0; i < usable; i += 8) {
        sum = (sum + buf.readBigUInt64LE(i)) & MASK64;
    }
    return sum;
}

/**
 * OpenSubtitles movie hash (OSHash): file size + uint64-LE sums of the first
 * and last 64 KB, wrapping at 64 bits, rendered as 16 lowercase hex chars.
 * Only 128 KB is ever read, so hashing a 50 GB file is as fast as a 200 KB one.
 */
async function computeOsHash(filePath) {
    const stat = await fs.promises.stat(filePath);
    const size = stat.size;

    const headLen = Math.min(HASH_CHUNK, size);
    const tailLen = Math.min(HASH_CHUNK, size);
    const head = Buffer.alloc(headLen);
    const tail = Buffer.alloc(tailLen);

    const handle = await fs.promises.open(filePath, 'r');
    try {
        await handle.read(head, 0, headLen, 0);
        await handle.read(tail, 0, tailLen, Math.max(size - HASH_CHUNK, 0));
    } finally {
        await handle.close();
    }

    let hash = BigInt(size) & MASK64;
    hash = (hash + sumChunk(head)) & MASK64;
    hash = (hash + sumChunk(tail)) & MASK64;

    return hash.toString(16).padStart(16, '0');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class OpenSubtitlesClient {
    constructor(options = {}) {
        const cfg = getOpenSubtitlesConfig();
        this.apiKey = options.apiKey !== undefined ? options.apiKey : cfg.apiKey;
        this.username = options.username !== undefined ? options.username : cfg.username;
        this.password = options.password !== undefined ? options.password : cfg.password;
        this.userAgent = options.userAgent || USER_AGENT;
        this.baseUrl = options.baseUrl || API_BASE;
        this.fetchImpl = options.fetch || globalThis.fetch;
        this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.token = null;
        this.lastRemaining = null;
    }

    enabled() {
        return Boolean(this.apiKey);
    }

    baseHeaders(extra = {}) {
        const headers = {
            'Api-Key': this.apiKey,
            'User-Agent': this.userAgent,
            Accept: 'application/json'
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        return Object.assign(headers, extra);
    }

    async request(method, url, options = {}) {
        if (typeof this.fetchImpl !== 'function') {
            throw new OpenSubtitlesError('global fetch is unavailable (Node >= 18 required)', { code: 'no_fetch' });
        }

        const retries = options.retries !== undefined ? options.retries : 2;
        const body = options.body !== undefined ? options.body : null;
        let reauthenticated = false;
        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const init = {
                method,
                headers: this.baseHeaders(options.headers || {}),
                signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : undefined
            };
            if (body !== null) {
                init.headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(body);
            }

            let res;
            try {
                res = await this.fetchImpl(url, init);
            } catch (e) {
                lastError = new OpenSubtitlesError(`network error: ${e.message}`, { code: 'network_error' });
                if (attempt < retries) {
                    await sleep(1000 * (attempt + 1));
                    continue;
                }
                throw lastError;
            }

            if (res.status === 401 && this.username && this.password && !reauthenticated) {
                reauthenticated = true;
                try {
                    await this.login(true);
                    continue;
                } catch (e) {
                    throw new OpenSubtitlesError(`authentication failed: ${e.message}`, { status: 401, code: 'auth_failed' });
                }
            }

            if (res.status === 429 || res.status >= 500) {
                if (attempt < retries) {
                    const retryAfter = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : 0);
                    await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000 * (attempt + 1));
                    continue;
                }
            }

            const text = await res.text().catch(() => '');
            let json = null;
            if (text) {
                try {
                    json = JSON.parse(text);
                } catch (e) {
                    json = null;
                }
            }

            if (!res.ok) {
                const message = (json && (json.message || json.error)) || `HTTP ${res.status}`;
                const quotaLike = /downloaded your allowed|quota|limit reached|too many requests/i.test(String(message));
                if (quotaLike || res.status === 406 && /quota/i.test(String(message))) {
                    throw new QuotaExceededError(String(message), { status: res.status });
                }
                if (res.status === 401 || res.status === 403) {
                    throw new OpenSubtitlesError(String(message), { status: res.status, code: 'auth_failed' });
                }
                throw new OpenSubtitlesError(String(message), { status: res.status });
            }

            if (json === null) {
                throw new OpenSubtitlesError('response was not valid JSON (User-Agent or Api-Key rejected?)', {
                    status: res.status,
                    code: 'bad_response'
                });
            }

            return json;
        }

        throw lastError || new OpenSubtitlesError('request failed');
    }

    /** Exchange OpenSubtitles account credentials for a JWT (optional; enables downloads + quota tracking). */
    async login(force = false) {
        if (this.token && !force) return this.token;
        if (!this.username || !this.password) return null;

        const res = await this.request('POST', `${this.baseUrl}/login`, {
            body: { username: this.username, password: this.password },
            retries: 1
        });

        if (!res || !res.token) {
            throw new OpenSubtitlesError('login response missing token', { code: 'auth_failed' });
        }

        this.token = res.token;
        if (res.base_url === 'vip-api.opensubtitles.com') {
            this.baseUrl = 'https://vip-api.opensubtitles.com/api/v1';
        }
        this.allowedDownloads = res.user && res.user.allowed_downloads;
        return this.token;
    }

    normalizeResult(item) {
        const attrs = (item && item.attributes) || {};
        const feature = attrs.feature_details || {};
        const files = Array.isArray(attrs.files) ? attrs.files : [];
        return {
            id: item && item.id ? String(item.id) : null,
            fileId: files.length ? files[0].file_id : null,
            fileName: files.length ? files[0].file_name || null : null,
            language: attrs.language || null,
            downloadCount: attrs.download_count || 0,
            title: feature.title || null,
            year: feature.year || null,
            featureType: feature.feature_type || null,
            season: feature.season_number !== undefined ? feature.season_number : null,
            episode: feature.episode_number !== undefined ? feature.episode_number : null,
            release: attrs.release || null,
            moviehashMatch: Boolean(attrs.moviehash_match),
            machineTranslated: Boolean(attrs.machine_translated),
            aiTranslated: Boolean(attrs.ai_translated),
            hearingImpaired: Boolean(attrs.hearing_impaired),
            url: attrs.url || null
        };
    }

    /**
     * GET /subtitles — free (search never consumes the download quota).
     * @returns {Promise<{totalPages: number, totalCount: number, results: Array}>}
     */
    async search(params = {}) {
        const query = new URLSearchParams();

        if (params.moviehash) query.set('moviehash', String(params.moviehash).toLowerCase());
        if (params.query) query.set('query', String(params.query));
        if (params.languages) query.set('languages', String(params.languages));
        if (params.year) query.set('year', String(params.year));
        if (params.season !== null && params.season !== undefined) query.set('season_number', String(params.season));
        if (params.episode !== null && params.episode !== undefined) query.set('episode_number', String(params.episode));
        if (params.type) query.set('type', String(params.type));
        query.set('order_by', params.orderBy || 'download_count');
        query.set('order_direction', params.orderDirection || 'desc');
        if (params.page) query.set('page', String(params.page));

        const url = `${this.baseUrl}/subtitles?${query.toString()}`;
        const res = await this.request('GET', url);

        const data = Array.isArray(res && res.data) ? res.data : [];
        return {
            totalPages: (res && res.total_pages) || 0,
            totalCount: (res && res.total_count) || 0,
            results: data.map((item) => this.normalizeResult(item)).filter((r) => r.fileId)
        };
    }

    /** POST /download — costs one unit of the daily download quota. Returns a short-lived link. */
    async getDownloadLink(fileId) {
        const res = await this.request('POST', `${this.baseUrl}/download`, {
            body: { file_id: Number(fileId), sub_format: 'srt' }
        });

        if (res && typeof res.remaining === 'number') this.lastRemaining = res.remaining;

        if (!res || !res.link) {
            const message = (res && res.message) || 'no download link in response';
            if (/downloaded your allowed|quota/i.test(String(message)) || (res && res.remaining === 0)) {
                throw new QuotaExceededError(String(message));
            }
            throw new OpenSubtitlesError(String(message), { code: 'no_link' });
        }

        return {
            link: res.link,
            fileName: res.file_name || null,
            remaining: typeof res.remaining === 'number' ? res.remaining : null,
            message: res.message || null,
            resetTime: res.reset_time || null
        };
    }

    async downloadContent(link) {
        const res = await this.fetchImpl(link, {
            method: 'GET',
            headers: { 'User-Agent': this.userAgent },
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(this.timeoutMs) : undefined
        });
        if (!res.ok) {
            throw new OpenSubtitlesError(`download failed with HTTP ${res.status}`, { status: res.status, code: 'download_failed' });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return buf;
    }

    /** Two-step download: get link, then fetch bytes. */
    async downloadSubtitle(fileId) {
        const meta = await this.getDownloadLink(fileId);
        const content = await this.downloadContent(meta.link);
        return Object.assign({ content }, meta);
    }
}

module.exports = {
    OpenSubtitlesClient,
    OpenSubtitlesError,
    QuotaExceededError,
    computeOsHash,
    API_BASE
};
