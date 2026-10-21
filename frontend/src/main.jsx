import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import 'antd/dist/reset.css';
import './index.css';
import App from './App.jsx';

// One small set of design tokens instead of per-screen colours: a single brand
// blue, softer radii and a calm page background so cards read as grouped
// regions. index.css holds the shell layout and the mobile overrides AntD's
// desktop-first defaults need.
const theme = {
  token: {
    colorPrimary: '#2563eb',
    colorSuccess: '#16a34a',
    colorWarning: '#d97706',
    colorError: '#dc2626',
    colorBgLayout: '#f4f6fa',
    colorBorderSecondary: '#eceef2',
    borderRadius: 8,
    borderRadiusLG: 12,
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      headerHeight: 64,
      siderBg: '#0f172a',
    },
    Menu: {
      darkItemBg: '#0f172a',
      darkSubMenuItemBg: '#0f172a',
      darkItemSelectedBg: '#2563eb',
      darkGroupTitleColor: 'rgba(255, 255, 255, 0.38)',
      itemHeight: 40,
      itemMarginBlock: 2,
      itemBorderRadius: 8,
    },
    Card: {
      headerFontSize: 15,
    },
    Statistic: {
      contentFontSize: 26,
    },
  },
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider locale={ruRU} theme={theme}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
