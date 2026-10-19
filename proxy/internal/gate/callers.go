package gate

import (
	"context"
	"sync"
	"time"

	"opsiforce/proxy/internal/backend"
)

type callerAddress struct {
	key  string
	slug string
}

type cachedCaller struct {
	resolution backend.CallerResolution
	slug       string
	expiresAt  time.Time
}

type pendingResolve struct {
	done       chan struct{}
	resolution backend.CallerResolution
	err        error
}

type resolveFunc func(ctx context.Context, credential string, slug string) (backend.CallerResolution, error)

type callerCache struct {
	mu         sync.Mutex
	life       time.Duration
	hold       time.Duration
	resolve    resolveFunc
	entries    map[callerAddress]cachedCaller
	pending    map[callerAddress]*pendingResolve
	generation uint64
}

func newCallerCache(life time.Duration, hold time.Duration, resolve resolveFunc) *callerCache {
	return &callerCache{
		life:    life,
		hold:    hold,
		resolve: resolve,
		entries: make(map[callerAddress]cachedCaller),
		pending: make(map[callerAddress]*pendingResolve),
	}
}

func (c *callerCache) caller(ctx context.Context, presented presentedKey, slug string) (backend.CallerResolution, error) {
	address := callerAddress{key: presented.key, slug: slug}

	c.mu.Lock()
	if cached, ok := c.entries[address]; ok && time.Now().Before(cached.expiresAt) {
		c.mu.Unlock()
		return cached.resolution, nil
	}
	waiting, inFlight := c.pending[address]
	if !inFlight {
		waiting = &pendingResolve{done: make(chan struct{})}
		c.pending[address] = waiting
		go c.load(address, presented.credential, waiting, c.generation)
	}
	c.mu.Unlock()

	select {
	case <-ctx.Done():
		return backend.CallerResolution{}, ctx.Err()
	case <-waiting.done:
		return waiting.resolution, waiting.err
	}
}

func (c *callerCache) load(address callerAddress, credential string, waiting *pendingResolve, generation uint64) {
	ctx, cancel := context.WithTimeout(context.Background(), c.hold)
	defer cancel()
	resolution, err := c.resolve(ctx, credential, address.slug)

	c.mu.Lock()
	if err == nil && generation == c.generation {
		c.entries[address] = cachedCaller{resolution: resolution, slug: address.slug, expiresAt: time.Now().Add(c.life)}
	}
	delete(c.pending, address)
	waiting.resolution, waiting.err = resolution, err
	close(waiting.done)
	c.mu.Unlock()
}

func (c *callerCache) forget(address callerAddress) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation++
	delete(c.entries, address)
}

func (c *callerCache) evictService(tenantID string, slug string) {
	c.evictWhere(func(address callerAddress, cached cachedCaller) bool {
		return cached.resolution.TenantID == tenantID && (cached.slug == slug || cached.resolution.Slug == slug)
	})
}

func (c *callerCache) evictKey(key string) {
	c.evictWhere(func(address callerAddress, _ cachedCaller) bool {
		return address.key == key
	})
}

func (c *callerCache) evictWhere(matches func(callerAddress, cachedCaller) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation++
	for address, cached := range c.entries {
		if matches(address, cached) {
			delete(c.entries, address)
		}
	}
}
