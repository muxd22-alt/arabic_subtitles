const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { toolEnv } = require('../src/binaries.js');

const DIR = path.resolve('fake-native-dir');
const FFMPEG = path.join(DIR, 'libffmpeg.so');

function withLdLibraryPath(value, fn) {
    const previous = process.env.LD_LIBRARY_PATH;
    if (value === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = value;
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.LD_LIBRARY_PATH;
        else process.env.LD_LIBRARY_PATH = previous;
    }
}

test('toolEnv drops the tool directory from LD_LIBRARY_PATH', () => {
    // The bundle ships libcrypto.so/libssl.so (OpenSSL 3.x, for Node). Leaving the
    // directory on the path makes Android's own libsqlite.so resolve its
    // libcrypto.so to that build and die on EVP_MD_CTX_init.
    withLdLibraryPath(DIR, () => {
        const env = toolEnv(FFMPEG);
        assert.strictEqual(env.LD_LIBRARY_PATH, undefined, 'the shadowing directory must not be inherited');
    });
});

test('toolEnv keeps other search paths intact', () => {
    withLdLibraryPath(['/system/lib64', DIR, '/vendor/lib64'].join(path.delimiter), () => {
        const env = toolEnv(FFMPEG);
        assert.deepStrictEqual(env.LD_LIBRARY_PATH.split(path.delimiter), ['/system/lib64', '/vendor/lib64']);
    });
});

test('toolEnv does not touch a tool outside the bundle directory', () => {
    withLdLibraryPath('/system/lib64', () => {
        const env = toolEnv(path.join(path.resolve('system-bin'), 'ffmpeg'));
        assert.strictEqual(env.LD_LIBRARY_PATH, '/system/lib64');
    });
});

test('toolEnv copies the environment instead of mutating it', () => {
    withLdLibraryPath(['/system/lib64', DIR].join(path.delimiter), () => {
        const before = process.env.LD_LIBRARY_PATH;
        toolEnv(FFMPEG);
        assert.strictEqual(process.env.LD_LIBRARY_PATH, before);
    });
});
