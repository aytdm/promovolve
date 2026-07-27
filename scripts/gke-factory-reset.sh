#!/usr/bin/env bash
#
# Factory-reset the GKE deployment back to a first-run install.
#
# Why this exists: the base currency is chosen at /setup and is IMMUTABLE
# afterwards, because a ledger amount is a bare int64 with no currency attached
# — flip the setting and $1,994 silently becomes ¥1,994. So the only way to try
# a different currency, or to re-verify the install path, is to start from an
# empty database. That is a repeated operation, not a one-off.
#
#   scripts/gke-factory-reset.sh            # dry run: show what would go
#   scripts/gke-factory-reset.sh --yes      # full reset (volumes)
#   scripts/gke-factory-reset.sh --yes --fast   # truncate only, keeps volumes
#
# FULL (default) deletes the Postgres volume and the api/singleton DData
# volumes. That clears the Pekko persistence journal too, so sites and
# campaigns go with it — the honest factory reset. ~5-8 min for the cluster to
# re-form.
#
# FAST truncates the tables instead. Quicker, but the actor journal survives,
# so entities persist with floors denominated in the OLD currency. Use it when
# iterating on the dashboard, not when validating a currency switch.
#
# Deliberately does NOT delete the namespace: that would take the Ingress and
# both ManagedCertificates with it. Re-provisioning a GKE managed cert runs
# 15-60 minutes of TLS errors on live hosts, and the load balancer IP would
# likely change, breaking DNS until it is updated. A database wipe achieves the
# same thing without any of that.

set -euo pipefail

CTX="gke_promovolve_asia-northeast1-b_promovolve"
NS="promovolve"
HOST="https://promovolve.programmer.llc"
MODE="full"
CONFIRMED=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --yes) CONFIRMED=true; shift ;;
    --fast) MODE="fast"; shift ;;
    --context) CTX="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

kc() { kubectl --context "$CTX" -n "$NS" "$@"; }

# A failure between "scale to zero" and "scale back up" leaves the deployment
# DOWN — that happened on this script's first real run, when the overlay apply
# errored after the volumes were already deleted. It cannot put the data back
# (that is the point of the script), but it can always hand back a running,
# empty cluster instead of a hole and a stack trace.
recover() {
  local rc=$?
  echo
  echo "!! failed (exit $rc) — scaling tiers back up so the cluster is not left down" >&2
  kc scale statefulset promovolve-db --replicas=1 >/dev/null 2>&1 || true
  kc scale statefulset promovolve-api --replicas=2 >/dev/null 2>&1 || true
  kc scale statefulset promovolve-singleton --replicas=1 >/dev/null 2>&1 || true
  kc rollout restart deploy/promovolve-platform >/dev/null 2>&1 || true
  echo "!! tiers restarting. If the wipe had already run, re-run this script to finish." >&2
  exit "$rc"
}
trap recover ERR

kubectl --context "$CTX" cluster-info >/dev/null 2>&1 \
  || { echo "context '$CTX' unreachable — run: gcloud auth login" >&2; exit 1; }

echo "== target: context '$CTX', namespace '$NS', mode '$MODE'"
echo "== currently holding:"
kc exec promovolve-db-0 -- psql -U promovolve -d promovolve -tAc "
  SELECT '   users='||(SELECT count(*) FROM platform_users)
      ||' orgs='||(SELECT count(*) FROM orgs)
      ||' ledger='||(SELECT count(*) FROM ledger_entries)
      ||' events='||(SELECT count(*) FROM tracking_events)
      ||' currency='||COALESCE((SELECT value FROM platform_settings WHERE key='base_currency'),'(unset → USD)')
" 2>/dev/null || echo "   (could not read — db may already be down)"

if [[ "$CONFIRMED" != true ]]; then
  echo
  echo "DRY RUN — nothing changed. Re-run with --yes to destroy the above."
  exit 0
fi

if [[ "$MODE" == "fast" ]]; then
  echo "== truncating (volumes kept; actor journal survives)"
  kc exec -i promovolve-db-0 -- psql -U promovolve -d promovolve -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
