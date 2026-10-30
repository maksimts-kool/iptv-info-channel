import { useState } from 'react';
import {
  Badge, Modal, Space, Tag, Tooltip, Typography,
} from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { AuthError } from './api.js';

// The Диагностика vocabulary, shared by the page, its channel drawer and the
// menu badge: what each state the server reports is called, its colour, and
// the sentences built from the numbers. One place, so a state reads the same
// everywhere it shows.

const GREEN = '#16a34a';
const AMBER = '#d97706';
const RED = '#dc2626';
const GREY = '#94a3b8';

// A channel's live state (server: playlist::diagnostics::ChannelState).
export const CHANNEL_STATES = {
  ok: { label: 'Работает', color: GREEN, tag: 'success', group: 'ok' },
  slow: { label: 'Медленно', color: AMBER, tag: 'warning', group: 'warn' },
  flaky: { label: 'С перебоями', color: AMBER, tag: 'warning', group: 'warn' },
  errors: { label: 'Ошибки', color: RED, tag: 'error', group: 'bad' },
  frozen: { label: 'Завис', color: RED, tag: 'error', group: 'bad' },
};

// A viewer's state (ViewerState).
export const VIEWER_STATES = {
  ok: { label: 'Смотрит', color: GREEN },
  buffer: { label: 'Буферизация', color: AMBER },
  retune: { label: 'Переподключается', color: AMBER },
  noconn: { label: 'Не подключается', color: RED },
  error: { label: 'Видит ошибку', color: RED },
  frozen: { label: 'Картинка стоит', color: RED },
};

// What an incident in the register was (Kind). `provider`: the cause is at
// the provider, not with the customers' players.
export const KINDS = {
  errors: { label: 'Ошибки провайдера', tag: 'error', provider: true },
  no_open: { label: 'Не открывался', tag: 'error', provider: true },
  frozen: { label: 'Зависал', tag: 'error', provider: true },
  slow: { label: 'Медленно', tag: 'warning', provider: true },
  buffering: { label: 'Буферизация', tag: 'warning', provider: false },
  retunes: { label: 'Переподключения', tag: 'warning', provider: false },
  player: { label: 'Не открывался в плеере', tag: 'default', provider: false },
};

// One minute of the live strip (MinuteState).
export const MINUTE_COLORS = {
  none: '#f1f5f9',
  ok: '#cbd5e1',
  warn: '#f59e0b',
  bad: RED,
};

export const MINUTE_LEGEND = [
  ['ok', 'работал'],
  ['warn', 'с перебоями'],
  ['bad', 'не работал'],
  ['none', 'никто не смотрел'],
];

// A failure code from the server ("502", "timeout", …) in words.
export function failureText(code) {
  if (!code) return 'ошибка';
  if (/^\d+$/.test(code)) return `ошибка ${code}`;
  return {
    timeout: 'не ответил вовремя',
    connect: 'нет связи',
    too_large: 'слишком большой ответ',
    empty: 'пустой плейлист',
  }[code] || code;
}

// "2,8 с" / "640 мс".
export function ms(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return `${Math.round(value)} мс`;
  return `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
}

// "45 с" / "3 мин" / "1 ч 10 мин" for a span in ms.
export function span(value) {
  const s = Math.max(0, Math.round((value || 0) / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  return m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${Math.floor(m / 60)} ч`;
}

// "сегодня 21:38" / "вчера 23:05" / "29 окт 20:10".
export function when(iso, { time = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today - day) / 86_400_000);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  let date;
  if (days === 0) date = 'сегодня';
  else if (days === 1) date = 'вчера';
  else date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  return time ? `${date} ${hm}` : date;
}

// "1 клиент" / "3 клиента" / "7 клиентов".
export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const clients = (n) => plural(n, 'клиент', 'клиента', 'клиентов');
export const viewersText = (n) => plural(n, 'зритель', 'зрителя', 'зрителей');
export const cases = (n) => plural(n, 'случай', 'случая', 'случаев');

export function ChannelStateTag({ state }) {
  const s = CHANNEL_STATES[state] || CHANNEL_STATES.ok;
  return <Tag color={s.tag} style={{ marginInlineEnd: 0 }}>{s.label}</Tag>;
}

