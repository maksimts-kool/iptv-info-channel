import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

// Lower-cased, ё folded into е, so "Семён" is found by "семен".
export const normalize = (text) => String(text ?? '').toLowerCase().replace(/ё/g, 'е').trim();

// Does a customer match a free-text query? Name, plan, id and email all count —
// the admin types whatever they remember about the person.
export function clientMatches(user, query, email = '') {
  const q = normalize(query);
  if (!q) return true;
  return [user.username, user.plan_name, email, String(user.id)].some((v) => normalize(v).includes(q));
}

// "Find a customer" box in the header: the most common task (open someone's
// card to renew, copy their link, check their channels) is one keystroke away
// from any screen. "/" focuses it, like search on most sites.
export default function ClientJump({ users, onPick, block = false }) {
  const ref = useRef(null);
  const [value, setValue] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (block) return undefined;
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [block]);

  const options = useMemo(() => users.map((u) => ({
    value: u.id,
    user: u,
    label: (
      <div className="client-jump-option">
        <span className="client-jump-name">{u.username}</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>{u.plan_name}</Typography.Text>
        <Tag color={u.status_color} style={{ marginInlineEnd: 0 }}>{u.status_label}</Tag>
      </div>
    ),
  })), [users]);

  return (
    <Select
      ref={ref}
      showSearch
      value={value}
      open={open}
      onOpenChange={setOpen}
      onSearch={() => setOpen(true)}
      placeholder="Найти клиента"
      suffixIcon={block ? <SearchOutlined /> : <kbd className="kbd-hint" title="Нажмите /, чтобы искать">/</kbd>}
      options={options}
      filterOption={(input, option) => clientMatches(option.user, input)}
      notFoundContent="Никого не нашлось"
      onSelect={(id) => {
        setValue(null);
        setOpen(false);
        ref.current?.blur();
        onPick(id);
      }}
      popupMatchSelectWidth={block ? true : 340}
      placement={block ? 'bottomLeft' : 'bottomRight'}
      style={{ width: block ? '100%' : 260 }}
      aria-label="Найти клиента"
    />
  );
}
