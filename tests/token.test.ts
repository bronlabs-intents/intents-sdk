import { describe, expect, it } from 'vitest';
import { canonicalTokenId, decodeErc6909TransferAmount, encodeTokenId, parseTokenAddress, parseTokenId } from '../src/token.js';

describe('parseTokenAddress', () => {
  it('returns plain address for a bare token', () => {
    expect(parseTokenAddress('ETH', '0xabc')).toEqual({ kind: 'plain', address: '0xabc' });
  });

  it('treats native 0x0 as plain', () => {
    expect(parseTokenAddress('OP', '0x0')).toEqual({ kind: 'plain', address: '0x0' });
  });

  it('keeps issuer-first ordering for Canton networks', () => {
    expect(parseTokenAddress('CC', 'issuer1:::0xToken')).toEqual({ kind: 'issuer', issuer: 'issuer1', address: '0xToken' });
    expect(parseTokenAddress('testCC', 'issuer1:::0xToken')).toEqual({ kind: 'issuer', issuer: 'issuer1', address: '0xToken' });
  });

  it('parses address-first tokenId for EVM networks', () => {
    expect(parseTokenAddress('OP', '0xToken:::42')).toEqual({ kind: 'nft', address: '0xToken', tokenId: 42n });
  });

  it('does NOT silently swap a Canton-encoded token on an EVM network — a non-numeric right side throws', () => {
    expect(() => parseTokenAddress('OP', 'issuer1:::0xToken')).toThrow();
  });

  it('splits only on the first separator', () => {
    expect(parseTokenAddress('CC', 'iss:::0xToken:::extra')).toEqual({ kind: 'issuer', issuer: 'iss', address: '0xToken:::extra' });
  });
});

describe('parseTokenId', () => {
  it('canonicalizes leading zeros', () => {
    expect(parseTokenId('01')).toBe(1n);
    expect(parseTokenId('0')).toBe(0n);
  });

  it('accepts max uint256', () => {
    const max = (1n << 256n) - 1n;
    expect(parseTokenId(max.toString(10))).toBe(max);
  });

  it('rejects empty, hex, negative and out-of-range', () => {
    expect(() => parseTokenId('')).toThrow();
    expect(() => parseTokenId('0x1')).toThrow();
    expect(() => parseTokenId('-1')).toThrow();
    expect(() => parseTokenId((1n << 256n).toString(10))).toThrow();
  });
});

describe('decodeErc6909TransferAmount', () => {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');

  it('reads the 2nd 32-byte word (amount), not the 1st (caller)', () => {
    const caller = 1234n;
    const amount = 999_999_999_999n;
    const data = '0x' + word(caller) + word(amount);
    expect(decodeErc6909TransferAmount(data)).toBe(amount);
  });

  it('does not confuse the whole data blob for the amount', () => {
    const data = '0x' + word(7n) + word(42n);
    expect(decodeErc6909TransferAmount(data)).toBe(42n);
    expect(decodeErc6909TransferAmount(data)).not.toBe(BigInt(data));
  });
});

describe('canonicalTokenId / encodeTokenId', () => {
  it('strips leading zeros', () => {
    expect(canonicalTokenId('007')).toBe('7');
  });

  it('round-trips through parseTokenAddress', () => {
    const encoded = encodeTokenId('0xToken', '007');
    expect(encoded).toBe('0xToken:::7');
    expect(parseTokenAddress('OP', encoded)).toEqual({ kind: 'nft', address: '0xToken', tokenId: 7n });
  });
});
