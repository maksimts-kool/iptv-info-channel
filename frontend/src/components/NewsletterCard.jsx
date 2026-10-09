import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Empty, Form, Input, Popconfirm, Radio, Space, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, ExclamationCircleOutlined, LoadingOutlined, NotificationOutlined, SendOutlined,
} from '@ant-design/icons';
import ResponsiveTable from './ResponsiveTable.jsx';
import AudiencePicker from './AudiencePicker.jsx';
import { AuthError } from '../lib/api.js';
import {
  EMPTY_AUDIENCE, audienceLabel, audienceMatches, clientsWord,
} from '../lib/audience.js';

const POLL_MS = 2_000;

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

// The admin's own newsletter: news and important announcements, mailed to
// customers who ticked «Новости и важные объявления» (their own sign-up page,
// or the Уведомления tab of their card) — to all of them, or to a group.
export default function NewsletterCard({
  api, state, message, onAuthError,
}) {
  const [form] = Form.useForm();
  const [items, setItems] = useState(null);
  const [scope, setScope] = useState('all');
  const [audience, setAudience] = useState(EMPTY_AUDIENCE);
  const [testEmail, setTestEmail] = useState('');
  const [sending, setSending] = useState(false);

  const users = state?.users || [];
  const plans = state?.plans || [];
  const subscribers = state?.subscribers || [];
  const mailOn = !!state?.notify?.enabled;

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  const load = useCallback(async () => {
    try {
      setItems((await api.get('/admin/api/newsletters')).newsletters);
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);

  useEffect(() => { load(); }, [load]);

  const busy = (items || []).some((n) => n.status === 'sending');
  useEffect(() => {
    if (!busy) return undefined;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [busy, load]);

  // Same rule as the server (newsletterRecipients): a verified address, the
  // news topic ticked, and the customer in the group.
  const target = scope === 'all' ? null : audience;
  const recipients = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    return subscribers.filter((s) => {
      const u = byId.get(s.user_id);
      return u && s.verified && s.options?.news && audienceMatches(target, u);
    });
  }, [subscribers, users, target]);
  const optedIn = subscribers.filter((s) => s.verified && s.options?.news).length;

  const draft = async () => {
    const v = await form.validateFields();
    return {
      subject: v.subject, body: v.body, important: !!v.important, audience: target,
    };
  };

  const send = async () => {
    setSending(true);
    try {
      const body = await draft();
      const res = await api.post('/admin/api/newsletters', body);
      message.success(`Рассылка отправляется: ${res.recipients} ${clientsWord(res.recipients)}`);
      form.resetFields();
      await load();
    } catch (e) {
      if (e?.errorFields) return; // form validation, shown inline
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const sendTest = async () => {
    if (!testEmail.trim()) { message.error('Введите адрес для теста'); return; }
    try {
      const body = await draft();
      await api.post('/admin/api/newsletters/test', { ...body, email: testEmail.trim() });
      message.success(`Тестовое письмо отправлено на ${testEmail.trim()}`);
    } catch (e) {
      if (e?.errorFields) return;
      fail(e);
    }
  };

  const remove = async (n) => {
    try {
      await api.del(`/admin/api/newsletters/${n.id}`);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const columns = [
    { title: 'Отправлено', key: 'at', width: 150, render: (_, n) => when(n.sent_at || n.created_at) },
    {
      title: 'Тема',
      key: 'subject',
      render: (_, n) => (
        <Space size={6} wrap>
          {n.important ? <Tag color="orange">важное</Tag> : null}
          <Typography.Text strong>{n.subject}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Кому',
      key: 'aud',
      width: 200,
      ellipsis: true,
      render: (_, n) => audienceLabel(n.audience, users, plans),
    },
    {
      title: 'Доставлено',
      key: 'status',
      width: 150,
      render: (_, n) => {
        if (n.status === 'sending') {
          return <Tag icon={<LoadingOutlined />} color="processing">{`${n.sent} из ${n.recipients}`}</Tag>;
        }
        if (n.status === 'error') {
          return (
            <Tooltip title={n.error}>
              <Tag icon={<ExclamationCircleOutlined />} color="error">не отправлена</Tag>
            </Tooltip>
          );
        }
        return (
          <Space size={4}>
            <Tag color="green">{`${n.sent} из ${n.recipients}`}</Tag>
            {n.failed ? <Tag color="red">{`ошибок: ${n.failed}`}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '',
      key: 'del',
      width: 50,
      align: 'right',
      render: (_, n) => (
        <Popconfirm
          title="Убрать из истории?"
          description="Письма уже отправлены — это только запись в списке."
          okText="Убрать"
          cancelText="Отмена"
          onConfirm={() => remove(n)}
        >
          <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Убрать из истории" disabled={n.status === 'sending'} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card title={<Space><NotificationOutlined />Рассылка новостей</Space>}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {!mailOn ? (
          <Alert
            type="warning"
            showIcon
            message="Почтовые уведомления выключены — рассылку не отправить. Включите их в карточке ниже."
          />
        ) : null}
        <Typography.Text type="secondary">
          {`Письмо получат клиенты с подтверждённым адресом, отметившие тему «Новости и важные объявления» — сейчас таких ${optedIn}. Тему можно включить или выключить в карточке клиента, а сами клиенты делают это на странице подписки.`}
        </Typography.Text>

        <Form form={form} layout="vertical" initialValues={{ important: false }}>
          <Form.Item name="subject" label="Тема" rules={[{ required: true, message: 'Укажите тему' }, { max: 150 }]}>
            <Input placeholder="Например: плановые работы в ночь на субботу" maxLength={150} />
          </Form.Item>
          <Form.Item
            name="body"
            label="Текст"
            rules={[{ required: true, message: 'Напишите текст' }]}
            extra="Пустая строка начинает новый абзац."
          >
            <Input.TextArea autoSize={{ minRows: 5, maxRows: 16 }} maxLength={10000} showCount />
          </Form.Item>
          <Form.Item name="important" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>Важное — выделить письмо (оранжевая плашка, «Важно» в теме)</Checkbox>
          </Form.Item>
        </Form>

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text strong>Кому</Typography.Text>
          <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
            <Radio value="all">Всем подписчикам новостей</Radio>
            <Radio value="group">Группе клиентов</Radio>
          </Radio.Group>
          {scope === 'group' ? (
            <AudiencePicker value={audience} onChange={setAudience} users={users} plans={plans} />
          ) : null}
        </Space>

        <div className="notify-controls">
          <Popconfirm
            title={`Отправить рассылку? Получателей: ${recipients.length}`}
            description="Письмо уйдёт сразу, отменить отправку нельзя."
            okText="Отправить"
            cancelText="Отмена"
            disabled={!mailOn || !recipients.length}
            onConfirm={send}
          >
            <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!mailOn || !recipients.length}>
              {recipients.length
                ? `Отправить · ${recipients.length} ${clientsWord(recipients.length)}`
                : 'Нет получателей'}
            </Button>
          </Popconfirm>
          <Space.Compact className="notify-test">
            <Input
              type="email"
              placeholder="тест на свой адрес"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
            />
            <Button onClick={sendTest}>Тест</Button>
          </Space.Compact>
        </div>

        <Typography.Text strong>Отправленные</Typography.Text>
        {items && !items.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Рассылок пока не было" />
        ) : (
          <ResponsiveTable
            size="small"
            rowKey="id"
            loading={!items}
            dataSource={items || []}
            columns={columns}
            scroll={{ x: 'max-content' }}
            pagination={(items || []).length > 10 ? { pageSize: 10, size: 'small' } : false}
            expandable={{
              expandedRowRender: (n) => (
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{n.body}</Typography.Paragraph>
              ),
            }}
          />
        )}
      </Space>
    </Card>
  );
}
