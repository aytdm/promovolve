package settings

import (
	"strings"
	"testing"
)

func TestNet(t *testing.T) {
	cases := []struct {
		gross   float64
		bps     int
		wantNet float64
		wantFee float64
	}{
		{100, 1500, 85, 15},
		{100, 0, 100, 0},
		{0, 1500, 0, 0},
		{8.50, 1250, 7.4375, 1.0625},
		{100, 9999, 0.01, 99.99},
	}
	for _, c := range cases {
		net, fee := Net(c.gross, c.bps)
		if diff := net - c.wantNet; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("Net(%v, %d) net = %v, want %v", c.gross, c.bps, net, c.wantNet)
		}
		if diff := fee - c.wantFee; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("Net(%v, %d) fee = %v, want %v", c.gross, c.bps, fee, c.wantFee)
		}
	}
}

func TestNormalizeLanguages(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"ja", "en"}, "ja,en"},         // order preserved (first = default)
		{[]string{" EN ", "ja", "en"}, "en,ja"}, // trim, lowercase, dedupe
		{[]string{"de", "fr"}, ""},              // nothing this build ships
		{[]string{"de", "ja", "xx"}, "ja"},      // unknown dropped, known kept
		{nil, ""},
	}
	for _, c := range cases {
		got := strings.Join(normalizeLanguages(c.in), ",")
		if got != c.want {
			t.Errorf("normalizeLanguages(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
