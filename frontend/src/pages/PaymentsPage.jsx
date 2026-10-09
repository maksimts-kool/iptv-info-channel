import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Empty, Form, Input, InputNumber, Popconfirm, Row, Select, Space,
  Statistic, Tag, Tooltip, Typography,
} from 'antd';
import {
  CalendarOutlined, ClockCircleOutlined, EuroCircleOutlined, RollbackOutlined, WalletOutlined,
} from '@ant-design/icons';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';
import {
  PERIOD_UNITS, euros, periodSuffix, periodWord, suggestedPaymentCents,
} from '../lib/plans.js';

// #/payments/12 opens the page with that customer already picked (the link
// from the customer's card).
function clientIdFromHash() {
  const m = window.location.hash.match(/^#\/?payments\/(\d+)/);
  return m ? Number(m[1]) : null;
}

const openClient = (id) => { window.location.hash = `#/clients/${id}`; };

function when(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

// Every payment for every customer in one place: record one (the server works
// out the new expiry date from the plan period and stacks it on what is left),
// see who is about to lapse, and read the ledger — with an undo for a payment
// entered by mistake.
export default function PaymentsPage({
  api, state, reloadToken, withRegen, message, onAuthError,
}) {
  const users = state?.users || [];
  const plans = state?.plans || [];
  const [data, setData] = useState(null);
  const [clientId, setClientId] = useState(clientIdFromHash);
  const [filter, setFilter] = useState(null);
  const [form] = Form.useForm();
  const paidCount = Form.useWatch('count', form) || 1;
  const period = Form.useWatch('period', form) || 'month';

  const user = users.find((u) => u.id === clientId) || null;
  const plan = plans.find((p) => p.id === user?.plan_id) || null;
  const suggested = suggestedPaymentCents(plan, { count: paidCount, period });

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/api/payments'));
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);

  useEffect(() => { load(); }, [load, reloadToken]);

  useEffect(() => {
    const onHash = () => { const id = clientIdFromHash(); if (id) setClientId(id); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // A new customer picked: default to one of whatever their plan is billed in.
  useEffect(() => {
    form.setFieldsValue({
      count: 1,
      period: ['month', 'year', 'day'].includes(plan?.billing_period) ? plan.billing_period : 'month',
      amount: null,
      note: '',
    });
  }, [clientId, plan, form]);

  const pick = (id) => {
    setClientId(id);
    window.history.replaceState(null, '', id ? `#/payments/${id}` : '#/payments');
  };

  const record = async (from) => {
    if (!user) { message.error('Выберите клиента'); return; }
    const v = await form.validateFields();
    await withRegen(`Оплата «${user.username}»`, async () => {
      const res = await api.post(`/admin/api/users/${user.id}/payment`, {
        count: v.count,
        period: v.period,
        from,
        amount_eur: v.amount ?? '',
        note: v.note || '',
      });
      message.success(`${res.user.username}: подписка продлена до ${res.user.expires_pretty}`);
      form.setFieldsValue({ amount: null, note: '' });
      await load();
    });
  };

  const undo = (p) => withRegen(`Отмена оплаты «${p.username}»`, async () => {
    await api.del(`/admin/api/payments/${p.id}`);
    message.success('Оплата отменена, дата окончания возвращена');
    await load();
  });

  const payments = data?.payments || [];
  const summary = data?.summary || state?.payments || {};

  // Only a customer's latest payment can be undone, and only while their
  // expiry is still the date it set (the server enforces the same rule).
  const undoable = useMemo(() => {
    const latest = new Map();
    for (const p of payments) if (!latest.has(p.user_id)) latest.set(p.user_id, p);
    const ok = new Set();
    for (const [userId, p] of latest) {
      const u = users.find((x) => x.id === userId);
      if (u && u.expires_at === p.expires_at) ok.add(p.id);
    }
    return ok;
  }, [payments, users]);

  const due = users
    .filter((u) => u.status === 'expiring' || u.status === 'expired')
    .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0));

  const shown = filter ? payments.filter((p) => p.user_id === filter) : payments;
  const clientOptions = users.map((u) => ({ value: u.id, label: u.username }));

  const columns = [
    { title: 'Когда', key: 'at', width: 150, render: (_, p) => when(p.at) },
    {
      title: 'Клиент',
      key: 'client',
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          {users.some((u) => u.id === p.user_id)
            ? <Typography.Link onClick={() => openClient(p.user_id)}>{p.username}</Typography.Link>
            : <Typography.Text>{`${p.username} (удалён)`}</Typography.Text>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.plan_name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Оплачено',
      key: 'paid',
      width: 130,
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          <span>{`${p.count} ${periodWord(p.period, p.count)}`}</span>
          {p.from === 'today' ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>с сегодняшнего дня</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: 'Сумма',
      key: 'amount',
      width: 100,
      align: 'right',
      render: (_, p) => (p.amount_cents === null ? <Typography.Text type="secondary">—</Typography.Text> : euros(p.amount_cents)),
    },
    {
      title: 'Действует до',
      key: 'expiry',
      width: 190,
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          <span>{p.expires_pretty}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {p.previous_expires_at ? `было: ${new Date(p.previous_expires_at).toLocaleDateString('ru-RU')}` : 'было: без срока'}
          </Typography.Text>
        </Space>
      ),
    },
    { title: 'Примечание', dataIndex: 'note', key: 'note', ellipsis: true, render: (v) => v || '—' },
    {
      title: '',
      key: 'undo',
      width: 56,
      align: 'right',
      render: (_, p) => (undoable.has(p.id) ? (
        <Popconfirm
          title="Отменить эту оплату?"
          description="Запись пропадёт, а дата окончания вернётся к прежней."
          okText="Отменить оплату"
          okButtonProps={{ danger: true }}
          cancelText="Нет"
          onConfirm={() => undo(p)}
        >
          <Tooltip title="Отменить (ошибочная запись)">
            <Button size="small" type="text" danger icon={<RollbackOutlined />} aria-label="Отменить оплату" />
          </Tooltip>
        </Popconfirm>
      ) : null),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Получено в этом месяце" value={euros(summary.month_cents || 0)} prefix={<EuroCircleOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Оплат в этом месяце" value={summary.month_count || 0} formatter={count} prefix={<WalletOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="За 30 дней" value={euros(summary.last30_cents || 0)} prefix={<CalendarOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Ждут продления"
              value={due.length}
              formatter={count}
              prefix={<ClockCircleOutlined />}
              valueStyle={due.length ? { color: '#d97706' } : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          <Card title={<Space><WalletOutlined />Записать оплату</Space>} size="small" style={{ height: '100%' }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Select
                showSearch
                allowClear
                placeholder="Клиент"
                value={clientId}
                onChange={(id) => pick(id ?? null)}
                options={clientOptions}
                optionFilterProp="label"
                style={{ width: '100%' }}
              />
              {user ? (
                <Space wrap size={[8, 4]}>
                  <Tag color={user.status_color}>{user.status_label}</Tag>
                  <Typography.Text type="secondary">
                    {`${user.plan_name} · ${user.price}${periodSuffix(user.billing_period)} · ${
                      user.expires_at ? `действует до ${user.expires_pretty}` : 'срок не ограничен'}`}
                  </Typography.Text>
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  Выберите клиента — или нажмите «Выбрать» в списке «Ждут продления».
                </Typography.Text>
              )}
              <Form form={form} layout="inline" style={{ rowGap: 8 }} disabled={!user}>
                <Form.Item name="count" label="Заплатили за" rules={[{ required: true }]}>
                  <InputNumber min={1} max={120} precision={0} style={{ width: 80 }} />
                </Form.Item>
                <Form.Item name="period" rules={[{ required: true }]}>
                  <Select options={PERIOD_UNITS} style={{ width: 90 }} />
                </Form.Item>
                <Form.Item name="amount" label="Сумма">
                  <InputNumber
                    min={0}
                    step={1}
                    precision={2}
                    decimalSeparator=","
                    addonAfter="€"
                    placeholder={suggested === null ? '—' : String(suggested / 100).replace('.', ',')}
                    style={{ width: 140 }}
                  />
                </Form.Item>
                <Form.Item name="note" style={{ flex: '1 1 200px' }}>
                  <Input placeholder="Примечание (наличными, перевод…)" maxLength={200} />
                </Form.Item>
              </Form>
              <Space wrap>
                <Button type="primary" icon={<WalletOutlined />} disabled={!user} onClick={() => record('expiry')}>
                  Продлить
                </Button>
                <Popconfirm
                  title="Отсчитать срок от сегодняшнего дня?"
                  description="Остаток текущей подписки при этом сгорает."
                  okText="Отсчитать от сегодня"
                  cancelText="Отмена"
                  disabled={!user}
                  onConfirm={() => record('today')}
                >
                  <Button disabled={!user}>С сегодняшнего дня</Button>
                </Popconfirm>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Дата окончания считается сама по периоду тарифа. Оплаченное время прибавляется к
                текущей дате, поэтому досрочное продление не съедает остаток; просроченная подписка
                продлевается от сегодняшнего дня. Пустая сумма — цена тарифа за этот срок.
                Клиенту уходит письмо о продлении.
              </Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={11}>
          <Card title="Ждут продления" size="small" style={{ height: '100%' }} styles={{ body: { padding: due.length ? 0 : undefined } }}>
            {due.length ? (
              <ResponsiveTable
                size="small"
                rowKey="id"
                pagination={due.length > 8 ? { pageSize: 8, size: 'small' } : false}
                dataSource={due}
                columns={[
                  {
                    title: 'Клиент',
                    key: 'u',
                    render: (_, u) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>{u.username}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{u.plan_name}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: 'Срок',
                    key: 'd',
                    width: 130,
                    render: (_, u) => (
                      <Space direction="vertical" size={0}>
                        <Tag color={u.status_color}>{u.status_label}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{u.expires_pretty}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '',
                    key: 'a',
                    width: 90,
                    align: 'right',
                    render: (_, u) => (
                      <Button size="small" type={u.id === clientId ? 'primary' : 'default'} onClick={() => pick(u.id)}>
                        Выбрать
                      </Button>
                    ),
                  },
                ]}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Никто не истекает в ближайшие дни" />
            )}
          </Card>
        </Col>
      </Row>

      <Card
        title="История оплат"
        extra={(
          <Select
            allowClear
            showSearch
            size="small"
            placeholder="Все клиенты"
            value={filter}
            onChange={(v) => setFilter(v ?? null)}
            options={clientOptions}
            optionFilterProp="label"
            style={{ width: 200 }}
          />
        )}
        styles={{ body: { padding: shown.length ? 0 : undefined } }}
      >
        {!data ? <Card loading bordered={false} /> : shown.length ? (
          <ResponsiveTable
            size="middle"
            rowKey="id"
            dataSource={shown}
            columns={columns}
            scroll={{ x: 'max-content' }}
            pagination={shown.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={filter ? 'У этого клиента оплат пока нет' : 'Оплат пока нет — запишите первую выше'}
          />
        )}
      </Card>

      {!data || payments.length ? null : (
        <Alert
          type="info"
          showIcon
          message="Оплаты, отмеченные до появления этого раздела, в историю не попали — новые записываются все."
        />
      )}
    </Space>
  );
}
