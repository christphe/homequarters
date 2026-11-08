package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"homequarters/internal/config"
	"homequarters/internal/gamemap"
	"homequarters/internal/httpapi"
	"homequarters/internal/media"
	"homequarters/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "testbed" { // a subcommand, before the server's own flags
		os.Exit(testbedMain(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz on HQ_ADDR and exit (for container health checks)")
	inviteRole := flag.String("invite", "", "print a new invite link path for this role (admin|member) and exit; use it to bootstrap the first admin")
	inviteUses := flag.Int("invite-uses", 1, "max uses of the invite created with -invite")
	inviteHours := flag.Int("invite-hours", 24, "validity in hours of the invite created with -invite")
	accountLink := flag.String("account-link", "", "print the personal link of this member and exit; opening it on another machine signs in as them and ends their other sessions")
	backup := flag.String("backup", "", "write a consistent online backup of the SQLite database to this path and exit")
	flag.Parse()
	// a word this binary does not know (a newer version's subcommand, a typo) must not start the server, which
	// would open the default database wherever it was run
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unknown argument %q (subcommands: testbed)\n", flag.Arg(0))
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	if *healthcheck {
		os.Exit(probe(cfg.Addr))
	}
	if *backup != "" {
		os.Exit(runBackup(cfg.DBPath, *backup))
	}
	os.Exit(run(log, cfg, cliFlags{inviteRole: *inviteRole, inviteUses: *inviteUses, inviteHours: *inviteHours, accountLink: *accountLink}))
}

// cliFlags are the one-shot commands that open the store, print and exit instead of serving.
type cliFlags struct {
	inviteRole  string
	inviteUses  int
	inviteHours int
	accountLink string
}

// run opens the store, then serves (or runs a one-shot command of f) and returns the exit code, so that the
// deferred closes and the final snapshot run on every path, which os.Exit would skip.
func run(log *slog.Logger, cfg *config.Config, f cliFlags) int {
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o750); err != nil {
		log.Error("data dir", "err", err)
		return 1
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Error("open store", "err", err)
		return 1
	}
	defer func() {
		if err := st.Close(); err != nil {
			log.Error("close store", "err", err)
		}
	}()

	def, _ := json.Marshal(gamemap.Default())
	office, err := st.EnsureOffice(context.Background(), cfg.OfficeSlug, cfg.OfficeName, string(def))
	if err != nil {
		log.Error("ensure office", "err", err)
		return 1
	}

	if f.inviteRole != "" {
		tok, err := st.CreateInvite(context.Background(), office.ID, f.inviteRole, f.inviteUses, time.Duration(f.inviteHours)*time.Hour, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, "invite:", err)
			return 1
		}
		_ = st.Audit(context.Background(), office.ID, 0, "invite.create", 0, "", fmt.Sprintf("cli role=%s uses=%d hours=%d", f.inviteRole, f.inviteUses, f.inviteHours))
		fmt.Println("/?invite=" + tok)
		return 0
	}

	if f.accountLink != "" {
		uid, err := st.MemberByName(context.Background(), office.ID, f.accountLink)
		if err != nil {
			fmt.Fprintln(os.Stderr, "account link:", err)
			return 1
		}
		if cfg.AuthEnabled() {
			// the link would bypass the sign-in of somebody who has one
			if linked, err := st.HasIdentityFor(context.Background(), uid, cfg.AuthProviders); err != nil || linked {
				fmt.Fprintln(os.Stderr, "account link: this member signs in with a provider; personal links only serve members who have not linked one yet")
				return 1
			}
		}
		tok, err := st.CreateAccountLink(context.Background(), uid, office.ID)
		if err != nil {
			fmt.Fprintln(os.Stderr, "account link:", err)
			return 1
		}
		_ = st.Audit(context.Background(), office.ID, 0, "account.link.create", uid, f.accountLink, "cli")
		fmt.Println("/link/" + tok)
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if cfg.StopOnStdinClose { // dev only: the test runner's graceful stop on Windows
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin) // a read error ends stdin as well as its end does
			log.Info("stdin closed: shutting down")
			stop()
		}()
	}

	md := media.New(media.Config{PublicURL: cfg.LiveKitURL, APIURL: cfg.LiveKitAPIURL, Key: cfg.LiveKitKey, Secret: cfg.LiveKitSecret, TokenTTL: cfg.MediaTTL}, log)
	go md.Run(ctx)
	if !md.Enabled() {
		log.Warn("LiveKit not configured: audio/video disabled (conversations still form, without media)")
	}

	srv := httpapi.New(ctx, cfg, log, st, md)
	hs := &http.Server{Addr: cfg.Addr, Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		if err := hs.Shutdown(sctx); err != nil {
			log.Warn("http shutdown", "err", err)
		}
	}()
	log.Info("listening", "addr", cfg.Addr, "env", cfg.Env, "office", office.Slug, "media", md.Enabled())
	code := 0
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server", "err", err)
		code = 1
	}
	stop()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Wait(shutdown); err != nil {
		log.Error("final snapshot timeout", "err", err)
	}
	return code
}

func probe(addr string) int {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/readyz", nil)
	if err != nil {
		return 2
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// runBackup uses VACUUM INTO: a transactionally consistent copy that is safe while the server is running.
func runBackup(dbPath, dest string) int {
	if _, err := os.Stat(dest); err == nil {
		fmt.Fprintln(os.Stderr, "destination already exists:", dest)
		return 2
	}
	st, err := store.Open(dbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		return 1
	}
	defer func() { _ = st.Close() }() // the backup is a separate file, written and closed by VACUUM INTO
	if err := st.BackupTo(context.Background(), dest); err != nil {
		fmt.Fprintln(os.Stderr, "backup:", err)
		return 1
	}
	fmt.Println("backup written to", dest)
	return 0
}
