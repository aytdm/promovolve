package main

// seed-account: create a fully-formed advertiser or publisher account —
// user row, core entity, org, and org membership — in one command.
//
// Why this exists: a dashboard account is not one row. `Role` is DERIVED from
// org membership (model.Org.HasSide), so a user created through the DEV_AUTH
// register hatch has a core entity ID but no org, and every RoleGuard bounces
// it straight to /login. That gap defeated browser-driven verification of the
// advertiser and publisher pages three separate times during the base-currency
// work — the campaigns form, the publisher site-request path, and the floor
// decisions page — and one of the bugs those pages were hiding (a min/step
// pairing that made every money form unsubmittable on a zero-decimal currency)
// reached code review instead of being caught by a click.
//
// PAIR IT WITH mint-session, NOT the DEV_AUTH password login. That login path
// does not attach the org session, so a seeded account still bounces to /login
// through it and the seeder looks broken; mint-session builds the org session
// the way a real login does:
//
//	server seed-account  --side advertiser --email adv@acme.com
//	server mint-session   --email adv@acme.com     # line 3 is the JWT
//
// Same threat model as mint-session: anyone who can run it already has the
// database and JWT_SECRET.
//
//	server seed-account --side advertiser --email adv@acme.com [--domain acme.com]

import (
	"context"
	"flag"
	"fmt"
	"net/mail"
	"os"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/hanishi/promovolve/platform/internal/config"
	"github.com/hanishi/promovolve/platform/internal/db"
	"github.com/hanishi/promovolve/platform/internal/model"
	"github.com/hanishi/promovolve/platform/internal/user"
)

func runSeedAccount(cfg config.Config, args []string) int {
	fs := flag.NewFlagSet("seed-account", flag.ContinueOnError)
	side := fs.String("side", "", "advertiser | publisher")
	email := fs.String("email", "", "email for the account")
	domain := fs.String("domain", "", "org domain (default: the email's domain)")
	password := fs.String("password", "", "password for DEV_AUTH login (default: the email)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	role := model.Role(strings.TrimSpace(*side))
	if role != model.RoleAdvertiser && role != model.RolePublisher {
		fmt.Fprintln(os.Stderr, "usage: server seed-account --side advertiser|publisher --email <email> [--domain d] [--password p]")
		return 2
	}
	if _, err := mail.ParseAddress(*email); err != nil {
		fmt.Fprintln(os.Stderr, "a valid --email is required")
		return 2
	}
	orgDomain := strings.TrimSpace(*domain)
	if orgDomain == "" {
		orgDomain = (*email)[strings.LastIndex(*email, "@")+1:]
	}
	pw := *password
	if pw == "" {
		pw = *email
	}

	pool, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "database:", err)
		return 1
	}
	defer pool.Close()
	ctx := context.Background()

	// The core owns entity IDs, so ask it for one rather than inventing a
	// value the auction side has never heard of.
	userSvc := user.NewService(user.NewRepository(pool), nil, cfg.CoreAPIURL)
	entityID, err := userSvc.ProvisionEntity(*email, role)
	if err != nil {
		fmt.Fprintf(os.Stderr, "core %s entity: %v\n", role, err)
		return 1
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hash:", err)
		return 1
	}
	u := &model.User{
		ID: uuid.New().String(), Email: strings.ToLower(*email),
		DisplayName: orgDomain, Role: model.RoleUser,
		Status: model.StatusActive, PasswordHash: string(hash),
	}
	if role == model.RoleAdvertiser {
		u.AdvertiserID = &entityID
	} else {
		u.PublisherID = &entityID
	}
	if err := user.NewRepository(pool).Create(ctx, u); err != nil {
		fmt.Fprintln(os.Stderr, "user:", err)
		return 1
	}

	// The part the register hatch skips, and the whole reason for this
	// command: without the org and the membership, Role never resolves to a
	// side and every guarded page redirects to /login.
	col := "advertiser_id"
	if role == model.RolePublisher {
		col = "publisher_id"
	}
	var orgID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO orgs (domain, name, `+col+`) VALUES ($1, $2, $3)
		ON CONFLICT (domain) DO UPDATE SET `+col+` = EXCLUDED.`+col+`
		RETURNING id::text`, orgDomain, orgDomain, entityID).Scan(&orgID); err != nil {
		fmt.Fprintln(os.Stderr, "org:", err)
		return 1
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO org_members (org_id, user_id, org_role) VALUES ($1, $2, 'admin')
		ON CONFLICT (org_id, user_id) DO NOTHING`, orgID, u.ID); err != nil {
		fmt.Fprintln(os.Stderr, "membership:", err)
		return 1
	}

	fmt.Printf("seeded %s account\n  email:    %s\n  password: %s\n  entity:   %s\n  org:      %s (%s)\n",
		role, u.Email, pw, entityID, orgDomain, orgID)
	return 0
}