export function ViewerStateBadge({ state }) {
  const s = VIEWER_STATES[state] || VIEWER_STATES.ok;
  return <Badge color={s.color} text={s.label} style={{ whiteSpace: 'nowrap' }} />;
}

export function KindTag({ kind }) {
  const k = KINDS[kind];
  if (!k) return null;
  return <Tag color={k.tag} style={{ marginInlineEnd: 0 }}>{k.label}</Tag>;
}

// The last 30 minutes, a square per minute.
export function MinuteStrip({ minutes, height = 18 }) {
  return (
    <div style={{ display: 'flex', gap: 2, minWidth: 150 }} role="img" aria-label="Последние 30 минут">
      {(minutes || []).map((m) => (
        <Tooltip
          key={m.at}
          title={`${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${m.viewers ? viewersText(m.viewers) : 'никто не смотрел'}`}
        >
          <span
            style={{
              flex: '1 1 0',
              height,
              borderRadius: 2,
              background: MINUTE_COLORS[m.state] || MINUTE_COLORS.none,
            }}
          />
        </Tooltip>
      ))}
    </div>
  );
}

export function MinuteLegend() {
  return (
    <Space size={12} wrap>
      {MINUTE_LEGEND.map(([state, label]) => (
        <Space key={state} size={4}>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 2,
              background: MINUTE_COLORS[state],
              border: state === 'none' ? '1px solid #e2e8f0' : 'none',
            }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
        </Space>
      ))}
    </Space>
  );
}

const TROUBLE_WORDS = {
  buffer: 'буферизация',
  retune: 'переподключения',
  noconn: 'не подключается',
  error: 'видит ошибки',
  frozen: 'картинка стоит',
};

// Viewers with a problem, in a few words: "2 — буферизация".
export function troubleSummary(viewers) {
  const bad = (viewers || []).filter((v) => v.state !== 'ok');
  if (!bad.length) return null;
  const states = new Set(bad.map((v) => v.state));
  const word = states.size === 1 ? TROUBLE_WORDS[bad[0].state] : 'перебои';
  return `${bad.length} — ${word}`;
}

// What is wrong with a watched channel, in one sentence ('' when nothing).
export function channelDiagnosis(ch) {
  const viewers = ch.viewers || [];
  const bad = viewers.filter((v) => v.state !== 'ok');
  const all = bad.length > 0 && bad.length === viewers.length;
  switch (ch.state) {
    case 'frozen':
      return `Провайдер отвечает, но видео не меняется уже ${span(ch.frozen_ms)}`;
    case 'errors':
      return `Провайдер отвечает с ошибкой (${failureText(ch.error)}): ${ch.failures} из ${ch.requests} запросов за 15 мин`;
    case 'slow':
      return all
        ? 'Провайдер отвечает медленно — тормозит у всех зрителей'
        : 'Провайдер отвечает медленно — зрители пока смотрят без перебоев';
    case 'flaky':
      if (bad.every((v) => v.state === 'noconn') && bad.some((v) => v.error)) {
        return `Канал не открывается: провайдер — ${failureText(bad.find((v) => v.error).error)}`;
      }
      if (bad.every((v) => v.state === 'noconn')) {
        return 'Провайдер в порядке, но плеер не открывает ни одно качество — проблема на стороне плеера';
      }
      if (all && viewers.length > 1) return 'Перебои у всех зрителей, хотя провайдер отвечает нормально';
      return bad.length < viewers.length
        ? 'У части зрителей перебои, у остальных порядок — скорее, сеть или плеер клиента'
        : 'Перебои у зрителя, провайдер отвечает нормально — скорее, сеть или плеер клиента';
    default:
      return '';
  }
}

// A viewer's problem in a few words ('' when fine).
export function viewerNote(v) {
  switch (v.state) {
    case 'buffer': return `обновления опаздывают до ${span(v.late_ms)}`;
    case 'retune': return `${v.retunes} переподключений за 5 мин`;
    case 'noconn': return v.error ? `не открылся: ${failureText(v.error)}` : 'получил список качеств, но не открыл ни одно';
    case 'error': return `провайдер: ${failureText(v.error)}`;
    default: return '';
  }
}

