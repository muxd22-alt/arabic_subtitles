const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeOsHash, OpenSubtitlesClient, OpenSubtitlesError, QuotaExceededError } = require('../opensubtitles.js');

const FIXTURES = path.join(__dirname, 'fixtures');

// Canonical vector published by opensubtitles/oshash for this exact file.
const CANONICAL_SMALL = { file: 'testfile_small.bin', hash: '6e4ae67790577f76' };
// Local fixtures (see generate_fixtures.py): non-overlapping head/tail, and a
// crafted hash with leading zeros to prove 16-char zero padding.
const LARGE_NON_OVERLAP = { file: 'large_140k.bin', hash: '3d5792839b35d0fd' };
const ZERO_PADDED = { file: 'zerohash_140k.bin', hash: '00005f1fe0a14000' };

test('computeOsHash reproduces the canonical OpenSubtitles test vector', async () => {
    const hash = await computeOsHash(path.join(FIXTURES, CANONICAL_SMALL.file));
    assert.equal(hash, CANONICAL_SMALL.hash);
});

test('computeOsHash handles non-overlapping head/tail chunks', async () => {
    const hash = await computeOsHash(path.join(FIXTURES, LARGE_NON_OVERLAP.file));
    assert.equal(hash, LARGE_NON_OVERLAP.hash);
});

test('computeOsHash zero-pads to 16 hex characters', async () => {
    const hash = await computeOsHash(path.join(FIXTURES, ZERO_PADDED.file));
    assert.equal(hash, ZERO_PADDED.hash);
    assert.equal(hash.length, 16);
    assert.match(hash, /^[0-9a-f]{16}$/);
});

test('computeOsHash is stable and size-independent in cost for tiny files', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-hash-')), 'tiny.bin');
    fs.writeFileSync(tmp, Buffer.alloc(4096, 7));
    const first = await computeOsHash(tmp);
    const second = await computeOsHash(tmp);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{16}$/);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

function jsonResponse(obj, status = 200, headers = {}) {
    const lower = {};
    Object.keys(headers).forEach((k) => { lower[k.toLowerCase()] = String(headers[k]); });
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => lower[String(name).toLowerCase()] || null },
        text: async () => JSON.stringify(obj),
        arrayBuffer: async () => Buffer.from(JSON.stringify(obj))
    };
}

function rawResponse(body, status = 200, contentType = 'text/plain') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () => buf
    };
}

const SAMPLE_SEARCH = {
    total_pages: 1,
    total_count: 1,
    per_page: 50,
    page: 1,
    data: [{
        id: '111',
        type: 'subtitle',
        attributes: {
            language: 'en',
            download_count: 9608,
            hearing_impaired: false,
            machine_translated: false,
            ai_translated: false,
            release: 'Interstellar.2014.1080p.BluRay.x264-SPARKS',
            moviehash_match: true,
            feature_details: { title: 'Interstellar', year: 2014, feature_type: 'Movie' },
            files: [{ file_id: 4242, file_name: 'Interstellar.2014.srt' }],
            url: 'https://www.opensubtitles.com/en/subtitles/111'
        }
    }]
};

test('search sends Api-Key + User-Agent and normalizes results', async () => {
    const calls = [];
    const client = new OpenSubtitlesClient({
        apiKey: 'test-key',
        fetch: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse(SAMPLE_SEARCH);
        }
    });

    const res = await client.search({ query: 'Interstellar', languages: 'en', year: 2014, moviehash: '8e245d9679d31e12' });

    assert.equal(calls.length, 1);
    const parsedUrl = new URL(calls[0].url);
    assert.equal(parsedUrl.pathname, '/api/v1/subtitles');
    assert.equal(parsedUrl.searchParams.get('query'), 'Interstellar');
    assert.equal(parsedUrl.searchParams.get('languages'), 'en');
    assert.equal(parsedUrl.searchParams.get('year'), '2014');
    assert.equal(parsedUrl.searchParams.get('moviehash'), '8e245d9679d31e12');
    assert.equal(calls[0].init.headers['Api-Key'], 'test-key');
    assert.match(calls[0].init.headers['User-Agent'], /^SubArabify v/);

    assert.equal(res.totalCount, 1);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].fileId, 4242);
    assert.equal(res.results[0].title, 'Interstellar');
    assert.equal(res.results[0].year, 2014);
    assert.equal(res.results[0].moviehashMatch, true);
    assert.equal(res.results[0].language, 'en');
});

