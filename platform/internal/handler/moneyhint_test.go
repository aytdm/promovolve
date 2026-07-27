package handler

// Placeholders were dollar-shaped: a greyed "10.00" in a yen top-up box
// suggests ¥10 is a sensible amount when the real figure is nearer ¥1,500.
// The hint is scaled by a static per-currency magnitude — never a rate, and
// never applied to a value that gets stored.

import (
	"testing"

	"github.com/hanishi/promovolve/platform/internal/currency"
)

func TestMoneyHintScalesToCurrencyMagnitude(t *testing.T) {
	orig := BaseCurrency()
	t.Cleanup(func() { SetBaseCurrency(orig) })
	hint := funcMap["moneyhint"].(func(float64) string)

	cases := []struct{ code, in, want string }{
		{"USD", "10", "10.00"},
		{"USD", "100", "100.00"},
		// Rounded to two significant figures so it reads as an example, not a
		// computed rate.
		{"JPY", "10", "1500"},
		{"JPY", "100", "15000"},
		{"KRW", "10", "14000"}, // 13,500 rounds up at 2 s.f.
		{"EUR", "10", "9.50"},
	}
	for _, c := range cases {
		SetBaseCurrency(currency.MustGet(c.code))
		var in float64
		switch c.in {
		case "10":
			in = 10
		case "100":
			in = 100
		}
		if got := hint(in); got != c.want {
			t.Errorf("%s moneyhint(%v) = %q, want %q", c.code, in, got, c.want)
		}
	}
}

// Every supported currency needs a usable scale, or its placeholders silently
// fall back to dollar magnitudes.
func TestEverySupportedCurrencyHasAHintScale(t *testing.T) {
	for _, c := range currency.Supported {
		if c.HintScale <= 0 {
			t.Errorf("%s has no HintScale", c.Code)
		}
	}
}
