import { useEffect } from 'react';
import {
  Button, Card, Form, Input, Space,
} from 'antd';

export default function BrandingCard({ state, api, withRegen }) {
  const [form] = Form.useForm();

  useEffect(() => {
    form.setFieldsValue({
      brand_name: state?.settings?.brand_name || '',
      tagline: state?.settings?.tagline || '',
    });
  }, [state?.settings, form]);

  const save = () => withRegen(
    'Сохранение оформления и пересборка потоков',
    () => api.patch('/admin/api/settings', form.getFieldsValue()),
    { success: 'Оформление сохранено — потоки пересобираются', reload: false },
  );

  return (
    <Card title="Оформление">
      <Form form={form} layout="vertical">
        <Space size="large" align="end" wrap>
          <Form.Item name="brand_name" label="Название сервиса" style={{ minWidth: 260, marginBottom: 0 }}>
            <Input />
          </Form.Item>
          <Form.Item name="tagline" label="Слоган" style={{ minWidth: 260, marginBottom: 0 }}>
            <Input />
          </Form.Item>
          <Button type="primary" onClick={save}>Сохранить оформление</Button>
        </Space>
      </Form>
    </Card>
  );
}
