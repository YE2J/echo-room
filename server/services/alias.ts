// ABOUTME: 匿名昵称生成（中性、无规律、不携带用户信息）与确定性头像配色。
// 昵称形如「沉默的雪豹-7F3A」，仅用于公开侧身份；与真实用户的关联保存在加密保险库。
import crypto from 'node:crypto';

const PREFIXES = [
  '沉默的', '夜行的', '匿名的', '无名的', '旁听的', '路过的', '隐于市的', '戴面具的',
  '写信的', '低语的', '未署名的', '远处的', '隔窗的', '灯下的', '雾中的', '静听的',
];

const ANIMALS = [
  '雪豹', '灰鹤', '白鲸', '林枭', '岩羊', '水獭', '夜鹭', '云雀', '松貂', '赤狐',
  '雨燕', '斑鸠', '苔原鹿', '冷杉', '鹅卵石', '纸鸢', '信天翁', '山谷风', '旧灯塔', '长桌',
];

export function generateAlias(): string {
  const prefix = PREFIXES[crypto.randomInt(PREFIXES.length)];
  const animal = ANIMALS[crypto.randomInt(ANIMALS.length)];
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}${animal}-${suffix}`;
}

/** 由昵称确定性派生柔和的 HSL 头像色与几何图形种子（相同昵称始终同色）。 */
export function aliasVisual(alias: string): { hue: number; shape: number } {
  const hash = crypto.createHash('sha256').update(alias).digest();
  const hue = hash[0] * 360 / 256;
  const shape = hash[1] % 6;
  return { hue: Math.round(hue), shape };
}
