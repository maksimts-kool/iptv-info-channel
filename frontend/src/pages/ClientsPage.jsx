import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import {
  App as AntApp, Button, Card, Dropdown, Empty, Form, Grid, Input, Modal, Result, Segmented, Select,
  Space, Switch, Tag, Tooltip, Typography,
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, FolderOpenOutlined, MoreOutlined, PlusOutlined,
} from '@ant-design/icons';
import { clientMatches } from '../components/ClientJump.jsx';
import ResponsiveTable from '../components/ResponsiveTable.jsx';
import { AuthError } from '../lib/api.js';
import { periodSuffix, planOptions, expiryForPlan } from '../lib/plans.js';
import ClientDrawer from '../clients/ClientDrawer.jsx';

// #/clients/12 opens that customer's card straight away (linked from the
// Устройства and Оплаты sections).
function clientIdFromHash() {
  const m = window.location.hash.match(/^#\/?clients\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// #/clients?status=expiring opens the list already filtered (the numbers on
// Обзор link here); #/clients?new=1 opens the "add" dialog.
function hashParams() {
  const q = window.location.hash.split('?')[1] || '';
  return new URLSearchParams(q);
}

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
  const screens = Grid.useBreakpoint();
  const phone = screens.md === false;
  const users = state?.users || [];
  const plans = state?.plans || [];
  const subByUser = useMemo(
    () => new Map((state?.subscribers || []).map((s) => [s.user_id, s])),
    [state?.subscribers],
  );

  const { modal } = AntApp.useApp();
  const [statusFilter, setStatusFilter] = useState(() => {
    const wanted = hashParams().get('status');
    return FILTERS.some((f) => f.value === wanted) ? wanted : 'all';
  });
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(clientIdFromHash);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState(null); // the customer just added
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const nameRef = useRef(null);

  // The header search (and links from other sections) change the hash while
  // this page is already open.
  useEffect(() => {
    const onHash = () => {
      const id = clientIdFromHash();
      if (id !== null) { setOpenId(id); return; }
      const wanted = hashParams().get('status');
      setStatusFilter(FILTERS.some((f) => f.value === wanted) ? wanted : 'all');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // How many customers each filter would show, so an empty one is visible
  // before it is clicked.
  const tally = useMemo(() => users.reduce((acc, u) => {
    acc[u.status] = (acc[u.status] || 0) + 1;
    return acc;
  }, { all: users.length }), [users]);
  const filterOptions = FILTERS.map((f) => ({
    value: f.value,
    label: `${f.label} · ${tally[f.value] || 0}`,
  }));

  const rows = users.filter((u) => {
    if (statusFilter !== 'all' && u.status !== statusFilter) return false;
    return clientMatches(u, search, subByUser.get(u.id)?.email);
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
  // Opened from the setup checklist on Обзор.
  useEffect(() => {
    if (hashParams().get('new') && plans.length) {
      openCreate();
      window.history.replaceState(null, '', '#/clients');
    }
  }, [plans.length]);

  const removeClient = (u) => modal.confirm({
    title: `Удалить клиента «${u.username}»?`,
    content: 'Его ссылка на плейлист перестанет работать. История оплат сохранится.',
    okText: 'Удалить',
    okButtonProps: { danger: true },
    cancelText: 'Отмена',
    onOk: () => guarded(() => api.del(`/admin/api/users/${u.id}`), 'Клиент удалён'),
  });

  function openCreate() {
    form.setFieldsValue({
      username: '',
      plan_id: plans[0]?.id,
      expires_at: plans[0] ? expiryForPlan(plans[0]) : '',
      active: true,
    });
    setCreateOpen(true);
  }

  const onPlanPicked = (planId) => {
    const picked = plans.find((p) => p.id === planId);
    if (picked) form.setFieldsValue({ expires_at: expiryForPlan(picked) });
  };

  // The end of "add a customer" is handing them their link, so the dialog
  // finishes on that link with a copy button instead of a bare toast.
  const create = async () => {
    const v = await form.validateFields();
    setSaving(true);
    await withRegen(
      `Создание клиента «${v.username}»`,
      async () => {
        const res = await api.post('/admin/api/users', {
          username: v.username.trim(),
          plan_id: v.plan_id,
          expires_at: v.expires_at || null,
          active: v.active,
        });
        setCreateOpen(false);
        setCreated(res);
      },
    );
    setSaving(false);
  };

  const columns = [
    {
      title: 'Клиент',
      key: 'username',
      render: (_, u) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0, height: 'auto', fontWeight: 600 }} onClick={(e) => { e.stopPropagation(); setOpenId(u.id); }}>
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
      // Devices watching right now vs. the limit that applies. Live numbers
      // from the stream gateway; refreshed with the rest of /api/state.
      title: 'Устройства',
      key: 'devices',
      width: 120,
      render: (_, u) => {
        const active = u.devices_active || 0;
        const limit = u.device_limit || 0;
        const text = limit > 0 ? `${active} / ${limit}` : `${active} / ∞`;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text type={limit > 0 && active >= limit ? 'warning' : undefined}>{text}</Typography.Text>
            {u.max_devices !== null && u.max_devices !== undefined
              ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>личный лимит</Typography.Text>
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
      // Frequent actions are visible; the destructive one sits behind "⋯" so it
      // is never one slip away from "Открыть".
      title: '',
      key: 'actions',
      width: 170,
      render: (_, u) => (
        <Space size={6}>
          <Tooltip title="Копировать ссылку на плейлист">
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(u.m3u_url)}>m3u</Button>
          </Tooltip>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => setOpenId(u.id)}>
            Открыть
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [{
                key: 'delete', danger: true, icon: <DeleteOutlined />, label: 'Удалить клиента',
              }],
              onClick: () => removeClient(u),
            }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />} aria-label="Ещё действия" />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const openUser = users.find((u) => u.id === openId) || null;

  // Clicking anywhere on a row opens the card — a far bigger target than the
  // name link — except on the row's own controls.
  const onRow = (u) => ({
    className: 'row-clickable',
    onClick: (e) => {
      if (e.target.closest('button, a, input, .ant-switch, .ant-dropdown-trigger, .ant-typography-copy')) return;
      setOpenId(u.id);
    },
  });

  const emptyText = (() => {
    if (!plans.length) {
      return (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сначала создайте тариф — клиенту нужно что-то назначить.">
          <Button type="primary" onClick={() => shared.go('plans')}>К тарифам</Button>
        </Empty>
      );
    }
    if (users.length) {
      return (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Никого не нашлось">
          <Button onClick={() => { setSearch(''); setStatusFilter('all'); }}>Сбросить фильтры</Button>
        </Empty>
      );
    }
    return (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Клиентов пока нет">
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Добавить клиента</Button>
      </Empty>
    );
  })();

  return (
    <Card
      title={`Клиенты (${users.length})`}
      extra={(
        <Button type="primary" icon={<PlusOutlined />} disabled={!plans.length} onClick={openCreate}>
          Добавить клиента
        </Button>
      )}
    >
      {/* Five segments are wider than a phone, so there they become a dropdown. */}
      <Space wrap style={{ marginBottom: 16, width: phone ? '100%' : undefined }} className={phone ? 'filter-bar-phone' : undefined}>
        {phone
          ? <Select options={filterOptions} value={statusFilter} onChange={setStatusFilter} style={{ width: '100%' }} />
          : <Segmented options={filterOptions} value={statusFilter} onChange={setStatusFilter} />}
        <Input.Search
          allowClear
          placeholder="Имя, почта или тариф"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: phone ? '100%' : 260 }}
        />
      </Space>

      <ResponsiveTable
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        onRow={onRow}
        scroll={{ x: 'max-content' }}
        pagination={rows.length > 25 ? { pageSize: 25, showSizeChanger: true } : false}
        locale={{ emptyText }}
      />

      <ClientDrawer
        {...shared}
        user={openUser}
        subscriber={openUser ? subByUser.get(openUser.id) : null}
        onClose={() => {
          setOpenId(null);
          if (clientIdFromHash() !== null) window.history.replaceState(null, '', '#/clients');
        }}
      />

      <Modal
        open={createOpen}
        title="Добавить клиента"
        okText="Создать"
        cancelText="Отмена"
        onOk={create}
        okButtonProps={{ loading: saving }}
        onCancel={() => setCreateOpen(false)}
        afterOpenChange={(opened) => { if (opened) nameRef.current?.focus(); }}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="Имя клиента" rules={[{ required: true, whitespace: true, message: 'Укажите имя' }]}>
            <Input ref={nameRef} onPressEnter={create} />
          </Form.Item>
          <Form.Item
            name="plan_id"
            label="Тариф"
            rules={[{ required: true, message: 'Выберите тариф' }]}
            tooltip="Клиент получает категории тарифа плюс «Информация». Исключения — потом в карточке клиента."
          >
            <Select options={planOptions(plans)} onChange={onPlanPicked} />
          </Form.Item>
          <Form.Item
            name="expires_at"
            label="Подписка действует до"
            tooltip="Подставлено по периоду тарифа от сегодняшнего дня. Можно изменить или очистить — тогда срок будет без ограничения."
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item name="active" label="Активен" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!created}
        footer={null}
        onCancel={() => setCreated(null)}
        width={520}
      >
        {created ? (
          <Result
            status="success"
            title={`Клиент «${created.username}» создан`}
            subTitle="Отправьте ему ссылку на плейлист."
            style={{ paddingBlock: 16 }}
            extra={(
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Typography.Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{created.m3u_url}</Typography.Text>
                <Space wrap style={{ justifyContent: 'center' }}>
                  <Button type="primary" icon={<CopyOutlined />} onClick={() => copy(created.m3u_url)}>
                    Копировать ссылку
                  </Button>
                  <Button onClick={() => { setOpenId(created.id); setCreated(null); }}>
                    Открыть карточку
                  </Button>
                </Space>
              </Space>
            )}
          />
        ) : null}
      </Modal>
    </Card>
  );
}
