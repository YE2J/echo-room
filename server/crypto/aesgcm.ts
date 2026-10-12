// ABOUTME: AES-256-GCM 消息加解密：每次加密随机 IV，密文格式 base64(iv|tag|ciphertext)
import crypto from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'v1';

export interface EncryptedPayload {
  /** base64(iv[12] | authTag[16] | ciphertext) */
  data: string;
  alg: 'AES-256-GCM';
}

/**
 * 用 32 字节密钥加密任意明文（UTF-8）。
 * 每次调用生成随机 IV；GCM 认证标签附在密文前。
 */
export function encryptText(plaintext: string, key: Buffer): EncryptedPayload {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    data: [PREFIX, Buffer.concat([iv, tag, ciphertext]).toString('base64')].join('.'),
    alg: 'AES-256-GCM',
  };
}

/** 解密 encryptText 产生的载荷，认证失败会抛错。 */
export function decryptText(payload: EncryptedPayload, key: Buffer): string {
  if (payload.alg !== 'AES-256-GCM') throw new Error('unsupported encryption algorithm');
  const [prefix, body] = payload.data.split('.');
  if (prefix !== PREFIX || !body) throw new Error('malformed ciphertext');
  const raw = Buffer.from(body, 'base64');
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) throw new Error('ciphertext too short');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** 用主密钥加密封装的 JSON 记录（如身份映射）。 */
export function encryptJson(value: unknown, key: Buffer): string {
  return encryptText(JSON.stringify(value), key).data;
}

export function decryptJson<T>(data: string, key: Buffer): T {
  return JSON.parse(decryptText({ data, alg: 'AES-256-GCM' }, key)) as T;
}

/** 从 32 字节主密钥派生子密钥（用途隔离），如 HMAC key / 行加密 key。 */
export function deriveSubKey(masterKey: Buffer, purpose: string): Buffer {
  const derived = crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32);
  return Buffer.from(derived);
}
