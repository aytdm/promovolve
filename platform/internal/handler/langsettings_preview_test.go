package handler

// Render smoke test for the language settings: the admin "Dashboard
// languages" card and the preference picker's active-set options, in
// both languages. With PREVIEW_OUT set, dumps the rendered HTML for a
// local screenshot pass.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/i18n"
	"github.com/hanishi/promovolve/platform/internal/model"
)

func TestLanguageSettingsRender(t *testing.T) {
	SetFS(platform.Templates, platform.Static)
	outDir := os.Getenv("PREVIEW_OUT")

	admin := &model.User{Email: "admin@test", Role: model.RoleAdmin}
	adv := &model.User{Email: "adv@test", Role: model.RoleAdvertiser, Locale: "ja"}

	cases := []struct {
		name string
		page string
		data pageData
		want string
	}{
		{
			"admin-settings", "admin/settings.html",
			pageData{Title: "Platform Settings", Nav: "admin-settings", User: admin,
				MarginPct: "15", OrgMaxMembers: 10,
				AllLanguages: []adminLangOption{
					{Tag: "en", Name: "English", Active: true, Default: true},
					{Tag: "ja", Name: "日本語", Active: true},
				},
			},
			`action="/admin/settings/languages"`,
		},
		{
			"preferences", "account-preferences.html",
			pageData{Title: "Preferences", Nav: "preferences", User: adv,
				Timezones: []string{"UTC", "Asia/Tokyo"},
				Languages: []langOption{
					{Tag: "en", Name: i18n.NativeName("en")},
					{Tag: "ja", Name: i18n.NativeName("ja")},
				},
			},
			`value="ja" selected`,
		},
	}
	for _, tc := range cases {
		for _, tlang := range []string{i18n.LangEN, i18n.LangJA} {
			var sb strings.Builder
			if err := getPage(tlang, tc.page).ExecuteTemplate(&sb, "layout", tc.data); err != nil {
				t.Fatalf("%s/%s: render failed: %v", tc.name, tlang, err)
			}
			out := sb.String()
			if !strings.Contains(out, tc.want) {
				t.Errorf("%s/%s: rendered page missing %q", tc.name, tlang, tc.want)
			}
			if outDir != "" {
				p := filepath.Join(outDir, tc.name+"-"+tlang+".html")
				if err := os.WriteFile(p, []byte(out), 0o644); err != nil {
					t.Fatalf("write %s: %v", p, err)
				}
			}
		}
	}
}
