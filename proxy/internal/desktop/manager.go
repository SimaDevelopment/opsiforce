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

type Window struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	PID   int    `json:"pid"`
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
	x         *process
	wm        *process
	ctx       context.Context
	cancel    context.CancelFunc
	published bool
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
	d.wm, err = startProcess(displayEnv(d.Display), "openbox", "--sm-disable")
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

func windows(ctx context.Context, name string) ([]Window, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wmctrl", "-lp")
	cmd.Env = displayEnv(name)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	result := []Window{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, _ := strconv.Atoi(fields[2])
		result = append(result, Window{ID: fields[0], PID: pid, Title: strings.Join(fields[4:], " ")})
	}
	return result, nil
}

func (m *Manager) List(ctx context.Context) []Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]Session, 0, 1)
	if d := m.desktop; d != nil {
		s := d.Session
		s.Windows, _ = windows(ctx, d.Display)
		if s.Windows == nil {
			s.Windows = []Window{}
		}
		s.Visible = d.published || len(s.Windows) > 0
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
	d.PreferredWindow = window
	d.Presentation++
	d.published = true
	return nil
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
