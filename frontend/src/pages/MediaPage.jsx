import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, Input, Progress, Row, Space, Statistic, Switch, Tag, Tooltip, Typography,
} from 'antd';
import {
  CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, SaveOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { bytes, count, seconds as secondsPretty } from '../lib/format.js';
import ArticleList from '../media/ArticleList.jsx';
import ArticleEditor from '../media/ArticleEditor.jsx';

const POLL_MS = 2_000;

function StatusTag({ status, hasArticles }) {
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
  return <Tag>{hasArticles ? 'ожидает сборки' : 'нет статей'}</Tag>;
}

// The media channel: the second built-in channel of Информация. Its content is
// a set of articles — text with images and videos inside — shown one after
// another, the same for every customer (expired ones too). Edits save at once;
// the server rebuilds the loop in the background, re-encoding only what changed.
export default function MediaPage({ api, message, onAuthError }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null); // { id, isNew }

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
    data.status.state === 'building' || data.status.pending || data.articles.some((a) => a.processing)
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
    }
  };

  const createArticle = async () => {
    try {
      const created = await api.post('/admin/api/media/articles', {});
      setEditing({ id: created.id, isNew: true });
    } catch (e) {
      fail(e);
    }
  };

  const closeEditor = useCallback(() => setEditing(null), []);

  if (!data) return <Card loading />;

  const {
    channel, articles, status, usage,
  } = data;
  const usedPercent = Math.min(100, Math.round((usage.used / usage.quota) * 100));
  const saveName = () => mutate(() => api.patch('/admin/api/media/channel', { name }), 'Название сохранено');

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Медиаканал — второй канал категории «Информация»: ваши статьи с текстом, изображениями и видео, одна за другой."
        description="Один и тот же для всех клиентов, в том числе с истёкшей подпиской. Длинная статья прокручивается, а на видео прокрутка останавливается, пока оно идёт. В углу экрана — «1/3 · заголовок». Видео перекодируется в 720p, а оригинал удаляется — так экономится место."
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
                <Button icon={<SaveOutlined />} disabled={!name.trim() || name === channel.name} onClick={saveName}>
                  Сохранить
                </Button>
              </Space.Compact>
              <Space wrap>
                <Switch
                  checked={channel.enabled}
                  onChange={(enabled) => mutate(
                    () => api.patch('/admin/api/media/channel', { enabled }),
                    enabled ? 'Канал включён' : 'Канал выключен — он пропадёт из плейлистов',
                  )}
                />
                <Typography.Text>{channel.enabled ? 'Показывается клиентам' : 'Выключен'}</Typography.Text>
                <StatusTag status={status} hasArticles={articles.some((a) => !a.empty)} />
              </Space>
            </Space>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Статей в эфире" value={status.articles || 0} formatter={count} />
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
        title="Статьи"
        extra={(
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={createArticle}>Новая статья</Button>
            <Tooltip title="Пересобрать канал полностью">
              <Button
                icon={<ReloadOutlined />}
                aria-label="Пересобрать"
                onClick={() => mutate(() => api.post('/admin/api/media/rebuild'), 'Пересборка запущена')}
              />
            </Tooltip>
          </Space>
        )}
      >
        <ArticleList
          articles={articles}
          onReorder={(next) => {
            setData((d) => ({ ...d, articles: next })); // optimistic
            mutate(() => api.put('/admin/api/media/order', { ids: next.map((a) => a.id) }));
          }}
          onEdit={(article) => setEditing({ id: article.id, isNew: false })}
          onDelete={(article) => mutate(() => api.del(`/admin/api/media/articles/${article.id}`), 'Статья удалена')}
        />
      </Card>

      {editing ? (
        <ArticleEditor
          key={editing.id}
          articleId={editing.id}
          isNew={editing.isNew}
          api={api}
          defaults={data.defaults}
          limits={data.limits}
          usage={usage}
          onAuthError={onAuthError}
          onSaved={load}
          onClose={closeEditor}
        />
      ) : null}
    </Space>
  );
}
