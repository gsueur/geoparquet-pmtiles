#!/bin/zsh
# Build a demo file: a GeoParquet 2.0 laid out for page reads, with simplified overview tiles
# baked in up to DETAIL_ZOOM-1, and a two-file baseline (plain PMTiles up to MAX_ZOOM).
#
#   prepare.sh <src.parquet> <workdir> <layer> <large_m> <detail_zoom> <max_zoom> <plain_cols> <tile_props> [min_zoom]
#
#   large_m      features whose bbox is wider than this (in the source CRS units) go last
#   plain_cols   comma-separated near-unique string columns written without a dictionary
#   tile_props   comma-separated columns kept in the tiles (styling, id)
#
# Examples:
#   prepare.sh src/parcels.parquet $D l3_taxpar_poly 500 14 14 LOC_ID,MAP_PAR_ID LOC_ID 6
#   prepare.sh clc/clc_2018.parquet $D/clc clc_2018 5000 12 13 ID Code_18,ID 0
set -euo pipefail
SRC=$1 W=$2 LAYER=$3 LARGE=$4 DZ=$5 MZ=$6 PLAIN=$7 PROPS=$8 MINZ=${9:-0}
HERE=${0:A:h}
PY=$HERE/.venv/bin/python
mkdir -p $W/spill
GEOM=$(duckdb -no-agent -init /dev/null -noheader -list -c "select json_extract_string(decode(value), '$.primary_column') from parquet_kv_metadata('$SRC') where decode(key)='geo'")
CRS=$(duckdb -no-agent -init /dev/null -noheader -list -c "select json_extract_string(decode(value), '$.columns.$GEOM.crs.id.authority') || ':' || json_extract_string(decode(value), '$.columns.$GEOM.crs.id.code') from parquet_kv_metadata('$SRC') where decode(key)='geo'")
echo "geometry column $GEOM, CRS $CRS"

echo "1. sort: Hilbert order, features wider than $LARGE last"
duckdb -no-agent -init /dev/null -c "LOAD spatial;
COPY (
  WITH e AS (SELECT min(bbox.xmin) x0, min(bbox.ymin) y0, max(bbox.xmax) x1, max(bbox.ymax) y1 FROM '$SRC')
  SELECT s.* FROM '$SRC' s, e
  ORDER BY greatest(s.bbox.xmax - s.bbox.xmin, s.bbox.ymax - s.bbox.ymin) > $LARGE,
           ST_Hilbert((s.bbox.xmin + s.bbox.xmax) / 2, (s.bbox.ymin + s.bbox.ymax) / 2, ST_Extent(ST_MakeEnvelope(e.x0, e.y0, e.x1, e.y1)))
) TO '$W/sorted.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 16384);"

echo "2. pages of 512 rows with a page index, GeoParquet 2.0 schema from the source"
$PY $HERE/paginate.py $W/sorted.parquet $W/layout.parquet --rows-per-page 512 --row-group-rows 16384 --schema-from $SRC --plain $PLAIN

echo "3. lon/lat copy for the tiler"
SEL=$(echo $PROPS | tr ',' '\n' | sed 's/.*/"&"/' | paste -sd, -)
duckdb -no-agent -init /dev/null -c "LOAD spatial; SET geometry_always_xy = true;
COPY (SELECT ST_Transform(\"$GEOM\", '$CRS', 'OGC:CRS84') AS geometry, $SEL FROM '$SRC') TO '$W/tiler_4326.parquet' (FORMAT parquet, COMPRESSION zstd);"

echo "4. baseline PMTiles z$MINZ-$MZ (simplified, tiny features kept as squares)"
tylertoo tiles $W/tiler_4326.parquet $W/baseline.pmtiles --min-zoom $MINZ --max-zoom $MZ --layer-name $LAYER --collapse-square --spill-dir $W/spill -f 2>&1 | grep -v WARN | tail -2

echo "5. overview zooms z$MINZ-$((DZ - 1)) baked into the GeoParquet"
$PY $HERE/overview.py $W/baseline.pmtiles $W/overview.pmtiles $((DZ - 1)) $LAYER ${(s:,:)PROPS}
$PY $HERE/bake.py bake $W/layout.parquet $W/overview.pmtiles $W/demo.parquet
ls -l $W/demo.parquet $W/baseline.pmtiles
