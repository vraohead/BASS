#!/usr/bin/env bash
# Builds the Chrome Web Store upload ZIP from extension/ — manifest.json at the
# ZIP root, dev-only files excluded. Refuses to build while the shared-secret
# placeholder is still in the service worker (every AI Verify call would 401).
set -euo pipefail
cd "$(dirname "$0")/.."

if grep -q "REPLACE_WITH_THE_SAME_VALUE" extension/background/service-worker.js; then
  echo "ERROR: EXTENSION_SHARED_SECRET in extension/background/service-worker.js is still the placeholder." >&2
  echo "Set it to the same value as the Cloudflare EXTENSION_SHARED_SECRET secret, then re-run." >&2
  exit 1
fi

VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
OUT="${1:-booking-assistant-$VERSION.zip}"
rm -f "$OUT"
( cd extension && zip -r -X "../$OUT" . \
    -x "CHROME_STORE_COMPLIANCE.md" "docs/*" "content/*" "*.DS_Store" )
echo "Built $OUT ($(du -h "$OUT" | cut -f1)) — upload this in the Chrome Web Store dashboard."
