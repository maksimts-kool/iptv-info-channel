// Who sees what on the media channel. Pure — no I/O — and unit-tested
// (test/media/variants.test.js).
//
// The channel used to be one loop for everyone. With PRIVATE content — a whole
// article for an audience (`article.audience`), or a private section inside an
// article (media/doc.js) — customers can see different channels. Encoding one
// loop per customer would not scale, so customers are grouped by what they
// actually see: a VARIANT is "these articles, with these of their private
// sections", and everyone in the same variant shares one loop.
//
// The PUBLIC variant is what a customer in no audience sees — the original
// shared loop. Every other variant is a strict superset of it (private content
// only ever adds), which is why the public loop is a safe stand-in while a
// customer's own variant is still being built.
import { audienceMatches } from '../core/audience.js';
import { docHasContent, filterPrivate, privateSections } from './doc.js';

// `viewer`: a customer, null (the public — nobody's audience) or 'all' (the
// admin, who sees every private section; used by the preview).
export function canSeeFor(viewer) {
  return (audience) => (viewer === 'all' ? true : audienceMatches(audience, viewer));
}

// The articles this viewer sees, in play order, each resolved to the document
// they see: [{ article, mask }]. `article.doc` is the filtered document and
// `mask` records which private sections it kept ('101'). Articles that end up
// empty are left out, as on the channel.
export function articlesFor(articles, viewer) {
  const canSee = canSeeFor(viewer);
  const out = [];
  for (const article of articles) {
    if (article.audience && !canSee(article.audience)) continue;
    const doc = filterPrivate(article.doc, canSee);
    if (!docHasContent(doc)) continue;
    const mask = privateSections(article.doc).map((aud) => (canSee(aud) ? '1' : '0')).join('');
    out.push({ article: { ...article, doc }, mask });
  }
  return out;
}

// A stable name for "what this viewer sees". Equal keys = identical channel.
export function variantKey(entries) {
  return entries.map(({ article, mask }) => `${article.id}:${mask}`).join(',');
}

// Every variant the customers need, plus the public one (always present, even
// if no customer is on it: it is the fallback). -> Map key -> { entries,
// userIds, public }
export function mediaVariants(articles, users = []) {
  const variants = new Map();
  const publicEntries = articlesFor(articles, null);
  const publicKey = variantKey(publicEntries);
  variants.set(publicKey, { entries: publicEntries, userIds: [], public: true });
  for (const user of users) {
    const entries = articlesFor(articles, user);
    const key = variantKey(entries);
    if (!variants.has(key)) variants.set(key, { entries, userIds: [], public: false });
    variants.get(key).userIds.push(user.id);
  }
  return { publicKey, variants };
}

// Whether any article holds private content at all — when none does, every
// customer is on the public variant and user changes need no media rebuild.
export function hasPrivateContent(articles) {
  return articles.some((a) => a.audience || privateSections(a.doc).length);
}
