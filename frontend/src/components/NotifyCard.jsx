import { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Input, Space, Switch, Table, Tag, Typography,
} from 'antd';
import { AuthError } from '../api.js';

const NOTIFY_TYPE = {
  verification: 'Подтверждение адреса',
  confirmation: 'Подписка оформлена',
  expiry: 'Истечение',
  renewal: 'Продление',
  server: 'Статус сервера',
  test: 'Тест',
};

const LOG_COLUMNS = [
  { title: 'Время', dataIndex: 'at', key: 'at', width: 170 },
  { title: 'Кому', dataIndex: 'email', key: 'email', render: (v) => v || '—' },
  { title: 'Тип', dataIndex: 'type', key: 'type', render: (v) => NOTIFY_TYPE[v] || v },
  {
    title: 'Статус',
    key: 'ok',
    render: (_, e) => (e.ok
      ? <Tag color="green">OK</Tag>
      : <Tag color="red" title={e.error || ''}>Ошибка</Tag>),
  },
];

export default function NotifyCard({
  api, withRegen, reloadToken, message, onAuthError,
}) {
  const [data, setData] = useState(null);
  const [testEmail, setTestEmail] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/api/notifications'));
      setError('');
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(e.message);
    }
  }, [api, onAuthError]);

  useEffect(() => { load(); }, [load, reloadToken]);

  const toggle = (checked) => withRegen(
    'Сохранение настроек уведомлений и пересборка потоков',
    () => api.patch('/admin/api/notifications', { enabled: checked }),
    { success: 'Настройки уведомлений сохранены — потоки пересобираются' },
  );

  const sendTest = async () => {
    if (!testEmail.trim()) { message.error('Введите адрес для теста'); return; }
    try {
      await api.post('/admin/api/notifications/test', { email: testEmail.trim() });
      message.success('Тестовое письмо отправлено');
      load();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    }
  };

  const cfg = !data ? '' : data.dryRun
    ? 'тестовый режим — письма не отправляются'
    : data.configured
      ? `провайдер: ${data.provider} ✓`
      : 'не настроено — задайте NOTIFY_API_KEY и NOTIFY_FROM';

  return (
    <Card
      title="Уведомления по почте · email notifications"
      extra={data ? (
        <span>
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 8,
            background: data.enabled ? '#16a34a' : '#8c8c8c',
          }}
          />
          {data.enabled ? 'Включены' : 'Выключены'}
        </span>
      ) : null}
    >
      <Space size="large" align="center" wrap style={{ marginBottom: 16 }}>
        <Space>
          <Switch checked={!!data?.enabled} onChange={toggle} />
          <span>Включить уведомления (QR на интро-слайде)</span>
        </Space>
        <Space.Compact>
          <Input
            type="email"
            placeholder="you@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            style={{ width: 220 }}
          />
          <Button onClick={sendTest}>Отправить тест</Button>
        </Space.Compact>
        <Typography.Text type="secondary">
          {error ? `Не удалось загрузить: ${error}` : `${cfg} · подписчиков: ${data?.subscribers?.length ?? 0}`}
        </Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey={(e) => `${e.at}|${e.type}|${e.email || ''}`}
        columns={LOG_COLUMNS}
        dataSource={data?.log || []}
        pagination={false}
        locale={{ emptyText: 'Писем пока не отправлялось.' }}
      />
    </Card>
  );
}
