import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Empty, Space, Table, Typography,
} from 'antd';
import { DesktopOutlined, ReloadOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';

// Who is watching this customer right now, as the stream gateway sees it: every
// device that fetched a gated channel's manifest within the idle window, oldest
// first. The first N (the limit) play; anyone after them is shown the
// "превышен лимит устройств" notice instead of the channel. Polled while open —
// the list is in server memory and changes every few seconds.
const POLL_MS = 10_000;

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} сек. назад`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} мин. назад` : `${Math.round(m / 60)} ч. назад`;
}

// A User-Agent is long and mostly noise; the product token is what an admin
// recognises ("TiviMate", "ExoPlayerLib", "VLC").
function shortAgent(ua) {
  if (!ua) return 'неизвестный плеер';
  const first = ua.split(/[\s(]/)[0];
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

export default function ClientDevicesCard({ user, api, onAuthError, message }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/admin/api/users/${user.id}/devices`));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, user.id, onAuthError, message]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const devices = data?.devices || [];
  const limit = data?.limit ?? user.device_limit ?? 0;
  const over = devices.filter((d) => !d.allowed).length;

  return (
    <Card
      size="small"
      title={(
        <Space>
          <DesktopOutlined />
          Устройства
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {limit > 0 ? `смотрят ${devices.length - over} из ${limit}` : `смотрят ${devices.length}, без ограничений`}
          </Typography.Text>
        </Space>
      )}
      extra={<Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>Обновить</Button>}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {data && !data.gateway_enabled ? (
          <Alert
            type="warning"
            showIcon
            message="Шлюз потоков выключен"
            description="Без шлюза плеер обращается к провайдеру напрямую, поэтому сервер не видит просмотров и лимит устройств не действует. Включите шлюз в разделе «Плейлист» → «Доступ»."
          />
        ) : null}
        {devices.length ? (
          <Table
            size="small"
            pagination={false}
            rowKey={(d) => `${d.ip}|${d.first_seen}`}
            dataSource={devices}
            columns={[
              {
                title: 'Статус',
                width: 130,
                render: (_, d) => (d.allowed
                  ? <Badge status="success" text="смотрит" />
                  : <Badge status="error" text="сверх лимита" />),
              },
              { title: 'Канал', dataIndex: 'channel', ellipsis: true },
              {
                title: 'Устройство',
                render: (_, d) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{shortAgent(d.user_agent)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.ip}</Typography.Text>
                  </Space>
                ),
              },
              { title: 'С начала', width: 120, render: (_, d) => ago(d.first_seen) },
            ]}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сейчас никто не смотрит" />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`Устройство считается смотрящим, пока плеер обновляет канал; после закрытия место освобождается через ${data?.idle_seconds ?? 60} сек. Два одинаковых плеера в одной домашней сети считаются одним устройством.`}
        </Typography.Text>
      </Space>
    </Card>
  );
}
