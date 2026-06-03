export type CanonicalWebhookEvent = 'edit' | 'delete' | 'move' | 'protect';

export interface WebhookBody {
  event: CanonicalWebhookEvent | 'page_save' | 'page_delete' | 'page_move' | 'page_protect';
  page_id: number;
  title?: string;
  new_title?: string;
  namespace: number;
  rev_id?: number;
  timestamp: string;
  user?: string;
  user_id?: number;
  summary?: string;
}

export function normalizeEvent(event: WebhookBody['event']): CanonicalWebhookEvent | null {
  if (event === 'page_save') return 'edit';
  if (event === 'page_delete') return 'delete';
  if (event === 'page_move') return 'move';
  if (event === 'page_protect') return 'protect';
  if (event === 'edit' || event === 'delete' || event === 'move' || event === 'protect') return event;
  return null;
}

export function getWebhookTitle(body: Pick<WebhookBody, 'title' | 'new_title'>): string | null {
  return body.title ?? body.new_title ?? null;
}
