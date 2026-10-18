const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// Keep every stateful module away from the real home before anything loads.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'arabicsubs-bazaar-'));
process.env.ARABIC_SUBS_HOME = SCRATCH;
process.env.PROVIDERS_STATE = path.join(SCRATCH, 'providers.json');
process.env.IMDB_CACHE = path.join(SCRATCH, 'imdb.json');

const net = require('../src/net.js');
const langs = require('../src/langs.js');
const releaseMod = require('../src/release.js');
const archives = require('../src/archives.js');
const health = require('../src/provider-health.js');
const imdb = require('../src/imdb.js');
const scrape = require('../src/scrape.js');
const Bazaar = require('../src/providers/index.js');
const gestdown = require('../src/providers/gestdown.js');
const subf2m = require('../src/providers/subf2m.js');
const yifysubtitles = require('../src/providers/yifysubtitles.js');
const supersubtitles = require('../src/providers/supersubtitles.js');
const podnapisi = require('../src/providers/podnapisi.js');
const { processVideo, outputPathFor, findSubtitleSource } = require('../src/pipeline.js');

const EN_SRT = `1
00:00:01,000 --> 00:00:03,000
Hello my friend

2
00:00:04,000 --> 00:00:06,000
How are you today
`;

const AR_SRT = `1
00:00:01,000 --> 00:00:03,000
مرحبا يا صديقي

2
00:00:04,000 --> 00:00:06,000
كيف حالك اليوم
`;

/** A realistic-length subtitle: the fit check rejects toy fixtures. */
function longSRT(text = 'Hello there, this is a real subtitle line with enough words in it') {
    const lines = [];
    for (let i = 0; i < 10; i++) {
        const start = `00:00:${String(i * 5 + 1).padStart(2, '0')},000`;
        const end = `00:00:${String(i * 5 + 4).padStart(2, '0')},000`;
        lines.push(`${i + 1}\n${start} --> ${end}\n${text} ${i + 1}\n`);
    }
    return lines.join('\n');
}

function tmpDir() {
    return fs.mkdtempSync(path.join(SCRATCH, 'dir-'));
}

// ── tiny fake HTTP ────────────────────────────────────────────────────────────

function fakeHttp(routes) {
    const calls = [];
    const lookup = (url) => {
        if (routes[url] !== undefined) return routes[url];
        for (const key of Object.keys(routes)) {
            if (key.endsWith('*') && url.startsWith(key.slice(0, -1))) return routes[key];
        }
        return undefined;
    };
    return {
        calls,
        async httpGet(url, options = {}) {
            calls.push({ url, options });
            const route = lookup(url);
            if (route === undefined) throw new Error(`HTTP 404 for ${url}`);
            const payload = typeof route === 'function' ? route(url, options) : route;
            const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
            return { ok: true, status: 200, headers: { get: () => null }, url, buffer: body };
        },
        async httpGetJson(url, options = {}) {
            const res = await this.httpGet(url, options);
            return JSON.parse(res.buffer.toString('utf8'));
        }
    };
}

// ── zip writer so archive tests need no dependencies ─────────────────────────

function makeZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const content = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(content.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, content);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt32LE(content.length, 20);
        cd.writeUInt32LE(content.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, name);

        offset += local.length + name.length + content.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
}

// ── release parsing ──────────────────────────────────────────────────────────

test('parseRelease reads a movie name', () => {
    const release = releaseMod.parseRelease('/movies/Inception.2010.1080p.BluRay.x264.YIFY.mkv');
    assert.strictEqual(release.title, 'Inception');
    assert.strictEqual(release.year, 2010);
    assert.strictEqual(release.isSeries, false);
});

test('parseRelease reads a series episode', () => {
    const release = releaseMod.parseRelease('/tv/Breaking.Bad.S01E02.720p.WEB-DL.mkv');
    assert.strictEqual(release.title, 'Breaking Bad');
    assert.strictEqual(release.season, 1);
    assert.strictEqual(release.episode, 2);
    assert.strictEqual(release.isSeries, true);
});

