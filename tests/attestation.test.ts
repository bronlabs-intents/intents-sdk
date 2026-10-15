import { expect, test } from 'vitest';
import { ethers } from 'ethers';
import * as ed25519 from '@noble/ed25519';
import * as bitcoin from 'bitcoinjs-lib';

import {
  AttestationMessageParams,
  attestationKeyMatchesAddress,
  buildAttestationPreimage,
  buildAttestationTypedData,
  buildAttestationTypedDataEnvelope,
  decodePayerSignatureProof,
  eip712AttestationDigest,
  encodePayerSignatureProof,
  isAttestationCapable,
  secp256k1Digest,
  SettlementMethod,
  verifyPayerSignatureEip712,
  verifySecp256k1,
  verifyEd25519,
  verifySettlementProof,
} from '../src/attestation.js';
import { CantonNetwork } from '../src/networks/canton.js';
import { EvmNetwork } from '../src/networks/evm.js';
import { TrxNetwork } from '../src/networks/trx.js';
import { XrpNetwork } from '../src/networks/xrp.js';
import { CosmosNetwork } from '../src/networks/cosmos.js';
import { BtcNetwork } from '../src/networks/btc.js';
import { SolNetwork } from '../src/networks/sol.js';
import { TonNetwork } from '../src/networks/ton.js';

const RPC = 'http://127.0.0.1:8545';

const params: AttestationMessageParams = {
  orderEngine: '0x1111111111111111111111111111111111111111',
  leg: 'user',
  orderId: 'order-abc',
  counterparty: '0x2222222222222222222222222222222222222222',
  token: '0x0',
  baseAmount: 1000000n,
  quoteAmount: 0n,
  price: 2000000000000000000n,
};

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Frozen canonical vector. The digest below is the cross-implementation contract: every signer and
// verifier implementation must reproduce it from `params` exactly. If this assert breaks, the
// encoding changed and ATTESTATION_DOMAIN must be bumped.
test('canonical vector digest is pinned', () => {
  const preimage = buildAttestationPreimage(params);
  expect(preimage.length).toBe(640);
  expect(secp256k1Digest(preimage)).toBe('0xe57018510e3afffc5c91b1b375fc2f414c5a287d7430a172b79fcb11c3471a4b');
});

// counterparty/token are ABI 'string', so their text is hashed verbatim. EVM-style 0x-addresses are
// canonicalized (EIP-55) so casing drift between independently-sourced signer and verifier can't
// false-reject; both sides must agree on the same canonical bytes.
test('EVM-style counterparty is canonicalized — checksum casing does NOT change the preimage', () => {
  const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const a = buildAttestationPreimage({ ...params, counterparty: lower });
  const b = buildAttestationPreimage({ ...params, counterparty: ethers.getAddress(lower) });
  expect(a).toEqual(b);
});

// Non-EVM forms (base58/bech32/r-address) are case-sensitive and must pass through untouched — they
// are NOT 0x-hex, so the canonicalizer leaves them verbatim.
test('non-EVM counterparty passes through verbatim (case-sensitive)', () => {
  const base58 = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
  const a = buildAttestationPreimage({ ...params, counterparty: base58 });
  const b = buildAttestationPreimage({ ...params, counterparty: base58.toLowerCase() });
  expect(a).not.toEqual(b);
});

// Canton sigBound matches only the namespace-fingerprint half of the party-id — the hint half is
// free-form and not key-derivable. The pinned vector (1220 + sha256(0x0000000C || pubkey)) is the
// cross-implementation contract with the signer-side party derivation.
test('canton: fingerprint-based sigBound', async () => {
  const net = new CantonNetwork('http://127.0.0.1:1');
  expect(isAttestationCapable(net)).toBe(true);

  const pub = '0x' + '11'.repeat(32);
  const fp = '12200205734e0ef4afadcf3873cafbb4b8954912a4eb6c11123340ab170e4302e477';
  expect(net.addressFromPublicKey(pub)).toBe(fp);
  expect(net.addressFromPublicKey('11'.repeat(32).toUpperCase())).toBe(fp); // bare uppercase hex (Canton convention)

  expect(await attestationKeyMatchesAddress(net, pub, `bron::${fp}`)).toBe(true);
  expect(await attestationKeyMatchesAddress(net, pub, `other-hint::${fp.toUpperCase()}`)).toBe(true); // hint-agnostic, case-insensitive
  expect(await attestationKeyMatchesAddress(net, pub, fp)).toBe(false); // bare fingerprint is not a party-id
  expect(await attestationKeyMatchesAddress(net, pub, `bron::1220${'0'.repeat(64)}`)).toBe(false);
});

