import {
  Button, Empty, Grid, Popconfirm, Space, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, ExclamationCircleOutlined, FileTextOutlined, HolderOutlined,
  LoadingOutlined, PictureOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { bytes, seconds as secondsPretty } from '../lib/format.js';

const TYPE = {
  text: { label: 'Текст', Icon: FileTextOutlined, color: 'blue' },
  image: { label: 'Изображение', Icon: PictureOutlined, color: 'green' },
  video: { label: 'Видео', Icon: VideoCameraOutlined, color: 'purple' },
};

// First meaningful line of a text page, without the Markdown markers.
function textSummary(markdown) {
  const line = String(markdown || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/^[#>\-*\d.\s]+/, '').replace(/[*_~`]/g, '').slice(0, 90) || 'Пустая страница';
}

function slideTitle(item) {
  if (item.title) return item.title;
  if (item.type === 'text') return textSummary(item.markdown);
  return item.original_name || TYPE[item.type].label;
}

function slideMeta(item) {
  if (item.type === 'text') return `${secondsPretty(item.seconds)} · прокрутка ${item.scroll_speed} пикс./сек. для длинных`;
  if (item.type === 'image') {
    return [secondsPretty(item.seconds), item.caption ? `«${item.caption}»` : 'без подписи', bytes(item.size)].join(' · ');
  }
  if (item.status === 'processing') return `${secondsPretty(item.duration)} · перекодируется в 720p…`;
  return [secondsPretty(item.duration), item.size ? bytes(item.size) : null].filter(Boolean).join(' · ');
}

function Thumb({ item, compact }) {
  const { Icon } = TYPE[item.type];
  const box = {
    width: compact ? 56 : 96, height: compact ? 32 : 54, borderRadius: 6, background: '#0e1630', flexShrink: 0,
    display: 'grid', placeItems: 'center', color: '#7dd3fc', fontSize: 22, overflow: 'hidden',
  };
  const hasPicture = item.type === 'image' || (item.type === 'video' && item.has_thumb);
  if (!hasPicture) return <div style={box}><Icon /></div>;
  return (
    <div style={box}>
      <img
        src={`/admin/api/media/items/${item.id}/thumb?v=${encodeURIComponent(item.created_at || '')}`}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  );
}

function SlideRow({
  item, index, compact, onEdit, onDelete,
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: item.id });
  const type = TYPE[item.type];
  const processing = item.type === 'video' && item.status === 'processing';
  const failed = item.error || (item.type === 'video' && item.status === 'error');

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
        <Typography.Text type="secondary" style={{ width: 20, textAlign: 'right' }}>{index + 1}</Typography.Text>
      )}
      <Thumb item={item} compact={compact} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={6} wrap>
          <Tag color={type.color} style={{ marginInlineEnd: 0 }}>{type.label}</Tag>
          {processing ? <Tag icon={<LoadingOutlined />} color="processing">обработка</Tag> : null}
          {failed ? (
            <Tooltip title={item.error || 'Ошибка обработки'}>
              <Tag icon={<ExclamationCircleOutlined />} color="error">ошибка</Tag>
            </Tooltip>
          ) : null}
        </Space>
        <div>
          <Typography.Text strong ellipsis style={{ maxWidth: '100%' }}>{slideTitle(item)}</Typography.Text>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>{slideMeta(item)}</Typography.Text>
      </div>
      <Space size={4} direction={compact ? 'vertical' : 'horizontal'}>
        {item.type !== 'video' ? (
          <Button
            size={compact ? 'small' : 'middle'}
            icon={<EditOutlined />}
            aria-label="Изменить"
            onClick={() => onEdit(item)}
          />
        ) : null}
        <Popconfirm
          title="Удалить слайд?"
          description={item.type === 'text' ? null : 'Файл будет удалён с диска.'}
          okText="Удалить"
          okButtonProps={{ danger: true }}
          cancelText="Отмена"
          onConfirm={() => onDelete(item)}
        >
          <Button danger size={compact ? 'small' : 'middle'} icon={<DeleteOutlined />} aria-label="Удалить" />
        </Popconfirm>
      </Space>
    </div>
  );
}

// The channel's slides in play order. Drag the handle (mouse, touch or
// keyboard) to reorder; the new order is saved as soon as it is dropped.
export default function SlideList({
  items, onReorder, onEdit, onDelete,
}) {
  const compact = !Grid.useBreakpoint().sm;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!items.length) {
    return <Empty description="Слайдов пока нет — добавьте текст или загрузите файл" />;
  }

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.id === active.id);
    const to = items.findIndex((i) => i.id === over.id);
    onReorder(arrayMove(items, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item, index) => (
          <SlideRow
            key={item.id}
            item={item}
            index={index}
            compact={compact}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}
