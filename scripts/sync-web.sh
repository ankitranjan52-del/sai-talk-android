#!/bin/sh
# Copies the web app (the Cloudflare project's public/ folder) into www/ and adds the Capacitor web runtime
# (needed for registerPlugin). Usage: sh scripts/sync-web.sh /path/to/talk-cf/public   (run `npm install` first)
SRC="${1:-../talk-cf/public}"
rm -rf www && mkdir -p www && cp -R "$SRC"/. www/ && rm -f www/admin.html www/sw.js www/mesh/sim.js
cp node_modules/@capacitor/core/dist/capacitor.js www/capacitor.js
sed -i '0,/<script>/s//<script src="capacitor.js"><\/script>\n<script>/' www/index.html
grep -c 'src="capacitor.js"' www/index.html
