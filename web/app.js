import { openBaked, EmbeddedSource } from "./baked.js";

// Overviews baked in the GeoParquet, detail tiles built from its rows.
const CLC = [["111", "Continuous urban fabric", "#e6004d"], ["112", "Discontinuous urban fabric", "#ff0000"], ["121", "Industrial or commercial units", "#cc4df2"], ["122", "Road and rail networks and associated land", "#cc0000"], ["123", "Port areas", "#e6cccc"], ["124", "Airports", "#e6cce6"], ["131", "Mineral extraction sites", "#a600cc"], ["132", "Dump sites", "#a64d00"], ["133", "Construction sites", "#ff4dff"], ["141", "Green urban areas", "#ffa6ff"], ["142", "Sport and leisure facilities", "#ffe6ff"], ["211", "Non-irrigated arable land", "#ffffa8"], ["212", "Permanently irrigated land", "#ffff00"], ["213", "Rice fields", "#e6e600"], ["221", "Vineyards", "#e68000"], ["222", "Fruit trees and berry plantations", "#f2a64d"], ["223", "Olive groves", "#e6a600"], ["231", "Pastures", "#e6e64d"], ["241", "Annual crops associated with permanent crops", "#ffe6a6"], ["242", "Complex cultivation patterns", "#ffe64d"], ["243", "Agriculture with significant natural vegetation", "#e6cc4d"], ["244", "Agro-forestry areas", "#f2cca6"], ["311", "Broad-leaved forest", "#80ff00"], ["312", "Coniferous forest", "#00a600"], ["313", "Mixed forest", "#4dff00"], ["321", "Natural grasslands", "#ccf24d"], ["322", "Moors and heathland", "#a6ff80"], ["323", "Sclerophyllous vegetation", "#a6e64d"], ["324", "Transitional woodland-shrub", "#a6f200"], ["331", "Beaches, dunes, sands", "#e6e6e6"], ["332", "Bare rocks", "#cccccc"], ["333", "Sparsely vegetated areas", "#ccffcc"], ["334", "Burnt areas", "#000000"], ["335", "Glaciers and perpetual snow", "#a6e6cc"], ["411", "Inland marshes", "#a6a6ff"], ["412", "Peat bogs", "#4d4dff"], ["421", "Salt marshes", "#ccccff"], ["422", "Salines", "#e6e6ff"], ["423", "Intertidal flats", "#a6a6e6"], ["511", "Water courses", "#00ccf2"], ["512", "Water bodies", "#80f2e6"], ["521", "Coastal lagoons", "#00ffa6"], ["522", "Estuaries", "#a6ffe6"], ["523", "Sea and ocean", "#e6f2ff"], ["999", "No data", "#ffffff"]];
const clcColor = ["match", ["get", "Code_18"], ...CLC.flatMap(([c, , col]) => [c, col]), "#ffffff"];

const DATASETS = {
  parcels: {
    title: "MassGIS property tax parcels",
    blurb: "2.2 million parcels, Massachusetts.",
    file: "/data/massgis-parcels.parquet", layer: "l3_taxpar_poly",
    proj4: "+proj=lcc +lat_0=41 +lon_0=-71.5 +lat_1=42.6833333333333 +lat_2=41.7166666666667 +x_0=200000 +y_0=750000 +ellps=GRS80 +units=m +no_defs",
    id: "LOC_ID", noun: "parcel", attribution: "MassGIS (Bureau of Geographic Information)",
    cols: ["LOC_ID", "MAP_PAR_ID", "POLY_TYPE", "TOWN_ID", "MAP_NO", "SOURCE", "PLAN_ID", "LAST_EDIT", "BND_CHK", "NO_MATCH", "SHAPE_Area"],
    fill: { "fill-color": "#b5553c", "fill-opacity": 0.2 },
    line: { "line-color": "#b5553c", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.2, 11, 0.5, 14, 1.2] },
  },
  clc: {
    title: "CORINE Land Cover 2018",
    blurb: "2.4 million land cover polygons, 39 European countries.",
    file: "/data/clc-2018.parquet", layer: "clc_2018",
    proj4: "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs",
    id: "ID", noun: "polygon", attribution: "CORINE Land Cover 2018, EEA / Copernicus Land Monitoring Service",
    cols: ["Code_18", "ID", "Area_Ha", "country", "Remark", "OBJECTID"],
    label: (row) => (CLC.find(([c]) => c === row.Code_18) || [])[1],
    fill: { "fill-color": clcColor, "fill-opacity": 0.85 },
    line: { "line-color": "rgba(60,60,60,0.35)", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0, 12, 0.3, 15, 1] },
  },
};
const params = new URLSearchParams(location.search);
const DKEY = DATASETS[params.get("d")] ? params.get("d") : "parcels";
const D = DATASETS[DKEY];
const FILE = params.get("file") || D.file;
const LAYER = D.layer;
document.getElementById("ds").innerHTML = Object.entries(DATASETS).map(([k, d]) => k === DKEY ? `<b>${d.title}</b>` : `<a href="?d=${k}">${d.title}</a>`).join(" · ");
document.getElementById("desc").textContent = D.blurb;

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(0) + " KB" : n + " B";

