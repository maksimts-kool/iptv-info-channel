import { Tooltip, Typography } from 'antd';

// A viewer's player, the same on every screen: the name the server gives it
// (the app that downloaded the playlist, plus the TV when the stream goes
// through the TV's own player), with the raw User-Agent on hover.
export default function PlayerName({ name, userAgent }) {
  return (
    <Tooltip title={userAgent || 'User-Agent не передан'}>
      <Typography.Text>{name || 'неизвестный плеер'}</Typography.Text>
    </Tooltip>
  );
}
