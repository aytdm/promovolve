package handler

// Validation coverage for the setup wizard's begin request — in particular
// that the default advertiser timezone and the chosen base currency survive
// validate() into the ceremony payload (they ride the passkey session to
// SetupFinish, which persists them). The create/persist path needs a live
// Postgres and is exercised via the gated integration setups instead.

import (
	"io"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/currency"
	"github.com/hanishi/promovolve/platform/internal/i18n"
)

func TestSetupValidateCarriesTimezone(t *testing.T) {
	req := setupBeginRequest{
		Email:         "admin@example.com",
		DisplayName:   "Admin",
		MarginPercent: "15",
		PayoutFloor:   "50",
		FloorCpm:      "0.50",
		MinFloorCpm:   "0.10",
		Timezone:      " Asia/Tokyo ",
	}
	admin, p, err := req.validate()
	if err != nil {
		t.Fatalf("validate() unexpected error: %v", err)
	}
	if admin.Email != "admin@example.com" || p.MarginBps != 1500 || p.PayoutFloorMicros != 50_000_000 {
		t.Errorf("validate() = (%q, %d, %d), want (admin@example.com, 1500, 50000000)",
			admin.Email, p.MarginBps, p.PayoutFloorMicros)
	}
	if p.DefaultTimezone != "Asia/Tokyo" {
		t.Errorf("validate() timezone = %q, want %q (trimmed)", p.DefaultTimezone, "Asia/Tokyo")
	}
	// Blank currency means USD, so an operator who never sees the field (or a
	// deployment installed before it existed) lands where the ledger already is.
	if p.BaseCurrency != "USD" {
		t.Errorf("validate() currency = %q, want USD", p.BaseCurrency)
	}

	// Blank means UTC — the wizard's "UTC (default)" option.
	req.Timezone = ""
	if _, p, err = req.validate(); err != nil || p.DefaultTimezone != "" {
		t.Errorf("validate() with blank timezone = (%q, %v), want (\"\", nil)", p.DefaultTimezone, err)
	}

	req.Timezone = "Asia/Nowhere"
	if _, _, err = req.validate(); err == nil {
		t.Error("validate() with unknown timezone expected error, got none")
	}
}

// The whole point of asking for currency first: money fields on this form are
// denominated in it, so a JPY install must store ¥80 as 80 million micros, not
// parse "80" as dollars.
func TestSetupValidateParsesAmountsInChosenCurrency(t *testing.T) {
	req := setupBeginRequest{
		Email: "admin@example.com", DisplayName: "Admin",
		Currency: "JPY", MarginPercent: "15",
		PayoutFloor: "5000", FloorCpm: "80", MinFloorCpm: "20",
	}
	_, p, err := req.validate()
	if err != nil {
		t.Fatalf("validate() unexpected error: %v", err)
	}
	if p.BaseCurrency != "JPY" {
		t.Errorf("currency = %q", p.BaseCurrency)
	}
	if p.PayoutFloorMicros != 5_000_000_000 || p.FloorCpmMicros != 80_000_000 || p.MinFloorCpmMicros != 20_000_000 {
		t.Errorf("amounts = (%d, %d, %d), want (5000000000, 80000000, 20000000)",
			p.PayoutFloorMicros, p.FloorCpmMicros, p.MinFloorCpmMicros)
	}

	// A min floor above the starting floor would have the sweep clamped above
	// its own start on the first cycle.
	req.MinFloorCpm = "200"
	if _, _, err := req.validate(); err == nil {
		t.Error("min floor above starting floor should be rejected")
	}

	req.MinFloorCpm = "20"
	req.Currency = "XYZ"
	if _, _, err := req.validate(); err == nil {
		t.Error("unsupported currency should be rejected, not silently defaulted")
	}
}

