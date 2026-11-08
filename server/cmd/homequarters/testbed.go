package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"

	"homequarters/internal/testbed"
)

// pluginDirs is the repeatable --plugin flag.
type pluginDirs []string

func (p *pluginDirs) String() string     { return strings.Join(*p, ",") }
func (p *pluginDirs) Set(v string) error { *p = append(*p, v); return nil }

// testbedMain runs `homequarters testbed`: the server for plugin tests (internal/testbed). Once it
// listens it prints one line, {"url":"http://127.0.0.1:PORT"}, on stdout; logs go to stderr as JSON.
// It stops when stdin closes (the test process ended, however it ended), on SIGINT or SIGTERM. With
// --db-temp it then removes the --db database, unless a line "keep" came on stdin before (a restart).
// Exit codes: 0 after a clean stop, 1 when it cannot start or stop cleanly, 2 for bad flags or
// HQ_ENV=production.
func testbedMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("testbed", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var plugins pluginDirs
	fs.Var(&plugins, "plugin", "a plugin folder to load and enable (repeatable, at least one)")
	addr := fs.String("addr", "127.0.0.1:0", "address to listen on, loopback only (port 0: a free port)")
	static := fs.String("static", "", "a built web client to serve (web/dist); none when empty")
	db := fs.String("db", "", "database file, kept after the stop (a restart test reopens it); empty: a temporary one, removed at the stop")
	dbTemp := fs.Bool("db-temp", false, "with --db: remove the database (and its folder, once empty) at the stop, unless a line \"keep\" came on stdin first (a restart reopens it)")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: homequarters testbed --plugin DIR [--plugin DIR]... [--addr A] [--static DIR] [--db FILE [--db-temp]]")
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
	case *dbTemp && *db == "":
		fmt.Fprintln(stderr, "testbed: --db-temp needs --db")
		fs.Usage()
		return 2
	}
	if env := os.Getenv("HQ_ENV"); env != "" && env != "dev" {
		fmt.Fprintf(stderr, "testbed: refused with HQ_ENV=%s: the testbed is for tests only\n", env)
		return 2
	}
	// a test process that died closed stdout and stderr too: on Linux the next log line would kill this
	// process with SIGPIPE before it removes its --db-temp database; ignored, the write only fails
	signal.Ignore(syscall.SIGPIPE)
	log := slog.New(slog.NewJSONHandler(stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// stdin: a line "keep" keeps a --db-temp database (the client restarts the server on it); its end stops
	var keep atomic.Bool
	go func() {
		sc := bufio.NewScanner(stdin)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "keep" {
				keep.Store(true)
			}
		}
		log.Info("stdin closed: shutting down")
		stop()
	}()
	// a --db-temp database goes when the server stops, unless kept: the client's test process may have died
	// without removing it
	defer func() {
		if *dbTemp && !keep.Load() {
			removeDB(*db)
		}
	}()

	bed, err := testbed.Start(ctx, testbed.Options{Plugins: plugins, Addr: *addr, Static: *static, DB: *db, Log: log})
	if err != nil {
		if ctx.Err() != nil { // stdin closed (or a signal) before the server was ready: say so, not "context canceled"
			log.Error("testbed: stopped before it was ready: stdin closed or a signal came (it stops when stdin ends; keep it open)", "err", err)
		} else {
			log.Error("testbed", "err", err)
		}
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

// removeDB removes a SQLite database with its side files, then its folder if nothing else is left in it.
func removeDB(db string) {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		os.Remove(db + suffix)
	}
	os.Remove(filepath.Dir(db)) // fails, harmlessly, while the folder holds anything else
}
