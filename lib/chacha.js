'use strict';

// ChaCha20 stream cipher — JS port of the backend's App_Code/ChaCha.cs
// (Chris Lomont / D.J. Bernstein chacha-ref.c, 2008-01-18 variant).
//
// Notes to keep this byte-for-byte compatible with the C# implementation:
//   - 64-bit IV (two little-endian uint32 words at state[14], state[15])
//   - 64-bit block counter at state[12], state[13] (starts at 0)
//   - little-endian pack/unpack
//   - 256-bit key uses the "expand 32-byte k" (sigma) constants
//
// Only used for the Kampüs Giriş (campus entrance) QR. See lib/qr.js.

const SIGMA = Buffer.from('expand 32-byte k', 'ascii');
const TAU = Buffer.from('expand 16-byte k', 'ascii');

const rotl = (v, c) => ((v << c) | (v >>> (32 - c))) >>> 0;

const pack = (buf, i) =>
  ((buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0);

const unpack = (out, i, val) => {
  out[i] = val & 0xff;
  out[i + 1] = (val >>> 8) & 0xff;
  out[i + 2] = (val >>> 16) & 0xff;
  out[i + 3] = (val >>> 24) & 0xff;
};

const quarterRound = (x, a, b, c, d) => {
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl((x[d] ^ x[a]) >>> 0, 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl((x[b] ^ x[c]) >>> 0, 12);
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl((x[d] ^ x[a]) >>> 0, 8);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl((x[b] ^ x[c]) >>> 0, 7);
};

class ChaCha {
  constructor() {
    this.state = new Uint32Array(16);
  }

  setKeyAndInitializationVector(keyBytes, ivBytes) {
    const kbits = keyBytes.length * 8;
    let constants;
    let koff = 0;
    if (kbits === 256) {
      koff = 16;
      constants = SIGMA;
    } else if (kbits === 128) {
      constants = TAU;
    } else {
      throw new Error('Key invalid length');
    }

    const s = this.state;
    s[0] = pack(constants, 0);
    s[1] = pack(constants, 4);
    s[2] = pack(constants, 8);
    s[3] = pack(constants, 12);
    s[4] = pack(keyBytes, 0);
    s[5] = pack(keyBytes, 4);
    s[6] = pack(keyBytes, 8);
    s[7] = pack(keyBytes, 12);
    s[8] = pack(keyBytes, 0 + koff);
    s[9] = pack(keyBytes, 4 + koff);
    s[10] = pack(keyBytes, 8 + koff);
    s[11] = pack(keyBytes, 12 + koff);
    s[12] = 0;
    s[13] = 0;
    s[14] = pack(ivBytes, 0);
    s[15] = pack(ivBytes, 4);
  }

  _nextState(output, rounds) {
    const input = this.state;
    const x = new Uint32Array(16);
    for (let i = 0; i < 16; i++) x[i] = input[i];
    for (let i = rounds; i > 0; i -= 2) {
      quarterRound(x, 0, 4, 8, 12);
      quarterRound(x, 1, 5, 9, 13);
      quarterRound(x, 2, 6, 10, 14);
      quarterRound(x, 3, 7, 11, 15);
      quarterRound(x, 0, 5, 10, 15);
      quarterRound(x, 1, 6, 11, 12);
      quarterRound(x, 2, 7, 8, 13);
      quarterRound(x, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) x[i] = (x[i] + input[i]) >>> 0;
    for (let i = 0; i < 16; i++) unpack(output, 4 * i, x[i]);
  }

  encrypt(message, rounds) {
    if (rounds < 1) throw new Error('Rounds must be positive');
    const out = Buffer.alloc(message.length);
    let bytes = message.length;
    if (bytes === 0) return out;

    const block = Buffer.alloc(64);
    const s = this.state;
    let d64 = 0;
    for (;;) {
      this._nextState(block, rounds);
      s[12] = (s[12] + 1) >>> 0;
      if (s[12] === 0) s[13] = (s[13] + 1) >>> 0;

      if (bytes <= 64) {
        for (let i = 0; i < bytes; i++) out[i + d64] = message[i + d64] ^ block[i];
        return out;
      }
      for (let i = 0; i < 64; i++) out[i + d64] = message[i + d64] ^ block[i];
      bytes -= 64;
      d64 += 64;
    }
  }

  decrypt(cipher, rounds) {
    return this.encrypt(cipher, rounds);
  }
}

module.exports = { ChaCha };