// Byte meter. Main-thread fetches: the tail read and the PMTiles archive; the worker reports its own.
const meter = { tiles: [0, 0], detail: [0, 0], pick: [0, 0], footer: [0, 0], workerFooter: [0, 0] };
const show = () => {
  const footer = [meter.footer[0] + meter.workerFooter[0], meter.footer[1] + meter.workerFooter[1]];
  for (const [k, v] of [["tiles", meter.tiles], ["detail", meter.detail], ["pick", meter.pick], ["footer", footer]])
    document.getElementById("n-" + k).textContent = `${v[0]} req, ${fmt(v[1])}`;
};
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const res = await realFetch(input, init);
  const range = new Headers(init.headers || {}).get("Range");
  if (range && /\.(parquet|pmtiles)/.test(String(input.url || input))) {
    const k = range.startsWith("bytes=-") ? "footer" : "tiles";
    meter[k][0]++; meter[k][1] += Number(res.headers.get("Content-Length") || 0);
    show();
  }
  return res;
};

const t0 = performance.now();
const file = await openBaked(FILE);
const t1 = performance.now();
if (!file.tiles) throw new Error("this Parquet file carries no PMTiles archive");

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
const archive = new pmtiles.PMTiles(new EmbeddedSource(FILE, file.tiles.offset));
protocol.add(archive);
const header = await archive.getHeader();
const detailSpec = (await archive.getMetadata()).geoparquet_detail; // {layer, minzoom, properties}

const dataBytes = file.tiles.offset, tileBytes = file.tiles.length, footBytes = file.size - dataBytes - tileBytes;
document.getElementById("file").innerHTML =
  `<b>${FILE.split("/").pop()}</b> <span class="mute">${fmt(file.size)}</span>
     <div class="bar"><span style="flex:${dataBytes};background:var(--pq)"></span><span style="flex:${tileBytes};background:var(--tiles)"></span><span style="flex:${Math.max(footBytes, file.size / 300)};background:var(--mute)"></span></div>
     <div class="mute">GeoParquet ${fmt(dataBytes)} · overview tiles z${header.minZoom}-${header.maxZoom} ${fmt(tileBytes)} · footer ${fmt(footBytes)}<br>
     ${detailSpec ? `From zoom ${detailSpec.minzoom}, tiles are built in the browser from the GeoParquet rows.<br>` : ""}
     Archive found in ${Math.round(t1 - t0)} ms from one 64 KB read of the file's end.</div>`;

// Worker: detail tiles and attribute lookups from the Parquet rows
let worker = null, seq = 0;
const pending = new Map();
const ask = (msg, transfer) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer || []); });
const tileStats = { n: 0, ms: 0, max: 0 };
if (detailSpec) {
  worker = new Worker("detail-worker.js", { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "bytes") { meter.detail = m.bytes.detail; meter.pick = m.bytes.pick; meter.workerFooter = m.bytes.footer; show(); return; }
    const p = pending.get(m.id); pending.delete(m.id);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error));
  };
  await ask({ type: "init", url: new URL(FILE, location.href).href, size: file.size, footerLen: file.footerLen, layer: detailSpec.layer, properties: detailSpec.properties, rows: detailSpec.rows, proj4: D.proj4 });
  maplibregl.addProtocol("gpq", async (req) => {
    const [z, x, y] = req.url.split("/").slice(-3).map(Number);
    const r = await ask({ type: "tile", z, x, y });
    console.debug("tile", JSON.stringify({ z, x, y, rowGroups: r.rowGroups, ranges: r.pages, rowsRead: r.rowsRead, kept: r.features, ms: r.ms }));
    tileStats.n++; tileStats.ms += r.ms; tileStats.max = Math.max(tileStats.max, r.ms);
    document.getElementById("n-build").textContent = `${tileStats.n} tiles, ${Math.round(tileStats.ms / tileStats.n)} ms avg, ${tileStats.max} ms max`;
    return { data: r.data };
  });
}

