// Package currency holds the deployment's base currency — the single unit
// every amount in the system is denominated in.
//
// PromoVolve is built for a small individual ad network: one operator, one
// country. So there is exactly one currency per deployment, chosen at setup
// and immutable afterwards. There is no conversion anywhere; an operator in
// Japan runs the whole instance in JPY, one in Australia in AUD.
//
// Immutability is not a policy choice, it is arithmetic: a ledger amount is a
// bare int64 with no currency attached, so it only means anything in the
// currency it was booked in. Changing the setting after any money has moved
// would silently reinterpret history. Hence setup-time only, no setter.
//
// Storage stays int64 micros of the currency's major unit — micro-dollars,
// micro-yen — which keeps sub-unit precision for CPMs (a ¥157 CPM is ¥0.157
// per impression) and is currency-agnostic integer math everywhere below the
// display layer.
package currency

import (
	"errors"
	"strconv"
	"strings"
)

// Currency describes how to read and write amounts in one currency. Decimals
// is the number of fractional digits its money is conventionally written with
// — 0 for JPY and KRW, which have no subunit in practice.
type Currency struct {
	Code     string
	Symbol   string
	Decimals int
	// HintScale is roughly how many units of this currency a dollar is worth.
	// It exists ONLY to scale placeholder text — a greyed "10.00" in a yen box
	// suggests ¥10 is a sensible top-up when the real figure is nearer ¥1,500,
	// and a hint that misleads is worse than none.
	//
	// Deliberately a static, approximate constant rather than a rate: the
	// platform holds no exchange rate anywhere, by design, and nothing that
	// gets STORED may pass through this. Stale by a factor of two is fine for
	// an order-of-magnitude hint; being wrong by 150x is not.
	HintScale float64
}

// USD is the fallback for any deployment installed before the base currency
// became configurable: an unset setting must keep meaning exactly what those
// ledgers were booked in.
var USD = Currency{Code: "USD", Symbol: "$", Decimals: 2, HintScale: 1}

// Supported is the setup wizard's list, deliberately curated rather than the
// full ISO set — each entry is a currency someone has to be able to read
// correctly, not merely name.
var Supported = []Currency{
	USD,
	{Code: "JPY", Symbol: "¥", Decimals: 0, HintScale: 150},
	{Code: "EUR", Symbol: "€", Decimals: 2, HintScale: 0.95},
	{Code: "GBP", Symbol: "£", Decimals: 2, HintScale: 0.8},
	{Code: "AUD", Symbol: "A$", Decimals: 2, HintScale: 1.5},
	{Code: "CAD", Symbol: "C$", Decimals: 2, HintScale: 1.4},
	{Code: "KRW", Symbol: "₩", Decimals: 0, HintScale: 1350},
	{Code: "INR", Symbol: "₹", Decimals: 2, HintScale: 85},
	{Code: "BRL", Symbol: "R$", Decimals: 2, HintScale: 5.5},
}

// ErrUnknown is returned for a code outside Supported. Callers seeding the
// setting must treat it as fatal — a deployment must never boot with a
// currency it cannot format.
var ErrUnknown = errors.New("currency: unsupported code")

// Get resolves a currency code. The empty code means USD, so a deployment
// predating this setting reads as what it was always booked in.
func Get(code string) (Currency, error) {
	if code == "" {
		return USD, nil
	}
	for _, c := range Supported {
		if c.Code == code {
			return c, nil
		}
	}
	return USD, ErrUnknown
}

// MustGet is Get for callers that have already validated the code — config
// load at boot, where an unusable currency should stop the process rather
// than silently render every amount in the wrong unit.
func MustGet(code string) Currency {
	c, err := Get(code)
	if err != nil {
		panic("currency: " + err.Error() + ": " + code)
	}
	return c
}

// Micro is one millionth of a major unit. Amounts are stored as int64 counts
// of these.
const Micro = 1_000_000