test('parseRelease honours an NFO next to the video', () => {
    const dir = tmpDir();
    const video = path.join(dir, 'weird-name.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(path.join(dir, 'weird-name.nfo'),
        '<movie><title>El Laberinto</title><year>2006</year><imdbid>tt0457430</imdbid></movie>');

    const release = releaseMod.parseRelease(video);
    assert.strictEqual(release.title, 'El Laberinto');
    assert.strictEqual(release.year, 2006);
    assert.strictEqual(release.imdb, 'tt0457430');
});

test('parseRelease takes the season from the folder', () => {
    const release = releaseMod.parseRelease('/tv/Some Show/Season 02/Some.Show.S02E05.mkv');
    assert.strictEqual(release.season, 2);
    assert.strictEqual(release.episode, 5);
});

// ── languages ────────────────────────────────────────────────────────────────

test('langs.codeFor understands provider spellings', () => {
    assert.strictEqual(langs.codeFor('Arabic'), 'ar');
    assert.strictEqual(langs.codeFor('العربية'), 'ar');
    assert.strictEqual(langs.codeFor('eng'), 'en');
    assert.strictEqual(langs.codeFor('pt-BR'), 'pt-br');
    assert.strictEqual(langs.codeFor('Brazillian Portuguese'), 'pt-br');
    assert.strictEqual(langs.codeFor('Farsi/Persian'), 'fa');
    assert.strictEqual(langs.codeFor('what is this'), 'und');
});

test('langs.detect recognises scripts and Latin stopwords', () => {
    assert.strictEqual(langs.detect(AR_SRT), 'ar');
    assert.strictEqual(langs.detect(EN_SRT), 'en');
    assert.strictEqual(langs.detect('que de no la el es y en los se por todo'), 'es');
});

test('langs.preferenceScore puts Arabic first, then source languages', () => {
    const opts = { prefer: ['ar'], accept: ['ar', 'en', 'es'] };
    assert.ok(langs.preferenceScore('ar', opts) < langs.preferenceScore('en', opts));
    assert.ok(langs.preferenceScore('en', opts) < langs.preferenceScore('es', opts));
    assert.ok(langs.preferenceScore('es', opts) < langs.preferenceScore('de', opts));
    assert.ok(langs.preferenceScore('de', opts) < langs.preferenceScore('und', opts));
});

// ── archives ─────────────────────────────────────────────────────────────────

test('extractSubtitles reads a plain SRT', () => {
    const { files } = archives.extractSubtitles(Buffer.from(EN_SRT), 'movie.srt');
    assert.strictEqual(files.length, 1);
    assert.match(files[0].data.toString('utf8'), /Hello my friend/);
});

test('extractSubtitles reads a zip and pickSubtitle prefers .ar.', () => {
    const zip = makeZip([
        { name: 'movie.en.srt', data: EN_SRT },
        { name: 'movie.ar.srt', data: AR_SRT }
    ]);
    const { files } = archives.extractSubtitles(zip, 'movie.zip');
    assert.strictEqual(files.length, 2);
    const picked = archives.pickSubtitle(files, { prefer: ['ar'] });
    assert.match(picked.name, /\.ar\.srt$/);
});

test('extractSubtitles reads gzip and tar payloads', () => {
    const gz = archives.extractSubtitles(zlib.gzipSync(Buffer.from(EN_SRT)), 'movie.srt.gz');
    assert.strictEqual(gz.files.length, 1);
    assert.match(gz.files[0].data.toString('utf8'), /Hello/);

    // A minimal but valid tar: one header block + one data block + padding.
    const header = Buffer.alloc(512);
    header.write('movie.ar.srt', 0, 'utf8');
    header.write('00000007547', 124, 'utf8'); // size 100755 octal ≈ 33 KB
    header.writeUInt8(0x30, 156); // regular file
    header.write('ustar', 257, 'utf8');
    const tar = Buffer.concat([header, Buffer.from(AR_SRT), Buffer.alloc(1024)]);
    const unpacked = archives.extractSubtitles(tar, 'bundle.tar');
    assert.strictEqual(unpacked.files.length, 1);
});

test('looksLikeSubtitle rejects binary junk', () => {
    assert.strictEqual(archives.looksLikeSubtitle(Buffer.from([0, 1, 2, 3, 4, 0, 7])), false);
});

// ── net ──────────────────────────────────────────────────────────────────────

