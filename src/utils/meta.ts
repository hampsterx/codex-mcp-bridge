/**
 * Build execution metadata attached as `_meta` on tool responses,
 * providing orchestrating agents with timing, model, and session information.
 */
export function buildMeta(fields: {
  durationMs: number;
  model?: string;
  fallbackUsed?: boolean;
  sessionId?: string;
  conversationId?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    durationMs: fields.durationMs,
  };
  if (fields.model) meta.model = fields.model;
  if (fields.fallbackUsed) meta.fallbackUsed = true;
  if (fields.sessionId) meta.sessionId = fields.sessionId;
  if (fields.conversationId) meta.conversationId = fields.conversationId;
  return meta;
}
