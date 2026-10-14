package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultLogDir   = "/workspace/data/logs"
	flushInterval   = 500 * time.Millisecond
	pruneInterval   = time.Hour
	maxLineLength   = 10 * 1024
	maxBatchLines   = 100
	timestampLayout = "2006-01-02T15:04:05.000Z"
	eventMarker     = "[event]"
)

type retention struct {
	maxFileBytes int64
	maxBackups   int
	maxAge       time.Duration
}

var defaultRetention = retention{
	maxFileBytes: 10 * 1024 * 1024,
	maxBackups:   3,
	maxAge:       72 * time.Hour,
}

type stringFlag struct {
	value string
	set   bool
}

func (f *stringFlag) Set(value string) error {
	f.value = value
	f.set = true
	return nil
}

func (f *stringFlag) String() string {
	return f.value
}

type logFile struct {
	dir             string
	path            string
	retention       retention
	now             func() time.Time
	file            *os.File
	size            int64
	batch           []string
	lastReportedErr error
}

type eventField struct {
	key   string
	value stringFlag
}

type streamEvent struct {
	output  string
	line    string
	hasLine bool
}

func main() {
	var nameFlag stringFlag
	var lineFlag stringFlag
	var eventFlag stringFlag
	var exitCodeFlag stringFlag
	var uptimeFlag stringFlag
	var restartFlag stringFlag

	flag.Var(&nameFlag, "name", "")
	flag.Var(&lineFlag, "line", "")
	flag.Var(&eventFlag, "event", "")
	flag.Var(&exitCodeFlag, "exit-code", "")
	flag.Var(&uptimeFlag, "uptime", "")
	flag.Var(&restartFlag, "restart", "")
	flag.Parse()

	log := newLogFile(logDir(), nameFlag.value, defaultRetention, time.Now)
	defer log.close()

	switch {
	case eventFlag.set:
		log.add(eventLine(eventFlag.value, []eventField{
			{"exit_code", exitCodeFlag},
			{"uptime_seconds", uptimeFlag},
			{"restart_count", restartFlag},
		}))
		log.flush()
	case lineFlag.set:
		log.add(lineFlag.value)
		log.flush()
	default:
		log.prune()
		stream(log)
	}
}

func logDir() string {
	if dir := os.Getenv("PROCESS_LOG_DIR"); dir != "" {
		return dir
	}
	return defaultLogDir
}

var unsafeNameCharacters = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func fileName(processName string) string {
	name := unsafeNameCharacters.ReplaceAllString(processName, "_")
	if strings.Trim(name, ".") == "" {
		name = "unknown"
	}
	return name + ".log"
}

func newLogFile(dir, processName string, retention retention, now func() time.Time) *logFile {
	return &logFile{
		dir:       dir,
		path:      filepath.Join(dir, fileName(processName)),
		retention: retention,
		now:       now,
		batch:     make([]string, 0, maxBatchLines),
	}
}

func eventLine(event string, fields []eventField) string {
	parts := []string{eventMarker, event}
	for _, field := range fields {
		if !field.value.set || field.value.value == "" {
			continue
		}
		if _, err := strconv.Atoi(field.value.value); err != nil {
			continue
		}
		parts = append(parts, field.key+"="+field.value.value)
	}
	return strings.Join(parts, " ")
}

func (l *logFile) add(line string) {
	l.batch = append(l.batch, l.now().UTC().Format(timestampLayout)+" "+truncateLine(line)+"\n")
	if len(l.batch) >= maxBatchLines {
		l.flush()
	}
}

func (l *logFile) flush() {
	if len(l.batch) == 0 {
		return
	}
	defer func() { l.batch = l.batch[:0] }()

	if !l.ensureOpen() {
		return
	}

	chunk := strings.Join(l.batch, "")
	if l.size > 0 && l.size+int64(len(chunk)) > l.retention.maxFileBytes {
		l.rotate()
		if !l.ensureOpen() {
			return
		}
	}

	written, err := io.WriteString(l.file, chunk)
	l.size += int64(written)
	if err != nil {
		l.reportError(err)
		l.closeFile()
	}
}

