import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import {
  Alert, Button, Descriptions, Drawer, Empty, Grid, Space, Spin, Typography,
} from 'antd';
import { CheckOutlined, CopyOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import {
  ChannelStateTag, KINDS, KindTag, ViewerList, cases, channelDiagnosis, clients, incidentText, ms, span, viewersText,
  when,
} from '../lib/diagnostics.jsx';

// One channel on the Диагностика page: what is wrong now, the last half hour
// (viewers with and without trouble against the provider's answer time), who
// is watching, and every problem since the channel was last marked fixed.

const POLL_MS = 5_000;
const CHART_HEIGHT = 120;

// Bars: the minute's viewers, the troubled ones on top. Line: the provider's
// median answer time that minute. One time axis, so cause and effect line up.
function HealthChart({ minutes, slowMs }) {
  const most = Math.max(1, ...minutes.map((m) => m.viewers));
  const slowest = Math.max(slowMs * 1.5, ...minutes.map((m) => m.latency_ms || 0));
  const step = 300 / Math.max(1, minutes.length - 1);
  // The line breaks over minutes without an answer.
  const runs = [];
  let run = [];
  minutes.forEach((m, i) => {
    if (m.latency_ms === null || m.latency_ms === undefined) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push(`${(i * step).toFixed(1)},${(96 - (m.latency_ms / slowest) * 86).toFixed(1)}`);
  });
  if (run.length) runs.push(run);
  // A minute on its own has no line to draw: a dot instead.
  const dots = runs.filter((r) => r.length === 1).map((r) => r[0].split(',').map(Number));
  const labels = minutes.filter((_, i) => i % 6 === 0 || i === minutes.length - 1);
  const time = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return (
    <div>
      <div
        role="img"
        aria-label="Зрители по минутам и время ответа провайдера за последние 30 минут"
        style={{ position: 'relative', height: CHART_HEIGHT, borderBottom: '1px solid #e2e8f0' }}
      >
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 3,
        }}
        >
          {minutes.map((m) => {
            const ok = ((m.viewers - m.troubled) / most) * (CHART_HEIGHT - 8);
            const bad = (m.troubled / most) * (CHART_HEIGHT - 8);
            return (
              <span key={m.at} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', gap: 1 }}>
                {bad ? <span style={{ height: bad, background: '#f59e0b', borderRadius: '2px 2px 0 0' }} /> : null}
                {ok ? <span style={{ height: ok, background: '#cbd5e1', borderRadius: bad ? 0 : '2px 2px 0 0' }} /> : null}
              </span>
            );
          })}
        </div>
        <svg
          viewBox="0 0 300 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible',
          }}
        >
          {runs.map((points) => (
            <polyline
              key={points[0]}
              points={points.join(' ')}
              fill="none"
              stroke="#2563eb"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {dots.map(([x, y]) => (
          <span
            key={`${x},${y}`}
            style={{
              position: 'absolute',
              left: `calc(${(x / 300) * 100}% - 3px)`,
              top: `calc(${y}% - 3px)`,
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#2563eb',
            }}
          />
        ))}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginTop: 4,
      }}
      >
        {labels.map((m) => <span key={m.at}>{time(m.at)}</span>)}
      </div>
      <Space size={16} wrap style={{ marginTop: 8 }}>
        <LegendMark color="#cbd5e1" label="зрители без проблем" />
        <LegendMark color="#f59e0b" label="зрители с перебоями" />
        <LegendMark color="#2563eb" label="ответ провайдера" line />
      </Space>
    </div>
  );
}

