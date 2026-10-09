import {
  Alert, Badge, Button, Card, Col, Empty, List, Row, Space, Statistic, Tag, Typography,
} from 'antd';
import {
  ClockCircleOutlined, DesktopOutlined, EuroCircleOutlined, MailOutlined, NotificationOutlined,
  PictureOutlined, PlaySquareOutlined, SafetyOutlined, TeamOutlined,
} from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import { count, seconds as secondsPretty } from '../lib/format.js';
import { euros, periodWord } from '../lib/plans.js';
import { PROVIDER_BLUE } from '../components/ProviderNewsCard.jsx';

// A small "section at a glance" card: a title that opens the section, a few
// lines of state underneath.
function Panel({
  title, icon, onOpen, extra, children,
}) {
  return (
    <Card
      size="small"
      title={<Space>{icon}{title}</Space>}
      extra={extra ?? (onOpen ? <Button size="small" type="link" onClick={onOpen}>Открыть</Button> : null)}
      style={{ height: '100%' }}
    >
      {children}
    </Card>
  );
}

function Line({ label, children }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0',
    }}
    >
      <Typography.Text type="secondary">{label}</Typography.Text>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

// Landing screen: what needs doing today (setup gaps, customers to renew), the
// money and the audience, and one card per part of the service with its
// current state — each a shortcut into its section.
export default function OverviewPage({ state, go }) {
  const users = state?.users || [];
  const plans = state?.plans || [];
  const catalog = state?.catalog || {};
  const status = state?.status;
  const gateway = state?.gateway || {};
  const payments = state?.payments || {};
  const media = state?.media || {};
  const newsletters = state?.newsletters || {};
  const subscribers = state?.subscribers || [];
  const notifyOn = !!state?.notify?.enabled;
  // Mixed into the status by the server; named separately only when one of
  // our own incidents holds the headline.
  const providerActive = status?.state === 'provider' ? [] : (status?.providerNotices || []);

  // A plan with no categories hands its customers an empty playlist (bar
  // Информация) — the single most likely setup mistake, so it leads the page.
  const emptyPlans = plans.filter((p) => !(p.category_ids || []).length);
  const limitedPlans = plans.filter((p) => p.max_devices > 0);

  const counts = users.reduce((acc, u) => {
    acc[u.status] = (acc[u.status] || 0) + 1;
    return acc;
  }, {});

  const attention = users
    .filter((u) => u.status === 'expiring' || u.status === 'expired')
    .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))
    .slice(0, 8);

  const watching = users.reduce((sum, u) => sum + (u.devices_active || 0), 0);
  const watchingClients = users.filter((u) => u.devices_active).length;
  const verified = subscribers.filter((s) => s.verified).length;
  const newsReaders = subscribers.filter((s) => s.verified && s.options?.news).length;

  const mediaTag = (() => {
    if (media.state === 'error') return <Tag color="error">ошибка сборки</Tag>;
    if (media.state === 'building' || media.pending) return <Tag color="processing">собирается</Tag>;
    if (media.ready) return <Tag color="success">в эфире</Tag>;
    return <Tag>{media.total_articles ? 'не в эфире' : 'нет статей'}</Tag>;
  })();
  const mediaChannel = (state?.builtinChannels || []).find((c) => c.id === 'info-media');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!catalog.sources ? (
        <Alert
          type="info"
          showIcon
          message="Плейлист ещё не подключён"
          description="Добавьте источник — ссылку на m3u вашего провайдера — и каналы появятся в каталоге. До этого клиенты получают только категорию «Информация»."
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

      {!gateway.enabled && limitedPlans.length ? (
        <Alert
          type="warning"
          showIcon
          message="Лимит устройств задан, но не действует — шлюз потоков выключен"
          description={`Тарифы с лимитом: ${limitedPlans.map((p) => p.name).join(', ')}. Без шлюза плеер ходит к провайдеру напрямую, и сервер не видит просмотров.`}
          action={<Button onClick={() => go('playlist')}>Включить шлюз</Button>}
        />
      ) : null}

      {media.state === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="Медиаканал не собрался"
          description={media.error}
          action={<Button onClick={() => go('media')}>Открыть</Button>}
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Активных клиентов"
              value={(counts.active || 0) + (counts.expiring || 0)}
              formatter={count}
              prefix={<TeamOutlined />}
              suffix={<Typography.Text type="secondary" style={{ fontSize: 14 }}>{`/ ${count(users.length)}`}</Typography.Text>}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Истекают / истекли"
              value={(counts.expiring || 0) + (counts.expired || 0)}
              formatter={count}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: (counts.expiring || counts.expired) ? '#d97706' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Получено в этом месяце"
              value={euros(payments.month_cents || 0)}
              prefix={<EuroCircleOutlined />}
              suffix={(
                <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                  {`· ${count(payments.month_count || 0)} опл.`}
                </Typography.Text>
              )}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Смотрят сейчас"
              value={gateway.enabled ? watching : '—'}
              formatter={gateway.enabled ? count : undefined}
              prefix={<DesktopOutlined />}
              suffix={gateway.enabled ? (
                <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                  {`устр. · ${count(watchingClients)} кл.`}
                </Typography.Text>
              ) : null}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title="Требуют продления"
            extra={<Button size="small" onClick={() => go('payments')}>Оплаты</Button>}
            style={{ height: '100%' }}
            styles={{ body: { padding: attention.length ? 0 : undefined } }}
          >
            {attention.length ? (
              <ResponsiveTable
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={attention}
                columns={[
                  {
                    title: 'Клиент',
                    key: 'u',
                    render: (_, u) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Link strong onClick={() => go(`clients/${u.id}`)}>{u.username}</Typography.Link>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{u.plan_name}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: 'Срок',
                    key: 'd',
                    render: (_, u) => (
                      <Space direction="vertical" size={0}>
                        <Tag color={u.status_color}>{u.status_label}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {`${u.expires_pretty}${u.days_left === null ? '' : ` · ${u.days_left} дн.`}`}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '',
                    key: 'pay',
                    width: 110,
                    align: 'right',
                    render: (_, u) => <Button size="small" type="primary" ghost onClick={() => go(`payments/${u.id}`)}>Продлить</Button>,
                  },
                ]}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Никто не истекает в ближайшее время" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title="Последние оплаты"
            extra={<Button size="small" onClick={() => go('payments')}>Все</Button>}
            style={{ height: '100%' }}
          >
            {(payments.recent || []).length ? (
              <List
                size="small"
                dataSource={payments.recent}
                renderItem={(p) => (
                  <List.Item style={{ paddingInline: 0 }}>
                    <List.Item.Meta
                      title={p.username}
                      description={`${new Date(p.at).toLocaleDateString('ru-RU')} · ${p.count} ${periodWord(p.period, p.count)} · до ${p.expires_pretty}`}
                    />
                    <Typography.Text strong>{p.amount_cents === null ? '—' : euros(p.amount_cents)}</Typography.Text>
                  </List.Item>
                )}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Оплат пока не записано" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={8}>
          <Panel title="Состояние сервиса" icon={<SafetyOutlined />} onOpen={() => go('info')}>
            {status ? (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text strong style={{ fontSize: 16, color: status.color }}>{status.label}</Typography.Text>
                <Line label="Аптайм за 90 дней">{`${String(status.uptimePct).replace('.', ',')}%`}</Line>
                <Line label="Открытых инцидентов">{count(status.activeIncidents?.length || 0)}</Line>
                {providerActive.length ? (
                  <Typography.Text style={{ color: PROVIDER_BLUE }}>
                    <NotificationOutlined />
                    {` Провайдер: ${providerActive[0].headline}`}
                    {providerActive.length > 1 ? ` (+${providerActive.length - 1})` : ''}
                  </Typography.Text>
                ) : null}
              </Space>
            ) : <Typography.Text type="secondary">Нет данных</Typography.Text>}
          </Panel>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Panel title="Плейлист" icon={<PlaySquareOutlined />} onOpen={() => go('playlist')}>
            <Line label="Источников">{count(catalog.sources)}</Line>
            <Line label="Категорий">{count(catalog.categories)}</Line>
            <Line label="Каналов в эфире">{`${count(catalog.enabled)} / ${count(catalog.channels)}`}</Line>
            <Line label="Шлюз потоков">
              {gateway.enabled
                ? <Badge status="success" text={`включён · ${count(catalog.gateable)} HLS`} />
                : <Badge status="default" text="выключен" />}
            </Line>
          </Panel>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Panel title="Устройства" icon={<DesktopOutlined />} onOpen={() => go('devices')}>
            <Line label="Смотрят сейчас">{gateway.enabled ? `${count(watching)} устр.` : 'не видно без шлюза'}</Line>
            <Line label="Клиентов онлайн">{gateway.enabled ? count(watchingClients) : '—'}</Line>
            <Line label="Тарифов с лимитом">{`${count(limitedPlans.length)} из ${count(plans.length)}`}</Line>
          </Panel>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Panel title={mediaChannel?.name ? `Медиаканал «${mediaChannel.name}»` : 'Медиаканал'} icon={<PictureOutlined />} onOpen={() => go('media')}>
            <Line label="Состояние">{mediaChannel && !mediaChannel.enabled ? <Tag>выключен</Tag> : mediaTag}</Line>
            <Line label="Статей в эфире у всех">{`${count(media.articles || 0)} / ${count(media.total_articles || 0)}`}</Line>
            <Line label="Круг">{secondsPretty(media.seconds || 0)}</Line>
            {media.private_viewers ? (
              <Line label="Своя версия канала">{`${count(media.private_viewers)} кл.`}</Line>
            ) : null}
          </Panel>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Panel title="Уведомления" icon={<MailOutlined />} onOpen={() => go('notify')}>
            <Line label="Почта">{notifyOn ? <Badge status="success" text="включена" /> : <Badge status="default" text="выключена" />}</Line>
            <Line label="Подписчиков (подтверждено)">{`${count(verified)} / ${count(subscribers.length)}`}</Line>
            <Line label="Получают новости">{count(newsReaders)}</Line>
            <Line label="Последняя рассылка">
              {newsletters.last
                ? `${new Date(newsletters.last.sent_at || newsletters.last.created_at).toLocaleDateString('ru-RU')} · ${newsletters.last.sent} писем`
                : '—'}
            </Line>
          </Panel>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Panel title="Тарифы" icon={<EuroCircleOutlined />} onOpen={() => go('plans')}>
            {plans.length ? plans.map((p) => (
              <Line key={p.id} label={p.name}>
                {`${count(users.filter((u) => u.plan_id === p.id).length)} кл. · ${(p.category_ids || []).length} кат.`}
              </Line>
            )) : <Typography.Text type="secondary">Тарифов пока нет</Typography.Text>}
          </Panel>
        </Col>
      </Row>
    </Space>
  );
}
