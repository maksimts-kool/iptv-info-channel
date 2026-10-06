import { useState } from 'react';
import {
  Alert, Badge, Card, Space, Statistic, Switch, Typography,
} from 'antd';
import { DesktopOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { count } from '../lib/format.js';
import { devicesLabel } from '../lib/plans.js';

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
  const plans = state?.plans || [];
  const users = state?.users || [];
  const idle = state?.gateway?.device_idle_seconds ?? 60;
  const watching = users.reduce((sum, u) => sum + (u.devices_active || 0), 0);
  const limitedPlans = plans.filter((p) => p.max_devices > 0);
  const personal = users.filter((u) => u.max_devices !== null && u.max_devices !== undefined);

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
              заново проверяет тариф, личные исключения, срок подписки и лимит
              устройств при каждом обновлении потока — плеер делает это каждые
              несколько секунд. Если забрать канал у клиента, пока он смотрит,
              через несколько секунд вместо канала у него начнётся инфоканал
              с тарифом и сроком, без ошибки и без обновления плейлиста. Видео
              через сервер не идёт: он отдаёт только манифест, сегменты клиент
              качает у провайдера напрямую.
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

        <Card
          size="small"
          type="inner"
          title={<Space><DesktopOutlined />Лимит устройств</Space>}
          extra={<Typography.Text type="secondary">{`сейчас смотрят: ${count(watching)}`}</Typography.Text>}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              Сколько устройств могут смотреть одновременно, задаётся в тарифе
              (раздел «Тарифы»), а для отдельного клиента — в его карточке.
              Устройства, которые начали смотреть первыми, сохраняют своё место;
              следующее устройство вместо канала видит экран «Превышен лимит
              устройств». Место освобождается
              {` ${idle} сек.`}
              {' '}
              после того, как плеер перестал обновлять канал.
            </Typography.Text>
            <Typography.Text>
              {limitedPlans.length
                ? `С лимитом: ${limitedPlans.map((p) => `${p.name} — ${devicesLabel(p.max_devices)}`).join('; ')}`
                : 'Ни в одном тарифе лимит не задан — смотреть можно на любом числе устройств.'}
              {personal.length ? ` · личный лимит у ${count(personal.length)} клиент(ов)` : ''}
            </Typography.Text>
            {!enabled && (limitedPlans.length || personal.length) ? (
              <Alert
                type="warning"
                showIcon
                message="Пока шлюз выключен, лимит устройств не действует"
              />
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Устройство — это адрес клиента плюс плеер, скачавший плейлист.
              Два одинаковых плеера в одной домашней сети считаются одним
              устройством, а телефон, сменивший сеть, на минуту занимает два
              места. Каналы без шлюза (MPEG-TS) не считаются.
            </Typography.Text>
          </Space>
        </Card>

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
                инфоканал с тарифом, сроком и списком тарифов — и при
                переключении, и прямо во время просмотра. Вернуть канал можно
                сразу, но клиент, уже переключённый на инфоканал, увидит его
                снова после переключения канала.
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
