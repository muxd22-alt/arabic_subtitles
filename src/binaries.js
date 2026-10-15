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

module.exports = {
    findExecutable,
    findLlamaServer,
    findWhisper,
    findFfmpeg,
    findFfprobe
};
