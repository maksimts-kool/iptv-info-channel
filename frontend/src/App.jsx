import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App as AntApp, Button, Layout, Space, Spin, Typography,
} from 'antd';
import {
  api, AuthError, login, logout, setCsrfToken,
} from './api.js';
import Login from './components/Login.jsx';
import RegenBanner from './components/RegenBanner.jsx';
import PlansCard from './components/PlansCard.jsx';
import BrandingCard from './components/BrandingCard.jsx';
import IncidentsCard from './components/IncidentsCard.jsx';
import WorldCupCard from './components/WorldCupCard.jsx';
import NotifyCard from './components/NotifyCard.jsx';
import UsersCard from './components/UsersCard.jsx';

const { Header, Content } = Layout;

const HIDDEN = {
  visible: false, complete: false, title: '', detail: '', showProgress: false, percent: 0, count: '',
};

export default function App() {
  const { message } = AntApp.useApp();
  const [authed, setAuthed] = useState(null); // null = probing
  const [state, setState] = useState(null);
  const [reloadToken, setReloadToken] = useState(0); // bumped so WC/notify cards refetch
  const [gen, setGen] = useState(HIDDEN);

  // Generation-status banner state machine (ported from the vanilla admin).
  const inProgress = useRef(false);
  const complete = useRef(false);
  const completeTimer = useRef(null);

  const showPending = useCallback((title = 'Updating channel streams') => {
    clearTimeout(completeTimer.current);
    inProgress.current = true;
    complete.current = false;
    setGen({
      visible: true,
      complete: false,
      title,
      detail: 'Your changes are saved. FFmpeg is rendering new video segments in the background, so IPTV playback updates only after encoding finishes.',
      showProgress: false,
      percent: 0,
      count: 'Waiting for the encoder…',
    });
  }, []);

  const clearPending = useCallback(() => {
    clearTimeout(completeTimer.current);
    inProgress.current = false;
    complete.current = false;
    setGen(HIDDEN);
  }, []);

  const showComplete = useCallback(() => {
    inProgress.current = false;
    complete.current = true;
    setGen({
      visible: true,
      complete: true,
      title: 'Stream update complete',
      detail: 'Encoding finished. The updated channel stream is ready for IPTV playback.',
      showProgress: true,
      percent: 100,
      count: 'Completed',
    });
    clearTimeout(completeTimer.current);
    completeTimer.current = setTimeout(() => {
      complete.current = false;
      setGen(HIDDEN);
    }, 5000);
  }, []);

  const renderGen = useCallback((status) => {
    if (!status.active) {
      if (inProgress.current) showComplete();
      else if (!complete.current) clearPending();
      return;
    }
    clearTimeout(completeTimer.current);
    inProgress.current = true;
    complete.current = false;
    const names = (status.active_users || []).map((u) => u.username).filter(Boolean);
    const next = {
      visible: true,
      complete: false,
      title: status.bulk ? 'Rebuilding all channel streams' : `Updating ${names[0] || 'channel'} stream`,
      detail: 'FFmpeg is encoding video in the background. Existing streams stay online, but saved changes appear in IPTV playback only when the new stream is ready.',
      showProgress: false,
      percent: 0,
      count: '',
    };
    if (status.bulk?.total) {
      const completed = Math.min(status.bulk.completed, status.bulk.total);
      next.showProgress = true;
      next.percent = Math.round((completed / status.bulk.total) * 100);
      next.count = `${completed} of ${status.bulk.total} streams encoded${names.length ? ` · Now: ${names.join(', ')}` : ''}`;
    } else {
      next.count = names.length ? `Encoding: ${names.join(', ')}` : 'Preparing stream encoding…';
    }
    setGen(next);
  }, [showComplete, clearPending]);

  const refreshGen = useCallback(async () => {
    try {
      renderGen(await api.get('/admin/api/generation-status'));
    } catch (e) {
      if (e instanceof AuthError) setAuthed(false);
      // else keep the current indicator through brief network failures
    }
  }, [renderGen]);

  const reloadAll = useCallback(async () => {
    const next = await api.get('/admin/api/state');
    setCsrfToken(next.csrfToken);
    setState(next);
    setReloadToken((t) => t + 1);
  }, []);

  // Shared mutate lifecycle: pending banner -> action -> toast + reload -> refresh.
  const withRegen = useCallback(async (pendingTitle, action, { success = null, reload = true } = {}) => {
    showPending(pendingTitle);
    try {
      await action();
      if (success) message.success(success);
      if (reload) await reloadAll();
      await refreshGen();
    } catch (e) {
      if (e instanceof AuthError) { setAuthed(false); return; }
      message.error(e.message);
      clearPending();
    }
  }, [showPending, clearPending, reloadAll, refreshGen, message]);

  // Initial auth probe.
  useEffect(() => {
    (async () => {
      try {
        await reloadAll();
        setAuthed(true);
      } catch (e) {
        if (e instanceof AuthError) setAuthed(false);
        else { setAuthed(true); message.error(`Load failed: ${e.message}`); }
      }
    })();
  }, [reloadAll, message]);

  // Poll the generation status while signed in.
  useEffect(() => {
    if (!authed) return undefined;
    refreshGen();
    const id = setInterval(refreshGen, 1500);
    return () => clearInterval(id);
  }, [authed, refreshGen]);

  const handleLogin = useCallback(async (password) => {
    await login(password);
    await reloadAll();
    setAuthed(true);
    refreshGen();
  }, [reloadAll, refreshGen]);

  const handleLogout = useCallback(async () => {
    await logout();
    setState(null);
    setAuthed(false);
  }, []);

  const rebuildAll = useCallback(async () => {
    showPending('Rebuilding all channel streams');
    message.info('Rebuilding all streams…');
    try {
      await api.post('/admin/api/regenerate-all');
      message.success('All streams rebuilt');
      await refreshGen();
    } catch (e) {
      if (e instanceof AuthError) { setAuthed(false); return; }
      message.error(e.message);
      clearPending();
    }
  }, [showPending, refreshGen, clearPending, message]);

  if (authed === null) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!authed) return <Login onLogin={handleLogin} />;

  const busy = gen.visible && !gen.complete;
  const shared = {
    state, api, withRegen, reload: reloadAll, reloadToken, message,
    onAuthError: () => setAuthed(false),
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ position: 'sticky', top: 0, zIndex: 10, paddingInline: 20 }}>
        <div style={{
          maxWidth: 1100, height: '100%', margin: '0 auto', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}
        >
          <Typography.Text strong style={{ color: '#fff', fontSize: 16 }}>
            📺 IPTV Info Channel <span style={{ opacity: 0.6, fontWeight: 400 }}>· admin</span>
          </Typography.Text>
          <Space size="middle">
            {state?.publicBaseUrl ? (
              <Typography.Text style={{ color: 'rgba(255,255,255,0.65)' }}>
                {state.publicBaseUrl}
              </Typography.Text>
            ) : null}
            <Button onClick={rebuildAll} disabled={busy} loading={busy}>Rebuild all streams</Button>
            <Button onClick={handleLogout}>Log out</Button>
          </Space>
        </div>
      </Header>
      <Content style={{ padding: 24 }}>
        <div style={{
          maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24,
        }}
        >
          <RegenBanner gen={gen} />
          <PlansCard {...shared} />
          <BrandingCard {...shared} />
          <IncidentsCard {...shared} />
          <WorldCupCard {...shared} />
          <NotifyCard {...shared} />
          <UsersCard {...shared} />
        </div>
      </Content>
    </Layout>
  );
}
