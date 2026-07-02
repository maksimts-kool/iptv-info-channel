import { useState } from 'react';
import {
  Button, Card, Empty, Form, Grid, Input, List, Modal, Popconfirm, Select, Space, Tag, Tooltip, Typography,
} from 'antd';

const SEV = {
  degraded: { label: 'Деградация', color: '#d97706' },
  outage: { label: 'Сбой', color: '#dc2626' },
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatPct(pct) {
  return Number.isInteger(pct) ? `${pct}%` : `${String(pct).replace('.', ',')}%`;
}

function incidentRangeText(inc) {
  if (inc.ongoing) return `с ${inc.starts_pretty} · идёт`;
  if (inc.ends_pretty && inc.ends_pretty !== inc.starts_pretty) {
    return `${inc.starts_pretty} — ${inc.ends_pretty}`;
  }
  return inc.starts_pretty;
}

function Dot({ color }) {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, marginRight: 8,
    }}
    />
  );
}

export default function IncidentsCard({ state, api, withRegen }) {
  const incidents = state?.incidents || [];
  const status = state?.status;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const screens = Grid.useBreakpoint();
  const isMobile = !screens.sm; // < 576px
  const compact = !screens.md; // < 768px — header/actions restack

  const statusEl = status ? (
    <span style={{ whiteSpace: 'nowrap' }}>
      <Dot color={status.color} />
      {`${status.label} · ${formatPct(status.uptimePct)} аптайм`}
    </span>
  ) : null;

  // Keep the strip a single clean row on every device: fewer days on small
  // screens, and let each bar flex-fill the available width.
  const maxDays = isMobile ? 30 : compact ? 60 : 90;
  const days = (status?.days || []).slice(-maxDays);

  const openDialog = (inc) => {
    setEditing(inc || null);
    form.setFieldsValue({
      title: inc?.title || '',
      severity: inc?.severity || 'degraded',
      starts_on: inc?.starts_on || todayISO(),
      ends_on: inc?.ends_on || '',
      note: inc?.note || '',
    });
    setOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    if (v.ends_on && v.ends_on < v.starts_on) {
      form.setFields([{ name: 'ends_on', errors: ['Дата окончания раньше даты начала'] }]);
      return;
    }
    const payload = {
      title: v.title.trim(),
      severity: v.severity,
      starts_on: v.starts_on || null,
      ends_on: v.ends_on || null,
      note: (v.note || '').trim(),
    };
    await withRegen(
      'Сохранение инцидента и пересборка потоков',
      async () => {
        if (editing) await api.patch(`/admin/api/incidents/${editing.id}`, payload);
        else await api.post('/admin/api/incidents', payload);
        setOpen(false);
      },
      { success: 'Инцидент сохранён — потоки пересобираются' },
    );
  };

  const resolve = (inc) => withRegen(
    'Закрытие инцидента и пересборка потоков',
    () => api.patch(`/admin/api/incidents/${inc.id}`, { ends_on: todayISO() }),
    { success: 'Инцидент закрыт — потоки пересобираются' },
  );

  const remove = (inc) => withRegen(
    'Удаление инцидента и пересборка потоков',
    () => api.del(`/admin/api/incidents/${inc.id}`),
    { success: 'Инцидент удалён — потоки пересобираются' },
  );

  return (
    <Card
      title="Статус сервиса"
      extra={(
        <Space size="middle">
          {statusEl && !compact ? statusEl : null}
          <Button type="primary" onClick={() => openDialog(null)}>
            {isMobile ? '+ Инцидент' : '+ Добавить инцидент'}
          </Button>
        </Space>
      )}
    >
      {statusEl && compact ? (
        <div style={{ marginBottom: 12 }}>{statusEl}</div>
      ) : null}

      {days.length ? (
        <div
          style={{ display: 'flex', gap: 2, marginBottom: 16 }}
          title={`Последние ${maxDays} дней`}
        >
          {days.map((d) => (
            <Tooltip key={d.date} title={d.date}>
              <span style={{
                flex: '1 1 0', minWidth: 3, height: 22, borderRadius: 2, background: d.color,
              }}
              />
            </Tooltip>
          ))}
        </div>
      ) : null}

      {incidents.length ? (
        <List
          dataSource={incidents}
          renderItem={(inc) => {
            const sev = SEV[inc.severity] || SEV.degraded;
            const actionButtons = [
              inc.ongoing ? (
                <Popconfirm key="resolve" title="Закрыть инцидент?" okText="Закрыть" onConfirm={() => resolve(inc)}>
                  <Button size="small">Закрыть</Button>
                </Popconfirm>
              ) : null,
              <Button key="edit" size="small" onClick={() => openDialog(inc)}>Изменить</Button>,
              <Popconfirm
                key="delete"
                title={`Удалить инцидент «${inc.title}»?`}
                okText="Удалить"
                okButtonProps={{ danger: true }}
                onConfirm={() => remove(inc)}
              >
                <Button size="small" danger>Удалить</Button>
              </Popconfirm>,
            ].filter(Boolean);
            const meta = (
              <List.Item.Meta
                avatar={<Tag color={sev.color} style={{ marginTop: 4 }}>{sev.label}</Tag>}
                title={inc.title}
                description={(
                  <Typography.Text type="secondary">
                    {incidentRangeText(inc)}
                    {inc.note ? ` · ${inc.note}` : ''}
                  </Typography.Text>
                )}
              />
            );
            // On wide screens keep AntD's right-aligned action row; on narrow
            // screens stack the buttons under the content so nothing overflows.
            if (compact) {
              return (
                <List.Item>
                  <div style={{ width: '100%' }}>
                    {meta}
                    <Space wrap style={{ marginTop: 8 }}>{actionButtons}</Space>
                  </div>
                </List.Item>
              );
            }
            return <List.Item actions={actionButtons}>{meta}</List.Item>;
          }}
        />
      ) : (
        <Empty description="Активных инцидентов нет. Добавьте инцидент — он появится на слайде статуса и в полосе аптайма." />
      )}

      <Modal
        open={open}
        title={editing ? 'Изменить инцидент' : 'Добавить инцидент'}
        okText="Сохранить"
        onOk={save}
        onCancel={() => setOpen(false)}
        style={{ maxWidth: '94vw' }}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="Заголовок" rules={[{ required: true, message: 'Укажите заголовок' }, { max: 100 }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="severity" label="Уровень">
            <Select
              options={[
                { value: 'degraded', label: 'Деградация (жёлтый)' },
                { value: 'outage', label: 'Сбой (красный)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="starts_on" label="Дата начала" rules={[{ required: true, message: 'Укажите дату начала' }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="ends_on" label="Дата окончания — пусто = продолжается">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="note" label="Заметка (необязательно)">
            <Input.TextArea rows={3} maxLength={280} placeholder="Короткое описание" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
