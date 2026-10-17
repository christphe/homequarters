package auth

import (
	"errors"
	"sync"
	"time"
)

// ErrFull means a pending store is at capacity even after dropping what expired:
// sign-ins are refused for a moment rather than letting memory grow.
var ErrFull = errors.New("too many sign-ins in progress")

// Pending holds short-lived values by random key: sign-in flows between the
// redirect to the provider and its callback, new identities between the
// callback and the name form. It is bounded, and every value expires.
type Pending[T any] struct {
	mu  sync.Mutex
	ttl time.Duration
	max int
	m   map[string]entry[T]
	now func() time.Time
}

type entry[T any] struct {
	v   T
	exp time.Time
}

func NewPending[T any](ttl time.Duration, max int) *Pending[T] {
	return &Pending[T]{ttl: ttl, max: max, m: map[string]entry[T]{}, now: time.Now}
}

// Put stores v and returns its new random key.
func (p *Pending[T]) Put(v T) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if len(p.m) >= p.max {
		for k, e := range p.m {
			if now.After(e.exp) {
				delete(p.m, k)
			}
		}
		if len(p.m) >= p.max {
			return "", ErrFull
		}
	}
	k := Random(24)
	p.m[k] = entry[T]{v, now.Add(p.ttl)}
	return k, nil
}

// Get returns the value without spending it.
func (p *Pending[T]) Get(k string) (T, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.m[k]
	if !ok || p.now().After(e.exp) {
		var zero T
		return zero, false
	}
	return e.v, true
}

// Take returns the value and forgets it: each key works once.
func (p *Pending[T]) Take(k string) (T, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.m[k]
	delete(p.m, k)
	if !ok || p.now().After(e.exp) {
		var zero T
		return zero, false
	}
	return e.v, true
}

// Len is the number of values held, expired ones included until swept.
func (p *Pending[T]) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.m)
}