test('net follows redirects manually and returns the final body', async () => {
    const calls = [];
    net.setFetchImpl(async (url) => {
        calls.push(url);
        if (url === 'http://example.test/start') {
            return {
                ok: false, status: 302,
                headers: { get: (h) => (h === 'location' ? 'http://example.test/end' : null) },
                body: null, arrayBuffer: async () => new ArrayBuffer(0)
            };
        }
        return {
            ok: true, status: 200, headers: { get: () => null },
            body: null, arrayBuffer: async () => Buffer.from('done')
        };
    });
    try {
        const res = await net.httpGetText('http://example.test/start');
        assert.strictEqual(res, 'done');
        assert.deepStrictEqual(calls, ['http://example.test/start', 'http://example.test/end']);
    } finally {
        net.resetFetchImpl();
    }
});

test('net turns an error status into a throw with a snippet', async () => {
    net.setFetchImpl(async () => ({
        ok: false, status: 404, headers: { get: () => null },
        body: null, arrayBuffer: async () => Buffer.from('<html>nothing here</html>')
    }));
    try {
        await assert.rejects(() => net.httpGet('http://example.test/missing'), /HTTP 404.*nothing here/);
    } finally {
        net.resetFetchImpl();
    }
});

test('net refuses an oversized body', async () => {
    net.setFetchImpl(async () => ({
        ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? '999999999' : null) },
        body: null, arrayBuffer: async () => Buffer.alloc(0)
    }));
    try {
        await assert.rejects(() => net.httpGet('http://example.test/big', { maxBytes: 1024 }), /too large/);
    } finally {
        net.resetFetchImpl();
    }
});

// ── provider health / backoff ────────────────────────────────────────────────

test('provider health backs off further with every consecutive failure', () => {
    const id = `demo-${Date.now()}`;
    health.reset();
    assert.strictEqual(health.snapshot([{ id, label: id }])[0].status, 'Good');

    health.markFailure(id, new Error('ETIMEDOUT'));
    assert.strictEqual(health.snapshot([{ id, label: id }])[0].status, 'ConnectionError');
    assert.strictEqual(health.snapshot([{ id, label: id }])[0].nextRetry, 'in 1 minute');
    assert.deepStrictEqual(health.cooldown(id).cooling, true);

    health.markFailure(id, new Error('ETIMEDOUT'));
    assert.strictEqual(health.snapshot([{ id, label: id }])[0].nextRetry, 'in 2 minutes');
    assert.strictEqual(health.backoffMs(3), 4 * 60 * 1000);
    assert.strictEqual(health.backoffMs(20), health.backoffMs(20)); // capped, no throw

    health.markSuccess(id);
    assert.strictEqual(health.snapshot([{ id, label: id }])[0].status, 'Good');
    assert.strictEqual(health.cooldown(id).cooling, false);

    health.markUnavailable(id, 'no api key');
    assert.strictEqual(health.snapshot([{ id, label: id }])[0].status, 'Not configured');
});

// ── IMDb resolution ──────────────────────────────────────────────────────────

test('imdb.resolveImdbId picks the best suggestion and caches it', async () => {
    imdb.clearCache();
    const http = fakeHttp({
        'https://v3.sg.media-imdb.com/suggestion/x/The%20Matrix.json?includeVideos=0': JSON.stringify({
            d: [
                { id: 'in0000304', l: 'The Matrix', q: 'TV series', qid: 'tvSeries' },
                { id: 'tt0234215', l: 'The Matrix Reloaded', y: 2003, qid: 'movie' },
                { id: 'tt0133093', l: 'The Matrix', y: 1999, qid: 'movie' }
            ]
        })
    });
    const release = { title: 'The Matrix', year: 1999, isSeries: false, queries: [] };
    const id = await imdb.resolveImdbId(release, { http });
    assert.strictEqual(id, 'tt0133093');
    assert.strictEqual(http.calls.length, 1);

    // Second call is served from the cache: no extra HTTP traffic.
    const again = await imdb.resolveImdbId({ title: 'The Matrix', year: 1999, isSeries: false, queries: [] }, { http });
    assert.strictEqual(again, 'tt0133093');
    assert.strictEqual(http.calls.length, 1);
});

// ── provider parsers (fixtures, no network) ──────────────────────────────────

