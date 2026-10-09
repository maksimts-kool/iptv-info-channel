// The media channel's article format: a TipTap/ProseMirror JSON document, as
// the admin's editor produces it. Pure — no I/O — and unit-tested
// (test/media/doc.test.js).
//
// The server never trusts the stored shape: `sanitizeDoc` keeps only the node
// types and marks the TV renderer (render/article.js) can draw, with their
// attributes coerced, so a hand-crafted request can't smuggle anything else in.
// Images and videos are referenced by ASSET id (media/store.js), never by URL —
// the renderer reads the files from disk.
//
// A `privateSection` block wraps part of an article that only an audience (a
// group of customers, core/audience.js) gets to see. It never reaches the TV
// renderer: `filterPrivate` resolves every section for one viewer first —
// unwrapped for a member, dropped for everyone else — so render/article.js only
// ever draws a plain document.
import { cleanAudience } from '../core/audience.js';

export const MEDIA_SIZES = ['full', 'half', 'small'];
const MARKS = new Set(['bold', 'italic', 'strike', 'code']);
const MAX_DEPTH = 12;
export const DOC_MAX_BYTES = 300_000;

const str = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanMedia(node) {
  const attrs = node.attrs || {};
  const assetId = /^[a-z0-9]{6,32}$/.test(String(attrs.assetId || '')) ? attrs.assetId : null;
  if (!assetId) return null;
  return {
    type: node.type,
    attrs: {
      assetId,
      size: MEDIA_SIZES.includes(attrs.size) ? attrs.size : 'full',
      caption: str(attrs.caption, 200),
    },
  };
}

function cleanText(node) {
  const text = String(node.text ?? '');
  if (!text) return null;
  const marks = (Array.isArray(node.marks) ? node.marks : [])
    .filter((m) => MARKS.has(m?.type))
    .map((m) => ({ type: m.type }));
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
}

// A cleaned child may come back as an array: a private section nested inside
// another one is spliced into its parent (a section inside a section would
// mean "members of both", which the editor never offers).
function cleanChildren(node, depth, inPrivate = false) {
  return (Array.isArray(node.content) ? node.content : [])
    .flatMap((child) => cleanNode(child, depth + 1, inPrivate))
    .filter(Boolean);
}

function cleanNode(node, depth = 0, inPrivate = false) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
  const withContent = (type, attrs) => {
    const out = { type };
    if (attrs) out.attrs = attrs;
    const content = cleanChildren(node, depth, inPrivate);
    if (content.length) out.content = content;
    return out;
  };
  switch (node.type) {
    case 'privateSection': {
      const content = cleanChildren(node, depth, true);
      if (inPrivate) return content;
      if (!content.length) return null;
      return {
        type: 'privateSection',
        attrs: { audience: cleanAudience(node.attrs?.audience) || { users: [], plans: [] } },
        content,
      };
    }
    case 'doc':
    case 'paragraph':
    case 'bulletList':
    case 'listItem':
    case 'blockquote':
    case 'table':
    case 'tableRow':
    case 'tableHeader':
    case 'tableCell':
      return withContent(node.type);
    case 'heading':
      return withContent('heading', { level: Math.min(3, Math.max(1, Number(node.attrs?.level) || 1)) });
    case 'orderedList':
      return withContent('orderedList', { start: Math.max(1, Math.floor(Number(node.attrs?.start) || 1)) });
    case 'codeBlock':
      return withContent('codeBlock');
    case 'horizontalRule':
    case 'hardBreak':
      return { type: node.type };
    case 'text':
      return cleanText(node);
    case 'mediaImage':
    case 'mediaVideo':
      return cleanMedia(node);
    default:
      // Unknown wrapper: keep what is inside it rather than lose the text.
      return Array.isArray(node.content) && node.content.length
        ? withContent('paragraph')
        : null;
  }
}

// -> { value: doc } | { error }
export function sanitizeDoc(doc) {
  if (!doc || typeof doc !== 'object' || doc.type !== 'doc') return { error: 'doc must be a document' };
  if (JSON.stringify(doc).length > DOC_MAX_BYTES) {
    return { error: `the article is too long (${Math.round(DOC_MAX_BYTES / 1000)} KB max)` };
  }
  return { value: cleanNode(doc) || { type: 'doc' } };
}

export function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// Every asset an article uses, in document order, each once.
export function docAssetIds(doc) {
  const ids = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'mediaImage' || node.type === 'mediaVideo') && node.attrs?.assetId) {
      if (!ids.includes(node.attrs.assetId)) ids.push(node.attrs.assetId);
    }
    (node.content || []).forEach(walk);
  };
  walk(doc);
  return ids;
}

// Whether there is anything to show: some text, an image or a video.
export function docHasContent(doc) {
  let found = false;
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'text' && node.text.trim()) found = true;
    else if (node.type === 'mediaImage' || node.type === 'mediaVideo' || node.type === 'horizontalRule') found = true;
    (node.content || []).forEach(walk);
  };
  walk(doc);
  return found;
}

// Plain text of the first block with any, for the admin list.
export function docSummary(doc, max = 90) {
  for (const block of doc?.content || []) {
    const parts = [];
    const walk = (node) => {
      if (node.type === 'text') parts.push(node.text);
      (node.content || []).forEach(walk);
    };
    walk(block);
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, max);
  }
  return '';
}

// Split an article at its top-level videos: [{ kind: 'flow', nodes }, { kind:
// 'video', node }, …]. The TV renderer lays each piece out separately so it
// knows exactly where every video sits on the page (satori reports no
// positions), and pauses the scroll there while the video plays. A video
// nested inside a list or quote stays in its flow as a still poster.
export function docSections(doc) {
  const sections = [];
  let flow = [];
  for (const node of doc?.content || []) {
    if (node.type === 'mediaVideo') {
      if (flow.length) sections.push({ kind: 'flow', nodes: flow });
      flow = [];
      sections.push({ kind: 'video', node });
    } else {
      flow.push(node);
    }
  }
  if (flow.length) sections.push({ kind: 'flow', nodes: flow });
  return sections;
}

// ---------------------------------------------------------------------------
// Private sections
// ---------------------------------------------------------------------------

// Resolve every private section for one viewer: `canSee(audience)` -> bool.
// A section the viewer may see is unwrapped into its parent (so a video inside
// it becomes a top-level video and pauses the scroll like any other); one they
// may not see is removed. The result is a plain document.
export function filterPrivate(doc, canSee) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return [node];
    if (node.type === 'privateSection') {
      if (!canSee(node.attrs?.audience || null)) return [];
      return (node.content || []).flatMap(walk);
    }
    if (!Array.isArray(node.content)) return [node];
    return [{ ...node, content: node.content.flatMap(walk) }];
  };
  return walk(doc)[0] || { type: 'doc' };
}

// The private sections in document order (their audiences), for counting and
// for telling viewers apart: two customers who see the same sections of the
// same articles see the same channel.
export function privateSections(doc) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'privateSection') found.push(node.attrs?.audience || null);
    (node.content || []).forEach(walk);
  };
  walk(doc);
  return found;
}
