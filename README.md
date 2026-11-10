# GeoParquet with baked PMTiles

One file that is a genuine GeoParquet 2.0 for analytics and carries its own map: generalized
PMTiles overviews baked in, full-resolution geometry read from the Parquet rows at close zooms.
Standard readers (DuckDB, GDAL, pyarrow) see only the GeoParquet; a reader that knows the
convention finds the tiles.

Live demo: https://geoparquet-demo.geomermaids.com (MassGIS parcels, CORINE Land Cover 2018);
the approach is explained at https://geoparquet-demo.geomermaids.com/readme (source: `web/readme.html`).

```
PAR1 | row groups, page index (unchanged bytes) | PMTiles archive | footer' | len | PAR1
footer' = original FileMetaData + key_value_metadata["pmtiles"] = {"version":3,"offset":…,"length":…}
```

## What is where

| Path | Role |
|---|---|
| `bake.py` | Insert a PMTiles archive before the footer (`bake`), remove it (`strip`, byte-identical), show it (`info`). No dependencies. |
| `paginate.py` | Rewrite a GeoParquet 2.0 with 512-row pages and a page index, native GEOMETRY kept. |
| `overview.py` | Keep the overview zooms of a PMTiles archive. |
| `assemble.py` | Overview zooms (all features) + detail-zoom tiles of the widest features only; records in the metadata which rows the reader draws from Parquet. |
| `prepare.sh` | The whole pipeline for one dataset (sort, paginate, tile with tylertoo, bake). |
| `web/` | MapLibre reader: `baked.js` (find the archive, offset PMTiles source), `src/detail-worker.js` (detail tiles and clicks from the rows), `app.js`, `readme.html`. |
| `site/` | Cloudflare Worker serving the demo and `/data/*` from R2 with Range support. |
| `server.mjs` | Local static server with Range support. |
| `tests/` | `readers.sh` (DuckDB, pyarrow, Polars, GDAL, hyparquet on original vs baked), `pages*.mjs` (bytes a view selects), `trace.mjs` (request timeline against production). |

## Run

```sh
python3 -m venv .venv && .venv/bin/pip install pyarrow geoarrow-pyarrow pmtiles polars
npm install
# needs duckdb (spatial extension) and tylertoo on the PATH
D=/Volumes/T9/claude-scratch/gpq-pmtiles
./prepare.sh $D/clc/clc_2018.parquet $D/clcwork clc_2018 8000 12 13 ID Code_18,ID 2
npm run dev            # http://localhost:8790/web/  (?d=parcels or ?d=clc)
npm run deploy         # builds site/dist and deploys the Worker; data files go to R2 with rclone
```

The parcels file was built step by step before `prepare.sh` existed: Hilbert sort with parcels
wider than 500 m last, `paginate.py`, tylertoo z6-14, `overview.py` to z13, large parcels at z14,
`assemble.py ... 14 l3_taxpar_poly 2150738 LOC_ID`, `bake.py`.

## Design notes

- The archive sits between the last data byte and the footer, so no Parquet offset moves; the
  footer edit only rewrites field 5 (key_value_metadata) at the Thrift level. The `pmtiles`
  entry is the last key-value, so one 64 KB read of the file's end finds it.
- Overview zooms: simplified features, sub-pixel ones kept as squares (`tylertoo --collapse-square`).
- Detail zooms: pages selected from the page index of the `bbox` columns, decoded with hyparquet,
  reprojected with proj4, clipped and encoded with geojson-vt and vt-pbf in a Web Worker.
- The widest 2% of features (water, forests, rights of way) are moved last and come from baked
  detail-zoom tiles: a Parquet page is read whole, a tile clips. Without that, a detail view read
  25-35 MB; with it, 0.8-2.5 MB.
- Requests: one offset-index read per row group handed to hyparquet (`pageLocationsByGroup`),
  neighbouring pages read as one run per column, and `fetch(..., { cache: "no-store" })`:
  Chrome otherwise serializes concurrent range requests to the same URL behind its cache lock.

## Numbers (production, 2026-11-10)

| | Parcels | CORINE 2018 |
|---|---|---|
| File | 834 MB (GeoParquet 617 + PMTiles 217) | 4.37 GB (3.11 + 1.26) |
| Source GeoParquet | 503 MB | 2.73 GB |
| Detail view, first load | about 2 s, 2.5 MB of rows (Boston z14) | about 2 s, 0.8 MB (Paris z12) |
| Click, every column | about 0.5 s, 60 KB | about 0.5 s, 110 KB |

Open questions: pages sized by bytes rather than rows (a giant feature alone in its page) would
remove the wide-feature tiles and shrink the page-index overhead (+14 to 23% on the GeoParquet).
Polars does not read GeoParquet 2.0 native geometry yet, with or without the archive.
