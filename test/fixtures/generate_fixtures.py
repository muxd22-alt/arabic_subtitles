#!/usr/bin/env python3
"""Generate deterministic fixtures for OpenSubtitles hash (OSHash) tests.

Provenance: testfile_small.bin follows the canonical generator from
https://github.com/opensubtitles/oshash (test-data/generate_testfile.py,
seed 123, 131080 bytes) and must hash to the published vector 6e4ae67790577f76.

The other two fixtures are project-local:
  large_140k.bin  - 140000 bytes, head/tail chunks do not overlap (seed 7)
  zerohash_140k.bin - 140000 bytes crafted so its hash has leading zeros

Usage: python test/fixtures/generate_fixtures.py
"""
import os
import random
import struct

HERE = os.path.dirname(os.path.abspath(__file__))

MASK = 0xFFFFFFFFFFFFFFFF


def oshash(data: bytes) -> str:
    """Independent reference: size + uint64-le sum of first/last 64KB, wrap at 64 bits."""
    size = len(data)

    def chunk_sum(buf: bytes) -> int:
        buf = buf[: len(buf) // 8 * 8]
        total = 0
        for i in range(0, len(buf), 8):
            total = (total + struct.unpack_from("<Q", buf, i)[0]) & MASK
        return total

    head = data[:65536]
    tail_start = max(size - 65536, 0)
    tail = data[tail_start : tail_start + 65536]
    return "%016x" % ((size + chunk_sum(head) + chunk_sum(tail)) & MASK)


def write_fixture(name: str, data: bytes) -> None:
    path = os.path.join(HERE, name)
    with open(path, "wb") as f:
        f.write(data)
    print("%-22s %8d bytes  %s" % (name, len(data), oshash(data)))


def main() -> None:
    # Canonical overlap-case vector from opensubtitles/oshash
    random.seed(123)
    write_fixture("testfile_small.bin", bytes(random.getrandbits(8) for _ in range(131080)))

    # Non-overlapping head/tail case
    random.seed(7)
    write_fixture("large_140k.bin", bytes(random.getrandbits(8) for _ in range(140000)))

    # Crafted leading-zero hash: for files > 64KB the first uint64 sits in the head
    # chunk only, so shifting it shifts the hash 1:1 (mod 2^64)
    random.seed(99)
    data = bytearray(bytes(random.getrandbits(8) for _ in range(140000)))
    target = 0x00005F1FE0A14000  # 4 leading zero hex chars
    first = struct.unpack_from("<Q", data, 0)[0]
    struct.pack_into("<Q", data, 0, (first - int(oshash(bytes(data)), 16) + target) & MASK)
    write_fixture("zerohash_140k.bin", bytes(data))


if __name__ == "__main__":
    main()
