import { ethers } from 'ethers';
import * as ed25519 from '@noble/ed25519';

// Payer-signature binding: the controller of a leg's settlement-from address signs this
// order-bound message with the key that controls that address. The oracle derives the signer's
// address from the public key, checks it equals the order's settlement-from address, and verifies
// the signature. Paired with the retained `tx.from == orderFrom` check this transitively proves
// `signer == tx.from`, i.e. the declared payer actually paid.
//
// The preimage binds everything known at signing time EXCEPT the tx hash (the attestation is signed
// in the same MPC request as the settlement tx, before the hash exists). Domain separation makes the
// digest structurally impossible to confuse with a real transaction hash or another protocol's
// payload — the settlement key also signs fund-moving txs, so a bare 32-byte signing primitive would
// be a signing oracle.
//
// CANONICAL ENCODING — both signer (Bron MPC / pilates) and verifier (oracle) MUST produce the exact
// same bytes. The preimage is the ABI encoding of the tuple below; the Scala MPC path must mirror it
// byte-for-byte (standard `abi.encode`). Do not reorder or change types without bumping the domain.

export const ATTESTATION_DOMAIN = 'BRON_INTENT_SETTLEMENT_V1';

export type AttestationLeg = 'user' | 'solver';

export enum SignatureScheme {
  Secp256k1 = 'secp256k1',
  Ed25519 = 'ed25519',
}

export interface AttestationMessageParams {
  orderEngine: string;    // OrderEngine address (per-deployment, single anchor instance; QA != Live)
  leg: AttestationLeg;
  orderId: string;
  counterparty: string;   // user-leg: solverAddress; solver-leg: userAddress (on the settlement chain)
  token: string;          // settlement token address on the settlement chain
  amount: bigint;         // settlement amount (base units)
}

const ATTESTATION_TYPES = ['string', 'address', 'string', 'string', 'string', 'string', 'uint256'];

const EVM_ADDRESS_STRING = /^0x[0-9a-fA-F]{40}$/;

// counterparty/token are ABI 'string' (non-EVM legs carry base58/bech32/r-addresses), so their text
// is hashed verbatim — and the signer and the oracle source these fields independently. EVM-style
// 0x-addresses are re-checksummed to one canonical EIP-55 form so casing drift between the two sides
// can't false-reject a valid signature; non-EVM forms are case-sensitive and pass through untouched.
function canonicalAddressString(value: string): string {
  return EVM_ADDRESS_STRING.test(value) ? ethers.getAddress(value.toLowerCase()) : value;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * Canonical attestation preimage bytes. secp256k1 chains sign keccak256(preimage); ed25519 chains
 * sign these raw bytes (RFC 8032 hashes internally).
 */
export function buildAttestationPreimage(params: AttestationMessageParams): Uint8Array {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(ATTESTATION_TYPES, [
    ATTESTATION_DOMAIN,
    ethers.getAddress(params.orderEngine),
    params.leg,
    params.orderId,
    canonicalAddressString(params.counterparty),
    canonicalAddressString(params.token),
    params.amount,
  ]);

  return ethers.getBytes(encoded);
}

export function secp256k1Digest(preimage: Uint8Array): string {
  return ethers.keccak256(preimage);
}

/**
 * Capability a Network gains to participate in payer-signature binding. Kept OFF the public
 * `Network` interface (optional/internal) so external Network implementers don't break.
 */
export interface AttestationCapable {
  readonly signatureScheme: SignatureScheme;

  /** Derive the chain address that the public key controls (compared against the order's from). */
  addressFromPublicKey(publicKey: string): Promise<string> | string;

  /** Verify the signature is valid for `publicKey` over the canonical preimage. */
  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> | boolean;

  /**
   * Optional sigBound override for networks where the settlement "from" is not the plain
   * key-derived address (e.g. Canton party-ids carry a free-form hint next to the key fingerprint).
   * When absent, sigBound is case-insensitive equality with `addressFromPublicKey`.
   */
  matchesAddress?(publicKey: string, address: string): Promise<boolean> | boolean;
}

export function isAttestationCapable<T>(network: T): network is T & AttestationCapable {
  const n = network as unknown as Partial<AttestationCapable>;
  return typeof n?.addressFromPublicKey === 'function' && typeof n?.verifyAttestation === 'function';
}

/** sigBound: does the public key control the order's settlement-from address? */
export async function attestationKeyMatchesAddress(
  network: AttestationCapable,
  publicKey: string,
  address: string,
): Promise<boolean> {
  if (network.matchesAddress) {
    return network.matchesAddress(publicKey, address);
  }

  const derived = await network.addressFromPublicKey(publicKey);
  return derived.toLowerCase() === address.toLowerCase();
}

// ---------------------------------------------------------------------------
// secp256k1 (ECDSA) — EVM / Tron / XRP / Cosmos / BTC
// ---------------------------------------------------------------------------

/**
 * Recover the uncompressed public key from a secp256k1 signature over the preimage, or null if the
 * signature is malformed / malleable. Rejects high-S (BIP-62 malleability). Accepts 64-byte (r||s)
 * and 65-byte (r||s||v) signatures; for 64-byte sigs both recovery ids are tried — safe because the
 * result is only accepted if it matches the submitted public key.
 */
export function recoverSecp256k1PublicKeys(preimage: Uint8Array, signature: string): string[] {
  const sig = ethers.getBytes(signature);
  if (sig.length !== 64 && sig.length !== 65) {
    return [];
  }

  const r = ethers.hexlify(sig.slice(0, 32));
  const sBytes = sig.slice(32, 64);
  const s = BigInt(ethers.hexlify(sBytes));

  if (s === 0n || s > SECP256K1_HALF_N) {
    return []; // reject zero and malleable high-S
  }

  const digest = secp256k1Digest(preimage);

  let parities: (0 | 1)[] = [0, 1];
  if (sig.length === 65) {
    const recoveryId = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    parities = [(recoveryId & 1) as 0 | 1];
  }

  const keys: string[] = [];
  for (const yParity of parities) {
    try {
      const recovered = ethers.SigningKey.recoverPublicKey(digest, ethers.Signature.from({ r, s: ethers.hexlify(sBytes), yParity }));
      keys.push(ethers.SigningKey.computePublicKey(recovered, false).toLowerCase());
    } catch {
      // skip invalid recovery
    }
  }

  return keys;
}

export function verifySecp256k1(publicKey: string, signature: string, preimage: Uint8Array): boolean {
  let target: string;
  try {
    target = ethers.SigningKey.computePublicKey(publicKey, false).toLowerCase();
  } catch {
    return false;
  }

  return recoverSecp256k1PublicKeys(preimage, signature).includes(target);
}

// ---------------------------------------------------------------------------
// ed25519 (EdDSA) — Solana / TON / Canton
// ---------------------------------------------------------------------------

/**
 * Strict RFC 8032 verification (zip215=false): canonical encoding, cofactor-correct, rejects
 * low-order / non-canonical points. Enforces 32-byte public key and 64-byte signature. Async: uses
 * verifyAsync (WebCrypto SHA-512) — the sync path requires a separately-configured sha512.
 */
export async function verifyEd25519(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
  const pub = ethers.getBytes(publicKey);
  const sig = ethers.getBytes(signature);

  if (pub.length !== 32 || sig.length !== 64) {
    return false;
  }

  try {
    ed25519.Point.fromBytes(pub, false); // reject off-curve / non-canonical public key
    return await ed25519.verifyAsync(sig, preimage, pub, { zip215: false });
  } catch {
    return false;
  }
}
