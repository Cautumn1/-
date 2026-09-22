// Session timestamps come from the server. Advance that clock locally with a
// monotonic timer, so the device's wall clock cannot freeze or rewind a session.
export function createFocusClock(tick = () => performance.now()) {
  let anchor = Date.now();
  let sampledAt = tick();
  return {
    now: () => anchor + Math.max(0, tick() - sampledAt),
    sync(serverNow: number | undefined) {
      if (!Number.isFinite(serverNow) || Number(serverNow) <= 0) return;
      anchor = Number(serverNow);
      sampledAt = tick();
    },
  };
}

export function elapsedSeconds(session: {
  startedAt: number;
  pausedAt?: number | null;
  pausedDurationMs?: number;
} | null | undefined, now: number) {
  if (!session) return 0;
  const endedAt = session.pausedAt ?? now;
  return Math.max(0, Math.floor((endedAt - session.startedAt - Math.max(0, session.pausedDurationMs ?? 0)) / 1000));
}

// Reads begun before/during a mutation must not replace its newer result.
export function createFocusReadGuard() {
  let generation = 0;
  let pending = false;
  return {
    capture: () => generation,
    accepts: (value: number) => !pending && value === generation,
    begin() { pending = true; generation += 1; },
    end() { pending = false; generation += 1; },
  };
}