test('canton: ed25519 attestation round-trip', async () => {
  const net = new CantonNetwork('http://127.0.0.1:1');
  const priv = ed25519.utils.randomSecretKey();
  const pub = ethers.hexlify(await ed25519.getPublicKeyAsync(priv));
  const preimage = buildAttestationPreimage(params);
  const sig = ethers.hexlify(await ed25519.signAsync(preimage, priv));

  expect(await net.verifyAttestation(pub, sig, preimage)).toBe(true);
  expect(await net.verifyAttestation(pub, sig, buildAttestationPreimage({ ...params, leg: 'solver' }))).toBe(false);
});

test('preimage is deterministic and field-sensitive', () => {
  const a = buildAttestationPreimage(params);
  const b = buildAttestationPreimage(params);
  expect(a).toEqual(b);

  const diffLeg = buildAttestationPreimage({ ...params, leg: 'solver' });
  expect(a).not.toEqual(diffLeg);

  const diffAmount = buildAttestationPreimage({ ...params, baseAmount: 1000001n });
  expect(a).not.toEqual(diffAmount);

  const diffPrice = buildAttestationPreimage({ ...params, price: 2000000000000000001n });
  expect(a).not.toEqual(diffPrice);
});

test('secp256k1 round-trip + tamper + malleability', () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const preimage = buildAttestationPreimage(params);
  const digest = secp256k1Digest(preimage);
  const sig = wallet.signingKey.sign(digest);
  const pub = wallet.signingKey.publicKey;

  expect(verifySecp256k1(pub, sig.serialized, preimage)).toBe(true);

  // wrong message
  const otherPreimage = buildAttestationPreimage({ ...params, orderId: 'order-xyz' });
  expect(verifySecp256k1(pub, sig.serialized, otherPreimage)).toBe(false);

  // malleated high-S variant must be rejected
  const highS = '0x' + (SECP_N - BigInt(sig.s)).toString(16).padStart(64, '0');
  const malleable = ethers.concat([sig.r, highS, '0x1c']);
  expect(verifySecp256k1(pub, malleable, preimage)).toBe(false);
});

test('ed25519 round-trip + tamper + length checks', async () => {
  const priv = ed25519.utils.randomSecretKey();
  const pub = await ed25519.getPublicKeyAsync(priv);
  const preimage = buildAttestationPreimage(params);
  const sig = await ed25519.signAsync(preimage, priv);

  const pubHex = ethers.hexlify(pub);
  const sigHex = ethers.hexlify(sig);

  expect(await verifyEd25519(pubHex, sigHex, preimage)).toBe(true);

  const otherPreimage = buildAttestationPreimage({ ...params, leg: 'solver' });
  expect(await verifyEd25519(pubHex, sigHex, otherPreimage)).toBe(false);

  // wrong lengths rejected
  expect(await verifyEd25519('0x1234', sigHex, preimage)).toBe(false);
  expect(await verifyEd25519(pubHex, '0x1234', preimage)).toBe(false);
});

test('EVM network: addressFromPublicKey + verifyAttestation', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const net = new EvmNetwork(RPC, 1);
  expect(net.addressFromPublicKey(wallet.signingKey.publicKey)).toBe(wallet.address);
  expect(await attestationKeyMatchesAddress(net, wallet.signingKey.publicKey, wallet.address.toLowerCase())).toBe(true);

  const preimage = buildAttestationPreimage(params);
  const sig = wallet.signingKey.sign(secp256k1Digest(preimage));
  expect(net.verifyAttestation(wallet.signingKey.publicKey, sig.serialized, preimage)).toBe(true);
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
    expect(typeof addr === 'string' && addr.length > 0, `${name} addr`).toBe(true);
    expect(net.addressFromPublicKey(pub), `${name} deterministic`).toBe(addr);
    expect(net.verifyAttestation(pub, sig, preimage), `${name} verify`).toBe(true);
    expect(net.verifyAttestation(pub, sig, buildAttestationPreimage({ ...params, baseAmount: 7n })), `${name} tamper`).toBe(false);
  }

  expect(nets.cosmos.addressFromPublicKey(pub).startsWith('gonka1'), 'cosmos bech32 prefix').toBe(true);
  expect(nets.btc.addressFromPublicKey(pub).startsWith('bc1'), 'btc p2wpkh prefix').toBe(true);
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
    expect(await attestationKeyMatchesAddress(net, pub, addr!), addr).toBe(true);
  }

  const otherKey = new ethers.Wallet(ethers.id('btc-other')).signingKey.publicKey;
  const otherPubkey = Buffer.from(ethers.getBytes(ethers.SigningKey.computePublicKey(otherKey, true)));
  const otherAddr = bitcoin.payments.p2wpkh({ pubkey: otherPubkey, network: bnet }).address;
  expect(await attestationKeyMatchesAddress(net, pub, otherAddr!)).toBe(false);
});

