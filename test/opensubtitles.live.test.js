const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { OpenSubtitlesClient, computeOsHash, QuotaExceededError } = require('../opensubtitles.js');

// Live contract checks against the real OpenSubtitles.com API.
// They only run when a key is available (locally via .env, in CI via the
// `OpenSubtitles` repository secret). Search is free; downloads are opt-in
// because they consume the daily download quota.

const HAS_KEY = Boolean(process.env.OPENSUBTITLES_API_KEY);
const LIVE_DOWNLOAD = process.env.OPENSUBTITLES_LIVE_DOWNLOAD === '1';

test('live search: title+year query returns normalized results', { skip: !HAS_KEY && 'OPENSUBTITLES_API_KEY not set' }, async () => {
    const client = new OpenSubtitlesClient();
    assert.equal(client.enabled(), true);

    const res = await client.search({ query: 'Inception', languages: 'en', year: 2010, type: 'movie' });
    assert.ok(res.totalCount > 0, 'expected at least one subtitle for Inception (2010)');
    assert.ok(res.results.length > 0);

    const first = res.results[0];
    assert.ok(Number.isInteger(first.fileId) && first.fileId > 0, 'fileId must be a positive integer');
    assert.equal(first.language, 'en');
    assert.ok(first.downloadCount >= 0);
});

test('live search: moviehash query accepts a valid 16-hex hash', { skip: !HAS_KEY && 'OPENSUBTITLES_API_KEY not set' }, async () => {
    const client = new OpenSubtitlesClient();
    const hash = await computeOsHash(path.join(__dirname, 'fixtures', 'testfile_small.bin'));
    assert.match(hash, /^[0-9a-f]{16}$/);

    const res = await client.search({ moviehash: hash, languages: 'ar' });
    assert.ok(Array.isArray(res.results), 'results must be an array (empty is fine for an unknown hash)');
});

test('live download: two-step flow returns a parseable subtitle', { skip: (!HAS_KEY || !LIVE_DOWNLOAD) && 'set OPENSUBTITLES_API_KEY and OPENSUBTITLES_LIVE_DOWNLOAD=1' }, async () => {
    const client = new OpenSubtitlesClient();
    const search = await client.search({ query: 'Inception', languages: 'en', year: 2010, type: 'movie' });
    assert.ok(search.results.length > 0);

    try {
        const downloaded = await client.downloadSubtitle(search.results[0].fileId);
        assert.ok(Buffer.isBuffer(downloaded.content));
        assert.ok(downloaded.content.length > 0);
        assert.ok(typeof downloaded.remaining === 'number');
    } catch (e) {
        if (e instanceof QuotaExceededError) {
            // Quota exhausted is a legitimate state, not a contract failure
            assert.ok(e.message.length > 0);
            return;
        }
        throw e;
    }
});
