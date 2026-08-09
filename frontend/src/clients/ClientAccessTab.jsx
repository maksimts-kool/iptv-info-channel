import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Input, Popconfirm, Segmented, Select, Space, Spin, Table, Tag, Typography,
} from 'antd';
import { AuthError } from '../lib/api.js';

// Per-customer channel access.
//
// A category's visibility has three layers, shown as three columns: what the
// customer's PLAN grants, this customer's personal pin (if any), and the
// effective result. A pin is the exception — it can take away a category the
// plan includes, or grant one it doesn't — and "По тарифу" clears it so the row
// follows the plan again.
const PIN_OPTIONS = [
  { value: 'default', label: 'По тарифу' },
  { value: 'on', label: 'Выдать' },
  { value: 'off', label: 'Забрать' },
];

const pinValue = (override) => (override === true ? 'on' : override === false ? 'off' : 'default');
const pinPayload = (value) => (value === 'on' ? true : value === 'off' ? false : null);

export default function ClientAccessTab({ user, api, message, onAuthError, reload }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState('categories');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: query, category, page: String(page), pageSize: '50',
      });
      setData(await api.get(`/admin/api/users/${user.id}/channels?${params}`));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, user.id, query, category, page, message, onAuthError]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setTimeout(() => { setQuery(search); setPage(1); }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const patch = async (body, ok) => {
    setSaving(true);
    try {
      await api.patch(`/admin/api/users/${user.id}/channels`, body);
      if (ok) message.success(ok);
      await load();
      // The client list shows a "personal rules" badge fed by /api/state.
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const resetAll = async () => {
    setSaving(true);
    try {
      await api.post(`/admin/api/users/${user.id}/channels/reset`);
      message.success('Персональные правила сброшены');
      await load();
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <Spin />;
  if (!data) return null;

  const effectiveTag = (row) => (row.effective
    ? <Tag color="green">видит</Tag>
    : <Tag>не видит</Tag>);

  const categoryColumns = [
    {
      title: 'Категория',
      key: 'name',
      render: (_, c) => (
        <Space size={6}>
          <strong>{c.name}</strong>
          {c.builtin ? <Tag color="blue">служебная</Tag> : null}
        </Space>
      ),
    },
    {
      title: 'Каналов',
      key: 'channels',
      width: 110,
      render: (_, c) => (c.builtin ? '—' : `${c.channels_enabled} / ${c.channels}`),
    },
    {
      title: 'В тарифе',
      key: 'plan',
      width: 130,
      render: (_, c) => {
        if (c.builtin) return <Typography.Text type="secondary">всегда</Typography.Text>;
        if (!c.global_enabled) return <Tag color="default">выключена</Tag>;
        return c.in_plan
          ? <Typography.Text type="success">входит</Typography.Text>
          : <Typography.Text type="secondary">не входит</Typography.Text>;
      },
    },
    // The dropdown is the whole control. There used to be a switch beside it
    // doing the same job in fewer words, which just meant two widgets that could
    // disagree on screen — "Выдать/Забрать/По тарифу" says what a switch can't.
    {
      title: 'Исключение для клиента',
      key: 'pin',
      width: 210,
      render: (_, c) => (
        <Select
          size="small"
          style={{ width: 190 }}
          disabled={c.builtin || saving}
          value={pinValue(c.override)}
          options={PIN_OPTIONS}
          onChange={(v) => patch({ categories: { [c.id]: pinPayload(v) } })}
        />
      ),
    },
    { title: 'Итог', key: 'effective', width: 100, render: (_, c) => effectiveTag(c) },
  ];

  const channelColumns = [
    {
      title: 'Канал',
      key: 'name',
      render: (_, ch) => (
        <Space direction="vertical" size={0}>
          <strong>{ch.name}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data.categories.find((c) => c.id === ch.category_id)?.name || ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Глобально',
      key: 'global',
      width: 110,
      render: (_, ch) => (ch.global_enabled
        ? <Typography.Text type="success">в эфире</Typography.Text>
        : <Typography.Text type="secondary">выключен</Typography.Text>),
    },
    {
      title: 'Для этого клиента',
      key: 'pin',
      width: 210,
      render: (_, ch) => (
        <Select
          size="small"
          style={{ width: 190 }}
          disabled={ch.builtin || saving}
          value={pinValue(ch.override)}
          options={PIN_OPTIONS}
          onChange={(v) => patch({ channels: { [ch.id]: pinPayload(v) } })}
        />
      ),
    },
    { title: 'Итог', key: 'effective', width: 100, render: (_, ch) => effectiveTag(ch) },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {data.locked ? (
        <Alert
          type="warning"
          showIcon
          message="Подписка неактивна — клиент сейчас видит только «Информация»"
          description="Настройки ниже сохраняются и вступят в силу сразу после продления. Ничего сбрасывать не нужно."
        />
      ) : null}

      <Typography.Text type="secondary">
        Базу даёт тариф клиента. Здесь настраиваются только исключения: «Выдать» —
        добавить категорию сверх тарифа, «Забрать» — убрать входящую в тариф.
      </Typography.Text>

      {!data.locked && data.plan && !data.plan.categories.length ? (
        <Alert
          type="warning"
          showIcon
          message={`В тарифе «${data.plan.name}» не выбрано ни одной категории`}
          description="Поэтому клиент видит только «Информация». Добавьте категории в тариф (раздел «Тарифы») либо выдайте их этому клиенту персонально ниже."
        />
      ) : null}

      <Space wrap>
        <Typography.Text type="secondary">
          {`Каналов у клиента: ${data.visibleCount}`}
        </Typography.Text>
        {data.plan ? (
          <Tag>{`тариф: ${data.plan.name} · категорий ${data.plan.categories.length}`}</Tag>
        ) : null}
        {data.overrideCount ? (
          <>
            <Tag color="purple">{`исключений: ${data.overrideCount}`}</Tag>
            <Popconfirm
              title="Сбросить все персональные исключения?"
              description="Клиент вернётся к тому, что даёт его тариф."
              okText="Сбросить"
              onConfirm={resetAll}
            >
              <Button size="small">Сбросить</Button>
            </Popconfirm>
          </>
        ) : <Typography.Text type="secondary">исключений нет — ровно по тарифу</Typography.Text>}
      </Space>

      <Segmented
        value={view}
        onChange={setView}
        options={[
          { value: 'categories', label: 'Категории' },
          { value: 'channels', label: 'Отдельные каналы' },
        ]}
      />

      {view === 'categories' ? (
        <Table
          rowKey="id"
          size="small"
          loading={saving}
          columns={categoryColumns}
          dataSource={data.categories}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      ) : (
        <>
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="Поиск по названию"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 240 }}
            />
            <Select
              style={{ width: 220 }}
              value={category}
              onChange={(v) => { setCategory(v); setPage(1); }}
              options={[
                { value: '', label: 'Все категории' },
                ...data.categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </Space>
          <Table
            rowKey="id"
            size="small"
            loading={loading || saving}
            columns={channelColumns}
            dataSource={data.channels.rows}
            scroll={{ x: 'max-content' }}
            pagination={{
              current: data.channels.page,
              pageSize: data.channels.pageSize,
              total: data.channels.total,
              showSizeChanger: false,
              showTotal: (total) => `всего ${total}`,
              onChange: setPage,
            }}
          />
        </>
      )}
    </Space>
  );
}
