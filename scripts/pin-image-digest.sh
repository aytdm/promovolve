#!/usr/bin/env bash
#
# Write a built image digest back into k8s/kustomization.yaml.
#
# WHY THIS EXISTS: deploy.yml rolls GKE with `kubectl set image` and, until
# this script, never wrote the digests back — so the `images:` pins were
# hand-maintained and permanently drifting behind main. That is not cosmetic:
#
#   • A manual `kubectl apply` of the overlay deploys the PINS, rolling the
#     app backwards (2026-07-12: reverted four shipped fixes; 2026-07-27:
#     gke-factory-reset.sh reverted api+singleton to a four-day-old build and
#     every /v1/internal/* route vanished with it).
#   • On a CLEAN install there is nothing running to preserve, so the pins are
#     simply what deploys — a stale pin means a fresh install is born broken.
#     That is the open-source path (k8s-gke/setup.sh), so it has to be right.
#
# The compensating machinery elsewhere (setup.sh's capture/restore of live
# images) exists only because the pins lie. Keep them true and it becomes a
# belt-and-braces no-op rather than the thing holding the deployment together.
#
#   scripts/pin-image-digest.sh api sha256:abc… 1a2b3c4 12345678
#
# Idempotent: re-running with the same digest leaves the file byte-identical
# (deploy.yml relies on that to decide whether there is anything to commit).
set -euo pipefail

COMPONENT="${1:?usage: pin-image-digest.sh <api|platform> <digest> <commit-sha> [run-id]}"
DIGEST="${2:?missing digest}"
SHA="${3:?missing commit sha}"
RUN_ID="${4:-manual}"

case "$COMPONENT" in
  api|platform) ;;
  *) echo "component must be 'api' or 'platform', got '$COMPONENT'" >&2; exit 2 ;;
esac
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || { echo "digest must look like sha256:<64 hex>, got '$DIGEST'" >&2; exit 2; }

FILE="$(cd "$(dirname "$0")/.." && pwd)/k8s/kustomization.yaml"
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }

STAMP="$(date -u +%Y-%m-%dT%H:%MZ)"

COMPONENT="$COMPONENT" DIGEST="$DIGEST" SHA="$SHA" RUN_ID="$RUN_ID" STAMP="$STAMP" \
python3 - "$FILE" <<'PY'
import os, re, sys

path      = sys.argv[1]
component = os.environ["COMPONENT"]
digest    = os.environ["DIGEST"]
marker    = f'    # build: {os.environ["SHA"]} {os.environ["STAMP"]} (Deploy run {os.environ["RUN_ID"]})'

lines = open(path).read().split("\n")

# Find this component's stanza: from its `- name: promovolve/<component>` to
# the next `- name:` (or EOF). Editing only inside that window keeps the two
# images independent — deploy.yml often builds just one of them.
start = next((i for i, l in enumerate(lines)
              if l.strip() == f"- name: promovolve/{component}"), None)
if start is None:
    sys.exit(f"no `- name: promovolve/{component}` stanza in {path}")
end = next((i for i in range(start + 1, len(lines))
            if lines[i].lstrip().startswith("- name:")), len(lines))

digest_idx = next((i for i in range(start, end)
                   if lines[i].lstrip().startswith("digest:")), None)
if digest_idx is None:
    sys.exit(f"no `digest:` line in the promovolve/{component} stanza")

# Replace the whole comment run directly above `digest:` with one marker line,
# so the historical hand-written changelogs collapse instead of accumulating.
first_comment = digest_idx
while first_comment > start and lines[first_comment - 1].lstrip().startswith("#"):
    first_comment -= 1

indent = re.match(r"\s*", lines[digest_idx]).group(0)
new = lines[:first_comment] + [marker, f"{indent}digest: {digest}"] + lines[digest_idx + 1:]

out = "\n".join(new)
if out != open(path).read():
    open(path, "w").write(out)
    print(f"pinned {component} -> {digest}")
else:
    print(f"{component} already pinned at {digest} — no change")
PY