test('btc: sigBound binds both mainnet and testnet encodings of the same key, rejects other keys', async () => {
  const pub = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d').signingKey.publicKey;
  const pubkey = Buffer.from(ethers.getBytes(ethers.SigningKey.computePublicKey(pub, true)));
  const net = new BtcNetwork(RPC, 1);

  const mainnetAddr = bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin }).address!;
  const testnetAddr = bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.testnet }).address!;
  expect(mainnetAddr.startsWith('bc1') && testnetAddr.startsWith('tb1'), 'mainnet/testnet prefixes').toBe(true);

  expect(await attestationKeyMatchesAddress(net, pub, mainnetAddr)).toBe(true);
  expect(await attestationKeyMatchesAddress(net, pub, testnetAddr)).toBe(true);

  const otherKey = new ethers.Wallet(ethers.id('btc-other-testnet')).signingKey.publicKey;
  const otherPubkey = Buffer.from(ethers.getBytes(ethers.SigningKey.computePublicKey(otherKey, true)));
  const otherTestnetAddr = bitcoin.payments.p2wpkh({ pubkey: otherPubkey, network: bitcoin.networks.testnet }).address!;
  expect(await attestationKeyMatchesAddress(net, pub, otherTestnetAddr)).toBe(false);
});

test('payer-signature proof: abi.encode round-trip preserves publicKey + signature', () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const sig = wallet.signingKey.sign(secp256k1Digest(buildAttestationPreimage(params))).serialized;
  const pub = wallet.signingKey.publicKey;

  const decoded = decodePayerSignatureProof(encodePayerSignatureProof(pub, sig));
  expect(decoded.publicKey.toLowerCase()).toBe(pub.toLowerCase());
  expect(decoded.signature.toLowerCase()).toBe(sig.toLowerCase());
});

test('verifySettlementProof: method None is not present (legacy pass-through)', async () => {
  const net = new EvmNetwork(RPC, 1);
  const v = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.None, proof: '0x' }, params, params.counterparty);
  expect(v.present).toBe(false);
  expect(v.valid).toBe(false);
});

test('verifySettlementProof: PayerSignature verifies a real proof, rejects tamper and unknown method', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const net = new EvmNetwork(RPC, 1);
  const sig = wallet.signingKey.sign(secp256k1Digest(buildAttestationPreimage(params))).serialized;
  const proof = encodePayerSignatureProof(wallet.signingKey.publicKey, sig);

  const ok = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignature, proof }, params, wallet.address);
  expect(ok).toMatchObject({ present: true, methodAllowed: true, sigBound: true, sigValid: true, valid: true });

  // wrong order's settlement-from address — sigBound fails
  const wrongFrom = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignature, proof }, params, params.counterparty);
  expect(wrongFrom.valid).toBe(false);
  expect(wrongFrom.sigBound).toBe(false);

  // proof bound to a different leg — sigValid fails
  const otherLeg = encodePayerSignatureProof(
    wallet.signingKey.publicKey,
    wallet.signingKey.sign(secp256k1Digest(buildAttestationPreimage({ ...params, leg: 'solver' }))).serialized,
  );
  const tampered = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignature, proof: otherLeg }, params, wallet.address);
  expect(tampered.valid).toBe(false);
  expect(tampered.sigValid).toBe(false);

  // unknown method id — fails closed, never reaches verification
  const unknown = await verifySettlementProof(net, 'ETH', { method: 99, proof }, params, wallet.address);
  expect(unknown).toMatchObject({ present: true, methodAllowed: false, valid: false });
});

