// Structural verification of the engine executables bundled in
// app/src/main/jniLibs/arm64-v8a/. Android loads these from nativeLibraryDir,
// so they must be valid AArch64 PIE ELF64 shared objects whose PT_LOAD segments
// are 16 KB aligned (Android 15+) and whose DT_NEEDED entries are all satisfied
// by a sibling file or an Android system library.
//
// Dependency-free on purpose: the ELF bytes are parsed here with fs/Buffer.
// Cannot execute arm64 binaries on this machine (Windows x64 / CI x64 ubuntu),
// so this proves structure only; on-device execution is a separate manual check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'app',
  'src',
  'main',
  'jniLibs',
  'arm64-v8a'
);

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;

const MIN_PAGE_ALIGN = 0x4000;

// Allowlist observed by inspecting the four committed binaries' DT_NEEDED
// (see docs/engine-binaries.md). All seven are Android system libraries present
// on any API 28+ device; libcamera2ndk.so / libmediandk.so are pulled in by the
// hzw1199 ffmpeg build's --enable-* media/camera support.
const ANDROID_SYSTEM_LIBS = new Set([
  'libc.so',
  'libm.so',
  'libdl.so',
  'libz.so',
  'libandroid.so',
  'libcamera2ndk.so',
  'libmediandk.so',
]);

// The exact names EngineEnv.base() points the engine at (the four tool binaries
// plus the Node runtime). A missing one means the app ships with no engine even
// though the directory still holds some .so files.
const REQUIRED = [
  'libllama-server.so',
  'libwhisper-cli.so',
  'libffmpeg.so',
  'libffprobe.so',
  'libnode.so',
];

// Sonames that Android itself ships, which we also bundle our own copy of.
// Deliberately separate from ANDROID_SYSTEM_LIBS: that set answers "may a tool
// binary depend on this?", this one answers "does this name exist on the device
// too?" — i.e. does our copy shadow the platform's. libcrypto.so/libssl.so are
// OpenSSL 3.x for Node; Android's are BoringSSL, and the two do not agree.
const ANDROID_SHIPPED_SONAMES = new Set([...ANDROID_SYSTEM_LIBS, 'libcrypto.so', 'libssl.so', 'libsqlite.so']);

// The four tool binaries we build/pin ourselves: PT_LOAD alignment below 16 KB
// is a hard failure here.
const CONTROLLED = new Set([
  'libllama-server.so',
  'libwhisper-cli.so',
  'libffmpeg.so',
  'libffprobe.so',
]);

// Node + the Termux runtime libraries pulled in by scripts/fetch-node-libs.mjs.
// Termux ships them 16 KB aligned today (verified below), but Termux does not
// promise it, so misalignment here is a loud WARN rather than a hard failure (see
// docs/engine-binaries.md). Do not silently drop the check.
const TERMUX_LIBS = new Set([
  'libnode.so',
  'libc++_shared.so',
  'libcares.so',
  'libsqlite3.so',
  'libicuuc.so',
  'libicui18n.so',
  'libicudata.so',
  'libcrypto.so',
  'libssl.so',
  'libz.so',
]);

function fail(file, message) {
  console.error(`FAIL ${file}: ${message}`);
  process.exit(1);
}

function parseElf(file, buf) {
  if (buf.length < 64 || !buf.subarray(0, 4).equals(ELF_MAGIC)) {
    fail(file, 'not an ELF file (bad magic)');
  }
  const eiClass = buf[4];
  const eiData = buf[5];
  const eType = buf.readUInt16LE(16);
  const eMachine = buf.readUInt16LE(18);
  if (eiClass !== 2) fail(file, `EI_CLASS=${eiClass}, expected 2 (ELF64)`);
  if (eiData !== 1) fail(file, `EI_DATA=${eiData}, expected 1 (little-endian)`);
  if (eType !== 3) fail(file, `e_type=${eType}, expected 3 (ET_DYN / PIE)`);
  if (eMachine !== 0xb7) fail(file, `e_machine=0x${eMachine.toString(16)}, expected 0xb7 (AArch64)`);

  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);

  const loads = [];
  let dynOffset = -1;
  let dynSize = 0;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    const pType = buf.readUInt32LE(off);
    if (pType === PT_LOAD) {
      loads.push({
        offset: Number(buf.readBigUInt64LE(off + 8)),
        vaddr: Number(buf.readBigUInt64LE(off + 16)),
        filesz: Number(buf.readBigUInt64LE(off + 32)),
        align: Number(buf.readBigUInt64LE(off + 48)),
      });
    } else if (pType === PT_DYNAMIC) {
      dynOffset = Number(buf.readBigUInt64LE(off + 8));
      dynSize = Number(buf.readBigUInt64LE(off + 32));
    }
  }

  if (loads.length === 0) fail(file, 'no PT_LOAD segment');
  const minAlign = loads.reduce((min, l) => Math.min(min, l.align), Infinity);

  const vaddrToOffset = (va) => {
    for (const l of loads) {
      if (va >= l.vaddr && va < l.vaddr + l.filesz) return l.offset + (va - l.vaddr);
    }
    return -1;
  };

  const needed = [];
  if (dynOffset >= 0) {
    let strtabOffset = -1;
    const entries = [];
    for (let off = dynOffset; off < dynOffset + dynSize; off += 16) {
      const tag = Number(buf.readBigInt64LE(off));
      const val = Number(buf.readBigUInt64LE(off + 8));
      if (tag === DT_NULL) break;
      entries.push([tag, val]);
      if (tag === DT_STRTAB) strtabOffset = vaddrToOffset(val);
    }
    if (strtabOffset < 0 && entries.some(([t]) => t === DT_NEEDED)) {
      fail(file, 'DT_STRTAB not found; cannot resolve DT_NEEDED');
    }
    for (const [tag, val] of entries) {
      if (tag !== DT_NEEDED) continue;
      let end = strtabOffset + val;
      while (end < buf.length && buf[end] !== 0) end++;
      needed.push(buf.toString('utf8', strtabOffset + val, end));
    }
  }

  return { needed, minAlign };
}

