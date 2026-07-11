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
  // Raw on-chain pricing (createOrder XOR-pins exactly one of base/quote; price_e18 set on solverReact).
  // Bound verbatim so signer and verifier read the same immutable order — the leg's settlement amount is
  // derived from these by the verifier, never recomputed on the signing side.
  baseAmount: bigint;
  quoteAmount: bigint;
  price: bigint;          // price_e18
}

const ATTESTATION_TYPES = ['string', 'address', 'string', 'string', 'string', 'string', 'uint256', 'uint256', 'uint256'];

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
    params.baseAmount,
    params.quoteAmount,
    params.price,
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

// ---------------------------------------------------------------------------
// Settlement-proof method registry
//
// `method` is the opaque uint8 stored on-chain in SettlementProof; the contract never interprets it.
// The registry — which methods exist, how each proof is encoded, how the oracle verifies it, and which
// methods are allowed per network — lives HERE so the submitter (defi-js / pilates) and the verifier
// (oracle) share one source of truth. Adding a method is an SDK change, not a contract change.
//
// Method 1 (payer-signature) is allowed on every network; method 2 (mint payer-signature) only on the
// EVM + Solana networks that host consumer-token mints.
// ---------------------------------------------------------------------------

export enum SettlementMethod {
  None = 0,
  PayerSignature = 1,
  MintPayerSignature = 2,
}

// A consumer-token mint has a zero token-level `from`, so the oracle resolves the settlement sender
// from the tx envelope — sound only on the EVM chains that host such mints (Solana not yet supported).
const MINT_SETTLEMENT_NETWORKS = new Set<string>([
  'ETH', 'OP', 'BSC', 'BASE', 'POL', 'ARB', 'hyperEVM',
  'testETH', 'testOP',
]);

export function allowedSettlementMethods(networkId: string): SettlementMethod[] {
  const methods: SettlementMethod[] = [SettlementMethod.PayerSignature];

  if (MINT_SETTLEMENT_NETWORKS.has(networkId)) {
    methods.push(SettlementMethod.MintPayerSignature);
  }

  return methods;
}

const PAYER_SIGNATURE_PROOF_TYPES = ['bytes', 'bytes'];

/** SettlementMethod.PayerSignature proof payload: abi.encode(publicKey, signature). */
export function encodePayerSignatureProof(publicKey: string, signature: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(PAYER_SIGNATURE_PROOF_TYPES, [publicKey, signature]);
}

export function decodePayerSignatureProof(proof: string): { publicKey: string; signature: string } {
  const [publicKey, signature] = ethers.AbiCoder.defaultAbiCoder().decode(PAYER_SIGNATURE_PROOF_TYPES, proof);
  return { publicKey, signature };
}

export interface SettlementProofInput {
  method: number;
  proof: string;
  // Set by the oracle when the settlement log's token-level `from` was the zero/empty sender (a mint);
  // MintPayerSignature is rejected unless this is true (G1).
  mintContext?: { logFromWasZero: boolean };
}

export interface SettlementProofVerification {
  present: boolean;       // a method other than None is declared on-chain
  methodAllowed: boolean; // the declared method is in this network's allow-list
  valid: boolean;         // method present, allowed, and its proof verified
  sigBound?: boolean;
  sigValid?: boolean;
}

/**
 * Verify the on-chain SettlementProof for one settlement leg. Dispatches on `method` against the
 * network's allow-list — an unknown or disallowed method fails closed. PayerSignature: decode the
 * proof to (publicKey, signature), check the key controls `orderFrom` (sigBound) and the signature
 * covers the canonical preimage (sigValid). MintPayerSignature: the same check, accepted only for a
 * mint (mintContext.logFromWasZero) where the oracle resolved `orderFrom` from the tx envelope.
 */
export async function verifySettlementProof(
  network: AttestationCapable,
  networkId: string,
  input: SettlementProofInput,
  preimageParams: AttestationMessageParams,
  orderFrom: string,
): Promise<SettlementProofVerification> {
  if (input.method === SettlementMethod.None) {
    return { present: false, methodAllowed: true, valid: false };
  }

  if (!allowedSettlementMethods(networkId).includes(input.method)) {
    return { present: true, methodAllowed: false, valid: false };
  }

  switch (input.method) {
    case SettlementMethod.PayerSignature:
    case SettlementMethod.MintPayerSignature: {
      // G1: MintPayerSignature is valid only for a mint (token-level `from` == zero); rejecting it
      // otherwise stops a relayer rebinding a normal transfer to the envelope sender it controls.
      if (input.method === SettlementMethod.MintPayerSignature && !input.mintContext?.logFromWasZero) {
        return { present: true, methodAllowed: true, valid: false };
      }

      const { publicKey, signature } = decodePayerSignatureProof(input.proof);
      const preimage = buildAttestationPreimage(preimageParams);

      const sigBound = await attestationKeyMatchesAddress(network, publicKey, orderFrom);
      const sigValid = await network.verifyAttestation(publicKey, signature, preimage);

      return { present: true, methodAllowed: true, valid: sigBound && sigValid, sigBound, sigValid };
    }

    default:
      return { present: true, methodAllowed: false, valid: false };
  }
}
