import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Col, Empty, InputNumber, Popconfirm, Progress, Row, Space,
  Statistic, Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  ClearOutlined, DesktopOutlined, ReloadOutlined, TeamOutlined, UserOutlined, WarningOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';

// Live "who is watching" across every customer, plus the limits that decide it.
// The data is the stream gateway's in-memory tracker, so it is polled rather
// than loaded once; the admin can pause the polling to read a row in peace.
const POLL_MS = 5_000;

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} сек.`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} мин.` : `${Math.floor(m / 60)} ч. ${m % 60} мин.`;
}

// The product token of a User-Agent ("TiviMate", "ExoPlayerLib", "VLC").
function shortAgent(ua) {
  if (!ua) return 'неизвестный плеер';
  const first = ua.split(/[\s(]/)[0];
  return first.length > 32 ? `${first.slice(0, 32)}…` : first;
}

const openClient = (id) => { window.location.hash = `#/clients/${id}`; };

export default function DevicesPage({
  api, state, reload, withRegen, message, onAuthError,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [enabling, setEnabling] = useState(false);

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/admin/api/devices'));
      setUpdatedAt(new Date());
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [api, fail]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [auto, load]);

  const enableGateway = async () => {
    setEnabling(true);
    try {
      await api.patch('/admin/api/gateway', { enabled: true });
      message.success('Шлюз включён — клиентам нужно один раз обновить плейлист');
      await reload();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setEnabling(false);
    }
  };

  const resetSlots = async (client) => {
    try {
      await api.post(`/admin/api/users/${client.user_id}/devices/reset`, {});
      message.success(`Места клиента ${client.username} освобождены`);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const savePlanLimit = (plan, value) => {
    const next = Number(value) || 0;
    if (next === (plan.max_devices || 0)) return;
    withRegen(
      'Сохранение тарифа',
      () => api.patch(`/admin/api/plans/${plan.id}`, { max_devices: next }),
      { success: `${plan.name}: ${next ? `до ${next} устр.` : 'без лимита'}` },
    );
  };

  const gatewayOn = data ? data.gateway_enabled : !!state?.gateway?.enabled;
  const idle = data?.idle_seconds ?? state?.gateway?.device_idle_seconds ?? 60;
  const clients = data?.clients || [];
  const devices = clients.flatMap((c) => c.devices);
  const over = devices.filter((d) => !d.allowed).length;
  const plans = state?.plans || [];
  const users = state?.users || [];
  const personal = users.filter((u) => u.max_devices !== null && u.max_devices !== undefined);

  const deviceColumns = [
    {
      title: 'Статус',
      width: 140,
      render: (_, d) => (d.allowed
        ? <Badge status="processing" color="green" text="смотрит" />
        : <Badge status="error" text="сверх лимита" />),
    },
    { title: 'Канал', dataIndex: 'channel', ellipsis: true },
    {
      title: 'Плеер',
      render: (_, d) => (
        <Tooltip title={d.user_agent || 'User-Agent не передан'}>
          <Typography.Text>{shortAgent(d.user_agent)}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 150,
      render: (ip) => <Typography.Text type="secondary" copyable={{ text: ip }}>{ip}</Typography.Text>,
    },
    { title: 'Смотрит', width: 120, render: (_, d) => ago(d.first_seen) },
  ];

  const clientColumns = [
    {
      title: 'Клиент',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Link onClick={() => openClient(c.user_id)}>{c.username}</Typography.Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.plan_name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Устройства',
      width: 280,
      render: (_, c) => {
        const watching = c.devices.length;
        const blocked = c.devices.filter((d) => !d.allowed).length;
        if (!c.limit) {
          return <Typography.Text>{`${watching} · без лимита`}</Typography.Text>;
        }
        const used = watching - blocked;
        return (
          <Space size={8} style={{ whiteSpace: 'nowrap' }}>
            <Progress
              steps={Math.min(c.limit, 10)}
              percent={Math.min(100, (used / c.limit) * 100)}
              showInfo={false}
              strokeColor={used >= c.limit ? '#fa8c16' : '#52c41a'}
              size={[14, 10]}
            />
            <Typography.Text>{`${used} из ${c.limit}`}</Typography.Text>
            {blocked ? (
              <Tooltip title="Устройства, которым отказано: вместо канала они видят экран «Превышен лимит устройств»">
                <Tag color="red" icon={<WarningOutlined />}>{`+${blocked} не пущено`}</Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Каналы',
      ellipsis: true,
      render: (_, c) => [...new Set(c.devices.map((d) => d.channel).filter(Boolean))].join(', ') || '—',
    },
    {
      title: '',
      width: 60,
      align: 'right',
      render: (_, c) => (
        <Popconfirm
          title="Освободить места?"
          description="Устаревшие устройства пропадут сразу; кто действительно смотрит — вернётся через пару секунд."
          okText="Освободить"
          cancelText="Отмена"
          onConfirm={() => resetSlots(c)}
        >
          <Tooltip title="Освободить места">
            <Button size="small" type="text" icon={<ClearOutlined />} aria-label="Освободить места" />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!gatewayOn ? (
        <Alert
          type="warning"
          showIcon
          message="Шлюз потоков выключен — лимит устройств не действует и просмотры не видны"
          action={(
            <Button type="primary" size="small" loading={enabling} onClick={enableGateway}>
              Включить шлюз
            </Button>
          )}
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Смотрят сейчас"
              value={devices.length - over}
              formatter={count}
              prefix={<DesktopOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Клиентов онлайн"
              value={clients.length}
              formatter={count}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Упёрлись в лимит"
              value={over}
              formatter={count}
              prefix={<WarningOutlined />}
              valueStyle={over ? { color: '#cf1322' } : undefined}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Место освобождается через" value={idle} suffix="сек." />
          </Card>
        </Col>
      </Row>

      <Card
        title={(
          <Space>
            <Badge status={auto && gatewayOn ? 'processing' : 'default'} />
            Сейчас смотрят
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
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} />
          </Space>
        )}
        styles={{ body: { padding: clients.length ? 0 : undefined } }}
      >
        {clients.length ? (
          <Table
            size="middle"
            rowKey="user_id"
            pagination={clients.length > 20 ? { pageSize: 20 } : false}
            dataSource={clients}
            columns={clientColumns}
            rowClassName={(c) => (c.devices.some((d) => !d.allowed) ? 'row-over-limit' : '')}
            expandable={{
              expandedRowRender: (c) => (
                <Table
                  size="small"
                  pagination={false}
                  rowKey={(d) => `${d.ip}|${d.first_seen}`}
                  dataSource={c.devices}
                  columns={deviceColumns}
                />
              ),
            }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={gatewayOn ? 'Сейчас никто не смотрит' : 'Без шлюза просмотры не видны'}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="Лимит по тарифам" size="small" style={{ height: '100%' }}>
            {plans.length ? (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {plans.map((p) => (
                  <Row key={p.id} align="middle" gutter={12} wrap={false}>
                    <Col flex="auto" style={{ minWidth: 0 }}>
                      <Typography.Text ellipsis>{p.name}</Typography.Text>
                    </Col>
                    <Col>
                      <InputNumber
                        key={`${p.id}:${p.max_devices}`}
                        min={0}
                        max={100}
                        precision={0}
                        defaultValue={p.max_devices || 0}
                        addonAfter="устр."
                        style={{ width: 130 }}
                        onBlur={(e) => savePlanLimit(p, e.target.value)}
                        onPressEnter={(e) => savePlanLimit(p, e.target.value)}
                      />
                    </Col>
                    <Col style={{ width: 110 }}>
                      {p.max_devices > 0
                        ? <Tag color="blue">ограничен</Tag>
                        : <Tag>без лимита</Tag>}
                    </Col>
                  </Row>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  0 — без ограничений. Сохраняется по Enter или при уходе с поля.
                </Typography.Text>
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Тарифов пока нет" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="Личный лимит" size="small" style={{ height: '100%' }}>
            {personal.length ? (
              <Space size={[8, 8]} wrap>
                {personal.map((u) => (
                  <Tag
                    key={u.id}
                    icon={<UserOutlined />}
                    style={{ cursor: 'pointer' }}
                    onClick={() => openClient(u.id)}
                  >
                    {`${u.username}: ${u.max_devices ? u.max_devices : '∞'}`}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                Ни у кого нет. Задаётся в карточке клиента и заменяет лимит тарифа.
              </Typography.Text>
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
