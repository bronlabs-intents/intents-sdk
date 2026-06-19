// Attestation self-test — proves the canonical attestation encoding round-trips through the SDK
// verifier for BOTH schemes, using local throwaway keys (no external signer needed).
//
// Verifies that buildAttestationPreimage + secp256k1Digest + verifySecp256k1/verifyEd25519 agree on
// the exact bytes a signer must produce. Any production signer must build the SAME preimage and sign:
//   secp256k1 -> keccak256 over the raw preimage  (verifier ecrecovers keccak(preimage))
//   ed25519   -> sha512    over the raw preimage  (RFC 8032; verifier checks raw bytes)
//
// Usage: node scripts/selftest-attestation-roundtrip.mjs

import { ethers } from 'ethers';
import * as ed25519 from '@noble/ed25519';
import {
  buildAttestationPreimage,
  secp256k1Digest,
  verifySecp256k1,
  verifyEd25519,
} from '../dist/attestation.js';

const VECTOR = {
  orderEngine: '0x1111111111111111111111111111111111111111',
  leg: 'user',
  orderId: 'order-abc',
  counterparty: '0x2222222222222222222222222222222222222222',
  token: '0x0',
  amount: 1000000n,
};

const preimage = buildAttestationPreimage(VECTOR);
console.log('preimage      :', ethers.hexlify(preimage), `(${preimage.length} bytes)`);
console.log('keccak digest :', secp256k1Digest(preimage));

// --- secp256k1: sign the keccak digest directly (raw ECDSA, NO EIP-191 prefix) ---
const wallet = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
const sigSecp = wallet.signingKey.sign(secp256k1Digest(preimage));
const secpOk = verifySecp256k1(wallet.signingKey.publicKey, sigSecp.serialized, preimage);
console.log(`\nsecp256k1 round-trip: ${secpOk ? 'PASS ✅' : 'FAIL ❌'}`);

// --- ed25519: sign the raw preimage bytes (RFC 8032 hashes internally) ---
const edPriv = ed25519.utils.randomSecretKey();
const edPub = await ed25519.getPublicKeyAsync(edPriv);
const edSig = await ed25519.signAsync(preimage, edPriv);
const edOk = await verifyEd25519(ethers.hexlify(edPub), ethers.hexlify(edSig), preimage);
console.log(`ed25519   round-trip: ${edOk ? 'PASS ✅' : 'FAIL ❌'}`);

process.exit(secpOk && edOk ? 0 : 1);
