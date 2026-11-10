#!/bin/zsh
# Each reader must see the baked file exactly like the original: rows, sum(OGC_FID), sum(TOWN_ID).
cd "$(dirname $0)/.."
D=${DATA:-/Volumes/T9/claude-scratch/gpq-pmtiles}
for f in $D/src/parcels.parquet $D/parcels.baked.parquet; do
  echo "== ${f:t}"
  print -n "duckdb  "; duckdb -no-agent -init /dev/null -csv -noheader -c "select count(*), sum(OGC_FID), sum(TOWN_ID) from '$f'"
  print -n "duckdb bbox filter  "; duckdb -no-agent -init /dev/null -csv -noheader -c "select count(*) from '$f' where bbox.xmin < 236000 and bbox.xmax > 234000 and bbox.ymin < 901000 and bbox.ymax > 899000"
  print -n "pyarrow "; .venv/bin/python -c "
import pyarrow.parquet as pq,pyarrow.compute as pc,sys
t=pq.read_table(sys.argv[1],columns=['OGC_FID','TOWN_ID','geometry'])
print(t.num_rows, pc.sum(t['OGC_FID']).as_py(), pc.sum(t['TOWN_ID']).as_py(), b'geo' in pq.read_metadata(sys.argv[1]).metadata and 'geo ok')" $f
  print -n "polars  "; .venv/bin/python -c "
import polars as pl,sys
try:
  d=pl.scan_parquet(sys.argv[1]).select(pl.len(),pl.col('OGC_FID').sum(),pl.col('TOWN_ID').cast(pl.Int64).sum()).collect().row(0);print(*d)
except Exception as e: print('ERROR', str(e)[:90])" $f
  print -n "gdal    "; ogrinfo -q -ro $f -sql "SELECT COUNT(*) AS n, SUM(OGC_FID) AS s, SUM(TOWN_ID) AS t FROM \"${${f:t}:r}\"" 2>&1 | grep -E "^\s+(n|s|t) " | awk '{printf "%s ", $NF}'; echo
  print -n "gdal geom "; ogrinfo -q -ro -fid 1000000 $f "${${f:t}:r}" 2>&1 | grep -oE "MULTIPOLYGON \(\(\([0-9.]+ [0-9.]+" | head -1
  print -n "hyparquet "; node -e "
const {parquetMetadataAsync, parquetRead, asyncBufferFromFile} = require('hyparquet');const {compressors}=require('hyparquet-compressors');
(async()=>{const f=await asyncBufferFromFile(process.argv[1]);const m=await parquetMetadataAsync(f);
let s=0n,n=0;await parquetRead({file:f,metadata:m,compressors,columns:['OGC_FID'],rowStart:0,rowEnd:Number(m.num_rows),onComplete:r=>{for(const x of r){s+=BigInt(x[0]);n++}}});
console.log(String(m.num_rows), n, String(s), m.key_value_metadata.map(k=>k.key).join(','))})()" $f
done
