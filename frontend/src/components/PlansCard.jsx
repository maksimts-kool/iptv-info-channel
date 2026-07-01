import { useState } from 'react';
import {
  Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Typography,
} from 'antd';

const periodSuffix = (p) => (p === 'month' ? '/мес.' : p === 'year' ? '/год' : '');

export default function PlansCard({ state, api, withRegen }) {
  const plans = state?.plans || [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const openDialog = (plan) => {
    setEditing(plan || null);
    form.setFieldsValue({
      name: plan?.name || '',
      price_eur: plan ? plan.price_cents / 100 : null,
      billing_period: plan?.billing_period || '',
      features: (plan?.features || []).join('\n'),
    });
    setOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    const payload = {
      name: v.name.trim(),
      price_eur: Number(v.price_eur),
      billing_period: v.billing_period || '',
      features: (v.features || '').split('\n').map((s) => s.trim()).filter(Boolean),
    };
    await withRegen(
      'Saving plan and rebuilding streams',
      async () => {
        if (editing) await api.patch(`/admin/api/plans/${editing.id}`, payload);
        else await api.post('/admin/api/plans', payload);
        setOpen(false);
      },
      { success: 'Plan saved — streams rebuilding' },
    );
  };

  const remove = (plan) => withRegen(
    'Deleting plan and rebuilding streams',
    () => api.del(`/admin/api/plans/${plan.id}`),
    { success: 'Plan deleted — streams rebuilding' },
  );

  return (
    <Card
      title="Plans & pricing"
      extra={<Button type="primary" onClick={() => openDialog(null)}>+ Add plan</Button>}
    >
      {plans.length ? (
        <Row gutter={[16, 16]}>
          {plans.map((p) => (
            <Col key={p.id} xs={24} sm={12} lg={8}>
              <Card
                size="small"
                style={{ height: '100%' }}
                title={(
                  <Space direction="vertical" size={0}>
                    <span>{p.name}</span>
                    <Typography.Text type="secondary">{`${p.price}${periodSuffix(p.billing_period)}`}</Typography.Text>
                  </Space>
                )}
                extra={(
                  <Space>
                    <Button size="small" onClick={() => openDialog(p)}>Edit</Button>
                    <Popconfirm
                      title={`Delete plan "${p.name}"?`}
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => remove(p)}
                    >
                      <Button size="small" danger>Delete</Button>
                    </Popconfirm>
                  </Space>
                )}
              >
                {p.features?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {p.features.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                ) : <Typography.Text type="secondary">No features added</Typography.Text>}
              </Card>
            </Col>
          ))}
        </Row>
      ) : <Empty description="No plans yet. Add one to make it available to users." />}

      <Modal
        open={open}
        title={editing ? 'Edit plan' : 'Add plan'}
        okText="Save"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Plan name" rules={[{ required: true, message: 'Plan name required' }, { max: 80 }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="price_eur" label="Price (EUR)" rules={[{ required: true, message: 'Valid price required' }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="billing_period" label="Billing period">
            <Select
              options={[
                { value: '', label: 'One-time / no period' },
                { value: 'month', label: 'Monthly (/мес.)' },
                { value: 'year', label: 'Yearly (/год)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="features" label="Features, one per line">
            <Input.TextArea rows={6} maxLength={1200} placeholder={'Sport channels\nEstonian channels'} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
