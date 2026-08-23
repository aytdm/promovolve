package handler

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// SearchAdProducts proxies taxonomy search to core API and returns JSON.
// Passes the request language so display names come back localized; the
// core matches the query against English and Japanese names regardless.
// QueryEscape matters here: Japanese queries are multi-byte.
func (h *Handler) SearchAdProducts(w http.ResponseWriter, r *http.Request) {
	user, claims := h.sessionUser(r)
	if claims == nil {
		slog.Warn("SearchAdProducts: unauthorized", "cookies", r.Header.Get("Cookie"))
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	q := r.URL.Query().Get("q")
	body, err := h.coreGet(fmt.Sprintf("/v1/taxonomy/ad-products?q=%s&lang=%s&limit=8",
		url.QueryEscape(q), h.lang(r, user)), claims)
	if err != nil {
		http.Error(w, `{"data":[]}`, http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// SearchCategories proxies content category search to core API. Same
// language handling as SearchAdProducts.
func (h *Handler) SearchCategories(w http.ResponseWriter, r *http.Request) {
	user, claims := h.sessionUser(r)
	if claims == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	q := r.URL.Query().Get("q")
	body, err := h.coreGet(fmt.Sprintf("/v1/taxonomy/categories?q=%s&lang=%s&limit=8",
		url.QueryEscape(q), h.lang(r, user)), claims)
	if err != nil {
		http.Error(w, `{"data":[]}`, http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// SearchSites proxies registered-site search to core API (media-targeting picker)
func (h *Handler) SearchSites(w http.ResponseWriter, r *http.Request) {
	_, claims := h.sessionUser(r)
	if claims == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	q := r.URL.Query().Get("q")
	body, err := h.coreGet(fmt.Sprintf("/v1/sites?q=%s&limit=8", q), claims)
	if err != nil {
		http.Error(w, `{"data":[]}`, http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// SearchPlaces proxies the geographic type-ahead to the core API. Used by
// both the publisher declaring a site audience and the advertiser targeting
// one, so the two sides always pick from the same vocabulary.
// `lang` follows the viewer's dashboard language so a Japanese publisher
// searching 鎌倉 finds it.
func (h *Handler) SearchPlaces(w http.ResponseWriter, r *http.Request) {
	_, claims := h.sessionUser(r)
	if claims == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	q := r.URL.Query().Get("q")
	lang := r.URL.Query().Get("lang")
	codes := r.URL.Query().Get("codes")
	body, err := h.coreGet(fmt.Sprintf("/v1/places?q=%s&codes=%s&lang=%s&limit=8",
		url.QueryEscape(q), url.QueryEscape(codes), url.QueryEscape(lang)), claims)
	if err != nil {
		http.Error(w, `{"data":[]}`, http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// GeoAvailability proxies the geographic inventory check. Called while the
// BidCheck asks the core whether a campaign would bid on a given page URL
// and, if not, which gate stops it. For the advertiser who set a target and
// sees no ads on the page they care about — the answer names the gate
// (category, place, audience, floor, paused) instead of leaving them to
// infer it from a blank slot.
func (h *Handler) BidCheck(w http.ResponseWriter, r *http.Request) {
	_, claims := h.sessionUser(r)
	if claims == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	campaignID := r.URL.Query().Get("campaignId")
	pageURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if campaignID == "" || pageURL == "" {
		http.Error(w, `{"error":"campaignId and url are required"}`, http.StatusBadRequest)
		return
	}
	body, err := h.coreGet(fmt.Sprintf("/v1/advertisers/me/campaigns/%s/bid-check?url=%s",
		url.PathEscape(campaignID), url.QueryEscape(pageURL)), claims)
	if err != nil {
		http.Error(w, `{"error":"bid check unavailable"}`, http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// advertiser edits targeting, so a campaign that would never serve says so
// before it is saved rather than after a flat week of spend.
func (h *Handler) GeoAvailability(w http.ResponseWriter, r *http.Request) {
	_, claims := h.sessionUser(r)
	if claims == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	body, err := h.coreGet(fmt.Sprintf("/v1/geo-availability?audience=%s&places=%s",
		url.QueryEscape(r.URL.Query().Get("audience")),
		url.QueryEscape(r.URL.Query().Get("places"))), claims)
	if err != nil {
		// No body rather than zeros: the UI shows no warning at all when
		// this fails, because a wrong "no inventory" is worse than silence.
		http.Error(w, `{}`, http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// SearchAdvertiserDomains proxies advertiser-domain search to core API
// (publisher's advertiser-domain block picker)
func (h *Handler) SearchAdvertiserDomains(w http.ResponseWriter, r *http.Request) {
	_, claims := h.sessionUser(r)
	if claims == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	q := r.URL.Query().Get("q")
	body, err := h.coreGet(fmt.Sprintf("/v1/advertiser-domains?q=%s&limit=8", q), claims)
	if err != nil {
		http.Error(w, `{"data":[]}`, http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}
