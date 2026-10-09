import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Card, Empty, Space, Typography,
} from 'antd';
import {
  ClearOutlined, CloseOutlined, DesktopOutlined, FolderOpenOutlined, ReloadOutlined,
} from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
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

// Shown at the top of Устройства when it is opened from a customer's card
// (#/devices/12): that one customer's devices, whether or not they are
// watching right now, with their limit and the slot reset at hand. (A gateway
// that is off is the page's own banner, right above this card.)
export default function ClientDevicesCard({
  user, api, onAuthError, message, onClose, onOpenClient, onReset,
}) {
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
        <Space wrap>
          <DesktopOutlined />
          {user.username}
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {limit > 0 ? `смотрят ${devices.length - over} из ${limit}` : `смотрят ${devices.length}, без ограничений`}
          </Typography.Text>
        </Space>
      )}
      extra={(
        <Space size={4} wrap>
          {onOpenClient ? (
            <Button size="small" icon={<FolderOpenOutlined />} onClick={onOpenClient}>Карточка</Button>
          ) : null}
          {onReset ? (
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={async () => { await onReset(); load(); }}
            >
              Освободить места
            </Button>
          ) : null}
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="Обновить" />
          {onClose ? <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Закрыть" /> : null}
        </Space>
      )}
      style={{ borderColor: '#91caff' }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {devices.length ? (
          <ResponsiveTable
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
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сейчас этот клиент ничего не смотрит" />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`Устройство считается смотрящим, пока плеер обновляет канал; после закрытия место освобождается через ${data?.idle_seconds ?? 60} сек. Два одинаковых плеера в одной домашней сети считаются одним устройством.`}
        </Typography.Text>
      </Space>
    </Card>
  );
}
