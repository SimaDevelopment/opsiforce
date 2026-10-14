package requestlog

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func urlsIn(t *testing.T, path string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT url FROM app_requests ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			t.Fatal(err)
		}
		urls = append(urls, url)
	}
	return urls
}

func TestLoggerStartsAFreshFileWhenTheOldOneIsMovedAside(t *testing.T) {
	root := t.TempDir()
	directory := "projects/env-1"
	dbPath := filepath.Join(root, directory, "data", "database.db")
	movedPath := dbPath + ".corrupt-test"

	logger := New(root, 1)
	logger.Log(directory, Entry{Method: "GET", URL: "/before", Status: 200})
	waitForURL(t, dbPath, "/before")

	if err := os.Rename(dbPath, movedPath); err != nil {
		t.Fatal(err)
	}

	logger.Log(directory, Entry{Method: "GET", URL: "/after", Status: 200})
	if err := logger.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	if got := urlsIn(t, dbPath); len(got) != 1 || got[0] != "/after" {
		t.Fatalf("expected the new file to hold only /after, got %v", got)
	}
	if got := urlsIn(t, movedPath); len(got) != 1 || got[0] != "/before" {
		t.Fatalf("expected the moved file to keep only /before, got %v", got)
	}
}

func waitForURL(t *testing.T, path, url string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		db, err := sql.Open("sqlite", path)
		if err == nil {
			var count int
			err = db.QueryRow("SELECT COUNT(*) FROM app_requests WHERE url = ?", url).Scan(&count)
			_ = db.Close()
			if err == nil && count > 0 {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s never reached %s", url, path)
}