// Who is watching a channel: state, customer (opens their card), player, for
// how long, and what is wrong.
export function ViewerList({ viewers, go }) {
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {(viewers || []).map((v) => (
        <Space key={`${v.user_id}|${v.ip}|${v.since}`} size={16} wrap>
          <span style={{ display: 'inline-block', width: 150 }}><ViewerStateBadge state={v.state} /></span>
          <Typography.Link style={{ display: 'inline-block', width: 120 }} onClick={() => go(`clients/${v.user_id}`)}>
            {v.username || `#${v.user_id}`}
          </Typography.Link>
          <span style={{ display: 'inline-block', width: 120 }}>{v.player || '—'}</span>
          <Typography.Text type="secondary" style={{ display: 'inline-block', width: 80 }}>
            {span(Date.now() - Date.parse(v.since))}
          </Typography.Text>
          {viewerNote(v) ? <Typography.Text type="secondary">{viewerNote(v)}</Typography.Text> : null}
        </Space>
      ))}
    </Space>
  );
}

// One incident of the register in a sentence.
export function incidentText(inc) {
  switch (inc.kind) {
    case 'errors': return `Провайдер отвечал с ошибкой (${failureText(inc.detail)})`;
    case 'no_open': return `Канал не открылся: ${failureText(inc.detail)}`;
    case 'frozen': return `Видео не менялось ${span(inc.peak)}`;
    case 'slow': return `Ответ провайдера до ${ms(inc.peak)}`;
    case 'buffering': return `Обновления у зрителей опаздывали до ${span(inc.peak)}`;
    case 'retunes': return `Плеер переподключался ${inc.peak} раз за 5 мин`;
    case 'player': return 'Плеер получил канал, но не открыл ни одно качество';
    default: return '';
  }
}

// Where the problems of a register line come from.
export function causeOf(kinds) {
  const provider = (kinds || []).some((k) => KINDS[k]?.provider);
  return provider ? 'провайдер' : 'плеер или сеть клиента';
}

const CHECK_VERDICTS = {
  ok: { title: 'Канал работает', type: 'success' },
  slow: { title: 'Канал работает, но провайдер отвечает медленно', type: 'warning' },
  frozen: { title: 'Канал завис: видео у провайдера не меняется', type: 'error' },
  error: { title: 'Канал не работает', type: 'error' },
  empty: { title: 'Провайдер отдал пустой плейлист', type: 'error' },
};

const CHECK_STEPS = {
  playlist: 'Плейлист канала',
  variant: 'Плейлист качества',
  segment: 'Кусок видео',
  advance: 'Видео обновляется',
};

function CheckSteps({ result }) {
  return (
    <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
      {result.steps.map((s) => (
        <Space key={s.step} size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size={8}>
            {s.ok
              ? <CheckCircleFilled style={{ color: GREEN }} />
              : <CloseCircleFilled style={{ color: RED }} />}
            <Typography.Text>{CHECK_STEPS[s.step] || s.step}</Typography.Text>
          </Space>
          <Typography.Text type={s.ok ? 'secondary' : 'danger'} style={{ fontSize: 13 }}>
            {s.ok ? (s.step === 'advance' ? 'да' : ms(s.ms)) : (s.error ? failureText(s.error) : 'нет')}
          </Typography.Text>
        </Space>
      ))}
      {result.segments ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`В плейлисте ${plural(result.segments, 'кусок', 'куска', 'кусков')} по ${Math.round(result.target_ms / 1000)} с`}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

// "Проверить канал сейчас": runs the check (a few seconds: it waits to see
// the playlist move) and shows the result. Returns the button's props and the
// modal to render.
export function useChannelCheck({ api, message, onAuthError }) {
  const [running, setRunning] = useState(null);
  const [modal, contextHolder] = Modal.useModal();

  const run = async (channelId, name) => {
    setRunning(channelId);
    try {
      const result = await api.post(`/admin/api/diagnostics/channels/${encodeURIComponent(channelId)}/check`, {});
      const v = CHECK_VERDICTS[result.verdict] || CHECK_VERDICTS.error;
      modal[v.type === 'success' ? 'success' : v.type]({
        title: `${name}: ${v.title.charAt(0).toLowerCase()}${v.title.slice(1)}`,
        content: <CheckSteps result={result} />,
        okText: 'Закрыть',
      });
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else message.error(e.message);
    } finally {
      setRunning(null);
    }
  };

  return { run, running, contextHolder };
}
