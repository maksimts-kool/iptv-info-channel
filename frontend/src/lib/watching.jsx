import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AuthError } from './api.js';

// Who is watching right now, for every screen at once: one poll of
// /admin/api/devices (the stream gateway's device list, the built-in loops
// included), shared through context. The menu badge, Обзор, Клиенты,
// Устройства and Статистика all read this, so they show the same devices at
// the same moment instead of each keeping its own, differently stale copy.
export const WATCHING_POLL_MS = 5_000;

const NO_DEVICES = [];

// The numbers every screen shows, from one /admin/api/devices response.
// "Watching" is a device that plays (not one turned away by the limit);
// "used" is a watching device that holds one of the limit's slots (a
// device only on the info or media channel holds none).
export function summarizeWatching(data) {
  const clients = data?.clients || [];
  const byUser = new Map(clients.map((c) => [c.user_id, c]));
  const devices = clients.flatMap((c) => c.devices);
  const watching = devices.filter((d) => d.allowed).length;
  const of = (userId) => {
    const list = byUser.get(userId)?.devices || NO_DEVICES;
    const playing = list.filter((d) => d.allowed);
    return {
      devices: list,
      watching: playing.length,
      used: playing.filter((d) => d.slot).length,
      over: list.length - playing.length,
    };
  };
  return {
    ready: !!data,
    gatewayEnabled: !!data?.gateway_enabled,
    idleSeconds: data?.idle_seconds ?? 60,
    clients,
    devices,
    watching,
    over: devices.length - watching,
    online: clients.filter((c) => c.devices.some((d) => d.allowed)).length,
    of,
  };
}

const WatchingContext = createContext(null);

export function WatchingProvider({
  api, enabled, onAuthError, children,
}) {
  const [data, setData] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const lastText = useRef('');
  const authError = useRef(onAuthError);
  authError.current = onAuthError;

  // Resolves with the fresh response (for a screen that shows a frozen copy).
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.get('/admin/api/devices');
      const text = JSON.stringify(next);
      // Unchanged: keep the same object so nothing recomputes.
      if (text !== lastText.current) {
        lastText.current = text;
        setData(next);
      }
      setUpdatedAt(new Date());
      return next;
    } catch (e) {
      if (e instanceof AuthError) authError.current?.();
      // Anything else: keep the last list through a brief network failure.
      return null;
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Polled while the tab is visible; a tab coming back refreshes at once.
  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const tick = () => { if (!document.hidden) refresh(); };
    const id = setInterval(tick, WATCHING_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, refresh]);

  const summary = useMemo(() => summarizeWatching(data), [data]);
  const value = useMemo(() => ({
    ...summary, updatedAt, loading, refresh,
  }), [summary, updatedAt, loading, refresh]);
  return <WatchingContext.Provider value={value}>{children}</WatchingContext.Provider>;
}

export function useWatching() {
  const value = useContext(WatchingContext);
  if (!value) throw new Error('useWatching outside WatchingProvider');
  return value;
}