test('search retries after a 429 rate-limit response', async () => {
    let calls = 0;
    const client = new OpenSubtitlesClient({
        apiKey: 'test-key',
        fetch: async () => {
            calls++;
            if (calls === 1) return jsonResponse({ message: 'slow down' }, 429, { 'retry-after': '0' });
            return jsonResponse(SAMPLE_SEARCH);
        }
    });

    const res = await client.search({ query: 'Interstellar', languages: 'en' });
    assert.equal(calls, 2);
    assert.equal(res.results.length, 1);
});

test('search surfaces auth failures as auth_failed', async () => {
    const client = new OpenSubtitlesClient({
        apiKey: 'bad-key',
        fetch: async () => jsonResponse({ message: 'Invalid API key' }, 401)
    });
    await assert.rejects(() => client.search({ query: 'x' }), (err) => {
        assert.ok(err instanceof OpenSubtitlesError);
        assert.equal(err.code, 'auth_failed');
        assert.equal(err.status, 401);
        return true;
    });
});

test('downloadSubtitle performs the two-step link flow', async () => {
    const calls = [];
    const subtitleBytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n", 'utf8');
    const client = new OpenSubtitlesClient({
        apiKey: 'test-key',
        fetch: async (url, init) => {
            calls.push({ url, init });
            if (init.method === 'POST') {
                return jsonResponse({ link: 'https://dl.example/sub/1', file_name: 'x.srt', requests: 1, remaining: 19, message: 'ok', reset_time: '24h', reset_time_utc: 'x' });
            }
            return rawResponse(subtitleBytes);
        }
    });

    const result = await client.downloadSubtitle(4242);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { file_id: 4242, sub_format: 'srt' });
    assert.equal(calls[1].url, 'https://dl.example/sub/1');
    assert.equal(result.content.toString('utf8'), subtitleBytes.toString('utf8'));
    assert.equal(result.remaining, 19);
    assert.equal(client.lastRemaining, 19);
});

test('quota exhaustion raises QuotaExceededError', async () => {
    const client = new OpenSubtitlesClient({
        apiKey: 'test-key',
        fetch: async () => jsonResponse({ message: 'You have downloaded your allowed 20 subtitles for 24h' }, 403)
    });
    await assert.rejects(() => client.downloadSubtitle(1), (err) => err instanceof QuotaExceededError);
});

test('login attaches the JWT to subsequent requests', async () => {
    const calls = [];
    const client = new OpenSubtitlesClient({
        apiKey: 'test-key',
        username: 'user',
        password: 'pass',
        fetch: async (url, init) => {
            calls.push({ url: String(url), init });
            if (String(url).endsWith('/login')) {
                return jsonResponse({ token: 'jwt-token', base_url: 'api.opensubtitles.com', status: 200, user: { allowed_downloads: 20, level: 'standard', user_id: 1, vip: false, ext_installed: false, allowed_translations: 0 } });
            }
            return jsonResponse(SAMPLE_SEARCH);
        }
    });

    await client.login();
    assert.equal(client.token, 'jwt-token');
    await client.search({ query: 'Interstellar', languages: 'en' });

    const searchCall = calls.find((c) => c.url.includes('/subtitles'));
    assert.equal(searchCall.init.headers.Authorization, 'Bearer jwt-token');
});

test('a 401 mid-flight re-logins once when credentials exist', async () => {
    let searches = 0;
    let logins = 0;
    const client = new OpenSubtitlesClient({
        apiKey: 'test-key',
        username: 'user',
        password: 'pass',
        fetch: async (url, init) => {
            if (String(url).endsWith('/login')) {
                logins++;
                return jsonResponse({ token: `jwt-${logins}`, base_url: 'api.opensubtitles.com', status: 200, user: {} });
            }
            searches++;
            if (searches === 1) return jsonResponse({ message: 'token expired' }, 401);
            return jsonResponse(SAMPLE_SEARCH);
        }
    });

    const res = await client.search({ query: 'Interstellar', languages: 'en' });
    assert.equal(logins, 1);
    assert.equal(res.results.length, 1);
});

test('disabled client reports missing API key', () => {
    const client = new OpenSubtitlesClient({ apiKey: '' });
    assert.equal(client.enabled(), false);
});
