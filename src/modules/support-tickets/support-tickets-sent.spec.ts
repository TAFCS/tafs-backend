import { BadRequestException } from '@nestjs/common';
import { ChatMessageType, MessageStatus } from '@prisma/client';
import {
  SENT_SNIPPET_LENGTH,
  parseSentStatusFilter,
  sentReplySnippet,
  ticketTopicLabel,
} from './support-tickets-sent';

describe('parseSentStatusFilter (TAFSD-536)', () => {
  it('treats nothing, empty and "all" as every status', () => {
    expect(parseSentStatusFilter()).toBeNull();
    expect(parseSentStatusFilter('')).toBeNull();
    expect(parseSentStatusFilter('all')).toBeNull();
    expect(parseSentStatusFilter('ALL')).toBeNull();
    expect(parseSentStatusFilter('approved,all')).toBeNull();
  });

  it('maps one status, case-insensitively', () => {
    expect(parseSentStatusFilter('pending')).toEqual([MessageStatus.PENDING]);
    expect(parseSentStatusFilter('Approved')).toEqual([MessageStatus.APPROVED]);
    expect(parseSentStatusFilter(' REJECTED ')).toEqual([
      MessageStatus.REJECTED,
    ]);
  });

  it('accepts several comma-separated, without duplicates', () => {
    expect(parseSentStatusFilter('approved,rejected,approved')).toEqual([
      MessageStatus.APPROVED,
      MessageStatus.REJECTED,
    ]);
  });

  it('treats every status selected as no filter', () => {
    expect(parseSentStatusFilter('pending,approved,rejected')).toBeNull();
  });

  it('rejects an unknown status', () => {
    expect(() => parseSentStatusFilter('deleted')).toThrow(BadRequestException);
    expect(() => parseSentStatusFilter('approved,nope')).toThrow(
      BadRequestException,
    );
  });
});

describe('sentReplySnippet', () => {
  it('keeps short text as is', () => {
    expect(
      sentReplySnippet(ChatMessageType.TEXT, '  Fee received, thank you.  '),
    ).toBe('Fee received, thank you.');
  });

  it('cuts long text with an ellipsis', () => {
    const snippet = sentReplySnippet(ChatMessageType.TEXT, 'a'.repeat(500));
    expect(snippet).toBe(`${'a'.repeat(SENT_SNIPPET_LENGTH)}…`);
  });

  it('labels media replies by type', () => {
    expect(sentReplySnippet(ChatMessageType.IMAGE, 'https://cdn/x.png')).toBe(
      '[IMAGE]',
    );
    expect(sentReplySnippet(ChatMessageType.VOICE, 'https://cdn/x.m4a')).toBe(
      '[VOICE]',
    );
    expect(
      sentReplySnippet(ChatMessageType.DOCUMENT, 'https://cdn/x.pdf'),
    ).toBe('[DOCUMENT]');
  });
});

describe('ticketTopicLabel', () => {
  it('joins the flow path without the lane and child-picker steps', () => {
    expect(
      ticketTopicLabel({
        flow_path: [
          { key: 'general', type: 'LANE', label: 'General' },
          { key: 'child', type: 'PICK_CHILD', label: 'Ali' },
          { key: 'leave', type: 'TOPIC', label: 'Leave' },
          { key: 'sick', type: 'LEAF', label: 'Sick leave' },
        ],
        subtopic: 'ignored',
      }),
    ).toBe('Leave › Sick leave');
  });

  it('falls back to the legacy subtopic, then null', () => {
    expect(ticketTopicLabel({ flow_path: null, subtopic: 'Fee query' })).toBe(
      'Fee query',
    );
    expect(
      ticketTopicLabel({
        flow_path: [{ type: 'LANE', label: 'Fees' }],
        subtopic: null,
      }),
    ).toBeNull();
    expect(
      ticketTopicLabel({ flow_path: 'not-an-array', subtopic: '  ' }),
    ).toBeNull();
  });
});
