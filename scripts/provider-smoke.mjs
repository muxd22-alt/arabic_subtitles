#!/usr/bin/env node
/**
 * Live smoke test for the subtitle bazaar — this one really talks to the sites.
 *
 *   node scripts/provider-smoke.mjs                       # the default titles
 *   node scripts/provider-smoke.mjs "Inception 2010" "Breaking Bad S01E01"
 *
 * It prints, per provider, how many candidates came back, then ranks them and
 * (unless --no-download) downloads the best one to prove the whole path:
 * search → rank → download → unpack → parse.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Bazaar = require(path.join(root, 'src/providers/index.js'));
const { parseRelease } = require(path.join(root, 'src/release.js'));

const args = process.argv.slice(2);
const noDownload = args.includes('--no-download');
const titles = args.filter((a) => !a.startsWith('--'));
if (titles.length === 0) {
    titles.push(
        'Inception.2010.1080p.BluRay.x264.mkv',
        'Breaking.Bad.S01E01.720p.WEB-DL.mkv',
        'The.Matrix.1999.1080p.BluRay.x264.mkv'
    );
}

async function main() {
    let failures = 0;

    for (const title of titles) {
        const videoPath = path.isAbsolute(title) ? title : `/tmp/${title}`;
        const release = parseRelease(videoPath);
        const episode = release.season != null
            ? ` S${String(release.season).padStart(2, '0')}E${String(release.episode).padStart(2, '0')}`
            : '';
        console.log(`\n=== ${title}`);
        console.log(`    title="${release.title}" year=${release.year ?? '-'}${episode}${release.imdb ? ` imdb=${release.imdb}` : ''}`);

        const search = await Bazaar.searchAll(release, { sourceLanguages: ['ar', 'en'] });
        for (const [id, info] of Object.entries(search.perProvider)) {
            const note = info.error ? ` — ${info.error}` : (info.skipped ? ` — ${info.skipped}` : '');
            console.log(`    ${id.padEnd(18)} ${String(info.count).padStart(3)} candidate(s)${note}`);
        }

        const ranked = Bazaar.rankCandidates(search.candidates, release, { sourceLanguages: ['ar', 'en'] });
        for (const candidate of ranked.slice(0, 8)) {
            console.log(`      • ${String(candidate.provider).padEnd(16)} ${String(candidate.langCode).padEnd(5)} ` +
                `${String(candidate.releaseName || '').slice(0, 70)}`);
        }

        if (ranked.length === 0) {
            console.log('    (nothing — the on-device transcript would be next)');
            failures++;
            continue;
        }
        if (noDownload) continue;

        const acquired = await Bazaar.acquire(release, { searchResult: search, sourceLanguages: ['ar', 'en'] });
        if (!acquired.ok) {
            console.log(`    DOWNLOAD FAILED: ${(acquired.notes || []).join(' | ')}`);
            failures++;
            continue;
        }
        const first = acquired.cues[0];
        console.log(`    ACQUIRED ${acquired.provider}/${acquired.langCode} — ${acquired.cues.length} cues` +
            ` (${acquired.fileName})`);
        console.log(`      ${first.start} --> ${first.end} | ${String(first.text).slice(0, 70).replace(/\n/g, ' ⏎ ')}`);
    }

    console.log(`\n${failures === 0 ? 'All good.' : `${failures} cas(es) without a downloadable subtitle.`}`);
    return failures === 0 ? 0 : 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('smoke test failed:', error);
        process.exit(1);
    });
