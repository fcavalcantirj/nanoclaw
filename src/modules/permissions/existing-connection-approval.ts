/**
 * Ratify a pre-receipt direct-message wiring from a fresh inbound message.
 *
 * The sender's message continues to the already-connected agent. In parallel,
 * the owner gets one deduplicated card. Approval signs the existing wiring;
 * it never fabricates the historical approval, rewires the channel, or
 * replays the nurse's message.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import type { InboundEvent } from '../../channels/adapter.js';
import { normalizeOptions } from '../../channels/ask-question.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup, getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { onStartup, registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { inboundDbPath, refreshApprovedConnectionsForApprover } from '../../session-manager.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import { createSignedConnectionReceipt } from './connection-receipt.js';
import {
  createChannelConnectionReceipt,
  getChannelConnectionReceiptByWiring,
} from './db/channel-connection-receipts.js';
import {
  createPendingConnectionReceiptApproval,
  deletePendingConnectionReceiptApproval,
  getPendingConnectionReceiptApproval,
  hasPendingConnectionReceiptApproval,
  recordConnectionReceiptRejection,
  wasConnectionReceiptMessageRejected,
} from './db/pending-connection-receipt-approvals.js';
import { getOwners, hasAdminPrivilege } from './db/user-roles.js';

export const APPROVE_CONNECTION_RECEIPT = 'approve_connection_receipt';
export const REJECT_CONNECTION_RECEIPT = 'reject_connection_receipt';

function namespacedPlatformId(channelType: string, platformId: string): string {
  return platformId.includes(':') ? platformId : `${channelType}:${platformId}`;
}

function identityFromEvent(event: InboundEvent): { userId: string; displayName: string } | null {
  try {
    const content = JSON.parse(event.message.content) as Record<string, unknown>;
    const author =
      typeof content.author === 'object' && content.author !== null
        ? (content.author as Record<string, unknown>)
        : undefined;
    const rawUserId =
      (typeof content.senderId === 'string' ? content.senderId : undefined) ??
      (typeof content.sender === 'string' ? content.sender : undefined) ??
      (typeof author?.userId === 'string' ? author.userId : undefined);
    const displayName =
      (typeof content.senderName === 'string' ? content.senderName : undefined) ??
      (typeof author?.fullName === 'string' ? author.fullName : undefined) ??
      (typeof author?.userName === 'string' ? author.userName : undefined);
    if (!rawUserId || !displayName?.trim()) return null;
    return {
      userId: rawUserId.includes(':') ? rawUserId : `${event.channelType}:${rawUserId}`,
      displayName: displayName.trim(),
    };
  } catch {
    return null;
  }
}

export interface ExistingConnectionApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderUserId: string;
  event: InboundEvent;
}

export async function requestExistingConnectionApproval(input: ExistingConnectionApprovalInput): Promise<boolean> {
  const keyPath = process.env.NANOCLAW_CONNECTION_RECEIPT_PRIVATE_KEY_PATH?.trim();
  const keyId = process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID?.trim();
  if (!keyPath && !keyId) return false;
  if (!keyPath || !keyId) {
    log.error('Existing connection receipt skipped — signing configuration is incomplete');
    return false;
  }

  const mg = getMessagingGroup(input.messagingGroupId);
  if (!mg || mg.is_group !== 0 || input.event.threadId !== null || input.event.message.isGroup === true) return false;
  if (hasAdminPrivilege(input.senderUserId, input.agentGroupId)) return false;

  const eventIdentity = identityFromEvent(input.event);
  const platformIdentity = namespacedPlatformId(mg.channel_type, mg.platform_id);
  if (!eventIdentity || eventIdentity.userId !== input.senderUserId || eventIdentity.userId !== platformIdentity) {
    log.warn('Existing connection receipt skipped — DM identity mismatch', {
      messagingGroupId: mg.id,
      agentGroupId: input.agentGroupId,
    });
    return false;
  }

  const wiring = getMessagingGroupAgentByPair(mg.id, input.agentGroupId);
  if (
    !wiring ||
    getChannelConnectionReceiptByWiring(wiring.id) ||
    hasPendingConnectionReceiptApproval(wiring.id) ||
    wasConnectionReceiptMessageRejected(wiring.id, input.event.message.id)
  ) {
    return false;
  }

  const agentGroup = getAgentGroup(input.agentGroupId);
  if (!agentGroup) return false;
  // Roster receipts are owner attestations. Deliver to one persisted owner,
  // never to a scoped admin whose signature the diary verifier must reject.
  const approvers = getOwners().map((owner) => owner.user_id);
  const delivery = await pickApprovalDelivery(approvers, mg.channel_type);
  if (!delivery) {
    log.warn('Existing connection receipt skipped — no reachable approver', {
      messagingGroupId: mg.id,
      agentGroupId: input.agentGroupId,
    });
    return false;
  }

  const questionId = `connection-receipt:${wiring.id}`;
  const title = '🔐 Aprovar identidade conectada';
  const question = `${eventIdentity.displayName} acabou de falar com ${agentGroup.name}. A conexão é anterior ao comprovante de identidade. Aprovar este Telegram para cadastro de plantão?`;
  const options = normalizeOptions([
    {
      label: `Aprovar ${eventIdentity.displayName}`,
      selectedLabel: `✅ ${eventIdentity.displayName} aprovada para cadastro`,
      value: APPROVE_CONNECTION_RECEIPT,
      style: 'primary',
    },
    {
      label: 'Não aprovar',
      selectedLabel: 'Identidade não aprovada',
      value: REJECT_CONNECTION_RECEIPT,
      style: 'danger',
    },
  ]);

  const created = createPendingConnectionReceiptApproval({
    question_id: questionId,
    wiring_id: wiring.id,
    messaging_group_id: mg.id,
    agent_group_id: input.agentGroupId,
    sender_user_id: eventIdentity.userId,
    sender_display_name: eventIdentity.displayName,
    original_message: JSON.stringify(input.event),
    approver_user_id: delivery.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });
  if (!created) return false;

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    deletePendingConnectionReceiptApproval(questionId);
    log.error('Existing connection approval has no delivery adapter', { questionId });
    return false;
  }

  try {
    await adapter.deliver(
      delivery.messagingGroup.channel_type,
      delivery.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ type: 'ask_question', questionId, title, question, options }),
    );
    log.info('Existing connection approval card delivered', {
      questionId,
      messagingGroupId: mg.id,
      agentGroupId: input.agentGroupId,
    });
    return true;
  } catch (err) {
    // A failed delivery must not permanently suppress the next fresh DM.
    deletePendingConnectionReceiptApproval(questionId);
    log.error('Existing connection approval card delivery failed', { questionId, err });
    return false;
  }
}

async function handleExistingConnectionApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingConnectionReceiptApproval(payload.questionId);
  if (!row) return false;

  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  if (!clickerId || clickerId !== row.approver_user_id) {
    log.warn('Existing connection approval click rejected — unauthorized clicker', {
      questionId: row.question_id,
    });
    return true;
  }

  if (payload.value === REJECT_CONNECTION_RECEIPT) {
    let messageId: string;
    try {
      messageId = (JSON.parse(row.original_message) as InboundEvent).message.id;
    } catch (err) {
      throw new Error(`Stored connection approval event is invalid: ${row.question_id}`, { cause: err });
    }
    getDb().transaction(() => {
      recordConnectionReceiptRejection(row.wiring_id, messageId, clickerId, new Date().toISOString());
      deletePendingConnectionReceiptApproval(row.question_id);
    })();
    log.info('Existing connection identity not approved', {
      questionId: row.question_id,
      agentGroupId: row.agent_group_id,
    });
    return true;
  }
  if (payload.value !== APPROVE_CONNECTION_RECEIPT) {
    log.warn('Existing connection approval received unknown value', {
      questionId: row.question_id,
      value: payload.value,
    });
    return true;
  }

  const existing = getChannelConnectionReceiptByWiring(row.wiring_id);
  if (existing) {
    deletePendingConnectionReceiptApproval(row.question_id);
    return true;
  }

  const wiring = getMessagingGroupAgentByPair(row.messaging_group_id, row.agent_group_id);
  const mg = getMessagingGroup(row.messaging_group_id);
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    throw new Error(`Stored connection approval event is invalid: ${row.question_id}`, { cause: err });
  }
  const eventIdentity = identityFromEvent(event);
  if (
    !wiring ||
    wiring.id !== row.wiring_id ||
    !mg ||
    mg.is_group !== 0 ||
    !eventIdentity ||
    eventIdentity.userId !== row.sender_user_id ||
    eventIdentity.displayName !== row.sender_display_name ||
    eventIdentity.userId !== namespacedPlatformId(mg.channel_type, mg.platform_id)
  ) {
    throw new Error(`Connection approval identity changed before commit: ${row.question_id}`);
  }

  const approvedAt = new Date().toISOString();
  const signed = createSignedConnectionReceipt({
    receipt_id: `conn:${wiring.id}`,
    wiring_id: wiring.id,
    messaging_group_id: mg.id,
    agent_group_id: row.agent_group_id,
    channel_type: mg.channel_type,
    instance: mg.instance ?? mg.channel_type,
    platform_id: namespacedPlatformId(mg.channel_type, mg.platform_id),
    sender_user_id: row.sender_user_id,
    sender_display_name: row.sender_display_name,
    approver_user_id: clickerId,
    approved_at: approvedAt,
  });
  if (!signed) {
    throw new Error('Connection receipt signing is not configured for legacy connection ratification');
  }

  getDb().transaction(() => {
    createChannelConnectionReceipt({ ...signed, created_at: approvedAt });
    deletePendingConnectionReceiptApproval(row.question_id);
  })();

  try {
    const refreshedSessions = refreshApprovedConnectionsForApprover(row.agent_group_id, clickerId);
    log.info('Existing connection receipt approved and projected', {
      receiptId: signed.receipt_id,
      agentGroupId: row.agent_group_id,
      refreshedSessions,
    });
  } catch (err) {
    log.error('Existing connection receipt projection failed after durable commit', {
      receiptId: signed.receipt_id,
      agentGroupId: row.agent_group_id,
      err,
    });
  }
  return true;
}

registerResponseHandler(handleExistingConnectionApprovalResponse);

interface RecoveryCandidate {
  wiring_id: string;
  messaging_group_id: string;
  agent_group_id: string;
  channel_type: string;
  platform_id: string;
  instance: string;
}

/**
 * Recover messages that arrived after receipts were deployed but before the
 * legacy-wiring gate existed. The migration timestamps create an exact,
 * one-time cutover window; old historical chats are never swept into cards.
 */
