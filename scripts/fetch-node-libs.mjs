// Downloads the pinned Termux arm64 packages that back the bundled Node runtime
// (Task 11b) and writes the resulting shared objects into
// app/src/main/jniLibs/arm64-v8a/. The produced bytes ARE committed to git, so
// this script only needs to be re-run to reproduce or update them.
//
// Why the soname shortening: Android's package manager only extracts a native
// library into nativeLibraryDir when its file name starts with "lib" and ends
// with ".so" (AOSP NativeLibraryHelper.cpp, NativeLibrariesIterator). The app
// uses packaging { jniLibs { useLegacyPackaging = true } } because the engine
// binaries are *executed* as separate processes, so the files must be extracted
// to disk. A versioned soname such as libicuuc.so.78 therefore never reaches
// nativeLibraryDir. We rewrite the DT_SONAME of each Termux library and every
// matching DT_NEEDED reference to the plain "lib<name>.so" form, in place in
// .dynstr (the replacement is shorter, so it fits and is NUL-terminated).
//
// Dependency-free on purpose: Node fs/crypto/child_process + the platform `tar`
// (bsdtar on Windows, GNU tar on Linux; both read .xz).
//
// Usage: node scripts/fetch-node-libs.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = path.join(REPO, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');

const BASE = 'https://packages.termux.dev/apt/termux-main/pool/main/';

// Pinned Termux sources (URL path is relative to BASE). sha256 is of the .deb
// as published; it is re-verified on every run so drift is caught.
const DEBS = [
  { key: 'nodejs-lts', file: 'n/nodejs-lts/nodejs-lts_24.18.0-1_aarch64.deb', sha256: '490f4d08c45b25a7ea7db6ee466ebb3ee61f07083260b85332704ed018f59a87' },
  { key: 'libc++', file: 'libc/libc++/libc++_30_aarch64.deb', sha256: '53d0b84a7ba7459024257cb94d5b136fe13ef858567f65a8064b35950799f2ca' },
  { key: 'libicu', file: 'libi/libicu/libicu_78.3_aarch64.deb', sha256: 'f536403f65a08fe0df6e7304184e902d54def77d5c3bd5edfd9109d57601d276' },
  { key: 'openssl', file: 'o/openssl/openssl_1:3.6.5_aarch64.deb', sha256: 'a2fb7856875e63ef6b90442752e05974813372c3ca86d2513a78ea43c67a0f8b' },
  { key: 'c-ares', file: 'c/c-ares/c-ares_1.34.8_aarch64.deb', sha256: '7681fc23e822d7988ba8b2adf3468f93ae68f724dda365cff1385096a9fa87e6' },
  { key: 'libsqlite', file: 'libs/libsqlite/libsqlite_3.54.1_aarch64.deb', sha256: '0856cac8cc87f6e112f2eef4fcac6ad5cb08209ecb7cc260f997874fc186a3c0' },
  { key: 'zlib', file: 'z/zlib/zlib_1.3.2_aarch64.deb', sha256: '75e7d0af17fcc3b40004309fdc00a1ddb9ae08346dce5e269902c34ac3966ac9' },
];

// libffi is intentionally NOT bundled: nodejs-lts 24.18.0-1 declares
// "Depends: libc++, openssl, c-ares, libicu, libsqlite, zlib" (no libffi) and
// node's DT_NEEDED closure does not reference it.

// Files to place in jniLibs. `from` is the path inside the extracted data.tar
// under ./data/data/com.termux/files/; `to` is the committed name.
const FILES = [
  { deb: 'nodejs-lts', from: 'usr/bin/node', to: 'libnode.so' },
  { deb: 'libc++', from: 'usr/lib/libc++_shared.so', to: 'libc++_shared.so' },
  { deb: 'c-ares', from: 'usr/lib/libcares.so', to: 'libcares.so' },
  { deb: 'libsqlite', from: 'usr/lib/libsqlite3.so', to: 'libsqlite3.so' },
  { deb: 'libicu', from: 'usr/lib/libicuuc.so.78', to: 'libicuuc.so' },
  { deb: 'libicu', from: 'usr/lib/libicui18n.so.78', to: 'libicui18n.so' },
  { deb: 'libicu', from: 'usr/lib/libicudata.so.78', to: 'libicudata.so' },
  { deb: 'openssl', from: 'usr/lib/libcrypto.so.3', to: 'libcrypto.so' },
  { deb: 'openssl', from: 'usr/lib/libssl.so.3', to: 'libssl.so' },
  { deb: 'zlib', from: 'usr/lib/libz.so.1', to: 'libz.so' },
];

