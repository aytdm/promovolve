package handler

// Render smoke test for the shared date-picker component: executes the
// pages that embed it (advertiser report, publisher observations)
// against the real layout in both languages so template/data mismatches
// fail in CI. With PREVIEW_OUT set, also dumps the rendered HTML for a
// browser screenshot pass (local visual review only).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/i18n"
	"github.com/hanishi/promovolve/platform/internal/model"
)

func TestDatePickerRenders(t *testing.T) {
	SetFS(platform.Templates, platform.Static)
	outDir := os.Getenv("PREVIEW_OUT")

	adv := &model.User{Email: "adv@test", Role: model.RoleAdvertiser}
	pub := &model.User{Email: "pub@test", Role: model.RolePublisher}

	cases := []struct {
		name string
		page string
		data pageData
		want string // a marker only the component emits
	}{
		{
			"report", "advertiser/report.html",
			pageData{Title: "Report", Nav: "report", User: adv, Report: &reportPageData{
				From: "2026-07-21", To: "2026-07-28", Today: "2026-07-28", Preset: "7d",
				HasData:   true,
				Campaigns: []reportBreakdownRow{{Key: "c1", Label: "Summer sale"}},
				// The chart scripts splice these in as raw JS — leaving them
				// zero renders `const labels = ;`, a page-wide SyntaxError
				// the browser suite (dashboard-tests) would flag. Real
				// handlers always marshal at least "[]".
				ChartLabels: "[]", ChartSpend: "[]", ChartImps: "[]",
				CampaignSeries:  reportSeriesChart{Labels: "[]", Series: "[]"},
				SiteSeries:      reportSeriesChart{Labels: "[]", Series: "[]"},
				CategorySeries:  reportSeriesChart{Labels: "[]", Series: "[]"},
				PublisherSeries: reportSeriesChart{Labels: "[]", Series: "[]"},
			}},
			"dateCal('2026-07-28'",
		},
		{
			"campaigns", "advertiser/campaigns.html",
			pageData{Title: "Campaigns", Nav: "campaigns", User: adv,
				NoCampaigns: true, ScheduleTz: "Asia/Tokyo"},
			"dateCal('', '', '', false)",
		},
		{
			"observations", "publisher/site-observations.html",
			pageData{Title: "Floor Decisions", Nav: "sites", User: pub,
				FloorObservations: &floorObservationsData{SiteID: "site-1",
					ArgmaxHistory: []argmaxHistoryPoint{{}},
					ArgmaxNav: &argmaxHistoryNav{
						Today: "2026-07-28", PrevDate: "2026-07-27",
					}},
			},
			"dateCal('2026-07-28'",
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
				t.Errorf("%s/%s: rendered page missing date-picker marker %q", tc.name, tlang, tc.want)
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