const GESTDOWN_SHOWS = {
    shows: [{ id: '5c2b1f', name: 'Breaking Bad', imdbId: 'tt0903747', seasons: [1, 2, 3, 4, 5] }]
};
const GESTDOWN_SUBS = {
    matchingSubtitles: [
        { subtitleId: 'aaa', language: 'english', version: 'BluRay-CtrlHD', downloadCount: 120, source: 'Addic7ed' },
        { subtitleId: 'bbb', language: 'arabic', version: 'WEB-DL', downloadCount: 30, source: 'Addic7ed' }
    ]
};

test('gestdown search finds the show and offers both languages', async () => {
    const http = fakeHttp({
        'https://api.gestdown.info/shows/search/Breaking%20Bad': JSON.stringify(GESTDOWN_SHOWS),
        'https://api.gestdown.info/subtitles/get/5c2b1f/1/2/english': JSON.stringify(GESTDOWN_SUBS),
        'https://api.gestdown.info/subtitles/get/5c2b1f/1/2/arabic': JSON.stringify({ matchingSubtitles: [] })
    });
    const release = releaseMod.parseRelease('/tv/Breaking.Bad.S01E02.720p.mkv');
    const found = await gestdown.search(release, { http, sourceLanguages: ['ar', 'en'] });
    assert.strictEqual(found.length, 2);
    assert.deepStrictEqual(found.map((c) => c.langCode).sort(), ['ar', 'en']);
    assert.strictEqual(found[0].season, 1);
    assert.strictEqual(found[0].episode, 2);
});

test('yify parses a movie page and needs an IMDb id', async () => {
    const row = (id, lang, slug, release) => `<tr data-id="${id}"><td><a href="/subtitles/${slug}">` +
        `<span class="sub-lang">${lang}</span></a><span class="label label-success">12</span>` +
        `<br>${release}</td></tr>`;
    const html = `<table>${row(1, 'Arabic', 'Sub.One.Arabic', 'Inception.2010.720p.BRRip')}` +
        `${row(2, 'English', 'Sub.Two', 'Inception.2010.1080p.BluRay')}</table>`;
    const http = fakeHttp({ 'https://yifysubtitles.ch/movie-imdb/tt1375666': html });

    const release = { title: 'Inception', year: 2010, isSeries: false, imdb: 'tt1375666', queries: [] };
    const found = await yifysubtitles.search(release, { http });
    assert.strictEqual(found.length, 2);
    assert.strictEqual(found[0].langCode, 'ar');
    assert.match(found[0].extra.downloadUrl, /\/subtitle\/Sub\.One\.Arabic\.zip$/);

    const withoutId = await yifysubtitles.search({ ...release, imdb: null }, { http });
    assert.deepStrictEqual(withoutId, []);
});

test('supersubtitles translates Hungarian labels and drops other movies', async () => {
    const row = (lang, file, title) => `<tr id="vilagit"><td><small>${lang}</small></td>` +
        `<td><a href="/index.php?action=letolt&fnev=${file}&felirat=1">x</a></td>` +
        `<td><div class="eredeti">${title}</div></td>` +
        `<td align="center">uploader</td><td align="center">2020-01-02</td></tr>`;
    const html = `${row('Angol', 'Inception.2010.720p.srt', 'Inception.2010.720p.BRRip')}` +
        `${row('Arab', 'Inception.2010.ar.srt', 'Inception.2010.720p.BRRip')}` +
        `${row('Angol', 'The.Drop.1x02.srt', 'The Drop - 1x02 - Street Matrix')}`;
    const http = fakeHttp({
        'https://feliratok.eu/index.php?sorrend=ido&irany=desc&search=Inception&sid=1': html
    });
    const release = releaseMod.parseRelease('/movies/Inception.2010.1080p.BluRay.mkv');
    const found = await supersubtitles.search(release, { http });
    assert.strictEqual(found.length, 2);
    assert.ok(found.some((c) => c.langCode === 'ar'));
    assert.ok(found.some((c) => c.langCode === 'en'));
    assert.ok(!found.some((c) => /Drop/.test(c.releaseName)));
});

