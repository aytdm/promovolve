package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/mail"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/hanishi/promovolve/platform/internal/currency"
	"github.com/hanishi/promovolve/platform/internal/model"
	"github.com/hanishi/promovolve/platform/internal/setup"
)

// setupPayload rides the ceremony session between setup begin and finish so
// the admin row is only created once the passkey attestation verifies.
type setupPayload struct {
	User    *model.User
	Install setup.InstallParams
}

// SetupPage renders the one-time installation wizard. Inert once an admin
// exists.
func (h *Handler) SetupPage(w http.ResponseWriter, r *http.Request) {
	if h.setupSvc.Initialized(r.Context()) {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	h.render(w, r, "setup.html", pageData{
		Title:      "Set up PromoVolve",
		DevAuth:    h.devAuth,
		Timezones:  preferenceTimezones,
		Currencies: currencyOptions(),
	})
}

type setupBeginRequest struct {
	Email         string `json:"email"`
	DisplayName   string `json:"displayName"`
	Currency      string `json:"currency"`
	MarginPercent string `json:"marginPercent"`
	PayoutFloor   string `json:"payoutFloor"`
	FloorCpm      string `json:"floorCpm"`
	MinFloorCpm   string `json:"minFloorCpm"`
	Timezone      string `json:"timezone"`
}

// validate resolves the currency BEFORE any amount, because every money field
// on this form is denominated in it — the operator is typing yen into these
// boxes, and parsing them as dollars would bake a 157x error into the floors
// on the first install.
func (req *setupBeginRequest) validate() (*model.User, setup.InstallParams, error) {
	var p setup.InstallParams
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		return nil, p, errors.New("a valid email address is required")
	}
	if strings.TrimSpace(req.DisplayName) == "" {
		return nil, p, errors.New("a display name is required")
	}

	cur, err := currency.Get(strings.TrimSpace(req.Currency))
	if err != nil {
		return nil, p, errors.New("choose one of the supported currencies")
	}
	p.BaseCurrency = cur.Code

	if p.MarginBps, err = parseMarginPercent(req.MarginPercent); err != nil {
		return nil, p, err
	}
	amount := func(s, label string) (int64, error) {
		v, err := cur.Parse(s)
		// Same ceiling parseDollars applies. Without it a slipped decimal at
		// install time reaches currency.FromMajor's int64(v*Micro), which is
		// undefined past int64 range — and unlike every other setting there is
		// no edit path for the currency these amounts are denominated in.
		if err != nil || v <= 0 || v > maxAmountMicros {
			return 0, errors.New("the " + label + " must be a positive amount in " + cur.Code)
		}
		return v, nil
	}
	if p.PayoutFloorMicros, err = amount(req.PayoutFloor, "minimum payout"); err != nil {
		return nil, p, err
	}
	if p.FloorCpmMicros, err = amount(req.FloorCpm, "starting floor CPM"); err != nil {
		return nil, p, err
	}
	if p.MinFloorCpmMicros, err = amount(req.MinFloorCpm, "minimum floor CPM"); err != nil {
		return nil, p, err
	}
	if p.MinFloorCpmMicros > p.FloorCpmMicros {
		return nil, p, errors.New("the minimum floor cannot be above the starting floor")
	}
	// Catch a dollar-magnitude amount carried into a zero-decimal currency —
	// the wizard pre-fills 0.50/0.10, and browser autofill can put them back
	// after the field-clearing JS has run. A sub-1 floor in a currency with no
	// subunit is not a price anyone means: ¥0.50 is 157x under market and
	// would clear every auction at nothing. Only guarded for zero-decimal
	// currencies; elsewhere the magnitudes are close enough to dollars that a
	// small floor is a legitimate choice.
	if cur.Decimals == 0 {
		for _, f := range []struct {
			micros int64
			label  string
		}{
			{p.FloorCpmMicros, "starting floor CPM"},
			{p.MinFloorCpmMicros, "minimum floor CPM"},
			{p.PayoutFloorMicros, "minimum payout"},
		} {
			if f.micros < currency.Micro {
				return nil, p, errors.New("the " + f.label + " looks like a " +
					"dollar amount — in " + cur.Code + " it is less than one unit. Enter what it is worth in " + cur.Code)
			}
		}
	}

	p.DefaultTimezone = strings.TrimSpace(req.Timezone)
	if !validTimezone(p.DefaultTimezone) {
		return nil, p, errors.New("the default timezone must be an IANA zone like Asia/Tokyo (leave blank for UTC)")
	}
	return &model.User{
		ID:          uuid.New().String(),
		Email:       email,
		DisplayName: strings.TrimSpace(req.DisplayName),
		Role:        model.RoleAdmin,
		Status:      model.StatusActive,
	}, p, nil
}

// currencyOptions is the setup wizard's dropdown. Offered once, at install:
// there is no edit path, because a ledger amount only means anything in the
// currency it was booked in.
func currencyOptions() []currency.Currency { return currency.Supported }

