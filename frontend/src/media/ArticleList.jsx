import {
  Button, Empty, Grid, Popconfirm, Space, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, ExclamationCircleOutlined, EyeInvisibleOutlined, FileTextOutlined, HolderOutlined,
  LoadingOutlined, LockOutlined, PictureOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { seconds as secondsPretty } from '../lib/format.js';
import { audienceLabel } from '../lib/audience.js';

function Cover({ article, compact }) {
  const box = {
    width: compact ? 56 : 96, height: compact ? 32 : 54, borderRadius: 6, background: '#0e1630', flexShrink: 0,
    display: 'grid', placeItems: 'center', color: '#7dd3fc', fontSize: 22, overflow: 'hidden',
  };
  if (!article.cover) return <div style={box}><FileTextOutlined /></div>;
  return (
    <div style={box}>
      <img
        src={`/admin/api/media/assets/${article.cover}/picture`}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  );
}

function ArticleRow({
  article, index, playing, compact, onEdit, onDelete, users, plans,
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: article.id });
  const meta = [
    article.images ? <span key="i"><PictureOutlined /> {article.images}</span> : null,
    article.videos ? <span key="v"><VideoCameraOutlined /> {article.videos}</span> : null,
    article.empty ? null : <span key="s">от {secondsPretty(article.seconds)}</span>,
  ].filter(Boolean);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 8 : 12,
        padding: compact ? '8px 6px' : '10px 12px',
        background: '#fff',
        border: '1px solid #f0f0f0',
        borderRadius: 10,
        marginBottom: 8,
        boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.15)' : 'none',
        position: 'relative',
        zIndex: isDragging ? 2 : 'auto',
      }}
    >
      <Button
        type="text"
        ref={setActivatorNodeRef}
        icon={<HolderOutlined />}
        aria-label="Перетащить"
        style={{ cursor: 'grab', touchAction: 'none' }}
        {...attributes}
        {...listeners}
      />
      {compact ? null : (
        <Typography.Text type="secondary" style={{ width: 36, textAlign: 'right' }}>
          {article.audience
            ? <Tooltip title="Номер у каждого клиента свой"><LockOutlined /></Tooltip>
            : (playing ? `${playing.index}/${playing.total}` : '—')}
        </Typography.Text>
      )}
      <Cover article={article} compact={compact} />
      <div
        style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
        onClick={() => onEdit(article)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEdit(article); }}
        role="button"
        tabIndex={0}
      >
        <div>
          <Typography.Text strong ellipsis style={{ maxWidth: '100%' }}>
            {article.title || article.summary || 'Без заголовка'}
          </Typography.Text>
        </div>
        <Space size={8} wrap style={{ fontSize: 12 }}>
          {article.empty ? <Tag>пустая — не в эфире</Tag> : null}
          {article.audience ? (
            <Tag icon={<LockOutlined />} color="purple">
              {`только: ${audienceLabel(article.audience, users, plans)}`}
            </Tag>
          ) : null}
          {article.private_sections ? (
            <Tag icon={<EyeInvisibleOutlined />} color="purple">
              {`закрытых частей: ${article.private_sections}`}
            </Tag>
          ) : null}
          {article.processing ? <Tag icon={<LoadingOutlined />} color="processing">видео обрабатывается</Tag> : null}
          {article.error ? (
            <Tooltip title={article.error}>
              <Tag icon={<ExclamationCircleOutlined />} color="error">ошибка</Tag>
            </Tooltip>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Space size={10}>{meta}</Space>
          </Typography.Text>
        </Space>
        {article.title && article.summary && !compact ? (
          <div>
            <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: '100%' }}>
              {article.summary}
            </Typography.Text>
          </div>
        ) : null}
      </div>
      <Space size={4} direction={compact ? 'vertical' : 'horizontal'}>
        <Button size={compact ? 'small' : 'middle'} icon={<EditOutlined />} aria-label="Редактировать" onClick={() => onEdit(article)} />
        <Popconfirm
          title="Удалить статью?"
          description="Её изображения и видео будут удалены с диска."
          okText="Удалить"
          okButtonProps={{ danger: true }}
          cancelText="Отмена"
          onConfirm={() => onDelete(article)}
        >
          <Button danger size={compact ? 'small' : 'middle'} icon={<DeleteOutlined />} aria-label="Удалить" />
        </Popconfirm>
      </Space>
    </div>
  );
}

// The articles in play order. Drag the handle (mouse, touch or keyboard) to
// reorder; the order — and so each article's «1/3» — is saved on drop.
export default function ArticleList({
  articles, onReorder, onEdit, onDelete, users = [], plans = [],
}) {
  const compact = !Grid.useBreakpoint().sm;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!articles.length) {
    return <Empty description="Статей пока нет — создайте первую" />;
  }

  // «1/3» counts only articles with something in them, as on the channel —
  // shown for the shared version; an article for a group is numbered per viewer.
  const live = articles.filter((a) => !a.empty && !a.audience);
  const place = new Map(live.map((a, i) => [a.id, { index: i + 1, total: live.length }]));

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = articles.findIndex((a) => a.id === active.id);
    const to = articles.findIndex((a) => a.id === over.id);
    onReorder(arrayMove(articles, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={articles.map((a) => a.id)} strategy={verticalListSortingStrategy}>
        {articles.map((article, index) => (
          <ArticleRow
            key={article.id}
            article={article}
            index={index}
            playing={place.get(article.id)}
            compact={compact}
            onEdit={onEdit}
            onDelete={onDelete}
            users={users}
            plans={plans}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}
