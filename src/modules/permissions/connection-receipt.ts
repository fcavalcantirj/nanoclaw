import { createPrivateKey, sign } from 'crypto';
import fs from 'fs';

export interface ConnectionReceiptInput {
  receipt_id: string;
  wiring_id: string;
  messaging_group_id: string;
  agent_group_id: string;
  channel_type: string;
  instance: string;
  platform_id: string;
  sender_user_id: string;
  sender_display_name: string;
  approver_user_id: string;
  approved_at: string;
}

export interface SignedConnectionReceipt extends ConnectionReceiptInput {
  key_id: string;
  payload_b64: string;
  signature_b64: string;
}

/**
 * Sign exact JSON bytes. Consumers verify these bytes first and only then
 * parse them, so neither key ordering nor cross-language reserialization is
 * part of the trust boundary.
 *
 * Both settings absent keeps the generic NanoClaw flow compatible. A partial
 * setup is an operator error and fails closed before any wiring is committed.
 */
export function createSignedConnectionReceipt(input: ConnectionReceiptInput): SignedConnectionReceipt | null {
  const privateKeyPath = process.env.NANOCLAW_CONNECTION_RECEIPT_PRIVATE_KEY_PATH?.trim();
  const keyId = process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID?.trim();
  if (!privateKeyPath && !keyId) return null;
  if (!privateKeyPath || !keyId) {
    throw new Error('Connection receipt signing configuration is incomplete');
  }

  const payload = {
    v: 1,
    receipt_id: input.receipt_id,
    key_id: keyId,
    wiring_id: input.wiring_id,
    messaging_group_id: input.messaging_group_id,
    agent_group_id: input.agent_group_id,
    channel_type: input.channel_type,
    instance: input.instance,
    platform_id: input.platform_id,
    sender_user_id: input.sender_user_id,
    sender_display_name: input.sender_display_name,
    approver_user_id: input.approver_user_id,
    approved_at: input.approved_at,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const privateKey = createPrivateKey(fs.readFileSync(privateKeyPath));
  const signature = sign(null, payloadBytes, privateKey);

  return {
    ...input,
    key_id: keyId,
    payload_b64: payloadBytes.toString('base64url'),
    signature_b64: signature.toString('base64url'),
  };
}
