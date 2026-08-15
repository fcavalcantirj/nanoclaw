/**
 * Integration tests for the unknown-channel registration flow (ACTION-ITEMS
 * item 22).
 *
 * Covers:
 *  - Mention on an unwired channel fires an owner-approval card
 *  - DM on an unwired channel fires a card (engage_mode will default to pattern='.')
 *  - In-flight dedup: second mention while a card is pending doesn't spam
 *  - Approve: wiring created with correct defaults, triggering sender added
 *    as member, replay wakes the container
 *  - Deny: messaging_groups.denied_at set, future mentions drop silently
 *  - Unauthorized clicker is rejected (same pattern as sender-approval)
 *  - No-owner install: no card, no row
 *  - No agent groups configured: no card, no row
 */
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

// Mock ensureUserDm — look up the owner's preconfigured DM row instead of
// hitting a real openDM RPC.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    const row = getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
    return row;
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-channel-approval' };
});

const TEST_DIR = '/tmp/nanoclaw-test-channel-approval';
const RECEIPT_KEY_PATH = `${TEST_DIR}/connection-receipt-private.pem`;

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(RECEIPT_KEY_PATH, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  process.env.NANOCLAW_CONNECTION_RECEIPT_PRIVATE_KEY_PATH = RECEIPT_KEY_PATH;
  process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID = 'test-key-1';
  const db = initTestDb();
  runMigrations(db);

  await import('./index.js'); // register hooks

  // Base fixtures: one agent group + owner with a DM on 'telegram'.
  createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  // Pre-seed owner's DM messaging group + user_dms mapping.
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.NANOCLAW_CONNECTION_RECEIPT_PRIVATE_KEY_PATH;
  delete process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function groupMention(platformId: string, text = '@bot hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: 'thread-1', // non-null → is_group=true per channel-approval default-picker logic
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text }),
      timestamp: now(),
      isMention: true,
    },
  };
}

function dmEvent(platformId: string, text = 'hello', senderId = 'stranger', senderName = 'Stranger') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId, senderName, text }),
      timestamp: now(),
      isMention: true, // DM bridge sets isMention=true
    },
  };
}

