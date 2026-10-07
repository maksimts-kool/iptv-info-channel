import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import {
  Alert, App as AntApp, Button, Drawer, Grid, Input, InputNumber, Modal, Progress, Space, Spin, Tooltip, Typography,
} from 'antd';
import { ColumnHeightOutlined, EyeOutlined, SaveOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { bytes, seconds as secondsPretty } from '../lib/format.js';
import EditorToolbar from './EditorToolbar.jsx';
import { MediaImage, MediaVideo } from './mediaNodes.js';
import { isVideoFile, uploadFile } from './upload.js';

const EXTENSIONS = [
  // Exactly the Markdown set: no underline, no links (a TV can't follow one).
  StarterKit.configure({ link: false, underline: false }),
  TableKit.configure({ table: { resizable: false } }),
  Placeholder.configure({ placeholder: 'Начните писать статью… Изображения и видео — кнопками на панели или перетаскиванием файла сюда.' }),
  MediaImage,
  MediaVideo,
];

const isEmptyDoc = (doc) => !doc?.content?.some((n) => n.type !== 'paragraph' || n.content?.length);

// One article: title, the rich-text body with images and videos inside, and
// how long it stays on screen. The body is styled like the TV page (dark
// background, the channel's colours), so the editor is close to what airs;
// "Как на ТВ" renders the real thing on the server.
export default function ArticleEditor({
  articleId, isNew, api, defaults, limits, usage, onAuthError, onSaved, onClose,
}) {
  const { message, modal } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const [article, setArticle] = useState(null);
  const [title, setTitle] = useState('');
  const [seconds, setSeconds] = useState(defaults?.seconds ?? 15);
  const [speed, setSpeed] = useState(defaults?.scrollSpeed ?? 40);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState([]); // [{ key, name, percent }]
  const [preview, setPreview] = useState(null); // null | 'loading' | result
  const savedOnce = useRef(!isNew);
  const queue = useRef(Promise.resolve());

  const fail = useCallback((e) => {
    if (e instanceof AuthError) onAuthError();
    else message.error(e.message);
  }, [onAuthError, message]);

  // Uploads go one at a time (a phone's photo burst shouldn't open ten
  // connections) and are inserted at the cursor as each finishes.
  const onUploadRef = useRef(null);
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: null,
    onUpdate: () => setDirty(true),
    editorProps: {
      attributes: { class: 'article-body' },
      handleDrop: (view, event, slice, moved) => {
        const files = [...(event.dataTransfer?.files || [])];
        if (moved || !files.length) return false;
        event.preventDefault();
        files.forEach((file) => onUploadRef.current?.(isVideoFile(file) ? 'video' : 'image', file));
        return true;
      },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length) return false;
        files.forEach((file) => onUploadRef.current?.(isVideoFile(file) ? 'video' : 'image', file));
        return true;
      },
    },
  });

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const loaded = await api.get(`/admin/api/media/articles/${articleId}`);
        if (stopped) return;
        setArticle(loaded);
        setTitle(loaded.title);
        setSeconds(loaded.seconds);
        setSpeed(loaded.scroll_speed);
      } catch (e) {
        fail(e);
        onClose();
      }
    })();
    return () => { stopped = true; };
  }, [api, articleId, fail, onClose]);

  useEffect(() => {
    if (editor && article) {
      editor.commands.setContent(article.doc, { emitUpdate: false });
      setDirty(false);
    }
  }, [editor, article]);

  const onUpload = useCallback((kind, file) => {
    const max = kind === 'video' ? usage?.max_video : usage?.max_image;
    if (max && file.size > max) {
      message.error(`${file.name}: файл больше ${bytes(max)}`);
      return;
    }
    const key = `${Date.now()}-${Math.random()}`;
    setUploads((list) => [...list, { key, name: file.name, percent: 0 }]);
    queue.current = queue.current.then(async () => {
      try {
        const asset = await uploadFile(`/admin/api/media/articles/${articleId}/assets`, file, (percent) => {
          setUploads((list) => list.map((u) => (u.key === key ? { ...u, percent } : u)));
        });
        // Insert AFTER the selection, never over it: a just-inserted picture
        // is still selected, and replacing it would drop it from the article.
        if (editor) {
          editor.chain().focus().insertContentAt(editor.state.selection.to, {
            type: asset.kind === 'video' ? 'mediaVideo' : 'mediaImage',
            attrs: { assetId: asset.id, size: 'full', caption: '' },
          }).run();
        }
        if (asset.kind === 'video') message.info(`${file.name}: загружено, перекодируется в 720p`);
      } catch (e) {
        fail(e);
      } finally {
        setUploads((list) => list.filter((u) => u.key !== key));
      }
    });
  }, [articleId, editor, usage, message, fail]);
  onUploadRef.current = onUpload;

  const body = () => ({
    title, doc: editor.getJSON(), seconds, scroll_speed: speed,
  });

  const save = async ({ close = false } = {}) => {
    setSaving(true);
    try {
      await api.patch(`/admin/api/media/articles/${articleId}`, body());
      savedOnce.current = true;
      setDirty(false);
      message.success('Статья сохранена');
      onSaved();
      if (close) onClose();
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    setPreview('loading');
    try {
      setPreview(await api.post('/admin/api/media/preview', body()));
    } catch (e) {
      setPreview(null);
      fail(e);
    }
  };

  // Closing: confirm unsaved changes; a brand-new article that was never saved
  // (and so is empty) is removed instead of being left behind.
  const close = () => {
    const discardNew = async () => {
      if (!savedOnce.current) {
        try { await api.del(`/admin/api/media/articles/${articleId}`); } catch { /* best effort */ }
        onSaved();
      }
      onClose();
    };
    const changed = dirty || title !== (article?.title ?? '');
    if (!changed || (!savedOnce.current && isEmptyDoc(editor?.getJSON()) && !title)) {
      discardNew();
      return;
    }
    modal.confirm({
      title: 'Закрыть без сохранения?',
      content: 'Изменения в статье будут потеряны.',
      okText: 'Закрыть',
      okButtonProps: { danger: true },
      cancelText: 'Вернуться',
      onOk: discardNew,
    });
  };

  return (
    <Drawer
      open
      title={isNew ? 'Новая статья' : 'Статья'}
      width={screens.lg ? 1040 : '100%'}
      onClose={close}
      maskClosable={false}
      destroyOnClose
      styles={{ body: { paddingTop: 12 } }}
      extra={(
        <Space>
          <Tooltip title={screens.sm ? null : 'Как на ТВ'}>
            <Button icon={<EyeOutlined />} onClick={showPreview} disabled={!article} aria-label="Как на ТВ">
              {screens.sm ? 'Как на ТВ' : null}
            </Button>
          </Tooltip>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!article} onClick={() => save({ close: true })}>
            Сохранить
          </Button>
        </Space>
      )}
    >
      {!article ? <Spin /> : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input
            size="large"
            placeholder="Заголовок (виден в углу экрана: «1/3 · Заголовок»)"
            value={title}
            maxLength={limits?.titleChars}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="article-editor">
            <EditorToolbar editor={editor} onUpload={onUpload} uploading={false} />
            {uploads.map((u) => (
              <div key={u.key} className="article-upload">
                <Typography.Text ellipsis style={{ maxWidth: 260 }}>{u.name}</Typography.Text>
                <Progress percent={u.percent} size="small" style={{ flex: 1, margin: 0 }} />
              </div>
            ))}
            <EditorContent editor={editor} />
          </div>
          <Space wrap size={24}>
            <Space>
              <Typography.Text>Показывать, сек.</Typography.Text>
              <Tooltip title="Для статьи, которая помещается на один экран. Длинная прокручивается и идёт столько, сколько нужно (плюс время видео).">
                <InputNumber
                  min={limits?.minSeconds ?? 3}
                  max={limits?.maxSeconds ?? 600}
                  precision={0}
                  value={seconds}
                  onChange={(v) => { setSeconds(v); setDirty(true); }}
                />
              </Tooltip>
            </Space>
            <Space>
              <Typography.Text>Скорость прокрутки</Typography.Text>
              <Tooltip title="Пикселей в секунду. 40 — спокойное чтение.">
                <InputNumber
                  min={limits?.minSpeed ?? 10}
                  max={limits?.maxSpeed ?? 200}
                  precision={0}
                  value={speed}
                  onChange={(v) => { setSpeed(v); setDirty(true); }}
                />
              </Tooltip>
            </Space>
          </Space>
        </Space>
      )}

      <Modal
        open={!!preview}
        title="Так статья выглядит на экране"
        footer={null}
        width={900}
        onCancel={() => setPreview(null)}
      >
        {preview === 'loading' ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div> : null}
        {preview && preview !== 'loading' ? (
          preview.image ? (
            <>
              <div className="article-preview">
                <img src={preview.image} alt="Предпросмотр" />
              </div>
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                {preview.scrolls ? <><ColumnHeightOutlined /> Прокручивается (прокрутите предпросмотр). </> : null}
                {preview.videos ? `Видео: ${preview.videos} — прокрутка останавливается, пока оно идёт. ` : ''}
                На экране: {secondsPretty(preview.seconds)}.
              </Typography.Paragraph>
            </>
          ) : <Alert type="info" showIcon message="Статья пока пустая — на канал она не попадёт." />
        ) : null}
      </Modal>
    </Drawer>
  );
}
