package handler

// Regression: the Y-axis tick loop was written as `.ArgmaxYTicks`, reading the
// enclosing dict instead of `$fo` (.FloorObservations) where the field lives.
// The loop sits inside {{define "sweepAndChart"}}, whose dot is the
// {FO, Cur} map — and a missing MAP key yields the zero value silently rather
// than erroring, so the chart rendered with no gridlines and no axis labels
// while the page still completed. Asserting the labels, not just completion,
// is what makes this catchable: a screenshot of a site with no sweep history
// skips the block entirely, which is how it got past review the first time.

import (
	"io"
	"strings"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/i18n"
	"github.com/hanishi/promovolve/platform/internal/model"
)

func TestObservationsRendersWithArgmaxHistory(t *testing.T) {
	SetFS(platform.Templates, platform.Static)
	pub := &model.User{Email: "pub@test", Role: model.RolePublisher}

	data := pageData{
		Title: "Floor Decisions", Nav: "sites", User: pub,
		FloorObservations: &floorObservationsData{
			SiteID: "site-1",
			// Non-empty history is what gates the chart block.
			ArgmaxHistory: []argmaxHistoryPoint{
				{X: 0, Y: 30, TS: "2026-07-26T00:00:00Z", Label: fmtMoney(1.0)},
				{X: 100, Y: 10, TS: "2026-07-26T01:00:00Z", Label: fmtMoney(2.0)},
			},
			ArgmaxYTicks: []yAxisTick{
				{Y: 0, Label: fmtMoney(2.5)}, {Y: 20, Label: fmtMoney(1.25)}, {Y: 40, Label: fmtMoney(0)},
			},
			Sweep: &floorSweepEvidence{Phase: "exploit", CurrentFloor: fmtMoney(1.5), BestFloor: fmtMoney(1.5)},
		},
	}
	for _, lang := range []string{i18n.LangEN, i18n.LangJA} {
		var b strings.Builder
		if err := getPage(lang, "publisher/site-observations.html").ExecuteTemplate(&b, "layout", data); err != nil {
			t.Fatalf("%s: render failed: %v", lang, err)
		}
		// A truncated render still returns the bytes written before the error,
		// so assert the page actually reached its end rather than trusting
		// err == nil alone.
		out := b.String()
		if !strings.Contains(out, "</html>") {
			t.Errorf("%s: page did not render to completion", lang)
		}
		for _, tick := range []string{fmtMoney(2.5), fmtMoney(1.25)} {
			if !strings.Contains(out, ">"+tick+"</text>") {
				t.Errorf("%s: Y-axis label %q missing — tick loop is reading the wrong scope", lang, tick)
			}
		}
	}
	_ = io.Discard
}
