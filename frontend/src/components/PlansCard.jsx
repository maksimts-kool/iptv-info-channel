import { useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row,
  Select, Space, Tag, Typography,
} from 'antd';
import { periodSuffix } from '../plans.js';

// A plan IS the channel package: the categories selected here are exactly what
// its customers receive, and the same list is printed on the info channel as
// "what you get". A plan with nothing selected sells nothing — its customers see
// only Информация — so that case is called out rather than left to be guessed.
export default function PlansCard({ state, api, withRegen, categories = [] }) {
  const plans = state?.plans || [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  // Информация is granted to everyone unconditionally, so it is not sellable.
  const sellable = categories.filter((c) => !c.builtin);
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const openDialog = (plan) => {
    setEditing(plan || null);
    form.setFieldsValue({
      name: plan?.name || '',
      price_eur: plan ? plan.price_cents / 100 : null,
      billing_period: plan?.billing_period || '',
      category_ids: plan?.category_ids || [],
    });
    setOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    const payload = {
      name: v.name.trim(),
      price_eur: Number(v.price_eur),
      billing_period: v.billing_period || '',
      category_ids: v.category_ids || [],
    };
    await withRegen(
      'Сохранение тарифа',
      async () => {
        if (editing) await api.patch(`/admin/api/plans/${editing.id}`, payload);
        else await api.post('/admin/api/plans', payload);
        setOpen(false);
      },
      { success: 'Тариф сохранён' },
    );
  };

  const remove = (plan) => withRegen(
    'Удаление тарифа',
    () => api.del(`/admin/api/plans/${plan.id}`),
    { success: 'Тариф удалён' },
  );

  const emptyPlans = plans.filter((p) => !(p.category_ids || []).length);

  return (
    <Card
      title="Тарифы и пакеты каналов"
      extra={<Button type="primary" onClick={() => openDialog(null)}>+ Добавить тариф</Button>}
    >
      {!sellable.length ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Категорий ещё нет"
          description="Сначала загрузите плейлист провайдера в разделе «Плейлист» — тогда категории можно будет включить в тариф."
        />
      ) : null}
      {sellable.length && emptyPlans.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`В тарифе не выбрано ни одной категории: ${emptyPlans.map((p) => p.name).join(', ')}`}
          description="Клиенты на таком тарифе получают только канал «Информация». Откройте тариф и отметьте категории, которые в него входят."
        />
      ) : null}

      {plans.length ? (
        <Row gutter={[16, 16]}>
          {plans.map((p) => {
            const ids = p.category_ids || [];
            return (
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
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {`Категорий в тарифе: ${ids.length}`}
                  </Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    {ids.length ? (
                      <Space size={[4, 4]} wrap>
                        {ids.map((id) => (
                          <Tag key={id} color={nameById.has(id) ? 'blue' : 'default'}>
                            {nameById.get(id) || 'удалённая категория'}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="warning">
                        Категории не выбраны — только «Информация»
                      </Typography.Text>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      ) : <Empty description="Тарифов пока нет. Добавьте тариф, чтобы назначать его клиентам." />}

      <Modal
        open={open}
        width={640}
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

          <Form.Item
            name="category_ids"
            label="Категории, входящие в тариф"
            extra="Клиент на этом тарифе получает только отмеченные категории (плюс «Информация»). Этот же список показывается на инфоканале как содержимое тарифа."
          >
            <CategoryPicker categories={sellable} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// Checkbox list with select-all / clear, scrollable so a provider with dozens of
// groups doesn't push the dialog off screen.
function CategoryPicker({ categories, value = [], onChange }) {
  if (!categories.length) {
    return <Typography.Text type="secondary">Категорий пока нет — загрузите плейлист.</Typography.Text>;
  }
  const allIds = categories.map((c) => c.id);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space>
        <Button size="small" onClick={() => onChange(allIds)}>Выбрать все</Button>
        <Button size="small" onClick={() => onChange([])}>Снять все</Button>
        <Typography.Text type="secondary">{`выбрано ${value.length} из ${categories.length}`}</Typography.Text>
      </Space>
      <div style={{
        maxHeight: 260, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, padding: 12,
      }}
      >
        <Checkbox.Group value={value} onChange={onChange} style={{ width: '100%' }}>
          <Row gutter={[8, 8]}>
            {categories.map((c) => (
              <Col key={c.id} xs={24} sm={12}>
                <Checkbox value={c.id} disabled={!c.enabled}>
                  {c.name}
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                    {c.enabled ? `(${c.channels_enabled})` : '(выключена)'}
                  </Typography.Text>
                </Checkbox>
              </Col>
            ))}
          </Row>
        </Checkbox.Group>
      </div>
    </Space>
  );
}
