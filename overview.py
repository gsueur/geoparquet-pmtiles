"""Keep only the overview zooms of a PMTiles archive: the detail zooms are drawn from the
GeoParquet rows by the reader, so their geometry is not stored twice.

    python overview.py in.pmtiles out.pmtiles <max_overview_zoom> <detail_layer> [prop ...]

The archive metadata gets a "geoparquet_detail" entry telling the reader which source-layer
to build from the Parquet rows, from which zoom, and with which properties.
"""
import json
import sys

from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import zxy_to_tileid
from pmtiles.writer import Writer

src, dst, maxz, layer, *props = sys.argv[1:]
maxz = int(maxz)
with open(src, "rb") as f:
    get = MmapSource(f)
    r = Reader(get)
    header, meta = r.header(), r.metadata()
    tiles = sorted((zxy_to_tileid(*zxy), data) for zxy, data in all_tiles(get) if zxy[0] <= maxz)

for l in meta.get("vector_layers", []):  # layers end at the overview zooms
    l["maxzoom"] = min(l.get("maxzoom", maxz), maxz)
meta["vector_layers"] = [l for l in meta.get("vector_layers", []) if l.get("minzoom", 0) <= maxz]
meta["geoparquet_detail"] = {"layer": layer, "minzoom": maxz + 1, "properties": props}
header["max_zoom"] = maxz
header["center_zoom"] = min(header.get("center_zoom", maxz), maxz)
with open(dst, "wb") as f:
    w = Writer(f)
    for tid, data in tiles:
        w.write_tile(tid, data)
    w.finalize(header, meta)
print(f"{len(tiles):,} tiles z{header['min_zoom']}-{maxz} -> {dst}")
