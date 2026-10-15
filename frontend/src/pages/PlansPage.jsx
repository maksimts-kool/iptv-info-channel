import { useCallback, useEffect, useState } from 'react';
import { Space } from 'antd';
import { AuthError } from '../lib/api.js';
import PlansCard from '../components/PlansCard.jsx';

// Plans are the channel packages, so this page needs the catalog's categories to
// offer as choices — it fetches them itself rather than bloating /api/state.
export default function PlansPage(shared) {
  const { api, onAuthError, reloadToken } = shared;
  const [categories, setCategories] = useState([]);

  const load = useCallback(async () => {
    try {
      setCategories((await api.get('/admin/api/catalog')).categories || []);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  }, [api, onAuthError]);

  useEffect(() => { load(); }, [load, reloadToken]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <PlansCard {...shared} categories={categories} />
    </Space>
  );
}
