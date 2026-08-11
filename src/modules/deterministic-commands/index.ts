/**
 * Deterministic commands — host-side slash-command executor for approved
 * non-owner senders (e.g. caregivers), with ZERO agent/LLM involvement.
 *
 * A `/command` DM from a sender on the allowlist is claimed by a pre-route
 * message interceptor (before messaging-group resolution, before any DB
 * write), executed as a host process, and answered via the delivery adapter —
 * no session row, no container wake, no model anywhere in the path. All
 * POLICY (who, which commands, what they run) lives in an external config
 * file; this module is pure mechanism and knows nothing about any domain.
 *
 * Config: ~/.config/nanoclaw/deterministic-commands.json — rendered by an
 * external sync job, reloaded on mtime (same pattern as mount-security):
 *   {
 *     "owner": "telegram:<id>",            // owner's DMs are NEVER intercepted
 *     "allowed_senders": ["telegram:<id>"],
 *     "commands": {
 *       "name": {"exec": "/abs/tool", "args": ["sub", "$1"],
 *                 "arg_re": "^[0-9]{1,4}$", "usage": "uso: ..."},
 *       "help": {"reply": "static text"}
 *     }
 *   }
 *
 * Fail-closed for allowed senders: once a sender is on the allowlist and the
 * text is a command, the message NEVER falls through to the agent — an
 * unknown command, a bad argument or an exec failure all answer
 * deterministically and consume the message. Free (non-command) text routes
 * normally. Missing/broken config = module inert (owner-only behavior
 * unchanged).
 *
 * The executed tool learns the VERIFIED sender via DETCMD_SESSION_PLATFORM_ID
 * and PLANTAO_SESSION_PLATFORM_ID (transport truth: event.platformId).
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'deterministic-commands.json');
const EXEC_TIMEOUT_MS = 20_000;
const MAX_REPLY_LEN = 3900; // Telegram hard cap is 4096; leave headroom

interface ExecCommand {
  exec: string;
  args: string[];
  arg_re?: string;
  usage?: string;
}
interface ReplyCommand {
  reply: string;
}
type CommandSpec = ExecCommand | ReplyCommand;

interface DetCmdConfig {
  owner: string;
  allowed_senders: string[];
  commands: Record<string, CommandSpec>;
}

let cache: { mtimeMs: number; config: DetCmdConfig } | null = null;

/** mtime-cached config load; parse errors are never cached (fix + next call recovers). */
function loadConfig(): DetCmdConfig | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(CONFIG_PATH);
  } catch {
    return null; // no config -> module inert
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.config;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    if (
      typeof raw.owner !== 'string' ||
      !Array.isArray(raw.allowed_senders) ||
      typeof raw.commands !== 'object' ||
      raw.commands === null
    ) {
      throw new Error('deterministic-commands config must have owner/allowed_senders/commands');
    }
    const config = raw as unknown as DetCmdConfig;
    cache = { mtimeMs: stat.mtimeMs, config };
    log.info('deterministic-commands config loaded', {
      path: CONFIG_PATH,
      senders: config.allowed_senders.length,
      commands: Object.keys(config.commands).length,
    });
    return config;
  } catch (err) {
    log.error('deterministic-commands config unreadable — module inert until fixed', { path: CONFIG_PATH, err });
    return null;
  }
}

function parseText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return content;
  }
}

/** `/cmd arg` | `/cmd@BotName arg` -> [cmd, arg]; null when not a command shape. */
function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text.trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[2] ?? '').trim() };
}

async function reply(event: InboundEvent, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('deterministic-commands: no delivery adapter — reply dropped', { platformId: event.platformId });
    return;
  }
  const capped = text.length > MAX_REPLY_LEN ? `${text.slice(0, MAX_REPLY_LEN)}\n[…]` : text;
  await adapter.deliver(
    event.channelType,
    event.platformId,
    null,
    'chat-sdk',
    JSON.stringify({ text: capped }),
    undefined,
    event.instance,
  );
}

function runExec(spec: ExecCommand, arg: string, senderPlatformId: string): Promise<string> {
  const args = spec.args.map((a) => (a === '$1' ? arg : a));
  return new Promise((resolve) => {
    execFile(
      spec.exec,
      args,
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          // Transport-verified identity for the tool's own guards. The tool
          // name is domain-specific but the mechanism is not: any tool may
          // read either variable.
          DETCMD_SESSION_PLATFORM_ID: senderPlatformId,
          PLANTAO_SESSION_PLATFORM_ID: senderPlatformId,
        },
      },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
        if (err && !out) {
          log.error('deterministic-commands: exec failed with no output', { exec: spec.exec, err });
          resolve('erro ao executar o comando — avise o Felipe.');
          return;
        }
        // A tool refusal (non-zero exit WITH output) is a real answer — relay it.
        resolve(out || 'ok');
      },
    );
  });
}

export async function interceptDeterministicCommand(event: InboundEvent): Promise<boolean> {
  const config = loadConfig();
  if (!config) return false;
  if (event.platformId === config.owner) return false; // the owner's flow is untouched
  if (!config.allowed_senders.includes(event.platformId)) return false; // strangers: normal routing/approval flow

  const text = parseText(event.message.content);
  const parsed = parseCommand(text);
  if (!parsed) return false; // free text still routes to the agent (fallback parser)

  const spec = config.commands[parsed.cmd];
  if (!spec) {
    // Allowed sender, unknown/unliberated command: consume + refuse — commands
    // from non-owner senders may NEVER reach the agent.
    const names = Object.keys(config.commands)
      .map((c) => `/${c}`)
      .join(' ');
    await reply(event, `comando não disponível — os seus: ${names}`);
    log.info('deterministic-commands: refused unliberated command', { platformId: event.platformId, cmd: parsed.cmd });
    return true;
  }

  if ('reply' in spec) {
    await reply(event, spec.reply);
    log.info('deterministic-commands: static reply', { platformId: event.platformId, cmd: parsed.cmd });
    return true;
  }

  if (spec.arg_re) {
    const re = new RegExp(spec.arg_re);
    if (!re.test(parsed.arg)) {
      await reply(event, spec.usage ?? `uso: /${parsed.cmd} <argumento>`);
      log.info('deterministic-commands: bad/missing arg', { platformId: event.platformId, cmd: parsed.cmd });
      return true;
    }
  }

  const started = Date.now();
  const out = await runExec(spec, parsed.arg, event.platformId);
  await reply(event, out);
  log.info('deterministic-commands: executed', {
    platformId: event.platformId,
    cmd: parsed.cmd,
    ms: Date.now() - started,
  });
  return true;
}

registerMessageInterceptor(interceptDeterministicCommand);
log.info('deterministic-commands module registered', { config: CONFIG_PATH });
