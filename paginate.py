"""Write a GeoParquet 2.0 file with small pages and a page index, so a reader can fetch only
the pages whose bbox overlaps a tile. Rows keep the input order.

    python paginate.py in.parquet out.parquet [--rows-per-page 512] [--row-group-rows N]
                       [--schema-from original.parquet] [--zstd-level 9]

--schema-from takes the Arrow schema (native GEOMETRY with its CRS, GeoParquet 2.0 metadata)
from the original file, for an input re-sorted by a tool that wrote plain WKB.
Without --row-group-rows, the input's row groups are kept.
"""
import argparse

import geoarrow.pyarrow  # noqa: F401  registers geoarrow.wkb, so GEOMETRY stays a native Parquet type
import pyarrow as pa
import pyarrow.parquet as pq

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("dst")
ap.add_argument("--rows-per-page", type=int, default=512)
ap.add_argument("--row-group-rows", type=int)
ap.add_argument("--schema-from")
ap.add_argument("--zstd-level", type=int, default=9)
ap.add_argument("--plain", default="", help="comma-separated string columns written without a dictionary (near-unique ids)")
a = ap.parse_args()

f = pq.ParquetFile(a.src, arrow_extensions_enabled=True)
schema = pq.ParquetFile(a.schema_from, arrow_extensions_enabled=True).schema_arrow if a.schema_from else f.schema_arrow
plain = set(filter(None, a.plain.split(",")))
strings = [n for n in schema.names if (pa.types.is_string(schema.field(n).type) or pa.types.is_large_string(schema.field(n).type)) and n not in plain]
floats = [f.metadata.schema.column(i).path for i in range(f.metadata.num_columns) if f.metadata.schema.column(i).physical_type in ("DOUBLE", "FLOAT")]


def conform(t):
    cols = []
    for field in schema:
        c = t.column(field.name)
        if isinstance(field.type, pa.ExtensionType):
            if c.type != field.type:
                storage = c.cast(field.type.storage_type) if not isinstance(c.type, pa.ExtensionType) else c.chunks and pa.chunked_array([x.storage for x in c.chunks])
                c = pa.chunked_array([field.type.wrap_array(x) for x in storage.chunks], type=field.type)
        else:
            c = c.cast(field.type)
        cols.append(c)
    return pa.Table.from_arrays(cols, schema=schema)


w = pq.ParquetWriter(
    a.dst, schema, compression="zstd", compression_level=a.zstd_level,
    use_dictionary=strings,  # not on geometry or floats
    column_encoding={c: "BYTE_STREAM_SPLIT" for c in floats},
    write_page_index=True,
    write_batch_size=a.rows_per_page,  # with a tiny data_page_size, one page per batch:
    data_page_size=1,                  # every column's pages start on the same rows
    write_statistics=True,
)
if a.row_group_rows:
    for batch in f.iter_batches(batch_size=a.row_group_rows):
        t = conform(pa.Table.from_batches([batch]))
        w.write_table(t, row_group_size=t.num_rows)
else:
    for i in range(f.num_row_groups):
        t = conform(f.read_row_group(i))
        w.write_table(t, row_group_size=t.num_rows)
w.close()
m = pq.ParquetFile(a.dst).metadata
print(f"{m.num_rows:,} rows, {m.num_row_groups} row groups -> {a.dst}")
