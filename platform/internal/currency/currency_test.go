package currency

import "testing"

func TestGetFallsBackToUSD(t *testing.T) {
	// An unset setting is what every deployment installed before this feature
	// has. It must read as USD, because that is what their ledgers hold.
	if c, err := Get(""); err != nil || c.Code != "USD" {
		t.Errorf(`Get("") = %v, %v; want USD, nil`, c, err)
	}
	if c, err := Get("JPY"); err != nil || c.Decimals != 0 || c.Symbol != "¥" {
		t.Errorf(`Get("JPY") = %v, %v`, c, err)
	}
	// An unknown code must be an error, never a silent default — booting with
	// the wrong currency would misrender every amount in the system.
	if _, err := Get("XYZ"); err == nil {
		t.Error(`Get("XYZ") should error`)
	}
}

func TestFormatHonorsDecimals(t *testing.T) {
	usd, _ := Get("USD")
	jpy, _ := Get("JPY")

	cases := []struct {
		c      Currency
		micros int64
		want   string
	}{
		{usd, 8_120_500_000, "$8,120.50"},
		{usd, 500_000, "$0.50"},
		{usd, -8_000_000, "−$8.00"},
		{usd, 0, "$0.00"},
		// Zero-decimal: no phantom cents, and rounding is to whole yen.
		{jpy, 157_000_000, "¥157"},
		{jpy, 1_277_355_000_000, "¥1,277,355"},
		{jpy, -6_607_000_000, "−¥6,607"},
		{jpy, 500_000, "¥1"}, // ¥0.5 rounds for display; storage keeps 500000
	}
	for _, c := range cases {
		if got := c.c.Format(c.micros); got != c.want {
			t.Errorf("%s.Format(%d) = %q, want %q", c.c.Code, c.micros, got, c.want)
		}
	}
}

func TestFormatSignedAlwaysCarriesSign(t *testing.T) {
	usd, _ := Get("USD")
	if got := usd.FormatSigned(5_000_000); got != "+$5.00" {
		t.Errorf("positive = %q", got)
	}
	if got := usd.FormatSigned(-42_000_000); got != "−$42.00" {
		t.Errorf("negative = %q", got)
	}
}

func TestParseRoundTrips(t *testing.T) {
	usd, _ := Get("USD")
	jpy, _ := Get("JPY")

	cases := []struct {
		c    Currency
		in   string
		want int64
	}{
		{usd, "5000.00", 5_000_000_000},
		{usd, "$5,000.00", 5_000_000_000},
		{usd, " 0.50 ", 500_000},
		{usd, "−$8.00", -8_000_000},
		{usd, "-8", -8_000_000},
		{jpy, "80", 80_000_000},
		{jpy, "¥1,277,355", 1_277_355_000_000},
	}
	for _, c := range cases {
		got, err := c.c.Parse(c.in)
		if err != nil || got != c.want {
			t.Errorf("%s.Parse(%q) = %d, %v; want %d", c.c.Code, c.in, got, err, c.want)
		}
	}
	if _, err := usd.Parse("not money"); err == nil {
		t.Error("Parse should reject non-numeric input")
	}
}

// FromMajor is the metering boundary — a float crossing into integer storage.
// Rounding has to be exact at the cent, or settlement drifts a micro at a time.
func TestFromMajorRoundsHalfAway(t *testing.T) {
	cases := []struct {
		in   float64
		want int64
	}{
		{0.5, 500_000},
		{1.005, 1_005_000},
		{-8, -8_000_000},
		{0, 0},
		{0.0000005, 1}, // half a micro rounds up, not toward zero
	}
	for _, c := range cases {
		if got := FromMajor(c.in); got != c.want {
			t.Errorf("FromMajor(%v) = %d, want %d", c.in, got, c.want)
		}
	}
	if got := Major(1_005_000); got != 1.005 {
		t.Errorf("Major round trip = %v", got)
	}
}
