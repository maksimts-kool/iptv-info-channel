import { useState } from 'react';
import {
  Badge, Button, Card, Col, Collapse, Progress, Row, Space, Statistic, Switch, Tag, Tooltip,
  Typography,
} from 'antd';
import {
  ArrowRightOutlined, CheckCircleOutlined, DesktopOutlined, InfoCircleOutlined, LinkOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';

// The stream gateway switch. No re-encode is involved (playlists are rendered
// per request), so this saves directly instead of going through the regen
// banner — same rule as the rest of the Плейлист screens.
//
// The screen is for an operator, not a developer: the switch, what it covers
// and who is using it right now. The why/how lives in the collapsed notes.
export default function GatewayCard({
  api, state, reload, message, onAuthError, onOpenDevices,
}) {
  const enabled = !!state?.gateway?.enabled;
  const gateable = state?.catalog?.gateable ?? 0;
  const direct = state?.catalog?.direct ?? 0;
  const total = gateable + direct;
  const percent = total ? Math.round((gateable / total) * 100) : 0;
  const watching = (state?.users || []).reduce((sum, u) => sum + (u.devices_active || 0), 0);
  const [saving, setSaving] = useState(false);

  const toggle = async (checked) => {
    setSaving(true);
    try {
      await api.patch('/admin/api/gateway', { enabled: checked });
      message.success(checked
        ? 'Шлюз включён — клиентам нужно один раз обновить плейлист'
        : 'Шлюз выключен — новые плейлисты снова ведут напрямую к провайдеру');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Row gutter={[24, 16]} align="middle">
          <Col flex="none">
            <SafetyOutlined style={{ fontSize: 36, color: enabled ? '#52c41a' : '#bfbfbf' }} />
          </Col>
          <Col flex="auto">
            <Space direction="vertical" size={2}>
              <Space size={10}>
                <Typography.Text strong style={{ fontSize: 16 }}>Шлюз потоков</Typography.Text>
                <Badge status={enabled ? 'success' : 'default'} text={enabled ? 'Включён' : 'Выключен'} />
              </Space>
              <Typography.Text type="secondary">
                {enabled
                  ? 'Отключённый канал пропадает у клиента за пару секунд — прямо во время просмотра.'
                  : 'Доступ меняется, только когда клиент сам обновит плейлист.'}
              </Typography.Text>
            </Space>
          </Col>
          <Col flex="none">
            <Switch checked={enabled} loading={saving} onChange={toggle} />
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={14}>
          <Card size="small" title="Охват каналов" style={{ height: '100%' }}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Progress
                percent={percent}
                strokeColor={enabled ? '#52c41a' : '#d9d9d9'}
                format={(p) => `${p}%`}
              />
              <Space size={[8, 8]} wrap>
                <Tag icon={<CheckCircleOutlined />} color={enabled ? 'success' : 'default'}>
                  {`${count(gateable)} под шлюзом`}
                </Tag>
                {direct > 0 ? (
                  <Tooltip title="Каналы без .m3u8 (MPEG-TS) шлюз закрыть не может: доступ к ним меняется только после обновления плейлиста.">
                    <Tag icon={<LinkOutlined />} color="warning" style={{ cursor: 'help' }}>
                      {`${count(direct)} напрямую`}
                    </Tag>
                  </Tooltip>
                ) : null}
              </Space>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={10}>
          <Card size="small" title="Сейчас через шлюз" style={{ height: '100%' }}>
            <Row align="middle" justify="space-between" gutter={8}>
              <Col>
                <Statistic
                  value={watching}
                  formatter={count}
                  prefix={<DesktopOutlined />}
                  suffix={<Typography.Text type="secondary" style={{ fontSize: 14 }}>устр.</Typography.Text>}
                />
              </Col>
              <Col>
                <Button type="link" onClick={onOpenDevices}>
                  Устройства
                  {' '}
                  <ArrowRightOutlined />
                </Button>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Collapse
        ghost
        items={[{
          key: 'faq',
          label: <Space><InfoCircleOutlined />Как это работает</Space>,
          children: (
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              <li>После включения клиенту нужно один раз обновить плейлист в плеере.</li>
              <li>Вместо закрытого канала клиент видит свой инфоканал с тарифом и сроком — без ошибки.</li>
              <li>Новые каналы всё равно появляются только после обновления плейлиста.</li>
              <li>Выключение не ломает уже выданные ссылки.</li>
              <li>Видео идёт от провайдера напрямую — нагрузка на сервер минимальная.</li>
            </ul>
          ),
        }]}
      />
    </Space>
  );
}
