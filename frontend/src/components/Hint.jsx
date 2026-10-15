import { Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';

// Explanations stay one hover away instead of filling the screen with text.
export default function Hint({ text }) {
  return (
    <Tooltip title={text} styles={{ root: { maxWidth: 360 } }}>
      <QuestionCircleOutlined className="hint-icon" aria-label={typeof text === 'string' ? text : 'Подсказка'} />
    </Tooltip>
  );
}
