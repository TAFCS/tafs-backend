import { BadRequestException } from '@nestjs/common';
import { ChatMessageType, MessageStatus } from '@prisma/client';

/**
 * The "Sent" view (TAFSD-536): a staff member's own ticket replies, filtered by
 * the review status a super admin gave them. Pure helpers, kept out of the
 * service so they can be unit tested without Prisma.
 */

export const SENT_STATUS_FILTERS = ['pending', 'approved', 'rejected'] as const;
export type SentStatusFilter = (typeof SENT_STATUS_FILTERS)[number];

const TO_MESSAGE_STATUS: Record<SentStatusFilter, MessageStatus> = {
  pending: MessageStatus.PENDING,
  approved: MessageStatus.APPROVED,
  rejected: MessageStatus.REJECTED,
};

/**
 * `?status=` accepts `all` (or nothing) for every reply, one of
 * pending / approved / rejected, or several comma-separated
 * (`approved,rejected`), case-insensitively. Returns the message statuses to
 * filter on, or null for "every status".
 */
export function parseSentStatusFilter(raw?: string): MessageStatus[] | null {
  const parts = (raw ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0 || parts.includes('all')) return null;

  const statuses = new Set<MessageStatus>();
  for (const part of parts) {
    if (!(SENT_STATUS_FILTERS as readonly string[]).includes(part)) {
      throw new BadRequestException(
        `Invalid status "${part}". Use all, pending, approved or rejected.`,
      );
    }
    statuses.add(TO_MESSAGE_STATUS[part as SentStatusFilter]);
  }
  // Every status selected is the same as no filter.
  return statuses.size === SENT_STATUS_FILTERS.length ? null : [...statuses];
}

export const SENT_SNIPPET_LENGTH = 140;

/** Text replies are cut to a readable preview; media replies read `[IMAGE]`, `[VOICE]`, `[DOCUMENT]`. */
export function sentReplySnippet(
  messageType: ChatMessageType,
  content: string,
): string {
  if (messageType !== ChatMessageType.TEXT) return `[${messageType}]`;
  const text = content.trim();
  return text.length > SENT_SNIPPET_LENGTH
    ? `${text.slice(0, SENT_SNIPPET_LENGTH).trimEnd()}…`
    : text;
}

/**
 * The ticket's topic as staff lists show it: the path the parent walked through
 * the flow, without the lane and child-picker steps ("Leave › Sick leave"), or
 * the legacy subtopic for tickets opened before the flow existed.
 */
export function ticketTopicLabel(ticket: {
  flow_path?: unknown;
  subtopic?: string | null;
}): string | null {
  const steps = Array.isArray(ticket.flow_path)
    ? (ticket.flow_path as { type?: unknown; label?: unknown }[]).filter(
        (s) =>
          s != null &&
          typeof s.label === 'string' &&
          s.label.trim() !== '' &&
          s.type !== 'LANE' &&
          s.type !== 'PICK_CHILD',
      )
    : [];
  if (steps.length > 0)
    return steps.map((s) => (s.label as string).trim()).join(' › ');
  return ticket.subtopic?.trim() || null;
}
