import type { Migration } from './index.js';

/**
 * Owner ratification for direct-message wirings created before signed
 * connection receipts existed. A fresh inbound DM creates one pending row;
 * approval signs the existing wiring without rewriting its history.
 */
export const migration020: Migration = {
  version: 20,
  name: 'pending-connection-receipt-approvals',
  up(db) {
    db.exec(`
      CREATE TABLE pending_connection_receipt_approvals (
        question_id        TEXT PRIMARY KEY,
        wiring_id          TEXT NOT NULL UNIQUE REFERENCES messaging_group_agents(id) ON DELETE CASCADE,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        sender_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_display_name TEXT NOT NULL,
        original_message   TEXT NOT NULL,
        approver_user_id   TEXT NOT NULL REFERENCES users(id),
        created_at         TEXT NOT NULL,
        title              TEXT NOT NULL,
        options_json       TEXT NOT NULL
      );

      CREATE TABLE connection_receipt_rejections (
        wiring_id          TEXT NOT NULL REFERENCES messaging_group_agents(id) ON DELETE CASCADE,
        message_id         TEXT NOT NULL,
        rejected_by        TEXT NOT NULL REFERENCES users(id),
        rejected_at        TEXT NOT NULL,
        PRIMARY KEY (wiring_id, message_id)
      );
    `);
  },
};
