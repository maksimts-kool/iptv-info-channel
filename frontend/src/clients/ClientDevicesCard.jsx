import { useState } from 'react';
import {
  Button, Card, Empty, Space, Typography,
} from 'antd';
import {
  ClearOutlined, CloseOutlined, DesktopOutlined, FolderOpenOutlined, ReloadOutlined,
} from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import Hint from '../components/Hint.jsx';
import PlayerName from '../components/PlayerName.jsx';
import DeviceStatus from '../components/DeviceStatus.jsx';
import { plainIp } from '../lib/format.js';

// Who is watching this customer right now, as the stream gateway sees it: every
// device that played a gated channel or one of the built-in loops within the
// idle window, oldest first. The first N gated devices (the limit) play;
// anyone after them is shown the "превышен лимит устройств" notice instead of
// the channel. The rows are the Устройства screen's own list (`watching`,
// the shared device poll), so the two never disagree.

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} сек. назад`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} мин. назад` : `${Math.round(m / 60)} ч. назад`;
}

// Shown at the top of Устройства when it is opened from a customer's card
// (#/devices/12): that one customer's devices, whether or not they are
// watching right now, with their limit and the slot reset at hand. (A gateway
// that is off is the page's own banner, right above this card.)
export default function ClientDevicesCard({
  user, watching, onRefresh, onClose, onOpenClient, onReset,
}) {
  const { devices, watching: playing, used } = watching.of(user.id);
  const limit = user.device_limit ?? 0;
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      await onRefresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      size="small"
      title={(
        <Space wrap>
          <DesktopOutlined />
          {user.username}
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {limit > 0
              ? `занято ${used} из ${limit}${playing > used ? ` · ещё ${playing - used} на своём канале` : ''}`
              : `смотрят ${playing}, без ограничений`}
          </Typography.Text>
          <Hint text={`Устройство считается смотрящим, пока плеер обновляет канал; после закрытия место освобождается через ${watching.idleSeconds} сек. Два одинаковых плеера в одной домашней сети считаются одним устройством.`} />
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
              onClick={onReset}
            >
              Освободить места
            </Button>
          ) : null}
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={refresh} aria-label="Обновить" />
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
              { title: 'Статус', width: 130, render: (_, d) => <DeviceStatus device={d} limited={limit > 0} /> },
              { title: 'Канал', dataIndex: 'channel', ellipsis: true },
              {
                title: 'Устройство',
                render: (_, d) => (
                  <Space direction="vertical" size={0}>
                    <PlayerName name={d.player} userAgent={d.user_agent} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{plainIp(d.ip)}</Typography.Text>
                  </Space>
                ),
              },
              { title: 'С начала', width: 120, render: (_, d) => ago(d.first_seen) },
            ]}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сейчас этот клиент ничего не смотрит" />
        )}
      </Space>
    </Card>
  );
}
