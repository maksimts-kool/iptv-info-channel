import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag,
  Typography,
} from 'antd';
import { AuthError } from '../lib/api.js';

// The channel list. A provider playlist is routinely tens of thousands of rows,
// so filtering and paging happen on the server (/admin/api/catalog/channels) and
// only one page is ever in the browser. Bulk actions can therefore target either
// the checked rows or "everything matching the current filter" — the latter is
// sent as the filter itself, not as a list of ids.
export default function ChannelsPanel({
  api, message, onAuthError, catalog, refresh,
}) {
  const [filter, setFilter] = useState({ q: '', category: '', source: '', status: 'all' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [editing, setEditing] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [addForm] = Form.useForm();

  const categories = catalog?.categories || [];
  const categoryName = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );
  const sourceName = useMemo(
    () => new Map((catalog?.sources || []).map((s) => [s.id, s.name])),
    [catalog?.sources],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: filter.q, category: filter.category, source: filter.source,
        status: filter.status, page: String(page), pageSize: String(pageSize),
      });
      setData(await api.get(`/admin/api/catalog/channels?${params}`));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, filter, page, pageSize, message, onAuthError]);

  useEffect(() => { load(); }, [load]);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setFilter((f) => (f.q === search ? f : { ...f, q: search }));
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const guarded = async (fn, ok) => {
    try {
      await fn();
      if (ok) message.success(ok);
      await load();
      await refresh();
      return true;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
      return false;
    }
  };

  const patchOne = (id, fields, ok) => guarded(
    () => api.patch(`/admin/api/catalog/channels/${id}`, fields), ok,
  );

  // `scope: 'filter'` hands the server the current filter instead of ids, so
  // "disable all N results" works without shipping N ids from a paged table.
  const bulk = async (fields, scope) => {
    const body = scope === 'filter'
      ? { ...fields, filter: { ...filter, page: 1, pageSize: 1 } }
      : { ...fields, ids: selected };
    const ok = await guarded(async () => {
      const res = await api.post('/admin/api/catalog/channels/bulk', body);
      message.success(`Изменено каналов: ${res.changed}`);
    });
    if (ok) setSelected([]);
  };

  const openEdit = (channel) => {
    setEditing(channel);
    form.setFieldsValue({ name: channel.name, category_id: channel.category_id });
  };

  const saveEdit = async () => {
    const v = await form.validateFields();
    const ok = await patchOne(editing.id, {
      name: v.name.trim(), category_id: v.category_id,
    }, 'Канал сохранён');
    if (ok) setEditing(null);
  };

  const saveNew = async () => {
    const v = await addForm.validateFields();
    const ok = await guarded(() => api.post('/admin/api/catalog/channels', {
      name: v.name.trim(), url: v.url.trim(), category_id: v.category_id,
    }), 'Канал добавлен');
    if (ok) { setAddOpen(false); addForm.resetFields(); }
  };

  const categoryOptions = categories.map((c) => ({ value: c.id, label: c.name }));

  const columns = [
    {
      title: 'Канал',
      key: 'name',
      render: (_, ch) => (
        <Space size={10}>
          {ch.logo ? (
            <img src={ch.logo} alt="" width={28} height={28} style={{ objectFit: 'contain', borderRadius: 4 }} />
          ) : null}
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <strong>{ch.name}</strong>
              {ch.builtin ? <Tag color="blue">инфоканал</Tag> : null}
              {ch.custom ? <Tag>своя</Tag> : null}
              {ch.missing ? <Tag color="red">нет у провайдера</Tag> : null}
            </Space>
            {ch.renamed ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {`было: ${ch.original_name}`}
              </Typography.Text>
            ) : null}
          </Space>
        </Space>
      ),
    },
    {
      title: 'Категория',
      key: 'category',
      width: 220,
      render: (_, ch) => (
        <Select
          size="small"
          style={{ width: 200 }}
          value={ch.category_id}
          options={categoryOptions}
          onChange={(category_id) => patchOne(ch.id, { category_id })}
        />
      ),
    },
    {
      title: 'Источник',
      key: 'source',
      width: 140,
      render: (_, ch) => (
        <Typography.Text type="secondary">
          {ch.builtin ? 'этот сервер' : (sourceName.get(ch.source_id) || 'вручную')}
        </Typography.Text>
      ),
    },
    {
      title: 'В эфире',
      key: 'enabled',
      width: 90,
      render: (_, ch) => (
        <Switch
          size="small"
          checked={ch.enabled}
          disabled={ch.builtin}
          onChange={(enabled) => patchOne(ch.id, { enabled })}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 170,
      render: (_, ch) => (
        <Space>
          <Button size="small" onClick={() => openEdit(ch)}>Изменить</Button>
          {ch.builtin ? null : (
            <Popconfirm
              title="Удалить канал из каталога?"
              description="Импортированный канал вернётся при следующей загрузке источника."
              okText="Удалить"
              okButtonProps={{ danger: true }}
              onConfirm={() => guarded(() => api.del(`/admin/api/catalog/channels/${ch.id}`), 'Канал удалён')}
            >
              <Button size="small" danger>Удалить</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const filtered = filter.q || filter.category || filter.source || filter.status !== 'all';

  return (
    <Card
      title="Каналы"
      extra={(
        <Button type="primary" disabled={!categories.length} onClick={() => setAddOpen(true)}>
          + Добавить канал
        </Button>
      )}
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          allowClear
          placeholder="Поиск по названию"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
        <Select
          style={{ width: 220 }}
          value={filter.category}
          onChange={(category) => { setFilter((f) => ({ ...f, category })); setPage(1); }}
          options={[{ value: '', label: 'Все категории' }, ...categoryOptions]}
        />
        <Select
          style={{ width: 180 }}
          value={filter.source}
          onChange={(source) => { setFilter((f) => ({ ...f, source })); setPage(1); }}
          options={[
            { value: '', label: 'Все источники' },
            ...(catalog?.sources || []).map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Select
          style={{ width: 190 }}
          value={filter.status}
          onChange={(status) => { setFilter((f) => ({ ...f, status })); setPage(1); }}
          options={[
            { value: 'all', label: 'Все' },
            { value: 'enabled', label: 'Только в эфире' },
            { value: 'disabled', label: 'Только выключенные' },
            { value: 'missing', label: 'Пропали у провайдера' },
          ]}
        />
      </Space>

      {selected.length ? (
        <Alert
          type="info"
          style={{ marginBottom: 16 }}
          message={(
            <Space wrap>
              <span>{`Выбрано: ${selected.length}`}</span>
              <Button size="small" onClick={() => bulk({ enabled: true }, 'ids')}>Включить</Button>
              <Button size="small" onClick={() => bulk({ enabled: false }, 'ids')}>Выключить</Button>
              <Select
                size="small"
                style={{ width: 200 }}
                placeholder="Перенести в категорию"
                value={null}
                options={categoryOptions}
                onChange={(category_id) => bulk({ category_id }, 'ids')}
              />
              <Button size="small" type="link" onClick={() => setSelected([])}>Снять выделение</Button>
            </Space>
          )}
        />
      ) : null}

      {filtered && data.total > data.rows.length ? (
        <Alert
          type="warning"
          style={{ marginBottom: 16 }}
          message={(
            <Space wrap>
              <span>{`Под фильтр попадает каналов: ${data.total}`}</span>
              <Popconfirm
                title={`Включить все ${data.total} каналов?`}
                okText="Включить"
                onConfirm={() => bulk({ enabled: true }, 'filter')}
              >
                <Button size="small">Включить все</Button>
              </Popconfirm>
              <Popconfirm
                title={`Выключить все ${data.total} каналов?`}
                okText="Выключить"
                okButtonProps={{ danger: true }}
                onConfirm={() => bulk({ enabled: false }, 'filter')}
              >
                <Button size="small" danger>Выключить все</Button>
              </Popconfirm>
            </Space>
          )}
        />
      ) : null}

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: 'max-content' }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          getCheckboxProps: (ch) => ({ disabled: ch.builtin }),
        }}
        pagination={{
          current: page,
          pageSize,
          total: data.total,
          showSizeChanger: true,
          pageSizeOptions: [25, 50, 100, 200],
          showTotal: (total) => `всего ${total}`,
          onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); },
        }}
        locale={{
          emptyText: catalog?.totals?.channels
            ? 'Ничего не найдено по этому фильтру.'
            : 'Каналов пока нет — добавьте источник во вкладке «Источники».',
        }}
      />

      <Modal
        open={!!editing}
        title={`Канал: ${editing?.original_name || editing?.name || ''}`}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={saveEdit}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Название в плейлисте" rules={[{ required: true, message: 'Укажите название' }, { max: 160 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category_id" label="Категория" rules={[{ required: true }]}>
            <Select options={categoryOptions} />
          </Form.Item>
          {editing?.url ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {`Поток: ${editing.url}`}
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={addOpen}
        title="Добавить канал вручную"
        okText="Добавить"
        cancelText="Отмена"
        onOk={saveNew}
        onCancel={() => setAddOpen(false)}
        forceRender
      >
        <Form form={addForm} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Укажите название' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="url" label="Ссылка на поток" rules={[{ required: true, message: 'Укажите ссылку' }]}>
            <Input placeholder="http://…/stream.m3u8" />
          </Form.Item>
          <Form.Item name="category_id" label="Категория" rules={[{ required: true, message: 'Выберите категорию' }]}>
            <Select options={categoryOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