// parseMarginPercent converts "15" / "15.25" to basis points, rejecting
// values outside [0, 100).
func parseMarginPercent(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, errors.New("a platform margin is required (use 0 for none)")
	}
	pct, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(pct) || pct < 0 || pct >= 100 {
		return 0, errors.New("margin must be a percentage between 0 and 99.99")
	}
	return int(math.Round(pct * 100)), nil
}

// applyInstalledCurrency binds the just-chosen currency for rendering, so the
// very next page the operator sees is already in it. Boot reads this setting
// from the database, but at install time the process has been running since
// before the row existed — without this, the wizard writes JPY and then the
// admin console immediately renders "Floor ($)".
func applyInstalledCurrency(code string) {
	if c, err := currency.Get(code); err == nil {
		SetBaseCurrency(c)
	}
}

func (h *Handler) SetupBegin(w http.ResponseWriter, r *http.Request) {
	if h.setupSvc.Initialized(r.Context()) {
		h.jsonErrorT(w, r, http.StatusConflict, "platform is already initialized")
		return
	}
	var req setupBeginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.jsonErrorT(w, r, http.StatusBadRequest, "invalid request body")
		return
	}
	admin, install, err := req.validate()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	creation, token, err := h.passkeySvc.BeginRegistration(r.Context(), admin,
		setupPayload{User: admin, Install: install})
	if err != nil {
		slog.Error("setup begin failed", "error", err)
		h.jsonErrorT(w, r, http.StatusInternalServerError, "could not start passkey registration")
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"sessionToken": token, "options": creation})
}

func (h *Handler) SetupFinish(w http.ResponseWriter, r *http.Request) {
	env, err := decodeEnvelope(r)
	if err != nil {
		h.jsonErrorT(w, r, http.StatusBadRequest, "invalid request body")
		return
	}
	session, payload, err := h.passkeySvc.TakeSession(env.SessionToken)
	if err != nil {
		h.jsonErrorT(w, r, http.StatusBadRequest, "setup session expired — try again")
		return
	}
	sp, ok := payload.(setupPayload)
	if !ok {
		h.jsonErrorT(w, r, http.StatusBadRequest, "invalid setup session")
		return
	}

	cred, err := h.passkeySvc.FinishRegistration(sp.User, session, bytes.NewReader(env.Credential))
	if err != nil {
		slog.Warn("setup passkey verification failed", "error", err)
		h.jsonErrorT(w, r, http.StatusBadRequest, "passkey registration failed")
		return
	}

	if err := h.setupSvc.CreateAdmin(r.Context(), sp.User, cred, "Setup passkey", sp.Install); err != nil {
		if errors.Is(err, setup.ErrAlreadyInitialized) {
			h.jsonErrorT(w, r, http.StatusConflict, "platform is already initialized")
			return
		}
		slog.Error("setup failed", "error", err)
		h.jsonErrorT(w, r, http.StatusInternalServerError, "could not create the admin account")
		return
	}

	applyInstalledCurrency(sp.Install.BaseCurrency)

	token, err := h.jwtSvc.Issue(sp.User)
	if err != nil {
		h.jsonErrorT(w, r, http.StatusInternalServerError, "failed to issue token")
		return
	}
	h.setSessionCookie(w, token)
	writeJSONResp(w, http.StatusOK, map[string]string{"redirect": homeFor(model.RoleAdmin)})
}

// SetupDev is the DEV_AUTH-only password variant so dev DB wipes don't need
// a browser passkey ceremony. Same guarded transaction underneath.
func (h *Handler) SetupDev(w http.ResponseWriter, r *http.Request) {
	if !h.devAuth {
		http.NotFound(w, r)
		return
	}
	r.ParseForm()
	req := setupBeginRequest{
		Email:         r.FormValue("email"),
		DisplayName:   r.FormValue("displayName"),
		Currency:      r.FormValue("currency"),
		MarginPercent: r.FormValue("marginPercent"),
		PayoutFloor:   r.FormValue("payoutFloor"),
		FloorCpm:      r.FormValue("floorCpm"),
		MinFloorCpm:   r.FormValue("minFloorCpm"),
		Timezone:      r.FormValue("timezone"),
	}
	renderErr := func(msg string) {
		h.render(w, r, "setup.html", pageData{Title: "Set up PromoVolve", DevAuth: h.devAuth, Error: msg,
			Timezones: preferenceTimezones, Currencies: currencyOptions()})
	}

	admin, install, err := req.validate()
	if err != nil {
		renderErr(err.Error())
		return
	}
	password := r.FormValue("password")
	if password == "" {
		renderErr("a password is required")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		renderErr("could not hash password")
		return
	}
	admin.PasswordHash = string(hash)

	if err := h.setupSvc.CreateAdmin(r.Context(), admin, nil, "", install); err != nil {
		if errors.Is(err, setup.ErrAlreadyInitialized) {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		slog.Error("dev setup failed", "error", err)
		renderErr("could not create the admin account")
		return
	}

	applyInstalledCurrency(install.BaseCurrency)

	token, err := h.jwtSvc.Issue(admin)
	if err != nil {
		renderErr("failed to issue token")
		return
	}
	h.setSessionCookie(w, token)
	http.Redirect(w, r, homeFor(model.RoleAdmin), http.StatusSeeOther)
}
