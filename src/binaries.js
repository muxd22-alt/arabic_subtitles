const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Robust cross-platform binary locator.
 * Searches:
 * 1. Explicit env var (if provided)
 * 2. All directories in PATH
 * 3. Termux prefix ($PREFIX/bin) and Android standard locations
 * 4. Local fallback build directories
 * 5. Shell lookup (command -v on POSIX / where on Windows)
 */
function findExecutable(names, envVar) {
    if (envVar && process.env[envVar]) {
        const val = process.env[envVar].trim();
        try {
            if (fs.existsSync(val) && fs.statSync(val).isFile()) return val;
        } catch (e) { }
    }

    const candidateNames = Array.isArray(names) ? names : [names];

    // 1. PATH directories
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        for (const name of candidateNames) {
            const fullPath = path.join(dir, name);
            try {
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    return fullPath;
                }
            } catch (e) { }
        }
    }

    // 2. Termux and Android / Linux standard prefixes
    const prefixDirs = [
        process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : null,
        '/data/data/com.termux/files/usr/bin',
        path.join(process.env.HOME || '', '.arabic-subs/bin'),
        path.join(process.env.HOME || '', '.arabic-subs/engine'),
        path.join(process.env.HOME || '', 'llama-stq'),
        path.join(process.env.HOME || '', 'llama.cpp/build/bin'),
        path.join(process.env.HOME || '', 'whisper.cpp/build/bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin'
    ].filter(Boolean);

    for (const dir of prefixDirs) {
        for (const name of candidateNames) {
            const fullPath = path.join(dir, name);
            try {
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    return fullPath;
                }
            } catch (e) { }
        }
    }

    // 3. Fallback to shell built-in command -v (does not depend on external 'which')
    for (const name of candidateNames) {
        try {
            const cmd = process.platform === 'win32' ? `where "${name}"` : `command -v "${name}"`;
            const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], shell: true })
                .toString().trim().split(/\r?\n/)[0];
            if (out && fs.existsSync(out)) return out;
        } catch (e) { }
    }

    return null;
}

function findLlamaServer() {
    return findExecutable(
        process.platform === 'win32'
            ? ['llama-server.exe', 'server.exe', 'llama-server']
            : ['llama-server', 'server'],
        'LLAMA_SERVER_BIN'
    );
}

function findWhisper() {
    return findExecutable(
        process.platform === 'win32'
            ? ['whisper-cli.exe', 'whisper.exe', 'whisper-cpp.exe', 'main.exe']
            : ['whisper-cli', 'whisper', 'whisper-cpp', 'main'],
        'WHISPER_BIN'
    );
}

function findFfmpeg() {
    return findExecutable(
        process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'],
        'FFMPEG_BIN'
    ) || 'ffmpeg';
}

function findFfprobe() {
    return findExecutable(
        process.platform === 'win32' ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe'],
        'FFPROBE_BIN'
    ) || 'ffprobe';
}

/**
 * Environment for launching one of the bundled *tool* binaries
 * (ffmpeg / ffprobe / whisper-cli / llama-server) as a child process.
 *
 * Those four are self-contained: their entire DT_NEEDED list is Android system
 * libraries (scripts/verify-engine-libs.mjs enforces that), so they never need a
 * sibling — yet the app starts the engine with LD_LIBRARY_PATH=<nativeLibraryDir>
 * because libnode.so *does* need its siblings, and every child inherits it.
 *
 * ffmpeg is where that inheritance bites: its DT_NEEDED libmediandk.so /
 * libcamera2ndk.so drag in the Android media/binder stack, which loads the
 * *system* /system/lib64/libsqlite.so, and bionic then resolved that library's
 * DT_NEEDED "libcrypto.so" to our bundled OpenSSL 3.x instead of the system
 * BoringSSL. OpenSSL 3.0 dropped the deprecated EVP_MD_CTX_init symbol, so the
 * exec died with:
 *
 *   CANNOT LINK EXECUTABLE libffmpeg.so: cannot locate symbol "EVP_MD_CTX_init"
 *   referenced by /system/lib64/libsqlite.so
 *
 * Dropping the tool's own directory from the search path — the only reason it is
 * on the path at all is Node — makes every system soname resolve to the system
 * copy. The tool binaries have no SONAME and no RUNPATH, so their own directory
 * is never searched implicitly: LD_LIBRARY_PATH is the only thing leaking.
 */
function toolEnv(bin) {
    const dir = path.resolve(path.dirname(bin));
    const env = { ...process.env };
    const keep = String(env.LD_LIBRARY_PATH || '')
        .split(path.delimiter)
        .filter((entry) => entry && path.resolve(entry) !== dir);
    if (keep.length > 0) env.LD_LIBRARY_PATH = keep.join(path.delimiter);
    else delete env.LD_LIBRARY_PATH;
    return env;
}

module.exports = {
    findExecutable,
    findLlamaServer,
    findWhisper,
    findFfmpeg,
    findFfprobe,
    toolEnv
};
