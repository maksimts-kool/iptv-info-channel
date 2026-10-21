import { useState } from 'react';
import {
  Alert, Button, Card, Form, Input, Typography,
} from 'antd';
import { LockOutlined, WifiOutlined } from '@ant-design/icons';

// One field, one button: the only thing to do here is sign in. A wrong
// password is said next to the field, where the eyes already are, rather than
// in a toast that disappears.
// The server answers in English (src/http/admin.rs); say it in the admin's language.
const LOGIN_ERRORS = {
  'wrong password': 'Неверный пароль',
  'too many attempts, try again later': 'Слишком много попыток. Подождите немного и попробуйте снова.',
};

export default function Login({ onLogin }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async ({ password }) => {
    setLoading(true);
    setError('');
    try {
      await onLogin(password);
    } catch (e) {
      setError(LOGIN_ERRORS[e.message] || e.message || 'Неверный пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <Card className="login-card" variant="borderless">
        <div className="login-brand">
          <span className="brand-logo"><WifiOutlined /></span>
          <span>IPTV Panel</span>
        </div>
        <Typography.Title level={3} style={{ margin: '20px 0' }}>Вход администратора</Typography.Title>
        <Form onFinish={submit} layout="vertical" requiredMark={false} onValuesChange={() => setError('')}>
          <Form.Item
            name="password"
            label="Пароль"
            rules={[{ required: true, message: 'Введите пароль' }]}
            style={{ marginBottom: error ? 12 : 20 }}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: 'rgba(0,0,0,0.35)' }} />}
              placeholder="Пароль администратора"
              size="large"
              autoComplete="current-password"
              autoFocus
            />
          </Form.Item>
          {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Войти
          </Button>
        </Form>
      </Card>
    </div>
  );
}
