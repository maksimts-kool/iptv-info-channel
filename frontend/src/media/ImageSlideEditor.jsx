import { useEffect, useState } from 'react';
import {
  Form, Input, InputNumber, Modal,
} from 'antd';

// Caption + on-screen time of an uploaded image. The picture itself is
// replaced by deleting the slide and uploading another.
export default function ImageSlideEditor({
  open, item, limits, onSave, onClose,
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && item) {
      form.setFieldsValue({ caption: item.caption, seconds: item.seconds, title: item.title });
    }
  }, [open, item, form]);

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
      title="Изображение"
      okText="Сохранить"
      cancelText="Отмена"
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      forceRender
    >
      {item ? (
        <img
          src={`/admin/api/media/items/${item.id}/thumb`}
          alt=""
          style={{
            width: '100%', maxHeight: 260, objectFit: 'contain', background: '#0e1630', borderRadius: 8, marginBottom: 16,
          }}
        />
      ) : null}
      <Form form={form} layout="vertical">
        <Form.Item name="caption" label="Подпись под изображением">
          <Input maxLength={limits?.captionChars} showCount placeholder="Без подписи" />
        </Form.Item>
        <Form.Item name="seconds" label="Показывать, сек." rules={[{ required: true }]}>
          <InputNumber min={limits?.minSeconds ?? 3} max={limits?.maxSeconds ?? 600} precision={0} />
        </Form.Item>
        <Form.Item name="title" label="Название в списке (необязательно)">
          <Input maxLength={80} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
