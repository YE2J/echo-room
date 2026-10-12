// ABOUTME: Shamir 密钥分割（GF(2^8), 多项式 0x11B 本原多项式）。
// 将主密钥拆为 N 份分片，任意 K 份可恢复；少于 K 份在信息论意义上零信息。
//
// 分片格式（base64url）：v1.<x>.<hexCoefficients>，x ∈ [1,255]。

export interface Share {
  x: number;
  /** 长度等于秘密字节数；y_i = f(x_i)，每个字节独立在 GF(256) 上求值 */
  y: Buffer;
}

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

// 以 3 为生成元构造 GF(256) 指数/对数表
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x ^= (x << 1) ^ ((x & 0x80) !== 0 ? 0x11b : 0);
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

function evalPoly(coeffs: Uint8Array, at: number): number {
  // Horner: c0 + c1*x + ... （coeffs[0] 是常数项 = 秘密字节）
  let result = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = coeffs[i] ^ gfMul(result, at);
  }
  return result;
}

export function splitSecret(secret: Buffer, thresholdK: number, totalN: number): Share[] {
  if (!(thresholdK >= 2 && totalN >= thresholdK && totalN <= 255)) {
    throw new Error('require 2 <= K <= N <= 255');
  }
  if (secret.length === 0) throw new Error('secret must not be empty');

  const shares: Share[] = [];
  const yPerShare: Uint8Array[] = Array.from({ length: totalN }, () => new Uint8Array(secret.length));

  for (let byteIndex = 0; byteIndex < secret.length; byteIndex++) {
    const coeffs = new Uint8Array(thresholdK);
    coeffs[0] = secret[byteIndex];
    // 用 CSPRNG 填充 k-1 个高阶系数
    const random = new Uint8Array(thresholdK - 1);
    globalThis.crypto.getRandomValues(random);
    coeffs.set(random, 1);

    for (let n = 0; n < totalN; n++) {
      yPerShare[n][byteIndex] = evalPoly(coeffs, n + 1);
    }
  }

  for (let n = 0; n < totalN; n++) {
    shares.push({ x: n + 1, y: Buffer.from(yPerShare[n]) });
  }
  return shares;
}

export function combineShares(shares: Share[]): Buffer {
  if (shares.length === 0) throw new Error('at least one share required');
  const xs = new Set(shares.map((s) => s.x));
  if (xs.size !== shares.length) throw new Error('duplicate share indices');
  const len = shares[0].y.length;
  if (shares.some((s) => s.y.length !== len || s.x < 1 || s.x > 255)) {
    throw new Error('inconsistent or invalid shares');
  }

  const secret = Buffer.alloc(len);
  for (let byteIndex = 0; byteIndex < len; byteIndex++) {
    let value = 0;
    // 拉格朗日插值求 f(0)
    for (let i = 0; i < shares.length; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gfMul(num, shares[j].x);
        den = gfMul(den, shares[i].x ^ shares[j].x);
      }
      const lagrange = gfDiv(num, den);
      value ^= gfMul(shares[i].y[byteIndex], lagrange);
    }
    secret[byteIndex] = value;
  }
  return secret;
}

export function encodeShare(share: Share): string {
  const yHex = share.y.toString('hex');
  return `v1.${share.x}.${yHex}`;
}

export function decodeShare(text: string): Share {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('invalid share format');
  const x = Number(parts[1]);
  if (!Number.isInteger(x) || x < 1 || x > 255) throw new Error('invalid share index');
  const y = Buffer.from(parts[2], 'hex');
  if (y.length === 0) throw new Error('invalid share body');
  return { x, y };
}