TRUNCATE platform_users, orgs, org_members, platform_settings,
         platform_margin_history, site_requests CASCADE;
TRUNCATE billing_accounts, ledger_entries, ledger_transactions, payouts,
         payout_methods, advertiser_settlements, publisher_settlements,
         settlement_cursors, settlement_windows, fraud_holds CASCADE;
TRUNCATE tracking_events, floor_decisions, mount_beacons,
         campaign_stats, creative_stats, advertiser_summary,
         campaign_hourly_stats, campaign_daily_stats CASCADE;
COMMIT;
SQL
else
  echo "== scaling writers down"
  kc scale statefulset promovolve-api --replicas=0
  kc scale statefulset promovolve-singleton --replicas=0
  kc scale statefulset promovolve-db --replicas=0
  kc wait --for=delete pod/promovolve-db-0 --timeout=120s || true

  echo "== deleting volumes (database + remembered-entity DData)"
  kc delete pvc data-promovolve-db-0 --ignore-not-found
  kc delete pvc -l app=promovolve-api --ignore-not-found
  kc delete pvc ddata-promovolve-singleton-0 --ignore-not-found

  # Re-apply the overlay BEFORE Postgres comes back. init-db.sql is mounted
  # from a kustomize-generated configMap, and deploy.yml rolls images by digest
  # without ever re-applying it — so that configMap holds whatever was last
  # applied by hand, which was 15 days stale. Deleting the volume then gave a
  # database built from a fortnight-old schema: campaign_dim_daily_stats
  # without pub_day_bucket, which killed the dashboard projection on its first
  # envelope every 30s and left campaign_stats permanently empty. A reset must
  # restore the schema the REPO describes, not the one the cluster remembers.
  echo "== re-applying overlay so init-db.sql is current"
  # LoadRestrictionsNone is required: the base configMapGenerator single-sources
  # ../docker/init-db.sql, which kustomize refuses to read from outside the
  # overlay directory by default (k8s-local/up.sh carries the same flag).
  kubectl kustomize --load-restrictor LoadRestrictionsNone "$(dirname "$0")/../k8s-gke" \
    | kubectl --context "$CTX" apply -f -

  echo "== scaling back up (Postgres re-inits from the configMap)"
  kc scale statefulset promovolve-db --replicas=1
  kc rollout status statefulset/promovolve-db --timeout=300s
  kc scale statefulset promovolve-api --replicas=2
  kc scale statefulset promovolve-singleton --replicas=1
fi

# scripts/migrations/ has no runner — those files were applied BY HAND to the
# old volume. A fresh volume runs only docker/init-db.sql, so without this the
# schema comes back OLDER than the code: fraud_flags and campaign_dim_daily_stats
# missing, tracking_events.suspect_reason missing, and the Fraud Review page
# erroring with "could not load fraud flags". Every file is CREATE/ADD ... IF
# NOT EXISTS, so re-running them is safe in either mode.
echo "== applying hand-migrations (no runner exists for these)"
for f in "$(dirname "$0")"/migrations/*.sql; do
  echo "   $(basename "$f")"
  kc exec -i promovolve-db-0 -- psql -U promovolve -d promovolve -v ON_ERROR_STOP=1 < "$f" >/dev/null
done

# The gate caches "an admin exists" in an atomic that never re-checks, so the
# wipe alone does NOT unlock the wizard. This restart is not optional.
echo "== restarting platform to clear the cached Initialized() flag"
kc rollout restart deploy/promovolve-platform
kc rollout status deploy/promovolve-platform --timeout=300s

echo "== waiting for /setup"
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$HOST/setup" || true)
  [[ "$code" == "200" ]] && { echo "   $HOST/setup is live"; break; }
  sleep 10
done

echo
echo "Done. Walk $HOST/setup and pick your currency."
echo "Passkeys work there (RP_ID matches the host) — no DEV_AUTH needed."
echo "The money fields pre-fill DOLLAR magnitudes; selecting a non-USD"
echo "currency clears them, and a sub-unit floor is rejected on a"
echo "zero-decimal currency. Enter real amounts for your market."
