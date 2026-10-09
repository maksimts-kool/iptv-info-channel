import { Space, Typography } from 'antd';
import NewsletterCard from '../components/NewsletterCard.jsx';
import NotifyCard from '../components/NotifyCard.jsx';

// Email: the newsletter the admin writes, then the global switch, the
// provider health and the send log. Individual subscribers are edited inside
// each customer's card.
export default function NotifyPage(shared) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        Подписки отдельных клиентов (адрес и темы) настраиваются в разделе «Клиенты» —
        вкладка «Уведомления» в карточке клиента.
      </Typography.Text>
      <NewsletterCard {...shared} />
      <NotifyCard {...shared} />
    </Space>
  );
}
