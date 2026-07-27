-- Widen every accumulated-spend column from DECIMAL(12,4) / DECIMAL(14,4) to
-- DECIMAL(18,4).
--
-- Why: the base currency is now chosen per deployment (one operator, one
-- country, one currency — see the setup wizard). DECIMAL(12,4) allows eight
-- digits before the point, which is ~100M major units. That is an ample
-- lifetime ceiling in dollars and roughly $640k worth of yen — a limit that
-- belonged to the currency the schema happened to be written in, not to the
-- money. At 18,4 the ceiling is ~100 trillion major units, which is out of
-- reach in any supported currency.
--
-- Widening a NUMERIC in Postgres rewrites no rows and takes only a brief
-- ACCESS EXCLUSIVE lock on the catalog entry; values and scale are unchanged,
-- so this is safe to run on a live database.
--
-- Apply by hand (this project has no migration runner for the core DB):
--   psql "$DATABASE_URL" -f scripts/migrations/2026-07-26-widen-spend-columns.sql

ALTER TABLE campaign_stats            ALTER COLUMN total_spend TYPE DECIMAL(18, 4);
ALTER TABLE creative_stats            ALTER COLUMN total_spend TYPE DECIMAL(18, 4);
ALTER TABLE advertiser_summary        ALTER COLUMN total_spend TYPE DECIMAL(18, 4);
ALTER TABLE campaign_hourly_stats     ALTER COLUMN spend       TYPE DECIMAL(18, 4);
ALTER TABLE campaign_daily_stats      ALTER COLUMN spend       TYPE DECIMAL(18, 4);

-- Created by 2026-07-06-advertiser-report-dim-rollup.sql; skip if that
-- migration has not been applied on this database.
ALTER TABLE IF EXISTS campaign_dim_daily_stats ALTER COLUMN spend TYPE DECIMAL(18, 4);
