import { Alert, Progress } from 'antd';

// Presentational: renders the "encoding in progress / complete" banner from the
// generation-status state machine owned by App. Floats in the bottom-right
// corner (fixed) so it overlays the page instead of shifting the sections down.
export default function RegenBanner({ gen }) {
  if (!gen.visible) return null;
  return (
    <div
      style={{
        position: 'fixed',
        zIndex: 1000,
        bottom: 24,
        right: 24,
        width: 'min(400px, calc(100vw - 32px))',
        boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
        borderRadius: 8,
      }}
    >
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
    </div>
  );
}