function seedLegacyConnectedDm() {
  upsertUser({ id: 'telegram:medusa', kind: 'telegram', display_name: 'Medusa', created_at: now() });
  createMessagingGroup({
    id: 'mg-medusa',
    channel_type: 'telegram',
    platform_id: 'telegram:medusa',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-medusa-legacy',
    messaging_group_id: 'mg-medusa',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  getDb()
    .prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:medusa', 'ag-1', 'telegram:owner', now());
}

describe('legacy connected DM receipt ratification', () => {
  it('sends one owner card on a fresh DM when the existing wiring has no receipt', async () => {
    seedLegacyConnectedDm();
    const { routeInbound } = await import('../../router.js');
    const { getDb } = await import('../../db/connection.js');

    await routeInbound(dmEvent('telegram:medusa', 'oi', 'medusa', 'Medusa'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const card = JSON.parse(deliverMock.mock.calls[0][4] as string) as {
      questionId: string;
      question: string;
      options: Array<{ value: string }>;
    };
    expect(card.question).toContain('Medusa');
    expect(card.question).toContain('Andy');
    expect(card.options.map((option) => option.value)).toEqual([
      'approve_connection_receipt',
      'reject_connection_receipt',
    ]);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM pending_connection_receipt_approvals').get()).toEqual({ c: 1 });

    await routeInbound(dmEvent('telegram:medusa', 'de novo', 'medusa', 'Medusa'));
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('approves the old wiring atomically without rewiring or replaying the nurse message', async () => {
    seedLegacyConnectedDm();
    const { routeInbound } = await import('../../router.js');
    const { getDb } = await import('../../db/connection.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { openInboundDb, resolveSession } = await import('../../session-manager.js');
    const { wakeContainer } = await import('../../container-runner.js');
    const { session: ownerSession } = resolveSession('ag-1', 'mg-dm-owner', null, 'shared');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(dmEvent('telegram:medusa', 'oi', 'medusa', 'Medusa'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getDb().prepare('SELECT question_id FROM pending_connection_receipt_approvals').get() as {
      question_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.question_id,
        value: 'approve_connection_receipt',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    expect(
      getDb().prepare("SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = 'mg-medusa'").get(),
    ).toEqual({ c: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM pending_connection_receipt_approvals').get()).toEqual({ c: 0 });
    expect(getDb().prepare('SELECT wiring_id, sender_display_name FROM channel_connection_receipts').get()).toEqual({
      wiring_id: 'mga-medusa-legacy',
      sender_display_name: 'Medusa',
    });
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    const ownerInbound = openInboundDb('ag-1', ownerSession.id);
    try {
      expect(ownerInbound.prepare('SELECT sender_display_name FROM approved_connections').get()).toEqual({
        sender_display_name: 'Medusa',
      });
    } finally {
      ownerInbound.close();
    }
  });

  it('rejects only that message and does not deny or disconnect the existing DM', async () => {
    seedLegacyConnectedDm();
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const event = dmEvent('telegram:medusa', 'oi', 'medusa', 'Medusa');

    await routeInbound(event);
    await new Promise((r) => setTimeout(r, 10));
    const pending = getDb().prepare('SELECT question_id FROM pending_connection_receipt_approvals').get() as {
      question_id: string;
    };
    for (const handler of getResponseHandlers()) {
      if (
        await handler({
          questionId: pending.question_id,
          value: 'reject_connection_receipt',
          userId: 'owner',
          channelType: 'telegram',
          platformId: 'dm-owner',
          threadId: null,
        })
      )
        break;
    }

    expect(getDb().prepare('SELECT COUNT(*) AS c FROM channel_connection_receipts').get()).toEqual({ c: 0 });
    expect(getMessagingGroupByPlatform('telegram', 'telegram:medusa')?.denied_at).toBeFalsy();
    expect(
      getDb().prepare("SELECT COUNT(*) AS c FROM messaging_group_agents WHERE id = 'mga-medusa-legacy'").get(),
    ).toEqual({ c: 1 });

    deliverMock.mockClear();
    const { requestExistingConnectionApproval } = await import('./existing-connection-approval.js');
    await requestExistingConnectionApproval({
      messagingGroupId: 'mg-medusa',
      agentGroupId: 'ag-1',
      senderUserId: 'telegram:medusa',
      event,
    });
    expect(deliverMock).not.toHaveBeenCalled();

    await routeInbound(dmEvent('telegram:medusa', 'nova mensagem', 'medusa', 'Medusa'));
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the card pending when signing succeeds but receipt persistence fails', async () => {
    seedLegacyConnectedDm();
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    await routeInbound(dmEvent('telegram:medusa', 'oi', 'medusa', 'Medusa'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getDb().prepare('SELECT question_id FROM pending_connection_receipt_approvals').get() as {
      question_id: string;
    };
    getDb().exec(`
      CREATE TRIGGER fail_legacy_connection_receipt
      BEFORE INSERT ON channel_connection_receipts
      BEGIN
        SELECT RAISE(ABORT, 'forced legacy receipt failure');
      END;
    `);

    await expect(async () => {
      for (const handler of getResponseHandlers()) {
        if (
          await handler({
            questionId: pending.question_id,
            value: 'approve_connection_receipt',
            userId: 'owner',
            channelType: 'telegram',
            platformId: 'dm-owner',
            threadId: null,
          })
        )
          break;
      }
    }).rejects.toThrow('forced legacy receipt failure');

    expect(getDb().prepare('SELECT COUNT(*) AS c FROM pending_connection_receipt_approvals').get()).toEqual({ c: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM channel_connection_receipts').get()).toEqual({ c: 0 });
  });

  it('recovers the exact receipt-rollout gap on startup without another nurse message', async () => {
    seedLegacyConnectedDm();
    const { resolveSession, writeSessionMessage } = await import('../../session-manager.js');
    const { reconcileExistingConnectionApprovals } = await import('./existing-connection-approval.js');
    const { session } = resolveSession('ag-1', 'mg-medusa', null, 'shared');
    const timestamp = now();
    writeSessionMessage('ag-1', session.id, {
      id: 'msg-medusa-cutover-gap',
      kind: 'chat',
      timestamp,
      platformId: 'telegram:medusa',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ senderId: 'medusa', senderName: 'Medusa', text: 'oi' }),
    });
    getDb()
      .prepare("UPDATE schema_version SET applied = '2000-01-01T00:00:00.000Z' WHERE name = ?")
      .run('channel-connection-receipts');
    getDb()
      .prepare("UPDATE schema_version SET applied = '2999-01-01T00:00:00.000Z' WHERE name = ?")
      .run('pending-connection-receipt-approvals');

    deliverMock.mockClear();
    await reconcileExistingConnectionApprovals();

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { question: string };
    expect(payload.question).toContain('Medusa');
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM pending_connection_receipt_approvals').get()).toEqual({ c: 1 });
  });
});

describe('unknown-channel registration flow', () => {
  it('delivers an approval card on mention into an unwired group', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-new'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channel, platformId, thread, kind, content] = deliverMock.mock.calls[0];
    expect(channel).toBe('telegram');
    expect(platformId).toBe('dm-owner'); // delivered to owner's DM
    expect(thread).toBeNull();
    expect(kind).toBe('chat-sdk');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');
    // Single-agent card offers a direct "Connect to <name>" button.
    const connectOption = payload.options.find((o: { value: string }) => o.value.startsWith('connect:'));
    expect(connectOption).toBeDefined();
    expect(connectOption.label).toContain('Andy');

    const { getDb } = await import('../../db/connection.js');
    const rows = getDb().prepare('SELECT * FROM pending_channel_approvals').all() as Array<{
      messaging_group_id: string;
    }>;
    expect(rows).toHaveLength(1);
  });

  it('delivers a card on DM too (non-threaded event)', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dmEvent('dm-new-user'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('dedups a second mention while the card is pending', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-busy'));
    await new Promise((r) => setTimeout(r, 10));
    await routeInbound(groupMention('chat-busy', '@bot still here'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('approve → creates wiring, admits triggering sender, replays', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(groupMention('chat-approve'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    expect(pending).toBeDefined();

    // Owner clicks "Connect to Andy" (single-agent card).
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner', // raw platform id — handler namespaces it
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Wiring created with defaults.
    const mga = getDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as {
      engage_mode: string;
      engage_pattern: string | null;
      sender_scope: string;
      ignored_message_policy: string;
      agent_group_id: string;
    };
    expect(mga).toBeDefined();
    expect(mga.engage_mode).toBe('mention-sticky'); // group (threadId != null)
    expect(mga.engage_pattern).toBeNull();
    expect(mga.sender_scope).toBe('known');
    expect(mga.ignored_message_policy).toBe('accumulate');
    expect(mga.agent_group_id).toBe('ag-1');

    // Triggering sender auto-admitted so sender_scope='known' doesn't
    // bounce the replay into sender-approval.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('telegram:caller', 'ag-1');
    expect(member).toBeDefined();

    // Pending row cleared and container woken via replay.
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(0);
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('approve on a DM wires with pattern="." defaults', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(dmEvent('dm-approve-user'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const mga = getDb()
      .prepare('SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { engage_mode: string; engage_pattern: string };
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
  });

  it('approve on a DM atomically records a signed, append-only connection receipt', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { openInboundDb, resolveSession } = await import('../../session-manager.js');

    // The owner's Claudius session is already alive when the nurse sends the
    // first DM. The approval click must refresh this existing projection
    // immediately; waiting for another owner message/container wake loses the
    // deterministic one-minute onboarding handoff.
    const { session: ownerSession } = resolveSession('ag-1', 'mg-dm-owner', null, 'shared');
    const legacyOwnerInbound = openInboundDb('ag-1', ownerSession.id);
    try {
      legacyOwnerInbound.exec('DROP TABLE approved_connections');
    } finally {
      legacyOwnerInbound.close();
    }

    await routeInbound(dmEvent('5426364345', 'hello', '5426364345', 'Medusa'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const receipt = getDb().prepare('SELECT * FROM channel_connection_receipts').get() as Record<string, string>;
    expect(receipt.receipt_id).toMatch(/^conn:mga-/);
    expect(receipt.messaging_group_id).toBe(pending.messaging_group_id);
    expect(receipt.agent_group_id).toBe('ag-1');
    expect(receipt.approver_user_id).toBe('telegram:owner');
    expect(receipt.sender_user_id).toBe('telegram:5426364345');
    expect(receipt.sender_display_name).toBe('Medusa');
    expect(receipt.channel_type).toBe('telegram');
    expect(receipt.platform_id).toBe('telegram:5426364345');
    expect(receipt.key_id).toBe('test-key-1');
    expect(receipt.payload_b64).not.toContain('5426364345');
    expect(receipt.signature_b64.length).toBeGreaterThan(40);

    const ownerInbound = openInboundDb('ag-1', ownerSession.id);
    try {
      const projected = ownerInbound.prepare('SELECT * FROM approved_connections').get() as Record<string, string>;
      expect(projected).toMatchObject({
        receipt_id: receipt.receipt_id,
        agent_group_id: 'ag-1',
        approver_user_id: 'telegram:owner',
        sender_display_name: 'Medusa',
      });
    } finally {
      ownerInbound.close();
    }

    const signedPayload = JSON.parse(Buffer.from(receipt.payload_b64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(signedPayload).toMatchObject({
      v: 1,
      receipt_id: receipt.receipt_id,
      key_id: 'test-key-1',
      wiring_id: receipt.wiring_id,
      messaging_group_id: pending.messaging_group_id,
      agent_group_id: 'ag-1',
      channel_type: 'telegram',
      instance: 'telegram',
      platform_id: 'telegram:5426364345',
      sender_user_id: 'telegram:5426364345',
      sender_display_name: 'Medusa',
      approver_user_id: 'telegram:owner',
      approved_at: receipt.approved_at,
    });

    expect(() =>
      getDb().prepare('UPDATE channel_connection_receipts SET sender_display_name = ?').run('Rebound'),
    ).toThrow();
    expect(() => getDb().prepare('DELETE FROM channel_connection_receipts').run()).toThrow();
  });

  it('rolls back wiring, membership and pending deletion when receipt persistence fails', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(dmEvent('dm-atomic-failure'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    getDb().exec(`
      CREATE TRIGGER fail_connection_receipt
      BEFORE INSERT ON channel_connection_receipts
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt failure');
      END;
    `);

    await expect(async () => {
      for (const handler of getResponseHandlers()) {
        const claimed = await handler({
          questionId: pending.messaging_group_id,
          value: 'connect:ag-1',
          userId: 'owner',
          channelType: 'telegram',
          platformId: 'dm-owner',
          threadId: null,
        });
        if (claimed) break;
      }
    }).rejects.toThrow('forced receipt failure');

    expect(
      getDb()
        .prepare('SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id),
    ).toBeUndefined();
    expect(
      getDb().prepare('SELECT 1 FROM agent_group_members WHERE user_id = ?').get('telegram:stranger'),
    ).toBeUndefined();
    expect(
      getDb()
        .prepare('SELECT 1 FROM pending_channel_approvals WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id),
    ).toBeDefined();
    expect(getDb().prepare('SELECT 1 FROM channel_connection_receipts').get()).toBeUndefined();
  });

  it('deny → sets denied_at; future mentions drop silently without a second card', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-deny'));
    await new Promise((r) => setTimeout(r, 10));
    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'reject',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // denied_at set, pending row cleared, no wiring.
    const mg = getMessagingGroupByPlatform('telegram', 'chat-deny');
    expect(mg?.denied_at).not.toBeNull();
    expect(mg?.denied_at).toBeTruthy();
    const mgaCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id) as { c: number }
    ).c;
    expect(mgaCount).toBe(0);

    // A follow-up mention on the denied channel: no new card, no new pending row.
    deliverMock.mockClear();
    await routeInbound(groupMention('chat-deny', '@bot please'));
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverMock).not.toHaveBeenCalled();
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(0);
  });

  it('rejects clicks from an unauthorized user (prevents self-admit via forwarded card)', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-unauth'));
    await new Promise((r) => setTimeout(r, 10));
    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'approve',
        userId: 'random-bystander',
        channelType: 'telegram',
        platformId: 'dm-random',
        threadId: null,
      });
      if (claimed) break;
    }

    // No wiring created, pending row preserved so a real approver can act on it.
    const mgaCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id) as { c: number }
    ).c;
    expect(mgaCount).toBe(0);
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(1);
  });

  it('does not let a scoped admin connect an unknown channel to another agent group', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getDb } = await import('../../db/connection.js');

    createAgentGroup({ id: 'ag-2', name: 'Betty', folder: 'betty', agent_provider: null, created_at: now() });
    upsertUser({ id: 'telegram:scoped-admin', kind: 'telegram', display_name: 'Scoped Admin', created_at: now() });
    grantRole({
      user_id: 'telegram:scoped-admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    createMessagingGroup({
      id: 'mg-dm-scoped-admin',
      channel_type: 'telegram',
      platform_id: 'dm-scoped-admin',
      name: 'Scoped Admin DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    getDb()
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run('telegram:scoped-admin', 'telegram', 'mg-dm-scoped-admin', now());

    await routeInbound(groupMention('chat-scoped-cross-group'));
    await new Promise((r) => setTimeout(r, 10));

    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    expect(pending).toBeDefined();
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][1]).toBe('dm-scoped-admin');

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'choose_existing',
        userId: 'scoped-admin',
        channelType: 'telegram',
        platformId: 'dm-scoped-admin',
        threadId: null,
      });
      if (claimed) break;
    }

    const followupPayload = JSON.parse(deliverMock.mock.calls[1][4] as string) as {
      options: Array<{ label: string; value: string }>;
    };
    expect(followupPayload.options.map((option) => option.value)).toContain('connect:ag-1');
    expect(followupPayload.options.map((option) => option.value)).not.toContain('connect:ag-2');

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-2',
        userId: 'scoped-admin',
        channelType: 'telegram',
        platformId: 'dm-scoped-admin',
        threadId: null,
      });
      if (claimed) break;
    }

    const mgaCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id) as { c: number }
    ).c;
    expect(mgaCount).toBe(0);
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(1);
  });
});

describe('no-owner / no-agent failure modes', () => {
  it('no owner → no card, no pending row (fresh-install bootstrap path)', async () => {
    // Wipe the owner grant set up in the outer beforeEach.
    const { getDb } = await import('../../db/connection.js');
    getDb().prepare('DELETE FROM user_roles').run();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noowner'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('no agent groups → no card, no pending row', async () => {
    const { getDb } = await import('../../db/connection.js');
    // Drop foreign-key-dependent rows first, then the agent group itself.
    getDb().prepare('DELETE FROM user_roles').run();
    getDb().prepare('DELETE FROM agent_groups').run();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noagent'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