test('subf2m reads the language tabs and the details download link', async () => {
    const titlePage = '<a href="/subtitles/inception/arabic">Arabic 71</a>' +
        '<a href="/subtitles/inception/english">English 141</a>';
    const langPage = `<ul><li class='item'><a href='/subtitles/inception/arabic/1234'>` +
        `<span class='language'>Arabic</span><ul><li>Inception.2010.1080p.BRRip</li></ul></a></li></ul>`;
    const details = `<a href="/subtitles/inception-ar-arabic-1234/download">Download</a>`;
    const http = fakeHttp({
        'https://subf2m.co/subtitles/inception': titlePage,
        'https://subf2m.co/subtitles/inception/arabic': langPage,
        'https://subf2m.co/subtitles/inception/english': langPage,
        'https://subf2m.co/subtitles/inception/arabic/1234': details,
        'https://subf2m.co/subtitles/inception-ar-arabic-1234/download': EN_SRT
    });
    const release = releaseMod.parseRelease('/movies/Inception.2010.1080p.BluRay.mkv');
    const found = await subf2m.search(release, { http, sourceLanguages: ['ar', 'en'] });
    assert.ok(found.length >= 2);
    assert.strictEqual(found[0].langCode, 'ar');

    const downloaded = await subf2m.download(found[0], { http });
    assert.match(downloaded.data.toString('utf8'), /Hello my friend/);
});

test('podnapisi reads the legacy XML', async () => {
    const xml = `<?xml version="1.0"?><results><subtitles>
        <subtitle><pid>abc123</pid><title>Inception</title>
        <language>en</language><year>2010</year><url>https://www.podnapisi.net/subtitles/abc123</url>
        </subtitle></subtitles></results>`;
    const http = fakeHttp({ 'https://www.podnapisi.net/subtitles/search/old?sXML=1&sK=Inception&sY=2010': xml });
    const release = releaseMod.parseRelease('/movies/Inception.2010.1080p.mkv');
    const found = await podnapisi.search(release, { http });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].langCode, 'en');
});

// ── ranking / acquiring ──────────────────────────────────────────────────────

function candidate(over) {
    return Object.assign({
        provider: 'subf2m',
        id: '1',
        langCode: 'en',
        releaseName: 'Inception.2010.1080p.BluRay',
        providerPriority: 3
    }, over);
}

test('rankCandidates prefers Arabic, then source languages, then year matches', () => {
    const release = { title: 'Inception', year: 2010, baseName: 'Inception.2010.1080p.BluRay.x264' };
    const ranked = Bazaar.rankCandidates([
        candidate({ id: 'de', langCode: 'de' }),
        candidate({ id: 'en-old', langCode: 'en', releaseName: 'Inception.720p.WEB' }),
        candidate({ id: 'en-year', langCode: 'en', releaseName: 'Inception.2010.1080p.BluRay' }),
        candidate({ id: 'ar', langCode: 'ar' })
    ], release, { sourceLanguages: ['ar', 'en'] });

    assert.strictEqual(ranked[0].id, 'ar');
    assert.ok(ranked.findIndex((c) => c.id === 'en-year') < ranked.findIndex((c) => c.id === 'en-old'));
    assert.strictEqual(ranked[ranked.length - 1].id, 'de');
});

test('acquire walks the ranked candidates until one really parses', async () => {
    const flushing = candidate({ id: 'flaky', provider: 'fake-flaky', langCode: 'en', providerPriority: 3 });
    const working = candidate({ id: 'good', provider: 'fake-good', langCode: 'en', providerPriority: 4 });

    const fakes = [
        { id: 'fake-flaky', label: 'fake-flaky', priority: 3, download: async () => { throw new Error('HTTP 503'); } },
        { id: 'fake-good', label: 'fake-good', priority: 4, download: async () => ({ name: 'right.zip', data: makeZip([{ name: 'movie.en.srt', data: longSRT() }]) }) }
    ];
    for (const fake of fakes) Bazaar.REGISTRY.push(fake);
    try {
        const searchResult = { candidates: [flushing, working], ctx: {}, perProvider: {}, notes: [] };
        const res = await Bazaar.acquire(
            { title: 'Inception', videoPath: path.join(SCRATCH, 'Inception.mkv') },
            { searchResult, maxTries: 5 }
        );
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.provider, 'fake-good');
        assert.strictEqual(res.langCode, 'en');
        assert.strictEqual(res.cues.length, 10);
        assert.strictEqual(res.fit.ok, true);
        assert.ok(res.notes.some((n) => /503/.test(n)));
        assert.deepStrictEqual(res.attempts.map((a) => a.outcome), ['failed', 'downloaded']);
    } finally {
        for (const fake of fakes) {
            const index = Bazaar.REGISTRY.indexOf(fake);
            if (index >= 0) Bazaar.REGISTRY.splice(index, 1);
        }
    }
});

