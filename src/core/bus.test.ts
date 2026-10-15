import { describe, expect, it, vi } from 'vitest';

import { EventBus } from './bus.js';

describe('EventBus', () => {
  it('delivers payloads to every listener of an event', () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.on('session.removed', first);
    bus.on('session.removed', second);
    bus.emit('session.removed', { sessionId: 's1' });
    expect(first).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(second).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('does nothing when an event has no listeners', () => {
    const bus = new EventBus();
    expect(() => {
      bus.emit('permission.resolved', { requestId: 'r1' });
    }).not.toThrow();
    expect(bus.listenerCount('permission.resolved')).toBe(0);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const off = bus.on('source.error', listener);
    expect(bus.listenerCount('source.error')).toBe(1);
    off();
    bus.emit('source.error', { source: 'x', message: 'y' });
    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount('source.error')).toBe(0);
  });
});
