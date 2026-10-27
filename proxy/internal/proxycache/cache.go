package proxycache

import (
	"context"
	"sync"
	"time"

	"opsiforce/proxy/internal/backend"
)

const defaultCapacity = 10000

type Cache struct {
	mu       sync.Mutex
	capacity int
	entries  map[string]entry
	inflight map[string]*call
}

type entry struct {
	value     backend.EnsureResponse
	expiresAt time.Time
}

type call struct {
	done  chan struct{}
	value backend.EnsureResponse
	err   error
}

func New() *Cache {
	return newWithCapacity(defaultCapacity)
}

func newWithCapacity(capacity int) *Cache {
	return &Cache{
		capacity: capacity,
		entries:  make(map[string]entry),
		inflight: make(map[string]*call),
	}
}

func (c *Cache) GetOrLoad(
	ctx context.Context,
	key string,
	ttl func(backend.EnsureResponse) time.Duration,
	load func(context.Context) (backend.EnsureResponse, error),
) (backend.EnsureResponse, error) {
	c.mu.Lock()
	if cached, ok := c.entries[key]; ok {
		if time.Now().Before(cached.expiresAt) {
			c.mu.Unlock()
			return cached.value, nil
		}
		delete(c.entries, key)
	}

	if pending, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return backend.EnsureResponse{}, ctx.Err()
		case <-pending.done:
			return pending.value, pending.err
		}
	}

	pending := &call{done: make(chan struct{})}
	c.inflight[key] = pending
	c.mu.Unlock()

	value, err := load(ctx)

	c.mu.Lock()
	if err == nil {
		c.store(key, entry{
			value:     value,
			expiresAt: time.Now().Add(ttl(value)),
		})
	}
	delete(c.inflight, key)
	pending.value = value
	pending.err = err
	close(pending.done)
	c.mu.Unlock()

	return value, err
}

func (c *Cache) store(key string, value entry) {
	if _, replacing := c.entries[key]; !replacing && len(c.entries) >= c.capacity {
		c.makeRoom(time.Now())
	}
	c.entries[key] = value
}

func (c *Cache) makeRoom(now time.Time) {
	for key, cached := range c.entries {
		if !now.Before(cached.expiresAt) {
			delete(c.entries, key)
		}
	}
	for key := range c.entries {
		if len(c.entries) < c.capacity {
			return
		}
		delete(c.entries, key)
	}
}

func (c *Cache) InvalidateEnvironment(environmentID string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for key, cached := range c.entries {
		if cached.value.EnvironmentID == environmentID {
			delete(c.entries, key)
		}
	}
}
