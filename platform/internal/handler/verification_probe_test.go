package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The ownership re-check that runs when a publisher opens a site's details.
//
// Everything here is ADVISORY — no state it can report stops an ad — so the
// thing worth pinning is that each state means what the dashboard claims it
// means. Two of them are easy to get wrong in a way nobody notices:
//
//   - "unreachable" must never be reported as "missing". A blocked request or
//     a TLS quirk telling a publisher their file is gone sends them fixing
//     something that is not broken.
//   - a token that is not theirs must read as "foreign", not "present". It
//     means a leftover file from an earlier setup is answering, which is a
//     different fix from "nothing is there".
func TestProbeVerificationFile(t *testing.T) {
	const want = "promovolve-site-verification=abc123"

	cases := []struct {
		name      string
		handler   http.HandlerFunc
		wantState string
	}{
		{
			name: "the token we expect",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(want))
			},
			wantState: "present",
		},
		{
			// Publishers' editors add them; the file is still correct.
			name: "trailing whitespace and a newline still count",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte("  " + want + "  \n"))
			},
			wantState: "present",
		},
		{
			name: "somebody else's token",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte("promovolve-site-verification=someoneelse"))
			},
			wantState: "foreign",
		},
		{
			name: "a 404",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
			},
			wantState: "missing",
		},
		{
			// A soft-404: 200 with the theme's "page not found" HTML, which
			// is what plenty of hosts serve. Not our token, not a token at
			// all — missing, not foreign.
			name: "a 200 that is not the file",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte("<html>Page not found</html>"))
			},
			wantState: "missing",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()

			got := probeVerificationFile(srv.URL, want)
			if got.State != tc.wantState {
				t.Fatalf("state = %q, want %q", got.State, tc.wantState)
			}
			if got.State == "present" && got.Method != "file" {
				t.Fatalf("method = %q, want %q", got.Method, "file")
			}
		})
	}
}

func TestProbeVerificationFileUnreachableIsNotMissing(t *testing.T) {
	// A server that is not there at all: the publisher's host blocks us, the
	// domain does not resolve, TLS fails. We know nothing, and saying
	// "missing" would be a confident wrong answer on a trust surface.
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close() // nothing is listening now

	if got := probeVerificationFile(url, "promovolve-site-verification=abc123"); got.State != "unreachable" {
		t.Fatalf("state = %q, want %q", got.State, "unreachable")
	}
}

// A publisher whose host owns the web root verifies by DNS TXT and never
// serves the file at all. Checking only the file would report "missing" on a
// site that is perfectly proven — so the file result must not be the last
// word while a DNS name is still to try.
func TestProbeVerificationFallsThroughToDNS(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	// No DNS name given: the file's verdict stands, unchanged.
	if got := probeVerification(srv.URL, "", "promovolve-site-verification=abc123"); got.State != "missing" {
		t.Fatalf("with no DNS name, state = %q, want %q", got.State, "missing")
	}

	// A name that cannot resolve must not upgrade the answer, and must not
	// turn it into something else either — "missing" is still the right fix.
	got := probeVerification(srv.URL, "_promovolve.invalid.", "promovolve-site-verification=abc123")
	if got.State != "missing" {
		t.Fatalf("with an unresolvable DNS name, state = %q, want %q", got.State, "missing")
	}
}
