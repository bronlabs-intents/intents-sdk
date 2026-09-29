import { Metadata, TypeRegistry } from '@polkadot/types';
import { hexToU8a, isHex, u8aEq, u8aToBigInt } from '@polkadot/util';
import { blake2AsHex, decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifyEd25519 } from '../attestation.js';
import { log } from '../utils.js';
import { proxyFetch } from '../proxy.js';

const SS58_PREFIX = 42;
const NATIVE_DECIMALS = 9;
const BLOCK_TIME_SECONDS = 12;
const WINDOW_MARGIN_BLOCKS = 50;
const DEFAULT_LOOKBACK_BLOCKS = 7200;
const SCAN_TIME_BOX_MS = 10_000;
const RPC_TIMEOUT_MS = 5_000;
const PARALLEL_BLOCKS = 5;
const MAX_CACHED_HITS = 10_000;

const TX_HASH = /^0x[0-9a-f]{64}$/;
const SYSTEM_EVENTS_KEY = '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';
const TIMESTAMP_NOW_KEY = '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';

interface ExtrinsicLocation {
  blockHash: string;
  index: number;
}

interface Transfer {
  from: Uint8Array;
  to: Uint8Array;
  amount: bigint;
}

interface ExtrinsicOutcome {
  failed: boolean;
  transfers: Transfer[];
}

const failed = (timestamp: number): TransactionData => ({
  from: '',
  to: '',
  token: '',
  amount: 0n,
  confirmed: true,
  timestamp
});

export function taoAccountId(address: string): Uint8Array | undefined {
  if (!address || isHex(address)) {
    return;
  }

  try {
    const accountId = decodeAddress(address);
    return accountId.length === 32 ? accountId : undefined;
  } catch {
    return;
  }
}

