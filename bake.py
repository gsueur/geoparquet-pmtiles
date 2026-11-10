"""Bake a PMTiles archive into a GeoParquet file, or strip it back out.

Layout of a baked file:

    PAR1 | row groups, page indexes (unchanged bytes) | PMTiles archive | footer' | len | PAR1

footer' is the original Parquet FileMetaData with one more key-value entry:

    pmtiles = {"version": 3, "offset": <archive start>, "length": <archive bytes>}

Nothing before the archive moves, so every offset in the footer stays valid and
standard readers (they only follow the footer) see the original GeoParquet.
The footer is edited at the Thrift compact-protocol level: only field 5
(key_value_metadata) is rebuilt, every other field is copied as raw bytes.

    python bake.py bake  data.parquet tiles.pmtiles out.parquet
    python bake.py strip baked.parquet plain.parquet
    python bake.py info  baked.parquet
"""
import json
import os
import shutil
import struct
import sys

MAGIC = b"PAR1"
KEY = "pmtiles"
KV_FIELD = 5  # FileMetaData.key_value_metadata: list<KeyValue>

# Thrift compact types
BOOL_T, BOOL_F, BYTE, I16, I32, I64, DOUBLE, BINARY, LIST, SET, MAP, STRUCT = range(1, 13)


def varint(buf, i):
    out = shift = 0
    while True:
        b = buf[i]
        i += 1
        out |= (b & 0x7F) << shift
        if not b & 0x80:
            return out, i
        shift += 7


def enc_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(n):
    return (n >> 1) ^ -(n & 1)


def skip(buf, i, t):
    """Return the index right after a value of compact type t starting at i."""
    if t in (BOOL_T, BOOL_F):
        return i  # struct-field booleans live in the header
    if t == BYTE:
        return i + 1
    if t in (I16, I32, I64):
        return varint(buf, i)[1]
    if t == DOUBLE:
        return i + 8
    if t == BINARY:
        n, i = varint(buf, i)
        return i + n
    if t in (LIST, SET):
        h = buf[i]
        i += 1
        n, et = h >> 4, h & 0x0F
        if n == 15:
            n, i = varint(buf, i)
        for _ in range(n):
            i = i + 1 if et in (BOOL_T, BOOL_F) else skip(buf, i, et)
        return i
    if t == MAP:
        n, i = varint(buf, i)
        if n:
            kt, vt = buf[i] >> 4, buf[i] & 0x0F
            i += 1
            for _ in range(n):
                i = i + 1 if kt in (BOOL_T, BOOL_F) else skip(buf, i, kt)
                i = i + 1 if vt in (BOOL_T, BOOL_F) else skip(buf, i, vt)
        return i
    if t == STRUCT:
        return parse_struct(buf, i)[1]
    raise ValueError(f"unknown thrift compact type {t}")


def parse_struct(buf, i):
    """Return ([(field_id, type, raw_value_bytes)], end_index)."""
    fields, last = [], 0
    while True:
        h = buf[i]
        i += 1
        if h == 0:
            return fields, i
        delta, t = h >> 4, h & 0x0F
        if delta:
            fid = last + delta
        else:
            z, i = varint(buf, i)
            fid = zigzag(z)
        start = i
        i = skip(buf, i, t)
        fields.append((fid, t, bytes(buf[start:i])))
        last = fid


def emit_struct(fields):
    out, last = bytearray(), 0
    for fid, t, raw in sorted(fields, key=lambda f: f[0]):
        delta = fid - last
        if 0 < delta <= 15:
            out.append(delta << 4 | t)
        else:
            out.append(t)
            out += enc_varint((fid << 1) ^ (fid >> 63))
        out += raw
        last = fid
    out.append(0)
    return bytes(out)


