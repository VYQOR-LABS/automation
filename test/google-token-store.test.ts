import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptGoogleToken,
  encryptGoogleToken,
} from '../src/modules/google/google-token-crypto.js';
import { EncryptedGoogleTokenStore } from '../src/modules/google/google-token-store.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

test('Google token encryption round-trips tokens without storing plaintext', () => {
  const token = 'sensitive-google-token';
  const encrypted = encryptGoogleToken(token, encryptionKey);

  assert.notEqual(encrypted, token);
  assert.match(encrypted, /^v1\./);
  assert.equal(decryptGoogleToken(encrypted, encryptionKey), token);
});

test('Google token decryption rejects tampered ciphertext', () => {
  const encrypted = encryptGoogleToken('sensitive-google-token', encryptionKey);
  const parts = encrypted.split('.');
  const tag = parts[2]!;
  parts[2] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;

  assert.throws(() => decryptGoogleToken(parts.join('.'), encryptionKey));
});

test('encrypted Google token store is the shared-account store implementation', () => {
  assert.equal(typeof EncryptedGoogleTokenStore, 'function');
  assert.equal(typeof new EncryptedGoogleTokenStore().getSharedCredentials, 'function');
});
