import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import * as ed25519 from '@noble/ed25519';
import * as bitcoin from 'bitcoinjs-lib';

import {
  attestationKeyMatchesAddress,
  buildAttestationPreimage,
  isAttestationCapable,
  secp256k1Digest,
  verifySecp256k1,
  verifyEd25519,
} from '../dist/attestation.js';
import { CantonNetwork } from '../dist/networks/canton.js';
import { EvmNetwork } from '../dist/networks/evm.js';
import { TrxNetwork } from '../dist/networks/trx.js';
import { XrpNetwork } from '../dist/networks/xrp.js';
import { CosmosNetwork } from '../dist/networks/cosmos.js';
import { BtcNetwork } from '../dist/networks/btc.js';
import { SolNetwork } from '../dist/networks/sol.js';
import { TonNetwork } from '../dist/networks/ton.js';

const RPC = 'http://127.0.0.1:8545';

const params = {
  orderEngine: '0x1111111111111111111111111111111111111111',
  leg: 'user',
  orderId: 'order-abc',
  counterparty: '0x2222222222222222222222222222222222222222',
  token: '0x0',
  amount: 1000000n,
};

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Frozen canonical vector. The digest below is the cross-implementation contract: every signer and
// verifier implementation must reproduce it from `params` exactly. If this assert breaks, the
// encoding changed and ATTESTATION_DOMAIN must be bumped.
test('canonical vector digest is pinned', () => {
  const preimage = buildAttestationPreimage(params);
  assert.equal(preimage.length, 576);
  assert.equal(secp256k1Digest(preimage), '0x3d5c37807f0daa4d09b1408e42c85a4a012d4b1862782cc6caeb6a3ad9b89995');
});

// counterparty/token are ABI 'string', so their text is hashed verbatim. EVM-style 0x-addresses are
// canonicalized (EIP-55) so casing drift between independently-sourced signer and verifier can't
// false-reject; both sides must agree on the same canonical bytes.
test('EVM-style counterparty is canonicalized — checksum casing does NOT change the preimage', () => {
  const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const a = buildAttestationPreimage({ ...params, counterparty: lower });
  const b = buildAttestationPreimage({ ...params, counterparty: ethers.getAddress(lower) });
  assert.deepEqual(a, b);
});

// Non-EVM forms (base58/bech32/r-address) are case-sensitive and must pass through untouched — they
// are NOT 0x-hex, so the canonicalizer leaves them verbatim.
test('non-EVM counterparty passes through verbatim (case-sensitive)', () => {
  const base58 = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
  const a = buildAttestationPreimage({ ...params, counterparty: base58 });
  const b = buildAttestationPreimage({ ...params, counterparty: base58.toLowerCase() });
  assert.notDeepEqual(a, b);
});

// Canton sigBound matches only the namespace-fingerprint half of the party-id — the hint half is
// free-form and not key-derivable. The pinned vector (1220 + sha256(0x0000000C || pubkey)) is the
// cross-implementation contract with the signer-side party derivation.
test('canton: fingerprint-based sigBound', async () => {
  const net = new CantonNetwork('http://127.0.0.1:1');
  assert.equal(isAttestationCapable(net), true);

  const pub = '0x' + '11'.repeat(32);
  const fp = '12200205734e0ef4afadcf3873cafbb4b8954912a4eb6c11123340ab170e4302e477';
  assert.equal(net.addressFromPublicKey(pub), fp);
  assert.equal(net.addressFromPublicKey('11'.repeat(32).toUpperCase()), fp); // bare uppercase hex (Canton convention)

  assert.equal(await attestationKeyMatchesAddress(net, pub, `bron::${fp}`), true);
  assert.equal(await attestationKeyMatchesAddress(net, pub, `other-hint::${fp.toUpperCase()}`), true); // hint-agnostic, case-insensitive
  assert.equal(await attestationKeyMatchesAddress(net, pub, fp), false); // bare fingerprint is not a party-id
  assert.equal(await attestationKeyMatchesAddress(net, pub, `bron::1220${'0'.repeat(64)}`), false);
});

test('canton: ed25519 attestation round-trip', async () => {
  const net = new CantonNetwork('http://127.0.0.1:1');
  const priv = ed25519.utils.randomSecretKey();
  const pub = ethers.hexlify(await ed25519.getPublicKeyAsync(priv));
  const preimage = buildAttestationPreimage(params);
  const sig = ethers.hexlify(await ed25519.signAsync(preimage, priv));

  assert.equal(await net.verifyAttestation(pub, sig, preimage), true);
  assert.equal(await net.verifyAttestation(pub, sig, buildAttestationPreimage({ ...params, leg: 'solver' })), false);
});

test('preimage is deterministic and field-sensitive', () => {
  const a = buildAttestationPreimage(params);
  const b = buildAttestationPreimage(params);
  assert.deepEqual(a, b);

  const diffLeg = buildAttestationPreimage({ ...params, leg: 'solver' });
  assert.notDeepEqual(a, diffLeg);

  const diffAmount = buildAttestationPreimage({ ...params, amount: 1000001n });
  assert.notDeepEqual(a, diffAmount);
});

