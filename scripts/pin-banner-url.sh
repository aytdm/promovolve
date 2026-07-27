#!/usr/bin/env bash
#
# Write the published banner bundle URL back into k8s/kustomization.yaml.
#
# WHY THIS EXISTS: deploy.yml's publish-banner job uploads a content-hashed
# bundle to R2 and points the cluster at it with `kubectl set env`, but never
# wrote the URL back — so the configMapGenerator literal here stayed at
# whatever was last hand-edited while the cluster ran something newer.
#
# That is the same failure as the image digest pins (see pin-image-digest.sh),
# and it broke manifest applies outright. `set env` replaces the platform's
# `valueFrom: configMapKeyRef` with a literal `value`; a later apply
# strategic-merges the valueFrom back on top, producing an env entry with BOTH
# — which the API server rejects:
#
#   The Deployment "promovolve-platform" is invalid:
#   spec.template.spec.containers[0].env[1].valueFrom: Invalid value: "":
#   may not be specified when `value` is not empty
#
# So `k8s-gke/setup.sh --deploy-only` failed on the platform tier after any
# banner publish, which in turn would have aborted a factory reset mid-wipe.
# Keeping this line true is what lets setup.sh drop the literal override and
# let the configMap be authoritative again.
#
#   scripts/pin-banner-url.sh https://…/expandable-magazine-banner.abc123.js
#
# Idempotent: re-running with the same URL leaves the file byte-identical.
set -euo pipefail

URL="${1:?usage: pin-banner-url.sh <published-bundle-url>}"

[[ "$URL" =~ ^https://.*/expandable-magazine-banner\..*\.js$ ]] \
  || { echo "does not look like a published banner bundle URL: '$URL'" >&2; exit 2; }

FILE="$(cd "$(dirname "$0")/.." && pwd)/k8s/kustomization.yaml"
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }

URL="$URL" python3 - "$FILE" <<'PY'
import os, sys

path = sys.argv[1]
url  = os.environ["URL"]
key  = "      - BANNER_SCRIPT_URL="

before = open(path).read()
lines  = before.split("\n")

hits = [i for i, l in enumerate(lines) if l.startswith(key)]
if len(hits) != 1:
    sys.exit(f"expected exactly one '{key.strip()}' line in {path}, found {len(hits)}")

lines[hits[0]] = f"{key}{url}"
after = "\n".join(lines)

if after != before:
    open(path, "w").write(after)
    print(f"pinned banner url -> {url}")
else:
    print("banner url already current — no change")
PY
