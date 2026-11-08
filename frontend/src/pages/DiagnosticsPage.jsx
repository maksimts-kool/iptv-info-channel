import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Empty, Space, Switch, Tooltip, Typography,
} from 'antd';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import ChannelDiagDrawer from '../diagnostics/ChannelDiagDrawer.jsx';
import { AuthError } from '../lib/api.js';
import {
  CHANNEL_STATES, ChannelStateTag, KindTag, MinuteLegend, MinuteStrip, VerificationProgress, ViewerList, causeOf,
  channelDiagnosis, ms, resolvedText, span, troubleSummary, useChannelCheck, viewersText, when,
} from '../lib/diagnostics.jsx';

// Are the channels customers watch working? The live table is what is being
// watched right now, judged from the manifests passing through the stream
// gateway. The problem register keeps every channel that had trouble until
// it is shown to work again: the server checks it at the provider and
// watches customers play it; then it moves to the resolved list on its own
// (a problem that comes back puts it back).

const POLL_MS = 5_000;

// #/diagnostics/<channel id>: that channel's drawer is open.
function channelFromHash() {
  const m = window.location.hash.match(/^#\/?diagnostics\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function SummaryCard({
  label, value, caption, dot, valueColor, active, onClick,
}) {
  return (
    <Card
      size="small"
      hoverable
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        borderColor: active ? '#2563eb' : undefined,
        boxShadow: active ? '0 0 0 3px rgba(37,99,235,.15)' : undefined,
      }}
    >
      <Space direction="vertical" size={2}>
        <Badge color={dot} text={<Typography.Text type="secondary" style={{ fontSize: 13 }}>{label}</Typography.Text>} />
        <span style={{ fontSize: 26, fontWeight: 600, color: valueColor }}>{value}</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{caption}</Typography.Text>
      </Space>
    </Card>
  );
}

const FILTER_NAMES = {
  all: 'все', ok: 'работают', warn: 'с перебоями', bad: 'не работают',
};

