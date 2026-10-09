import {
  Button, Card, Space, Switch, Tooltip, Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

// The head of a built-in channel's page (Инфоканал, Медиаканал): what the
// channel is, its name as customers see it in the playlist (click the pencil to
// rename), whether it is on air, and the rebuild control. Both pages open with
// it, followed by a row of numbers and then their content cards — the same
// shape as Устройства — so the two channels read as siblings.
export default function ChannelHeader({
  icon, name, nameNote = null, onRename, description, status, enabled, onToggle, toggleLocked = null,
  onRebuild, rebuilding = false, rebuildHint,
}) {
  return (
    <Card className="channel-header">
      <div className="channel-header-row">
        <div className="channel-header-icon">{icon}</div>
        <div className="channel-header-main">
          <Space size={10} wrap align="center">
            <Typography.Title
              level={4}
              style={{ margin: 0 }}
              editable={onRename ? {
                onChange: (value) => { if (value.trim() && value.trim() !== name) onRename(value.trim()); },
                maxLength: 80,
                tooltip: 'Переименовать — так канал называется в плейлисте',
                triggerType: ['icon'],
              } : false}
            >
              {name}
            </Typography.Title>
            {nameNote}
            {status}
          </Space>
          <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
            {description}
          </Typography.Paragraph>
        </div>
        <Space className="channel-header-actions" size={12} wrap>
          {toggleLocked ? (
            <Tooltip title={toggleLocked}>
              <Space size={6}>
                <Switch checked disabled />
                <Typography.Text type="secondary">Всегда в эфире</Typography.Text>
              </Space>
            </Tooltip>
          ) : (
            <Space size={6}>
              <Switch checked={enabled} onChange={onToggle} />
              <Typography.Text>{enabled ? 'Показывается клиентам' : 'Выключен'}</Typography.Text>
            </Space>
          )}
          {onRebuild ? (
            <Tooltip title={rebuildHint}>
              <Button icon={<ReloadOutlined />} loading={rebuilding} onClick={onRebuild}>
                Пересобрать
              </Button>
            </Tooltip>
          ) : null}
        </Space>
      </div>
    </Card>
  );
}
