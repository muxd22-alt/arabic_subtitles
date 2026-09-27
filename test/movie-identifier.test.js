const test = require('node:test');
const assert = require('node:assert/strict');
const { identifyMovie, cleanTitleFallback, isValidYear } = require('../movie-identifier.js');

test('identifies hard sci-fi release names', () => {
    const result = identifyMovie('Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv');
    assert.equal(result.title, 'Interstellar');
    assert.equal(result.year, 2014);
    assert.equal(result.type, 'movie');
    assert.equal(result.source, 'parse-torrent-title');

    const dune = identifyMovie('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv');
    assert.equal(dune.title, 'Dune Part Two');
    assert.equal(dune.year, 2024);
});

test('identifies zombie-horror release names', () => {
    const result = identifyMovie('Zombieland.2009.720p.BluRay.x264-REFINE.mkv');
    assert.equal(result.title, 'Zombieland');
    assert.equal(result.year, 2009);

    const quiet = identifyMovie('A.Quiet.Place.2018.1080p.WEB-DL.x264-SPARKS.mkv');
    assert.equal(quiet.title, 'A Quiet Place');
    assert.equal(quiet.year, 2018);
});

test('identifies TV episodes with season/episode', () => {
    const result = identifyMovie('The.Walking.Dead.S05E03.720p.HDTV.x264-IMMERSE.mkv');
    assert.equal(result.title, 'The Walking Dead');
    assert.equal(result.season, 5);
    assert.equal(result.episode, 3);
    assert.equal(result.type, 'episode');
    assert.equal(result.year, null);
});

test('handles bracketed and spaced year formats', () => {
    const bracketed = identifyMovie('The Matrix (1999) [1080p].mkv');
    assert.equal(bracketed.title, 'The Matrix');
    assert.equal(bracketed.year, 1999);
});

test('falls back to a cleaned title when no year is present', () => {
    const result = identifyMovie('Some.Weird.Film.1080p.WEB.mkv');
    assert.equal(result.title, 'Some Weird Film');
    assert.equal(result.year, null);
    assert.ok(result.title.length >= 2);
});

test('handles Arabic filenames', () => {
    const result = identifyMovie('فيلم.العجوز.والبحر.2019.mkv');
    assert.equal(result.title, 'فيلم العجوز والبحر');
    assert.equal(result.year, 2019);
});

test('accepts full paths and strips directories', () => {
    const result = identifyMovie('C:\\media\\Arrival.2016.720p.BluRay.x264.mkv');
    assert.equal(result.title, 'Arrival');
    assert.equal(result.year, 2016);

    const posix = identifyMovie('/sdcard/Movies/Arrival.2016.720p.mkv');
    assert.equal(posix.title, 'Arrival');
});

test('rejects noise-only names instead of inventing a title', () => {
    assert.equal(identifyMovie('___1080p___').title, null);
    assert.equal(identifyMovie('.mkv').title, null);
    assert.equal(identifyMovie('').title, null);
    assert.equal(identifyMovie('x264').title, null);
});

test('rejects implausible years', () => {
    const result = identifyMovie('Some.Film.1802.720p.mkv');
    assert.equal(result.year, null);
    assert.equal(isValidYear(1802), false);
    assert.equal(isValidYear(2014), true);
    assert.equal(isValidYear('2014'), false);
});

test('cleanTitleFallback strips release noise', () => {
    assert.equal(cleanTitleFallback('Interstellar 2014 1080p BluRay x264-SPARKS'), 'Interstellar');
    assert.equal(cleanTitleFallback('Movie.Name.720p.WEB-DL.H.264'), 'Movie Name');
});
