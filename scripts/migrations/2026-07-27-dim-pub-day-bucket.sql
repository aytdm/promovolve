-- Add campaign_dim_daily_stats.pub_day_bucket to databases created from the
-- ORIGINAL 2026-07-06 rollup migration, which predates it.
--
-- The projection writes both buckets — day_bucket is the advertiser's local
-- day, pub_day_bucket the publisher's — because the two sides settle on their
-- own timezones and a row is only attributable to each with both. The column
-- was added to production by hand and never written into a migration, so any
-- database rebuilt from the file came back without it. The symptom is severe
-- and silent: the dashboard projection dies on its first envelope
-- ("column pub_day_bucket ... does not exist"), restarts every 30 seconds
-- forever, and campaign_stats is never written — so campaigns show zero
-- impressions while spend, computed live from tracking_events, keeps climbing.
--
-- Safe to re-run. The DEFAULT only backfills pre-existing rows; the projection
-- always supplies the value.
--
--   psql "$DATABASE_URL" -f scripts/migrations/2026-07-27-dim-pub-day-bucket.sql

BEGIN;

ALTER TABLE campaign_dim_daily_stats
  ADD COLUMN IF NOT EXISTS pub_day_bucket DATE NOT NULL DEFAULT CURRENT_DATE;

-- Widen the key so a campaign/site/category can hold one row per DISTINCT
-- pair of local days. With the old four-column key, an advertiser day
-- spanning two publisher days would collide and lose a row on conflict.
ALTER TABLE campaign_dim_daily_stats
  DROP CONSTRAINT IF EXISTS campaign_dim_daily_stats_pkey;
ALTER TABLE campaign_dim_daily_stats
  ADD PRIMARY KEY (campaign_id, day_bucket, pub_day_bucket, site_id, category);

COMMIT;