function LegendMark({ color, label, line }) {
  return (
    <Space size={6}>
      <span style={{
        display: 'inline-block', width: line ? 14 : 10, height: line ? 2 : 10, borderRadius: line ? 0 : 2, background: color,
      }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
    </Space>
  );
}

function duration(inc) {
  const d = span(Date.parse(inc.ended) - Date.parse(inc.started));
  return inc.ongoing ? `идёт ${d}` : d;
}

// What to send the provider: the channel, its problems and when.
function report(detail) {
  const kinds = [...new Set(detail.history.map((h) => KINDS[h.kind]?.label).filter(Boolean))];
  const lines = [
    `Канал: ${detail.name}`,
    `Проблемы с ${when(detail.since)}: ${kinds.join(', ').toLowerCase()}`,
    `Случаев: ${detail.count}, затронуто клиентов: ${detail.clients}`,
    '',
    'Последние случаи:',
    ...detail.history.slice(0, 10).map((h) => `— ${when(h.started)}: ${incidentText(h)} (${duration(h)})`),
  ];
  return lines.join('\n');
}

export default function ChannelDiagDrawer({
  channelId, api, message, onAuthError, onClose, go, check, onResolved,
}) {
  const screens = Grid.useBreakpoint();
  const [detail, setDetail] = useState(null);
  const [fixing, setFixing] = useState(false);

  // The page re-renders on every poll with fresh callbacks; reading them
  // through a ref keeps the poll below from restarting (and the drawer from
  // blanking) each time.
  const handlers = useRef();
  handlers.current = { message, onAuthError, onClose };

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      setDetail(await api.get(`/admin/api/diagnostics/channels/${encodeURIComponent(channelId)}`));
    } catch (e) {
      if (e instanceof AuthError) handlers.current.onAuthError();
      else {
        handlers.current.message.error(e.message);
        handlers.current.onClose();
      }
    }
  }, [api, channelId]);

  useEffect(() => { setDetail(null); }, [channelId]);

  useEffect(() => {
    if (!channelId) return undefined;
    load();
    const tick = () => { if (!document.hidden) load(); };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [channelId, load]);

  const resolve = async () => {
    setFixing(true);
    try {
      const res = await api.post(`/admin/api/diagnostics/channels/${encodeURIComponent(channelId)}/resolve`, {});
      onResolved({ channel_id: channelId, name: detail?.name || channelId, cleared_at: res.cleared_at });
      await load();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setFixing(false);
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report(detail));
      message.success('Отчёт скопирован');
    } catch {
      message.error('Не удалось скопировать');
    }
  };

  const live = detail?.live;
  const watched = live && live.viewers.length > 0;
  const diagnosis = watched ? channelDiagnosis(live) : '';

  return (
    <Drawer
      open={!!channelId}
      onClose={onClose}
      width={screens.md ? 720 : '100%'}
      title={detail ? (
        <Space size={12} wrap>
          <span>{detail.name}</span>
          {watched ? <ChannelStateTag state={live.state} /> : null}
        </Space>
      ) : 'Канал'}
      destroyOnHidden
    >
      {!detail ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 48 }}><Spin /></div>
      ) : (
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <Descriptions size="small" column={screens.sm ? 3 : 1}>
            <Descriptions.Item label="Группа">{detail.group || '—'}</Descriptions.Item>
            <Descriptions.Item label="Смотрят сейчас">{watched ? viewersText(live.viewers.length) : 'никто'}</Descriptions.Item>
            {live?.target_ms ? (
              <Descriptions.Item label="Видео кусками по">{`${Math.round(live.target_ms / 1000)} с`}</Descriptions.Item>
            ) : null}
          </Descriptions>

          {watched ? (
            <Alert
              type={diagnosis ? 'info' : 'success'}
              showIcon
              message={diagnosis || 'Сейчас канал работает без перебоев'}
            />
          ) : null}

          {live ? (
            <section>
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
                <Typography.Text strong>Последние 30 минут</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`ответ провайдера сейчас ${ms(live.latency_ms)} · обычно ${ms(live.usual_ms)}`}
                </Typography.Text>
              </Space>
              <HealthChart minutes={live.minutes} slowMs={detail.slow_ms} />
            </section>
          ) : null}

          {watched ? (
            <section>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>Кто смотрит</Typography.Text>
              <ViewerList viewers={live.viewers} go={go} />
            </section>
          ) : null}

          <section>
            <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
              <Space size={6} wrap>
                <Typography.Text strong>История проблем</Typography.Text>
                {detail.count ? (
                  <Typography.Text type="secondary">
                    {`· с ${when(detail.since, { time: false })}, ${cases(detail.count)} у ${clients(detail.clients)}`}
                  </Typography.Text>
                ) : null}
              </Space>
              {detail.count ? (
                <Button size="small" icon={<CheckOutlined style={{ color: '#16a34a' }} />} loading={fixing} onClick={resolve}>
                  Отметить исправленным
                </Button>
              ) : null}
            </Space>
            {detail.history.length ? (
              <Space direction="vertical" size={0} style={{ width: '100%' }}>
                {detail.history.map((h) => (
                  <div
                    key={h.id}
                    style={{
                      display: 'flex', gap: 12, alignItems: 'baseline', padding: '8px 0', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap',
                    }}
                  >
                    <Typography.Text type="secondary" style={{ fontSize: 12, width: 100, flex: 'none' }}>{when(h.started)}</Typography.Text>
                    <KindTag kind={h.kind} />
                    <span style={{ flex: '1 1 200px', minWidth: 0 }}>{`${incidentText(h)} · ${clients(h.clients)}`}</span>
                    <Typography.Text
                      style={{ fontSize: 12, color: h.ongoing ? '#b91c1c' : '#64748b', fontWeight: h.ongoing ? 600 : 400 }}
                    >
                      {duration(h)}
                    </Typography.Text>
                  </div>
                ))}
                {detail.count > detail.history.length ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12, paddingTop: 8 }}>
                    {`Показаны последние ${detail.history.length} из ${detail.count}`}
                  </Typography.Text>
                ) : null}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="С последнего исправления проблем не было" />
            )}
          </section>

          <Space wrap>
            {detail.checkable ? (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={check.running === channelId}
                onClick={() => check.run(channelId, detail.name)}
              >
                Проверить канал сейчас
              </Button>
            ) : null}
            {detail.count ? (
              <Button icon={<CopyOutlined />} onClick={copyReport}>Скопировать отчёт для провайдера</Button>
            ) : null}
          </Space>
        </Space>
      )}
    </Drawer>
  );
}
