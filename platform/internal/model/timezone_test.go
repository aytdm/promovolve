package model

// The platform's timezone is chosen once at /setup. An account that has stated
// no preference should read the dashboard in it, not in UTC — reported from a
// real install: "TimeZone was not set" after picking Asia/Tokyo in the wizard,
// because the wizard's value seeded the ORG default and nothing else.

import (
	"testing"
	"time"
)

func TestUserLocationFallsBackToSystemTimezone(t *testing.T) {
	t.Cleanup(func() { systemLocation = time.UTC })

	// Before anything is bound, UTC — correct for a deployment that never set one.
	if got := (&User{}).Location(); got != time.UTC {
		t.Errorf("unbound fallback = %v, want UTC", got)
	}

	SetSystemTimezone("Asia/Tokyo")
	if got := (&User{}).Location().String(); got != "Asia/Tokyo" {
		t.Errorf("no preference = %v, want Asia/Tokyo", got)
	}
	// A stated preference still wins.
	if got := (&User{Timezone: "Europe/Berlin"}).Location().String(); got != "Europe/Berlin" {
		t.Errorf("stated preference = %v", got)
	}
	// A stored value that no longer loads degrades to the platform zone rather
	// than breaking the render.
	if got := (&User{Timezone: "Mars/Olympus"}).Location().String(); got != "Asia/Tokyo" {
		t.Errorf("invalid preference = %v, want the system zone", got)
	}
	// An unloadable system zone leaves the previous value alone.
	SetSystemTimezone("Mars/Olympus")
	if got := SystemLocation().String(); got != "Asia/Tokyo" {
		t.Errorf("bad system zone clobbered it: %v", got)
	}
	// Empty means "not configured" and must not reset a bound zone either.
	SetSystemTimezone("")
	if got := SystemLocation().String(); got != "Asia/Tokyo" {
		t.Errorf("empty system zone clobbered it: %v", got)
	}
}
