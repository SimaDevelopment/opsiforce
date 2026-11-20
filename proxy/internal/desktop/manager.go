// Package desktop owns one lightweight X11 desktop inside a single agent pod.
// X11 is local-only; VNC processes exist only for the lifetime of a viewer.
package desktop

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const MaxViewers = 10

// Maximizes every normal window without a title bar, so an app fills the screen.
const openboxConfig = "/etc/opsiforce/openbox-rc.xml"

type Window struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	PID   int    `json:"pid"`
	App   string `json:"app"`
}

type Session struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	Display         string   `json:"display"`
	Windows         []Window `json:"windows"`
	Visible         bool     `json:"visible"`
	PreferredWindow string   `json:"preferredWindow"`
	Presentation    int      `json:"presentation"`
}

type process struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func startProcess(env []string, name string, args ...string) (*process, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = env
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &process{cmd: cmd, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(p.done) }()
	return p, nil
}

func (p *process) stop() {
	if p == nil {
		return
	}
	select {
	case <-p.done:
		return
	default:
	}
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		<-p.done
	}
}

type display struct {
	Session
	x      *process
	wm     *process
	ctx    context.Context
	cancel context.CancelFunc
}

type Manager struct {
	mu      sync.Mutex
	desktop *display
	viewers chan struct{}
}

func New() *Manager {
	return &Manager{viewers: make(chan struct{}, MaxViewers)}
}

func displayEnv(display string) []string {
	env := make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "DISPLAY=") {
			env = append(env, item)
		}
	}
	return append(env, "DISPLAY="+display)
}

func (m *Manager) Start(ctx context.Context) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.desktop != nil {
		return Session{}, errors.New("the desktop is already running")
	}
	d := &display{Session: Session{ID: "default", Title: "Desktop", Display: ":99"}}
	clearStaleDisplay(d.Display)
	d.ctx, d.cancel = context.WithCancel(context.Background())
	x, err := startProcess(displayEnv(d.Display), "Xvfb", d.Display, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-noreset")
	if err != nil {
		d.cancel()
		return Session{}, err
	}
	d.x = x
	ready := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		checkCtx, cancel := context.WithTimeout(ctx, time.Second)
		check := exec.CommandContext(checkCtx, "xdpyinfo", "-display", d.Display)
		err = check.Run()
		cancel()
		if err == nil {
			ready = true
			break
		}
		select {
		case <-ctx.Done():
			deadline = time.Time{}
		case <-x.done:
			deadline = time.Time{}
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !ready {
		d.cancel()
		x.stop()
		return Session{}, errors.New("X11 display failed to start")
	}
	wmArgs := []string{"--sm-disable"}
	if _, err := os.Stat(openboxConfig); err == nil {
		wmArgs = append(wmArgs, "--config-file", openboxConfig)
	}
	d.wm, err = startProcess(displayEnv(d.Display), "openbox", wmArgs...)
	if err != nil {
		d.cancel()
		x.stop()
		return Session{}, err
	}
	// Openbox defaults to several virtual workspaces. Keep all app windows on
	// the same desktop, including when a viewer scrolls over the background.
	ready = false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		checkCtx, cancel := context.WithTimeout(ctx, time.Second)
		cmd := exec.CommandContext(checkCtx, "wmctrl", "-n", "1")
		cmd.Env = displayEnv(d.Display)
		err = cmd.Run()
		if err == nil {
			query := exec.CommandContext(checkCtx, "wmctrl", "-d")
			query.Env = displayEnv(d.Display)
			out, queryErr := query.Output()
			workspaces := strings.TrimSpace(string(out))
			ready = queryErr == nil && workspaces != "" && !strings.Contains(workspaces, "\n")
		}
		cancel()
		if ready {
			break
		}
		select {
		case <-ctx.Done():
			deadline = time.Time{}
		case <-d.wm.done:
			deadline = time.Time{}
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !ready {
		d.cancel()
		d.wm.stop()
		d.x.stop()
		return Session{}, errors.New("window manager failed to initialize")
	}

	m.desktop = d
	return d.Session, nil
}

// An Xvfb left behind by a killed manager still owns the display, so the new
// one would exit at once while the old one answered every readiness check.
func clearStaleDisplay(display string) {
	number := strings.TrimPrefix(display, ":")
	lock := "/tmp/.X" + number + "-lock"
	if raw, err := os.ReadFile(lock); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	_ = os.Remove(lock)
	_ = os.Remove("/tmp/.X11-unix/X" + number)
}

// A line is "<id> <desktop> <pid> <instance.Class> <host> <title>", where the
// instance may contain spaces, so the host is the reliable split point.
func parseWindow(line, host string) (Window, bool) {
	fields := strings.Fields(line)
	if len(fields) < 5 {
		return Window{}, false
	}
	pid, _ := strconv.Atoi(fields[2])
	class, title := fields[3], strings.Join(fields[5:], " ")
	if at := strings.Index(line, " "+host+" "); host != "" && at >= 0 {
		head := strings.Fields(line[:at])
		class = strings.Join(head[3:], " ")
		title = strings.TrimSpace(line[at+len(host)+2:])
	}
	if dot := strings.LastIndex(class, "."); dot >= 0 {
		class = class[dot+1:]
	}
	return Window{ID: fields[0], PID: pid, App: class, Title: title}, true
}

func windows(ctx context.Context, name string) ([]Window, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wmctrl", "-lpx")
	cmd.Env = displayEnv(name)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	result := []Window{}
	for _, line := range strings.Split(string(out), "\n") {
		if window, ok := parseWindow(line, host); ok {
			result = append(result, window)
		}
	}
	return result, nil
}

func (m *Manager) List(ctx context.Context) []Session {
	m.mu.Lock()
	d := m.desktop
	var s Session
	if d != nil {
		s = d.Session
	}
	m.mu.Unlock()
	result := make([]Session, 0, 1)
	if d != nil {
		s.Windows, _ = windows(ctx, s.Display)
		if s.Windows == nil {
			s.Windows = []Window{}
		}
		s.Visible = len(s.Windows) > 0
		result = append(result, s)
	}
	return result
}

// A failed X server or window manager must not leave a permanently broken
// display in the registry. The supervisor can restart the manager cleanly.
func (m *Manager) Healthy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d := m.desktop; d != nil {
		for _, p := range []*process{d.x, d.wm} {
			select {
			case <-p.done:
				return false
			default:
			}
		}
	}
	return true
}

func (m *Manager) Present(ctx context.Context, id, window string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.desktop
	if d == nil || d.ID != id {
		return os.ErrNotExist
	}
	if err := checkWindow(ctx, d.Display, window); err != nil {
		return err
	}
	bringToFront(ctx, d.Display, window)
	d.PreferredWindow = window
	d.Presentation++
	return nil
}

// Every window fills the screen, so the one on top is the one the person
// sees. With no window named, the newest one is what was just opened.
func bringToFront(ctx context.Context, display, window string) {
	if window == "" {
		list, err := windows(ctx, display)
		if err != nil || len(list) == 0 {
			return
		}
		window = list[len(list)-1].ID
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wmctrl", "-i", "-a", window)
	cmd.Env = displayEnv(display)
	_ = cmd.Run()
}

func checkWindow(ctx context.Context, display, window string) error {
	if window == "" {
		return nil
	}
	list, err := windows(ctx, display)
	if err != nil {
		return err
	}
	for _, item := range list {
		if item.ID == window {
			return nil
		}
	}
	return errors.New("window is not present on this display")
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d := m.desktop; d != nil {
		d.cancel()
		d.wm.stop()
		d.x.stop()
		m.desktop = nil
	}
}
