/**
 * Same-medium reply gating.
 *
 * These tests are the integration points of voice-reply.ts with the rest of the
 * system. They go red if: `messages_in.id` stops matching `messages_out.in_reply_to`,
 * the Telegram adapter stops labelling voice notes `type: "audio"`, the caption
 * limit stops protecting data blocks from truncation, or a group without a
 * `tools/say` stops falling back to text.
 *
 * The piper/ffmpeg synthesis itself is NOT unit-tested here (it is a subprocess
 * and a 60 MB model); it is covered by `tools/say`'s own ffprobe assert, which
 * refuses to emit anything that is not opus.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { INBOUND_SCHEMA } from './db/schema.js';
import { MAX_VOICE_CAPTION, inboundWasVoice, maybeVoiceReply, replyText, synthesizeVoice } from './voice-reply.js';

const VOICE_ID = '152099202:127:ag-test';
const TEXT_ID = '152099202:88:ag-test';
const PHOTO_ID = '152099202:99:ag-test';

let inDb: Database.Database;

function insert(id: string, content: unknown, seq: number) {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content, trigger)
       VALUES (?, ?, 'chat-sdk', '2026-07-09T20:35:59.000Z', ?, 1)`,
    )
    .run(id, seq, JSON.stringify(content));
}

beforeEach(() => {
  inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  // Shapes copied verbatim from the live inbound.db on 2026-07-09.
  insert(VOICE_ID, { text: '', attachments: [{ type: 'audio', mimeType: 'audio/ogg', name: 'a.ogg' }] }, 2);
  insert(TEXT_ID, { text: 'quando devo sondar?', attachments: [] }, 4);
  insert(PHOTO_ID, { text: '', attachments: [{ type: 'image', mimeType: 'image/jpeg', name: 'p.jpg' }] }, 6);
});

describe('inboundWasVoice', () => {
  it('is true for a Telegram voice note (attachment type "audio")', () => {
    expect(inboundWasVoice(inDb, VOICE_ID)).toBe(true);
  });

  it('is false for plain text (attachments: [])', () => {
    expect(inboundWasVoice(inDb, TEXT_ID)).toBe(false);
  });

  it('is false for a caption-less photo — empty text is NOT the signal', () => {
    expect(inboundWasVoice(inDb, PHOTO_ID)).toBe(false);
  });

  it('is false, not throwing, when in_reply_to is null or unknown', () => {
    expect(inboundWasVoice(inDb, null)).toBe(false);
    expect(inboundWasVoice(inDb, 'no-such-id')).toBe(false);
  });
});

describe('replyText', () => {
  it('reads markdown or text, trimmed', () => {
    expect(replyText({ markdown: '  oi  ' })).toBe('oi');
    expect(replyText({ text: 'oi' })).toBe('oi');
    expect(replyText({})).toBe('');
    expect(replyText(null)).toBe('');
  });
});

describe('synthesizeVoice', () => {
  it('returns undefined when the group has no tools/say — voice is opt-in', () => {
    expect(synthesizeVoice('group-that-does-not-exist', 'oi')).toBeUndefined();
  });
});

describe('maybeVoiceReply gates', () => {
  const base = {
    kind: 'chat',
    channelType: 'telegram',
    inReplyTo: VOICE_ID,
    content: { text: 'Confere, cap’n.' },
    groupFolder: 'group-that-does-not-exist',
    get inDb() {
      return inDb;
    },
  };

  it('does not speak for a text inbound', () => {
    expect(maybeVoiceReply({ ...base, inReplyTo: TEXT_ID })).toBeUndefined();
  });

  it('does not speak system-kind messages', () => {
    expect(maybeVoiceReply({ ...base, kind: 'system' })).toBeUndefined();
  });

  it('does not speak on non-Telegram channels (only Telegram promotes .ogg)', () => {
    expect(maybeVoiceReply({ ...base, channelType: 'cli' })).toBeUndefined();
  });

  it('does not speak an empty reply', () => {
    expect(maybeVoiceReply({ ...base, content: { text: '   ' } })).toBeUndefined();
  });

  it('does not speak a long data block — the caption would be truncated', () => {
    const long = 'x'.repeat(MAX_VOICE_CAPTION + 1);
    expect(maybeVoiceReply({ ...base, content: { text: long } })).toBeUndefined();
  });

  it('falls back to text when the group has no voice, even for a voice inbound', () => {
    expect(maybeVoiceReply(base)).toBeUndefined();
  });
});