// Versioned soname -> plain ABI-compatible name, applied to DT_SONAME and
// DT_NEEDED everywhere in the bundled set.
const RENAMES = new Map([
  ['libz.so.1', 'libz.so'],
  ['libcrypto.so.3', 'libcrypto.so'],
  ['libssl.so.3', 'libssl.so'],
  ['libicuuc.so.78', 'libicuuc.so'],
  ['libicui18n.so.78', 'libicui18n.so'],
  ['libicudata.so.78', 'libicudata.so'],
]);

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_SONAME = 14;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function arEntry(buf, namePrefix) {
  if (buf.toString('ascii', 0, 8) !== '!<arch>\n') throw new Error('not an ar archive');
  let off = 8;
  while (off + 60 <= buf.length) {
    const name = buf.toString('ascii', off, off + 16).trim();
    const size = Number.parseInt(buf.toString('ascii', off + 48, off + 58).trim(), 10);
    const start = off + 60;
    if (Number.isNaN(size) || start + size > buf.length) break;
    if (name.startsWith(namePrefix)) return buf.subarray(start, start + size);
    off = start + size + (size % 2);
  }
  return null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Rewrite DT_SONAME / DT_NEEDED strings in place. Every replacement is shorter
// than the original, so it fits in .dynstr; the shorter string is NUL-terminated
// and the leftover bytes are zeroed. String-table offsets never change.
function shortenSoname(buf, file) {
  if (buf.length < 64 || !buf.subarray(0, 4).equals(ELF_MAGIC)) {
    throw new Error(`${file}: not an ELF file`);
  }
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
      loads.push({ offset: Number(buf.readBigUInt64LE(off + 8)), vaddr: Number(buf.readBigUInt64LE(off + 16)), filesz: Number(buf.readBigUInt64LE(off + 32)) });
    } else if (pType === PT_DYNAMIC) {
      dynOffset = Number(buf.readBigUInt64LE(off + 8));
      dynSize = Number(buf.readBigUInt64LE(off + 32));
    }
  }
  if (dynOffset < 0) return { buf, changed: [] };

  const vaddrToOffset = (va) => {
    for (const l of loads) {
      if (va >= l.vaddr && va < l.vaddr + l.filesz) return l.offset + (va - l.vaddr);
    }
    return -1;
  };

  const entries = [];
  let strtabVa = -1;
  for (let off = dynOffset; off < dynOffset + dynSize; off += 16) {
    const tag = Number(buf.readBigInt64LE(off));
    const val = Number(buf.readBigUInt64LE(off + 8));
    if (tag === DT_NULL) break;
    entries.push([tag, val]);
    if (tag === DT_STRTAB) strtabVa = val;
  }
  if (strtabVa < 0) return { buf, changed: [] };
  const strtabOffset = vaddrToOffset(strtabVa);
  if (strtabOffset < 0) return { buf, changed: [] };

  const changed = [];
  for (const [tag, val] of entries) {
    if (tag !== DT_NEEDED && tag !== DT_SONAME) continue;
    const at = strtabOffset + val;
    let end = at;
    while (end < buf.length && buf[end] !== 0) end++;
    const current = buf.toString('utf8', at, end);
    const replacement = RENAMES.get(current);
    if (!replacement) continue;
    if (replacement.length > current.length) throw new Error(`${file}: replacement longer than original`);
    buf.write(replacement, at, 'utf8');
    buf[at + replacement.length] = 0;
    for (let i = at + replacement.length + 1; i < end; i++) buf[i] = 0;
    changed.push(`${tag === DT_SONAME ? 'SONAME' : 'NEEDED'} ${current} -> ${replacement}`);
  }
  return { buf, changed };
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-node-libs-'));
  const extracted = new Map();

  for (const deb of DEBS) {
    const url = BASE + deb.file;
    process.stdout.write(`download ${deb.key}  ${url}\n`);
    const buf = await download(url);
    const got = sha256(buf);
    if (got !== deb.sha256) {
      throw new Error(`sha256 mismatch for ${deb.key}: got ${got}, expected ${deb.sha256}`);
    }
    const debPath = path.join(work, `${deb.key}.deb`);
    fs.writeFileSync(debPath, buf);

    const dataTar = arEntry(buf, 'data.tar');
    if (!dataTar) throw new Error(`${deb.key}: no data.tar.* in .deb`);
    const tarPath = path.join(work, `${deb.key}.data.tar.xz`);
    fs.writeFileSync(tarPath, dataTar);
    const dir = path.join(work, deb.key);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xf', tarPath, '-C', dir], { stdio: 'inherit' });
    extracted.set(deb.key, path.join(dir, 'data', 'data', 'com.termux', 'files'));
  }

  fs.mkdirSync(LIB_DIR, { recursive: true });

  let total = 0;
  for (const spec of FILES) {
    const src = path.join(extracted.get(spec.deb), spec.from);
    const raw = fs.readFileSync(src);
    const { buf, changed } = shortenSoname(raw, spec.to);
    const out = path.join(LIB_DIR, spec.to);
    fs.writeFileSync(out, buf);
    total += buf.length;
    console.log(`${spec.to.padEnd(20)} ${String(buf.length).padStart(10)} bytes  sha256=${sha256(buf)}`);
    for (const c of changed) console.log(`    patch: ${c}`);
  }
  console.log(`\n${FILES.length} files, ${total} bytes (${(total / 1024 / 1024).toFixed(1)} MB) written to ${LIB_DIR}`);
  console.log(`work dir: ${work}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
