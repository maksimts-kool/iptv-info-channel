import { useEffect, useRef, useState } from 'react';
import {
  Button, Empty, Popconfirm, Tag, Tooltip, Typography,
} from 'antd';
import {
  CheckCircleFilled, CloseCircleFilled, CloseOutlined, DownOutlined, MinusCircleFilled,
  PictureOutlined, RedoOutlined, StopOutlined, SyncOutlined, UpOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import {
  PRIORITY, etaPretty, reasonLabel, useJobs,
} from '../lib/jobs.jsx';

const { Text } = Typography;

const QUEUED_SHOWN = 8;
const RECENT_SHOWN = 12;

const OUTCOME = {
  encoded: { Icon: CheckCircleFilled, color: '#16a34a', label: 'собран' },
  up_to_date: { Icon: MinusCircleFilled, color: '#9ca3af', label: 'без изменений' },
  failed: { Icon: CloseCircleFilled, color: '#dc2626', label: 'ошибка' },
  not_found: { Icon: CloseCircleFilled, color: '#dc2626', label: 'клиент удалён' },
  cancelled: { Icon: StopOutlined, color: '#9ca3af', label: 'отменён' },
};

function duration(secs) {
  const s = Math.max(0, Math.round(secs || 0));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с`;
}

function clock(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function reasons(list) {
  return (list || []).map(reasonLabel).filter(Boolean).join(', ');
}

// Seconds a running job has been going, ticking locally between snapshots.
function useElapsed(jobs, enabled) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  const skew = jobs?.server_time ? Date.parse(jobs.server_time) - Date.now() : 0;
  return (startedAt) => (Date.now() + skew - Date.parse(startedAt)) / 1000;
}

function Section({ title, extra, children }) {
  return (
    <div className="jobs-section">
      <div className="jobs-section-head">
        <span>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

// The background work panel (bottom-right). Collapsed it is the familiar
// one-line progress card; expanded it lists what runs, what waits (in run
// order), the media channel's builds and the recent results, with cancel,
// retry and clear. It shows itself while anything runs, flashes "Готово" (or
// the failures) when the queue drains, and stays open while pinned from the
// header button.
export default function JobsDock({
  open, onOpenChange, pending, api, message, onAuthError,
}) {
  const { jobs, summary, apply } = useJobs();
  const [done, setDone] = useState(null);
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showAllQueued, setShowAllQueued] = useState(false);
  const wasActive = useRef(false);
  const seen = useRef(new Set());
  const doneTimer = useRef();
  const exitTimer = useRef();
  const lastHead = useRef(null);
  const elapsed = useElapsed(jobs, open && summary.running.length > 0);

  const recent = jobs?.queue?.recent || [];
  // A save counts from the click: its encode may finish before a snapshot
  // ever shows it running.
  const working = summary.active > 0 || pending;

  // Working -> idle: say how it went, briefly.
  useEffect(() => {
    if (!summary.ready) return;
    if (working) {
      if (!wasActive.current) seen.current = new Set(recent.map((r) => r.id));
      wasActive.current = true;
      clearTimeout(doneTimer.current);
      setDone(null);
      return;
    }
    if (wasActive.current) {
      wasActive.current = false;
      const fresh = recent.filter((r) => !seen.current.has(r.id));
      const failed = fresh.filter((r) => r.outcome === 'failed' || r.outcome === 'not_found').length;
      setDone({ failed, total: fresh.length });
      clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => setDone(null), failed ? 6000 : 2500);
    }
  }, [working, summary.ready, recent]);

  useEffect(() => () => clearTimeout(doneTimer.current), []);

  const visible = open || working || !!done;

  // Keep rendering through the fade-out.
  useEffect(() => {
    if (visible) {
      clearTimeout(exitTimer.current);
      setClosing(false);
      setMounted(true);
      return undefined;
    }
    setClosing(true);
    exitTimer.current = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(exitTimer.current);
  }, [visible]);

  if (!mounted) return null;

  const act = async (fn, success) => {
    try {
      apply(await fn());
      if (success) message.success(success);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };
  const cancel = (id) => act(() => api.post(`/admin/api/jobs/${id}/cancel`));
  const retry = (id) => act(() => api.post(`/admin/api/jobs/${id}/retry`), 'Поставлено в очередь');
  const clear = () => act(() => api.post('/admin/api/jobs/clear'), 'Очередь очищена');

  // The headline.
  let title = summary.title;
  let count = summary.count;
  let state = 'busy';
  if (!summary.active && pending) {
    title = 'Обновление потоков';
    count = '';
  } else if (!summary.active && done) {
    state = done.failed ? 'warn' : 'done';
    title = done.failed ? `Готово, ошибок: ${done.failed}` : 'Готово';
    count = '';
  } else if (!summary.active) {
    state = 'idle';
    title = 'Фоновые задачи';
    count = '';
  }
  let indet = state === 'busy' && (summary.indeterminate || !summary.active);
  let width = state === 'busy' ? summary.percent : 100;
  let eta = state === 'busy' ? etaPretty(summary.eta) : '';
  // The fade-out keeps the last headline instead of flashing the idle one.
  if (visible) {
    lastHead.current = {
      title, count, state, indet, width, eta,
    };
  } else if (lastHead.current) {
    ({
      title, count, state, indet, width, eta,
    } = lastHead.current);
  }

  const queue = jobs?.queue;
  const queuedList = queue?.queued || [];
  const shownQueued = showAllQueued ? queuedList : queuedList.slice(0, QUEUED_SHOWN);
  const media = jobs?.media;
  const totals = queue?.totals;

  return (
    <div
      className={`jobs-dock ${open ? 'jobs-dock-open' : ''} ${closing ? 'jobs-out' : 'jobs-in'}`}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="jobs-head"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label={open ? 'Свернуть список задач' : 'Показать список задач'}
      >
        <span className={`jobs-dot jobs-dot-${state}`} />
        <span className="jobs-title">{title}</span>
        {count ? <span className="jobs-count">{count}</span> : null}
        {eta ? <span className="jobs-count">{eta}</span> : null}
        <span className="jobs-chevron">{open ? <DownOutlined /> : <UpOutlined />}</span>
      </button>
      {state !== 'idle' ? (
        <div className="jobs-track">
          <div
            className={`jobs-fill jobs-fill-${state} ${indet ? 'indet' : ''}`}
            style={indet ? undefined : { width: `${width}%` }}
          />
        </div>
      ) : null}

      {open ? (
        <div className="jobs-body">
          {summary.batch ? (
            <div className="jobs-batch">
              <Text type="secondary">
                {reasonLabel(summary.batch.reason)}
                {' · с '}
                {clock(summary.batch.started_at)}
                {summary.batch.failed ? ` · ошибок: ${summary.batch.failed}` : ''}
              </Text>
            </div>
          ) : null}

          {summary.running.length ? (
            <Section title="Выполняется">
              {summary.running.map((r) => (
                <div className="jobs-row" key={r.id}>
                  <SyncOutlined spin className="jobs-row-icon" style={{ color: '#2563eb' }} />
                  <div className="jobs-row-main">
                    <div className="jobs-row-name">{r.label}</div>
                    <div className="jobs-row-meta">
                      {reasons(r.reasons)}
                      {r.attempt > 1 ? ' · повтор' : ''}
                    </div>
                  </div>
                  <span className="jobs-row-time">{duration(elapsed(r.started_at))}</span>
                  <Tooltip title="Остановить">
                    <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => cancel(r.id)} aria-label="Остановить" />
                  </Tooltip>
                </div>
              ))}
            </Section>
          ) : null}

          {summary.queued ? (
            <Section
              title={`В очереди · ${summary.queued}`}
              extra={(
                <Popconfirm
                  title="Убрать всё из очереди?"
                  description="Потоки останутся прежними до следующей правки или ежедневного обновления."
                  okText="Очистить"
                  cancelText="Отмена"
                  onConfirm={clear}
                >
                  <Button size="small" type="link">Очистить</Button>
                </Popconfirm>
              )}
            >
              {shownQueued.map((q) => (
                <div className="jobs-row" key={q.id}>
                  <span className="jobs-row-icon jobs-queued-dot" />
                  <div className="jobs-row-main">
                    <div className="jobs-row-name">
                      {q.label}
                      {' '}
                      <Tag color={PRIORITY[q.priority]?.color} bordered={false} className="jobs-tag">
                        {PRIORITY[q.priority]?.label}
                      </Tag>
                    </div>
                    <div className="jobs-row-meta">
                      {reasons(q.reasons)}
                      {q.retry_in ? ` · повтор через ${Math.ceil(q.retry_in)} с` : ''}
                    </div>
                  </div>
                  <Tooltip title="Убрать из очереди">
                    <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => cancel(q.id)} aria-label="Убрать из очереди" />
                  </Tooltip>
                </div>
              ))}
              {queuedList.length > QUEUED_SHOWN ? (
                <Button size="small" type="link" onClick={() => setShowAllQueued((v) => !v)}>
                  {showAllQueued ? 'Свернуть' : `Показать все (${queuedList.length})`}
                </Button>
              ) : null}
              {summary.queued > queuedList.length ? (
                <Text type="secondary" className="jobs-row-meta">{`и ещё ${summary.queued - queuedList.length}`}</Text>
              ) : null}
            </Section>
          ) : null}

          {summary.mediaBuilding || summary.videos.length ? (
            <Section title="Медиаканал">
              {summary.videos.map((v) => (
                <div className="jobs-row" key={v.asset_id}>
                  {v.state === 'running'
                    ? <SyncOutlined spin className="jobs-row-icon" style={{ color: '#2563eb' }} />
                    : <span className="jobs-row-icon jobs-queued-dot" />}
                  <div className="jobs-row-main">
                    <div className="jobs-row-name">{v.name || 'Видео'}</div>
                    <div className="jobs-row-meta">{v.state === 'running' ? 'обработка видео' : 'ждёт обработки'}</div>
                  </div>
                  {v.started_at ? <span className="jobs-row-time">{duration(elapsed(v.started_at))}</span> : null}
                </div>
              ))}
              {summary.mediaBuilding ? (
                <div className="jobs-row">
                  {media?.build?.state === 'building'
                    ? <SyncOutlined spin className="jobs-row-icon" style={{ color: '#2563eb' }} />
                    : <PictureOutlined className="jobs-row-icon" />}
                  <div className="jobs-row-main">
                    <div className="jobs-row-name">Сборка канала</div>
                    <div className="jobs-row-meta">
                      {media?.build?.state === 'building' ? reasonLabel(media.build.reason) : 'скоро начнётся'}
                    </div>
                  </div>
                  {media?.build?.state === 'building' && media.build.started_at
                    ? <span className="jobs-row-time">{duration(elapsed(media.build.started_at))}</span>
                    : null}
                </div>
              ) : null}
            </Section>
          ) : null}

          <Section title="Недавние">
            {recent.length ? recent.slice(0, RECENT_SHOWN).map((r) => {
              const o = OUTCOME[r.outcome] || OUTCOME.encoded;
              const failed = r.outcome === 'failed';
              const row = (
                <div className="jobs-row" key={r.id}>
                  <o.Icon className="jobs-row-icon" style={{ color: o.color }} />
                  <div className="jobs-row-main">
                    <div className="jobs-row-name">{r.label}</div>
                    <div className="jobs-row-meta">
                      {o.label}
                      {r.outcome === 'encoded' ? ` за ${duration(r.seconds)}` : ''}
                      {reasons(r.reasons) ? ` · ${reasons(r.reasons)}` : ''}
                    </div>
                  </div>
                  <span className="jobs-row-time">{clock(r.ended_at)}</span>
                  {failed ? (
                    <Tooltip title="Повторить">
                      <Button size="small" type="text" icon={<RedoOutlined />} onClick={() => retry(r.id)} aria-label="Повторить" />
                    </Tooltip>
                  ) : null}
                </div>
              );
              return failed && r.error
                ? <Tooltip key={r.id} title={r.error} placement="left">{row}</Tooltip>
                : row;
            }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Пока ничего" />}
          </Section>

          {totals ? (
            <div className="jobs-foot">
              {`Параллельно: ${queue.workers} · собрано ${totals.encoded} · без изменений ${totals.up_to_date}`}
              {totals.failed ? ` · ошибок ${totals.failed}` : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
