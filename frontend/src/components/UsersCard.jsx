import { useState } from 'react';
import {
  Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography,
} from 'antd';
import { AuthError } from '../api.js';

const periodSuffix = (p) => (p === 'month' ? '/мес.' : p === 'year' ? '/год' : '');
const subOptLabels = (o) => ['Продление', o.expiry ? 'Истечение' : null, o.server ? 'Статус' : null]
  .filter(Boolean).join(', ');

export default function UsersCard({
  state, api, withRegen, reload, message, onAuthError,
}) {
  const users = state?.users || [];
  const plans = state?.plans || [];
  const subByUser = new Map((state?.subscribers || []).map((s) => [s.user_id, s]));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const [subOpen, setSubOpen] = useState(false);
  const [subUser, setSubUser] = useState(null);
  const [subForm] = Form.useForm();

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('Скопировано');
    } catch {
      window.prompt('Copy this URL:', text);
    }
  };

  const guarded = async (fn, ok) => {
    try {
      await fn();
      if (ok) message.success(ok);
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  const openDialog = (u) => {
    setEditing(u || null);
    form.setFieldsValue({
      username: u?.username || '',
      plan_id: u?.plan_id || plans[0]?.id,
      expires_at: u?.expires_at || '',
      active: u ? !!u.active : true,
    });
    setOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    const payload = {
      username: v.username.trim(),
      plan_id: v.plan_id,
      expires_at: v.expires_at || null,
      active: v.active,
    };
    await withRegen(
      editing ? `Обновление потока «${payload.username}»` : `Создание потока «${payload.username}»`,
      async () => {
        if (editing) await api.patch(`/admin/api/users/${editing.id}`, payload);
        else await api.post('/admin/api/users', payload);
        setOpen(false);
      },
      { success: 'Сохранено — поток пересобирается' },
    );
  };

  const openSubDialog = (u) => {
    const sub = subByUser.get(u.id);
    setSubUser(u);
    subForm.setFieldsValue({
      email: sub?.email || '',
      expiry: sub ? !!sub.options.expiry : true,
      server: sub ? !!sub.options.server : false,
      verified: sub ? !!sub.verified : true,
    });
    setSubOpen(true);
  };

  const saveSub = async () => {
    const v = await subForm.validateFields();
    try {
      const res = await api.put(`/admin/api/users/${subUser.id}/subscriber`, {
        email: v.email.trim(),
        options: { expiry: v.expiry, server: v.server },
        verified: v.verified,
      });
      setSubOpen(false);
      message.success(res.sentVerification
        ? 'Сохранено — клиенту отправлено письмо для подтверждения'
        : 'Подписка сохранена');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  const columns = [
    { title: 'Пользователь', dataIndex: 'username', render: (v) => <strong>{v}</strong> },
    { title: 'Тариф', dataIndex: 'plan_name' },
    { title: 'Цена', dataIndex: 'price' },
    { title: 'Истекает', dataIndex: 'expires_pretty' },
    { title: 'Осталось дней', dataIndex: 'days_left', render: (v) => (v === null ? '—' : v) },
    { title: 'Статус', key: 'status', render: (_, u) => <Tag color={u.status_color}>{u.status_label}</Tag> },
    {
      title: 'Активен',
      key: 'active',
      render: (_, u) => (
        <Switch
          checked={!!u.active}
          onChange={(checked) => withRegen(`Обновление потока «${u.username}»`, () => api.patch(`/admin/api/users/${u.id}`, { active: checked }))}
        />
      ),
    },
    {
      title: 'Подписка',
      key: 'sub',
      render: (_, u) => {
        const sub = subByUser.get(u.id);
        if (!sub) {
          return (
            <Button size="small" type="link" style={{ paddingLeft: 0 }} onClick={() => openSubDialog(u)}>
              + Добавить
            </Button>
          );
        }
        return (
          <Space direction="vertical" size={0}>
            <span>
              {sub.email}
              {sub.verified ? null : <Tag color="orange" style={{ marginLeft: 6 }}>не подтв.</Tag>}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{subOptLabels(sub.options)}</Typography.Text>
            <Space size={0}>
              <Button size="small" type="link" style={{ paddingLeft: 0 }} onClick={() => openSubDialog(u)}>Изменить</Button>
              <Popconfirm title={`Отписать ${u.username}?`} okText="Отписать" onConfirm={() => guarded(() => api.del(`/admin/api/users/${u.id}/subscriber`), 'Подписчик удалён')}>
                <Button size="small" type="link" danger>Отписать</Button>
              </Popconfirm>
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Ссылки',
      key: 'links',
      render: (_, u) => (
        <Space>
          <Button size="small" onClick={() => copy(u.m3u_url)}>Копировать m3u</Button>
          <Button size="small" onClick={() => window.open(u.hls_url, '_blank')}>HLS</Button>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      render: (_, u) => (
        <Space>
          <Button size="small" onClick={() => openDialog(u)}>Изменить</Button>
          <Popconfirm
            title="Сгенерировать новую ссылку? Старый адрес m3u перестанет работать."
            okText="Новая ссылка"
            onConfirm={() => withRegen(`Генерация новой ссылки «${u.username}»`, () => api.post(`/admin/api/users/${u.id}/token`), { success: 'Новая ссылка создана — поток пересобирается' })}
          >
            <Button size="small">Новая ссылка</Button>
          </Popconfirm>
          <Popconfirm
            title={`Удалить пользователя «${u.username}»?`}
            okText="Удалить"
            okButtonProps={{ danger: true }}
            onConfirm={() => guarded(() => api.del(`/admin/api/users/${u.id}`), 'Пользователь удалён')}
          >
            <Button size="small" danger>Удалить</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="Пользователи"
      extra={<Button type="primary" onClick={() => openDialog(null)}>+ Добавить пользователя</Button>}
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={users}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'Пользователей пока нет — нажмите «Добавить пользователя».' }}
      />

      <Modal
        open={open}
        title={editing ? 'Изменить пользователя' : 'Добавить пользователя'}
        okText="Сохранить"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="Имя пользователя" rules={[{ required: true, message: 'Укажите имя' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="plan_id" label="Тариф" rules={[{ required: true, message: 'Выберите тариф' }]}>
            <Select
              options={plans.map((p) => ({
                value: p.id,
                label: `${p.name} (${p.price}${periodSuffix(p.billing_period)})`,
              }))}
            />
          </Form.Item>
          <Form.Item name="expires_at" label="Дата окончания">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="active" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={subOpen}
        title={subUser ? `Подписка: ${subUser.username}` : 'Подписка'}
        okText="Сохранить"
        onOk={saveSub}
        onCancel={() => setSubOpen(false)}
        forceRender
      >
        <Form form={subForm} layout="vertical">
          <Form.Item
            name="email"
            label="Электронная почта"
            rules={[
              { required: true, message: 'Введите адрес' },
              { type: 'email', message: 'Некорректный адрес' },
            ]}
          >
            <Input type="email" placeholder="you@example.com" />
          </Form.Item>
          <Form.Item label="Темы уведомлений">
            <Space direction="vertical">
              <Checkbox checked disabled>Продление подписки (обязательно)</Checkbox>
              <Form.Item name="expiry" valuePropName="checked" noStyle>
                <Checkbox>Подписка скоро истекает</Checkbox>
              </Form.Item>
              <Form.Item name="server" valuePropName="checked" noStyle>
                <Checkbox>Статус сервера</Checkbox>
              </Form.Item>
            </Space>
          </Form.Item>
          <Form.Item name="verified" valuePropName="checked" noStyle>
            <Checkbox>Подтвердить без письма (не отправлять запрос подтверждения)</Checkbox>
          </Form.Item>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
            Если снять галочку, клиенту уйдёт письмо со ссылкой для подтверждения,
            и уведомления начнут приходить только после подтверждения.
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}