// FromMajor converts a major-unit amount (the metering and form-entry
// boundary) to micros.
func FromMajor(v float64) int64 {
	if v < 0 {
		return -int64(-v*Micro + 0.5)
	}
	return int64(v*Micro + 0.5)
}

// Major converts micros back to a float, for display and for the float-based
// arithmetic the auction side still uses.
func Major(micros int64) float64 { return float64(micros) / Micro }

// Format renders micros with the currency's symbol and conventional decimal
// places: "$1,234.56", "¥1,235", "−$8.00". The minus is U+2212, which is what
// a money column should use rather than a hyphen.
func (c Currency) Format(micros int64) string {
	if micros < 0 {
		return "−" + c.Symbol + c.group(-micros)
	}
	return c.Symbol + c.group(micros)
}

// FormatSigned always carries an explicit sign, so a delta or a ledger
// movement reads as one: "+$5.00", "−$42.00".
func (c Currency) FormatSigned(micros int64) string {
	if micros < 0 {
		return "−" + c.Symbol + c.group(-micros)
	}
	return "+" + c.Symbol + c.group(micros)
}

// FormatPrec renders with `extra` decimal places beyond the currency's
// convention, for readouts whose whole purpose is fine resolution — the floor
// sweep compares per-candidate revenues that differ in the fourth decimal of a
// dollar. Adding to the convention rather than fixing an absolute precision
// keeps that resolution proportional: 4dp for USD, 2dp for JPY, which is the
// same amount of information in each.
func (c Currency) FormatPrec(micros int64, extra int) string {
	p := Currency{Code: c.Code, Symbol: c.Symbol, Decimals: c.Decimals + extra}
	return p.Format(micros)
}

// Plain renders the number alone, no symbol — for form field values, where
// the symbol belongs in the label beside the input rather than inside it.
//
// No thousands separators either: an <input type="number"> silently discards
// a value it cannot parse, so "¥5,000" and "5,000" both render as an empty
// box. Only a bare decimal round-trips.
func (c Currency) Plain(micros int64) string {
	sign := ""
	if micros < 0 {
		sign, micros = "-", -micros
	}
	scale := int64(Micro)
	for i := 0; i < c.Decimals; i++ {
		scale /= 10
	}
	if scale > 1 {
		micros = (micros + scale/2) / scale * scale
	}
	return sign + strconv.FormatFloat(Major(micros), 'f', c.Decimals, 64)
}

// Parse reads a major-unit amount the way an operator types it: optional
// symbol, optional sign, thousands separators tolerated. It does NOT enforce
// the currency's decimal places — a JPY operator typing "80.5" gets ¥80.5,
// which micros represent exactly; rounding to whole yen is a display concern,
// not a storage one.
func (c Currency) Parse(s string) (int64, error) {
	s = strings.TrimSpace(s)
	neg := false
	switch {
	case strings.HasPrefix(s, "−"), strings.HasPrefix(s, "-"):
		neg = true
		s = strings.TrimPrefix(strings.TrimPrefix(s, "−"), "-")
	case strings.HasPrefix(s, "+"):
		s = s[1:]
	}
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), c.Symbol))
	s = strings.ReplaceAll(s, ",", "")
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, errors.New("currency: not an amount: " + s)
	}
	if neg {
		v = -v
	}
	return FromMajor(v), nil
}

// group formats a positive micro amount with thousands separators at the
// currency's decimal precision.
//
// It rounds half away from zero explicitly, rather than leaving it to
// FormatFloat's half-to-even: FromMajor rounds half away from zero on the way
// in, and a display path that rounded the other way would show ¥0 for an
// amount stored as half a yen.
func (c Currency) group(micros int64) string {
	scale := int64(Micro)
	for i := 0; i < c.Decimals; i++ {
		scale /= 10
	}
	if scale > 1 {
		micros = (micros + scale/2) / scale * scale
	}
	s := strconv.FormatFloat(Major(micros), 'f', c.Decimals, 64)
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	var b strings.Builder
	for i := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteByte(intPart[i])
	}
	return b.String() + frac
}
