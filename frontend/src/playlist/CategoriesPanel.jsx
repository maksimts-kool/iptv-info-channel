import { useState } from 'react';
import {
  Alert, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tag, Typography,
} from 'antd';
import { AuthError } from '../api.js';

// Categories are the group titles customers see in their player. They are shared
// across sources (two providers both shipping "Спорт" land in one group), can be
// renamed freely, reordered, and switched off wholesale.
export default function CategoriesPanel({
  api, message, onAuthError, catalog, refresh, onOpenChannels,
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const categories = catalog?.categories || [];

  const guarded = async (fn, ok) => {
    try {
      await fn();
      if (ok) message.success(ok);
      await refresh();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  const openDialog = (category) => {
    setEditing(category || null);
    form.setFieldsValue({ name: category?.name || '' });
    setOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    await guarded(async () => {
      if (editing) await api.patch(`/admin/api/catalog/categories/${editing.id}`, { name: v.name.trim() });
      else await api.post('/admin/api/catalog/categories', { name: v.name.trim() });
      setOpen(false);
    }, 'Категория сохранена');
  };

  // Reordering is a swap with the neighbour, sent as the whole new order.
  const move = (index, delta) => {
    const next = [...categories];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    guarded(() => api.post('/admin/api/catalog/categories/reorder', { ids: next.map((c) => c.id) }));
  };

  const columns = [
    {
      title: 'Категория',
      key: 'name',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Space size={8}>
            <strong>{c.name}</strong>
            {c.builtin ? <Tag color="blue">служебная</Tag> : null}
            {c.custom ? <Tag>своя</Tag> : null}
          </Space>
          {c.source_name && c.source_name !== c.name ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {`у провайдера: ${c.source_name}`}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: 'Каналов',
      key: 'channels',
      width: 130,
      render: (_, c) => (c.builtin
        ? <Typography.Text type="secondary">инфоканал</Typography.Text>
        : `${c.channels_enabled} / ${c.channels}`),
    },
    {
      // A category nobody sells is invisible to every customer, however enabled
      // it is — the most common "why can't they see it?" cause.
      title: 'В тарифах',
      key: 'plans',
      width: 150,
      render: (_, c) => {
        if (c.builtin) return <Typography.Text type="secondary">во всех</Typography.Text>;
        if (!c.plans) return <Tag color="orange">ни в одном</Tag>;
        return `${c.plans} из ${(catalog?.plans || []).length}`;
      },
    },
    {
      title: 'Включена',
      key: 'enabled',
      width: 110,
      render: (_, c) => (
        <Switch
          checked={c.enabled}
          disabled={c.builtin}
          onChange={(enabled) => guarded(
            () => api.patch(`/admin/api/catalog/categories/${c.id}`, { enabled }),
            enabled ? `Категория «${c.name}» включена` : `Категория «${c.name}» выключена`,
          )}
        />
      ),
    },
    {
      title: 'Порядок',
      key: 'order',
      width: 100,
      render: (_, c, index) => (
        <Space size={4}>
          <Button size="small" disabled={c.builtin || index <= 1} onClick={() => move(index, -1)}>↑</Button>
          <Button size="small" disabled={c.builtin || index === categories.length - 1} onClick={() => move(index, 1)}>↓</Button>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      render: (_, c) => (
        <Space>
          <Button size="small" onClick={() => openDialog(c)}>Переименовать</Button>
          {c.builtin ? null : (
            <>
              <Button size="small" onClick={onOpenChannels}>Каналы</Button>
              <Popconfirm
                title={`Удалить категорию «${c.name}»?`}
                description={`Вместе с ней будут удалены каналы: ${c.channels}. Они вернутся при следующей загрузке источника.`}
                okText="Удалить"
                okButtonProps={{ danger: true }}
                onConfirm={() => guarded(() => api.del(`/admin/api/catalog/categories/${c.id}`), 'Категория удалена')}
              >
                <Button size="small" danger>Удалить</Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="Категории"
      extra={<Button type="primary" onClick={() => openDialog(null)}>+ Своя категория</Button>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="«Информация» — служебная категория с вашим инфоканалом."
        description="Её нельзя удалить или выключить: именно она остаётся у клиента, когда подписка заканчивается. Переименовать можно."
      />
      {catalog?.totals?.unsoldCategories ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Категорий не входит ни в один тариф: ${catalog.totals.unsoldCategories}`}
          description="Такие категории не увидит ни один клиент, даже если они включены. Добавьте их в нужные тарифы в разделе «Тарифы»."
        />
      ) : null}
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={categories}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'Категорий нет — загрузите источник во вкладке «Источники».' }}
      />

      <Modal
        open={open}
        title={editing ? 'Переименовать категорию' : 'Новая категория'}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Укажите название' }, { max: 80 }]}>
            <Input placeholder="Спорт" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
