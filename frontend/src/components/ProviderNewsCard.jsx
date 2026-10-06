import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Divider, Form, Input, Space, Switch, Typography,
} from 'antd';
import { NotificationOutlined, ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';

// Blue is the provider's colour everywhere (slide, «Статус сервиса», Обзор):
// its notices share the incident list but never read as our own yellow/red.
export const PROVIDER_BLUE = '#2563eb';

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// Settings for the provider's service notices — the notices themselves are
// listed with the incidents in IncidentsCard, this card is only the switch, the
// login session and the OpenRouter key for the AI retelling. Saves
// directly (like GatewayCard): a stream rebuild happens only when what the slide
// shows actually changes, and the server says so in `regenerating`.
export default function ProviderNewsCard({
  api, state, reload, message, onAuthError,
}) {
  const pn = state?.providerNews;
  const enabled = !!pn?.enabled;
  const shown = state?.status?.providerNotices?.length || 0;
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    form.setFieldsValue({ url: pn?.url || '', cookie: '', ai_key: '' });
  }, [form, pn?.url]);

  const run = async (kind, request) => {
    setBusy(kind);
    try {
      const view = await request();
      if (view?.error && view.enabled) message.warning(`Лента провайдера: ${view.error}`);
      else if (view?.ai_error && view.enabled) message.warning(`ИИ-пересказ: ${view.ai_error}`);
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
    if (v.ai_key?.trim()) body.ai_key = v.ai_key.trim();
    await run('save', async () => {
      const view = await api.patch('/admin/api/provider-news', body);
      form.setFieldsValue({ cookie: '', ai_key: '' });
      return view;
    });
  };

  const forget = () => run('save', () => api.patch('/admin/api/provider-news', { cookie: '' }));
  const forgetKey = () => run('save', () => api.patch('/admin/api/provider-news', { ai_key: '' }));
  const check = () => run('check', () => api.post('/admin/api/provider-news/refresh'));

  let keyLabel = 'API-ключ OpenRouter';
  if (pn?.ai_key_from_env) keyLabel = 'Ключ задан в OPENROUTER_API_KEY — вставьте другой, чтобы заменить';
  else if (pn?.ai_key_set) keyLabel = 'Ключ сохранён — вставьте новый, чтобы заменить';

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
              публикации — вместе с вашими инцидентами, но синим цветом.`}
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

        {pn?.ai_error && pn?.ai_key_set ? (
          <Alert
            type="warning"
            showIcon
            message={`ИИ-пересказ не получился: ${pn.ai_error}`}
            description="Пока показывается обычный текст сообщения; следующая проверка попробует снова."
          />
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

          <Divider orientation="left" plain>
            <Space size={6}>
              <RobotOutlined />
              ИИ-пересказ
            </Space>
          </Divider>
          <Form.Item
            name="ai_key"
            label={keyLabel}
            extra={`Сообщения провайдера длинные — ИИ (${pn?.ai_model || 'openrouter/free'}) сокращает каждое до одной короткой фразы для слайда. Запрос уходит только когда появляется новое сообщение или меняется текст старого. Без ключа показывается обычный текст.`}
          >
            <Input.Password placeholder="sk-or-v1-…" autoComplete="off" spellCheck={false} />
          </Form.Item>

          <Space wrap>
            <Button type="primary" onClick={save} loading={busy === 'save'}>Сохранить</Button>
            <Button icon={<ReloadOutlined />} onClick={check} loading={busy === 'check'}>Проверить сейчас</Button>
            {pn?.cookie_set ? <Button danger onClick={forget}>Забыть сессию</Button> : null}
            {pn?.ai_key_set && !pn?.ai_key_from_env ? <Button danger onClick={forgetKey}>Забыть ключ</Button> : null}
          </Space>
        </Form>

        <Typography.Text type="secondary">
          {`Последняя проверка: ${when(pn?.checked_at)}`}
          {enabled ? ` · сейчас на слайде: ${shown} (см. «Статус сервиса» выше)` : ''}
        </Typography.Text>

      </Space>
    </Card>
  );
}