export default function DiagnosticsPage({
  api, message, onAuthError, go,
}) {
  const [data, setData] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState('all');
  const [drawer, setDrawer] = useState(channelFromHash);

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/admin/api/diagnostics'));
      setUpdatedAt(new Date());
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [api, fail]);

  useEffect(() => { load(); }, [load]);

  // A check counts towards the channel's way out: show it at once.
  const check = useChannelCheck({
    api, message, onAuthError, onDone: load,
  });

  // Polled while the tab is visible and auto-refresh is on.
  useEffect(() => {
    if (!auto) return undefined;
    const tick = () => { if (!document.hidden) load(); };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [auto, load]);

  useEffect(() => {
    const onHash = () => setDrawer(channelFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openChannel = (id) => go(`diagnostics/${encodeURIComponent(id)}`);
  const closeChannel = () => go('diagnostics');

  const channels = data?.channels || [];
  const problems = data?.problems || [];
  const resolved = data?.resolved || [];
  const req = data?.verify;
  const slowMs = data?.slow_ms ?? 1500;
  const groupOf = (c) => CHANNEL_STATES[c.state]?.group || 'ok';
  const countOf = (g) => channels.filter((c) => groupOf(c) === g).length;
  const viewers = channels.reduce((n, c) => n + c.viewers.length, 0);
  const shown = filter === 'all' ? channels : channels.filter((c) => groupOf(c) === filter);

  const cards = [
    {
      key: 'all', label: 'Каналов смотрят', value: channels.length, caption: viewersText(viewers), dot: '#2563eb',
    },
    {
      key: 'ok', label: 'Работают', value: countOf('ok'), caption: 'без перебоев', dot: '#16a34a',
    },
    {
      key: 'warn', label: 'С перебоями', value: countOf('warn'), caption: 'медленно или у части зрителей', dot: '#d97706', valueColor: countOf('warn') ? '#b45309' : undefined,
    },
    {
      key: 'bad', label: 'Не работают', value: countOf('bad'), caption: 'ошибки провайдера, завис', dot: '#dc2626', valueColor: countOf('bad') ? '#b91c1c' : undefined,
    },
  ];

  const viewerRows = (c) => (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>Кто смотрит</Typography.Text>
      <ViewerList viewers={c.viewers} go={go} />
    </Space>
  );

  const liveColumns = [
    { title: 'Состояние', width: 140, render: (_, c) => <ChannelStateTag state={c.state} /> },
    {
      title: 'Канал',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Link strong onClick={() => openChannel(c.channel_id)}>{c.name}</Typography.Link>
          {c.group ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.group}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: 'Зрители',
      width: 150,
      render: (_, c) => {
        const trouble = troubleSummary(c.viewers);
        return (
          <Space direction="vertical" size={0}>
            <span>{c.viewers.length}</span>
            {trouble ? (
              <Typography.Text style={{ fontSize: 12, color: groupOf(c) === 'bad' ? '#b91c1c' : '#b45309' }}>
                {trouble}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    { title: 'Последние 30 мин', width: 210, render: (_, c) => <MinuteStrip minutes={c.minutes} /> },
    {
      title: 'Ответ провайдера',
      width: 140,
      render: (_, c) => (
        <Typography.Text
          strong={c.latency_ms > slowMs}
          style={{ color: c.latency_ms > slowMs ? '#b45309' : undefined, whiteSpace: 'nowrap' }}
        >
          {ms(c.latency_ms)}
        </Typography.Text>
      ),
    },
    { title: 'Что не так', render: (_, c) => channelDiagnosis(c) || <Typography.Text type="secondary">—</Typography.Text> },
  ];

  const problemColumns = [
    {
      title: 'Канал',
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          <Typography.Link strong onClick={() => openChannel(p.channel_id)}>{p.name || p.channel_id}</Typography.Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{causeOf(p.kinds)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Что случалось',
      render: (_, p) => <Space size={4} wrap>{p.kinds.map((k) => <KindTag key={k} kind={k} />)}</Space>,
    },
    { title: 'Случаев', dataIndex: 'count', width: 90 },
    { title: 'Клиентов', dataIndex: 'clients', width: 100 },
    { title: 'Впервые', width: 130, render: (_, p) => <Typography.Text type="secondary">{when(p.first, { time: false })}</Typography.Text> },
    {
      title: 'Последний раз',
      width: 140,
      render: (_, p) => <Typography.Text type="secondary">{when(p.last)}</Typography.Text>,
    },
    {
      title: 'Проверка',
      width: 170,
      render: (_, p) => <VerificationProgress verification={p.verification} req={req} ongoing={p.ongoing} />,
    },
    {
      title: '',
      width: 56,
      align: 'right',
      render: (_, p) => (
        <Tooltip title="Проверить канал сейчас (засчитывается в проверку)">
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={check.running === p.channel_id}
            onClick={() => check.run(p.channel_id, p.name)}
            aria-label="Проверить канал сейчас"
          />
        </Tooltip>
      ),
    },
  ];

  const resolvedColumns = [
    {
      title: 'Канал',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Link strong onClick={() => openChannel(r.channel_id)}>{r.name || r.channel_id}</Typography.Link>
          {r.group ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.group}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: 'Что было',
      render: (_, r) => <Space size={4} wrap>{r.kinds.map((k) => <KindTag key={k} kind={k} />)}</Space>,
    },
    { title: 'Случаев', dataIndex: 'count', width: 90 },
    { title: 'Клиентов', dataIndex: 'clients', width: 100 },
    { title: 'Решено', width: 140, render: (_, r) => <Typography.Text type="secondary">{when(r.resolved)}</Typography.Text> },
    { title: 'Чем подтверждено', render: (_, r) => <Typography.Text type="secondary">{resolvedText(r)}</Typography.Text> },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {check.contextHolder}
      {data && !data.gateway_enabled ? (
        <Alert
          type="warning"
          showIcon
          message="Шлюз потоков выключен — диагностика видит только каналы из плейлистов, выданных при включённом шлюзе"
        />
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {cards.map((c) => (
          <SummaryCard
            key={c.key}
            label={c.label}
            value={c.value}
            caption={c.caption}
            dot={c.dot}
            valueColor={c.valueColor}
            active={filter === c.key}
            onClick={() => setFilter(c.key)}
          />
        ))}
        <SummaryCard
          label="Проблемные каналы"
          value={problems.length}
          caption="ждут подтверждения, что работают"
          dot="#dc2626"
          valueColor={problems.length ? '#b91c1c' : undefined}
          active={false}
          onClick={() => document.getElementById('diag-problems')?.scrollIntoView({ behavior: 'smooth' })}
        />
      </div>

      <Card
        title={(
          <Space>
            <Badge status={auto ? 'processing' : 'default'} />
            Каналы, которые смотрят сейчас
            <Typography.Text type="secondary" style={{ fontWeight: 400 }}>{`· ${FILTER_NAMES[filter]}`}</Typography.Text>
          </Space>
        )}
        extra={(
          <Space size="middle" wrap>
            {updatedAt ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {`обновлено ${updatedAt.toLocaleTimeString('ru-RU')}`}
              </Typography.Text>
            ) : null}
            <Space size={6}>
              <Switch size="small" checked={auto} onChange={setAuto} />
              <Typography.Text>Автообновление</Typography.Text>
            </Space>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="Обновить" />
          </Space>
        )}
        styles={{ body: { padding: shown.length ? 0 : undefined } }}
      >
        {shown.length ? (
          <>
            <ResponsiveTable
              size="middle"
              rowKey="channel_id"
              pagination={shown.length > 20 ? { pageSize: 20 } : false}
              dataSource={shown}
              columns={liveColumns}
              rowClassName={(c) => (groupOf(c) === 'bad' ? 'row-over-limit' : '')}
              expandable={{ expandedRowRender: viewerRows }}
              scroll={{ x: 'max-content' }}
            />
            <div style={{ padding: '12px 16px' }}><MinuteLegend /></div>
          </>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={channels.length ? 'Таких каналов сейчас нет' : 'Сейчас никто не смотрит каналы провайдера'}
          />
        )}
      </Card>

      <Card
        id="diag-problems"
        title="Проблемные каналы"
        extra={(
          <Tooltip
            title={req
              ? `Канал уходит из списка сам: ${span(req.quiet_ms)} без проблем, ${req.probes} проверки сервером у провайдера и ${span(req.viewing_ms)} просмотра без перебоев (без зрителей — ${span(req.unwatched_ms)} проверок сервера). Новая проблема начинает проверку заново.`
              : null}
          >
            <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>уходят сами, когда подтвердится, что работают</Typography.Text>
          </Tooltip>
        )}
        styles={{ body: { padding: problems.length ? 0 : undefined } }}
      >
        {problems.length ? (
          <ResponsiveTable
            size="middle"
            rowKey="channel_id"
            pagination={problems.length > 20 ? { pageSize: 20 } : false}
            dataSource={problems}
            columns={problemColumns}
            scroll={{ x: 'max-content' }}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Проблемных каналов нет" style={{ padding: 16 }} />
        )}
      </Card>

      {resolved.length ? (
        <Card
          title="Решены за 7 дней"
          extra={(
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              подтверждены проверками сервера и зрителями
            </Typography.Text>
          )}
          styles={{ body: { padding: 0 } }}
        >
          <ResponsiveTable
            size="middle"
            rowKey={(r) => `${r.channel_id}|${r.resolved}`}
            pagination={resolved.length > 10 ? { pageSize: 10 } : false}
            dataSource={resolved}
            columns={resolvedColumns}
            scroll={{ x: 'max-content' }}
          />
        </Card>
      ) : null}

      <ChannelDiagDrawer
        channelId={drawer}
        api={api}
        message={message}
        onAuthError={onAuthError}
        onClose={closeChannel}
        go={go}
        check={check}
      />
    </Space>
  );
}
