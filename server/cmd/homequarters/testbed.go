package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"homequarters/internal/testbed"
)

// pluginDirs is the repeatable --plugin flag.
type pluginDirs []string

func (p *pluginDirs) String() string     { return strings.Join(*p, ",") }
func (p *pluginDirs) Set(v string) error { *p = append(*p, v); return nil }

// testbedMain runs `homequarters testbed`: the server for plugin tests (internal/testbed). Once it
// listens it prints one line, {"url":"http://127.0.0.1:PORT"}, on stdout; logs go to stderr as JSON.
// It stops when stdin closes (the test process ended, however it ended), on SIGINT or SIGTERM.
// Exit codes: 0 after a clean stop, 1 when it cannot start or stop cleanly, 2 for bad flags or
// HQ_ENV=production.
func testbedMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("testbed", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var plugins pluginDirs
	fs.Var(&plugins, "plugin", "a plugin folder to load and enable (repeatable, at least one)")
	addr := fs.String("addr", "127.0.0.1:0", "address to listen on (port 0: a free port)")
	static := fs.String("static", "", "a built web client to serve (web/dist); none when empty")
	db := fs.String("db", "", "database file, kept after the stop (a restart test reopens it); empty: a temporary one, removed at the stop")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: homequarters testbed --plugin DIR [--plugin DIR]... [--addr A] [--static DIR] [--db FILE]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	switch {
	case fs.NArg() > 0:
		fmt.Fprintf(stderr, "testbed: unexpected argument %q\n", fs.Arg(0))
		fs.Usage()
		return 2
	case len(plugins) == 0:
		fmt.Fprintln(stderr, "testbed: at least one --plugin is required")
		fs.Usage()
		return 2
	}
	if env := os.Getenv("HQ_ENV"); env != "" && env != "dev" {
		fmt.Fprintf(stderr, "testbed: refused with HQ_ENV=%s: the testbed is for tests only\n", env)
		return 2
	}
	log := slog.New(slog.NewJSONHandler(stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		io.Copy(io.Discard, stdin)
		log.Info("stdin closed: shutting down")
		stop()
	}()

	bed, err := testbed.Start(ctx, testbed.Options{Plugins: plugins, Addr: *addr, Static: *static, DB: *db, Log: log})
	if err != nil {
		log.Error("testbed", "err", err)
		return 1
	}
	line, _ := json.Marshal(map[string]string{"url": bed.URL})
	if _, err := fmt.Fprintf(stdout, "%s\n", line); err != nil {
		log.Error("write the url", "err", err)
		bed.Close()
		return 1
	}
	<-ctx.Done()
	if err := bed.Close(); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("testbed stop", "err", err)
		return 1
	}
	return 0
}
