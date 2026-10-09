import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import MediaNodeView from './MediaNodeView.jsx';

// An image or a video inside an article: a block that points at an uploaded
// ASSET by id (never a URL), with a size and a caption. The server's schema
// (src/media/doc.js) knows exactly these two node names and attributes.
function mediaNode(name, tag) {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,

    addAttributes() {
      return {
        assetId: { default: null },
        size: { default: 'full' },
        caption: { default: '' },
      };
    },

    // Copy/paste within and between articles round-trips through this HTML.
    parseHTML() {
      return [{
        tag: `figure[data-${tag}]`,
        getAttrs: (el) => ({
          assetId: el.getAttribute('data-asset-id'),
          size: el.getAttribute('data-size') || 'full',
          caption: el.getAttribute('data-caption') || '',
        }),
      }];
    },

    renderHTML({ HTMLAttributes }) {
      return ['figure', mergeAttributes({
        [`data-${tag}`]: '',
        'data-asset-id': HTMLAttributes.assetId,
        'data-size': HTMLAttributes.size,
        'data-caption': HTMLAttributes.caption,
      })];
    },

    addNodeView() {
      // Let the size picker and the caption field inside the node keep their
      // own clicks and keystrokes instead of ProseMirror taking them.
      return ReactNodeViewRenderer(MediaNodeView, {
        stopEvent: ({ event }) => {
          const target = event.target;
          return !!target?.closest?.('.media-node-controls');
        },
      });
    },
  });
}

export const MediaImage = mediaNode('mediaImage', 'media-image');
export const MediaVideo = mediaNode('mediaVideo', 'media-video');
