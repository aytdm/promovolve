// Package settings stores platform-wide configuration: the platform
// margin (the fee deducted from publisher earnings) and the deployment's
// active dashboard languages.
//
// The margin history is append-only and effective-dated: the current margin
// is the latest row with effective_from <= now(), so past earnings are never
// silently repriced by a settings change.
package settings

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hanishi/promovolve/platform/internal/i18n"
)

type MarginEntry struct {
	MarginBps     int
	EffectiveFrom time.Time
	CreatedBy     *string
}

type Service struct {
	pool *pgxpool.Pool

	// The margin is read on every publisher page render; cache it briefly.
	// Single pod, and SetMargin invalidates, so 30 s staleness only ever
	// applies across replicas that don't exist.
	mu       sync.Mutex
	cached   int
	cachedAt time.Time

	// Active languages are read on EVERY request (handler.lang); same
	// short cache, invalidated by SetActiveLanguages.
	langsMu       sync.Mutex
	langsCached   []string
	langsCachedAt time.Time
}

const cacheTTL = 30 * time.Second

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// CurrentMarginBps returns the effective platform margin in basis points.
// A missing row (pre-setup database) degrades to 0 — plain gross display.
func (s *Service) CurrentMarginBps(ctx context.Context) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.cachedAt) < cacheTTL {
		return s.cached
	}

	var bps int
	err := s.pool.QueryRow(ctx, `
		SELECT margin_bps FROM platform_margin_history
		WHERE effective_from <= NOW()
		ORDER BY effective_from DESC LIMIT 1`,
	).Scan(&bps)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			// Transient DB error: serve the stale value rather than flapping
			// the displayed fee to zero.
			return s.cached
		}
		bps = 0
	}
	s.cached = bps
	s.cachedAt = time.Now()
	return bps
}

// MarginBpsAt returns the margin effective at a point in time — the
// settlement job passes the end of the day being settled so the snapshot
// covers the whole day. Uncached: settlement runs a handful of times a day.
// A missing row (margin never configured) degrades to 0 like CurrentMarginBps.
func (s *Service) MarginBpsAt(ctx context.Context, at time.Time) (int, error) {
	var bps int
	err := s.pool.QueryRow(ctx, `
		SELECT margin_bps FROM platform_margin_history
		WHERE effective_from < $1
		ORDER BY effective_from DESC LIMIT 1`,
		at,
	).Scan(&bps)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return bps, err
}

