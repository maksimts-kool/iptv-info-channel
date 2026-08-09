import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp, Button, Drawer, Grid, Layout, Menu, Space, Spin, Typography,
} from 'antd';
import {
  DashboardOutlined, DesktopOutlined, EuroCircleOutlined, LogoutOutlined, MailOutlined,
  MenuOutlined, PlaySquareOutlined, TeamOutlined, WifiOutlined,
} from '@ant-design/icons';
import {
  api, AuthError, login, logout, setCsrfToken,
} from './lib/api.js';
import Login from './components/Login.jsx';
import RegenBanner from './components/RegenBanner.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import PlaylistPage from './pages/PlaylistPage.jsx';
import ClientsPage from './pages/ClientsPage.jsx';
import PlansPage from './pages/PlansPage.jsx';
import InfoChannelPage from './pages/InfoChannelPage.jsx';
import NotifyPage from './pages/NotifyPage.jsx';

const { Header, Content, Sider } = Layout;

// Playlist + client management is the product now; the info channel is one
// feature inside it, so it sits below them in the navigation.
//
// Icons are Ant Design's icon set (vector, themed with the rest of the UI and
// identical on every platform) rather than emoji, which render as a different
// picture on every OS and sit off the text baseline.
const SECTIONS = [
  { key: 'overview', label: 'Обзор', Icon: DashboardOutlined, title: 'Обзор', Page: OverviewPage },
  { key: 'playlist', label: 'Плейлист', Icon: PlaySquareOutlined, title: 'Плейлист', Page: PlaylistPage },
  { key: 'clients', label: 'Клиенты', Icon: TeamOutlined, title: 'Клиенты', Page: ClientsPage },
  { key: 'plans', label: 'Тарифы', Icon: EuroCircleOutlined, title: 'Тарифы и цены', Page: PlansPage },
  { key: 'info', label: 'Инфоканал', Icon: DesktopOutlined, title: 'Информационный канал', Page: InfoChannelPage },
  { key: 'notify', label: 'Уведомления', Icon: MailOutlined, title: 'Уведомления по почте', Page: NotifyPage },
];

const DEFAULT_SECTION = 'overview';

const HIDDEN = {
  visible: false, complete: false, title: '', percent: 0, count: '', indeterminate: false,
};

// Section routing lives in the URL hash (#/clients) so a screen can be
// bookmarked and the browser's back button works — without pulling in a router.
function sectionFromHash() {
  const key = window.location.hash.replace(/^#\/?/, '');
  return SECTIONS.some((s) => s.key === key) ? key : DEFAULT_SECTION;
}

export default function App() {
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const [authed, setAuthed] = useState(null); // null = probing
  const [state, setState] = useState(null);
  const [reloadToken, setReloadToken] = useState(0); // bumped so pages refetch
  const [gen, setGen] = useState(HIDDEN);
  const [section, setSection] = useState(sectionFromHash);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((key) => {
    window.location.hash = `#/${key}`;
    setSection(key);
    setNavOpen(false);
  }, []);

  // Generation-status banner state machine (only the info-channel encode uses
  // it; catalog edits are served live and never trigger a rebuild).
  const inProgress = useRef(false);
  const complete = useRef(false);
  const completeTimer = useRef(null);

  // Concise, generic label the instant a change is saved; the poll below refines
  // it (bulk vs single) within a beat. Any title callers pass is ignored on
  // purpose — the banner stays short ("just updating") by design.
  const showPending = useCallback(() => {
    clearTimeout(completeTimer.current);
    inProgress.current = true;
    complete.current = false;
    setGen({
      visible: true, complete: false, title: 'Обновление потоков',
      percent: 0, count: '', indeterminate: true,
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
      visible: true, complete: true, title: 'Готово',
      percent: 100, count: '', indeterminate: false,
    });
    clearTimeout(completeTimer.current);
    completeTimer.current = setTimeout(() => {
      complete.current = false;
      setGen(HIDDEN);
    }, 2500);
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
    const bulk = status.bulk;
    if (bulk?.total) {
      // Real progress: the encoder finishes users one by one (channel.js).
      const completed = Math.min(bulk.completed, bulk.total);
      setGen({
        visible: true, complete: false, title: 'Пересборка потоков',
        percent: Math.round((completed / bulk.total) * 100),
        count: `${completed} / ${bulk.total}`, indeterminate: false,
      });
    } else {
      // A single encode reports no sub-progress — show an honest indeterminate bar.
      setGen({
        visible: true, complete: false, title: 'Обновление потока',
        percent: 0, count: names.join(', '), indeterminate: true,
      });
    }
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
        else { setAuthed(true); message.error(`Ошибка загрузки: ${e.message}`); }
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

  // Note: catalog edits are served live from the .m3u and never re-encode, so
  // those screens save directly instead of going through `withRegen`.
  const shared = useMemo(() => ({
    state, api, withRegen, reload: reloadAll, reloadToken, message, go,
    onAuthError: () => setAuthed(false),
  }), [state, withRegen, reloadAll, reloadToken, message, go]);

  if (authed === null) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!authed) return <Login onLogin={handleLogin} />;

  const active = SECTIONS.find((s) => s.key === section) || SECTIONS[0];
  const { Page } = active;
  const compact = !screens.lg;

  const menu = (
    <Menu
      mode="inline"
      theme="dark"
      selectedKeys={[section]}
      onClick={({ key }) => go(key)}
      style={{ borderInlineEnd: 'none' }}
      items={SECTIONS.map((s) => ({
        key: s.key,
        icon: <s.Icon />,
        label: s.label,
      }))}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {compact ? null : (
        <Sider width={216} breakpoint="lg" style={{ position: 'sticky', top: 0, height: '100vh' }}>
          <div className="brand-mark">
            <WifiOutlined />
            <span>IPTV Panel</span>
          </div>
          {menu}
        </Sider>
      )}
      <Layout>
        <Header className="app-header">
          <Space size="middle" align="center">
            {compact ? (
              <Button icon={<MenuOutlined />} aria-label="Меню" onClick={() => setNavOpen(true)} />
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Typography.Text strong style={{ color: '#fff', fontSize: 16 }}>
                {active.title}
              </Typography.Text>
              {state?.publicBaseUrl ? (
                <Typography.Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }} ellipsis>
                  {state.publicBaseUrl}
                </Typography.Text>
              ) : null}
            </div>
          </Space>
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>Выйти</Button>
        </Header>
        <Content style={{ padding: 24 }}>
          <div style={{ maxWidth: 1240, margin: '0 auto' }}>
            <RegenBanner gen={gen} />
            <Page {...shared} />
          </div>
        </Content>
      </Layout>

      <Drawer
        open={compact && navOpen}
        placement="left"
        width={240}
        onClose={() => setNavOpen(false)}
        styles={{ body: { padding: 0, background: '#001529' }, header: { display: 'none' } }}
      >
        <div className="brand-mark">
          <WifiOutlined />
          <span>IPTV Panel</span>
        </div>
        {menu}
      </Drawer>
    </Layout>
  );
}
