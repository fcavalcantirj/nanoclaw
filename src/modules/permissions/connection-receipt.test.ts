import { generateKeyPairSync, verify } from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSignedConnectionReceipt } from './connection-receipt.js';

const TEST_DIR = '/tmp/nanoclaw-connection-receipt-test';

afterEach(() => {
  delete process.env.NANOCLAW_CONNECTION_RECEIPT_PRIVATE_KEY_PATH;
  delete process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('createSignedConnectionReceipt', () => {
  it('signs the exact payload bytes with Ed25519 and returns base64url fields', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyPath = path.join(TEST_DIR, 'private.pem');
    fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    process.env.NANOCLAW_CONNECTION_RECEIPT_PRIVATE_KEY_PATH = keyPath;
    process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID = 'key-2026-08';

    const receipt = createSignedConnectionReceipt({
      receipt_id: 'conn:mga-1',
      wiring_id: 'mga-1',
      messaging_group_id: 'mg-medusa',
      agent_group_id: 'claudius',
      channel_type: 'telegram',
      instance: 'telegram-main',
      platform_id: 'secret-chat-id',
      sender_user_id: 'telegram:secret-chat-id',
      sender_display_name: 'Medusa',
      approver_user_id: 'telegram:felipe',
      approved_at: '2026-08-15T18:08:37.000Z',
    });

    expect(receipt).not.toBeNull();
    const payloadBytes = Buffer.from(receipt!.payload_b64, 'base64url');
    const signature = Buffer.from(receipt!.signature_b64, 'base64url');
    expect(verify(null, payloadBytes, publicKey, signature)).toBe(true);
    expect(JSON.parse(payloadBytes.toString('utf8'))).toEqual({
      v: 1,
      receipt_id: 'conn:mga-1',
      key_id: 'key-2026-08',
      wiring_id: 'mga-1',
      messaging_group_id: 'mg-medusa',
      agent_group_id: 'claudius',
      channel_type: 'telegram',
      instance: 'telegram-main',
      platform_id: 'secret-chat-id',
      sender_user_id: 'telegram:secret-chat-id',
      sender_display_name: 'Medusa',
      approver_user_id: 'telegram:felipe',
      approved_at: '2026-08-15T18:08:37.000Z',
    });
  });

  it('returns null only when both signing settings are absent and rejects partial configuration', () => {
    expect(createSignedConnectionReceipt({} as never)).toBeNull();
    process.env.NANOCLAW_CONNECTION_RECEIPT_KEY_ID = 'partial';
    expect(() => createSignedConnectionReceipt({} as never)).toThrow(/incomplete/i);
  });
});
