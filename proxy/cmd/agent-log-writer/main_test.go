package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var fixedNow = time.Date(2026, 10, 13, 2, 14, 5, 123_000_000, time.UTC)

func clock() time.Time { return fixedNow }

func readLines(t *testing.T, path string) []string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(content), "\n"), "\n")
}

func TestLinesAreAppendedWithUtcTimestamp(t *testing.T) {
	dir := t.TempDir()
	log := newLogFile(dir, "app-backend", defaultRetention, clock)
	log.add("listening on 3000")
	log.add("ready\r")
	log.close()

	lines := readLines(t, filepath.Join(dir, "app-backend.log"))
	want := []string{
		"2026-10-13T02:14:05.123Z listening on 3000",
		"2026-10-13T02:14:05.123Z ready",
	}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Fatalf("unexpected lines: %#v", lines)
	}
}

func TestEventLineCarriesOnlyNumericFieldsThatWereSet(t *testing.T) {
	line := eventLine("crashed", []eventField{
		{"exit_code", stringFlag{value: "1", set: true}},
		{"uptime_seconds", stringFlag{value: "", set: true}},
		{"restart_count", stringFlag{value: "4", set: true}},
	})
	if line != "[event] crashed exit_code=1 restart_count=4" {
		t.Fatalf("unexpected event line: %q", line)
	}
}

func TestProcessNameIsSanitisedIntoAFileName(t *testing.T) {
	for name, want := range map[string]string{
		"app-frontend": "app-frontend.log",
		"../../etc/x":  ".._.._etc_x.log",
		"":             "unknown.log",
		"my worker #2": "my_worker__2.log",
		"..":           "unknown.log",
	} {
		if got := fileName(name); got != want {
			t.Errorf("fileName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestFileRotatesBySizeAndKeepsMaxBackups(t *testing.T) {
	dir := t.TempDir()
	log := newLogFile(dir, "webapp", retention{maxFileBytes: 100, maxBackups: 2, maxAge: time.Hour}, clock)
	for round := 0; round < 6; round++ {
		log.add(strings.Repeat(string(rune('a'+round)), 60))
		log.flush()
	}
	log.close()

	for _, name := range []string{"webapp.log", "webapp.log.1", "webapp.log.2"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("expected %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "webapp.log.3")); !os.IsNotExist(err) {
		t.Fatal("kept more backups than maxBackups")
	}
	if lines := readLines(t, filepath.Join(dir, "webapp.log")); !strings.HasSuffix(lines[0], strings.Repeat("f", 60)) {
		t.Fatalf("active file should hold the newest line, got %q", lines[0])
	}
	if lines := readLines(t, filepath.Join(dir, "webapp.log.2")); !strings.HasSuffix(lines[0], strings.Repeat("d", 60)) {
		t.Fatalf("oldest kept backup should hold the fourth line, got %q", lines[0])
	}
}

func TestPruneRemovesFilesOlderThanMaxAgeButNeverItsOwnFile(t *testing.T) {
	dir := t.TempDir()
	old := fixedNow.Add(-4 * 24 * time.Hour)
	for _, name := range []string{"webapp.log", "webapp.log.1", "gone.log", "gone.log.2", "fresh.log.1", "notes.txt"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if name != "fresh.log.1" {
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}

	newLogFile(dir, "webapp", defaultRetention, clock).prune()

	for name, kept := range map[string]bool{
		"webapp.log":   true,
		"webapp.log.1": false,
		"gone.log":     false,
		"gone.log.2":   false,
		"fresh.log.1":  true,
		"notes.txt":    true,
	} {
		_, err := os.Stat(filepath.Join(dir, name))
		if kept && err != nil {
			t.Errorf("%s should be kept: %v", name, err)
		}
		if !kept && !os.IsNotExist(err) {
			t.Errorf("%s should be pruned", name)
		}
	}
}

func TestWriterReopensWhenItsFileIsRemoved(t *testing.T) {
	dir := t.TempDir()
	log := newLogFile(dir, "vscode", defaultRetention, clock)
	log.add("before")
	log.flush()

	if err := os.Remove(filepath.Join(dir, "vscode.log")); err != nil {
		t.Fatal(err)
	}
	log.add("after")
	log.close()

	lines := readLines(t, filepath.Join(dir, "vscode.log"))
	if len(lines) != 1 || !strings.HasSuffix(lines[0], " after") {
		t.Fatalf("expected the line written after removal in a new file, got %#v", lines)
	}
}

func TestWriterAppendsToAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	first := newLogFile(dir, "opencode", defaultRetention, clock)
	first.add("one")
	first.close()
	second := newLogFile(dir, "opencode", defaultRetention, clock)
	second.add("two")
	second.close()

	if lines := readLines(t, filepath.Join(dir, "opencode.log")); len(lines) != 2 {
		t.Fatalf("expected both lines, got %#v", lines)
	}
}

func TestReadStreamPreservesOutputAndLines(t *testing.T) {
	output, lines := collectStream("alpha\nbeta\nfinal")
	if output != "alpha\nbeta\nfinal" {
		t.Fatalf("unexpected output: %q", output)
	}
	if strings.Join(lines, "|") != "alpha|beta|final" {
		t.Fatalf("unexpected lines: %#v", lines)
	}
}

func TestReadStreamTruncatesStoredLine(t *testing.T) {
	input := strings.Repeat("x", maxLineLength+100) + "\n"
	output, lines := collectStream(input)
	if output != input {
		t.Fatal("output was not preserved")
	}
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if len(lines[0]) != maxLineLength {
		t.Fatalf("expected truncated line length %d, got %d", maxLineLength, len(lines[0]))
	}
}

func collectStream(input string) (string, []string) {
	events := make(chan streamEvent)
	go readStream(strings.NewReader(input), events)

	var output strings.Builder
	var lines []string
	for event := range events {
		output.WriteString(event.output)
		if event.hasLine {
			lines = append(lines, event.line)
		}
	}
	return output.String(), lines
}
