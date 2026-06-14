'use strict';

// Kampüs Giriş (campus entrance) QR helpers — JS mirror of the backend's
// Feature/KampusGirisQr/KampusGirisQrDataManager.cs.
//
// Format (see KampusGirisQrEntegrasyonRehberi.md):
//   QR text = IV(16 hex chars) + cipher(hex), all uppercase hexadecimal.
//   IV last 4 bytes = (now - 30s) UNIX timestamp, little-endian.
//   plainData is left-padded with '0' to 16 hex chars before encryption,
//   and leading zeros are trimmed after decryption.

const crypto = require('crypto');
const { ChaCha } = require('./chacha');

const ROUNDS = 20;

const hexToBytes = (hex) => {
  const out = Buffer.alloc(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

const bytesToHex = (buf) => Buffer.from(buf).toString('hex').toUpperCase();

// "0x..,0x..,..." (8 words) -> 32-byte key, big-endian per word.
const keyToBytes = (key) => {
  const words = key
    .replace(/[\r\n]/g, '')
    .split(',')
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s.replace('0x', ''), 16) >>> 0);
  const bkey = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) bkey.writeUInt32BE(words[i] >>> 0, i * 4);
  return bkey;
};

// Random 8-byte IV; last 4 bytes carry (now - 30s) UNIX time (little-endian).
const generateIv = (nowMs) => {
  const iv = crypto.randomBytes(8);
  const unixTime = Math.floor(((nowMs || Date.now()) - 30000) / 1000) >>> 0;
  iv.writeUInt32LE(unixTime, 4);
  return bytesToHex(iv);
};

const isHex = (s) => typeof s === 'string' && s.length > 0 && /^[0-9a-fA-F]+$/.test(s);

const generateQr = (key, plainData, nowMs) => {
  const iv = generateIv(nowMs);
  const ivBytes = hexToBytes(iv);
  const keyBytes = keyToBytes(key);

  const padded = String(plainData).padStart(16, '0');
  const plainBytes = hexToBytes(padded);

  const c = new ChaCha();
  c.setKeyAndInitializationVector(keyBytes, ivBytes);
  const cipher = c.encrypt(plainBytes, ROUNDS);

  return iv + bytesToHex(cipher);
};

const decryptQr = (key, qrText) => {
  const ivBytes = hexToBytes(qrText.substring(0, 16));
  const keyBytes = keyToBytes(key);
  const cipherBytes = hexToBytes(qrText.substring(16));

  const c = new ChaCha();
  c.setKeyAndInitializationVector(keyBytes, ivBytes);
  const dec = c.decrypt(cipherBytes, ROUNDS);

  return bytesToHex(dec).replace(/^0+/, '');
};

// UNIX seconds embedded in the IV (offset 4, little-endian).
const readTimestamp = (qrText) => hexToBytes(qrText.substring(0, 16)).readUInt32LE(4);

module.exports = {
  ROUNDS,
  generateQr,
  decryptQr,
  readTimestamp,
  isHex,
  keyToBytes,
  hexToBytes,
  bytesToHex,
};
