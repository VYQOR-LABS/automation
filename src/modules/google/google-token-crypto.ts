import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../config.js';

const NONCE_LENGTH = 12;

function getEncryptionKey(encryptionKey: string) {
  const key = Buffer.from(encryptionKey, 'base64');
  if (!encryptionKey || key.length !== 32) {
    throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

export function assertGoogleTokenEncryptionKey(encryptionKey: string) {
  getEncryptionKey(encryptionKey);
}

export function encryptGoogleToken(
  token: string,
  encryptionKey = config.googleTokenEncryptionKey,
) {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(encryptionKey), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptGoogleToken(
  value: string,
  encryptionKey = config.googleTokenEncryptionKey,
) {
  const [version, noncePart, tagPart, ciphertextPart, ...extra] = value.split('.');
  if (
    version !== 'v1' ||
    !noncePart ||
    !tagPart ||
    !ciphertextPart ||
    extra.length > 0
  ) {
    throw new Error('Stored Google token has an unsupported encrypted format.');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(encryptionKey),
    Buffer.from(noncePart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
