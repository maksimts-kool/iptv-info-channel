import { Alert, Progress } from 'antd';

// Presentational: renders the "encoding in progress / complete" banner from the
// generation-status state machine owned by App.
export default function RegenBanner({ gen }) {
  if (!gen.visible) return null;
  return (
    <Alert
      type={gen.complete ? 'success' : 'info'}
      showIcon
      message={gen.title}
      description={(
        <div>
          <div>{gen.detail}</div>
          {gen.showProgress ? (
            <Progress percent={gen.percent} status={gen.complete ? 'success' : 'active'} />
          ) : null}
          {gen.count ? <div style={{ marginTop: 4, opacity: 0.75 }}>{gen.count}</div> : null}
        </div>
      )}
    />
  );
}
