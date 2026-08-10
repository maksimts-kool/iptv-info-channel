import { useState } from 'react';
import {
  Alert, Badge, Card, Space, Statistic, Switch, Typography,
} from 'antd';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';

// The stream gateway switch. No re-encode is involved (playlists are rendered
// per request), so this saves directly instead of going through the regen
// banner — same rule as the rest of the Плейлист screens.
export default function GatewayCard({
  api, state, reload, message, onAuthError,
}) {
  const enabled = !!state?.gateway?.enabled;
  const total = state?.catalog?.channels ?? 0;
  const gateable = state?.catalog?.gateable ?? 0;
  const direct = Math.max(0, total - gateable);
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
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="start">
          <Switch checked={enabled} loading={saving} onChange={toggle} />
          <div>
            <div>Проверять доступ при каждом запросе плеера</div>
            <Typography.Text type="secondary">
              Ссылки в плейлисте ведут не к провайдеру, а на этот сервер, и он
              каждый раз заново проверяет тариф, личные исключения и срок
              подписки. Канал, который вы забрали у клиента, перестаёт работать
              сразу — обновлять плейлист в плеере не нужно. Видео через сервер
              не идёт: он отдаёт только манифест, сегменты клиент качает у
              провайдера напрямую.
            </Typography.Text>
          </div>
        </Space>

        <Space size="large" wrap>
          <Statistic title="Под шлюзом (HLS)" value={gateable} formatter={count} />
          <Statistic title="Остаются прямыми" value={direct} formatter={count} />
        </Space>

        {direct > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`${count(direct)} каналов шлюз не закрывает`}
            description={(
              <>
                Шлюз работает только с HLS-каналами (ссылка на
                {' '}
                <Typography.Text code>.m3u8</Typography.Text>
                ): для них сервер отдаёт манифест сам, без переадресации.
                У сырых MPEG-TS каналов манифеста нет, и единственный способ их
                закрыть — переадресация с https на http, которую плееры на
                Android (ExoPlayer) не выполняют: канал бесконечно грузится.
                Поэтому такие каналы остаются с прямыми ссылками и ведут себя
                как раньше — доступ по ним меняется только после обновления
                плейлиста у клиента.
              </>
            )}
          />
        ) : null}

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
