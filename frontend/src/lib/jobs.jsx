import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AuthError } from './api.js';

// The background work queue — info-channel encodes and media-channel builds —
// for every screen at once. The server pushes a snapshot over a live event
// feed (/admin/api/jobs/events) whenever something changes; where that feed
// can't connect (a proxy that buffers it, an old browser) this falls back to
// polling /admin/api/jobs and keeps trying the feed in the background.
const POLL_MS = 2_000;
const RECONNECT_MS = 15_000;

// Server reasons are log strings; the panel shows them in Russian.
const REASONS = {
  'admin user created': 'новый клиент',
  'admin user updated': 'клиент изменён',
  'admin payment recorded': 'оплата',
  'admin payment undone': 'оплата отменена',
  'admin access token regenerated': 'новая ссылка',
  'admin manual regeneration': 'вручную',
  'admin manual bulk regeneration': 'пересборка вручную',
  'admin plan created': 'тариф добавлен',
  'admin plan updated': 'тариф изменён',
  'admin plan deleted': 'тариф удалён',
  'admin branding updated': 'оформление',
  'admin incident created': 'новый инцидент',
  'admin incident updated': 'инцидент изменён',
  'admin incident deleted': 'инцидент удалён',
  'admin notifications toggled': 'уведомления по почте',
  'provider service notices changed': 'уведомления провайдера',
  'daily refresh': 'ежедневное обновление',
  'startup pre-generation': 'запуск сервера',
  'lazy stream request': 'зритель открыл канал',
  'gateway filler': 'зритель без доступа',
  'admin retry': 'повтор',
  'admin request': 'вручную',
  startup: 'запуск сервера',
  'article added': 'новая статья',
  'article edited': 'статья изменена',
  'article deleted': 'статья удалена',
  'articles reordered': 'новый порядок',
  'video processed': 'видео готово',
  'client created': 'новый клиент',
  'client deleted': 'клиент удалён',
  'client plan changed': 'тариф клиента',
};

export function reasonLabel(reason) {
  return REASONS[reason] || reason || '';
}

export const PRIORITY = {
  viewer: { label: 'ждёт зритель', color: 'volcano' },
  admin: { label: 'правка', color: 'blue' },
  background: { label: 'фон', color: 'default' },
};

// "≈ 3 мин" / "≈ 40 сек" for an estimate in seconds.
export function etaPretty(secs) {
  if (!secs || !Number.isFinite(secs)) return '';
  if (secs < 60) return `≈ ${Math.max(5, Math.round(secs / 5) * 5)} сек`;
  return `≈ ${Math.round(secs / 60)} мин`;
}

// What the dock and the header badge show, from one snapshot.
export function summarizeJobs(jobs) {
  const queue = jobs?.queue;
  const media = jobs?.media;
  const running = queue?.running || [];
  const queued = queue?.queued_total || 0;
  // Overlapping bulk rebuilds share their jobs; the newest names the work.
  const batch = (queue?.batches || []).filter((b) => !b.finished_at).at(-1) || null;
  const videos = media?.videos || [];
  const mediaBuilding = media?.build?.state === 'building' || !!media?.build?.pending;
  const encodes = running.length + queued;
  const active = encodes + videos.length + (mediaBuilding ? 1 : 0);

  let title = '';
  let count = '';
  let percent = 0;
  let indeterminate = true;
  if (batch) {
    const done = Math.min(batch.done, batch.total);
    title = 'Пересборка потоков';
    count = `${done} / ${batch.total}`;
    percent = Math.round((done / batch.total) * 100);
    indeterminate = false;
  } else if (encodes) {
    title = encodes === 1 ? 'Обновление потока' : 'Обновление потоков';
    count = encodes === 1 ? (running[0] || queue.queued[0])?.label || '' : `${encodes}`;
  } else if (videos.length) {
    title = 'Обработка видео';
    count = videos.length > 1 ? `${videos.length}` : videos[0].name || '';
  } else if (mediaBuilding) {
    title = 'Сборка медиаканала';
  }

  // Encodes left × the moving average, spread over the workers.
  const left = batch ? batch.total - batch.done : encodes;
  const eta = left > 0 && queue?.avg_seconds
    ? (left * queue.avg_seconds) / Math.max(1, Math.min(queue.workers || 1, left))
    : 0;

  return {
    ready: !!jobs,
    busy: !!jobs?.busy,
    active,
    title,
    count,
    percent,
    indeterminate,
    eta,
    batch,
    running,
    queued,
    videos,
    mediaBuilding,
  };
}

const JobsContext = createContext(null);

// The feed itself; App owns it (its save flow waits on `refresh`) and hands
// it down through <JobsProvider>.
export function useJobsFeed({ api, enabled, onAuthError }) {
  const [jobs, setJobs] = useState(null);
  const [live, setLive] = useState(false);
  const authError = useRef(onAuthError);
  authError.current = onAuthError;

  // Mutations answer with a fresh snapshot; this takes it without a refetch.
  const apply = useCallback((next) => {
    if (next?.queue) setJobs(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get('/admin/api/jobs');
      setJobs(next);
      return next;
    } catch (e) {
      if (e instanceof AuthError) authError.current?.();
      return null;
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) return undefined;
    let source = null;
    let pollTimer = null;
    let retryTimer = null;
    let stopped = false;

    const startPolling = () => {
      if (pollTimer) return;
      refresh();
      pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    };
    const stopPolling = () => {
      clearInterval(pollTimer);
      pollTimer = null;
    };
    const connect = () => {
      if (stopped) return;
      if (typeof EventSource === 'undefined') { startPolling(); return; }
      source = new EventSource('/admin/api/jobs/events', { withCredentials: true });
      source.addEventListener('jobs', (ev) => {
        stopPolling();
        setLive(true);
        try { setJobs(JSON.parse(ev.data)); } catch { /* a torn event: the next one fixes it */ }
      });
      source.onerror = () => {
        setLive(false);
        // CONNECTING: the browser retries by itself. CLOSED (401, a proxy
        // refusing the stream): poll — which also notices a signed-out
        // session — and try the feed again later.
        if (source.readyState === EventSource.CLOSED) {
          source = null;
          startPolling();
          retryTimer = setTimeout(connect, RECONNECT_MS);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      stopPolling();
      clearTimeout(retryTimer);
    };
  }, [enabled, refresh]);

  const summary = useMemo(() => summarizeJobs(jobs), [jobs]);
  return useMemo(() => ({
    jobs, summary, live, refresh, apply,
  }), [jobs, summary, live, refresh, apply]);
}

export function JobsProvider({ value, children }) {
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs() {
  const value = useContext(JobsContext);
  if (!value) throw new Error('useJobs outside JobsProvider');
  return value;
}
