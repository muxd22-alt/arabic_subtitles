const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chokidar = require('chokidar');
const { identifyMovie } = require('./movie-identifier.js');
const { findSubtitle } = require('./subtitle-finder.js');
const { parseSRT, buildSRT, timeToMs, msToTime, normalizeToUtf8 } = require('./srt-utils.js');
const { logDecision } = require('./decision-log.js');

// Global error handlers to prevent socket/fetch terminations from abruptly stopping the daemon
process.on('unhandledRejection', (reason) => {
    console.error('[SubArabify Warning] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[SubArabify Warning] Uncaught Exception:', err);
});

// Parse --media folder argument (defaults to /sdcard/Movies)
const args = process.argv.slice(2);
const mediaIdx = args.indexOf('--media');
const MEDIA_DIR = mediaIdx !== -1 ? args[mediaIdx + 1] : '/sdcard/Movies';

// Sequential Processing Queue
const fileQueue = [];
const processingFiles = new Set();
let isProcessingQueue = false;
let videoProcessor = processVideoFile;

function setVideoProcessor(fn) {
    videoProcessor = fn;
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (fileQueue.length > 0) {
        const filePath = fileQueue.shift();
        console.log(`[Queue] Processing file (${fileQueue.length} remaining): ${path.basename(filePath)}`);
        try {
            await videoProcessor(filePath);
        } catch (err) {
            console.error(`[Queue Error] Error processing ${path.basename(filePath)}:`, err.message || err);
        } finally {
            processingFiles.delete(filePath);
        }
    }

    isProcessingQueue = false;
}

function enqueueFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.mp4', '.mkv', '.avi', '.m4v'].includes(ext)) return false;

    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ext);
    const arSrtPath = path.join(dir, `${baseName}.SubArabify.ar.srt`);

    if (fs.existsSync(arSrtPath)) return false;
    if (processingFiles.has(filePath)) return false;

    processingFiles.add(filePath);
    fileQueue.push(filePath);
    console.log(`[Queue] Enqueued: ${path.basename(filePath)} (Total queued: ${fileQueue.length})`);
    processQueue().catch(e => console.error('[Queue Error]', e));
    return true;
}

// SRT parsing/building now lives in srt-utils.js (shared with the finder).

// Pipeline hook — swappable in tests; the default is the real finder.
let subtitleFinder = findSubtitle;

function setSubtitleFinder(fn) { subtitleFinder = fn; }

// File Processor & Folder Monitor
// Pipeline: existing branded output → skip | ready-made Arabic → brand only |
// ready-made English or nothing → skip (AI translation/transcription removed).
async function processVideoFile(videoPath) {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const baseName = path.basename(videoPath, ext);
  const arSrtPath = path.join(dir, `${baseName}.SubArabify.ar.srt`);

  if (fs.existsSync(arSrtPath)) {
    logDecision({ file: videoPath, action: 'skip', reason: 'existing-output' });
    return;
  }

  let result = null;
  try {
    const movie = identifyMovie(baseName);
    console.log(`[Finder] Identified: "${movie.title}"${movie.year ? ` (${movie.year})` : ''} — looking for subtitles...`);
    result = await subtitleFinder(videoPath, { movie });
  } catch (err) {
    console.error(`[Finder] Subtitle lookup failed for ${path.basename(videoPath)}: ${err.message}`);
    logDecision({ file: videoPath, action: 'finder-error', reason: err.message });
  }

  if (result && result.status === 'found' && result.language === 'ar') {
    const { text } = normalizeToUtf8(fs.readFileSync(result.path));
    const cues = parseSRT(text);
    if (cues.length > 0) {
      fs.writeFileSync(arSrtPath, buildSRT(cues), 'utf8');
      logDecision({
        file: videoPath,
        action: 'brand-arabic',
        language: 'ar',
        source: result.source,
        match: result.match,
        provider: result.provider,
        cueCount: cues.length
      });
      console.log(`[Success] Ready-made Arabic subtitle branded (no translation): ${path.basename(arSrtPath)}`);
      return;
    }
  }

  if (result && result.status === 'found' && result.language === 'en') {
    logDecision({
      file: videoPath,
      action: 'skip-english',
      language: 'en',
      source: result.source,
      match: result.match,
      provider: result.provider,
      cueCount: result.cueCount,
      reason: 'AI translation removed — English subtitle cannot be converted'
    });
    console.log(`[Finder] English subtitle found for ${path.basename(videoPath)}, but AI translation was removed — skipping.`);
    return;
  }

  logDecision({ file: videoPath, action: 'no-subtitle', reason: 'no-arabic-subtitle-found' });
  console.log(`[Finder] No Arabic subtitle for ${path.basename(videoPath)} — nothing to brand, skipping.`);
}

// Initial full-scan on boot + active watching
async function start() {
    // Auto-update check
    try {
        console.log('[SubArabify] 🔄 Checking for updates from GitHub...');
        execSync('git pull --rebase', { stdio: 'inherit', cwd: __dirname });
        console.log('[SubArabify] ✅ Up to date!');
    } catch (e) {
        console.log('[SubArabify] ⚠️ Note: Could not auto-update from git. Skipping.');
    }

    console.log(`[SubArabify] Active and watching: ${MEDIA_DIR}`);

    const watcher = chokidar.watch(MEDIA_DIR, { persistent: true, depth: 4, awaitWriteFinish: true });
    watcher.on('add', filePath => {
      enqueueFile(filePath);
    });
}

if (require.main === module) {
    start();
}

module.exports = {
    parseSRT,
    buildSRT,
    timeToMs,
    msToTime,
    processVideoFile,
    setVideoProcessor,
    setSubtitleFinder,
    identifyMovie,
    findSubtitle,
    logDecision,
    enqueueFile,
    processQueue,
    fileQueue,
    processingFiles,
    start
};
