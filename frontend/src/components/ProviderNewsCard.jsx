import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Empty, Form, Input, List, Space, Switch, Tag, Typography,
} from 'antd';
import { NotificationOutlined, ReloadOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';

// Blue is the provider's colour everywhere (slide, this card, Обзор), so its
// notices never read as our own yellow/red incidents.
export const PROVIDER_BLUE = '#2563eb';

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// Settings for the provider's service notices on the status slide. Saves
// directly (like GatewayCard): a stream rebuild happens only when what the slide
// shows actually changes, and the server says so in `regenerating`.
export default function ProviderNewsCard({
  api, state, reload, message, onAuthError,
}) {
  const pn = state?.providerNews;
  const enabled = !!pn?.enabled;
  const notices = pn?.notices || [];
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    form.setFieldsValue({ url: pn?.url || '', cookie: '' });
  }, [form, pn?.url]);

  const run = async (kind, request) => {
    setBusy(kind);
    try {
      const view = await request();
      if (view?.error && view.enabled) message.warning(`Лента провайдера: ${view.error}`);
      else if (view?.regenerating) message.success('Уведомления на слайде изменились — потоки пересобираются');
      else message.success(kind === 'check' ? 'Лента проверена' : 'Сохранено');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (checked) => run('toggle', () => api.patch('/admin/api/provider-news', { enabled: checked }));

  const save = async () => {
    const v = await form.validateFields();
    const body = { url: (v.url || '').trim() };
    if (v.cookie?.trim()) body.cookie = v.cookie.trim();
    await run('save', async () => {
      const view = await api.patch('/admin/api/provider-news', body);
      form.setFieldValue('cookie', '');
      return view;
    });
  };

  const forget = () => run('save', () => api.patch('/admin/api/provider-news', { cookie: '' }));
  const check = () => run('check', () => api.post('/admin/api/provider-news/refresh'));

  return (
    <Card
      title={(
        <Space>
          <NotificationOutlined style={{ color: PROVIDER_BLUE }} />
          Уведомления провайдера
        </Space>
      )}
      extra={(
        <Badge
          color={enabled ? PROVIDER_BLUE : undefined}
          status={enabled ? undefined : 'default'}
          text={enabled ? 'Включены' : 'Выключены'}
        />
      )}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="start">
          <Switch checked={enabled} loading={busy === 'toggle'} onChange={toggle} />
          <div>
            <div>Показывать на слайде статуса технические работы и перебои провайдера</div>
            <Typography.Text type="secondary">
              {`Лента проверяется каждые ${pn?.check_minutes ?? 15} мин. Берутся только
              сообщения о работах и сбоях — новости о новых и удалённых каналах
              пропускаются. Сообщение висит на слайде ${pn?.max_age_hours ?? 24} ч после
              публикации отдельным синим блоком, не смешиваясь с вашими инцидентами.`}
            </Typography.Text>
          </div>
        </Space>

        {!state?.statusSlideEnabled ? (
          <Alert
            type="warning"
            showIcon
            message="Слайд статуса выключен"
            description="Уведомления некуда показывать, пока STATUS_SLIDE_ENABLED=false."
          />
        ) : null}

        {pn?.auth_failed ? (
          <Alert
            type="error"
            showIcon
            message="Провайдер не принял сессию"
            description="Войдите на сайт провайдера заново и вставьте свежий Cookie ниже."
          />
        ) : pn?.error ? (
          <Alert type="warning" showIcon message={`Последняя проверка не удалась: ${pn.error}`} />
        ) : null}

        <Form form={form} layout="vertical">
          <Form.Item
            name="url"
            label="Адрес ленты новостей"
            extra="Пусто — адрес по умолчанию"
          >
            <Input placeholder={pn?.default_url} />
          </Form.Item>
          <Form.Item
            name="cookie"
            label={pn?.cookie_set ? 'Сессия сохранена — вставьте новую, чтобы заменить' : 'Cookie сессии'}
            extra="Лента доступна только после входа. Войдите на сайт провайдера в браузере, откройте F12 → Network, обновите страницу новостей, выберите запрос news и скопируйте значение заголовка Cookie. Дальше сервер сам продлевает сессию."
          >
            <Input.TextArea rows={3} placeholder="name=value; name2=value2" autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Space wrap>
            <Button type="primary" onClick={save} loading={busy === 'save'}>Сохранить</Button>
            <Button icon={<ReloadOutlined />} onClick={check} loading={busy === 'check'}>Проверить сейчас</Button>
            {pn?.cookie_set ? <Button danger onClick={forget}>Забыть сессию</Button> : null}
          </Space>
        </Form>

        <Typography.Text type="secondary">{`Последняя проверка: ${when(pn?.checked_at)}`}</Typography.Text>

        {notices.length ? (
          <List
            dataSource={notices}
            renderItem={(n) => (
              <List.Item>
                <List.Item.Meta
                  avatar={n.active
                    ? <Tag color={PROVIDER_BLUE}>На слайде</Tag>
                    : <Tag>Устарело</Tag>}
                  title={n.headline}
                  description={(
                    <Typography.Text type="secondary">
                      {`${when(n.published_at)} · ${n.body}`}
                    </Typography.Text>
                  )}
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="Сообщений о работах и сбоях у провайдера нет" />
        )}
      </Space>
    </Card>
  );
}
