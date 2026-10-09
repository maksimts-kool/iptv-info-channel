import { useRef } from 'react';
import { useEditorState } from '@tiptap/react';
import {
  Button, Divider, Dropdown, Tooltip,
} from 'antd';
import {
  BoldOutlined, CodeOutlined, CommentOutlined, ConsoleSqlOutlined, ItalicOutlined, LineOutlined, LockOutlined,
  OrderedListOutlined, PictureOutlined, RedoOutlined, StrikethroughOutlined, TableOutlined,
  UndoOutlined, UnorderedListOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import { IMAGE_ACCEPT, VIDEO_ACCEPT } from './upload.js';

function Tool({
  title, icon, label, active = false, disabled = false, onClick,
}) {
  return (
    <Tooltip title={title} mouseEnterDelay={0.4}>
      <Button
        type={active ? 'primary' : 'text'}
        ghost={false}
        icon={icon}
        disabled={disabled}
        aria-label={title}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
        onClick={onClick}
        style={label ? { fontWeight: 700, paddingInline: 8 } : undefined}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

// The editor's formatting bar: everything Markdown can express, as buttons,
// plus image and video upload (`onUpload(kind, file)` inserts the result) and
// the private-section wrapper (a part only some customers see).
export default function EditorToolbar({ editor, onUpload, uploading }) {
  const imageInput = useRef(null);
  const videoInput = useRef(null);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      table: e.isActive('table'),
      privateSection: e.isActive('privateSection'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();

  const tableItems = [
    { key: 'row', label: 'Добавить строку', onClick: () => chain().addRowAfter().run() },
    { key: 'col', label: 'Добавить столбец', onClick: () => chain().addColumnAfter().run() },
    { key: 'delrow', label: 'Удалить строку', onClick: () => chain().deleteRow().run() },
    { key: 'delcol', label: 'Удалить столбец', onClick: () => chain().deleteColumn().run() },
    { type: 'divider' },
    { key: 'deltable', label: 'Удалить таблицу', danger: true, onClick: () => chain().deleteTable().run() },
  ];

  const pick = (input) => input.current?.click();
  const picked = (kind) => (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    files.forEach((file) => onUpload(kind, file));
  };

  return (
    <div className="article-toolbar" role="toolbar" aria-label="Форматирование">
      <Tool title="Отменить" icon={<UndoOutlined />} disabled={!s.canUndo} onClick={() => chain().undo().run()} />
      <Tool title="Повторить" icon={<RedoOutlined />} disabled={!s.canRedo} onClick={() => chain().redo().run()} />
      <Divider type="vertical" />
      {/* A heading button on a heading turns it back into plain text. */}
      {[1, 2, 3].map((level) => (
        <Tool
          key={level}
          title={`Заголовок ${level}`}
          label={`H${level}`}
          active={s[`h${level}`]}
          onClick={() => chain().toggleHeading({ level }).run()}
        />
      ))}
      <Divider type="vertical" />
      <Tool title="Жирный" icon={<BoldOutlined />} active={s.bold} onClick={() => chain().toggleBold().run()} />
      <Tool title="Курсив" icon={<ItalicOutlined />} active={s.italic} onClick={() => chain().toggleItalic().run()} />
      <Tool title="Зачёркнутый" icon={<StrikethroughOutlined />} active={s.strike} onClick={() => chain().toggleStrike().run()} />
      <Tool title="Код в строке" icon={<CodeOutlined />} active={s.code} onClick={() => chain().toggleCode().run()} />
      <Divider type="vertical" />
      <Tool title="Маркированный список" icon={<UnorderedListOutlined />} active={s.bulletList} onClick={() => chain().toggleBulletList().run()} />
      <Tool title="Нумерованный список" icon={<OrderedListOutlined />} active={s.orderedList} onClick={() => chain().toggleOrderedList().run()} />
      <Tool title="Цитата" icon={<CommentOutlined />} active={s.blockquote} onClick={() => chain().toggleBlockquote().run()} />
      <Tool title="Блок кода" icon={<ConsoleSqlOutlined />} active={s.codeBlock} onClick={() => chain().toggleCodeBlock().run()} />
      <Tool title="Разделитель" icon={<LineOutlined />} onClick={() => chain().setHorizontalRule().run()} />
      {s.table ? (
        <Dropdown menu={{ items: tableItems }} trigger={['click']}>
          <Button type="primary" icon={<TableOutlined />} aria-label="Таблица" onMouseDown={(e) => e.preventDefault()} />
        </Dropdown>
      ) : (
        <Tool
          title="Таблица"
          icon={<TableOutlined />}
          onClick={() => chain().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()}
        />
      )}
      <Divider type="vertical" />
      <Tool title="Вставить изображение" icon={<PictureOutlined />} disabled={uploading} onClick={() => pick(imageInput)} />
      <Tool title="Вставить видео" icon={<VideoCameraOutlined />} disabled={uploading} onClick={() => pick(videoInput)} />
      <Divider type="vertical" />
      {/* Wraps the selected blocks; on a section already, takes its content back out. */}
      <Tool
        title={s.privateSection ? 'Убрать закрытую часть (показывать всем)' : 'Закрытая часть — только для выбранных клиентов'}
        icon={<LockOutlined />}
        active={s.privateSection}
        onClick={() => (s.privateSection
          ? chain().lift('privateSection').run()
          : chain().wrapIn('privateSection').run())}
      />
      <input ref={imageInput} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={picked('image')} />
      <input ref={videoInput} type="file" accept={VIDEO_ACCEPT} hidden onChange={picked('video')} />
    </div>
  );
}