test('acquire falls through when every download fails', async () => {
    const fake = { id: 'fake-dead', label: 'fake-dead', priority: 3, download: async () => { throw new Error('HTTP 500'); } };
    Bazaar.REGISTRY.push(fake);
    try {
        const searchResult = {
            candidates: [candidate({ provider: 'fake-dead' })],
            ctx: {}, perProvider: {}, notes: []
        };
        const res = await Bazaar.acquire({ title: 'X', videoPath: '/tmp/X.mkv' }, { searchResult, maxTries: 2 });
        assert.strictEqual(res.ok, false);
        assert.ok(res.notes.length > 0);
    } finally {
        const index = Bazaar.REGISTRY.indexOf(fake);
        if (index >= 0) Bazaar.REGISTRY.splice(index, 1);
    }
});

test('searchAll skips key-based providers when their key is missing', async () => {
    delete process.env.SUBDL_API_KEY;
    delete process.env.OPENSUBTITLES_API_KEY;
    const res = await Bazaar.searchAll(
        { title: 'Nothing', queries: [{ title: 'Nothing' }], videoPath: '/tmp/nothing.mkv' },
        { only: ['subdl', 'opensubtitlescom'], resolveImdb: false, sourceLanguages: ['ar'] }
    );
    assert.strictEqual(res.candidates.length, 0);
    assert.match(res.perProvider.subdl.error, /key/i);
    assert.match(res.perProvider.opensubtitlescom.error, /key/i);
});

test('searchAll resolves a missing IMDb id through the free lookup', async () => {
    const http = fakeHttp({
        'https://v3.sg.media-imdb.com/suggestion/x/Inception.json?includeVideos=0': JSON.stringify({
            d: [{ id: 'tt1375666', l: 'Inception', y: 2010, qid: 'movie' }]
        }),
        'https://yifysubtitles.ch/movie-imdb/tt1375666': '<table></table>'
    });
    const release = { title: 'Inception', year: 2010, isSeries: false, queries: [{ title: 'Inception' }], videoPath: '/tmp/I.mkv' };
    const res = await Bazaar.searchAll(release, { only: ['yifysubtitles'], http, sourceLanguages: ['ar'] });
    assert.strictEqual(release.imdb, 'tt1375666');
    assert.ok(res.notes.includes('imdb:tt1375666'));
});

// ── sidecars ─────────────────────────────────────────────────────────────────

test('sidecarName matches the local scan and avoids collisions', () => {
    const dir = tmpDir();
    const video = path.join(dir, 'Movie.mkv');
    fs.writeFileSync(video, '');
    const first = Bazaar.sidecarName(video, 'ar', 'subf2m');
    assert.strictEqual(path.basename(first), 'Movie.ar.srt');
    fs.writeFileSync(first, AR_SRT);

    const second = Bazaar.sidecarName(video, 'ar', 'subf2m');
    assert.strictEqual(path.basename(second), 'Movie.ar.subf2m.srt');

    const saved = Bazaar.saveSidecar(video, 'en', 'gestdown', [
        { start: '00:00:01,000', end: '00:00:02,000', text: 'Hi' },
        { start: '00:00:03,000', end: '00:00:04,000', text: 'There' }
    ]);
    assert.match(fs.readFileSync(saved, 'utf8'), /Hi/);

    const source = findSubtitleSource(video);
    assert.strictEqual(source.kind, 'arabic', 'the saved Arabic sidecar wins the local scan');
    assert.strictEqual(source.langCode, 'ar');
});

// ── pipeline integration (fake bazaar, no network, no ffprobe) ───────────────

