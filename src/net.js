const config = require('./config.js');

/**
 * One tiny HTTP layer for everything the provider bazaar fetches.
 *
 * It uses the global fetch (Node 18+ — same runtime the rest of the engine
 * already requires) but adds the three things a scraper cannot live without:
 *   - redirects are followed by hand, so a provider can never bounce us to an
 *     endless loop or an unbounded download;
 *   - every response is capped (Content-Length and streamed bytes alike), so a
 *     misbehaving endpoint cannot fill the phone's disk or RAM;
 *   - a per-request timeout that actually aborts the socket.
 *
 * `setFetchImpl` swaps the transport for tests, which is how the whole provider
 * suite runs offline with fixtures.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_REDIRECTS = 5;

let injectedFetch = null;

function setFetchImpl(fn) {
    injectedFetch = fn || null;
}

function resetFetchImpl() {
    injectedFetch = null;
}

function getFetch() {
    const impl = injectedFetch || globalThis.fetch;
    if (typeof impl !== 'function') {
        throw new Error('global fetch is missing — Arabic Subs needs Node 18 or newer');
    }
    return impl;
}

async function readCapped(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > maxBytes) throw new Error(`response too large (>${maxBytes} bytes)`);
        return buf;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch (e) { }
            throw new Error(`response too large (>${maxBytes} bytes)`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/**
 * Perform one HTTP request and resolve with the full outcome. Never rejects for
 * an HTTP error status (providers want to see 404 vs 403), only for transport
 * failures and over-sized bodies.
 */
async function httpRequest(url, options = {}) {
    const {
        method = 'GET',
        headers = {},
        body = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxBytes = DEFAULT_MAX_BYTES,
        maxRedirects = DEFAULT_REDIRECTS,
        signal = null
    } = options;

    const fetchImpl = getFetch();
    let current = String(url);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        let response;
        try {
            response = await fetchImpl(current, {
                method,
                headers: { 'User-Agent': config.USER_AGENT, ...headers },
                body: body === null ? undefined : body,
                redirect: 'manual',
                signal: controller.signal
            });
        } catch (err) {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            const aborted = err && (err.name === 'AbortError' || controller.signal.aborted);
            throw new Error(aborted ? `request timed out after ${timeoutMs}ms: ${current}` : `${describeError(err)} (${current})`);
        }
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);

        const location = response.headers && response.headers.get ? response.headers.get('location') : null;
        if (response.status >= 300 && response.status < 400 && location) {
            if (response.body && typeof response.body.cancel === 'function') {
                try { await response.body.cancel(); } catch (e) { }
            }
            current = new URL(location, current).toString();
            continue;
        }

        const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error(`response too large: ${declared} bytes (${current})`);
        }

        const buffer = await readCapped(response, maxBytes);
        return {
            ok: Boolean(response.ok),
            status: response.status,
            headers: response.headers,
            url: current,
            buffer
        };
    }

    throw new Error(`too many redirects: ${url}`);
}

/** GET expecting a successful status; throws with the status and a body snippet otherwise. */
async function httpGet(url, options = {}) {
    const res = await httpRequest(url, options);
    if (!res.ok) {
        const hint = res.buffer.length ? `: ${snippet(res.buffer.toString('utf8'))}` : '';
        throw new Error(`HTTP ${res.status} for ${res.url}${hint}`);
    }
    return res;
}

function httpGetBuffer(url, options = {}) {
    return httpGet(url, options).then((res) => res.buffer);
}

function httpGetText(url, options = {}) {
    return httpGet(url, options).then((res) => res.buffer.toString(options.encoding || 'utf8'));
}

async function httpGetJson(url, options = {}) {
    const text = await httpGetText(url, options);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`invalid JSON from ${url}: ${snippet(text)}`);
    }
}

function snippet(text, length = 160) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function describeError(err) {
    const parts = [err && err.message ? err.message : String(err)];
    const cause = err && err.cause;
    if (cause) {
        if (cause.code) parts.push(cause.code);
        else if (cause.message) parts.push(cause.message);
    } else if (err && err.code) {
        parts.push(err.code);
    }
    return [...new Set(parts)].join(' — ');
}

module.exports = {
    httpRequest,
    httpGet,
    httpGetBuffer,
    httpGetText,
    httpGetJson,
    snippet,
    describeError,
    setFetchImpl,
    resetFetchImpl,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_BYTES
};
