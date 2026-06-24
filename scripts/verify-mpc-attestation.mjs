// Signature verifier — run AFTER obtaining an external (e.g. MPC) signature over the canonical
// attestation preimage. Proves the signing path produces a signature the oracle's verifier accepts,
// for BOTH schemes.
//
// Usage:
//   node scripts/verify-mpc-attestation.mjs secp256k1 <publicKeyHex> <signatureHex> [preimageHex]
//   node scripts/verify-mpc-attestation.mjs ed25519   <publicKeyHex> <signatureHex> [preimageHex]
//
// If preimageHex is omitted, the canonical test-vector preimage is rebuilt from the params below —
// the signer must have signed exactly that. The signer is handed the FULL preimage with an explicit
// hash function: secp256k1 -> keccak256, ed25519 -> sha512. The verifier ecrecovers
// keccak256(preimage) for secp256k1 and checks a standard RFC-8032 signature over the raw preimage
// for ed25519.

import { ethers } from 'ethers';
import {
  buildAttestationPreimage,
  secp256k1Digest,
  verifySecp256k1,
  verifyEd25519,
} from '../dist/attestation.js';

// Canonical test-vector params — keep in sync with the signer-side preimage builder.
const VECTOR = {
  orderEngine: '0x1111111111111111111111111111111111111111',
  leg: 'user',
  orderId: 'order-abc',
  counterparty: '0x2222222222222222222222222222222222222222',
  token: '0x0',
  baseAmount: 1000000n,
  quoteAmount: 0n,
  price: 2000000000000000000n,
};

const [scheme, publicKey, signature, preimageHex] = process.argv.slice(2);

if (!scheme || !publicKey || !signature) {
  console.error('usage: node scripts/verify-mpc-attestation.mjs <secp256k1|ed25519> <publicKeyHex> <signatureHex> [preimageHex]');
  process.exit(2);
}

const preimage = preimageHex ? ethers.getBytes(preimageHex) : buildAttestationPreimage(VECTOR);

console.log('preimage      :', ethers.hexlify(preimage));
if (scheme === 'secp256k1') {
  console.log('keccak digest :', secp256k1Digest(preimage), '(verifier ecrecovers this; MPC gets full preimage + hashFunction=keccak256)');
}

const ok = scheme === 'secp256k1'
  ? verifySecp256k1(publicKey, signature, preimage)
  : scheme === 'ed25519'
    ? await verifyEd25519(publicKey, signature, preimage)
    : (() => { console.error(`unknown scheme: ${scheme}`); process.exit(2); })();

console.log(`\n${scheme} attestation verify: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);
