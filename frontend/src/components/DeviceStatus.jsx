import { Badge, Tooltip } from 'antd';

// A device's state, the same on every device list: playing, playing one of the
// built-in channels (which are not limited, so under a limit it holds no
// slot), or turned away by the limit.
export default function DeviceStatus({ device, limited }) {
  if (!device.allowed) return <Badge status="error" text="сверх лимита" />;
  if (limited && !device.slot) {
    return (
      <Tooltip title="Свой канал (инфоканал или медиаканал) не ограничен — место не занимает">
        <Badge status="processing" color="green" text="смотрит · без места" />
      </Tooltip>
    );
  }
  return <Badge status="processing" color="green" text="смотрит" />;
}
