import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Tooltip, Typography,
} from 'antd';
import {
  CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, FileTextOutlined, LoadingOutlined,
  LockOutlined, PictureOutlined, PlusOutlined,
} from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { bytes, count, seconds as secondsPretty } from '../lib/format.js';
import { clientsWord } from '../lib/audience.js';
import ChannelHeader from '../components/ChannelHeader.jsx';
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
// another. Everyone sees the same channel unless an article (or a section of
// one) is addressed to a group of customers; those customers get their own
// version of the loop. Edits save at once; the server rebuilds in the
// background, re-encoding only what changed. Laid out like Инфоканал.
export default function MediaPage({
  api, state, message, onAuthError,
}) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // { id, isNew }
  const users = state?.users || [];
  const plans = state?.plans || [];

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/api/media'));
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);

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
      setData(await action());
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
  const privateArticles = articles.filter((a) => a.audience || a.private_sections).length;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ChannelHeader
        icon={<PictureOutlined />}
        name={channel.name}
        onRename={(name) => mutate(() => api.patch('/admin/api/media/channel', { name }), 'Название сохранено')}
        description="Второй канал категории «Информация»: ваши статьи с текстом, изображениями и видео, одна за другой — в том числе у клиентов с истёкшей подпиской. Длинная статья прокручивается, на видео прокрутка останавливается. Статью или её часть можно показать только выбранным клиентам."
        status={<StatusTag status={status} hasArticles={articles.some((a) => !a.empty)} />}
        enabled={channel.enabled}
        onToggle={(enabled) => mutate(
          () => api.patch('/admin/api/media/channel', { enabled }),
          enabled ? 'Канал включён' : 'Канал выключен — он пропадёт из плейлистов',
        )}
        onRebuild={() => mutate(() => api.post('/admin/api/media/rebuild'), 'Пересборка запущена')}
        rebuilding={status.state === 'building'}
        rebuildHint="Обычно не нужно: канал пересобирается сам после каждой правки."
      />

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Статей в эфире у всех"
              value={status.articles || 0}
              formatter={count}
              prefix={<FileTextOutlined />}
              suffix={<Typography.Text type="secondary" style={{ fontSize: 14 }}>{`/ ${count(articles.length)}`}</Typography.Text>}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Длительность круга" value={secondsPretty(status.seconds)} prefix={<ClockCircleOutlined />} valueStyle={{ fontSize: 20 }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Статей с закрытым содержимым"
              value={privateArticles}
              formatter={count}
              prefix={<LockOutlined />}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {status.private_viewers
                ? `${status.private_viewers} ${clientsWord(status.private_viewers)} видят свою версию канала`
                : 'Все клиенты видят один и тот же канал'}
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
        extra={<Button icon={<PlusOutlined />} type="primary" onClick={createArticle}>Новая статья</Button>}
      >
        <ArticleList
          articles={articles}
          users={users}
          plans={plans}
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
          users={users}
          plans={plans}
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