const DETAIL_MIN = detailSpec?.minzoom ?? 12;
document.getElementById("clickzoom").textContent = `(zoom ${DETAIL_MIN} and closer)`;
const fill = D.fill, line = D.line;
const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
const sources = {
  basemap: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors" },
  overview: { type: "vector", url: `pmtiles://${archive.source.getKey()}`, attribution: D.attribution },
};
if (worker) sources.detail = { type: "vector", tiles: [`gpq://${DKEY}/{z}/{x}/{y}`], minzoom: DETAIL_MIN, maxzoom: 15, bounds };
const detailSource = worker ? "detail" : "overview";
const ovMax = worker && detailSpec.rows ? 24 : DETAIL_MIN;
const clickLayers = ovMax > DETAIL_MIN ? ["dt-fill", "ov-fill"] : ["dt-fill"];
const style = {
  version: 8, sources,
  layers: [
    { id: "basemap", type: "raster", source: "basemap" },
    // from the detail zoom, the baked tiles hold only the large features (detailSpec.rows); without that, they stop there
    { id: "ov-fill", type: "fill", source: "overview", "source-layer": LAYER, maxzoom: ovMax, paint: fill },
    { id: "ov-line", type: "line", source: "overview", "source-layer": LAYER, maxzoom: ovMax, paint: line },
    { id: "dt-fill", type: "fill", source: detailSource, "source-layer": LAYER, minzoom: DETAIL_MIN, paint: fill },
    { id: "dt-line", type: "line", source: detailSource, "source-layer": LAYER, minzoom: DETAIL_MIN, paint: line },
    { id: "picked-ov", type: "line", source: "overview", "source-layer": LAYER, minzoom: DETAIL_MIN, maxzoom: ovMax, filter: ["==", ["get", D.id], ""], paint: { "line-color": "#2f6fb3", "line-width": 3 } },
    { id: "picked", type: "line", source: detailSource, "source-layer": LAYER, minzoom: DETAIL_MIN, filter: ["==", ["get", D.id], ""], paint: { "line-color": "#2f6fb3", "line-width": 3 } },
  ],
};

const map = new maplibregl.Map({ container: "map", style, hash: true, bounds: [[bounds[0], bounds[1]], [bounds[2], bounds[3]]], fitBoundsOptions: { padding: 20 } });
map.addControl(new maplibregl.NavigationControl(), "top-left");
const zoomBadge = document.getElementById("zoom");
const showZoom = () => {
  const z = map.getZoom();
  const src = !worker || z < DETAIL_MIN ? "baked tiles" : "GeoParquet rows";
  zoomBadge.innerHTML = `Zoom ${z.toFixed(1)} <span class="src">· ${src}</span>`;
};
map.on("zoom", showZoom);
map.on("load", showZoom);
map.on("mousemove", (e) => {
  const hit = map.getZoom() >= DETAIL_MIN && map.queryRenderedFeatures(e.point, { layers: clickLayers }).length;
  map.getCanvas().style.cursor = hit ? "pointer" : "";
});

const COLS = D.cols;
map.on("click", async (e) => {
  const pick = document.getElementById("pick");
  const f = map.getZoom() >= DETAIL_MIN ? map.queryRenderedFeatures(e.point, { layers: clickLayers })[0] : null;
  if (!f) { pick.textContent = `No ${D.noun} here (zoom ${DETAIL_MIN} and closer).`; return; }
  for (const l of ["picked", "picked-ov"]) map.setFilter(l, ["==", ["get", D.id], f.properties[D.id] || ""]);
  if (!worker) { pick.innerHTML = `<table>${Object.entries(f.properties).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`; return; }
  pick.textContent = "Reading the Parquet rows…";
  const before = meter.pick[1];
  const r = await ask({ type: "pick", lng: e.lngLat.lng, lat: e.lngLat.lat, columns: COLS });
  const row = r.rows.find((x) => x[D.id] === f.properties[D.id]) || r.rows[0];
  if (!row) { pick.textContent = "No row found."; return; }
  const label = D.label ? D.label(row) : "";
  pick.innerHTML = `${label ? `<div><b>${label}</b></div>` : ""}<div class="mute">${r.pages} pages in ${r.rowGroups} of ${r.totalRowGroups} row groups read, ${fmt(meter.pick[1] - before)}, ${r.ms} ms</div>
    <table>${COLS.map((c) => `<tr><td>${c}</td><td>${row[c] ?? ""}</td></tr>`).join("")}</table>`;
});
window.__map = map;
window.__meter = meter;
