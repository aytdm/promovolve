// Package fx maintains daily foreign-exchange reference rates for
// DISPLAY-ONLY currency conversion. The system of record is USD micros
// everywhere (ledger, auctions, floors, settlement); these rates exist so a
// user who thinks in yen can read their dashboard in yen. One rate per day,
// applied uniformly to every displayed amount, always labeled approximate.
package fx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultRatesURL is a keyless daily USD-base source. Operators can point
// FX_RATES_URL anywhere that returns the same shape:
// {"result":"success","rates":{"JPY":157.3,...}}
const DefaultRatesURL = "https://open.er-api.com/v6/latest/USD"

// SupportedCurrencies is the preferences dropdown, deliberately curated.
// "" (USD) is always valid and means "no conversion".
var SupportedCurrencies = []string{"JPY", "EUR", "GBP", "AUD", "CAD", "KRW", "INR", "BRL"}

// Symbols for formatting. Currencies absent here render as "CODE amount".
var symbols = map[string]string{
	"USD": "$", "JPY": "¥", "EUR": "€", "GBP": "£",
	"AUD": "A$", "CAD": "C$", "KRW": "₩", "INR": "₹", "BRL": "R$",
}

// zeroDecimal currencies conventionally display without cents.
var zeroDecimal = map[string]bool{"JPY": true, "KRW": true}

type Rate struct {
	Rate      float64
	FetchedAt time.Time
}

type Service struct {
	pool   *pgxpool.Pool
	url    string
	client *http.Client

	mu    sync.RWMutex
	rates map[string]Rate
}

func NewService(pool *pgxpool.Pool) *Service {
	url := os.Getenv("FX_RATES_URL")
	if url == "" {
		url = DefaultRatesURL
	}
	return &Service{
		pool:   pool,
		url:    url,
		client: &http.Client{Timeout: 15 * time.Second},
		rates:  map[string]Rate{},
	}
}

// Start loads persisted rates immediately (so a restart never loses display
// conversion) and refreshes daily in the background. Fetch failures keep the
// last stored rates — staleness is disclosed in the UI via the rate date.
func (s *Service) Start(ctx context.Context) {
	s.loadFromDB(ctx)
	go func() {
		s.refresh(ctx)
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.refresh(ctx)
			}
		}
	}()
}

// Get returns the USD→currency rate and its fetch time. ok=false (unknown
// currency or no rates yet) means the caller should fall back to USD.
func (s *Service) Get(currency string) (Rate, bool) {
	if currency == "" || currency == "USD" {
		return Rate{Rate: 1, FetchedAt: time.Now()}, true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.rates[currency]
	return r, ok
}

// Symbol returns the display symbol for a currency ("$" for ""/USD).
func Symbol(currency string) string {
	if currency == "" {
		currency = "USD"
	}
	if sym, ok := symbols[currency]; ok {
		return sym
	}
	return currency + " "
}

// ZeroDecimal reports whether the currency conventionally omits cents.
func ZeroDecimal(currency string) bool { return zeroDecimal[currency] }

func (s *Service) loadFromDB(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `SELECT currency, rate, fetched_at FROM fx_rates`)
	if err != nil {
		slog.Warn("fx: load from db failed", "error", err)
		return
	}
	defer rows.Close()
	loaded := map[string]Rate{}
	for rows.Next() {
		var cur string
		var r Rate
		if err := rows.Scan(&cur, &r.Rate, &r.FetchedAt); err == nil && r.Rate > 0 {
			loaded[cur] = r
		}
	}
	if len(loaded) > 0 {
		s.mu.Lock()
		s.rates = loaded
		s.mu.Unlock()
		slog.Info("fx: loaded rates from db", "currencies", len(loaded))
	}
}

func (s *Service) refresh(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		slog.Warn("fx: bad rates url", "url", s.url, "error", err)
		return
	}
	resp, err := s.client.Do(req)
	if err != nil {
		slog.Warn("fx: rate fetch failed — keeping last stored rates", "error", err)
		return
	}
	defer resp.Body.Close()
	var body struct {
		Result string             `json:"result"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Result != "success" || len(body.Rates) == 0 {
		slog.Warn("fx: unusable rates response — keeping last stored rates", "error", err, "result", body.Result)
		return
	}
	now := time.Now().UTC()
	fresh := map[string]Rate{}
	for _, cur := range SupportedCurrencies {
		if rate, ok := body.Rates[cur]; ok && rate > 0 {
			fresh[cur] = Rate{Rate: rate, FetchedAt: now}
		}
	}
	if len(fresh) == 0 {
		slog.Warn("fx: response had none of the supported currencies")
		return
	}
	s.mu.Lock()
	s.rates = fresh
	s.mu.Unlock()
	for cur, r := range fresh {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO fx_rates (currency, rate, fetched_at) VALUES ($1, $2, $3)
			ON CONFLICT (currency) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at`,
			cur, r.Rate, r.FetchedAt); err != nil {
			slog.Warn("fx: persist rate failed", "currency", cur, "error", err)
		}
	}
	slog.Info("fx: refreshed rates", "currencies", len(fresh))
}
