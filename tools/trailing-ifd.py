"""Rewrite a classic TIFF so its directories sit at the end of the file.

A trailing directory is legal TIFF and is what a reader that only fetches the
first 64 KB silently fails on. All 20 tiles in `tools/cog-survey.js` were
front-loaded, but 3DEP is thousands of separately converted lidar projects, so
the reader has to cope with the other layout — and a test needs a file in it.

Only the directory blocks move. Every offset a directory holds (tile offsets,
and the values of tags too large to sit inline) is absolute and points at bytes
that stay where they are, so relocating the block itself and fixing the two
kinds of pointer that refer to it — the header's first-IFD pointer and each
directory's next-IFD pointer — is the whole job. GDAL is used afterwards to
confirm the result is still a file an independent reader accepts.

    python3 tools/trailing-ifd.py in.tif out.tif
"""

import struct
import sys

HEADER_FIRST_IFD = 4
ENTRY_BYTES = 12


def ifd_chain(data):
    """Every directory's (offset, byte length), in file order."""
    if data[:2] != b"II":
        raise SystemExit("this helper only handles little-endian classic TIFF")
    if struct.unpack_from("<H", data, 2)[0] != 42:
        raise SystemExit("this helper only handles classic TIFF, not BigTIFF")

    chain = []
    at = struct.unpack_from("<I", data, HEADER_FIRST_IFD)[0]
    while at:
        count = struct.unpack_from("<H", data, at)[0]
        chain.append((at, 2 + count * ENTRY_BYTES + 4))
        at = struct.unpack_from("<I", data, at + 2 + count * ENTRY_BYTES)[0]
    return chain


def relocate(data):
    out = bytearray(data)
    chain = ifd_chain(data)

    moved = []
    for offset, length in chain:
        moved.append(len(out))
        out += data[offset:offset + length]

    struct.pack_into("<I", out, HEADER_FIRST_IFD, moved[0])
    for i, start in enumerate(moved):
        count = struct.unpack_from("<H", out, start)[0]
        nxt = moved[i + 1] if i + 1 < len(moved) else 0
        struct.pack_into("<I", out, start + 2 + count * ENTRY_BYTES, nxt)

    # The old directory blocks are now unreachable. Left in place rather than
    # compacted, because compacting would move the pixel data and every offset
    # with it, which is the part this is deliberately not doing.
    return bytes(out), moved


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    blob, offsets = relocate(open(src, "rb").read())
    open(dst, "wb").write(blob)
    print(dst, "directories now at", offsets, "of", len(blob), "bytes")
