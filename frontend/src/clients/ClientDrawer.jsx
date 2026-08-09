import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Descriptions, Drawer, Form, Input, Popconfirm, Select, Space, Spin, Switch, Tabs,
  Tag, Typography,
} from 'antd';
import { AuthError } from '../api.js';
import { periodSuffix, planOptions } from '../plans.js';
import ClientAccessTab from './ClientAccessTab.jsx';
import ClientNotifyTab from './ClientNotifyTab.jsx';

// Everything about one customer in one place: the account, the channels they
// personally get, their email subscription, and the exact playlist their player
// will download.
export default function ClientDrawer({
  user, subscriber, state, api, withRegen, reload, message, onAuthError, onClose,
}) {
  const [tab, setTab] = useState('account');
  const [form] = Form.useForm();
  const plans = state?.plans || [];

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

  const guarded = useCallback(async (fn, ok) => {
    try {
      await fn();
      if (ok) message.success(ok);
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  }, [message, reload, onAuthError]);

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
        <Form.Item name="expires_at" label="Подписка действует до" extra="Перенос даты вперёд считается продлением: клиенту уйдёт письмо и каналы включатся обратно.">
          <Input type="date" />
        </Form.Item>
        <Form.Item name="active" label="Активен" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button type="primary" onClick={save}>Сохранить</Button>
      </Form>

      <Descriptions bordered size="small" column={1} title="Ссылки">
        <Descriptions.Item label="Плейлист (m3u)">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Typography.Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{user.m3u_url}</Typography.Text>
            <Space>
              <Button size="small" onClick={() => copy(user.m3u_url)}>Копировать</Button>
              <Button size="small" onClick={() => window.open(user.m3u_url, '_blank')}>Открыть</Button>
            </Space>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="Инфоканал (HLS)">
          <Space>
            <Button size="small" onClick={() => copy(user.hls_url)}>Копировать</Button>
            <Button size="small" onClick={() => window.open(user.hls_url, '_blank')}>Открыть</Button>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="Обслуживание">
          <Space wrap>
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
              <Button size="small" danger>Перевыпустить ссылку</Button>
            </Popconfirm>
            <Button
              size="small"
              onClick={() => guarded(
                () => api.post(`/admin/api/users/${user.id}/regenerate`),
                'Инфоканал пересобран',
              )}
            >
              Пересобрать инфоканал
            </Button>
          </Space>
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
