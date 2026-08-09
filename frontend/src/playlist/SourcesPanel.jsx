import { useState } from 'react';
import {
  Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SyncOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { intervalLabel, untilPretty } from '../lib/format.js';

// Upstream provider playlists. Refreshing one re-downloads the m3u and folds it
// into the catalog: new channels are added, renames/moves/toggles the admin made
// are preserved, and channels the provider dropped are flagged rather than
// deleted (so nothing is lost to a bad download).
//
// Each source also carries its own unattended schedule: with «Авто» on, the
// server re-downloads it every `interval_hours` on its own, so a provider that
// adds channels weekly doesn't need anyone to press a button.
const DEFAULT_INTERVAL = 24;

export default function SourcesPanel({
  api, message, onAuthError, catalog, refresh, error,
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [form] = Form.useForm();

  const intervalOptions = (catalog?.refreshIntervals || [1, 2, 3, 6, 12, 24, 48, 72, 168])
    .map((h) => ({ value: h, label: intervalLabel(h) }));

  const guarded = async (fn, ok) => {
    try {
      const result = await fn();
      if (ok) message.success(ok);
      await refresh();
      return result;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
      return null;
    }
  };

  const openDialog = (source) => {
    setEditing(source || null);
    form.setFieldsValue({
      name: source?.name || '',
      url: source?.url || '',
      auto_refresh: source ? source.auto_refresh !== false : true,
      interval_hours: source?.interval_hours || DEFAULT_INTERVAL,
    });
    setOpen(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    const payload = {
      name: v.name.trim(),
      url: v.url.trim(),
      auto_refresh: !!v.auto_refresh,
      interval_hours: v.interval_hours || DEFAULT_INTERVAL,
    };
    const created = await guarded(async () => {
      if (editing) return api.patch(`/admin/api/catalog/sources/${editing.id}`, payload);
      return api.post('/admin/api/catalog/sources', payload);
    }, 'Источник сохранён');
    if (!created) return;
    setOpen(false);
    // A brand-new source is useless until it is imported, so do it right away.
    if (!editing) await syncOne(created.id);
  };

  const syncOne = async (id) => {
    setBusy(id);
    try {
      const res = await api.post(`/admin/api/catalog/sources/${id}/refresh`);
      const s = res.stats;
      message.success(
        `Загружено ${s.total} каналов: новых ${s.added}, обновлено ${s.updated}`
        + (s.missing ? `, пропало ${s.missing}` : '')
        + (s.restored ? `, вернулось ${s.restored}` : ''),
      );
      await refresh();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(`Не удалось загрузить плейлист: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const syncAll = async () => {
    setBusy('all');
    try {
      const res = await api.post('/admin/api/catalog/refresh');
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) message.warning(`Обновлено с ошибками: ${failed.length} из ${res.results.length}`);
      else message.success(`Обновлено источников: ${res.results.length}`);
      await refresh();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const sources = catalog?.sources || [];

  const columns = [
    {
      title: 'Источник',
      key: 'name',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <strong>{s.name}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: s.url }}>
            {s.url.length > 64 ? `${s.url.slice(0, 64)}…` : s.url}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Включён',
      key: 'enabled',
      width: 100,
      render: (_, s) => (
        <Switch
          checked={s.enabled}
          onChange={(enabled) => guarded(
            () => api.patch(`/admin/api/catalog/sources/${s.id}`, { enabled }),
            enabled ? 'Источник включён' : 'Источник выключен',
          )}
        />
      ),
    },
    {
      // Unattended re-download: the switch is the on/off, the dropdown is how
      // often. Both save immediately — this is a schedule, not a form.
      title: 'Авто-обновление',
      key: 'auto',
      width: 230,
      render: (_, s) => (
        <Space direction="vertical" size={4}>
          <Space size={8}>
            <Switch
              size="small"
              checked={s.auto_refresh}
              onChange={(auto_refresh) => guarded(
                () => api.patch(`/admin/api/catalog/sources/${s.id}`, { auto_refresh }),
                auto_refresh ? 'Авто-обновление включено' : 'Авто-обновление выключено',
              )}
            />
            <Select
              size="small"
              style={{ width: 150 }}
              disabled={!s.auto_refresh}
              value={s.interval_hours || DEFAULT_INTERVAL}
              options={intervalOptions}
              onChange={(interval_hours) => guarded(
                () => api.patch(`/admin/api/catalog/sources/${s.id}`, { interval_hours }),
                'Интервал сохранён',
              )}
            />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {!s.enabled ? 'источник выключен'
              : s.auto_refresh ? `следующая загрузка ${untilPretty(s.next_sync_ms)}`
                : 'только вручную'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Последняя загрузка',
      key: 'sync',
      render: (_, s) => (s.last_error
        ? <Tag color="red" title={s.last_error}>Ошибка</Tag>
        : (
          <Space direction="vertical" size={0}>
            <span>{s.last_sync_at || '—'}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {s.last_count ? `${s.last_count} каналов` : 'ещё не загружался'}
            </Typography.Text>
          </Space>
        )),
    },
    {
      title: '',
      key: 'actions',
      render: (_, s) => (
        <Space wrap>
          <Button
            size="small"
            type="primary"
            icon={<SyncOutlined />}
            loading={busy === s.id}
            onClick={() => syncOne(s.id)}
          >
            Обновить
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openDialog(s)}>Изменить</Button>
          <Popconfirm
            title={`Удалить источник «${s.name}»?`}
            description="Импортированные из него каналы будут удалены из каталога."
            okText="Удалить"
            okButtonProps={{ danger: true }}
            onConfirm={() => guarded(() => api.del(`/admin/api/catalog/sources/${s.id}`), 'Источник удалён')}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>Удалить</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="Источники плейлистов"
      extra={(
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={busy === 'all'}
            disabled={!sources.length}
            onClick={syncAll}
          >
            Обновить все
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openDialog(null)}>
            Добавить источник
          </Button>
        </Space>
      )}
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
      {catalog && catalog.autoRefreshEnabled === false && sources.some((s) => s.auto_refresh) ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Авто-обновление отключено на сервере"
          description="Расписание ниже сохраняется, но не выполняется: включите CATALOG_AUTO_REFRESH в настройках сервера."
        />
      ) : null}
      {sources.some((s) => s.last_error) ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Не все источники загрузились"
          description={sources.filter((s) => s.last_error)
            .map((s) => `${s.name}: ${s.last_error}`).join(' · ')}
        />
      ) : null}

      {sources.length ? (
        <Table rowKey="id" size="small" columns={columns} dataSource={sources} pagination={false} scroll={{ x: 'max-content' }} />
      ) : (
        <Empty description="Источников нет. Добавьте ссылку на m3u вашего провайдера — каналы попадут в каталог, и их можно будет переименовывать, перегруппировать и отключать." />
      )}

      <Modal
        open={open}
        title={editing ? 'Изменить источник' : 'Добавить источник'}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, message: 'Укажите название' }, { max: 80 }]}>
            <Input placeholder="Основной провайдер" />
          </Form.Item>
          <Form.Item
            name="url"
            label="Ссылка на плейлист (m3u)"
            rules={[
              { required: true, message: 'Укажите ссылку' },
              { type: 'url', message: 'Некорректная ссылка' },
            ]}
          >
            <Input placeholder="http://provider.tv/get.php?username=…&type=m3u_plus" />
          </Form.Item>
          <Form.Item
            name="auto_refresh"
            label="Обновлять автоматически"
            valuePropName="checked"
            extra="Сервер сам перезагружает плейлист по расписанию — новые каналы провайдера появляются без ручного обновления."
          >
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.auto_refresh !== b.auto_refresh}>
            {({ getFieldValue }) => (
              <Form.Item name="interval_hours" label="Как часто">
                <Select options={intervalOptions} disabled={!getFieldValue('auto_refresh')} />
              </Form.Item>
            )}
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            После сохранения плейлист будет загружен сразу. Повторная загрузка не
            затирает ваши правки: переименования, перенос в другую категорию и
            отключения сохраняются, обновляются только ссылки на потоки.
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}
