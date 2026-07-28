// Package i18n is the dashboard's message catalog: English-text-as-key,
// with Japanese as the one translated locale. Zero dependencies.
//
// Developer guide (adding strings, the hard rules, the drift guard):
// dev_docs/I18N.md.
//
// Design (see the dashboard-i18n plan):
//   - The English string IS the key. English needs no catalog; a missing
//     key falls through to itself, so partially translated builds degrade
//     to English, never to a broken page.
//   - The catalog lives in ja.go as Go source — compile-time validated,
//     raw strings for multi-sentence prose, gofmt-stable diffs.
//   - Word-order differences use indexed printf verbs in the ja value:
//     key "Remove %s from %s?" → 「%[2]sから%[1]sを削除しますか？」.
//     T uses the *translated* string as the Sprintf format.
//   - Catalog values must not contain ' " \ ` or </ — translations are
//     interpolated into Alpine attribute expressions where html/template
//     cannot protect them (the drift test enforces this).
package i18n

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Langs the dashboard ships with. "" on a user record means "auto" —
// resolve from the browser's Accept-Language.
const (
	LangEN = "en"
	LangJA = "ja"
)

// catalogs registers every non-English catalog this build can render.
// English needs no catalog — the string IS the key. A deployment adds a
// language by adding its <lang>.go file (a map like ja.go's) and one
// entry here; which registered languages are OFFERED is the operator's
// /admin/settings choice, read at request time (see settings.Service
// and handler.lang).
var catalogs = map[string]map[string]string{
	LangJA: ja,
}

// nativeNames labels each language in itself — what pickers show.
var nativeNames = map[string]string{
	LangEN: "English",
	LangJA: "日本語",
}

// Available lists every language this build can render: English first,
// then the registered catalogs in stable (sorted) order.
func Available() []string {
	langs := make([]string, 0, len(catalogs)+1)
	for l := range catalogs {
		langs = append(langs, l)
	}
	sort.Strings(langs)
	return append([]string{LangEN}, langs...)
}

// NativeName labels lang in itself; unknown tags echo back unchanged so
// a stale preference still renders something identifiable.
func NativeName(lang string) string {
	if n, ok := nativeNames[lang]; ok {
		return n
	}
	return lang
}

// T translates key into lang. Unknown lang or missing key → the key
// itself (English). With args, the translated string is the Sprintf
// format — catalog values may reorder with indexed verbs (%[2]s …).
func T(lang, key string, args ...any) string {
	s := key
	if m := catalogs[lang]; m != nil {
		if v, ok := m[key]; ok {
			s = v
		}
	}
	if len(args) > 0 {
		return fmt.Sprintf(s, args...)
	}
	return s
}

// Resolve picks the request language from the ACTIVE set (the operator's
// ordered /admin/settings choice; active[0] is the deployment default).
// An explicit user preference wins if it's active; "" (auto) falls back
// to the browser's Accept-Language header with proper q-value ordering
// (RFC 9110 §12.4.2 semantics at the fidelity we need — primary
// subtags, quality weights, q=0 exclusion); default active[0]. A nil
// active set defensively means "everything this build has". Still no
// golang.org/x/text: the full matcher earns its keep only when regional
// variants (pt-BR vs pt-PT) start mattering.
func Resolve(pref, acceptLanguage string, active []string) string {
	if len(active) == 0 {
		active = Available()
	}
	isActive := func(l string) bool {
		for _, a := range active {
			if a == l {
				return true
			}
		}
		return false
	}
	if pref != "" && isActive(pref) {
		return pref
	}
	best, bestQ := "", -1.0
	for _, part := range strings.Split(acceptLanguage, ",") {
		tag := strings.TrimSpace(part)
		if tag == "" {
			continue
		}
		q := 1.0
		if i := strings.Index(tag, ";"); i >= 0 {
			for _, p := range strings.Split(tag[i+1:], ";") {
				p = strings.TrimSpace(p)
				if v, ok := strings.CutPrefix(p, "q="); ok {
					if f, err := strconv.ParseFloat(v, 64); err == nil {
						q = f
					}
				}
			}
			tag = strings.TrimSpace(tag[:i])
		}
		if i := strings.IndexByte(tag, '-'); i >= 0 {
			tag = tag[:i] // ja-JP → ja
		}
		lang := strings.ToLower(tag)
		if !isActive(lang) || q <= 0 {
			continue // not offered here, or explicitly excluded (q=0)
		}
		if q > bestQ {
			best, bestQ = lang, q
		}
	}
	if best != "" {
		return best
	}
	return active[0]
}

// Catalogs exposes every registered catalog for the drift test
// (read-only by convention).
func Catalogs() map[string]map[string]string { return catalogs }
