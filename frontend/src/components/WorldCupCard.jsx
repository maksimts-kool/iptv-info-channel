import { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Empty, InputNumber, Space, Switch, Tag, Typography,
} from 'antd';
import { AuthError } from '../api.js';

const STATUS_COLOR = {
  finished: 'default', live: 'red', upcoming: 'blue',
};

function FixtureRow({ fx }) {
  const score = fx.hasScore ? `${fx.home.score} : ${fx.away.score}` : '—';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #f0f0f0',
    }}
    >
      <div style={{ minWidth: 96 }}>
        <div>{fx.dateLabel}</div>
        {fx.time ? <Typography.Text type="secondary">{fx.time}</Typography.Text> : null}
      </div>
      <Typography.Text type="secondary" style={{ minWidth: 90 }}>{fx.stageLabel}</Typography.Text>
      <div style={{ flex: 1, textAlign: 'center' }}>
        <Typography.Text strong={fx.home.winner}>{fx.home.label}</Typography.Text>
        <span style={{ margin: '0 10px', fontVariantNumeric: 'tabular-nums' }}>{score}</span>
        <Typography.Text strong={fx.away.winner}>{fx.away.label}</Typography.Text>
      </div>
      <Tag color={STATUS_COLOR[fx.statusKey] || 'default'}>{fx.statusLabel}</Tag>
    </div>
  );
}

function Preview({ data }) {
  if (!data) return <Empty description="Загрузка…" />;
  if (data.champion) {
    const c = data.champion;
    const hasScore = c.champScore !== null && c.runnerScore !== null;
    const final = hasScore
      ? `Финал: ${c.team} ${c.champScore} – ${c.runnerScore} ${c.runnerUp}`
      : `Финал: ${c.team} — ${c.runnerUp}`;
    return (
      <div style={{ textAlign: 'center', padding: 16 }}>
        <Typography.Text type="secondary">ЧЕМПИОН МИРА 2026</Typography.Text>
        <Typography.Title level={3} style={{ margin: '4px 0' }}>{c.team}</Typography.Title>
        <Typography.Text type="secondary">{final}</Typography.Text>
      </div>
    );
  }
  if (data.notStarted) {
    return (
      <div style={{ textAlign: 'center', padding: 16 }}>
        <Typography.Text type="secondary">СТАРТ ПЛЕЙ-ОФФ</Typography.Text>
        <Typography.Title level={3} style={{ margin: '4px 0' }}>{data.notStarted.startLabel}</Typography.Title>
        <Typography.Text type="secondary">Первые матчи — 1/16 финала</Typography.Text>
      </div>
    );
  }
  if (!data.fixtures?.length) return <Empty description="Матчей пока нет." />;
  return <div>{data.fixtures.map((fx) => <FixtureRow key={fx.id} fx={fx} />)}</div>;
}

export default function WorldCupCard({
  state, api, withRegen, reloadToken, message, onAuthError,
}) {
  const [data, setData] = useState(null);
  const [enabled, setEnabled] = useState(!!state?.worldcupSlide?.enabled);
  const [seconds, setSeconds] = useState(state?.worldcupSlide?.seconds ?? 14);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get('/admin/api/worldcup');
      setData(d);
      setEnabled(d.enabled);
      setSeconds(d.seconds);
      setError('');
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(e.message);
    }
  }, [api, onAuthError]);

  useEffect(() => { load(); }, [load, reloadToken]);

  const save = () => {
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 120) {
      message.error('Секунд на экране: целое число от 4 до 120');
      return;
    }
    withRegen(
      'Сохранение настроек чемпионата и пересборка потоков',
      () => api.patch('/admin/api/worldcup', { enabled, seconds }),
      { success: 'Настройки слайда сохранены — потоки пересобираются' },
    );
  };

  const refresh = () => withRegen(
    'Обновление результатов чемпионата',
    () => api.post('/admin/api/worldcup/refresh'),
    { success: 'Результаты обновлены' },
  );

  const tokenText = data?.tokenConfigured
    ? 'Live-результаты: токен задан ✓'
    : 'Live-результаты: токен не задан — показывается сетка-заглушка';

  return (
    <Card
      title="Чемпионат мира 2026 · World Cup"
      extra={(
        <Space>
          <span>
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 8,
              background: data?.enabled ? '#16a34a' : '#8c8c8c',
            }}
            />
            {data ? `${data.enabled ? 'Включён' : 'Выключен'}${data.headline ? ` · ${data.headline}` : ''}` : '…'}
          </span>
          <Button onClick={refresh}>Обновить результаты</Button>
        </Space>
      )}
    >
      <Space size="large" align="center" wrap style={{ marginBottom: 16 }}>
        <Space>
          <Switch checked={enabled} onChange={setEnabled} />
          <span>Показывать слайд в канале</span>
        </Space>
        <Space>
          <span>Секунд на экране</span>
          <InputNumber min={4} max={120} step={1} value={seconds} onChange={(v) => setSeconds(v)} />
        </Space>
        <Button type="primary" onClick={save}>Сохранить</Button>
        <Typography.Text type="secondary">
          {tokenText}
          {data?.updated ? ` · обновлено ${data.updated}` : ''}
        </Typography.Text>
      </Space>
      {error ? <Empty description={`Не удалось загрузить данные чемпионата: ${error}`} /> : <Preview data={data} />}
    </Card>
  );
}