export class TaoNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly hits = new Map<string, ExtrinsicLocation>();
  private readonly progress = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<ExtrinsicLocation | undefined>>();
  private readonly registries = new Map<number, TypeRegistry>();
  readonly retryDelay: number = BLOCK_TIME_SECONDS * 1000;
  readonly signatureScheme = SignatureScheme.Ed25519;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async ping(): Promise<void> {
    await this.rpcCall('chain_getFinalizedHead', []);
  }

  addressFromPublicKey(publicKey: string): string {
    return encodeAddress(hexToU8a(publicKey), SS58_PREFIX);
  }

  matchesAddress(publicKey: string, address: string): boolean {
    const accountId = taoAccountId(address);
    return !!accountId && isHex(publicKey) && u8aEq(accountId, hexToU8a(publicKey));
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
    return verifyEd25519(publicKey, signature, preimage);
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress !== '0x0') {
      throw new Error(`TAO supports only the native token, got ${tokenAddress}`);
    }

    return NATIVE_DECIMALS;
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string,
    _tokenId?: bigint,
    senderAddress?: string,
    notBefore?: number
  ): Promise<TransactionData | undefined> {
    const hash = txHash.toLowerCase();
    const recipient = taoAccountId(recipientAddress);
    const sender = taoAccountId(senderAddress ?? '');

    if (tokenAddress !== '0x0' || !TX_HASH.test(hash) || !recipient || !sender) {
      log.warn(`TAO tx ${txHash} rejected: token ${tokenAddress}, recipient ${recipientAddress}, sender ${senderAddress}`);
      return failed(0);
    }

    const location = await this.locate(hash, notBefore);

    if (!location) {
      return;
    }

    const [outcome, timestamp] = await Promise.all([
      this.extrinsicOutcome(location.blockHash, location.index),
      this.blockTimestamp(location.blockHash)
    ]);

    if (outcome.failed) {
      log.warn(`TAO tx ${txHash} failed on chain in block ${location.blockHash}`);
      return failed(timestamp);
    }

    const transfers = outcome.transfers.filter(t => u8aEq(t.to, recipient) && u8aEq(t.from, sender));

    if (transfers.length !== 1) {
      log.warn(`TAO tx ${txHash} has ${transfers.length} transfers from ${senderAddress} to ${recipientAddress}`);
      return failed(timestamp);
    }

    return {
      from: senderAddress!,
      to: recipientAddress,
      token: tokenAddress,
      amount: transfers[0].amount,
      confirmed: true,
      timestamp
    };
  }

  async transfer(): Promise<string> {
    throw new Error('TaoNetwork does not support transfers');
  }

  private locate(hash: string, notBefore?: number): Promise<ExtrinsicLocation | undefined> {
    const hit = this.hits.get(hash);

    if (hit) {
      return Promise.resolve(hit);
    }

    const key = `${hash}:${notBefore ?? ''}`;
    const pending = this.inFlight.get(key) ?? this.scan(key, notBefore).finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, pending);

    return pending;
  }

  private async scan(key: string, notBefore?: number): Promise<ExtrinsicLocation | undefined> {
    const hash = key.split(':')[0];
    const deadline = Date.now() + SCAN_TIME_BOX_MS;
    const finalized = await this.finalizedHeight(deadline);

    let next = this.progress.get(key) ?? this.windowStart(finalized, notBefore);

    while (next <= finalized && Date.now() < deadline) {
      const heights = Array.from({ length: Math.min(PARALLEL_BLOCKS, finalized - next + 1) }, (_, i) => next + i);
      const blocks = await Promise.all(heights.map(height => this.blockExtrinsics(height, deadline)));

      for (const { blockHash, extrinsics } of blocks) {
        const index = extrinsics.findIndex(extrinsic => blake2AsHex(hexToU8a(extrinsic), 256) === hash);

        if (index >= 0) {
          const location = { blockHash, index };

          this.progress.delete(key);
          this.rememberHit(hash, location);

          return location;
        }
      }

      next = heights[heights.length - 1] + 1;
      this.progress.set(key, next);
    }

    log.info(`TAO tx ${hash} not found up to block ${next - 1} (finalized ${finalized})`);
  }

  private windowStart(finalized: number, notBefore?: number): number {
    const lookback = notBefore === undefined
      ? DEFAULT_LOOKBACK_BLOCKS
      : Math.ceil(Math.max(0, Date.now() / 1000 - notBefore) / BLOCK_TIME_SECONDS);

    return Math.max(0, finalized - lookback - WINDOW_MARGIN_BLOCKS);
  }

  private rememberHit(hash: string, location: ExtrinsicLocation): void {
    if (this.hits.size >= MAX_CACHED_HITS) {
      this.hits.delete(this.hits.keys().next().value!);
    }

    this.hits.set(hash, location);
  }

  private async finalizedHeight(deadline: number): Promise<number> {
    const finalizedHash = await this.rpcCall('chain_getFinalizedHead', [], deadline);
    const header = await this.rpcCall('chain_getHeader', [finalizedHash], deadline);

    return parseInt(header.number, 16);
  }

  private async blockExtrinsics(height: number, deadline: number): Promise<{ blockHash: string; extrinsics: string[] }> {
    const blockHash = await this.rpcCall('chain_getBlockHash', [height], deadline);
    const { block } = await this.rpcCall('chain_getBlock', [blockHash], deadline);

    return { blockHash, extrinsics: block.extrinsics };
  }

  private async blockTimestamp(blockHash: string): Promise<number> {
    const now = await this.rpcCall('state_getStorage', [TIMESTAMP_NOW_KEY, blockHash]);

    return Math.floor(Number(u8aToBigInt(hexToU8a(now))) / 1000);
  }

  private async extrinsicOutcome(blockHash: string, index: number): Promise<ExtrinsicOutcome> {
    const registry = await this.registryAt(blockHash);
    const raw = await this.rpcCall('state_getStorage', [SYSTEM_EVENTS_KEY, blockHash]);

    const events = (registry.createType('Vec<FrameSystemEventRecord>', raw) as any[])
      .filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === index)
      .map(record => record.event);

    return {
      failed: events.some(event => event.section === 'system' && event.method === 'ExtrinsicFailed'),
      transfers: events
        .filter(event => event.section === 'balances' && event.method === 'Transfer')
        .map(({ data: [from, to, amount] }) => ({ from: from.toU8a(), to: to.toU8a(), amount: amount.toBigInt() }))
    };
  }

  private async registryAt(blockHash: string): Promise<TypeRegistry> {
    const { specVersion } = await this.rpcCall('state_getRuntimeVersion', [blockHash]);
    const cached = this.registries.get(specVersion);

    if (cached) {
      return cached;
    }

    const registry = new TypeRegistry();
    registry.setMetadata(new Metadata(registry, await this.rpcCall('state_getMetadata', [blockHash])));
    this.registries.set(specVersion, registry);

    return registry;
  }

  private async rpcCall(method: string, params: unknown[], deadline: number = Date.now() + RPC_TIMEOUT_MS): Promise<any> {
    const response = await proxyFetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(RPC_TIMEOUT_MS, deadline - Date.now())))
    });

    if (!response.ok) {
      throw new Error(`TAO RPC ${method} failed with HTTP ${response.status}: ${(await response.text()).substring(0, 512)}`);
    }

    const { result, error } = await response.json() as { result?: any; error?: { code: number; message: string } };

    if (error || result === null || result === undefined) {
      throw new Error(`TAO RPC ${method} error: ${error ? `${error.code} ${error.message}` : 'empty result'}`);
    }

    return result;
  }
}
