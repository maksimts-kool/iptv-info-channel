import {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import {
  Alert, Badge, Button, Card, Col, Empty, Row, Segmented, Select, Space, Statistic, Tag, Tooltip, Typography,
} from 'antd';
import {
  ClockCircleOutlined, CloseOutlined, DesktopOutlined, FieldTimeOutlined, PlaySquareOutlined, ReloadOutlined,
  RiseOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import { AuthError } from '../lib/api.js';
import { count, watchTime } from '../lib/format.js';
import {
  BarList, ColumnChart, Heatmap, Legend, OTHER, SERIES, TipBody, useTooltip,
} from '../stats/charts.jsx';

// Viewing statistics: how long each channel is watched and by whom, and when.
// Built from the history the stream gateway records (gated HLS channels and
// the built-in loops), plus whatever is playing right now. #/stats/12 opens
// it filtered to one customer (the link on the customer's card).

const PERIODS = [
  { value: 1, label: 'Сегодня' },
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
];
const TOP_ROWS = 12;
// Channels that get their own colour in "Кто что смотрит"; the rest are «Другие».
const STACKED = SERIES.length;

function fromHash() {
  const m = window.location.hash.match(/^#\/?stats(?:\/(\d+))?(?:\?days=(\d+))?/);
  return { user: m?.[1] ? Number(m[1]) : null, days: m?.[2] ? Number(m[2]) : 7 };
}

function toHash(user, days) {
  const path = user ? `#/stats/${user}` : '#/stats';
  return days === 7 ? path : `${path}?days=${days}`;
}

const MONTH_DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
});
const dateOf = (ymd) => new Date(`${ymd}T00:00:00Z`);
const dayLabel = (ymd, many) => (many
  ? MONTH_DAY.format(dateOf(ymd)).replace('.', '')
  : `${WEEKDAY.format(dateOf(ymd))} ${dateOf(ymd).getUTCDate()}`);

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function Tile({
  title, value, icon, suffix, hint,
}) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Statistic
        title={title}
        value={value}
        prefix={icon}
        suffix={suffix}
        valueStyle={{ fontSize: 22, whiteSpace: 'nowrap' }}
      />
      {hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text> : null}
    </Card>
  );
}

