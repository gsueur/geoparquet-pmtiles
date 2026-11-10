"""Assemble the archive baked into the GeoParquet:
- overview zooms (all features, simplified) below the detail zoom;
- from the detail zoom, tiles of the large features only: the reader draws every other
  feature from the Parquet rows [0, rows_end), and the large ones (the file's last rows,
  heavy, and unclipped in Parquet) from these tiles.

    python assemble.py overview.pmtiles large.pmtiles out.pmtiles <detail_zoom> <layer> <rows_end> [prop ...]
"""
import sys

from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import zxy_to_tileid
from pmtiles.writer import Writer

ov, large, dst, dz, layer, rows_end, *props = sys.argv[1:]
dz, rows_end = int(dz), int(rows_end)
tiles = []
with open(ov, "rb") as f:
    get = MmapSource(f)
    r = Reader(get)
    header, meta = r.header(), r.metadata()
    tiles += [(zxy_to_tileid(*zxy), d) for zxy, d in all_tiles(get) if zxy[0] < dz]
with open(large, "rb") as f:
    get = MmapSource(f)
    lh = Reader(get).header()
    tiles += [(zxy_to_tileid(*zxy), d) for zxy, d in all_tiles(get) if zxy[0] >= dz]
tiles.sort()

for l in meta.get("vector_layers", []):
    if l["id"] == layer:
        l["maxzoom"] = lh["max_zoom"]
meta["geoparquet_detail"] = {"layer": layer, "minzoom": dz, "properties": props, "rows": [0, rows_end],
                             "note": f"from zoom {dz}, rows [0, {rows_end}) come from the Parquet rows; the larger features after them from these tiles"}
header["max_zoom"] = lh["max_zoom"]
with open(dst, "wb") as f:
    w = Writer(f)
    for tid, data in tiles:
        w.write_tile(tid, data)
    w.finalize(header, meta)
print(f"{len(tiles):,} tiles z{header['min_zoom']}-{header['max_zoom']} -> {dst}")
