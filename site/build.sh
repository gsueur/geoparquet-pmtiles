#!/bin/zsh
# Build the static site into site/dist: bundled app and worker, vendored map libraries.
set -euo pipefail
cd "$(dirname $0)/.."
OUT=site/dist
mkdir -p $OUT/vendor
npx esbuild web/app.js --bundle --format=esm --minify --outfile=$OUT/app.js
npx esbuild web/src/detail-worker.js --bundle --format=esm --minify --outfile=$OUT/detail-worker.js
cp node_modules/maplibre-gl/dist/maplibre-gl.js node_modules/maplibre-gl/dist/maplibre-gl.css node_modules/pmtiles/dist/pmtiles.js node_modules/proj4/dist/proj4.js $OUT/vendor/
# index.html: vendored paths, no import map (the app is bundled)
sed -e 's#/node_modules/maplibre-gl/dist/#vendor/#g' -e 's#/node_modules/pmtiles/dist/#vendor/#' -e 's#/node_modules/proj4/dist/#vendor/#' web/index.html \
  | perl -0pe 's#<script type="importmap">.*?</script>\n##s' > $OUT/index.html
cp web/readme.html $OUT/readme.html
ls -la $OUT $OUT/vendor
