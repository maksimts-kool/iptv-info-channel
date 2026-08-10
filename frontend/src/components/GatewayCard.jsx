import { useState } from 'react';
import {
  Alert, Badge, Card, Space, Switch, Typography,
} from 'antd';
import { AuthError } from '../lib/api.js';

// The stream gateway switch. No re-encode is involved (playlists are rendered
// per request), so this saves directly instead of going through the regen
// banner — same rule as the rest of the Плейлист screens.
export default function GatewayCard({
  api, state, reload, message, onAuthError,
}) {
  const enabled = !!state?.gateway?.enabled;
  const [saving, setSaving] = useState(false);

  const toggle = async (checked) => {
    setSaving(true);
    try {
      await api.patch('/admin/api/gateway', { enabled: checked });
      message.success(checked
        ? 'Шлюз включён — клиентам нужно один раз обновить плейлист'
        : 'Шлюз выключен — новые плейлисты снова ведут напрямую к провайдеру');
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Шлюз потоков"
      extra={(
        <Badge
          status={enabled ? 'success' : 'default'}
          text={enabled ? 'Включён' : 'Выключен'}
        />
      )}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space align="start">
          <Switch checked={enabled} loading={saving} onChange={toggle} />
          <div>
            <div>Проверять доступ при каждом переключении канала</div>
            <Typography.Text type="secondary">
              Ссылки в плейлисте ведут не к провайдеру, а на этот сервер, и он
              каждый раз заново проверяет тариф, личные исключения и срок
              подписки. Канал, который вы забрали у клиента, перестаёт работать
              сразу — обновлять плейлист в плеере не нужно. Видео через сервер не
              идёт: он отвечает переадресацией, нагрузка не растёт.
            </Typography.Text>
          </div>
        </Space>

        <Alert
          type="info"
          showIcon
          message="Что нужно знать"
          description={(
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              <li>
                Включение действует только на плейлисты, скачанные после него —
                клиенту нужно один раз обновить плейлист в плеере.
              </li>
              <li>
                Недоступный канал не выдаёт ошибку: клиент попадает на свой
                инфоканал с тарифом, сроком и списком тарифов.
              </li>
              <li>
                Новые каналы всё равно появляются у клиента только после
                обновления плейлиста — этого без обновления не сделать.
              </li>
              <li>
                Выключение шлюза не ломает уже выданные ссылки: сервер продолжает
                их обслуживать.
              </li>
            </ul>
          )}
        />
      </Space>
    </Card>
  );
}
