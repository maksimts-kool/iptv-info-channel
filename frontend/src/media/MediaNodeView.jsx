import { useEffect, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import {
  Button, Input, Segmented, Spin, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, ExclamationCircleOutlined, HolderOutlined, PlayCircleFilled,
} from '@ant-design/icons';
import { api } from '../lib/api.js';
import { seconds as secondsPretty } from '../lib/format.js';

const SIZES = [
  { label: 'Во всю ширину', value: 'full' },
  { label: 'Половина', value: 'half' },
  { label: 'Маленькое', value: 'small' },
];

const POLL_MS = 2_000;

// An image or video block inside the editor: the picture at (roughly) its TV
// width, plus a size picker, a caption and a delete button. A video that is
// still being re-encoded shows a spinner and polls until it is ready.
export default function MediaNodeView({
  node, updateAttributes, deleteNode, selected,
}) {
  const { assetId, size, caption } = node.attrs;
  const isVideo = node.type.name === 'mediaVideo';
  const [asset, setAsset] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const load = async () => {
      try {
        const next = await api.get(`/admin/api/media/assets/${assetId}`);
        if (stopped) return;
        setAsset(next);
        if (next.status === 'processing') timer = setTimeout(load, POLL_MS);
      } catch {
        if (!stopped) setMissing(true);
      }
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [assetId]);

  const processing = asset?.status === 'processing';
  const failed = asset?.status === 'error';

  let picture;
  if (missing) {
    picture = <div className="media-node-placeholder">Файл не найден</div>;
  } else if (!asset || processing) {
    picture = (
      <div className="media-node-placeholder">
        <Spin size="small" />
        <span>{processing ? 'Видео перекодируется в 720p…' : 'Загрузка…'}</span>
      </div>
    );
  } else if (failed) {
    picture = (
      <div className="media-node-placeholder media-node-error">
        <ExclamationCircleOutlined />
        <span>{asset.error || 'Не удалось обработать файл'}</span>
      </div>
    );
  } else {
    picture = (
      <div className="media-node-picture">
        <img src={`/admin/api/media/assets/${assetId}/picture`} alt={caption || ''} draggable={false} />
        {isVideo ? <PlayCircleFilled className="media-node-play" /> : null}
        {isVideo ? <span className="media-node-duration">{secondsPretty(asset.duration)}</span> : null}
      </div>
    );
  }

  return (
    <NodeViewWrapper className={`media-node media-node-${size}${selected ? ' is-selected' : ''}`}>
      <div className="media-node-frame" data-drag-handle>
        {picture}
      </div>
      <div className="media-node-controls" contentEditable={false}>
        <Tooltip title="Перетащите, чтобы переместить">
          <HolderOutlined className="media-node-grip" data-drag-handle />
        </Tooltip>
        <Segmented size="small" options={SIZES} value={size} onChange={(value) => updateAttributes({ size: value })} />
        <Input
          size="small"
          placeholder={isVideo ? 'Подпись к видео' : 'Подпись к изображению'}
          value={caption}
          maxLength={200}
          onChange={(e) => updateAttributes({ caption: e.target.value })}
          style={{ flex: 1, minWidth: 140 }}
        />
        <Tooltip title={isVideo ? 'Удалить видео' : 'Удалить изображение'}>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={deleteNode} aria-label="Удалить" />
        </Tooltip>
      </div>
      {isVideo && !processing && !failed && asset ? (
        <Typography.Text type="secondary" className="media-node-note" contentEditable={false}>
          На экране страница остановится, пока идёт видео
          {asset.has_audio === false ? '' : ' (звук видео вместо музыки)'}
        </Typography.Text>
      ) : null}
    </NodeViewWrapper>
  );
}