function fakeBazaar(result) {
    const calls = { acquire: [], saved: [] };
    return {
        calls,
        async acquire(release, options) {
            calls.acquire.push({ release, options });
            return result;
        },
        saveSidecar(videoPath, langCode, providerId, cues) {
            calls.saved.push({ langCode, providerId, count: cues.length });
            const file = path.join(path.dirname(videoPath),
                `${path.basename(videoPath, path.extname(videoPath))}.${langCode}.srt`);
            fs.writeFileSync(file, Bazaar.serializeSRT(cues), 'utf8');
            return file;
        }
    };
}

test('processVideo brands an Arabic download without the model', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'Movie.2020.1080p.mkv');
    fs.writeFileSync(video, '');

    const bazaar = fakeBazaar({
        ok: true,
        provider: 'subf2m',
        langCode: 'ar',
        cues: [{ start: '00:00:01,000', end: '00:00:03,000', text: 'مرحبا' }],
        tried: []
    });
    const res = await processVideo(video, {
        providers: true, embedded: false, audio: false, bazaar, server: null, log: () => { }
    });

    assert.strictEqual(res.status, 'branded');
    assert.strictEqual(res.provider, 'subf2m');
    assert.ok(fs.existsSync(outputPathFor(video)));
    assert.deepStrictEqual(bazaar.calls.saved, [{ langCode: 'ar', providerId: 'subf2m', count: 1 }]);
    assert.ok(fs.existsSync(path.join(dir, 'Movie.2020.1080p.ar.srt')), 'sidecar written next to the video');
});

test('processVideo translates a non-Arabic download and remembers the source', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'Movie2.2020.1080p.mkv');
    fs.writeFileSync(video, '');

    const bazaar = fakeBazaar({
        ok: true,
        provider: 'gestdown',
        langCode: 'en',
        cues: [{ start: '00:00:01,000', end: '00:00:03,000', text: 'Hello' }],
        tried: []
    });
    const logs = [];
    const res = await processVideo(video, {
        providers: true,
        embedded: false,
        audio: false,
        bazaar,
        server: { async translate(texts) { return texts.map(() => 'مرحبا'); } },
        log: (entry) => logs.push(entry)
    });

    assert.strictEqual(res.status, 'translated');
    assert.strictEqual(res.language, 'en');
    assert.strictEqual(res.source, 'downloaded');
    assert.strictEqual(logs[0].action, 'translate');
    assert.strictEqual(logs[0].provider, 'gestdown');
    assert.deepStrictEqual(bazaar.calls.saved, [{ langCode: 'en', providerId: 'gestdown', count: 1 }]);
});

test('processVideo never shops online when a local subtitle exists', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'Local.2021.mkv');
    fs.writeFileSync(video, '');
    fs.writeFileSync(path.join(dir, 'Local.2021.en.srt'), EN_SRT);

    const bazaar = fakeBazaar({ ok: true, provider: 'x', langCode: 'ar', cues: [], tried: [] });
    const res = await processVideo(video, {
        providers: true,
        embedded: false,
        audio: false,
        bazaar,
        server: { async translate() { return ['مرحبا', 'مرحبا']; } },
        log: () => { }
    });

    assert.strictEqual(res.status, 'translated');
    assert.strictEqual(res.source, 'local-subtitle');
    assert.strictEqual(bazaar.calls.acquire.length, 0, 'the bazaar is not touched when a sidecar exists');
});

test('processVideo reports why it skipped when everything is empty', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'Nothing.2021.mkv');
    fs.writeFileSync(video, '');

    const bazaar = fakeBazaar({ ok: false, tried: [], notes: ['subf2m: nothing'] });
    const logs = [];
    const res = await processVideo(video, {
        providers: true,
        embedded: false,
        audio: false,
        bazaar,
        log: (entry) => logs.push(entry)
    });

    assert.strictEqual(res.status, 'skipped');
    assert.strictEqual(res.reason, 'no-subtitle');
    assert.strictEqual(logs[0].action, 'skip');
    assert.ok(logs[0].notes.some((n) => /subf2m/.test(n)));
});

