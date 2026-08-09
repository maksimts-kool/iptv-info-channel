import { useMemo, useState } from 'react';
import {
  Button, Card, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag,
  Typography,
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, FolderOpenOutlined, PlusOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { periodSuffix, planOptions, expiryForPlan } from '../lib/plans.js';
import ClientDrawer from '../clients/ClientDrawer.jsx';

const FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'active', label: 'Активные' },
  { value: 'expiring', label: 'Истекают' },
  { value: 'expired', label: 'Просрочены' },
  { value: 'disabled', label: 'Отключены' },
];

// Customer list. The row is a summary; everything about one customer — plan,
// personal channel access, notifications, the exact .m3u they receive — lives in
// the drawer, so the table stays readable as the customer base grows.
export default function ClientsPage(shared) {
  const {
    state, api, withRegen, reload, message, onAuthError,
  } = shared;
  const users = state?.users || [];
  const plans = state?.plans || [];
  const subByUser = useMemo(
    () => new Map((state?.subscribers || []).map((s) => [s.user_id, s])),
    [state?.subscribers],
  );

  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const rows = users.filter((u) => {
    if (statusFilter !== 'all' && u.status !== statusFilter) return false;
    if (!search.trim()) return true;
    return u.username.toLowerCase().includes(search.trim().toLowerCase());
  });

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

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('Скопировано');
    } catch {
      window.prompt('Скопируйте ссылку:', text);
    }
  };

  // Pre-fill the expiry from the plan's billing period, so a monthly plan needs
  // no date arithmetic to create a customer. Still a plain date input — an
  // unusual first period is just typed over.
  const openCreate = () => {
    form.setFieldsValue({
      username: '',
      plan_id: plans[0]?.id,
      expires_at: plans[0] ? expiryForPlan(plans[0]) : '',
      active: true,
    });
    setCreateOpen(true);
  };

  const onPlanPicked = (planId) => {
    const picked = plans.find((p) => p.id === planId);
    if (picked) form.setFieldsValue({ expires_at: expiryForPlan(picked) });
  };

  const create = async () => {
    const v = await form.validateFields();
    await withRegen(
      `Создание клиента «${v.username}»`,
      async () => {
        await api.post('/admin/api/users', {
          username: v.username.trim(),
          plan_id: v.plan_id,
          expires_at: v.expires_at || null,
          active: v.active,
        });
        setCreateOpen(false);
      },
      { success: 'Клиент создан' },
    );
  };

  const columns = [
    {
      title: 'Клиент',
      key: 'username',
      render: (_, u) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0, height: 'auto', fontWeight: 600 }} onClick={() => setOpenId(u.id)}>
            {u.username}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`${u.plan_name} · ${u.price}${periodSuffix(u.billing_period)}`}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Статус',
      key: 'status',
      width: 190,
      render: (_, u) => (
        <Space direction="vertical" size={2}>
          <Tag color={u.status_color}>{u.status_label}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {u.expires_at
              ? `${u.expires_pretty}${u.days_left === null ? '' : ` · ${u.days_left} дн.`}`
              : 'бессрочно'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Доступ к каналам',
      key: 'access',
      width: 230,
      render: (_, u) => {
        if (u.status === 'expired' || u.status === 'disabled') {
          return <Tag color="red">только «Информация»</Tag>;
        }
        const plan = plans.find((p) => p.id === u.plan_id);
        const count = plan?.category_ids?.length ?? 0;
        return (
          <Space direction="vertical" size={2}>
            {count
              ? <Typography.Text type="secondary">{`по тарифу: ${count} кат.`}</Typography.Text>
              : <Tag color="orange">в тарифе нет категорий</Tag>}
            {u.personal_overrides
              ? <Tag color="purple">{`исключений: ${u.personal_overrides}`}</Tag>
              : null}
          </Space>
        );
      },
    },
    {
      title: 'Почта',
      key: 'sub',
      render: (_, u) => {
        const sub = subByUser.get(u.id);
        if (!sub) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            <span style={{ fontSize: 13 }}>{sub.email}</span>
            {sub.verified ? null : <Tag color="orange">не подтв.</Tag>}
          </Space>
        );
      },
    },
    {
      title: 'Активен',
      key: 'active',
      width: 90,
      render: (_, u) => (
        <Switch
          checked={!!u.active}
          onChange={(checked) => withRegen(
            `Обновление «${u.username}»`,
            () => api.patch(`/admin/api/users/${u.id}`, { active: checked }),
          )}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 240,
      render: (_, u) => (
        <Space wrap>
          <Button size="small" icon={<CopyOutlined />} onClick={() => copy(u.m3u_url)}>m3u</Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => setOpenId(u.id)}>
            Открыть
          </Button>
          <Popconfirm
            title={`Удалить клиента «${u.username}»?`}
            okText="Удалить"
            okButtonProps={{ danger: true }}
            onConfirm={() => guarded(() => api.del(`/admin/api/users/${u.id}`), 'Клиент удалён')}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>Удалить</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const openUser = users.find((u) => u.id === openId) || null;

  return (
    <Card
      title={`Клиенты (${users.length})`}
      extra={(
        <Button type="primary" icon={<PlusOutlined />} disabled={!plans.length} onClick={openCreate}>
          Добавить клиента
        </Button>
      )}
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented options={FILTERS} value={statusFilter} onChange={setStatusFilter} />
        <Input.Search
          allowClear
          placeholder="Поиск по имени"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
      </Space>

      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        pagination={users.length > 25 ? { pageSize: 25, showSizeChanger: true } : false}
        locale={{
          emptyText: plans.length
            ? 'Клиентов нет — нажмите «Добавить клиента».'
            : 'Сначала создайте тариф в разделе «Тарифы».',
        }}
      />

      <ClientDrawer
        {...shared}
        user={openUser}
        subscriber={openUser ? subByUser.get(openUser.id) : null}
        onClose={() => setOpenId(null)}
      />

      <Modal
        open={createOpen}
        title="Добавить клиента"
        okText="Создать"
        cancelText="Отмена"
        onOk={create}
        onCancel={() => setCreateOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="Имя клиента" rules={[{ required: true, message: 'Укажите имя' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="plan_id" label="Тариф" rules={[{ required: true, message: 'Выберите тариф' }]}>
            <Select options={planOptions(plans)} onChange={onPlanPicked} />
          </Form.Item>
          <Form.Item
            name="expires_at"
            label="Подписка действует до"
            extra="Подставлено по периоду тарифа от сегодняшнего дня. Можно изменить или очистить — тогда срок будет без ограничения."
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item name="active" label="Активен" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Клиент получает категории, входящие в выбранный тариф, плюс канал
            «Информация». Персональные исключения настраиваются потом в карточке
            клиента, на вкладке «Каналы клиента».
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}
