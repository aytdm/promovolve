package handler

// Render smoke test for the advertiser campaigns page — the create form and
// the inline Edit panel — with the frequency-cap controls populated, so a
// template/data mismatch (a renamed field, a bad `eq`) fails in CI instead
// of at the advertiser's first click. docs/design/FREQUENCY_CAPPING.md.

import (
	"bytes"
	"strings"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/i18n"
	"github.com/hanishi/promovolve/platform/internal/model"
)

func TestCampaignsTemplateRendersFrequencyCap(t *testing.T) {
	SetFS(platform.Templates, platform.Static)
	adv := &model.User{Email: "adv@test", Role: model.RoleAdvertiser}
	data := pageData{
		Title: "Campaigns", Nav: "campaigns", User: adv,
		ListNav:    &listNav{Page: 1, TotalPages: 1, Total: 2, From: 1, To: 2},
		ScheduleTz: "Asia/Tokyo",
		Campaigns: []campaignData{
			{ID: "camp-capped", Name: "Capped", Status: "active", DailyBudget: "100.00", MaxCPM: "5.00",
				LandingURL: "https://example.com/a", FrequencyCapN: 3, FrequencyCapWindow: "week"},
			{ID: "camp-open", Name: "Uncapped", Status: "paused", DailyBudget: "50.00", MaxCPM: "2.00",
				LandingURL: "https://example.com/b", FrequencyCapN: 0, FrequencyCapWindow: "day"},
		},
	}
	for _, tlang := range []string{i18n.LangEN, i18n.LangJA} {
		var buf bytes.Buffer
		if err := getPage(tlang, "advertiser/campaigns.html").ExecuteTemplate(&buf, "layout", data); err != nil {
			t.Fatalf("[%s] campaigns.html failed to render: %v", tlang, err)
		}
		html := buf.String()
		// Create form + two edit panels = three pairs of selects.
		if got := strings.Count(html, `name="freqCapN"`); got != 3 {
			t.Errorf("[%s] expected 3 freqCapN selects (create + 2 edit panels), got %d", tlang, got)
		}
		if got := strings.Count(html, `name="freqCapWindow"`); got != 3 {
			t.Errorf("[%s] expected 3 freqCapWindow selects, got %d", tlang, got)
		}
		// The capped campaign's panel pre-selects 3 / week; the uncapped one
		// pre-selects "No cap" / day.
		if !strings.Contains(html, `<option value="3" selected>3</option>`) {
			t.Errorf("[%s] capped campaign should pre-select 3 impressions", tlang)
		}
		if !strings.Contains(html, `<option value="week" selected>`) {
			t.Errorf("[%s] capped campaign should pre-select the week window", tlang)
		}
		if !strings.Contains(html, `<option value="0" selected>`) {
			t.Errorf("[%s] uncapped campaign should pre-select No cap", tlang)
		}
		if !strings.Contains(html, `<option value="day" selected>`) {
			t.Errorf("[%s] uncapped campaign should pre-select the day window", tlang)
		}
		// "No cap per week" is not a policy: the window select is disabled
		// while the cap is 0, and seeded from the campaign's stored value so
		// an already-uncapped campaign opens with it greyed out rather than
		// waiting for a change event that never comes.
		if got := strings.Count(html, `:disabled="freqN === '0'"`); got != 3 {
			t.Errorf("[%s] expected 3 window selects bound to the No-cap state, got %d", tlang, got)
		}
		// Create form + the uncapped campaign's panel both seed 0; the
		// capped one seeds its stored 3. Counting is what distinguishes
		// "seeded from the campaign" from "always 0".
		if got := strings.Count(html, `x-data="{ freqN: '0' }"`); got != 2 {
			t.Errorf("[%s] expected 2 panels seeded at No cap (create + uncapped), got %d", tlang, got)
		}
		if got := strings.Count(html, `x-data="{ freqN: '3' }"`); got != 1 {
			t.Errorf("[%s] the capped campaign's panel should seed freqN at its stored cap, got %d", tlang, got)
		}
	}
}
