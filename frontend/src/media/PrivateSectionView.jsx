import { useContext } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import {
  Button, Popover, Tooltip, Typography,
} from 'antd';
import { LockOutlined, TeamOutlined, UnlockOutlined } from '@ant-design/icons';
import AudiencePicker from '../components/AudiencePicker.jsx';
import { audienceIsEmpty, audienceLabel } from '../lib/audience.js';
import { AudienceContext } from './audienceContext.js';

// A private part of an article in the editor: a tinted box with a header saying
// who sees it, a picker to change that, and a button to make it public again
// (the content stays, only the box goes). Everything inside is edited as usual.
export default function PrivateSectionView({
  node, updateAttributes, editor, getPos,
}) {
  const { users, plans } = useContext(AudienceContext);
  const audience = node.attrs.audience || { users: [], plans: [] };
  const empty = audienceIsEmpty(audience);

  const unwrap = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().focus().command(({ tr }) => {
      const current = tr.doc.nodeAt(pos);
      if (!current) return false;
      tr.replaceWith(pos, pos + current.nodeSize, current.content);
      return true;
    }).run();
  };

  const picker = (
    <div style={{ width: 320, maxWidth: '80vw' }}>
      <AudiencePicker
        value={audience}
        onChange={(next) => updateAttributes({ audience: next })}
        users={users}
        plans={plans}
        size="small"
      />
    </div>
  );

  return (
    <NodeViewWrapper className={`private-section${empty ? ' is-empty' : ''}`}>
      <div className="private-section-head" contentEditable={false}>
        <LockOutlined />
        <Typography.Text className="private-section-label" ellipsis>
          {empty ? 'Закрытая часть — выберите, кому её показывать' : `Видят только: ${audienceLabel(audience, users, plans)}`}
        </Typography.Text>
        <Popover trigger="click" placement="bottomRight" title="Кто видит эту часть" content={picker} defaultOpen={empty}>
          <Button size="small" icon={<TeamOutlined />}>Кому</Button>
        </Popover>
        <Tooltip title="Показывать всем (убрать ограничение, текст останется)">
          <Button size="small" icon={<UnlockOutlined />} onClick={unwrap} aria-label="Показывать всем" />
        </Tooltip>
      </div>
      <NodeViewContent className="private-section-body" />
    </NodeViewWrapper>
  );
}