def read_kv(raw):
    """Decode a raw list<KeyValue> into [(key, value or None)]."""
    h = raw[0]
    i = 1
    n, et = h >> 4, h & 0x0F
    if n == 15:
        n, i = varint(raw, i)
    assert et == STRUCT
    out = []
    for _ in range(n):
        fields, i = parse_struct(raw, i)
        kv = {}
        for fid, t, v in fields:
            ln, j = varint(v, 0)
            kv[fid] = v[j:j + ln].decode()
        out.append((kv[1], kv.get(2)))
    return out


def enc_kv(pairs):
    n = len(pairs)
    out = bytearray([(n << 4 | STRUCT)] if n < 15 else [0xF0 | STRUCT])
    if n >= 15:
        out += enc_varint(n)
    for k, v in pairs:
        f = [(1, BINARY, enc_varint(len(k.encode())) + k.encode())]
        if v is not None:
            f.append((2, BINARY, enc_varint(len(v.encode())) + v.encode()))
        out += emit_struct(f)
    return bytes(out)


def read_footer(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(size - 8)
        tail = f.read(8)
        if tail[4:] != MAGIC:
            raise SystemExit(f"{path}: not a Parquet file")
        flen = struct.unpack("<I", tail[:4])[0]
        start = size - 8 - flen
        f.seek(start)
        footer = f.read(flen)
    fields, end = parse_struct(footer, 0)
    assert end == flen, "footer not fully parsed"
    return start, fields


def kv_of(fields):
    raw = next((r for fid, _, r in fields if fid == KV_FIELD), None)
    return read_kv(raw) if raw else []


def with_kv(fields, pairs):
    rest = [f for f in fields if f[0] != KV_FIELD]
    return emit_struct(rest + ([(KV_FIELD, LIST, enc_kv(pairs))] if pairs else []))


def copy_range(src, dst, length):
    left = length
    while left:
        chunk = src.read(min(left, 16 << 20))
        dst.write(chunk)
        left -= len(chunk)


def bake(parquet, pmtiles, out):
    start, fields = read_footer(parquet)
    pairs = [(k, v) for k, v in kv_of(fields) if k != KEY]
    with open(pmtiles, "rb") as t:
        if t.read(7) != b"PMTiles" or t.read(1) != b"\x03":
            raise SystemExit(f"{pmtiles}: not a PMTiles v3 archive")
    length = os.path.getsize(pmtiles)
    pairs.append((KEY, json.dumps({"version": 3, "offset": start, "length": length})))
    footer = with_kv(fields, pairs)
    with open(parquet, "rb") as src, open(pmtiles, "rb") as t, open(out, "wb") as dst:
        copy_range(src, dst, start)  # PAR1 + row groups + page indexes, byte for byte
        shutil.copyfileobj(t, dst, 16 << 20)
        dst.write(footer)
        dst.write(struct.pack("<I", len(footer)) + MAGIC)
    return start, length


def embedded(path):
    start, fields = read_footer(path)
    meta = dict(kv_of(fields)).get(KEY)
    return (json.loads(meta) if meta else None), start, fields


def strip(baked, out):
    meta, _, fields = embedded(baked)
    if not meta:
        raise SystemExit(f"{baked}: no embedded PMTiles")
    footer = with_kv(fields, [(k, v) for k, v in kv_of(fields) if k != KEY])
    with open(baked, "rb") as src, open(out, "wb") as dst:
        copy_range(src, dst, meta["offset"])
        dst.write(footer)
        dst.write(struct.pack("<I", len(footer)) + MAGIC)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    if cmd == "bake" and len(args) == 3:
        s, n = bake(*args)
        print(f"baked {n:,} bytes of PMTiles at offset {s:,} -> {args[2]} ({os.path.getsize(args[2]):,} bytes)")
    elif cmd == "strip" and len(args) == 2:
        strip(*args)
        print(f"stripped -> {args[1]} ({os.path.getsize(args[1]):,} bytes)")
    elif cmd == "info" and len(args) == 1:
        meta, start, _ = embedded(args[0])
        print(json.dumps({"footer_offset": start, "pmtiles": meta}))
    else:
        print(__doc__)
        sys.exit(1)
