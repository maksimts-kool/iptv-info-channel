import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import PrivateSectionView from './PrivateSectionView.jsx';

const EMPTY = { users: [], plans: [] };

// A part of an article only a group of customers sees: a block wrapping other
// blocks, with the group in `audience` ({ users, plans }, src/core/audience.js).
// The server's schema (src/media/doc.js) knows exactly this node; on TV it is
// resolved per viewer — unwrapped for the group, absent for everyone else.
export const PrivateSection = Node.create({
  name: 'privateSection',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      audience: {
        default: EMPTY,
        parseHTML: (el) => {
          try { return JSON.parse(el.getAttribute('data-audience')) || EMPTY; } catch { return EMPTY; }
        },
        renderHTML: (attrs) => ({ 'data-audience': JSON.stringify(attrs.audience || EMPTY) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-private-section]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-private-section': '' }, HTMLAttributes), 0];
  },

  addNodeView() {
    // The header (group, buttons) keeps its own clicks; the body is ordinary
    // editable article text.
    return ReactNodeViewRenderer(PrivateSectionView, {
      stopEvent: ({ event }) => !!event.target?.closest?.('.private-section-head'),
    });
  },
});
