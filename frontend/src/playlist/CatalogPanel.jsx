import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin,
  Switch, Table, Tag, Typography,
} from 'antd';
import {
  ArrowDownOutlined, ArrowUpOutlined, DownOutlined, EditOutlined, FolderOpenOutlined,
  PlusOutlined, RightOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';

// Categories and the channels inside them, as one structure: a category is a
// row you expand to see (and edit) its channels. They used to be two separate
// tabs, which meant answering "what is actually in Спорт?" took a tab switch
// plus a filter.
//
// A provider playlist is routinely tens of thousands of rows, so channels are
// never all in the browser at once: expanding a category fetches just that
// category's page from /admin/api/catalog/channels, and the search box switches
// the whole panel to a flat, server-filtered result list.
//
// Nothing here deletes an imported row. The next source refresh would bring it
// straight back, so the honest control is the on/off switch — only channels and
// categories created by hand can be removed, because nothing else can.

const PAGE_SIZE = 25;

export default function CatalogPanel({
  api, message, onAuthError, catalog, refresh,
}) {
  const [mode, setMode] = useState('tree'); // 'tree' | 'search'
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('');

  const [expanded, setExpanded] = useState([]);
  const [byCategory, setByCategory] = useState({}); // id -> { loading, page, total, rows }
  const [flat, setFlat] = useState({ loading: false, page: 1, total: 0, rows: [] });

  // Checked rows, per table: keyed 'flat' or 'cat:<id>' so two expanded
  // categories keep separate selections. `whole` upgrades a selection from "the
  // rows I ticked" to "everything in this scope", which is how a 68-channel
  // category is switched off without paging through it — the server gets the
  // filter rather than a list of ids.
  const [selected, setSelected] = useState({});
  const [whole, setWhole] = useState({});

  const [categoryModal, setCategoryModal] = useState(null); // null | {} | category
  const [channelModal, setChannelModal] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [categoryForm] = Form.useForm();
  const [channelForm] = Form.useForm();
  const [addForm] = Form.useForm();

  const categories = catalog?.categories || [];
  const sources = catalog?.sources || [];
  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.id, label: c.name })),
    [categories],
  );
  const sourceName = useMemo(
    () => new Map(sources.map((s) => [s.id, s.name])),
    [sources],
  );

  // Debounce the search box, and let a non-empty query switch to flat results.
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const filtering = !!query || status !== 'all' || !!source;
  useEffect(() => { setMode(filtering ? 'search' : 'tree'); }, [filtering]);

  const fetchChannels = useCallback(async (where) => {
    const params = new URLSearchParams({
      q: where.q || '',
      category: where.category || '',
      source: where.source || '',
      status: where.status || 'all',
      page: String(where.page || 1),
      pageSize: String(where.pageSize || PAGE_SIZE),
    });
    return api.get(`/admin/api/catalog/channels?${params}`);
  }, [api]);

  const guarded = useCallback(async (fn, ok) => {
    try {
      const result = await fn();
      if (ok) message.success(ok);
      return result ?? true;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
      return null;
    }
  }, [message, onAuthError]);

  // ---- tree mode: one page of channels per expanded category ----
  const loadCategory = useCallback(async (categoryId, page = 1) => {
    setByCategory((prev) => ({ ...prev, [categoryId]: { ...prev[categoryId], loading: true } }));
    const data = await guarded(() => fetchChannels({ category: categoryId, page }));
    setByCategory((prev) => ({
      ...prev,
      [categoryId]: data
        ? { loading: false, page, total: data.total, rows: data.rows }
        : { ...prev[categoryId], loading: false },
    }));
  }, [fetchChannels, guarded]);

  // ---- search mode: flat, server-filtered results ----
  const loadFlat = useCallback(async (page = 1) => {
    setFlat((prev) => ({ ...prev, loading: true }));
    const data = await guarded(() => fetchChannels({
      q: query, status, source, page, pageSize: 50,
    }));
    setFlat(data
      ? { loading: false, page, total: data.total, rows: data.rows }
      : { loading: false, page, total: 0, rows: [] });
  }, [fetchChannels, guarded, query, status, source]);

  useEffect(() => { if (mode === 'search') loadFlat(1); }, [mode, loadFlat]);

  // A new filter means the ticked ids are no longer on screen — drop them
  // rather than let a stale selection act on rows the admin can't see.
  useEffect(() => {
    setSelected((prev) => ({ ...prev, flat: [] }));
    setWhole((prev) => ({ ...prev, flat: false }));
  }, [query, status, source]);

  // Re-read whatever is on screen plus the catalog counts in the parent.
  const reloadVisible = useCallback(async () => {
    await refresh();
    if (mode === 'search') await loadFlat(flat.page);
    else {
      await Promise.all(expanded.map((id) => loadCategory(id, byCategory[id]?.page || 1)));
    }
  }, [refresh, mode, loadFlat, flat.page, expanded, byCategory, loadCategory]);

  const patchChannel = (id, fields, ok) => guarded(async () => {
    await api.patch(`/admin/api/catalog/channels/${id}`, fields);
    await reloadVisible();
  }, ok);

  const patchCategory = (id, fields, ok) => guarded(async () => {
    await api.patch(`/admin/api/catalog/categories/${id}`, fields);
    await reloadVisible();
  }, ok);

  // Open/close a category, loading its first page of channels on first open.
  // Bound to both the chevron and the category name, because AntD's default
  // expand affordance is a 16px glyph that is easy to miss and hard to hit.
  const isOpen = (categoryId) => expanded.includes(categoryId);
  const toggleCategory = (category, open) => {
    setExpanded((prev) => (open
      ? [...prev, category.id]
      : prev.filter((id) => id !== category.id)));
    if (open && !byCategory[category.id]) loadCategory(category.id, 1);
  };

  // ---- selection + bulk actions ----
  const picked = (key) => selected[key] || [];

  const changeSelection = (key, ids) => {
    setSelected((prev) => ({ ...prev, [key]: ids }));
    // Ticking rows by hand leaves "everything in this scope" mode.
    setWhole((prev) => (prev[key] ? { ...prev, [key]: false } : prev));
  };

  const clearSelection = (key) => {
    setSelected((prev) => ({ ...prev, [key]: [] }));
    setWhole((prev) => ({ ...prev, [key]: false }));
  };

  // What "everything here" means for a scope, as the server-side filter the
  // bulk endpoint accepts instead of a list of ids.
  const scopeFilter = (key) => (key === 'flat'
    ? { q: query, status, source }
    : { category: key.slice(4), status: 'all' });

  const bulk = (key, fields) => guarded(async () => {
    const res = await api.post('/admin/api/catalog/channels/bulk', whole[key]
      ? { ...fields, filter: scopeFilter(key) }
      : { ...fields, ids: picked(key) });
    message.success(`Изменено каналов: ${res.changed}`);
    clearSelection(key);
    await reloadVisible();
  });

  const move = (index, delta) => {
    const next = [...categories];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    guarded(async () => {
      await api.post('/admin/api/catalog/categories/reorder', { ids: next.map((c) => c.id) });
      await refresh();
    });
  };

  // ---- dialogs ----
  const openCategoryModal = (category) => {
    setCategoryModal(category || {});
    categoryForm.setFieldsValue({ name: category?.name || '' });
  };

  const saveCategory = async () => {
    const v = await categoryForm.validateFields();
    const ok = await guarded(async () => {
      if (categoryModal.id) {
        await api.patch(`/admin/api/catalog/categories/${categoryModal.id}`, { name: v.name.trim() });
      } else {
        await api.post('/admin/api/catalog/categories', { name: v.name.trim() });
      }
      await refresh();
    }, 'Категория сохранена');
    if (ok) setCategoryModal(null);
  };

  const openChannelModal = (channel) => {
    setChannelModal(channel);
    channelForm.setFieldsValue({ name: channel.name, category_id: channel.category_id });
  };

  const saveChannel = async () => {
    const v = await channelForm.validateFields();
    const ok = await patchChannel(channelModal.id, {
      name: v.name.trim(), category_id: v.category_id,
    }, 'Канал сохранён');
    if (ok) setChannelModal(null);
  };

  const openAddChannel = (categoryId) => {
    addForm.setFieldsValue({
      name: '',
      url: '',
      category_id: categoryId || categories.find((c) => !c.builtin)?.id,
    });
    setAddOpen(true);
  };

  const saveNewChannel = async () => {
    const v = await addForm.validateFields();
    const ok = await guarded(async () => {
      await api.post('/admin/api/catalog/channels', {
        name: v.name.trim(), url: v.url.trim(), category_id: v.category_id,
      });
      await reloadVisible();
    }, 'Канал добавлен');
    if (ok) { setAddOpen(false); addForm.resetFields(); }
  };

  // The bulk bar for one table, shown only once something is ticked. Bulk
  // switching is reversible, so it asks for confirmation only in "everything in
  // this scope" mode, where the count can run into the thousands.
  const bulkBar = (key, total, pageRows) => {
    const ids = picked(key);
    if (!ids.length) return null;
    const all = !!whole[key];
    const affected = all ? total : ids.length;
    const act = (label, fields, danger) => (all ? (
      <Popconfirm
        key={label}
        title={`${label}: каналов ${count(affected)}?`}
        okText={label}
        okButtonProps={{ danger }}
        onConfirm={() => bulk(key, fields)}
      >
        <Button size="small" danger={danger}>{label}</Button>
      </Popconfirm>
    ) : (
      <Button key={label} size="small" danger={danger} onClick={() => bulk(key, fields)}>
        {label}
      </Button>
    ));

    return (
      <Alert
        type="info"
        style={{ marginBottom: 12 }}
        message={(
          <Space wrap>
            <span>
              {all
                ? `Выбраны все каналы: ${count(total)}`
                : `Выбрано: ${count(ids.length)}`}
            </span>
            {act('В эфир', { enabled: true }, false)}
            {act('Из эфира', { enabled: false }, true)}
            <Select
              size="small"
              style={{ width: 210 }}
              placeholder="Перенести в категорию"
              value={null}
              options={categoryOptions}
              onChange={(category_id) => bulk(key, { category_id })}
            />
            {!all && total > pageRows ? (
              <Button
                size="small"
                type="link"
                onClick={() => setWhole((prev) => ({ ...prev, [key]: true }))}
              >
                {`Выбрать все ${count(total)}`}
              </Button>
            ) : null}
            <Button size="small" type="link" onClick={() => clearSelection(key)}>
              Снять выделение
            </Button>
          </Space>
        )}
      />
    );
  };

  // Ticking rows is how bulk changes are made; the info channel is not one of
  // the things that can be switched off, so it is not selectable.
  const rowSelection = (key) => ({
    selectedRowKeys: picked(key),
    onChange: (ids) => changeSelection(key, ids),
    getCheckboxProps: (ch) => ({ disabled: ch.builtin }),
  });

  // ---- channel table (shared by the expanded rows and the search results) ----
  const channelName = (ch) => (
    <Space size={10}>
      {ch.logo ? (
        <img src={ch.logo} alt="" width={26} height={26} style={{ objectFit: 'contain', borderRadius: 4 }} />
      ) : null}
      <Space direction="vertical" size={0}>
        <Space size={6}>
          <span>{ch.name}</span>
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
  );

  const channelColumns = (withCategory) => [
    { title: 'Канал', key: 'name', render: (_, ch) => channelName(ch) },
    ...(withCategory ? [{
      title: 'Категория',
      key: 'category',
      width: 220,
      render: (_, ch) => (
        <Select
          size="small"
          style={{ width: 200 }}
          disabled={ch.builtin}
          value={ch.category_id}
          options={categoryOptions}
          onChange={(category_id) => patchChannel(ch.id, { category_id })}
        />
      ),
    }] : []),
    {
      title: 'Источник',
      key: 'source',
      width: 130,
      render: (_, ch) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {ch.builtin ? 'этот сервер' : (sourceName.get(ch.source_id) || 'вручную')}
        </Typography.Text>
      ),
    },
    {
      title: 'В эфире',
      key: 'enabled',
      width: 84,
      render: (_, ch) => (
        <Switch
          size="small"
          checked={ch.enabled}
          disabled={ch.builtin}
          onChange={(enabled) => patchChannel(ch.id, { enabled })}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 130,
      render: (_, ch) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openChannelModal(ch)}>
            Изменить
          </Button>
          {/* Only a hand-made channel is deletable: an imported one comes back
              on the next refresh, so "выключить" is the real control. */}
          {ch.custom ? (
            <Popconfirm
              title="Удалить добавленный вручную канал?"
              okText="Удалить"
              okButtonProps={{ danger: true }}
              onConfirm={() => guarded(async () => {
                await api.del(`/admin/api/catalog/channels/${ch.id}`);
                await reloadVisible();
              }, 'Канал удалён')}
            >
              <Button size="small" danger>Удалить</Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  // ---- category (parent) rows ----
  const categoryColumns = [
    {
      title: 'Категория',
      key: 'name',
      render: (_, c) => {
        const open = isOpen(c.id);
        const label = (
          <Space size={8}>
            <FolderOpenOutlined style={{ color: c.enabled ? '#2563eb' : '#bfbfbf' }} />
            <strong>{c.name}</strong>
            {c.builtin ? <Tag color="blue">служебная</Tag> : null}
            {c.custom ? <Tag>своя</Tag> : null}
          </Space>
        );
        return (
          <Space direction="vertical" size={0}>
            {/* The whole name is the open/close control — a much larger target
                than the chevron, and it looks clickable. */}
            {c.builtin ? label : (
              <Button
                type="text"
                style={{
                  padding: '4px 8px', height: 'auto', marginInlineStart: -8, textAlign: 'left',
                }}
                aria-expanded={open}
                onClick={() => toggleCategory(c, !open)}
              >
                {label}
              </Button>
            )}
            {c.source_name && c.source_name !== c.name ? (
              <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 24 }}>
                {`у провайдера: ${c.source_name}`}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Каналов в эфире',
      key: 'channels',
      width: 150,
      render: (_, c) => (c.builtin
        ? <Typography.Text type="secondary">инфоканал</Typography.Text>
        : `${count(c.channels_enabled)} / ${count(c.channels)}`),
    },
    {
      // A category nobody sells is invisible to every customer, however enabled
      // it is — the most common "why can't they see it?" cause.
      title: 'В тарифах',
      key: 'plans',
      width: 140,
      render: (_, c) => {
        if (c.builtin) return <Typography.Text type="secondary">во всех</Typography.Text>;
        if (!c.plans) return <Tag color="orange">ни в одном</Tag>;
        return `${c.plans} из ${(catalog?.plans || []).length}`;
      },
    },
    {
      title: 'Включена',
      key: 'enabled',
      width: 100,
      render: (_, c) => (
        <Switch
          checked={c.enabled}
          disabled={c.builtin}
          onChange={(enabled) => patchCategory(
            c.id, { enabled },
            enabled ? `Категория «${c.name}» включена` : `Категория «${c.name}» выключена`,
          )}
        />
      ),
    },
    {
      title: 'Порядок',
      key: 'order',
      width: 90,
      render: (_, c, index) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={c.builtin || index <= 1}
            onClick={() => move(index, -1)}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            disabled={c.builtin || index === categories.length - 1}
            onClick={() => move(index, 1)}
          />
        </Space>
      ),
    },
    {
      // Just the rename here. Turning a lot of channels on or off is done by
      // ticking them in the list below (with "выбрать все N" for the whole
      // category) — a row-level "Все в эфир" acted on channels the row wasn't
      // even showing.
      title: '',
      key: 'actions',
      width: 160,
      render: (_, c) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openCategoryModal(c)}>
          Переименовать
        </Button>
      ),
    },
  ];

  // The channels of one expanded category.
  const expandedRow = (category) => {
    const state = byCategory[category.id];
    if (!state || (state.loading && !state.rows)) return <Spin style={{ margin: 16 }} />;
    const key = `cat:${category.id}`;
    return (
      <div style={{ padding: '8px 0 8px 24px' }}>
        <Space style={{ marginBottom: 8 }}>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => openAddChannel(category.id)}
          >
            Добавить канал сюда
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`каналов в категории: ${count(state.total)}`}
          </Typography.Text>
        </Space>
        {bulkBar(key, state.total, (state.rows || []).length)}
        <Table
          rowKey="id"
          size="small"
          loading={state.loading}
          columns={channelColumns(false)}
          dataSource={state.rows || []}
          scroll={{ x: 'max-content' }}
          rowSelection={rowSelection(key)}
          pagination={state.total > PAGE_SIZE ? {
            current: state.page,
            pageSize: PAGE_SIZE,
            total: state.total,
            size: 'small',
            showSizeChanger: false,
            showTotal: (total) => `всего ${count(total)}`,
            onChange: (page) => loadCategory(category.id, page),
          } : false}
          locale={{ emptyText: 'В этой категории пока нет каналов.' }}
        />
      </div>
    );
  };

  return (
    <Card
      title="Каналы и категории"
      extra={(
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={() => openCategoryModal(null)}>Категория</Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!categories.length}
            onClick={() => openAddChannel(null)}
          >
            Канал
          </Button>
        </Space>
      )}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="«Информация» — служебная категория с инфоканалом клиента."
        description="Её нельзя выключить: именно она остаётся у клиента, когда подписка заканчивается. Переименовать можно. Импортированные каналы и категории не удаляются — их достаточно выключить, иначе они вернутся при следующей загрузке источника."
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

      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          allowClear
          placeholder="Поиск канала по всему каталогу"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 280 }}
        />
        <Select
          style={{ width: 190 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'Все каналы' },
            { value: 'enabled', label: 'Только в эфире' },
            { value: 'disabled', label: 'Только выключенные' },
            { value: 'missing', label: 'Пропали у провайдера' },
          ]}
        />
        <Select
          style={{ width: 180 }}
          value={source}
          onChange={setSource}
          options={[
            { value: '', label: 'Все источники' },
            ...sources.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        {filtering ? (
          <Button onClick={() => { setSearch(''); setStatus('all'); setSource(''); }}>
            Сбросить фильтр
          </Button>
        ) : null}
      </Space>

      {mode === 'search' ? (
        <>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            {`Найдено каналов: ${count(flat.total)}`}
            {flat.total ? ' — отметьте нужные, чтобы включить, выключить или перенести их.' : ''}
          </Typography.Text>
          {bulkBar('flat', flat.total, flat.rows.length)}
          <Table
            rowKey="id"
            size="small"
            loading={flat.loading}
            columns={channelColumns(true)}
            dataSource={flat.rows}
            scroll={{ x: 'max-content' }}
            rowSelection={rowSelection('flat')}
            pagination={{
              current: flat.page,
              pageSize: 50,
              total: flat.total,
              showSizeChanger: false,
              showTotal: (total) => `всего ${count(total)}`,
              onChange: (page) => loadFlat(page),
            }}
            locale={{ emptyText: 'Ничего не найдено по этому фильтру.' }}
          />
        </>
      ) : categories.length ? (
        <Table
          rowKey="id"
          size="small"
          columns={categoryColumns}
          dataSource={categories}
          pagination={false}
          scroll={{ x: 'max-content' }}
          expandable={{
            expandedRowKeys: expanded,
            expandedRowRender: expandedRow,
            rowExpandable: (c) => !c.builtin,
            columnWidth: 56,
            onExpand: (open, category) => toggleCategory(category, open),
            // A full-size chevron button instead of AntD's small +/- glyph,
            // which was both hard to aim at and easy to overlook.
            expandIcon: ({ expanded: open, record }) => (record.builtin ? null : (
              <Button
                type="text"
                shape="circle"
                aria-label={open ? `Свернуть «${record.name}»` : `Развернуть «${record.name}»`}
                icon={open
                  ? <DownOutlined style={{ fontSize: 15 }} />
                  : <RightOutlined style={{ fontSize: 15 }} />}
                style={{ color: '#2563eb' }}
                onClick={(e) => { e.stopPropagation(); toggleCategory(record, !open); }}
              />
            )),
          }}
        />
      ) : (
        <Empty description="Категорий нет — загрузите источник во вкладке «Источники»." />
      )}

      <Modal
        open={!!categoryModal}
        title={categoryModal?.id ? 'Переименовать категорию' : 'Новая категория'}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={saveCategory}
        onCancel={() => setCategoryModal(null)}
        forceRender
      >
        <Form form={categoryForm} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Укажите название' }, { max: 80 }]}>
            <Input placeholder="Спорт" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!channelModal}
        title={`Канал: ${channelModal?.original_name || channelModal?.name || ''}`}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={saveChannel}
        onCancel={() => setChannelModal(null)}
        destroyOnClose
      >
        <Form form={channelForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Название в плейлисте" rules={[{ required: true, message: 'Укажите название' }, { max: 160 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category_id" label="Категория" rules={[{ required: true }]}>
            <Select options={categoryOptions} disabled={channelModal?.builtin} />
          </Form.Item>
          {channelModal?.url ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {`Поток: ${channelModal.url}`}
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={addOpen}
        title="Добавить канал вручную"
        okText="Добавить"
        cancelText="Отмена"
        onOk={saveNewChannel}
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
