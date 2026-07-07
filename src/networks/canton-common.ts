import { createHash } from 'node:crypto';

import { ethers } from 'ethers';

import { verifyEd25519 } from '../attestation.js';
import { proxyFetch } from '../proxy.js';
import { memoize } from '../utils.js';

export const CANTON_NATIVE_DECIMALS = 10;
export const DEFAULT_DA_UTILITIES_API_URL = 'https://api.utilities.digitalasset.com';

// Canton fingerprints are a multihash (0x12 = SHA-256, 0x20 = 32-byte length) over the 4-byte
// purpose tag 12 (PublicKeyFingerprint) followed by the raw public key bytes.
const FINGERPRINT_PURPOSE = Buffer.from('0000000c', 'hex');
const PARTY_ID_PATTERN = /^[\w-]*::(1220[0-9a-fA-F]{64})$/;

// Canton APIs use bare uppercase hex for keys/signatures; the SDK convention is 0x-prefixed.
export function hex0x(hex: string): string {
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

// Returns the namespace fingerprint, not a full party-id — the hint half is not key-derivable.
export function cantonAddressFromPublicKey(publicKey: string): string {
  const pub = ethers.getBytes(hex0x(publicKey));
  if (pub.length !== 32) {
    throw new Error(`Invalid ed25519 public key length: ${pub.length} (expected 32)`);
  }

  return `1220${createHash('sha256').update(FINGERPRINT_PURPOSE).update(pub).digest('hex')}`;
}

// A Canton "from" is a party-id (`hint::fingerprint`): the hint is free-form and not key-derivable,
// so sigBound compares fingerprints only, binding the key to the paying party's NAMESPACE. A delegated,
// rotated, or multi-controller namespace carries that SAME fingerprint, so it still matches and is
// NOT auto-excluded here — separating it needs a topology-state lookup we don't do, so such parties
// must be kept off attested settlement at onboarding. The only fail-closed guards at this layer are
// the strict PARTY_ID_PATTERN and the 32-byte key-length check.
export function cantonMatchesAddress(publicKey: string, address: string): boolean {
  const partyId = address.match(PARTY_ID_PATTERN);
  return !!partyId && partyId[1].toLowerCase() === cantonAddressFromPublicKey(publicKey);
}

export function verifyCantonAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
  return verifyEd25519(hex0x(publicKey), hex0x(signature), preimage);
}

export async function cantonTokenDecimals(daUtilitiesApiUrl: string, tokenAddress: string): Promise<number> {
  if (tokenAddress === '0x0') {
    return CANTON_NATIVE_DECIMALS;
  }

  const [tokenIssuer, tokenInstrumentId] = tokenAddress.split(':::');

  return await memoize(`cc-decimals-${tokenIssuer}-${tokenInstrumentId}`, 86_400_000, async () => {
    const url = `${daUtilitiesApiUrl}/api/token-standard/v0/registrars/${tokenIssuer}/registry/metadata/v1/instruments/${tokenInstrumentId}`;
    const resp = await proxyFetch(url, { method: 'GET' });

    if (!resp.ok) {
      throw new Error(`Failed to get token metadata from ${url}: ${resp.status} - ${await resp.text()}`);
    }

    return (await resp.json()).decimals;
  });
}
