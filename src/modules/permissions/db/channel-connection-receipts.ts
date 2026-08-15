import { getDb } from '../../../db/connection.js';
import type { SignedConnectionReceipt } from '../connection-receipt.js';

export interface ChannelConnectionReceipt extends SignedConnectionReceipt {
  created_at: string;
}

export function createChannelConnectionReceipt(receipt: ChannelConnectionReceipt): void {
  getDb()
    .prepare(
      `INSERT INTO channel_connection_receipts (
         receipt_id, wiring_id, messaging_group_id, agent_group_id,
         approver_user_id, sender_user_id, sender_display_name,
         channel_type, instance, platform_id, approved_at,
         key_id, payload_b64, signature_b64, created_at
       ) VALUES (
         @receipt_id, @wiring_id, @messaging_group_id, @agent_group_id,
         @approver_user_id, @sender_user_id, @sender_display_name,
         @channel_type, @instance, @platform_id, @approved_at,
         @key_id, @payload_b64, @signature_b64, @created_at
       )`,
    )
    .run(receipt);
}

export function getChannelConnectionReceiptByWiring(wiringId: string): ChannelConnectionReceipt | undefined {
  return getDb().prepare('SELECT * FROM channel_connection_receipts WHERE wiring_id = ?').get(wiringId) as
    | ChannelConnectionReceipt
    | undefined;
}

export function listChannelConnectionReceiptsForApprover(
  approverUserId: string,
  agentGroupId: string,
): ChannelConnectionReceipt[] {
  return getDb()
    .prepare(
      `SELECT * FROM channel_connection_receipts
        WHERE approver_user_id = ? AND agent_group_id = ?
        ORDER BY approved_at DESC, receipt_id ASC`,
    )
    .all(approverUserId, agentGroupId) as ChannelConnectionReceipt[];
}
