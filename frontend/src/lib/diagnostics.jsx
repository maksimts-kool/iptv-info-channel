import { useState } from 'react';
import {
  Badge, Modal, Progress, Space, Tag, Tooltip, Typography,
} from 'antd';
import {
  CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, MinusCircleOutlined,
} from '@ant-design/icons';
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
  noconn: { label: 'Не подключается', color: RED },
  error: { label: 'Видит ошибку', color: RED },
  frozen: { label: 'Картинка стоит', color: RED },
};

// What an incident in the register was (Kind). `provider`: the cause is at
// the provider, not with the customers' players. Buffering and players that
// do not open the channel only get here once several customers have them.
export const KINDS = {
  errors: { label: 'Ошибки провайдера', tag: 'error', provider: true },
  no_open: { label: 'Не открывался', tag: 'error', provider: true },
  frozen: { label: 'Зависал', tag: 'error', provider: true },
  slow: { label: 'Медленно', tag: 'warning', provider: true },
  buffering: { label: 'Буферизация', tag: 'warning', provider: false },
  player: { label: 'Не открывался в плеерах', tag: 'default', provider: false },
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
const times = (n) => plural(n, 'раз', 'раза', 'раз');

// How far back tune-ins of a channel count as restarts (server:
// playlist::diagnostics::RETUNE_WINDOW_MS).
const RETUNE_WINDOW = '10 мин';

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
    case 'noconn': return v.error ? `не открылся: ${failureText(v.error)}` : 'получил список качеств, но не открыл ни одно';
    case 'error': return `провайдер: ${failureText(v.error)}`;
    // Restarting a channel is the viewer's business, not a problem: shown
    // only as a note.
    default: return v.retunes >= 3 ? `переключал канал ${times(v.retunes)} за ${RETUNE_WINDOW}` : '';
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
    case 'buffering': return `Обновления у нескольких клиентов опаздывали до ${span(inc.peak)}`;
    case 'player': return 'Плееры нескольких клиентов получили канал, но не открыли ни одно качество';
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
export function useChannelCheck({
  api, message, onAuthError, onDone,
}) {
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
      onDone?.();
    }
  };

  return { run, running, contextHolder };
}

// How a channel left the register (server: playlist::diagnostics::Resolved).
export function resolvedText(r) {
  switch (r.how) {
    case 'verified':
      return `${plural(r.probes, 'проверка', 'проверки', 'проверок')} сервером, ${span(r.viewing_ms)} просмотра без перебоев у ${clients(r.viewers)}`;
    case 'server_only':
      return `${plural(r.probes, 'проверка', 'проверки', 'проверок')} сервером; зрителей почти не было`;
    case 'removed':
      return 'канал удалён из каталога';
    default:
      return '';
  }
}

const VERDICT_WORDS = {
  ok: 'прошла',
  slow: 'прошла, но ответ медленный',
  frozen: 'не прошла: видео не обновляется',
  error: 'не прошла',
  empty: 'не прошла: пустой плейлист',
};

function probeText(p) {
  const time = new Date(p.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const words = VERDICT_WORDS[p.verdict] || (p.passed ? 'прошла' : 'не прошла');
  const why = !p.passed && p.error ? `: ${failureText(p.error)}` : '';
  return `последняя в ${time} ${words}${p.verdict === 'error' ? why : ''}`;
}

const clamp = (x) => Math.max(0, Math.min(1, x));

// A register channel's way out: what it still needs (`req`: the server's
// requirements, the same for every channel), as a checklist and a share
// done. While the problem is going on there is nothing to check yet.
export function verificationSteps(v, req, ongoing) {
  if (!v || !req) return { steps: [], percent: 0 };
  const quiet = Date.now() - Date.parse(v.since);
  const quietFrac = clamp(quiet / req.quiet_ms);
  const serverFrac = v.checkable ? clamp(v.probes_ok / req.probes) : 1;
  const viewFrac = clamp(v.viewing_ms / req.viewing_ms);
  const unwatchedFrac = clamp(quiet / req.unwatched_ms);
  const steps = [
    {
      key: 'quiet',
      done: !ongoing && quietFrac >= 1,
      label: ongoing
        ? 'Проблема идёт сейчас — проверка начнётся, когда она закончится'
        : `Без проблем ${span(Math.min(quiet, req.quiet_ms))} из ${span(req.quiet_ms)}`,
    },
    v.checkable
      ? {
        key: 'server',
        done: serverFrac >= 1,
        failed: v.last_probe && !v.last_probe.passed,
        label: `Проверки сервером у провайдера: ${v.probes_ok} из ${req.probes}`,
        note: v.last_probe ? probeText(v.last_probe) : `первая через ${span(Math.max(0, req.probe_every_ms - quiet))} без проблем`,
      }
      : {
        key: 'server', done: true, skipped: true, label: 'Сервер не может проверить этот канал — решают зрители',
      },
    {
      key: 'viewers',
      done: viewFrac >= 1 || unwatchedFrac >= 1,
      label: v.viewing_ms
        ? `Просмотр без перебоев: ${span(v.viewing_ms)} из ${span(req.viewing_ms)} (${clients(v.viewers)})`
        : `Просмотр без перебоев: никто пока не смотрел (нужно ${span(req.viewing_ms)})`,
      note: viewFrac < 1 && !ongoing
        ? `без зрителей хватит проверок сервера через ${span(Math.max(0, req.unwatched_ms - quiet))}`
        : null,
    },
  ];
  const percent = ongoing ? 0 : Math.round(100 * Math.min(quietFrac, serverFrac, Math.max(viewFrac, unwatchedFrac)));
  return { steps, percent };
}

function StepIcon({ step }) {
  if (step.skipped) return <MinusCircleOutlined style={{ color: GREY }} />;
  if (step.done) return <CheckCircleFilled style={{ color: GREEN }} />;
  if (step.failed) return <CloseCircleFilled style={{ color: RED }} />;
  return <ClockCircleOutlined style={{ color: GREY }} />;
}

export function VerificationChecklist({ verification, req, ongoing }) {
  const { steps } = verificationSteps(verification, req, ongoing);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {steps.map((s) => (
        <Space key={s.key} size={8} align="start">
          <span style={{ display: 'inline-block', paddingTop: 2 }}><StepIcon step={s} /></span>
          <Space direction="vertical" size={0}>
            <Typography.Text>{s.label}</Typography.Text>
            {s.note ? <Typography.Text type={s.failed ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{s.note}</Typography.Text> : null}
          </Space>
        </Space>
      ))}
    </Space>
  );
}

// The register table's cell: how far along the way out is, the checklist on hover.
export function VerificationProgress({ verification, req, ongoing }) {
  if (ongoing) {
    return <Typography.Text strong style={{ color: '#b91c1c', whiteSpace: 'nowrap' }}>идёт сейчас</Typography.Text>;
  }
  const { percent } = verificationSteps(verification, req, ongoing);
  const failed = verification?.last_probe && !verification.last_probe.passed;
  return (
    <Tooltip
      title={<VerificationChecklist verification={verification} req={req} ongoing={ongoing} />}
      color="#fff"
      styles={{ body: { color: 'inherit', minWidth: 300 } }}
    >
      <Space direction="vertical" size={0} style={{ minWidth: 140, cursor: 'help' }}>
        <Typography.Text style={{ fontSize: 12, color: failed ? '#b91c1c' : undefined }}>
          {failed ? 'проверка не прошла' : 'проверяем'}
        </Typography.Text>
        <Progress percent={percent} size="small" status={failed ? 'exception' : 'active'} showInfo={false} />
      </Space>
    </Tooltip>
  );
}
