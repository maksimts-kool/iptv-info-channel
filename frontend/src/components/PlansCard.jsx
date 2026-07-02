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
      'Сохранение тарифа и пересборка потоков',
      async () => {
        if (editing) await api.patch(`/admin/api/plans/${editing.id}`, payload);
        else await api.post('/admin/api/plans', payload);
        setOpen(false);
      },
      { success: 'Тариф сохранён — потоки пересобираются' },
    );
  };

  const remove = (plan) => withRegen(
    'Удаление тарифа и пересборка потоков',
    () => api.del(`/admin/api/plans/${plan.id}`),
    { success: 'Тариф удалён — потоки пересобираются' },
  );

  return (
    <Card
      title="Тарифы и цены"
      extra={<Button type="primary" onClick={() => openDialog(null)}>+ Добавить тариф</Button>}
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
                    <Button size="small" onClick={() => openDialog(p)}>Изменить</Button>
                    <Popconfirm
                      title={`Удалить тариф «${p.name}»?`}
                      okText="Удалить"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => remove(p)}
                    >
                      <Button size="small" danger>Удалить</Button>
                    </Popconfirm>
                  </Space>
                )}
              >
                {p.features?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {p.features.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                ) : <Typography.Text type="secondary">Пункты не добавлены</Typography.Text>}
              </Card>
            </Col>
          ))}
        </Row>
      ) : <Empty description="Тарифов пока нет. Добавьте тариф, чтобы он стал доступен пользователям." />}

      <Modal
        open={open}
        title={editing ? 'Изменить тариф' : 'Добавить тариф'}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Название тарифа" rules={[{ required: true, message: 'Укажите название' }, { max: 80 }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="price_eur" label="Цена (EUR)" rules={[{ required: true, message: 'Укажите корректную цену' }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="billing_period" label="Период оплаты">
            <Select
              options={[
                { value: '', label: 'Разовый / без периода' },
                { value: 'month', label: 'Ежемесячно (/мес.)' },
                { value: 'year', label: 'Ежегодно (/год)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="features" label="Пункты, по одному на строку">
            <Input.TextArea rows={6} maxLength={1200} placeholder={'Спортивные каналы\nЭстонские каналы'} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
