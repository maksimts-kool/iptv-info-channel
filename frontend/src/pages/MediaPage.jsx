import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, Input, Progress, Row, Space, Statistic, Switch, Tag, Tooltip, Typography, Upload,
} from 'antd';
import {
  CheckCircleOutlined, CloudUploadOutlined, ExclamationCircleOutlined, FileTextOutlined, LoadingOutlined,
  ReloadOutlined, SaveOutlined,
} from '@ant-design/icons';
import { AuthError, getCsrfToken } from '../lib/api.js';
import { bytes, count, seconds as secondsPretty } from '../lib/format.js';
import SlideList from '../media/SlideList.jsx';
import TextSlideEditor from '../media/TextSlideEditor.jsx';
import ImageSlideEditor from '../media/ImageSlideEditor.jsx';

const POLL_MS = 2_000;
const ACCEPT = '.jpg,.jpeg,.png,.webp,.mp4,.m4v,.mkv,.mov,.webm,image/jpeg,image/png,image/webp,video/*';

const isVideoFile = (file) => String(file.type || '').startsWith('video/')
  || /\.(mp4|m4v|mkv|mov|webm)$/i.test(file.name || '');

function StatusTag({ status, hasSlides }) {
  if (status.state === 'building' || status.pending) {
    return <Tag icon={<LoadingOutlined />} color="processing">собирается</Tag>;
  }
  if (status.state === 'error') {
    return (
      <Tooltip title={status.error}>
        <Tag icon={<ExclamationCircleOutlined />} color="error">ошибка сборки</Tag>
      </Tooltip>
    );
  }
  if (status.ready) return <Tag icon={<CheckCircleOutlined />} color="success">в эфире</Tag>;
  return <Tag>{hasSlides ? 'ожидает сборки' : 'нет слайдов'}</Tag>;
}

