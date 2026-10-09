import { Select, Space, Typography } from 'antd';
import { TeamOutlined, UserOutlined } from '@ant-design/icons';
import { audienceMembers, clientsWord, EMPTY_AUDIENCE } from '../lib/audience.js';

// Pick a group of customers: whole plans and/or individual customers. A
// customer is in the group if either list names them, so "тариф Про + Иван"
// reads exactly as it behaves. Shows who that is right now underneath.
export default function AudiencePicker({
  value, onChange, users = [], plans = [], size, showCount = true,
}) {
  const audience = value || EMPTY_AUDIENCE;
  const members = audienceMembers(audience, users);
  const set = (patch) => onChange?.({ ...audience, ...patch });

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Select
        mode="multiple"
        size={size}
        allowClear
        placeholder="Тарифы — все клиенты на них"
        value={audience.plans}
        onChange={(planIds) => set({ plans: planIds })}
        options={plans.map((p) => ({ value: p.id, label: p.name }))}
        suffixIcon={<TeamOutlined />}
        style={{ width: '100%' }}
        optionFilterProp="label"
      />
      <Select
        mode="multiple"
        size={size}
        allowClear
        placeholder="Отдельные клиенты"
        value={audience.users}
        onChange={(userIds) => set({ users: userIds })}
        options={users.map((u) => ({ value: u.id, label: u.username }))}
        suffixIcon={<UserOutlined />}
        style={{ width: '100%' }}
        optionFilterProp="label"
        maxTagCount="responsive"
      />
      {showCount ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {members.length
            ? `Сейчас в группе: ${members.length} ${clientsWord(members.length)}${
              members.length <= 5 ? ` — ${members.map((u) => u.username).join(', ')}` : ''}`
            : 'В группе пока никого — выберите тариф или клиентов.'}
        </Typography.Text>
      ) : null}
    </Space>
  );
}