if (!fs.existsSync(LIB_DIR)) {
  console.error(`FAIL: library directory not found: ${LIB_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(LIB_DIR)
  .filter((name) => /^lib.+\.so(\.\d+)*$/.test(name))
  .sort();

if (files.length === 0) {
  console.error(`FAIL: no lib*.so* files in ${LIB_DIR}`);
  process.exit(1);
}

const presentNames = new Set(files);

const missing = REQUIRED.filter((name) => !presentNames.has(name));
if (missing.length) {
  console.error(`FAIL: required engine libraries missing from ${LIB_DIR}: ${missing.join(', ')}`);
  process.exit(1);
}

const results = [];
let alignmentWarnings = 0;
for (const name of files) {
  const full = path.join(LIB_DIR, name);
  const buf = fs.readFileSync(full);
  const { needed, minAlign } = parseElf(name, buf);
  for (const soname of needed) {
    if (presentNames.has(soname)) continue;
    if (ANDROID_SYSTEM_LIBS.has(soname)) continue;
    fail(name, `unresolved DT_NEEDED "${soname}" (not a sibling file, not in the Android allowlist)`);
  }
  if (CONTROLLED.has(name)) {
    // Tool binaries are executed as child processes WITHOUT the bundle directory
    // on the library search path (see toolEnv in src/binaries.js), because that
    // directory ships libcrypto.so/libssl.so/libz.so and would shadow Android's
    // own copies with incompatible builds. A sibling dependency here would
    // therefore be unresolvable at runtime, so keep tools on system libraries.
    for (const soname of needed) {
      if (!ANDROID_SYSTEM_LIBS.has(soname)) {
        fail(
          name,
          `tool binaries must depend on Android system libraries only, but this one needs "${soname}": tool processes run without the bundle directory on LD_LIBRARY_PATH`
        );
      }
    }
  }
  if (minAlign < MIN_PAGE_ALIGN) {
    if (TERMUX_LIBS.has(name) && !CONTROLLED.has(name)) {
      // Termux does not promise 16 KB alignment; keep the check but do not fail.
      console.warn(`WARN ${name}: PT_LOAD p_align=0x${minAlign.toString(16)} < 0x4000 (16 KB) — may fail to load on 16 KB-page devices (see docs/engine-binaries.md)`);
      alignmentWarnings++;
    } else {
      fail(name, `PT_LOAD p_align=0x${minAlign.toString(16)} < 0x4000 (not 16 KB aligned)`);
    }
  }
  results.push({ name, size: buf.length, needed, minAlign });
}

// Every library name the APK must carry: all committed siblings plus any
// non-system soname in DT_NEEDED (which the checks above proved is a sibling).
// `--closure` prints this space-separated for the CI APK assertion.
function apkLibs() {
  const libs = new Set(files);
  for (const r of results) {
    for (const soname of r.needed) {
      if (!ANDROID_SYSTEM_LIBS.has(soname)) libs.add(soname);
    }
  }
  return [...libs].sort();
}

if (process.argv.includes('--closure')) {
  console.log(apkLibs().join(' '));
  process.exit(0);
}

console.log('Engine libraries verified (structure only; not executed):');
for (const r of results) {
  const list = r.needed.length ? r.needed.join(', ') : '(none)';
  const align = `0x${r.minAlign.toString(16)}`;
  console.log(`  OK ${r.name} (${r.size} bytes, p_align=${align}) DT_NEEDED: ${list}`);
}
if (alignmentWarnings) {
  console.warn(`\n${alignmentWarnings} Termux library(ies) below 16 KB alignment â€” packaged anyway (documented caveat).`);
}

// Sonames we ship that ALSO exist on Android. For any process that has this
// directory on LD_LIBRARY_PATH they shadow the system copy, which is exactly how
// `libffmpeg.so` ended up resolving /system/lib64/libsqlite.so's libcrypto.so to
// our OpenSSL 3.x and dying on the dropped EVP_MD_CTX_init symbol. Node really
// needs these siblings; tool processes are launched without the directory.
const shadowed = files.filter((name) => ANDROID_SHIPPED_SONAMES.has(name));
if (shadowed.length) {
  console.log(`\nNOTE: bundled sonames that shadow Android system libraries: ${shadowed.join(', ')}`);
  console.log('      Only libnode.so runs with this directory on LD_LIBRARY_PATH;');
  console.log('      ffmpeg/ffprobe/whisper/llama are launched with it stripped (src/binaries.js toolEnv).');
}

console.log(`All ${results.length} engine libraries passed.`);
