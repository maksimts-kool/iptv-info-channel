import { useState } from 'react';
import {
  Button, Card, Col, Row, Space, Statistic, Tag, Tooltip,
} from 'antd';
import {
  CheckCircleOutlined, DesktopOutlined, PictureOutlined, TeamOutlined, WarningOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';
import ChannelHeader from '../components/ChannelHeader.jsx';
import BrandingCard from '../components/BrandingCard.jsx';
import IncidentsCard from '../components/IncidentsCard.jsx';
import ProviderNewsCard from '../components/ProviderNewsCard.jsx';

export const INFO_CHANNEL_ID = 'info-account';

// The info channel: the per-customer looping HLS card that lives in the
// Информация category. Laid out like Медиаканал — header, numbers, content —
// with its branding, its status board and the rebuild control.
export default function InfoChannelPage(shared) {
  const {
    state, api, message, reload, withRegen, onAuthError,
  } = shared;
  const [busy, setBusy] = useState(false);
  const channel = (state?.builtinChannels || []).find((c) => c.id === INFO_CHANNEL_ID);
  const status = state?.status;
  const users = state?.users || [];
  const locked = users.filter((u) => u.status === 'expired' || u.status === 'disabled').length;
  const openIncidents = status?.activeIncidents?.length || 0;

  // Empty is the default: every customer's channel is named "<brand> — <their
  // name>" in their own playlist. A set name is the same for everyone.
  const brand = state?.settings?.brand_name || 'IPTV';
  const custom = !!channel?.name;
  const rename = async (name) => {
    try {
      await api.patch(`/admin/api/catalog/channels/${INFO_CHANNEL_ID}`, { name });
      message.success(name
        ? 'Название сохранено — клиенты увидят его при следующем обновлении плейлиста'
        : 'Название снова своё у каждого клиента');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  const rebuildAll = async () => {
    setBusy(true);
    await withRegen(
      'Пересборка потоков',
      () => api.post('/admin/api/regenerate-all'),
      { success: 'Все потоки пересобраны', reload: false },
    );
    setBusy(false);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ChannelHeader
        icon={<DesktopOutlined />}
        name={channel?.name || `${brand} — имя клиента`}
        nameNote={custom ? (
          <Tooltip title="Вернуть название по умолчанию: «название сервиса — имя клиента», своё у каждого">
            <Button size="small" type="link" onClick={() => rename('')}>сбросить</Button>
          </Tooltip>
        ) : <Tag>своё у каждого клиента</Tag>}
        onRename={rename}
        description="Персональный канал каждого клиента в категории «Информация»: тариф, цена, дата окончания и статус аккаунта поверх фоновой музыки, плюс слайд состояния сервиса. Его нельзя выключить — именно он остаётся у клиента, когда подписка заканчивается."
        status={<Tag icon={<CheckCircleOutlined />} color="success">в эфире</Tag>}
        toggleLocked="Инфоканал есть у каждого клиента всегда: после окончания подписки он объясняет, что случилось и сколько стоит продление."
        onRebuild={rebuildAll}
        rebuilding={busy}
        rebuildHint="Обычно не нужно: потоки пересобираются сами при правках и ежедневно в 00:05."
      />

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Потоков (по клиенту)" value={users.length} formatter={count} prefix={<TeamOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Видят только «Информацию»"
              value={locked}
              formatter={count}
              prefix={<WarningOutlined />}
              valueStyle={locked ? { color: '#d97706' } : undefined}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Состояние сервиса"
              value={status?.label || '—'}
              valueStyle={{ fontSize: 20, color: status?.color }}
              suffix={openIncidents ? <Tag color="orange" style={{ marginInlineStart: 8 }}>{`инцидентов: ${openIncidents}`}</Tag> : null}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Слайд статуса"
              value={state?.statusSlideEnabled ? 'включён' : 'выключен'}
              prefix={<PictureOutlined />}
              valueStyle={{ fontSize: 20 }}
            />
          </Card>
        </Col>
      </Row>

      <BrandingCard {...shared} />
      <IncidentsCard {...shared} />
      <ProviderNewsCard {...shared} />
    </Space>
  );
}
