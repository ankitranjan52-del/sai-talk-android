#!/bin/sh
# Copies the web app (the Cloudflare project's public/ folder) into www/. Usage: sh scripts/sync-web.sh /path/to/talk-cf/public
SRC="${1:-../talk-cf/public}"
rm -rf www && mkdir -p www && cp -R "$SRC"/. www/ && rm -f www/admin.html www/sw.js www/mesh/sim.js
