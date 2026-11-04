package proxycache

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
)

func lasting(ttl time.Duration) func(backend.EnsureResponse) time.Duration {
	return func(backend.EnsureResponse) time.Duration { return ttl }
}

func answering(loads *int, err error) func(context.Context) (backend.EnsureResponse, error) {
	return func(context.Context) (backend.EnsureResponse, error) {
		*loads++
		return backend.EnsureResponse{State: "ready"}, err
	}
}

func TestAnExpiredEntryIsDroppedWhenItCannotBeReloaded(t *testing.T) {
	cache := newWithCapacity(10)
	loads := 0
	_, _ = cache.GetOrLoad(context.Background(), "host", lasting(0), answering(&loads, nil))

	_, err := cache.GetOrLoad(context.Background(), "host", lasting(time.Hour), answering(&loads, errors.New("down")))

	if err == nil || loads != 2 {
		t.Fatalf("got err %v after %d loads, want the failed reload", err, loads)
	}
	if size := len(cache.entries); size != 0 {
		t.Errorf("entries: got %d want 0", size)
	}
}

func TestTheCacheNeverHoldsMoreEntriesThanItsCapacity(t *testing.T) {
	cache := newWithCapacity(3)
	loads := 0

	for i := range 10 {
		_, _ = cache.GetOrLoad(context.Background(), fmt.Sprintf("host-%d", i), lasting(time.Hour), answering(&loads, nil))
	}

	if size := len(cache.entries); size != 3 {
		t.Errorf("entries: got %d want 3", size)
	}
}

func TestExpiredEntriesMakeRoomBeforeAnyLiveOneIsEvicted(t *testing.T) {
	cache := newWithCapacity(2)
	loads := 0
	_, _ = cache.GetOrLoad(context.Background(), "live", lasting(time.Hour), answering(&loads, nil))
	_, _ = cache.GetOrLoad(context.Background(), "expired", lasting(0), answering(&loads, nil))

	_, _ = cache.GetOrLoad(context.Background(), "new", lasting(time.Hour), answering(&loads, nil))
	_, _ = cache.GetOrLoad(context.Background(), "live", lasting(time.Hour), answering(&loads, nil))

	if loads != 3 {
		t.Errorf("loads: got %d want 3, the live entry was evicted", loads)
	}
}
