// ABOUTME: 轻量 HS256 JWT 签发/校验（node:crypto 实现，无第三方依赖）
import crypto from 'node:crypto';

export interface TokenPayload {
  sub: string; // user id (UUID)
  username: string;
  role: 'admin' | 'user';
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(
  payload: Omit<TokenPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const full: TokenPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = base64url(JSON.stringify(header));
  const body = base64url(JSON.stringify(full));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('invalid token signature');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired');
  }
  return payload;
}
