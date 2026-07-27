package handler

// Regression coverage for the hand-entered-amount ceiling.
//
// The original bound was `v > 1e7` on the MAJOR-unit float, i.e. ten million
// dollars. Once the base currency became configurable that silently became a
// business limit rather than a fat-finger guard: ¥10M is about $63k, so a
// mid-sized yen top-up or payout floor was rejected as malformed. Caught by
// installing a JPY deployment locally and posting ¥20,000,000 to the payout
// floor, which came back "must be a positive amount".

import (
	"testing"

	"github.com/hanishi/promovolve/platform/internal/currency"
)

func TestParseDollarsCeilingIsGenerousInEveryCurrency(t *testing.T) {
	orig := BaseCurrency()
	t.Cleanup(func() { SetBaseCurrency(orig) })

	for _, code := range []string{"USD", "JPY"} {
		SetBaseCurrency(currency.MustGet(code))

		// A realistic large entry must be accepted. ¥20M is ~$130k — a
		// perfectly ordinary prepay, and exactly what the old bound rejected.
		got, err := parseDollars("20000000")
		if err != nil {
			t.Errorf("%s: parseDollars(20000000) rejected a legitimate amount: %v", code, err)
		} else if got != 20_000_000*currency.Micro {
			t.Errorf("%s: parseDollars(20000000) = %d micros", code, got)
		}

		// The guard still has to fire on an obviously slipped decimal.
		if _, err := parseDollars("100000000000"); err == nil {
			t.Errorf("%s: parseDollars accepted an absurd amount", code)
		}
		// And on the things it always rejected.
		for _, bad := range []string{"0", "-5", "", "abc"} {
			if _, err := parseDollars(bad); err == nil {
				t.Errorf("%s: parseDollars(%q) should be rejected", code, bad)
			}
		}
	}
}

// Amounts are entered in the deployment's currency, so the same keystrokes
// must land as that currency's micros — not reinterpreted as dollars.
func TestParseDollarsUsesBaseCurrency(t *testing.T) {
	orig := BaseCurrency()
	t.Cleanup(func() { SetBaseCurrency(orig) })

	SetBaseCurrency(currency.MustGet("JPY"))
	got, err := parseDollars("¥5,000")
	if err != nil || got != 5_000*currency.Micro {
		t.Errorf(`parseDollars("¥5,000") = %d, %v; want %d`, got, err, 5_000*currency.Micro)
	}

	SetBaseCurrency(currency.MustGet("USD"))
	got, err = parseDollars("$5,000.50")
	if err != nil || got != 5_000_500_000 {
		t.Errorf(`parseDollars("$5,000.50") = %d, %v; want 5000500000`, got, err)
	}
}