test('verifySettlementProof: MintPayerSignature verifies only for a mint (G1) and only on mint-hosting networks (G4)', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const net = new EvmNetwork(RPC, 1);
  const sig = wallet.signingKey.sign(secp256k1Digest(buildAttestationPreimage(params))).serialized;
  const proof = encodePayerSignatureProof(wallet.signingKey.publicKey, sig);

  // mint (logFromWasZero) + minter signature bound to the resolved orderFrom → valid
  const minted = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.MintPayerSignature, proof, mintContext: { logFromWasZero: true } }, params, wallet.address);
  expect(minted).toMatchObject({ present: true, methodAllowed: true, sigBound: true, sigValid: true, valid: true });

  // G1: same valid proof but the log-from was NOT zero (not a mint) — rejected before the signature is used
  const notMint = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.MintPayerSignature, proof, mintContext: { logFromWasZero: false } }, params, wallet.address);
  expect(notMint).toMatchObject({ present: true, methodAllowed: true, valid: false });

  // G1: mintContext omitted entirely — still rejected
  const noContext = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.MintPayerSignature, proof }, params, wallet.address);
  expect(noContext.valid).toBe(false);

  // G4: method 2 is not allowed on a non-mint-hosting network — never reaches verification
  const wrongNet = await verifySettlementProof(net, 'BTC', { method: SettlementMethod.MintPayerSignature, proof, mintContext: { logFromWasZero: true } }, params, wallet.address);
  expect(wrongNet).toMatchObject({ present: true, methodAllowed: false, valid: false });
});

const CHAIN_ID = 1;

// Frozen canonical vector for method 3 — same contract as the V1 vector above: signer and verifier
// must reproduce this digest exactly; a break means the typed-data encoding changed.
test('eip712: canonical vector digest is pinned', () => {
  expect(eip712AttestationDigest(params, CHAIN_ID)).toBe('0xa5e2e8b2cb694b6c5a23dcfcd7847dc73d8fb82c0ed0b597898305250bcf2388');
});

test('eip712: EVM-style counterparty casing does NOT change the digest', () => {
  const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const a = eip712AttestationDigest({ ...params, counterparty: lower }, CHAIN_ID);
  const b = eip712AttestationDigest({ ...params, counterparty: ethers.getAddress(lower) }, CHAIN_ID);
  expect(a).toBe(b);
});

test('eip712: signTypedData round-trip, wrong signer/field/chainId rejected', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const { domain, types, message } = buildAttestationTypedData(params, CHAIN_ID);
  const sig = await wallet.signTypedData(domain, types, message);

  expect(verifyPayerSignatureEip712(sig, params, CHAIN_ID, wallet.address)).toBe(true);
  expect(verifyPayerSignatureEip712(sig, params, CHAIN_ID, wallet.address.toLowerCase())).toBe(true);

  expect(verifyPayerSignatureEip712(sig, params, CHAIN_ID, params.counterparty)).toBe(false);
  expect(verifyPayerSignatureEip712(sig, { ...params, leg: 'solver' }, CHAIN_ID, wallet.address)).toBe(false);
  expect(verifyPayerSignatureEip712(sig, { ...params, baseAmount: 1000001n }, CHAIN_ID, wallet.address)).toBe(false);
  expect(verifyPayerSignatureEip712(sig, params, 42161, wallet.address)).toBe(false);
});

test('eip712: high-S and malformed proofs are rejected without throwing', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const { domain, types, message } = buildAttestationTypedData(params, CHAIN_ID);
  const sig = ethers.Signature.from(await wallet.signTypedData(domain, types, message));

  const highS = '0x' + (SECP_N - BigInt(sig.s)).toString(16).padStart(64, '0');
  const flippedV = sig.v === 27 ? '0x1c' : '0x1b';
  const malleated = ethers.concat([sig.r, highS, flippedV]);
  expect(verifyPayerSignatureEip712(malleated, params, CHAIN_ID, wallet.address)).toBe(false);

  expect(verifyPayerSignatureEip712(ethers.concat([sig.r, sig.s]), params, CHAIN_ID, wallet.address)).toBe(false); // 64 bytes
  expect(verifyPayerSignatureEip712('0x1234', params, CHAIN_ID, wallet.address)).toBe(false);
  expect(verifyPayerSignatureEip712('not-hex', params, CHAIN_ID, wallet.address)).toBe(false);
  expect(verifyPayerSignatureEip712('0x' + '00'.repeat(65), params, CHAIN_ID, wallet.address)).toBe(false); // s = 0
  expect(verifyPayerSignatureEip712('0x' + 'ff'.repeat(65), params, CHAIN_ID, wallet.address)).toBe(false);
});

