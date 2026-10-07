import { useEffect, useRef, useState } from 'react';
import {
  Alert, Col, Collapse, Form, Input, InputNumber, Modal, Row, Space, Spin, Typography,
} from 'antd';
import { ColumnHeightOutlined } from '@ant-design/icons';
import { AuthError } from '../lib/api.js';
import { seconds as secondsPretty } from '../lib/format.js';

// What the renderer understands. Kept next to the editor rather than in a
// tooltip: it is the whole "formatting toolbar".
const CHEATSHEET = [
  ['# Заголовок', 'крупный заголовок (## и ### — поменьше)'],
  ['**жирный**', 'жирный текст'],
  ['*курсив*', 'курсив'],
  ['~~зачёркнутый~~', 'зачёркнутый'],
  ['- пункт', 'маркированный список (отступ 2 пробела — вложенный)'],
  ['1. пункт', 'нумерованный список'],
  ['> цитата', 'выделенный блок'],
  ['---', 'разделительная линия'],
  ['`код`', 'моноширинная плашка'],
  ['| A | B |', 'таблица (вторая строка |---|---|)'],
];

const PREVIEW_DELAY_MS = 600;

// Write (or edit) a text page. The preview on the right is rendered by the
// SERVER with the same code the encoder uses, so what is shown is exactly what
// lands on the TV — including where a long page starts to scroll.
export default function TextSlideEditor({
  open, item, defaults, limits, api, onAuthError, onSave, onClose,
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const timer = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      markdown: item?.markdown ?? '# Заголовок\n\nТекст страницы. **Жирный**, *курсив*, списки:\n\n- первый пункт\n- второй пункт',
      seconds: item?.seconds ?? defaults?.seconds ?? 15,
      scroll_speed: item?.scroll_speed ?? defaults?.scrollSpeed ?? 40,
      title: item?.title ?? '',
    });
    setPreview(null);
    setPreviewError(null);
    requestPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const requestPreview = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const values = form.getFieldsValue();
      if (!String(values.markdown || '').trim()) { setPreview(null); return; }
      const mine = ++seq.current;
      setPreviewing(true);
      try {
        const result = await api.post('/admin/api/media/preview', {
          markdown: values.markdown,
          seconds: values.seconds || undefined,
          scroll_speed: values.scroll_speed || undefined,
        });
        if (mine === seq.current) { setPreview(result); setPreviewError(null); }
      } catch (e) {
        if (e instanceof AuthError) onAuthError();
        else if (mine === seq.current) setPreviewError(e.message);
      } finally {
        if (mine === seq.current) setPreviewing(false);
      }
    }, PREVIEW_DELAY_MS);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await onSave(values);
      onClose();
    } catch {
      // onSave has already reported it; keep the dialog open for a fix.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={item ? 'Текстовая страница' : 'Новая текстовая страница'}
      okText="Сохранить"
      cancelText="Отмена"
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      width={1180}
      forceRender
      style={{ top: 24 }}
    >
      <Form form={form} layout="vertical" onValuesChange={requestPreview}>
        <Row gutter={[24, 16]}>
          <Col xs={24} lg={11}>
            <Form.Item name="title" label="Название в списке (необязательно)">
              <Input maxLength={80} placeholder="Видно только в админке" />
            </Form.Item>
            <Form.Item
              name="markdown"
              label="Текст (Markdown)"
              rules={[{ required: true, whitespace: true, message: 'Введите текст' }]}
            >
              <Input.TextArea
                autoSize={{ minRows: 12, maxRows: 22 }}
                maxLength={limits?.markdownChars}
                showCount
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
              />
            </Form.Item>
            <Space wrap size={16}>
              <Form.Item
                name="seconds"
                label="Показывать, сек."
                tooltip="Для страницы, которая помещается на экран. Длинная страница прокручивается и идёт столько, сколько нужно."
                rules={[{ required: true }]}
              >
                <InputNumber min={limits?.minSeconds ?? 3} max={limits?.maxSeconds ?? 600} precision={0} />
              </Form.Item>
              <Form.Item
                name="scroll_speed"
                label="Скорость прокрутки, пикс./сек."
                tooltip="Только для длинных страниц. 40 — спокойное чтение."
                rules={[{ required: true }]}
              >
                <InputNumber min={limits?.minSpeed ?? 10} max={limits?.maxSpeed ?? 200} precision={0} />
              </Form.Item>
            </Space>
            <Collapse
              size="small"
              items={[{
                key: 'help',
                label: 'Как оформлять текст',
                children: (
                  <table style={{ width: '100%', fontSize: 13 }}>
                    <tbody>
                      {CHEATSHEET.map(([code, what]) => (
                        <tr key={code}>
                          <td style={{ padding: '2px 12px 2px 0', whiteSpace: 'nowrap' }}>
                            <Typography.Text code>{code}</Typography.Text>
                          </td>
                          <td style={{ padding: '2px 0' }}>{what}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ),
              }]}
            />
          </Col>
          <Col xs={24} lg={13}>
            <Typography.Text type="secondary">Так страница будет выглядеть на экране</Typography.Text>
            <div
              style={{
                marginTop: 8,
                aspectRatio: '16 / 9',
                overflowY: 'auto',
                background: '#0e1630',
                borderRadius: 8,
                position: 'relative',
              }}
            >
              {preview ? (
                <img src={preview.image} alt="Предпросмотр" style={{ width: '100%', display: 'block' }} />
              ) : null}
              {previewing ? (
                <div style={{ position: 'absolute', top: 12, right: 12 }}><Spin size="small" /></div>
              ) : null}
            </div>
            {previewError ? (
              <Alert type="error" showIcon style={{ marginTop: 8 }} message={previewError} />
            ) : null}
            {preview ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                {preview.scrolls ? (
                  <>
                    <ColumnHeightOutlined /> Не помещается на один экран — будет прокручиваться
                    (прокрутите предпросмотр, чтобы увидеть всё). На экране: {secondsPretty(preview.seconds)}
                  </>
                ) : (
                  <>На экране: {secondsPretty(preview.seconds)} (округляется до целых сегментов потока)</>
                )}
              </Typography.Paragraph>
            ) : null}
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
