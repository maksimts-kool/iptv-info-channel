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
    'Saving branding and rebuilding streams',
    () => api.patch('/admin/api/settings', form.getFieldsValue()),
    { success: 'Branding saved — streams rebuilding', reload: false },
  );

  return (
    <Card title="Branding">
      <Form form={form} layout="vertical">
        <Space size="large" align="end" wrap>
          <Form.Item name="brand_name" label="Service name" style={{ minWidth: 260, marginBottom: 0 }}>
            <Input />
          </Form.Item>
          <Form.Item name="tagline" label="Tagline" style={{ minWidth: 260, marginBottom: 0 }}>
            <Input />
          </Form.Item>
          <Button type="primary" onClick={save}>Save branding</Button>
        </Space>
      </Form>
    </Card>
  );
}
