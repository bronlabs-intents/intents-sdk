import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { decodeErc6909TransferAmount } from '../token.js';
import { log, memoize, paymentFlow, sameAddress, settlement, traceWithinRetryWindow, Transfer } from '../utils.js';
import { proxyFetch } from '../proxy.js';

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC6909_TRANSFER_TOPIC = ethers.id('Transfer(address,address,address,uint256,uint256)');
const ERC6909_DECIMALS_SELECTOR = '0x3f47e662';
const ERC165_SUPPORTS_INTERFACE_SELECTOR = '0x01ffc9a7';
const ERC6909_INTERFACE_ID = '0x0f632fb3';
const VALUE_FRAME_TYPES = new Set(['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);
const MAX_TRACE_FRAMES = 2000;
const MAX_TRANSFER_LOGS = 500;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };

interface CallFrame {
  type: string;
  from: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: CallFrame[];
}

interface EthTransactionReceipt {
  status: string;
  from: string;
  to: string;
  blockNumber: string;
  logs: {
    address: string;
    topics: string[];
    data: string;
  }[];
}

export class EvmNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 15000;
  readonly signatureScheme = SignatureScheme.Secp256k1;

  constructor(rpcUrl: string, confirmations: number = 6) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    this.confirmations = confirmations;
  }

  async ping(): Promise<void> {
    await this.provider.getBlockNumber();

    const { error } = await this.rpc("debug_traceTransaction", [ethers.ZeroHash, { tracer: "callTracer" }]);

    if (error && (error.code === -32601 || !/transaction.*not found|cannot find transaction|unknown transaction/i.test(error.message))) {
      throw new Error(`RPC does not serve debug_traceTransaction: ${error.message}`);
    }
  }

  addressFromPublicKey(publicKey: string): string {
    return ethers.computeAddress(publicKey);
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  async supportsInterface(tokenAddress: string, interfaceId: string): Promise<boolean> {
    return memoize(`supports-interface-${this.rpcUrl}-${tokenAddress}-${interfaceId}`, 86400 * 1000, async () => {
      const { result } = await this.rpc("eth_call", [
        {
          to: tokenAddress,
          data: ERC165_SUPPORTS_INTERFACE_SELECTOR + interfaceId.slice(2).padStart(8, '0').padEnd(64, '0')
        },
        "latest"
      ]);

      return !!result && result !== "0x" && BigInt(result) !== 0n;
    });
  }

  async isErc6909(tokenAddress: string): Promise<boolean> {
    return this.supportsInterface(tokenAddress, ERC6909_INTERFACE_ID);
  }

  async getDecimals(tokenAddress: string, tokenId?: bigint): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    if (tokenId !== undefined && !(await this.isErc6909(tokenAddress))) {
      throw new Error(`Token ${tokenAddress} carries tokenId ${tokenId} but does not support the ERC6909 interface`);
    }

    const callData = tokenId !== undefined
      ? ERC6909_DECIMALS_SELECTOR + tokenId.toString(16).padStart(64, '0')
      : "0x313ce567";

    return memoize(`decimals-${this.rpcUrl}-${tokenAddress}-${tokenId ?? ''}`, 86400 * 1000, async () => {
      const { result } = await this.rpc("eth_call", [
        {
          to: tokenAddress,
          data: callData
        },
        "latest"
      ]);

      if (!result || result === "0x") {
        throw new Error(`No on-chain decimals for ${tokenAddress}${tokenId !== undefined ? ` id ${tokenId}` : ''}`);
      }

      return parseInt(result, 16);
    });
  }

  async blockTimestamp(blockNumber: string): Promise<number> {
    const { result } = await this.rpc("eth_getBlockByNumber", [blockNumber, false]);

    return result?.timestamp ? parseInt(result.timestamp, 16) : 0;
  }

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string, tokenId: bigint | undefined, senderAddress: string): Promise<TransactionData | undefined> {
    const currentBlock = await this.provider.getBlockNumber();

    const { result: receiptResult } = await this.rpc("eth_getTransactionReceipt", [txHash]);

    if (!receiptResult) {
      return;
    }

    const receipt = receiptResult as EthTransactionReceipt;

    const confirmed = (currentBlock - parseInt(receipt.blockNumber, 16)) >= this.confirmations;

    log.info(`Confirmations ${txHash}: ${currentBlock - parseInt(receipt.blockNumber, 16)}, confirmed: ${confirmed}`)

    const timestamp = await this.blockTimestamp(receipt.blockNumber);

    if (receipt.status !== '0x1') {
      log.warn(`Transaction ${txHash} failed on blockchain: ${JSON.stringify(receipt)}`);

      return settlement("", "", "", 0n, confirmed, timestamp);
    }

    const recipient = recipientAddress.toLowerCase();

    const payment = (from: string, amount: bigint, extra: Partial<TransactionData> = {}): TransactionData =>
      settlement(from, recipientAddress, tokenAddress, amount, confirmed, timestamp, { envelopeFrom: receipt.from, ...extra });

    const tokenPayment = (transferLogs: EthTransactionReceipt['logs'], decodeAmount: (data: string) => bigint, extra: Partial<TransactionData> = {}): TransactionData => {
      const transfers = this.tokenTransfers(txHash, transferLogs, decodeAmount);
      const paid = paymentFlow(transfers, senderAddress.toLowerCase(), recipient);

      if (paid > 0n) {
        return payment(senderAddress, paid, extra);
      }

      const mintedToRecipient = transfers.filter(([from, to]) => (from === ZERO_ADDRESS && to === recipient) || from === recipient);

      return payment(ZERO_ADDRESS, paymentFlow(mintedToRecipient, ZERO_ADDRESS, recipient), extra);
    };

    if (tokenAddress === "0x0") {
      return payment(senderAddress, await this.tracedNativeContribution(txHash, timestamp, senderAddress, recipientAddress));
    }

    // ERC6909 multi-token — match the 4-topic Transfer(caller, sender, receiver, id, amount) of the
    // expected id; amount is the 2nd 32-byte data word (1st is caller), NOT BigInt(data).
    if (tokenId !== undefined) {
      if (!(await this.isErc6909(tokenAddress))) {
        throw new Error(`Token ${tokenAddress} carries tokenId ${tokenId} but does not support the ERC6909 interface`);
      }

      const idHex = '0x' + tokenId.toString(16).padStart(64, '0');

      const transferLogs = receipt.logs.filter(l =>
        sameAddress(l.address, tokenAddress) &&
        sameAddress(l.topics[0], ERC6909_TRANSFER_TOPIC) &&
        l.topics.length === 4 &&
        sameAddress(l.topics[3], idHex)
      );

      return tokenPayment(transferLogs, decodeErc6909TransferAmount, { tokenId });
    }

    const transferLogs = receipt.logs.filter(l =>
      sameAddress(l.address, tokenAddress) &&
      sameAddress(l.topics[0], ERC20_TRANSFER_TOPIC) &&
      l.topics.length === 3
    );

    return tokenPayment(transferLogs, BigInt);
  }

  private tokenTransfers(txHash: string, transferLogs: EthTransactionReceipt['logs'], decodeAmount: (data: string) => bigint): Transfer[] {
    if (transferLogs.length > MAX_TRANSFER_LOGS) {
      log.warn(`Transaction ${txHash} has ${transferLogs.length} transfer logs, over the attribution cap of ${MAX_TRANSFER_LOGS}`);
      return [];
    }

    return transferLogs.map(l => [
      ('0x' + l.topics[1].slice(26)).toLowerCase(),
      ('0x' + l.topics[2].slice(26)).toLowerCase(),
      decodeAmount(l.data)
    ]);
  }

  private rpc<T = any>(method: string, params: unknown[]): Promise<RpcResponse<T>> {
    return proxyFetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params })
    }).then((res) => res.json() as Promise<RpcResponse<T>>);
  }

  private async tracedNativeContribution(txHash: string, timestamp: number, senderAddress: string, recipientAddress: string): Promise<bigint> {
    const response = await traceWithinRetryWindow(
      this.rpc<CallFrame>("debug_traceTransaction", [txHash, { tracer: "callTracer" }])
        .then((body) => {
          if (!body.result) {
            throw new Error(`Trace of ${txHash} unavailable: ${JSON.stringify(body.error ?? null)}`);
          }

          return body.result;
        }),
      txHash,
      timestamp
    );

    if (!response) {
      return 0n;
    }

    const transfers: Transfer[] = [];
    let frames = 0;

    const walk = (frame: CallFrame): boolean => {
      if (++frames > MAX_TRACE_FRAMES) {
        return false;
      }

      if (frame.error) {
        return true;
      }

      const value = frame.value ? BigInt(frame.value) : 0n;

      if (value > 0n && frame.to && VALUE_FRAME_TYPES.has(frame.type)) {
        transfers.push([frame.from.toLowerCase(), frame.to.toLowerCase(), value]);
      }

      return (frame.calls ?? []).every(walk);
    };

    if (!walk(response)) {
      log.warn(`Transaction ${txHash} trace has over ${MAX_TRACE_FRAMES} frames, over the attribution cap`);
      return 0n;
    }

    return paymentFlow(transfers, senderAddress.toLowerCase(), recipientAddress.toLowerCase());
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    const signer = new ethers.Wallet(privateKey, this.provider);

    if (tokenAddress === "0x0") {
      const { hash } = await signer.sendTransaction({ to, value });
      return hash;
    }

    const tokenContract = new ethers.Contract(tokenAddress, [
      'function transfer(address to, uint256 amount) returns (bool)'
    ], signer);

    const { hash } = await tokenContract.transfer(to, value);
    return hash;
  }
}