// The \x19\x01 framing vs the ABI-encoded V1 preimage makes the digests structurally disjoint —
// one signature must never verify under both methods.
test('eip712: no cross-method replay with V1 in either direction', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const preimage = buildAttestationPreimage(params);

  const v1Sig = wallet.signingKey.sign(secp256k1Digest(preimage)).serialized;
  expect(verifyPayerSignatureEip712(v1Sig, params, CHAIN_ID, wallet.address)).toBe(false);

  const { domain, types, message } = buildAttestationTypedData(params, CHAIN_ID);
  const eip712Sig = await wallet.signTypedData(domain, types, message);
  expect(verifySecp256k1(wallet.signingKey.publicKey, eip712Sig, preimage)).toBe(false);
});

test('eip712: envelope is JSON-safe and hashes to the same digest', () => {
  const env = buildAttestationTypedDataEnvelope(params, CHAIN_ID);

  expect(() => JSON.stringify(env)).not.toThrow();
  expect(env.types.EIP712Domain).toBeDefined();
  expect(env.primaryType).toBe('Settlement');
  expect(typeof env.message.baseAmount).toBe('string');

  const { EIP712Domain, ...types } = env.types;
  expect(ethers.TypedDataEncoder.hash(env.domain, types, env.message)).toBe(eip712AttestationDigest(params, CHAIN_ID));
});

test('verifySettlementProof: PayerSignatureEip712 verifies transfers on EVM, fails closed on mints and non-EVM', async () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const net = new EvmNetwork(RPC, 1);
  const { domain, types, message } = buildAttestationTypedData(params, CHAIN_ID);
  const proof = await wallet.signTypedData(domain, types, message);

  const ok = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignatureEip712, proof }, params, wallet.address);
  expect(ok).toMatchObject({ present: true, methodAllowed: true, sigBound: true, sigValid: true, valid: true });

  const okNotMint = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignatureEip712, proof, mintContext: { logFromWasZero: false } }, params, wallet.address);
  expect(okNotMint.valid).toBe(true);

  const wrongFrom = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignatureEip712, proof }, params, params.counterparty);
  expect(wrongFrom.valid).toBe(false);

  // transfers only — a mint's orderFrom comes from the relayer-controlled envelope
  const mint = await verifySettlementProof(net, 'ETH', { method: SettlementMethod.PayerSignatureEip712, proof, mintContext: { logFromWasZero: true } }, params, wallet.address);
  expect(mint).toMatchObject({ present: true, methodAllowed: true, valid: false });

  // domain chainId is pinned per network: an ETH-domain proof cannot verify as an ARB settlement
  const wrongChain = await verifySettlementProof(net, 'ARB', { method: SettlementMethod.PayerSignatureEip712, proof }, params, wallet.address);
  expect(wrongChain.valid).toBe(false);

  for (const networkId of ['BTC', 'SOL', 'TRX', 'CC']) {
    const nonEvm = await verifySettlementProof(net, networkId, { method: SettlementMethod.PayerSignatureEip712, proof }, params, wallet.address);
    expect(nonEvm, networkId).toMatchObject({ present: true, methodAllowed: false, valid: false });
  }
});

test('ed25519 chains derive + verify (SOL/TON)', async () => {
  const priv = ed25519.utils.randomSecretKey();
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubHex = ethers.hexlify(pub);
  const preimage = buildAttestationPreimage(params);
  const sig = ethers.hexlify(await ed25519.signAsync(preimage, priv));

  for (const net of [new SolNetwork(RPC, 1), new TonNetwork(RPC, 1)]) {
    const addr = net.addressFromPublicKey(pubHex);
    expect(typeof addr === 'string' && addr.length > 0).toBe(true);
    expect(await net.verifyAttestation(pubHex, sig, preimage)).toBe(true);
    expect(await net.verifyAttestation(pubHex, sig, buildAttestationPreimage({ ...params, leg: 'solver' }))).toBe(false);
  }
});
