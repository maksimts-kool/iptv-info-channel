import { useState } from 'react';
import {
  Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography,
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
      editing ? `Updating ${payload.username}'s stream` : `Creating ${payload.username}'s stream`,
      async () => {
        if (editing) await api.patch(`/admin/api/users/${editing.id}`, payload);
        else await api.post('/admin/api/users', payload);
        setOpen(false);
      },
      { success: 'Saved — stream rebuilding' },
    );
  };

  const columns = [
    { title: 'User', dataIndex: 'username', render: (v) => <strong>{v}</strong> },
    { title: 'Plan', dataIndex: 'plan_name' },
    { title: 'Price', dataIndex: 'price' },
    { title: 'Expires', dataIndex: 'expires_pretty' },
    { title: 'Days left', dataIndex: 'days_left', render: (v) => (v === null ? '—' : v) },
    { title: 'Status', key: 'status', render: (_, u) => <Tag color={u.status_color}>{u.status_label}</Tag> },
    {
      title: 'Active',
      key: 'active',
      render: (_, u) => (
        <Switch
          checked={!!u.active}
          onChange={(checked) => withRegen(`Updating ${u.username}'s stream`, () => api.patch(`/admin/api/users/${u.id}`, { active: checked }))}
        />
      ),
    },
    {
      title: 'Подписка',
      key: 'sub',
      render: (_, u) => {
        const sub = subByUser.get(u.id);
        if (!sub) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            <span>
              {sub.email}
              {sub.verified ? null : <Tag color="orange" style={{ marginLeft: 6 }}>не подтв.</Tag>}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{subOptLabels(sub.options)}</Typography.Text>
            <Popconfirm title={`Отписать ${u.username}?`} okText="Отписать" onConfirm={() => guarded(() => api.del(`/admin/api/users/${u.id}/subscriber`), 'Подписчик удалён')}>
              <Button size="small" type="link" style={{ paddingLeft: 0 }}>Отписать</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
    {
      title: 'Links',
      key: 'links',
      render: (_, u) => (
        <Space>
          <Button size="small" onClick={() => copy(u.m3u_url)}>Copy m3u</Button>
          <Button size="small" onClick={() => window.open(u.hls_url, '_blank')}>HLS</Button>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      render: (_, u) => (
        <Space>
          <Button size="small" onClick={() => openDialog(u)}>Edit</Button>
          <Popconfirm
            title="Generate a new link? The old m3u URL will stop working."
            okText="New link"
            onConfirm={() => withRegen(`Generating ${u.username}'s new stream`, () => api.post(`/admin/api/users/${u.id}/token`), { success: 'New link generated — stream rebuilding' })}
          >
            <Button size="small">New link</Button>
          </Popconfirm>
          <Popconfirm
            title={`Delete ${u.username}?`}
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={() => guarded(() => api.del(`/admin/api/users/${u.id}`), 'User deleted')}
          >
            <Button size="small" danger>Delete</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="Users"
      extra={<Button type="primary" onClick={() => openDialog(null)}>+ Add user</Button>}
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={users}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'No users yet — click “Add user”.' }}
      />

      <Modal
        open={open}
        title={editing ? 'Edit user' : 'Add user'}
        okText="Save"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username required' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="plan_id" label="Plan" rules={[{ required: true, message: 'Plan required' }]}>
            <Select
              options={plans.map((p) => ({
                value: p.id,
                label: `${p.name} (${p.price}${periodSuffix(p.billing_period)})`,
              }))}
            />
          </Form.Item>
          <Form.Item name="expires_at" label="Expiration date">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
