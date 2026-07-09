/**
 * Same-medium replies: a voice note in, a voice note out.
 *
 * WHY THIS IS NOT A PROMPT. The medium of a reply is not a judgement call — it
 * is `if (inbound was audio) then (outbound is audio)`. Asking the agent to
 * decide it failed three times in a row on 2026-07-09: the rule was in his
 * CLAUDE.local.md, he read it, and he replied in text anyway (`tools/say` was
 * never once invoked). Instructions are advisory; this file is not.
 *
 * HOW. Every `messages_out` row carries `in_reply_to`, which is byte-identical
 * to the `messages_in.id` it answers. That inbound row's content JSON carries
 * `attachments: [{ type: "audio", ... }]` for a voice note and `attachments: []`
 * for text. So the decision is a lookup, not an inference.
 *
 * The audio is produced by the GROUP'S OWN `tools/say`, not by logic duplicated
 * here — one implementation of the ogg/opus recipe, and a group opts in simply
 * by having that tool. A group without `tools/say` keeps replying in text, so
 * this is additive: it cannot change behaviour for anyone who has not installed
 * a voice.
 *
 * THE FORMAT IS LOAD-BEARING (verified 2026-07-09): Telegram promotes an upload
 * to a playable voice bubble only when the file is BOTH named `*.ogg` AND
 * encoded with Opus. nanoclaw always uploads via `sendDocument`; Telegram does
 * the promotion server-side. `tools/say` guarantees both and fails loudly
 * otherwise.
 *
 * FAILURE IS ALWAYS TEXT. Anything unexpected — no tool, a non-zero exit, a
 * timeout, an unreadable file — returns `undefined` and the caller delivers the
 * original text unchanged. A voice reply must never be able to swallow the
 * confirmation of a catheterisation.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { OutboundFile } from './channels/adapter.js';
import { GROUPS_DIR } from './config.js';
import { log } from './log.js';

/**
 * Telegram's caption limit is 1024 characters and the adapter TRUNCATES past
 * it. A day listing with `#ids` would therefore lose rows to make room for
 * audio nobody asked for — so long replies stay text. This is the deterministic
 * form of the "dado continua texto" rule: data must stay scannable on screen.
 */
export const MAX_VOICE_CAPTION = 900;

/** Telegram only promotes `.ogg` uploads; other channels get their text. */
const VOICE_CHANNELS = new Set(['telegram']);

/** `tools/say` shells out to piper; ~1s on a Pi 5, but never hang delivery. */
const SAY_TIMEOUT_MS = 30_000;

/**
 * True when the inbound message this reply answers carried an audio attachment.
 *
 * Matches on `type === 'audio'` (what the Telegram adapter labels a voice note)
 * rather than on an empty `text`, because a caption-less photo also has empty
 * text and must not be answered with speech.
 */
export function inboundWasVoice(inDb: Database.Database, inReplyTo: string | null): boolean {
  if (!inReplyTo) return false;
  try {
    const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(inReplyTo) as
      | { content: string }
      | undefined;
    if (!row?.content) return false;
    const parsed = JSON.parse(row.content) as { attachments?: Array<{ type?: string; mimeType?: string }> };
    const attachments = parsed.attachments ?? [];
    return attachments.some((a) => a.type === 'audio' || (a.mimeType ?? '').startsWith('audio/'));
  } catch (err) {
    log.warn('voice-reply: could not read inbound row', { inReplyTo, err });
    return false;
  }
}

/** The reply text the adapter would have sent, or '' when there is none. */
export function replyText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as { markdown?: unknown; text?: unknown };
  const raw = typeof c.markdown === 'string' ? c.markdown : typeof c.text === 'string' ? c.text : '';
  return raw.trim();
}

/**
 * Speak `text` with the group's own `tools/say`. Returns the `.ogg` as an
 * OutboundFile, or `undefined` if the group has no voice or synthesis failed.
 */
export function synthesizeVoice(groupFolder: string, text: string): OutboundFile | undefined {
  const say = path.join(GROUPS_DIR, groupFolder, 'tools', 'say');
  try {
    fs.accessSync(say, fs.constants.X_OK);
  } catch {
    return undefined; // group has no voice — not an error
  }

  let oggPath = '';
  try {
    oggPath = execFileSync(say, [text], { timeout: SAY_TIMEOUT_MS, encoding: 'utf-8' }).trim();
    if (!oggPath.endsWith('.ogg')) throw new Error(`say printed a non-ogg path: ${oggPath}`);
    const data = fs.readFileSync(oggPath);
    if (data.length === 0) throw new Error('say produced an empty file');
    // The filename is what Telegram sniffs; it must end in .ogg.
    return { filename: 'voz.ogg', data };
  } catch (err) {
    log.warn('voice-reply: synthesis failed, falling back to text', { groupFolder, err });
    return undefined;
  } finally {
    if (oggPath) fs.rm(path.dirname(oggPath), { recursive: true, force: true }, () => {});
  }
}

/**
 * The whole decision, in one place. Returns files to attach, or `undefined` to
 * let the reply go out as plain text.
 */
export function maybeVoiceReply(args: {
  kind: string;
  channelType: string | null;
  inReplyTo: string | null;
  content: unknown;
  groupFolder: string;
  inDb: Database.Database;
}): OutboundFile[] | undefined {
  const { kind, channelType, inReplyTo, content, groupFolder, inDb } = args;
  if (kind !== 'chat') return undefined; // system actions are not conversation
  if (!channelType || !VOICE_CHANNELS.has(channelType)) return undefined;

  const text = replyText(content);
  if (!text) return undefined;
  if (text.length > MAX_VOICE_CAPTION) return undefined; // data stays text
  if (!inboundWasVoice(inDb, inReplyTo)) return undefined;

  const file = synthesizeVoice(groupFolder, text);
  return file ? [file] : undefined;
}
