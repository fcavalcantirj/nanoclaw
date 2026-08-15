import { getDb } from '../../../db/connection.js';

export interface PendingConnectionReceiptApproval {
  question_id: string;
  wiring_id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_user_id: string;
  sender_display_name: string;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  title: string;
  options_json: string;
}

export function createPendingConnectionReceiptApproval(row: PendingConnectionReceiptApproval): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_connection_receipt_approvals (
         question_id, wiring_id, messaging_group_id, agent_group_id,
         sender_user_id, sender_display_name, original_message,
         approver_user_id, created_at, title, options_json
       ) VALUES (
         @question_id, @wiring_id, @messaging_group_id, @agent_group_id,
         @sender_user_id, @sender_display_name, @original_message,
         @approver_user_id, @created_at, @title, @options_json
       )`,
    )
    .run(row);
  return result.changes === 1;
}

export function getPendingConnectionReceiptApproval(questionId: string): PendingConnectionReceiptApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_connection_receipt_approvals WHERE question_id = ?').get(questionId) as
    | PendingConnectionReceiptApproval
    | undefined;
}

export function hasPendingConnectionReceiptApproval(wiringId: string): boolean {
  return Boolean(
    getDb().prepare('SELECT 1 FROM pending_connection_receipt_approvals WHERE wiring_id = ?').get(wiringId),
  );
}

export function deletePendingConnectionReceiptApproval(questionId: string): void {
  getDb().prepare('DELETE FROM pending_connection_receipt_approvals WHERE question_id = ?').run(questionId);
}

export function recordConnectionReceiptRejection(
  wiringId: string,
  messageId: string,
  rejectedBy: string,
  rejectedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO connection_receipt_rejections
         (wiring_id, message_id, rejected_by, rejected_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(wiringId, messageId, rejectedBy, rejectedAt);
}

export function wasConnectionReceiptMessageRejected(wiringId: string, messageId: string): boolean {
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM connection_receipt_rejections WHERE wiring_id = ? AND message_id = ?')
      .get(wiringId, messageId),
  );
}