test('acquire decodes an Arabic Windows-1256 download instead of mojibake', async () => {
    const CP1256 = { 'م': 0xe3, 'ر': 0xd1, 'ح': 0xcd, 'ب': 0xc8, 'ا': 0xc7 };
    const cp1256 = (text) => Buffer.from([...text].map((ch) => {
        const code = ch.codePointAt(0);
        if (code < 128) return code; // ASCII (timestamps, digits, arrows) is identical
        return CP1256[ch] ?? 0x3f;
    }), 'latin1');
    const line = 'مرحبا'.repeat(8); // 40 chars per cue × 10 cues = 400 visible chars
    let srt = '';
    for (let i = 0; i < 10; i++) {
        const start = `00:00:${String(i * 5 + 1).padStart(2, '0')},000`;
        const end = `00:00:${String(i * 5 + 4).padStart(2, '0')},000`;
        srt += `${i + 1}\n${start} --> ${end}\n${line}\n\n`;
    }
    const payload = cp1256(srt);
    const fake = {
        id: 'fake-legacy',
        label: 'fake-legacy',
        priority: 3,
        download: async () => ({ name: 'legacy.zip', data: makeZip([{ name: 'movie.ar.srt', data: payload }]) })
    };
    Bazaar.REGISTRY.push(fake);
    try {
        const searchResult = {
            candidates: [candidate({ provider: 'fake-legacy', langCode: 'ar' })],
            ctx: {}, perProvider: {}, notes: []
        };
        const res = await Bazaar.acquire({ title: 'X', videoPath: '/tmp/X.mkv' }, { searchResult, maxTries: 2 });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.langCode, 'ar');
        assert.match(res.cues[0].text, /مرحبا/);
    } finally {
        const index = Bazaar.REGISTRY.indexOf(fake);
        if (index >= 0) Bazaar.REGISTRY.splice(index, 1);
    }
});

test('acquire rejects a candidate that fails the fit check and keeps trying', async () => {
    const weak = {
        id: 'fake-weak',
        label: 'fake-weak',
        priority: 3,
        download: async () => ({ name: 'signs.zip', data: makeZip([{ name: 'movie.en.srt', data: EN_SRT }]) })
    };
    const good = {
        id: 'fake-good2',
        label: 'fake-good2',
        priority: 4,
        download: async () => ({ name: 'full.zip', data: makeZip([{ name: 'movie.en.srt', data: longSRT() }]) })
    };
    Bazaar.REGISTRY.push(weak, good);
    try {
        const searchResult = {
            candidates: [
                candidate({ id: 'signs', provider: 'fake-weak', langCode: 'en' }),
                candidate({ id: 'full', provider: 'fake-good2', langCode: 'en' })
            ],
            ctx: {}, perProvider: {}, notes: []
        };
        const res = await Bazaar.acquire({ title: 'X', videoPath: '/tmp/X.mkv' }, { searchResult, maxTries: 5 });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.provider, 'fake-good2');
        assert.strictEqual(res.attempts[0].outcome, 'rejected');
        assert.match(res.attempts[0].reason, /too-few-cues/);
    } finally {
        for (const fake of [weak, good]) {
            const index = Bazaar.REGISTRY.indexOf(fake);
            if (index >= 0) Bazaar.REGISTRY.splice(index, 1);
        }
    }
});

test('checkFit enforces cues, visible characters and duration range', () => {
    assert.strictEqual(Bazaar.checkFit([{ end: '00:00:01,000', text: 'hi' }]).reason, 'too-few-cues');

    const many = [];
    for (let i = 0; i < 10; i++) many.push({ start: '00:00:01,000', end: '00:00:02,000', text: 'x' });
    assert.strictEqual(Bazaar.checkFit(many).reason, 'signs-only');

    const healthy = [];
    for (let i = 0; i < 10; i++) {
        healthy.push({ start: '00:00:01,000', end: `00:0${i}:30,000`, text: 'A fully written subtitle line with plenty of visible words' });
    }
    assert.strictEqual(Bazaar.checkFit(healthy).ok, true);
    assert.strictEqual(Bazaar.checkFit(healthy, { durationMs: 30 * 1000 }).reason, 'out-of-range');
    assert.strictEqual(Bazaar.checkFit(healthy, { durationMs: 10 * 60 * 1000 }).ok, true);
});

test('scrape.yearConflict understands remake titles', () => {
    assert.strictEqual(scrape.yearConflict('The Matrix Resurrections (2021)', { year: 1999 }), true);
    assert.strictEqual(scrape.yearConflict('The Matrix 1999 REMASTERED', { year: 1999 }), false);
    assert.strictEqual(scrape.yearConflict('The Matrix', { year: 1999 }), false);
});
