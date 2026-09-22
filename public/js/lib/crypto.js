/**
 * 浏览器端 AES-256-GCM 加密（Web Crypto API）
 * 与服务端 node:crypto 完全兼容：IV(12B) + 密文 + Tag(16B)，Base64 编码
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function importKey(base64Key) {
  return crypto.subtle.importKey('raw', b64ToBytes(base64Key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(obj));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return bytesToB64(out);
}

export async function decrypt(key, b64) {
  const buf = b64ToBytes(b64);
  const iv = buf.slice(0, 12);
  const data = buf.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(dec.decode(plain));
}