func (s *Service) History(ctx context.Context) ([]MarginEntry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT margin_bps, effective_from, created_by::text
		FROM platform_margin_history ORDER BY effective_from DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []MarginEntry
	for rows.Next() {
		var e MarginEntry
		if err := rows.Scan(&e.MarginBps, &e.EffectiveFrom, &e.CreatedBy); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// SetMargin appends a new effective-dated margin row and invalidates the cache.
func (s *Service) SetMargin(ctx context.Context, bps int, createdBy string) error {
	if bps < 0 || bps >= 10000 {
		return errors.New("margin must be between 0 and 9999 basis points")
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO platform_margin_history (margin_bps, created_by) VALUES ($1, $2)`,
		bps, createdBy,
	)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.cachedAt = time.Time{}
	s.mu.Unlock()
	return nil
}

// Net splits a gross amount into the publisher's net and the platform fee.
func Net(gross float64, bps int) (net, fee float64) {
	fee = gross * float64(bps) / 10000
	return gross - fee, fee
}

// ── prohibited ad-product categories ─────────────────────────────────

const prohibitedAdProductsKey = "prohibited_ad_products"

// ProhibitedAdProducts is the operator's system-wide disallow list of
// ad-product category ids (e.g. Tobacco for a JP deployment). The CORE
// enforces it at campaign registration by reading this same row through
// its dashboard-DB handle; here it only feeds the admin UI. Uncached —
// the admin settings page is the sole reader on this side.
func (s *Service) ProhibitedAdProducts(ctx context.Context) []string {
	var raw string
	if err := s.pool.QueryRow(ctx,
		`SELECT value FROM platform_settings WHERE key = $1`, prohibitedAdProductsKey,
	).Scan(&raw); err != nil {
		return nil
	}
	var out []string
	for _, id := range strings.Split(raw, ",") {
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// SetProhibitedAdProducts stores the list (dedupe, drop blanks). An
// empty list is valid — it clears the prohibition.
func (s *Service) SetProhibitedAdProducts(ctx context.Context, ids []string, updatedBy string) error {
	seen := map[string]bool{}
	var clean []string
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !seen[id] {
			seen[id] = true
			clean = append(clean, id)
		}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO platform_settings (key, value, updated_by, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
		prohibitedAdProductsKey, strings.Join(clean, ","), updatedBy,
	)
	return err
}

// ── active languages ─────────────────────────────────────────────────

const activeLanguagesKey = "active_languages"

// defaultLanguages is what a deployment offers before the admin ever
// touches the setting: the LANGUAGES env var (ordered CSV, first =
// default) filtered to the catalogs this build ships, else everything
// the build ships. Read once — it is a boot-time default, not live
// configuration; the live knob is /admin/settings.
var defaultLanguages = sync.OnceValue(func() []string {
	if env := os.Getenv("LANGUAGES"); env != "" {
		if langs := normalizeLanguages(strings.Split(env, ",")); len(langs) > 0 {
			return langs
		}
	}
	return i18n.Available()
})

// normalizeLanguages trims, lowercases, dedupes, and drops anything the
// build has no catalog for, preserving order (first entry = deployment
// default language).
func normalizeLanguages(in []string) []string {
	available := i18n.Available()
	seen := map[string]bool{}
	var out []string
	for _, l := range in {
		l = strings.ToLower(strings.TrimSpace(l))
		if l == "" || seen[l] {
			continue
		}
		for _, a := range available {
			if a == l {
				seen[l] = true
				out = append(out, l)
				break
			}
		}
	}
	return out
}

// ActiveLanguages returns the ordered set of dashboard languages this
// deployment offers (first = default). Unset degrades to the boot-time
// default; a transient DB error serves the cached value rather than
// flapping the UI language.
func (s *Service) ActiveLanguages(ctx context.Context) []string {
	s.langsMu.Lock()
	defer s.langsMu.Unlock()
	if time.Since(s.langsCachedAt) < cacheTTL {
		return s.langsCached
	}

	var raw string
	err := s.pool.QueryRow(ctx,
		`SELECT value FROM platform_settings WHERE key = $1`, activeLanguagesKey,
	).Scan(&raw)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) && s.langsCached != nil {
			return s.langsCached
		}
		s.langsCached = defaultLanguages()
		s.langsCachedAt = time.Now()
		return s.langsCached
	}
	langs := normalizeLanguages(strings.Split(raw, ","))
	if len(langs) == 0 {
		// A stored set referencing only catalogs this build no longer
		// ships must not brick the dashboard — fall back to the default.
		langs = defaultLanguages()
	}
	s.langsCached = langs
	s.langsCachedAt = time.Now()
	return langs
}

// SetActiveLanguages stores the operator's ordered language choice
// (first = deployment default) and invalidates the cache.
func (s *Service) SetActiveLanguages(ctx context.Context, langs []string, updatedBy string) error {
	normalized := normalizeLanguages(langs)
	if len(normalized) == 0 {
		return fmt.Errorf("settings: at least one available language required (this build ships %s)",
			strings.Join(i18n.Available(), ", "))
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO platform_settings (key, value, updated_by, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
		activeLanguagesKey, strings.Join(normalized, ","), updatedBy,
	)
	if err != nil {
		return err
	}
	s.langsMu.Lock()
	s.langsCachedAt = time.Time{}
	s.langsMu.Unlock()
	return nil
}
