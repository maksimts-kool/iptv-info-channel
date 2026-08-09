import { useCallback, useState } from 'react';
import {
  Alert, Button, Card, Col, Row, Space, Statistic, Typography,
} from 'antd';
import { api, AuthError } from '../lib/api.js';
import BrandingCard from '../components/BrandingCard.jsx';
import IncidentsCard from '../components/IncidentsCard.jsx';

// The info channel: the per-customer looping HLS card that lives in the
// Информация category. It is now one feature of the playlist rather than the
// product, so its branding, its status board and the rebuild control sit here.
export default function InfoChannelPage(shared) {
  const { state, message } = shared;
  const [busy, setBusy] = useState(false);

  const rebuildAll = useCallback(async () => {
    setBusy(true);
    message.info('Пересобираем все потоки…');
    try {
      await api.post('/admin/api/regenerate-all');
      message.success('Все потоки пересобраны');
    } catch (e) {
      if (e instanceof AuthError) shared.onAuthError();
      else message.error(e.message);
    } finally {
      setBusy(false);
    }
  }, [message, shared]);

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Инфоканал — это персональный канал каждого клиента в категории «Информация»."
        description="Он показывает тариф, цену, дату окончания и статус аккаунта поверх фоновой музыки. Категорию нельзя выключить: именно она остаётся у клиента, когда подписка заканчивается."
      />

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title="Потоков" value={state?.users?.length ?? 0} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Слайд статуса"
              value={state?.statusSlideEnabled ? 'включён' : 'выключен'}
              valueStyle={{ fontSize: 20 }}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small">
            <Space direction="vertical" size={8}>
              <Typography.Text type="secondary">
                Пересборка нужна, если что-то на карточке выглядит устаревшим.
                Обычно она запускается сама: при правках и ежедневно в 00:05.
              </Typography.Text>
              <Button onClick={rebuildAll} loading={busy}>Пересобрать все потоки</Button>
            </Space>
          </Card>
        </Col>
      </Row>

      <BrandingCard {...shared} />
      <IncidentsCard {...shared} />
    </Space>
  );
}