export default function StatsPage({
  api, state, message, onAuthError, go,
}) {
  const [{ user, days }, setFilter] = useState(fromHash);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [channel, setChannel] = useState(null);
  const [tipNode, bind, hideTip] = useTooltip();

  useEffect(() => {
    const onHash = () => setFilter(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const update = (next) => {
    const merged = { user, days, ...next };
    window.history.replaceState(null, '', toHash(merged.user, merged.days));
    setFilter(merged);
    setChannel(null);
    hideTip();
  };
  const pickChannel = (id) => {
    setChannel(id);
    hideTip();
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (user) qs.set('user', String(user));
      setData(await api.get(`/admin/api/stats?${qs}`));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, days, user, onAuthError, message]);

  useEffect(() => { load(); }, [load]);

  const users = state?.users || [];
  const userOptions = useMemo(() => users
    .map((u) => ({ value: u.id, label: u.username }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru')), [users]);

  const totals = data?.totals;
  const live = data?.live || [];
  const channels = data?.channels || [];
  const customers = data?.customers || [];
  const daily = data?.daily || [];
  const heatmap = data?.heatmap || Array.from({ length: 7 }, () => Array(24).fill(0));
  const hasData = !!totals && (totals.sessions > 0 || live.length > 0);

  // Today: one column per hour (every watch falls on the same weekday, so
  // that is one heatmap row). Longer: one column per day.
  const columns = useMemo(() => {
    if (days === 1 && daily.length) {
      const weekday = (dateOf(daily[0].date).getUTCDay() + 6) % 7;
      return heatmap[weekday].map((v, h) => ({
        key: `h${h}`,
        label: String(h).padStart(2, '0'),
        value: v,
        tip: <TipBody title={`${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`} rows={[{ label: 'просмотра', value: watchTime(v) }]} />,
      }));
    }
    return daily.map((d) => ({
      key: d.date,
      label: dayLabel(d.date, daily.length > 10),
      value: d.seconds,
      tip: (
        <TipBody
          title={LONG_DAY.format(dateOf(d.date))}
          rows={[
            { label: 'просмотра', value: watchTime(d.seconds) },
            { label: 'зрителей', value: count(d.viewers) },
            { label: 'просмотров', value: count(d.sessions) },
            { label: 'одновременно максимум', value: count(d.peak) },
          ]}
        />
      ),
    }));
  }, [days, daily, heatmap]);

  // A colour per top channel, fixed by its overall rank, so «Спорт» is the
  // same orange in every customer's bar.
  const channelColor = useMemo(() => {
    const map = new Map();
    channels.slice(0, STACKED).forEach((c, i) => map.set(c.id, SERIES[i]));
    return map;
  }, [channels]);

  const channelRows = channels.slice(0, TOP_ROWS).map((c) => ({
    key: c.id,
    label: c.name,
    sub: user ? `${count(c.sessions)} просм.` : `${count(c.viewers)} зрит. · ${count(c.sessions)} просм.`,
    value: c.seconds,
    onClick: user ? undefined : () => pickChannel(channel === c.id ? null : c.id),
    tip: (
      <TipBody
        title={c.name}
        rows={[
          { label: 'просмотра', value: watchTime(c.seconds) },
          { label: 'зрителей', value: count(c.viewers) },
          { label: 'просмотров', value: count(c.sessions) },
        ]}
      />
    ),
  }));

  const customerRows = customers.slice(0, TOP_ROWS).map((cu) => {
    const own = cu.channels.filter((c) => channelColor.has(c.id));
    const rest = cu.seconds - own.reduce((s, c) => s + c.seconds, 0);
    const segments = [...channelColor.keys()]
      .map((id) => own.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => ({ key: c.id, value: c.seconds, color: channelColor.get(c.id) }));
    if (rest > 0) segments.push({ key: '_other', value: rest, color: OTHER });
    return {
      key: String(cu.user_id),
      label: cu.username,
      sub: `${count(cu.channels.length)} кан. · был ${when(cu.last_seen)}`,
      value: cu.seconds,
      segments,
      onClick: () => update({ user: cu.user_id }),
      tip: (
        <TipBody
          title={cu.username}
          rows={cu.channels.slice(0, 6).map((c) => ({
            label: c.name, value: watchTime(c.seconds), color: channelColor.get(c.id) || OTHER,
          }))}
        />
      ),
    };
  });
  const legend = [
    ...channels.slice(0, STACKED).map((c) => ({ key: c.id, label: c.name, color: channelColor.get(c.id) })),
    ...(channels.length > STACKED ? [{ key: '_other', label: 'Другие', color: OTHER }] : []),
  ];

  const picked = channels.find((c) => c.id === channel);
  const audienceRows = (picked?.users || []).slice(0, TOP_ROWS).map((u) => ({
    key: String(u.user_id),
    label: u.username,
    value: u.seconds,
    color: channelColor.get(picked.id) || OTHER,
    onClick: () => update({ user: u.user_id }),
    tip: <TipBody title={u.username} rows={[{ label: picked.name, value: watchTime(u.seconds) }]} />,
  }));

  const recentColumns = [
    ...(user ? [] : [{
      title: 'Клиент',
      dataIndex: 'username',
      render: (v, r) => <Typography.Link onClick={() => update({ user: r.user_id })}>{v}</Typography.Link>,
    }]),
    {
      title: 'Канал',
      dataIndex: 'channel',
      render: (v, r) => (
        <Space size={6}>
          <span>{v}</span>
          {r.live ? <Tag color="green" bordered={false}>смотрит</Tag> : null}
        </Space>
      ),
    },
    { title: 'Начало', dataIndex: 'started_at', render: when },
    { title: 'Длительность', dataIndex: 'seconds', render: watchTime },
    { title: 'Плеер', dataIndex: 'player', render: (v) => v || '—' },
    {
      title: 'IP',
      dataIndex: 'ip',
      render: (v) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{(v || '').replace(/^::ffff:/i, '') || '—'}</Typography.Text>,
    },
  ];

  const periodWord = days === 1 ? 'сегодня' : `за ${days} дн.`;
  const filteredUser = data?.user || users.find((u) => u.id === user);
  const peakHint = totals?.peak_at ? `в ${when(totals.peak_at)}` : null;
  const chartFrame = { opacity: loading && data ? 0.55 : 1, transition: 'opacity .2s' };

  const empty = (text) => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
  const noData = data?.gateway_enabled === false
    ? 'Нет просмотров: шлюз выключен, поэтому видны только встроенные каналы'
    : 'Нет просмотров за этот период';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {tipNode}
      <div className="stats-filters">
        <Segmented options={PERIODS} value={days} onChange={(v) => update({ days: v })} />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все клиенты"
          value={user ?? undefined}
          options={userOptions}
          onChange={(v) => update({ user: v ?? null })}
          style={{ minWidth: 200 }}
          suffixIcon={<UserOutlined />}
        />
        <Tooltip title="Обновить">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="Обновить" />
        </Tooltip>
        {user && filteredUser ? (
          <Button type="link" onClick={() => go(`clients/${user}`)}>Карточка клиента</Button>
        ) : null}
      </div>

      {data && !data.gateway_enabled ? (
        <Alert
          type="info"
          showIcon
          message="Шлюз потоков выключен"
          description="Плееры открывают каналы провайдера напрямую, и сервер их не видит. В статистику попадают только информационный и медиаканал. Включите шлюз в разделе «Устройства», чтобы считать все HLS-каналы."
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} xxl={4}>
          <Tile title="Время просмотра" value={totals ? watchTime(totals.seconds) : '—'} icon={<FieldTimeOutlined />} hint={periodWord} />
        </Col>
        <Col xs={12} md={8} xxl={4}>
          {user ? (
            <Tile title="Последний просмотр" value={customers[0] ? when(customers[0].last_seen) : '—'} icon={<ClockCircleOutlined />} />
          ) : (
            <Tile title="Зрителей" value={totals ? count(totals.viewers) : '—'} icon={<TeamOutlined />} suffix={users.length ? `/ ${count(users.length)}` : null} />
          )}
        </Col>
        <Col xs={12} md={8} xxl={4}>
          <Tile title="Просмотров" value={totals ? count(totals.sessions) : '—'} icon={<PlaySquareOutlined />} />
        </Col>
        <Col xs={12} md={8} xxl={4}>
          <Tile title="Каналов смотрели" value={totals ? count(totals.channels) : '—'} icon={<PlaySquareOutlined />} />
        </Col>
        <Col xs={12} md={8} xxl={4}>
          <Tile title="Пик одновременно" value={totals ? count(totals.peak) : '—'} icon={<RiseOutlined />} hint={peakHint} />
        </Col>
        <Col xs={12} md={8} xxl={4}>
          <Tile
            title="Смотрят сейчас"
            value={count(live.length)}
            icon={<DesktopOutlined />}
            hint={live.length ? [...new Set(live.map((l) => l.channel))].slice(0, 2).join(', ') : null}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={chartFrame}>
        <Col xs={24} xl={14}>
          <Card size="small" title={days === 1 ? 'Время просмотра по часам' : 'Время просмотра по дням'} style={{ height: '100%' }}>
            {hasData ? (
              <ColumnChart
                items={columns}
                format={watchTime}
                bind={bind}
                ariaLabel={days === 1 ? 'Время просмотра по часам сегодня' : 'Время просмотра по дням'}
              />
            ) : empty(noData)}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            size="small"
            title="Когда смотрят"
            extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{data?.range?.timezone || ''}</Typography.Text>}
            style={{ height: '100%' }}
          >
            {hasData ? <Heatmap grid={heatmap} format={watchTime} bind={bind} /> : empty(noData)}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={chartFrame}>
        <Col xs={24} xl={user ? 24 : 12}>
          <Card
            size="small"
            title={user && filteredUser ? `Что смотрит ${filteredUser.username}` : 'Популярные каналы'}
            extra={user ? null : <Typography.Text type="secondary" style={{ fontSize: 12 }}>нажмите на канал — кто его смотрел</Typography.Text>}
            style={{ height: '100%' }}
          >
            {channelRows.length ? (
              <BarList items={channelRows} format={watchTime} bind={bind} active={channel} />
            ) : empty(noData)}
            {channels.length > TOP_ROWS ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {`Ещё каналов: ${count(channels.length - TOP_ROWS)}`}
              </Typography.Text>
            ) : null}
          </Card>
        </Col>
        {user ? null : (
          <Col xs={24} xl={12}>
            {picked ? (
              <Card
                size="small"
                title={`Кто смотрел «${picked.name}»`}
                extra={<Button size="small" type="text" icon={<CloseOutlined />} onClick={() => pickChannel(null)} aria-label="Закрыть" />}
                style={{ height: '100%' }}
              >
                <BarList items={audienceRows} format={watchTime} bind={bind} />
              </Card>
            ) : (
              <Card size="small" title="Кто что смотрит" style={{ height: '100%' }}>
                {customerRows.length ? (
                  <>
                    <Legend entries={legend} />
                    <BarList items={customerRows} format={watchTime} bind={bind} />
                    {customers.length > TOP_ROWS ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {`Ещё клиентов: ${count(customers.length - TOP_ROWS)}`}
                      </Typography.Text>
                    ) : null}
                  </>
                ) : empty(noData)}
              </Card>
            )}
          </Col>
        )}
      </Row>

      <Card
        size="small"
        title={(
          <Space>
            Последние просмотры
            {live.length ? <Badge count={live.length} color="#16a34a" size="small" title={`Смотрят сейчас: ${live.length}`} /> : null}
          </Space>
        )}
        extra={data ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`история хранится ${data.retention_days} дн.; короче 30 сек. не считаются`}
          </Typography.Text>
        ) : null}
      >
        <ResponsiveTable
          size="small"
          rowKey="id"
          loading={loading && !data}
          columns={recentColumns}
          dataSource={data?.recent || []}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          locale={{ emptyText: empty(noData) }}
          scroll={{ x: 'max-content' }}
        />
      </Card>
    </Space>
  );
}
