#!/usr/bin/env bash
# Run the classifier over the eval set and score it.
#
#   scripts/classify-eval/run.sh [--no-extract] [--no-hints] [--label NAME] [--baseline out/NAME.json] [--strict]
#
#   --no-extract   reuse pages/*.json from the last extract (compare two
#                  prompts on IDENTICAL text — always do this for A/B)
#   --no-hints     classify from page text only, ignoring the tag's
#                  data-section / data-place (measures what hints add)
#   --label NAME   results file name (out/NAME.json); default = git short sha
#   --baseline F   print per-page verdict changes against a previous results file
#   --strict       exit 1 when any page is wrong / invented / missing
#
# Needs the same LLM key the app uses (GEMINI_API_KEY, or OPENAI_API_KEY /
# ANTHROPIC_API_KEY). Calls the real provider: a few dozen requests, cents.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/classify-eval"
EXTRACT=1; ARGS=()
for a in "$@"; do
  case "$a" in
    --no-extract) EXTRACT=0 ;;
    *) ARGS+=("$a") ;;
  esac
done
if [ -z "${GEMINI_API_KEY:-}${OPENAI_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]; then
  echo "classify-eval: set GEMINI_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) — the eval calls the real classifier" >&2
  exit 2
fi
if [ "$EXTRACT" = 1 ]; then
  echo "-> extracting page text (as the tag does)"
  node "$HERE/extract.mjs" "$HERE/pages.tsv"
fi
mkdir -p "$HERE/out"
echo "-> classifying + scoring"
cd "$ROOT"
sbt -batch "core/Test/runMain promovolve.tools.ClassifyEval $HERE ${ARGS[*]:-}" 2>&1 \
  | grep -v '^\[info\] \(welcome\|loading\|compiling\|set current\|running\)' \
  | sed 's/^\[info\] //'
