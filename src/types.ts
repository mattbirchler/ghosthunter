/**
 * Shared types. No logic beyond `linkFor`, no imports.
 */

export type DocType = 'post' | 'page';
export type DocStatus = 'published' | 'draft' | 'scheduled' | 'sent';

export const DOC_TYPES: readonly DocType[] = ['post', 'page'];
export const DOC_STATUSES: readonly DocStatus[] = ['published', 'draft', 'scheduled', 'sent'];

export interface GhostDoc {
  id: string;
  type: DocType;
  status: DocStatus;
  title: string;
  slug: string;
  /** Public URL. Null for anything not publicly visible. */
  url: string | null;
  /** Always available, even for drafts. */
  editorUrl: string;
  plaintext: string;
  tags: string[];
  publishedAt: string | null;
  updatedAt: string;
}

export interface ParsedQuery {
  /** A safe FTS5 MATCH expression. Empty string means "no text query". */
  fts: string;
  tag?: string;
  before?: string;
  after?: string;
  status?: DocStatus;
  type?: DocType;
}

export interface SearchHit {
  doc: GhostDoc;
  snippet: string;
  score: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

export type PickerAction =
  | { kind: 'copy-url'; doc: GhostDoc }
  | { kind: 'copy-markdown'; doc: GhostDoc }
  | { kind: 'open'; doc: GhostDoc }
  | { kind: 'edit'; doc: GhostDoc }
  | { kind: 'cancel' };

/**
 * The URL worth putting on the clipboard. Drafts and scheduled posts have no
 * public URL, so they resolve to the Ghost editor instead of a dead link.
 */
export function linkFor(doc: GhostDoc): string {
  const isPublic = doc.status === 'published' || doc.status === 'sent';
  return isPublic ? (doc.url ?? doc.editorUrl) : doc.editorUrl;
}