// The media channel: the second built-in channel of Информация. One loop of
// text pages, images and videos, the same for every customer (expired ones
// too). Edits save at once; the server rebuilds the loop in the background,
// re-encoding only the slides that changed.
export default function MediaPage({ api, message, onAuthError }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null); // { kind: 'text'|'image', item }
  const [uploads, setUploads] = useState([]); // in-flight uploads (progress bars)

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  const accept = useCallback((next) => {
    setData(next);
    setName((current) => current || next.channel.name);
  }, []);

  const load = useCallback(async () => {
    try {
      accept(await api.get('/admin/api/media'));
    } catch (e) {
      fail(e);
    }
  }, [api, accept, fail]);

  useEffect(() => { load(); }, [load]);

  // Poll only while something is happening on the server.
  const busy = !!data && (
    data.status.state === 'building' || data.status.pending
    || data.items.some((i) => i.type === 'video' && i.status === 'processing')
  );
  useEffect(() => {
    if (!busy) return undefined;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [busy, load]);

  const mutate = async (action, success) => {
    try {
      accept(await action());
      if (success) message.success(success);
    } catch (e) {
      fail(e);
      throw e;
    }
  };

  if (!data) return <Card loading />;

  const { channel, items, status, usage } = data;
  const usedPercent = Math.min(100, Math.round((usage.used / usage.quota) * 100));

  const saveName = () => mutate(
    () => api.patch('/admin/api/media/channel', { name }),
    'Название сохранено',
  ).catch(() => {});

  const uploadProps = {
    name: 'file',
    multiple: true,
    accept: ACCEPT,
    action: '/admin/api/media/upload',
    withCredentials: true,
    headers: { 'X-CSRF-Token': getCsrfToken() },
    // Only uploads still in flight are listed; a finished one is a slide below.
    fileList: uploads,
    showUploadList: { showRemoveIcon: false },
    beforeUpload: (file) => {
      const max = isVideoFile(file) ? usage.max_video : usage.max_image;
      if (file.size > max) {
        message.error(`${file.name}: файл больше ${bytes(max)}`);
        return Upload.LIST_IGNORE;
      }
      return true;
    },
    onChange: ({ file, fileList }) => {
      setUploads(fileList.filter((f) => f.status === 'uploading'));
      if (file.status === 'done') {
        accept(file.response);
        message.success(isVideoFile(file)
          ? `${file.name}: загружено, перекодируется в 720p`
          : `${file.name}: добавлено`);
      } else if (file.status === 'error') {
        if (file.xhr?.status === 401) onAuthError();
        else message.error(`${file.name}: ${file.response?.error || 'загрузка не удалась'}`);
      }
    },
  };

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Медиаканал — второй канал категории «Информация»: ваши страницы с текстом, картинки и видео по кругу."
        description="Один и тот же для всех клиентов, в том числе с истёкшей подпиской. Появляется в плейлисте, как только в нём есть хотя бы один готовый слайд. Видео перекодируется в 720p, а оригинал удаляется — так экономится место на диске."
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title="Канал">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onPressEnter={saveName}
                  addonBefore="Название"
                />
                <Button
                  icon={<SaveOutlined />}
                  disabled={!name.trim() || name === channel.name}
                  onClick={saveName}
                >
                  Сохранить
                </Button>
              </Space.Compact>
              <Space wrap>
                <Switch
                  checked={channel.enabled}
                  onChange={(enabled) => mutate(
                    () => api.patch('/admin/api/media/channel', { enabled }),
                    enabled ? 'Канал включён' : 'Канал выключен — он пропадёт из плейлистов',
                  ).catch(() => {})}
                />
                <Typography.Text>{channel.enabled ? 'Показывается клиентам' : 'Выключен'}</Typography.Text>
                <StatusTag status={status} hasSlides={items.length > 0} />
              </Space>
            </Space>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Слайдов" value={items.length} formatter={count} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Круг: {secondsPretty(status.seconds)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Typography.Text type="secondary">Место на диске</Typography.Text>
            <Progress
              percent={usedPercent}
              size="small"
              status={usedPercent >= 90 ? 'exception' : 'normal'}
              format={() => `${usedPercent}%`}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {bytes(usage.used)} из {bytes(usage.quota)}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      {status.state === 'error' ? (
        <Alert type="error" showIcon message="Не удалось собрать канал" description={status.error} />
      ) : null}

      <Card
        title="Слайды"
        extra={(
          <Space wrap>
            <Button icon={<FileTextOutlined />} type="primary" onClick={() => setEditing({ kind: 'text', item: null })}>
              Текст
            </Button>
            <Tooltip title="Пересобрать канал полностью">
              <Button
                icon={<ReloadOutlined />}
                aria-label="Пересобрать"
                onClick={() => mutate(() => api.post('/admin/api/media/rebuild'), 'Пересборка запущена').catch(() => {})}
              />
            </Tooltip>
          </Space>
        )}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Upload.Dragger {...uploadProps}>
            <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
            <p className="ant-upload-text">Перетащите сюда изображения или видео, или нажмите для выбора</p>
            <p className="ant-upload-hint">
              JPG, PNG, WebP до {bytes(usage.max_image)} · MP4, MKV, MOV, WebM до {bytes(usage.max_video)}
            </p>
          </Upload.Dragger>

          <SlideList
            items={items}
            onReorder={(next) => {
              setData((d) => ({ ...d, items: next })); // optimistic
              mutate(() => api.put('/admin/api/media/order', { ids: next.map((i) => i.id) })).catch(load);
            }}
            onEdit={(item) => setEditing({ kind: item.type, item })}
            onDelete={(item) => mutate(
              () => api.del(`/admin/api/media/items/${item.id}`),
              'Слайд удалён',
            ).catch(() => {})}
          />
        </Space>
      </Card>

      <TextSlideEditor
        open={editing?.kind === 'text'}
        item={editing?.kind === 'text' ? editing.item : null}
        defaults={data.defaults}
        limits={data.limits}
        api={api}
        onAuthError={onAuthError}
        onClose={() => setEditing(null)}
        onSave={(values) => mutate(
          () => (editing.item
            ? api.patch(`/admin/api/media/items/${editing.item.id}`, values)
            : api.post('/admin/api/media/items', { type: 'text', ...values })),
          editing.item ? 'Страница сохранена' : 'Страница добавлена',
        )}
      />
      <ImageSlideEditor
        open={editing?.kind === 'image'}
        item={editing?.kind === 'image' ? editing.item : null}
        limits={data.limits}
        onClose={() => setEditing(null)}
        onSave={(values) => mutate(
          () => api.patch(`/admin/api/media/items/${editing.item.id}`, values),
          'Изображение сохранено',
        )}
      />
    </Space>
  );
}
