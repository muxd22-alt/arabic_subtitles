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
  for (const l of loads) {
    if (l.align < MIN_PAGE_ALIGN) {
      fail(file, `PT_LOAD p_align=0x${l.align.toString(16)} < 0x4000 (not 16 KB aligned)`);
    }
  }

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

  return needed;
}

if (!fs.existsSync(LIB_DIR)) {
  console.error(`FAIL: library directory not found: ${LIB_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(LIB_DIR)
  .filter((name) => name.startsWith('lib') && name.includes('.so'))
  .sort();

if (files.length === 0) {
  console.error(`FAIL: no lib*.so* files in ${LIB_DIR}`);
  process.exit(1);
}

const presentNames = new Set(files);

const results = [];
for (const name of files) {
  const full = path.join(LIB_DIR, name);
  const buf = fs.readFileSync(full);
  const needed = parseElf(name, buf);
  for (const soname of needed) {
    if (presentNames.has(soname)) continue;
    if (ANDROID_SYSTEM_LIBS.has(soname)) continue;
    fail(name, `unresolved DT_NEEDED "${soname}" (not a sibling file, not in the Android allowlist)`);
  }
  results.push({ name, size: buf.length, needed });
}

console.log('Engine libraries verified (structure only; not executed):');
for (const r of results) {
  const list = r.needed.length ? r.needed.join(', ') : '(none)';
  console.log(`  OK ${r.name} (${r.size} bytes) DT_NEEDED: ${list}`);
}
console.log(`All ${results.length} engine libraries passed.`);
