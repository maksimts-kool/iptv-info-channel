import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Popconfirm, Select, Space,
  Spin, Switch, Tabs, Tag, Typography,
} from 'antd';
import {
  CopyOutlined, ExportOutlined, KeyOutlined, WalletOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { periodSuffix, planOptions } from '../lib/plans.js';
import ClientAccessTab from './ClientAccessTab.jsx';
import ClientNotifyTab from './ClientNotifyTab.jsx';

// "Paid for N ..." — the units the payment endpoint understands. The default is
// the plan's own billing period, so a monthly plan needs no thought at all.
const PERIOD_UNITS = [
  { value: 'month', label: 'мес.' },
  { value: 'year', label: 'год' },
  { value: 'day', label: 'дн.' },
];

// Everything about one customer in one place: the account, the channels they
// personally get, their email subscription, and the exact playlist their player
// will download.
export default function ClientDrawer({
  user, subscriber, state, api, withRegen, reload, message, onAuthError, onClose,
}) {
  const [tab, setTab] = useState('account');
  const [form] = Form.useForm();
  const [payForm] = Form.useForm();
  const plans = state?.plans || [];
  const plan = plans.find((p) => p.id === user?.plan_id) || null;

  useEffect(() => {
    if (!user) return;
    setTab('account');
    form.setFieldsValue({
      username: user.username,
      plan_id: user.plan_id,
      expires_at: user.expires_at || '',
      active: !!user.active,
    });
  }, [user, form]);

  // The payment form defaults to one of whatever the plan is billed in, so
  // "клиент заплатил" is one click for the normal case.
  useEffect(() => {
    if (!user) return;
    payForm.setFieldsValue({
      count: 1,
      period: ['month', 'year', 'day'].includes(plan?.billing_period) ? plan.billing_period : 'month',
    });
  }, [user, plan, payForm]);

  if (!user) return <Drawer open={false} />;

  const save = async () => {
    const v = await form.validateFields();
    await withRegen(
      `Обновление «${user.username}»`,
      () => api.patch(`/admin/api/users/${user.id}`, {
        username: v.username.trim(),
        plan_id: v.plan_id,
        expires_at: v.expires_at || null,
        active: v.active,
      }),
      { success: 'Сохранено' },
    );
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('Скопировано');
    } catch {
      window.prompt('Скопируйте ссылку:', text);
    }
  };

  // Record a payment: the server works the new date out from the plan period and
  // pushes the expiry, so nobody has to count months in their head.
  const recordPayment = async (from) => {
    const v = await payForm.validateFields();
    await withRegen(
      `Оплата «${user.username}»`,
      async () => {
        const res = await api.post(`/admin/api/users/${user.id}/payment`, {
          count: v.count, period: v.period, from,
        });
        message.success(`Подписка продлена до ${res.user.expires_pretty}`);
      },
    );
  };

  const locked = user.status === 'expired' || user.status === 'disabled';

  const accountTab = (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      {locked ? (
        <Alert
          type="warning"
          showIcon
          message={user.status === 'expired' ? 'Подписка истекла' : 'Клиент отключён'}
          description="Сейчас в плейлисте клиента остаётся только категория «Информация». Полный список вернётся сам, как только вы продлите дату окончания или включите клиента — ничего перенастраивать не нужно."
        />
      ) : null}

      <Form form={form} layout="vertical">
        <Form.Item name="username" label="Имя клиента" rules={[{ required: true, message: 'Укажите имя' }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="plan_id"
          label="Тариф"
          rules={[{ required: true }]}
          extra="Тариф определяет, какие категории каналов получает клиент. Смена тарифа сразу меняет его плейлист."
        >
          <Select options={planOptions(plans)} />
        </Form.Item>
        <Form.Item
          name="expires_at"
          label="Подписка действует до"
          extra="Обычно эту дату ставит блок «Оплата» ниже. Здесь её можно поправить вручную, если дата неверная. Перенос вперёд считается продлением: клиенту уйдёт письмо и каналы включатся обратно."
        >
          <Input type="date" />
        </Form.Item>
        <Form.Item name="active" label="Активен" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button type="primary" onClick={save}>Сохранить</Button>
      </Form>

      <Card size="small" title={<Space><WalletOutlined />Оплата</Space>}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {`Отметьте оплаченный срок — дата окончания посчитается сама${
              plan?.billing_period ? ` по периоду тарифа (${periodSuffix(plan.billing_period).replace('/', '')})` : ''
            }. Оплаченное время прибавляется к текущей дате, поэтому досрочное продление не съедает остаток.`}
          </Typography.Text>
          <Form form={payForm} layout="inline" style={{ rowGap: 8 }}>
            <Form.Item name="count" label="Заплатили за" rules={[{ required: true }]}>
              <InputNumber min={1} max={120} precision={0} style={{ width: 90 }} />
            </Form.Item>
            <Form.Item name="period" rules={[{ required: true }]}>
              <Select options={PERIOD_UNITS} style={{ width: 100 }} />
            </Form.Item>
            <Form.Item>
              <Space wrap>
                <Button type="primary" onClick={() => recordPayment('expiry')}>
                  Продлить
                </Button>
                <Popconfirm
                  title="Отсчитать срок от сегодняшнего дня?"
                  description="Остаток текущей подписки при этом сгорает."
                  okText="Отсчитать от сегодня"
                  onConfirm={() => recordPayment('today')}
                >
                  <Button>С сегодняшнего дня</Button>
                </Popconfirm>
              </Space>
            </Form.Item>
          </Form>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {user.expires_at
              ? `Сейчас действует до ${user.expires_pretty}`
              : 'Срок сейчас не ограничен — первая же отметка об оплате поставит дату от сегодняшнего дня.'}
          </Typography.Text>
        </Space>
      </Card>

      <Descriptions bordered size="small" column={1} title="Ссылки">
        <Descriptions.Item label="Плейлист (m3u)">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Typography.Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{user.m3u_url}</Typography.Text>
            <Space>
              <Button size="small" icon={<CopyOutlined />} onClick={() => copy(user.m3u_url)}>Копировать</Button>
              <Button size="small" icon={<ExportOutlined />} onClick={() => window.open(user.m3u_url, '_blank')}>Открыть</Button>
            </Space>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="Обслуживание">
          <Popconfirm
            title="Сгенерировать новую ссылку?"
            description="Старый адрес m3u сразу перестанет работать — клиенту нужно будет отдать новый."
            okText="Новая ссылка"
            onConfirm={() => withRegen(
              `Новая ссылка «${user.username}»`,
              () => api.post(`/admin/api/users/${user.id}/token`),
              { success: 'Ссылка перевыпущена' },
            )}
          >
            <Button size="small" danger icon={<KeyOutlined />}>Перевыпустить ссылку</Button>
          </Popconfirm>
        </Descriptions.Item>
      </Descriptions>
    </Space>
  );

  return (
    <Drawer
      open
      width={880}
      onClose={onClose}
      title={(
        <Space wrap>
          <span>{user.username}</span>
          <Tag color={user.status_color}>{user.status_label}</Tag>
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {`${user.plan_name} · ${user.price}${periodSuffix(user.billing_period)}`}
          </Typography.Text>
        </Space>
      )}
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'account', label: 'Аккаунт', children: accountTab },
          {
            key: 'access',
            label: 'Каналы клиента',
            children: <ClientAccessTab
              user={user}
              api={api}
              message={message}
              onAuthError={onAuthError}
              reload={reload}
            />,
          },
          {
            key: 'notify',
            label: 'Уведомления',
            children: <ClientNotifyTab
              user={user}
              subscriber={subscriber}
              api={api}
              message={message}
              onAuthError={onAuthError}
              reload={reload}
            />,
          },
          {
            key: 'playlist',
            label: 'Плейлист клиента',
            children: <PlaylistPreview user={user} api={api} message={message} onAuthError={onAuthError} />,
          },
        ]}
      />
    </Drawer>
  );
}

// The literal .m3u this customer's player downloads — the fastest way to answer
// "why don't they see channel X?".
function PlaylistPreview({ user, api, message, onAuthError }) {
  const [text, setText] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/admin/api/users/${user.id}/playlist`)
      .then((res) => { if (!cancelled) setText(res.text); })
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
        else message.error(e.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user.id, api, message, onAuthError]);

  if (loading) return <Spin />;

  const channels = (text || '').split('\n').filter((l) => l.startsWith('#EXTINF:')).length;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Text type="secondary">{`Каналов в плейлисте: ${channels}`}</Typography.Text>
      <Input.TextArea value={text || ''} readOnly autoSize={{ minRows: 16, maxRows: 32 }} style={{ fontFamily: 'monospace', fontSize: 12 }} />
    </Space>
  );
}
