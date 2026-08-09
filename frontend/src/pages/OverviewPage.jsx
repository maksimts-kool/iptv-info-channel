import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { count } from '../lib/format.js';

// Landing screen: the numbers that answer "is anything wrong right now?" and
// shortcuts into the two sections that matter day to day.
export default function OverviewPage({ state, go }) {
  const users = state?.users || [];
  const plans = state?.plans || [];
  const catalog = state?.catalog || {};
  const status = state?.status;

  // A plan with no categories hands its customers an empty playlist (bar
  // Информация) — the single most likely setup mistake, so it leads the page.
  const emptyPlans = plans.filter((p) => !(p.category_ids || []).length);

  const counts = users.reduce((acc, u) => {
    acc[u.status] = (acc[u.status] || 0) + 1;
    return acc;
  }, {});

  const attention = users
    .filter((u) => u.status === 'expiring' || u.status === 'expired')
    .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))
    .slice(0, 8);

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      {!catalog.sources ? (
        <Alert
          type="info"
          showIcon
          message="Плейлист ещё не подключён"
          description="Добавьте источник — ссылку на m3u вашего провайдера — и каналы появятся в каталоге. До этого клиенты получают только канал «Информация»."
          action={<Button type="primary" onClick={() => go('playlist')}>К плейлисту</Button>}
        />
      ) : null}

      {catalog.sources && emptyPlans.length ? (
        <Alert
          type="warning"
          showIcon
          message={`В тарифе не выбраны категории: ${emptyPlans.map((p) => p.name).join(', ')}`}
          description="Клиенты на этих тарифах получают только «Информация». Откройте тариф и отметьте, какие категории каналов в него входят."
          action={<Button type="primary" onClick={() => go('plans')}>К тарифам</Button>}
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Клиентов" value={users.length} formatter={count} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Активных"
              value={counts.active || 0}
              formatter={count}
              valueStyle={{ color: '#16a34a' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Истекают / истекли"
              value={(counts.expiring || 0) + (counts.expired || 0)}
              formatter={count}
              valueStyle={{ color: (counts.expiring || counts.expired) ? '#d97706' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            {/* Both halves go through the same formatter — AntD groups `value`
                but not `suffix`, which is how "1,308 / 1310" happened. */}
            <Statistic
              title="Каналов в эфире"
              value={catalog.enabled ?? 0}
              formatter={count}
              suffix={`/ ${count(catalog.channels)}`}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title="Требуют внимания"
            extra={<Button size="small" onClick={() => go('clients')}>Все клиенты</Button>}
          >
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={attention}
              locale={{ emptyText: 'Никто не истекает в ближайшее время.' }}
              columns={[
                { title: 'Клиент', dataIndex: 'username', render: (v) => <strong>{v}</strong> },
                { title: 'Тариф', dataIndex: 'plan_name' },
                { title: 'Истекает', dataIndex: 'expires_pretty' },
                {
                  title: 'Осталось',
                  dataIndex: 'days_left',
                  render: (v) => (v === null ? '—' : `${v} дн.`),
                },
                {
                  title: 'Статус',
                  key: 'status',
                  render: (_, u) => <Tag color={u.status_color}>{u.status_label}</Tag>,
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card title="Каталог" extra={<Button size="small" onClick={() => go('playlist')}>Открыть</Button>}>
              <Row gutter={16}>
                <Col span={8}><Statistic title="Источников" value={catalog.sources ?? 0} formatter={count} /></Col>
                <Col span={8}><Statistic title="Категорий" value={catalog.categories ?? 0} formatter={count} /></Col>
                <Col span={8}><Statistic title="Каналов" value={catalog.channels ?? 0} formatter={count} /></Col>
              </Row>
            </Card>
            <Card title="Состояние сервиса" extra={<Button size="small" onClick={() => go('info')}>Инциденты</Button>}>
              {status ? (
                <Space direction="vertical" size={4}>
                  <Typography.Text strong style={{ fontSize: 16, color: status.color }}>
                    {status.label}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {`Аптайм за 90 дней: ${String(status.uptimePct).replace('.', ',')}%`}
                    {status.activeIncidents?.length
                      ? ` · открытых инцидентов: ${status.activeIncidents.length}`
                      : ''}
                  </Typography.Text>
                </Space>
              ) : <Typography.Text type="secondary">Нет данных</Typography.Text>}
            </Card>
          </Space>
        </Col>
      </Row>
    </Space>
  );
}
