import { useState } from 'react';
import {
  Button, Card, Empty, Form, Input, List, Modal, Popconfirm, Select, Space, Tag, Tooltip, Typography,
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
      form.setFields([{ name: 'ends_on', errors: ['End date is before start date'] }]);
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
      'Saving incident and rebuilding streams',
      async () => {
        if (editing) await api.patch(`/admin/api/incidents/${editing.id}`, payload);
        else await api.post('/admin/api/incidents', payload);
        setOpen(false);
      },
      { success: 'Incident saved — streams rebuilding' },
    );
  };

  const resolve = (inc) => withRegen(
    'Resolving incident and rebuilding streams',
    () => api.patch(`/admin/api/incidents/${inc.id}`, { ends_on: todayISO() }),
    { success: 'Incident resolved — streams rebuilding' },
  );

  const remove = (inc) => withRegen(
    'Deleting incident and rebuilding streams',
    () => api.del(`/admin/api/incidents/${inc.id}`),
    { success: 'Incident deleted — streams rebuilding' },
  );

  return (
    <Card
      title="Статус сервиса · status board"
      extra={(
        <Space size="middle">
          {status ? (
            <span>
              <Dot color={status.color} />
              {`${status.label} · ${formatPct(status.uptimePct)} аптайм`}
            </span>
          ) : null}
          <Button type="primary" onClick={() => openDialog(null)}>+ Add incident</Button>
        </Space>
      )}
    >
      {status?.days?.length ? (
        <div style={{ display: 'flex', gap: 2, marginBottom: 16, flexWrap: 'wrap' }} title="Последние 90 дней">
          {status.days.map((d) => (
            <Tooltip key={d.date} title={d.date}>
              <span style={{
                display: 'inline-block', width: 6, height: 22, borderRadius: 2, background: d.color,
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
            return (
              <List.Item
                actions={[
                  inc.ongoing ? (
                    <Popconfirm key="resolve" title="Resolve this incident?" okText="Resolve" onConfirm={() => resolve(inc)}>
                      <Button size="small">Resolve</Button>
                    </Popconfirm>
                  ) : null,
                  <Button key="edit" size="small" onClick={() => openDialog(inc)}>Edit</Button>,
                  <Popconfirm
                    key="delete"
                    title={`Delete incident "${inc.title}"?`}
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove(inc)}
                  >
                    <Button size="small" danger>Delete</Button>
                  </Popconfirm>,
                ].filter(Boolean)}
              >
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
              </List.Item>
            );
          }}
        />
      ) : (
        <Empty description="Активных инцидентов нет. Добавьте инцидент — он появится на слайде статуса и в полосе аптайма." />
      )}

      <Modal
        open={open}
        title={editing ? 'Edit incident' : 'Add incident'}
        okText="Save"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="Title" rules={[{ required: true, message: 'Title required' }, { max: 100 }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="severity" label="Severity">
            <Select
              options={[
                { value: 'degraded', label: 'Деградация (жёлтый)' },
                { value: 'outage', label: 'Сбой (красный)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="starts_on" label="Start date" rules={[{ required: true, message: 'Start date required' }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="ends_on" label="End date — blank = ongoing">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="note" label="Note (optional)">
            <Input.TextArea rows={3} maxLength={280} placeholder="Короткое описание" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