func TestSetupTemplateRenders(t *testing.T) {
	SetFS(platform.Templates, platform.Static)

	data := pageData{
		Title:      "Set up PromoVolve",
		DevAuth:    true, // render the dev form's timezone select too
		Error:      "an error banner",
		Timezones:  preferenceTimezones,
		Currencies: currencyOptions(),
	}
	for _, tlang := range []string{i18n.LangEN, i18n.LangJA} {
		if err := getPage(tlang, "setup.html").ExecuteTemplate(io.Discard, "layout", data); err != nil {
			t.Errorf("setup.html failed to render: %v", err)
		}
	}
}

// The wizard writes the currency and then renders the admin console. If the
// process does not adopt it immediately, that next page contradicts the choice
// just made — observed on the cluster as "Floor ($)" right after a JPY install.
func TestSetupAppliesCurrencyImmediately(t *testing.T) {
	orig := BaseCurrency()
	t.Cleanup(func() { SetBaseCurrency(orig) })

	SetBaseCurrency(currency.USD)
	applyInstalledCurrency("JPY")
	if got := BaseCurrency(); got.Code != "JPY" || got.Symbol != "¥" || got.Decimals != 0 {
		t.Errorf("after JPY install, BaseCurrency() = %+v", got)
	}

	// An unusable code must leave the previous value alone rather than
	// silently resetting the deployment to dollars.
	applyInstalledCurrency("XYZ")
	if got := BaseCurrency(); got.Code != "JPY" {
		t.Errorf("bad code clobbered the currency: %+v", got)
	}
}

// The wizard pre-fills dollar magnitudes (0.50 / 0.10 / 50). Carrying those
// into a zero-decimal currency is silent and expensive — ¥0.50 is 157x under
// market, and the label flipping to ¥ makes the stale number look deliberate.
// The page clears the fields on currency change; this is the backstop for
// autofill and for the JS-free dev form.
func TestSetupRejectsDollarMagnitudesInZeroDecimalCurrency(t *testing.T) {
	base := setupBeginRequest{
		Email: "admin@example.com", DisplayName: "Admin",
		Currency: "JPY", MarginPercent: "15",
		PayoutFloor: "5000", FloorCpm: "80", MinFloorCpm: "20",
	}
	if _, _, err := base.validate(); err != nil {
		t.Fatalf("realistic yen amounts rejected: %v", err)
	}

	for _, tc := range []struct{ field, value string }{
		{"FloorCpm", "0.50"}, {"MinFloorCpm", "0.10"}, {"PayoutFloor", "0.50"},
	} {
		req := base
		switch tc.field {
		case "FloorCpm":
			req.FloorCpm = tc.value
		case "MinFloorCpm":
			req.MinFloorCpm = tc.value
		case "PayoutFloor":
			req.PayoutFloor = tc.value
		}
		if _, _, err := req.validate(); err == nil {
			t.Errorf("JPY %s=%s should be rejected as a carried-over dollar amount", tc.field, tc.value)
		}
	}

	// The same amounts are perfectly legitimate in a currency that has cents.
	usd := base
	usd.Currency = "USD"
	usd.PayoutFloor, usd.FloorCpm, usd.MinFloorCpm = "50", "0.50", "0.10"
	if _, _, err := usd.validate(); err != nil {
		t.Errorf("USD defaults rejected: %v", err)
	}
}

// The installer states the platform's timezone once; the admin should not have
// to set the same thing again on /account/preferences, where blank silently
// means UTC. Reported from a real GKE install: "TimeZone was not set" after
// picking Asia/Tokyo in the wizard.
func TestInstallParamsCarryTimezoneForAdminDefault(t *testing.T) {
	req := setupBeginRequest{
		Email: "admin@example.com", DisplayName: "Admin",
		Currency: "JPY", MarginPercent: "15",
		PayoutFloor: "5000", FloorCpm: "80", MinFloorCpm: "20",
		Timezone: "Asia/Tokyo",
	}
	_, p, err := req.validate()
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if p.DefaultTimezone != "Asia/Tokyo" {
		t.Fatalf("DefaultTimezone = %q", p.DefaultTimezone)
	}
}
