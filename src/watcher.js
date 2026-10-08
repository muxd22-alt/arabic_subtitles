const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const { isDone } = require('./pipeline.js');

function walkMedia(rootDir, options = {}) {
    const exts = options.videoExts || config.VIDEO_EXTS;
    const maxDepth = options.maxDepth || 8;
    const found = [];

    function walk(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile() && exts.includes(path.extname(entry.name).toLowerCase())) {
                found.push(full);
            }
        }
    }

    walk(rootDir, 0);
    return found;
}

/**
 * Sequential job queue with de-duplication. One video at a time keeps the
 * phone cool while *inside* each video the subtitle chunks run in parallel.
 */
class JobQueue {
    constructor(options = {}) {
        this.process = options.process || null;
        this.pending = [];
        this.queued = new Set();
        this.active = new Set();
        this.done = new Set();
        this.failed = new Set();
        this.running = false;
        this.current = null;
        this.listeners = new Set();
    }

    onEvent(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(event) {
        for (const fn of this.listeners) {
            try { fn(event); } catch (e) { }
        }
    }

    enqueue(filePath, front = false) {
        const resolved = path.resolve(filePath);
        if (this.done.has(resolved) || this.queued.has(resolved) || this.active.has(resolved)) return false;
        if (this.failed.has(resolved) && !front) return false;
        if (front) this.pending.unshift(resolved);
        else this.pending.push(resolved);
        this.queued.add(resolved);
        this.emit({ type: 'enqueue', file: resolved, pending: this.pending.length });
        this._drain();
        return true;
    }

    enqueueAll(files) {
        let added = 0;
        for (const file of files) if (this.enqueue(file)) added++;
        return added;
    }

    requeueFailures() {
        const files = [...this.failed];
        this.failed.clear();
        for (const file of files) this.enqueue(file);
        return files.length;
    }

    status() {
        return {
            pending: this.pending.length,
            active: this.active.size,
            done: this.done.size,
            failed: this.failed.size,
            current: this.current
        };
    }

    async _drain() {
        if (this.running) return;
        this.running = true;
        while (this.pending.length > 0) {
            const file = this.pending.shift();
            this.queued.delete(file);
            this.active.add(file);
            this.current = file;
            this.emit({ type: 'start', file, pending: this.pending.length });
            try {
                const result = this.process ? await this.process(file) : null;
                this.active.delete(file);
                this.done.add(file);
                this.current = null;
                this.emit({ type: 'done', file, result, status: this.status() });
            } catch (err) {
                this.active.delete(file);
                this.failed.add(file);
                this.current = null;
                this.emit({ type: 'error', file, error: err.message, status: this.status() });
            }
        }
        this.running = false;
    }
}

/**
 * Watch a folder for new videos using a polling scan (reliable on Android
 * shared storage where inotify often does not fire).
 */
function watchFolder(rootDir, queue, options = {}) {
    const intervalMs = options.intervalMs || 15000;
    const seen = new Set();

    const scan = () => {
        const files = walkMedia(rootDir, options);
        const fresh = [];
        for (const file of files) {
            const resolved = path.resolve(file);
            if (seen.has(resolved)) continue;
            seen.add(resolved);
            if (isDone(resolved)) continue;
            fresh.push(resolved);
        }
        if (fresh.length > 0) queue.enqueueAll(fresh);
        return fresh;
    };

    scan();
    const timer = setInterval(scan, intervalMs);
    if (timer.unref) timer.unref();

    return {
        scanOnce: scan,
        stop() { clearInterval(timer); }
    };
}

module.exports = { walkMedia, JobQueue, watchFolder };
