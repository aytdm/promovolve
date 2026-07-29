package handler

// Render smoke test for the creative-editor wizard page (the LP image
// tray + save-to-library star live here). With PREVIEW_OUT set, dumps
// the rendered HTML for a local screenshot pass.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/i18n"
	"github.com/hanishi/promovolve/platform/internal/model"
)

func TestCreativeEditorTrayRenders(t *testing.T) {
	SetFS(platform.Templates, platform.Static)
	outDir := os.Getenv("PREVIEW_OUT")
	adv := &model.User{Email: "adv@test", Role: model.RoleAdvertiser}

	data := pageData{Title: "Creative Editor", Nav: "creatives", User: adv,
		CampaignID: "c1", LandingURL: "https://example.com"}
	for _, tlang := range []string{i18n.LangEN, i18n.LangJA} {
		var sb strings.Builder
		if err := getPage(tlang, "advertiser/creative-editor.html").ExecuteTemplate(&sb, "layout", data); err != nil {
			t.Fatalf("%s: render failed: %v", tlang, err)
		}
		out := sb.String()
		if !strings.Contains(out, "toggleLibrarySave") {
			t.Errorf("%s: rendered page missing save-to-library toggle", tlang)
		}
		if outDir != "" {
			p := filepath.Join(outDir, "editor-"+tlang+".html")
			if err := os.WriteFile(p, []byte(out), 0o644); err != nil {
				t.Fatalf("write %s: %v", p, err)
			}
		}
	}
}
