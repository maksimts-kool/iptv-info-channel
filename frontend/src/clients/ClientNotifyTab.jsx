import { useEffect } from 'react';
import {
  Alert, Button, Checkbox, Form, Input, Popconfirm, Space, Typography,
} from 'antd';
import { AuthError } from '../lib/api.js';

// One customer's email subscription. Same double opt-in store the public /sub
// page writes to: a new or changed address is unverified until the recipient
// clicks the link, unless the admin explicitly vouches for it.
export default function ClientNotifyTab({
  user, subscriber, api, message, onAuthError, reload,
}) {
  const [form] = Form.useForm();

  useEffect(() => {
    form.setFieldsValue({
      email: subscriber?.email || '',
      expiry: subscriber ? !!subscriber.options.expiry : true,
      server: subscriber ? !!subscriber.options.server : false,
      verified: subscriber ? !!subscriber.verified : true,
    });
  }, [subscriber, form]);

  const save = async () => {
    const v = await form.validateFields();
    try {
      const res = await api.put(`/admin/api/users/${user.id}/subscriber`, {
        email: v.email.trim(),
        options: { expiry: v.expiry, server: v.server },
        verified: v.verified,
      });
      message.success(res.sentVerification
        ? 'Сохранено — клиенту отправлено письмо для подтверждения'
        : 'Подписка сохранена');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/admin/api/users/${user.id}/subscriber`);
      message.success('Подписчик удалён');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {subscriber && !subscriber.verified ? (
        <Alert
          type="warning"
          showIcon
          message="Адрес не подтверждён"
          description="Пока клиент не перейдёт по ссылке из письма, настоящие уведомления ему не отправляются."
        />
      ) : null}

      <Form form={form} layout="vertical" style={{ maxWidth: 520 }}>
        <Form.Item
          name="email"
          label="Электронная почта"
          rules={[
            { required: true, message: 'Введите адрес' },
            { type: 'email', message: 'Некорректный адрес' },
          ]}
        >
          <Input type="email" placeholder="you@example.com" />
        </Form.Item>
        <Form.Item label="Темы уведомлений">
          <Space direction="vertical">
            <Checkbox checked disabled>Продление подписки (обязательно)</Checkbox>
            <Form.Item name="expiry" valuePropName="checked" noStyle>
              <Checkbox>Подписка скоро истекает</Checkbox>
            </Form.Item>
            <Form.Item name="server" valuePropName="checked" noStyle>
              <Checkbox>Статус сервера</Checkbox>
            </Form.Item>
          </Space>
        </Form.Item>
        <Form.Item name="verified" valuePropName="checked" noStyle>
          <Checkbox>Подтвердить без письма (вы ручаетесь за адрес)</Checkbox>
        </Form.Item>
        <Typography.Text type="secondary" style={{ display: 'block', margin: '6px 0 16px', fontSize: 12 }}>
          Если снять галочку, клиенту уйдёт письмо со ссылкой для подтверждения,
          и уведомления начнут приходить только после подтверждения.
        </Typography.Text>
        <Space>
          <Button type="primary" onClick={save}>Сохранить подписку</Button>
          {subscriber ? (
            <Popconfirm title={`Отписать ${user.username}?`} okText="Отписать" onConfirm={remove}>
              <Button danger>Отписать</Button>
            </Popconfirm>
          ) : null}
        </Space>
      </Form>
    </Space>
  );
}