test('secp256k1 round-trip + tamper + malleability', () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const preimage = buildAttestationPreimage(params);
  const digest = secp256k1Digest(preimage);
  const sig = wallet.signingKey.sign(digest);
  const pub = wallet.signingKey.publicKey;

  assert.equal(verifySecp256k1(pub, sig.serialized, preimage), true);

  // wrong message
  const otherPreimage = buildAttestationPreimage({ ...params, orderId: 'order-xyz' });
  assert.equal(verifySecp256k1(pub, sig.serialized, otherPreimage), false);

  // malleated high-S variant must be rejected
  const highS = '0x' + (SECP_N - BigInt(sig.s)).toString(16).padStart(64, '0');
  const malleable = ethers.concat([sig.r, highS, '0x1c']);
  assert.equal(verifySecp256k1(pub, malleable, preimage), false);
});

test('ed25519 round-trip + tamper + length checks', async () => {
  const priv = ed25519.utils.randomSecretKey();
  const pub = await ed25519.getPublicKeyAsync(priv);
  const preimage = buildAttestationPreimage(params);
  const sig = await ed25519.signAsync(preimage, priv);

  const pubHex = ethers.hexlify(pub);
  const sigHex = ethers.hexlify(sig);

  assert.equal(await verifyEd25519(pubHex, sigHex, preimage), true);

  const otherPreimage = buildAttestationPreimage({ ...params, leg: 'solver' });
  assert.equal(await verifyEd25519(pubHex, sigHex, otherPreimage), false);

  // wrong lengths rejected
  assert.equal(await verifyEd25519('0x1234', sigHex, preimage), false);
  assert.equal(await verifyEd25519(pubHex, '0x1234', preimage), false);
});

test('EVM network: addressFromPublicKey + verifyAttestation', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const net = new EvmNetwork(RPC, 1);
  assert.equal(net.addressFromPublicKey(wallet.signingKey.publicKey), wallet.address);
  assert.equal(await attestationKeyMatchesAddress(net, wallet.signingKey.publicKey, wallet.address.toLowerCase()), true);

  const preimage = buildAttestationPreimage(params);
  const sig = wallet.signingKey.sign(secp256k1Digest(preimage));
  assert.equal(net.verifyAttestation(wallet.signingKey.publicKey, sig.serialized, preimage), true);
});

test('secp256k1 chains derive deterministic non-empty addresses + verify', () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const pub = wallet.signingKey.publicKey;
  const preimage = buildAttestationPreimage(params);
  const sig = wallet.signingKey.sign(secp256k1Digest(preimage)).serialized;

  const nets = {
    trx: new TrxNetwork(RPC, 1),
    xrp: new XrpNetwork(RPC, 1),
    cosmos: new CosmosNetwork(RPC, 'ngonka', 'gonka', 0, 1),
    btc: new BtcNetwork(RPC, 1),
  };

  for (const [name, net] of Object.entries(nets)) {
    const addr = net.addressFromPublicKey(pub);
    assert.ok(typeof addr === 'string' && addr.length > 0, `${name} addr`);
    assert.equal(net.addressFromPublicKey(pub), addr, `${name} deterministic`);
    assert.equal(net.verifyAttestation(pub, sig, preimage), true, `${name} verify`);
    assert.equal(net.verifyAttestation(pub, sig, buildAttestationPreimage({ ...params, amount: 7n })), false, `${name} tamper`);
  }

  assert.ok(nets.cosmos.addressFromPublicKey(pub).startsWith('gonka1'), 'cosmos bech32 prefix');
  assert.ok(nets.btc.addressFromPublicKey(pub).startsWith('bc1'), 'btc p2wpkh prefix');
});

test('btc: sigBound accepts P2WPKH / P2SH-P2WPKH / P2PKH of the same key, rejects others', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const pub = wallet.signingKey.publicKey;
  const net = new BtcNetwork(RPC, 1);
  const bnet = bitcoin.networks.bitcoin;
  const pubkey = Buffer.from(ethers.getBytes(ethers.SigningKey.computePublicKey(pub, true)));

  const formats = [
    bitcoin.payments.p2wpkh({ pubkey, network: bnet }).address,
    bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: bnet }), network: bnet }).address,
    bitcoin.payments.p2pkh({ pubkey, network: bnet }).address,
  ];

  for (const addr of formats) {
    assert.equal(await attestationKeyMatchesAddress(net, pub, addr), true, addr);
  }

  const otherKey = new ethers.Wallet(ethers.id('btc-other')).signingKey.publicKey;
  const otherPubkey = Buffer.from(ethers.getBytes(ethers.SigningKey.computePublicKey(otherKey, true)));
  const otherAddr = bitcoin.payments.p2wpkh({ pubkey: otherPubkey, network: bnet }).address;
  assert.equal(await attestationKeyMatchesAddress(net, pub, otherAddr), false);
});

test('ed25519 chains derive + verify (SOL/TON)', async () => {
  const priv = ed25519.utils.randomSecretKey();
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubHex = ethers.hexlify(pub);
  const preimage = buildAttestationPreimage(params);
  const sig = ethers.hexlify(await ed25519.signAsync(preimage, priv));

  for (const net of [new SolNetwork(RPC, 1), new TonNetwork(RPC, 1)]) {
    const addr = net.addressFromPublicKey(pubHex);
    assert.ok(typeof addr === 'string' && addr.length > 0);
    assert.equal(await net.verifyAttestation(pubHex, sig, preimage), true);
    assert.equal(await net.verifyAttestation(pubHex, sig, buildAttestationPreimage({ ...params, leg: 'solver' })), false);
  }
});
