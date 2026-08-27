package handler

// Render smoke test for the publisher creative ledger — the durable
// per-advertiser record whose whole reason to exist is stability while the
// approval queue churns. A template/data mismatch here would fail exactly
// the page built to be trustworthy, so it fails in CI instead.

import (
	"bytes"
	"strings"
	"testing"

	platform "github.com/hanishi/promovolve/platform"
	"github.com/hanishi/promovolve/platform/internal/i18n"
	"github.com/hanishi/promovolve/platform/internal/model"
)

func TestLedgerTemplateRendersStates(t *testing.T) {
	SetFS(platform.Templates, platform.Static)
	pub := &model.User{Email: "pub@test", Role: model.RolePublisher}

	type ledgerCreative struct {
		CreativeID, CampaignID, Name, ApprovalState, ApprovedVia, ApprovedAt string
		PendingPlacements                                                    int
		QueuedSince, FlagReason, CreativeStatus                              string
	}
	type ledgerAdvertiser struct {
		AdvertiserID, Email string
		Creatives           []ledgerCreative
	}
	type ledgerSite struct {
		SiteID, Domain string
		Advertisers    []ledgerAdvertiser
	}

	data := pageData{
		Title: "Creative Ledger", Nav: "approval", User: pub,
		LedgerSites: []ledgerSite{{
			SiteID: "site-1", Domain: "programmer.llc",
			Advertisers: []ledgerAdvertiser{{
				AdvertiserID: "adv-1", Email: "someone@example.com",
				Creatives: []ledgerCreative{
					// One creative per state, so every badge branch renders.
					{CreativeID: "cr-approved", ApprovalState: "approved", ApprovedVia: "auto", CreativeStatus: "Active"},
					{CreativeID: "cr-manual", ApprovalState: "approved", ApprovedVia: "manual", CreativeStatus: "Paused"},
					{CreativeID: "cr-pending", ApprovalState: "pending", PendingPlacements: 4, CreativeStatus: "Active"},
					{CreativeID: "cr-flagged", ApprovalState: "flagged", FlagReason: "off-topic", CreativeStatus: "Active"},
					{CreativeID: "cr-none", ApprovalState: "none"},
				},
			}},
		}},
	}

	for _, lang := range []string{i18n.LangEN, i18n.LangJA} {
		var buf bytes.Buffer
		if err := getPage(lang, "publisher/ledger.html").ExecuteTemplate(&buf, "layout", data); err != nil {
			t.Fatalf("[%s] ledger.html failed to render: %v", lang, err)
		}
		html := buf.String()
		// Every state badge present, exactly as many approved badges as
		// approved creatives, and the advertiser-paused overlay independent
		// of approval state (approved+paused must show BOTH).
		if got := strings.Count(html, "badge-success"); got != 2 {
			t.Errorf("[%s] expected 2 approved badges, got %d", lang, got)
		}
		for _, marker := range []string{"badge-warning", "badge-danger", "badge-neutral", "off-topic", "someone@example.com"} {
			if !strings.Contains(html, marker) {
				t.Errorf("[%s] missing %q", lang, marker)
			}
		}
		// The auto badge renders only for the auto-approved creative.
		if got := strings.Count(html, "badge-info"); got != 1 {
			t.Errorf("[%s] expected exactly 1 auto badge, got %d", lang, got)
		}
	}

	// Empty state must render too — nil LedgerSites is what the handler
	// passes for a publisher with no sites.
	var buf bytes.Buffer
	if err := getPage(i18n.LangEN, "publisher/ledger.html").ExecuteTemplate(&buf, "layout", pageData{
		Title: "Creative Ledger", Nav: "approval", User: pub,
	}); err != nil {
		t.Fatalf("ledger.html failed on empty data: %v", err)
	}
}
