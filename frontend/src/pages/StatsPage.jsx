import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Alert, Button, Card, Col, Empty, Row, Segmented, Select, Space, Statistic, Tag, Tooltip, Typography,
} from 'antd';
import {
  ClockCircleOutlined, CloseOutlined, DesktopOutlined, FieldTimeOutlined, PlaySquareOutlined, ReloadOutlined,
  RiseOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import { AuthError } from '../lib/api.js';
import { count, plainIp, watchTime } from '../lib/format.js';
import PlayerName from '../components/PlayerName.jsx';
import { useWatching } from '../lib/watching.jsx';
import {
  BarList, ColumnChart, Heatmap, Legend, OTHER, SERIES, TipBody, useTooltip,
} from '../stats/charts.jsx';

// Viewing statistics: how long each channel is watched and by whom, and when.
// Built from the history the stream gateway records (gated HLS channels and
// the built-in loops), plus whatever is playing right now. #/stats/12 opens
// it filtered to one customer (the link on the customer's card).
//
// "Смотрят сейчас" is the shared device poll (lib/watching), the same list as
// Устройства; whenever it changes the numbers here are reloaded quietly, and
// once a minute anyway so running watches keep growing.

const PERIODS = [
  { value: 1, label: 'Сегодня' },
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
];
const TOP_ROWS = 12;
const REFRESH_MS = 60_000;
// "Когда смотрят" by period length (in days); see `heat` below.
const WEEK_DAYS = 7;
// Dates across: at most this many columns, so 90 days is as wide as 30.
const MAX_COLUMNS = 31;
// A week: each date split into parts of this many hours, a row per hour.
const WEEK_PART_HOURS = 8;
const BLOCK_HOURS = 3;
const BLOCKS = Array.from({ length: 24 / BLOCK_HOURS }, (_, i) => i * BLOCK_HOURS);
const hh = (h) => String(h % 24).padStart(2, '0');
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
  const live = useWatching();

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

  // `quiet`: a background refresh, no dimming and no error toast.
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (user) qs.set('user', String(user));
      setData(await api.get(`/admin/api/stats?${qs}`));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else if (!quiet) message.error(e.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api, days, user, onAuthError, message]);

  useEffect(() => { load(); }, [load]);

  // Someone started, stopped or switched: reload with the device list.
  const liveKey = live.devices
    .filter((d) => d.allowed)
    .map((d) => `${d.ip}|${d.player}|${d.channel}`)
    .sort()
    .join('\n');
  const seenKey = useRef(liveKey);
  useEffect(() => {
    if (seenKey.current === liveKey) return;
    seenKey.current = liveKey;
    load({ quiet: true });
  }, [liveKey, load]);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const users = state?.users || [];
  const userOptions = useMemo(() => users
    .map((u) => ({ value: u.id, label: u.username }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru')), [users]);

  const totals = data?.totals;
  const watchingNow = user ? live.of(user).watching : live.watching;
  const channels = data?.channels || [];
  const customers = data?.customers || [];
  const daily = data?.daily || [];
  const hasData = !!totals && totals.sessions > 0;
  const today = days === 1;

  // Today: one column per hour, which is all "Когда смотрят" has to say for
  // one day. Longer: one column per day, and the hours in the heatmap.
  const columns = useMemo(() => {
    if (today && daily.length) {
      return daily[0].hours.map((v, h) => ({
        key: `h${h}`,
        label: hh(h),
        value: v,
        tip: <TipBody title={`${hh(h)}:00–${hh(h + 1)}:00`} rows={[{ label: 'просмотра', value: watchTime(v) }]} />,
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
  }, [today, daily]);

  // The dates across, in square cells about as tall as each other:
  // - a week: three columns per date (from 00, 08 and 16) and a row per
  //   hour into them, so every cell is one hour;
  // - longer: a column per date and a row per three hours. Past a month a
  //   column holds several days (3 for 90), counted back from today so the
  //   last column ends now.
  const heat = useMemo(() => {
    if (daily.length <= WEEK_DAYS) {
      const parts = Array.from({ length: 24 / WEEK_PART_HOURS }, (_, i) => i * WEEK_PART_HOURS);
      const columns = daily.flatMap((d) => parts.map((p) => ({
        key: `${d.date}|${p}`,
        // The date over its first column runs on over the other two.
        label: p === 0 ? dayLabel(d.date, false) : '',
        sub: hh(p),
        day: d,
        start: p,
      })));
      return {
        columns,
        rows: Array.from({ length: WEEK_PART_HOURS }, (_, r) => ({
          key: r,
          label: `+${r} ч`,
          values: columns.map((c) => c.day.hours[c.start + r]),
          titles: columns.map((c) => `${LONG_DAY.format(dateOf(c.day.date))}, ${hh(c.start + r)}:00–${hh(c.start + r + 1)}:00`),
        })),
      };
    }
    const size = Math.ceil(daily.length / MAX_COLUMNS);
    const groups = [];
    for (let end = daily.length; end > 0; end -= size) groups.unshift(daily.slice(Math.max(0, end - size), end));
    const marks = (g) => (size === 1
      // A day per column: Mondays mark the weeks.
      ? g.find((d) => dateOf(d.date).getUTCDay() === 1)
      // Several: the 1st and the 15th mark the months.
      : g.find((d) => [1, 15].includes(dateOf(d.date).getUTCDate())));
    return {
      columns: groups.map((g) => {
        const first = g[0].date;
        const last = g[g.length - 1].date;
        const mark = marks(g);
        return {
          key: first,
          label: mark ? dayLabel(mark.date, true) : '',
          title: first === last
            ? LONG_DAY.format(dateOf(first))
            : `${dayLabel(first, true)} – ${dayLabel(last, true)}`,
        };
      }),
      rows: BLOCKS.map((b) => ({
        key: b,
        label: `${hh(b)}–${hh(b + BLOCK_HOURS)}`,
        title: `${hh(b)}:00–${hh(b + BLOCK_HOURS)}:00`,
        values: groups.map((g) => g.reduce(
          (sum, d) => sum + d.hours.slice(b, b + BLOCK_HOURS).reduce((a, v) => a + v, 0),
          0,
        )),
      })),
    };
  }, [daily]);

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
    {
      title: 'Плеер',
      dataIndex: 'player',
      render: (v, r) => <PlayerName name={v} userAgent={r.user_agent} />,
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      render: (v) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{plainIp(v) || '—'}</Typography.Text>,
    },
  ];

  const filteredUser = data?.user || users.find((u) => u.id === user);
  const peakHint = totals?.peak_at ? `в ${when(totals.peak_at)}` : null;
  const chartFrame = { opacity: loading && data ? 0.55 : 1, transition: 'opacity .2s' };

  const empty = (text) => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
  const noData = 'Нет просмотров за этот период';

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
        <Col flex="1 1 150px">
          <Tile title="Время просмотра" value={totals ? watchTime(totals.seconds) : '—'} icon={<FieldTimeOutlined />} />
        </Col>
        <Col flex="1 1 150px">
          {user ? (
            <Tile title="Последний просмотр" value={customers[0] ? when(customers[0].last_seen) : '—'} icon={<ClockCircleOutlined />} />
          ) : (
            <Tile title="Зрителей" value={totals ? count(totals.viewers) : '—'} icon={<TeamOutlined />} suffix={users.length ? `/ ${count(users.length)}` : null} />
          )}
        </Col>
        <Col flex="1 1 150px">
          <Tile title="Просмотров" value={totals ? count(totals.sessions) : '—'} icon={<PlaySquareOutlined />} />
        </Col>
        <Col flex="1 1 150px">
          <Tile title="Пик одновременно" value={totals ? count(totals.peak) : '—'} icon={<RiseOutlined />} hint={peakHint} />
        </Col>
        <Col flex="1 1 150px">
          <Tile
            title="Смотрят сейчас"
            value={live.ready ? count(watchingNow) : '—'}
            icon={<DesktopOutlined />}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={chartFrame}>
        <Col xs={24} xl={today ? 24 : 14}>
          <Card
            size="small"
            title={today ? 'Когда смотрят сегодня' : 'Время просмотра по дням'}
            extra={today ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{data?.range?.timezone || ''}</Typography.Text> : null}
            className="card-fill"
            style={{ height: '100%' }}
          >
            {hasData ? (
              <ColumnChart
                items={columns}
                format={watchTime}
                bind={bind}
                ariaLabel={today ? 'Время просмотра по часам сегодня' : 'Время просмотра по дням'}
              />
            ) : empty(noData)}
          </Card>
        </Col>
        {today ? null : (
          <Col xs={24} xl={10}>
            <Card
              size="small"
              title="Когда смотрят"
              extra={(
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {data?.range?.timezone || ''}
                </Typography.Text>
              )}
              style={{ height: '100%' }}
            >
              {hasData ? (
                <Heatmap
                  rows={heat.rows}
                  columns={heat.columns}
                  format={watchTime}
                  bind={bind}
                  ariaLabel="Время просмотра по дням и часам"
                />
              ) : empty(noData)}
            </Card>
          </Col>
        )}
      </Row>

      <Row gutter={[16, 16]} style={chartFrame}>
        <Col xs={24} xl={user ? 24 : 12}>
          <Card
            size="small"
            title={user ? 'Каналы' : 'Популярные каналы'}
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
        title="Последние просмотры"
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
