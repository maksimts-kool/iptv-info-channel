import { useCallback, useEffect, useState } from 'react';
import { Space, Tabs } from 'antd';
import { AuthError } from '../api.js';
import SourcesPanel from '../playlist/SourcesPanel.jsx';
import CategoriesPanel from '../playlist/CategoriesPanel.jsx';
import ChannelsPanel from '../playlist/ChannelsPanel.jsx';

// The main playlist: where the upstream m3u comes from, how it is grouped, and
// which channels are on air. Everything here is served to customers live — no
// stream re-encode is involved, so saves are plain saves.
export default function PlaylistPage({ api, message, onAuthError, reload }) {
  const [catalog, setCatalog] = useState(null);
  const [tab, setTab] = useState('channels');
  const [error, setError] = useState('');

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api.get('/admin/api/catalog'));
      setError('');
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(e.message);
    }
  }, [api, onAuthError]);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  // Anything that changes the catalog also changes the headline counts in
  // /api/state, so both are refreshed together.
  const refresh = useCallback(async () => {
    await loadCatalog();
    await reload();
  }, [loadCatalog, reload]);

  const shared = {
    api, message, onAuthError, catalog, refresh, error,
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'channels',
            label: `Каналы${catalog ? ` (${catalog.totals.channels})` : ''}`,
            children: <ChannelsPanel {...shared} />,
          },
          {
            key: 'categories',
            label: `Категории${catalog ? ` (${catalog.totals.categories})` : ''}`,
            children: <CategoriesPanel {...shared} onOpenChannels={() => setTab('channels')} />,
          },
          {
            key: 'sources',
            label: `Источники${catalog ? ` (${catalog.sources.length})` : ''}`,
            children: <SourcesPanel {...shared} />,
          },
        ]}
      />
    </Space>
  );
}
