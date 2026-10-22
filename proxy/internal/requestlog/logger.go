package requestlog

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	idleTTL = 5 * time.Minute
)

type Entry struct {
	Method          string
	URL             string
	Domain          string
	SourceIP        string
	Status          int
	Size            int64
	DurationMillis  int64
	RequestHeaders  string
	ResponseHeaders string
	RequestBody     string
	ResponseBody    string
}

type Logger struct {
	rootPath  string
	queue     chan task
	done      chan struct{}
	closeOnce sync.Once
}

type task struct {
	directory string
	entry     Entry
}

type cachedDB struct {
	db       *sql.DB
	path     string
	file     os.FileInfo
	lastUsed time.Time
}

func New(rootPath string, queueDepth int) *Logger {
	logger := &Logger{
		rootPath: rootPath,
		done:     make(chan struct{}),
	}

	if rootPath == "" {
		close(logger.done)
		return logger
	}

	logger.queue = make(chan task, queueDepth)

	go logger.run()

	return logger
}

func (l *Logger) Log(directory string, entry Entry) {
	if l.rootPath == "" || directory == "" {
		return
	}

	select {
	case l.queue <- task{directory: directory, entry: entry}:
	default:
	}
}

func (l *Logger) Close(ctx context.Context) error {
	l.closeOnce.Do(func() {
		if l.queue != nil {
			close(l.queue)
		}
	})

	select {
	case <-l.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *Logger) run() {
	defer close(l.done)

	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	cache := make(map[string]*cachedDB)
	lastFailure := make(map[string]string)

	for {
		select {
		case task, ok := <-l.queue:
			if !ok {
				closeAll(cache)
				return
			}

			reportFailure(lastFailure, task.directory, l.handleTask(cache, task))
		case <-ticker.C:
			closeIdle(cache)
		}
	}
}

func reportFailure(lastFailure map[string]string, directory string, err error) {
	if err == nil {
		delete(lastFailure, directory)
		return
	}
	if lastFailure[directory] == err.Error() {
		return
	}
	lastFailure[directory] = err.Error()
	slog.Warn("request log write failed", "directory", directory, "error", err.Error())
}

func (l *Logger) handleTask(cache map[string]*cachedDB, task task) error {
	if existing, ok := cache[task.directory]; ok && !existing.stillAtPath() {
		closeCached(cache, task.directory)
	}

	cached, err := getOrOpen(l.rootPath, cache, task.directory)
	if err != nil {
		return err
	}

	cached.lastUsed = time.Now()

	if err := insert(cached.db, task.entry); err != nil {
		closeCached(cache, task.directory)
		return err
	}
	return nil
}

func (c *cachedDB) stillAtPath() bool {
	current, err := os.Stat(c.path)
	return err == nil && os.SameFile(c.file, current)
}

func closeCached(cache map[string]*cachedDB, directory string) {
	if cached, ok := cache[directory]; ok {
		_ = cached.db.Close()
		delete(cache, directory)
	}
}

func insert(db *sql.DB, entry Entry) error {
	_, err := db.Exec(
		`INSERT INTO app_requests (method, url, domain, source_ip, status, size, duration_ms, request_headers, response_headers, request_body, response_body)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.Method,
		entry.URL,
		nullIfEmpty(entry.Domain),
		nullIfEmpty(entry.SourceIP),
		entry.Status,
		entry.Size,
		entry.DurationMillis,
		nullIfEmpty(entry.RequestHeaders),
		nullIfEmpty(entry.ResponseHeaders),
		nullIfEmpty(entry.RequestBody),
		nullIfEmpty(entry.ResponseBody),
	)
	return err
}

func getOrOpen(rootPath string, cache map[string]*cachedDB, directory string) (*cachedDB, error) {
	if existing, ok := cache[directory]; ok {
		return existing, nil
	}

	dbPath := filepath.Join(rootPath, directory, "data", "database.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	for _, statement := range []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA journal_mode = TRUNCATE",
		"PRAGMA synchronous = NORMAL",
		`CREATE TABLE IF NOT EXISTS app_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			method TEXT NOT NULL,
			url TEXT NOT NULL,
			domain TEXT,
			source_ip TEXT,
			status INTEGER,
			size INTEGER,
			duration_ms INTEGER,
			request_headers TEXT,
			response_headers TEXT,
			request_body TEXT,
			response_body TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		"CREATE INDEX IF NOT EXISTS idx_app_requests_created_at ON app_requests(created_at)",
		"CREATE INDEX IF NOT EXISTS idx_app_requests_status ON app_requests(status)",
		"CREATE INDEX IF NOT EXISTS idx_app_requests_source_ip ON app_requests(source_ip)",
	} {
		if _, err := db.Exec(statement); err != nil {
			_ = db.Close()
			return nil, err
		}
	}

	var sourceIPCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM pragma_table_info('app_requests') WHERE name = 'source_ip'",
	).Scan(&sourceIPCount); err != nil {
		_ = db.Close()
		return nil, err
	}
	if sourceIPCount == 0 {
		if _, err := db.Exec("ALTER TABLE app_requests ADD COLUMN source_ip TEXT"); err != nil {
			_ = db.Close()
			return nil, err
		}
	}

	file, err := os.Stat(dbPath)
	if err != nil {
		_ = db.Close()
		return nil, err
	}

	cached := &cachedDB{
		db:       db,
		path:     dbPath,
		file:     file,
		lastUsed: time.Now(),
	}
	cache[directory] = cached
	return cached, nil
}

func closeIdle(cache map[string]*cachedDB) {
	cutoff := time.Now().Add(-idleTTL)

	for key, cached := range cache {
		if cached.lastUsed.Before(cutoff) {
			_ = cached.db.Close()
			delete(cache, key)
		}
	}
}

func closeAll(cache map[string]*cachedDB) {
	for key, cached := range cache {
		_ = cached.db.Close()
		delete(cache, key)
	}
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}

	return value
}

func IsClosed(err error) bool {
	return errors.Is(err, sql.ErrConnDone)
}
