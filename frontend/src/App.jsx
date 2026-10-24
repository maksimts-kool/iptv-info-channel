import {
  Suspense, lazy, useCallback, useEffect, useMemo, useState,
} from 'react';
import {
  App as AntApp, Badge, Button, Drawer, Grid, Layout, Menu, Spin, Tooltip, Typography,
} from 'antd';
import {
  BarChartOutlined, DashboardOutlined, DesktopOutlined, EuroCircleOutlined, LaptopOutlined, LogoutOutlined, MailOutlined,
  MenuOutlined, PictureOutlined, PlaySquareOutlined, SyncOutlined, TeamOutlined, UnorderedListOutlined, WalletOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import ClientJump from './components/ClientJump.jsx';
import {
  api, AuthError, login, logout, setCsrfToken,
} from './lib/api.js';
import Login from './components/Login.jsx';
import JobsDock from './components/JobsDock.jsx';
import { JobsProvider, useJobsFeed } from './lib/jobs.jsx';
import { WatchingProvider, useWatching } from './lib/watching.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import ClientsPage from './pages/ClientsPage.jsx';

// The landing screen and the customer list ship in the main bundle; the other
// sections (the media editor above all) load on first visit, so signing in is
// not held up by code for screens that may not be opened.
const PlaylistPage = lazy(() => import('./pages/PlaylistPage.jsx'));
const DevicesPage = lazy(() => import('./pages/DevicesPage.jsx'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage.jsx'));
const PlansPage = lazy(() => import('./pages/PlansPage.jsx'));
const InfoChannelPage = lazy(() => import('./pages/InfoChannelPage.jsx'));
const MediaPage = lazy(() => import('./pages/MediaPage.jsx'));
const NotifyPage = lazy(() => import('./pages/NotifyPage.jsx'));
const StatsPage = lazy(() => import('./pages/StatsPage.jsx'));

const { Header, Content, Sider } = Layout;

// "Watching now" on the Устройства entry, from the shared device poll.
function WatchingBadge() {
  const { watching } = useWatching();
  return watching
    ? <Badge count={watching} color="#16a34a" size="small" title={`Смотрят сейчас: ${watching}`} />
    : null;
}

// Playlist + client management is the product now; the info channel is one
// feature inside it, so it sits below them in the navigation.
//
// Ten flat entries are more than anyone scans at a glance, so the menu is
// chunked into a few labelled groups by what the admin is doing (customers and
// money, what is on air, the built-in channels, mail). Обзор stays first and
// alone: it is the landing screen and the shortcut into everything else.
//
// Icons are Ant Design's icon set (vector, themed with the rest of the UI and
// identical on every platform) rather than emoji, which render as a different
// picture on every OS and sit off the text baseline.
// Header entry to the job dock: spins with a count while anything runs, and
// opens the dock (recent results included) when nothing does.
function JobsButton({
  summary, open, onClick, labelled,
}) {
  const busy = summary.active > 0;
  return (
    <Tooltip title={labelled ? null : 'Фоновые задачи'}>
      <Badge count={summary.active} size="small" color="#2563eb" offset={[-4, 4]}>
        <Button
          type={open ? 'primary' : 'default'}
          ghost={open}
          icon={busy ? <SyncOutlined spin /> : <UnorderedListOutlined />}
          onClick={onClick}
          aria-label="Фоновые задачи"
          aria-pressed={open}
        >
          {labelled ? 'Задачи' : null}
        </Button>
      </Badge>
    </Tooltip>
  );
}

const SECTIONS = [
  {
    key: 'overview', label: 'Обзор', Icon: DashboardOutlined, title: 'Обзор', Page: OverviewPage,
  },
  {
    key: 'clients', group: 'Клиенты и деньги', label: 'Клиенты', Icon: TeamOutlined, title: 'Клиенты', Page: ClientsPage,
  },
  {
    key: 'payments', group: 'Клиенты и деньги', label: 'Оплаты', Icon: WalletOutlined, title: 'Оплаты и продления', Page: PaymentsPage,
  },
  {
    key: 'plans', group: 'Клиенты и деньги', label: 'Тарифы', Icon: EuroCircleOutlined, title: 'Тарифы и цены', Page: PlansPage,
  },
  {
    key: 'playlist', group: 'Вещание', label: 'Плейлист', Icon: PlaySquareOutlined, title: 'Плейлист', Page: PlaylistPage,
  },
  {
    key: 'devices', group: 'Вещание', label: 'Устройства', Icon: LaptopOutlined, title: 'Устройства', Page: DevicesPage,
  },
  {
    key: 'stats', group: 'Вещание', label: 'Статистика', Icon: BarChartOutlined, title: 'Статистика просмотров', Page: StatsPage,
  },
  {
    key: 'info', group: 'Свои каналы', label: 'Инфоканал', Icon: DesktopOutlined, title: 'Информационный канал', Page: InfoChannelPage,
  },
  {
    key: 'media', group: 'Свои каналы', label: 'Медиаканал', Icon: PictureOutlined, title: 'Медиаканал', Page: MediaPage,
  },
  {
    key: 'notify', group: 'Связь', label: 'Уведомления', Icon: MailOutlined, title: 'Уведомления по почте', Page: NotifyPage,
  },
];

const BRAND = 'IPTV Panel';

const DEFAULT_SECTION = 'overview';

// Section routing lives in the URL hash (#/clients) so a screen can be
// bookmarked and the browser's back button works — without pulling in a router.
// Only the first segment picks the section; the rest (#/clients/12,
// #/clients?status=expiring) is for the page itself.
function sectionFromHash() {
  const key = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return SECTIONS.some((s) => s.key === key) ? key : DEFAULT_SECTION;
}

export default function App() {
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const [authed, setAuthed] = useState(null); // null = probing
  const [state, setState] = useState(null);
  const [reloadToken, setReloadToken] = useState(0); // bumped so pages refetch
  const [pending, setPending] = useState(false); // a save whose encode isn't queued yet
  const [dockOpen, setDockOpen] = useState(false);
  const [section, setSection] = useState(sectionFromHash);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The browser tab names the open screen, like every other web app does.
  useEffect(() => {
    const current = SECTIONS.find((x) => x.key === section);
    document.title = current ? `${current.title} · ${BRAND}` : BRAND;
  }, [section]);

  // `go('payments/12')` opens a section with something already picked; the
  // page reads the rest of the hash itself.
  const go = useCallback((target) => {
    window.location.hash = `#/${target}`;
    setSection(target.split(/[/?]/)[0]);
    setNavOpen(false);
  }, []);

  const onAuthError = useCallback(() => setAuthed(false), []);

  // The background job queue (info-channel encodes, media builds), live from
  // the server for every screen and the dock.
  const jobsFeed = useJobsFeed({ api, enabled: !!authed, onAuthError });
  const refreshJobs = jobsFeed.refresh;

  const reloadAll = useCallback(async () => {
    const next = await api.get('/admin/api/state');
    setCsrfToken(next.csrfToken);
    setState(next);
    setReloadToken((t) => t + 1);
  }, []);

  // Shared mutate lifecycle: the dock shows "updating" the instant a change is
  // saved -> action -> toast + reload -> a fresh queue snapshot, which carries
  // the encodes the save queued (the dock follows them from there). The
  // pending title callers pass is not shown: the dock names the real work.
  const withRegen = useCallback(async (_pendingTitle, action, { success = null, reload = true } = {}) => {
    setPending(true);
    try {
      await action();
      if (success) message.success(success);
      if (reload) await reloadAll();
      await refreshJobs();
    } catch (e) {
      if (e instanceof AuthError) { setAuthed(false); return; }
      message.error(e.message);
    } finally {
      setPending(false);
    }
  }, [reloadAll, refreshJobs, message]);

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

  const handleLogin = useCallback(async (password) => {
    await login(password);
    await reloadAll();
    setAuthed(true);
  }, [reloadAll]);

  const handleLogout = useCallback(async () => {
    await logout();
    setState(null);
    setAuthed(false);
  }, []);

  // Note: catalog edits are served live from the .m3u and never re-encode, so
  // those screens save directly instead of going through `withRegen`.
  const shared = useMemo(() => ({
    state, api, withRegen, reload: reloadAll, reloadToken, message, go, onAuthError,
  }), [state, withRegen, reloadAll, reloadToken, message, go, onAuthError]);

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
  const users = state?.users || [];
  // Customers waiting for a renewal, on the Оплаты entry: an open task the
  // admin should see from any screen, not only from Обзор.
  const due = users.filter((u) => u.status === 'expiring' || u.status === 'expired').length;
  const badges = {
    payments: due ? <Badge count={due} color="#d97706" size="small" title={`Ждут продления: ${due}`} /> : null,
    devices: <WatchingBadge />,
  };

  const item = (s) => ({
    key: s.key,
    icon: <s.Icon />,
    label: badges[s.key] ? (
      <span className="nav-label">
        <span>{s.label}</span>
        {badges[s.key]}
      </span>
    ) : s.label,
  });
  const items = [];
  for (const s of SECTIONS) {
    if (!s.group) { items.push(item(s)); continue; }
    let group = items.find((g) => g.type === 'group' && g.label === s.group);
    if (!group) {
      group = { type: 'group', label: s.group, children: [] };
      items.push(group);
    }
    group.children.push(item(s));
  }

  const menu = (
    <Menu
      mode="inline"
      theme="dark"
      selectedKeys={[section]}
      onClick={({ key }) => go(key)}
      className="app-nav"
      items={items}
    />
  );

  const brandMark = (
    <div className="brand-mark">
      <span className="brand-logo"><WifiOutlined /></span>
      <span>{BRAND}</span>
    </div>
  );

  return (
    <JobsProvider value={jobsFeed}>
      <WatchingProvider api={api} enabled={authed} onAuthError={onAuthError}>
        <Layout style={{ minHeight: '100vh' }}>
          {compact ? null : (
            <Sider width={232} className="app-sider">
              {brandMark}
              {menu}
            </Sider>
          )}
          <Layout>
            <Header className="app-header">
              <div className="app-header-title">
                {compact ? (
                  <Button type="text" icon={<MenuOutlined />} aria-label="Меню" onClick={() => setNavOpen(true)} />
                ) : null}
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <Typography.Text strong className="app-header-heading">{active.title}</Typography.Text>
                  {state?.publicBaseUrl ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                      {state.publicBaseUrl}
                    </Typography.Text>
                  ) : null}
                </div>
              </div>
              <div className="app-header-actions">
                <JobsButton
                  summary={jobsFeed.summary}
                  open={dockOpen}
                  onClick={() => setDockOpen((v) => !v)}
                  labelled={!!screens.sm}
                />
                {screens.md ? (
                  <ClientJump users={users} onPick={(id) => go(`clients/${id}`)} />
                ) : null}
                <Tooltip title={screens.sm ? null : 'Выйти'}>
                  <Button icon={<LogoutOutlined />} onClick={handleLogout} aria-label="Выйти">
                    {screens.sm ? 'Выйти' : null}
                  </Button>
                </Tooltip>
              </div>
            </Header>
            <Content className="app-content">
              <div className="app-content-inner">
                <JobsDock
                  open={dockOpen}
                  onOpenChange={setDockOpen}
                  pending={pending}
                  api={api}
                  message={message}
                  onAuthError={onAuthError}
                />
                <Suspense fallback={<div className="page-loading"><Spin /></div>}>
                  <Page {...shared} />
                </Suspense>
              </div>
            </Content>
          </Layout>

          <Drawer
            open={compact && navOpen}
            placement="left"
            width={260}
            onClose={() => setNavOpen(false)}
            styles={{ body: { padding: 0, background: '#0f172a' }, header: { display: 'none' } }}
          >
            {brandMark}
            <div style={{ padding: '12px 12px 0' }}>
              <ClientJump users={users} onPick={(id) => go(`clients/${id}`)} block />
            </div>
            {menu}
          </Drawer>
        </Layout>
      </WatchingProvider>
    </JobsProvider>
  );
}