func (l *logFile) ensureOpen() bool {
	if l.file != nil && l.stillAtPath() {
		return true
	}
	l.closeFile()

	if err := os.MkdirAll(l.dir, 0o755); err != nil {
		l.reportError(err)
		return false
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		l.reportError(err)
		return false
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		l.reportError(err)
		return false
	}

	l.file = file
	l.size = info.Size()
	l.lastReportedErr = nil
	return true
}

func (l *logFile) stillAtPath() bool {
	opened, err := l.file.Stat()
	if err != nil {
		return false
	}
	current, err := os.Stat(l.path)
	if err != nil {
		return false
	}
	return os.SameFile(opened, current)
}

func (l *logFile) rotate() {
	l.closeFile()
	for index := l.retention.maxBackups; index >= 1; index-- {
		source := l.backupPath(index - 1)
		if index == l.retention.maxBackups {
			_ = os.Remove(l.backupPath(index))
		}
		_ = os.Rename(source, l.backupPath(index))
	}
	if l.retention.maxBackups == 0 {
		_ = os.Remove(l.path)
	}
	l.prune()
}

func (l *logFile) backupPath(index int) string {
	if index == 0 {
		return l.path
	}
	return l.path + "." + strconv.Itoa(index)
}

func (l *logFile) prune() {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return
	}
	cutoff := l.now().Add(-l.retention.maxAge)
	own := filepath.Base(l.path)

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || name == own || !strings.Contains(name, ".log") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(l.dir, name))
	}
}

func (l *logFile) reportError(err error) {
	if l.lastReportedErr != nil && l.lastReportedErr.Error() == err.Error() {
		return
	}
	l.lastReportedErr = err
	fmt.Fprintf(os.Stderr, "log-writer: %s: %v\n", l.path, err)
}

func (l *logFile) closeFile() {
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

func (l *logFile) close() {
	l.flush()
	l.closeFile()
}

func stream(log *logFile) {
	events := make(chan streamEvent)
	go readStream(os.Stdin, events)

	flushTicker := time.NewTicker(flushInterval)
	defer flushTicker.Stop()
	pruneTicker := time.NewTicker(pruneInterval)
	defer pruneTicker.Stop()

	for {
		select {
		case event, ok := <-events:
			if !ok {
				log.flush()
				return
			}
			if event.output != "" {
				_, _ = io.WriteString(os.Stdout, event.output)
			}
			if event.hasLine {
				log.add(event.line)
			}
		case <-flushTicker.C:
			log.flush()
		case <-pruneTicker.C:
			log.prune()
		}
	}
}

func readStream(input io.Reader, events chan<- streamEvent) {
	defer close(events)
	buffer := make([]byte, 32*1024)
	var line strings.Builder
	truncated := false

	for {
		read, err := input.Read(buffer)
		if read > 0 {
			text := string(buffer[:read])
			events <- streamEvent{output: text}
			start := 0
			for index := strings.IndexByte(text[start:], '\n'); index >= 0; index = strings.IndexByte(text[start:], '\n') {
				end := start + index
				truncated = appendLineSegment(&line, truncated, text[start:end])
				events <- streamEvent{line: line.String(), hasLine: true}
				line.Reset()
				truncated = false
				start = end + 1
			}
			if start < len(text) {
				truncated = appendLineSegment(&line, truncated, text[start:])
			}
		}
		if err == io.EOF {
			if line.Len() > 0 || truncated {
				events <- streamEvent{line: line.String(), hasLine: true}
			}
			return
		}
		if err != nil {
			return
		}
	}
}

func appendLineSegment(line *strings.Builder, truncated bool, segment string) bool {
	if truncated {
		return true
	}

	remaining := maxLineLength - line.Len()
	if remaining <= 0 {
		return true
	}
	if len(segment) <= remaining {
		line.WriteString(segment)
		return false
	}

	line.WriteString(segment[:remaining])
	return true
}

func truncateLine(line string) string {
	line = strings.TrimSuffix(line, "\r")
	if len(line) <= maxLineLength {
		return line
	}
	return line[:maxLineLength]
}
