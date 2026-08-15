import type { Migration } from './index.js';

/**
 * Durable proof that a named messaging identity was admitted to an agent by
 * a specific approver. The signed payload is later projected read-only into
 * the approver's session and verified by the diary API before onboarding.
 *
 * Receipts are deliberately append-only. A corrected identity must be a new
 * approval/receipt; rebinding historical proof would defeat the audit trail.
 */
export const migration019: Migration = {
  version: 19,
  name: 'channel-connection-receipts',
  up(db) {
    db.exec(`
      CREATE TABLE channel_connection_receipts (
        receipt_id          TEXT PRIMARY KEY,
        wiring_id           TEXT NOT NULL UNIQUE REFERENCES messaging_group_agents(id),
        messaging_group_id  TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id),
        approver_user_id    TEXT NOT NULL REFERENCES users(id),
        sender_user_id      TEXT NOT NULL REFERENCES users(id),
        sender_display_name TEXT NOT NULL,
        channel_type        TEXT NOT NULL,
        instance            TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        approved_at         TEXT NOT NULL,
        key_id              TEXT NOT NULL,
        payload_b64         TEXT NOT NULL,
        signature_b64       TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX idx_channel_connection_receipts_owner_agent
        ON channel_connection_receipts(approver_user_id, agent_group_id, approved_at);

      CREATE TRIGGER channel_connection_receipts_no_update
      BEFORE UPDATE ON channel_connection_receipts
      BEGIN
        SELECT RAISE(ABORT, 'channel connection receipts are append-only');
      END;

      CREATE TRIGGER channel_connection_receipts_no_delete
      BEFORE DELETE ON channel_connection_receipts
      BEGIN
        SELECT RAISE(ABORT, 'channel connection receipts are append-only');
      END;
    `);
  },
};
