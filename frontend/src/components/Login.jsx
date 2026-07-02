import { useState } from 'react';
import {
  App as AntApp, Button, Card, Form, Input, Typography,
} from 'antd';

export default function Login({ onLogin }) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);

  const submit = async ({ password }) => {
    setLoading(true);
    try {
      await onLogin(password);
    } catch (e) {
      message.error(e.message || 'Неверный пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 20 }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>IPTV Info Channel</Typography.Title>
        <Typography.Paragraph type="secondary">Вход администратора</Typography.Paragraph>
        <Form onFinish={submit} layout="vertical" requiredMark={false}>
          <Form.Item name="password" rules={[{ required: true, message: 'Введите пароль' }]}>
            <Input.Password placeholder="Пароль администратора" size="large" autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Войти
          </Button>
        </Form>
      </Card>
    </div>
  );
}
