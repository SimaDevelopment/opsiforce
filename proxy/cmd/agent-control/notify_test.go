package main

import (
	"os"
	"path/filepath"
	"testing"
)

func withOpencodeDir(t *testing.T, subdirectories ...string) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".opencode")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, name := range subdirectories {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	previous := opencodeDir
	opencodeDir = root
	t.Cleanup(func() { opencodeDir = previous })
	return root
}

func entries(t *testing.T, directory string) []string {
	t.Helper()
	found, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("readdir %s: %v", directory, err)
	}
	names := []string{}
	for _, entry := range found {
		names = append(names, entry.Name())
	}
	return names
}

func TestNotifyConfigChangeTouchesEachTargetSeparately(t *testing.T) {
	for _, testCase := range []struct {
		target    string
		directory string
	}{
		{target: "config", directory: ""},
		{target: "agents", directory: "agents"},
		{target: "skills", directory: "skills"},
	} {
		t.Run(testCase.target, func(t *testing.T) {
			root := withOpencodeDir(t, "agents", "skills")
			watched := filepath.Join(root, testCase.directory)

			result := notifyConfigChange([]string{testCase.target})

			if len(result.Failed) > 0 {
				t.Fatalf("expected no failures, got %v", result.Failed)
			}
			if len(result.Notified) != 1 || result.Notified[0] != testCase.target {
				t.Fatalf("expected %s notified, got %v", testCase.target, result.Notified)
			}
			for _, name := range entries(t, watched) {
				if name != "agents" && name != "skills" {
					t.Fatalf("marker %s was left behind in %s", name, watched)
				}
			}
		})
	}
}

func TestNotifyConfigChangeReportsAbsentDirectory(t *testing.T) {
	withOpencodeDir(t)

	result := notifyConfigChange([]string{"skills"})

	if len(result.Notified) != 0 {
		t.Fatalf("expected nothing notified, got %v", result.Notified)
	}
	if len(result.Absent) != 1 || result.Absent[0] != "skills" {
		t.Fatalf("expected skills absent, got %v", result.Absent)
	}
}

func TestNotifyConfigChangeRejectsUnknownTarget(t *testing.T) {
	withOpencodeDir(t)

	result := notifyConfigChange([]string{"everything"})

	if result.Failed["everything"] == "" {
		t.Fatalf("expected a failure for the unknown target, got %v", result.Failed)
	}
}

func TestMarkerNameIsHiddenAndNotMarkdown(t *testing.T) {
	name, err := markerName()
	if err != nil {
		t.Fatalf("markerName: %v", err)
	}
	if name[0] != '.' {
		t.Fatalf("marker %s is not hidden", name)
	}
	if filepath.Ext(name) == ".md" {
		t.Fatalf("marker %s would be scanned as markdown", name)
	}
}