export async function reconcileExistingConnectionApprovals(): Promise<void> {
  const bounds = getDb()
    .prepare(
      `SELECT
         (SELECT applied FROM schema_version WHERE name = 'channel-connection-receipts') AS start_at,
         (SELECT applied FROM schema_version WHERE name = 'pending-connection-receipt-approvals') AS end_at`,
    )
    .get() as { start_at: string | null; end_at: string | null };
  if (!bounds.start_at || !bounds.end_at) return;

  const candidates = getDb()
    .prepare(
      `SELECT mga.id AS wiring_id, mga.messaging_group_id, mga.agent_group_id,
              mg.channel_type, mg.platform_id, mg.instance
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    LEFT JOIN channel_connection_receipts receipt ON receipt.wiring_id = mga.id
    LEFT JOIN pending_connection_receipt_approvals pending ON pending.wiring_id = mga.id
        WHERE mg.is_group = 0 AND receipt.wiring_id IS NULL AND pending.wiring_id IS NULL`,
    )
    .all() as RecoveryCandidate[];

  let recovered = 0;
  for (const candidate of candidates) {
    const senderUserId = namespacedPlatformId(candidate.channel_type, candidate.platform_id);
    if (hasAdminPrivilege(senderUserId, candidate.agent_group_id)) continue;
    const sessions = getDb()
      .prepare(
        `SELECT id FROM sessions
          WHERE agent_group_id = ? AND messaging_group_id = ?
          ORDER BY COALESCE(last_active, created_at) DESC`,
      )
      .all(candidate.agent_group_id, candidate.messaging_group_id) as Array<{ id: string }>;

    let recoveredEvent: InboundEvent | null = null;
    for (const session of sessions) {
      const dbPath = inboundDbPath(candidate.agent_group_id, session.id);
      if (!fs.existsSync(dbPath)) continue;
      let inbound: Database.Database | null = null;
      try {
        inbound = new Database(dbPath, { readonly: true, fileMustExist: true });
        const message = inbound
          .prepare(
            `SELECT id, kind, timestamp, content, platform_id, channel_type, thread_id
               FROM messages_in
              WHERE channel_type = ? AND platform_id = ?
                AND timestamp >= ? AND timestamp <= ?
              ORDER BY seq DESC LIMIT 1`,
          )
          .get(candidate.channel_type, candidate.platform_id, bounds.start_at, bounds.end_at) as
          | {
              id: string;
              kind: InboundEvent['message']['kind'];
              timestamp: string;
              content: string;
              platform_id: string;
              channel_type: string;
              thread_id: string | null;
            }
          | undefined;
        if (message) {
          recoveredEvent = {
            channelType: message.channel_type,
            instance: candidate.instance,
            platformId: message.platform_id,
            threadId: message.thread_id,
            message: {
              id: message.id,
              kind: message.kind,
              timestamp: message.timestamp,
              content: message.content,
              isMention: true,
              isGroup: false,
            },
          };
          break;
        }
      } catch (err) {
        log.error('Existing connection cutover recovery could not read session', {
          agentGroupId: candidate.agent_group_id,
          err,
        });
      } finally {
        inbound?.close();
      }
    }
    if (!recoveredEvent) continue;

    const delivered = await requestExistingConnectionApproval({
      messagingGroupId: candidate.messaging_group_id,
      agentGroupId: candidate.agent_group_id,
      senderUserId,
      event: recoveredEvent,
    });
    if (delivered) recovered++;
  }
  if (recovered > 0) log.info('Existing connection cutover recovery completed', { recovered });
}

onStartup(reconcileExistingConnectionApprovals);
