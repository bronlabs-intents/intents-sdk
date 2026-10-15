import { Address, beginCell, Cell, internal, SendMode, toNano, TonClient, WalletContractV5R1 } from "@ton/ton";
import { keyPairFromSecretKey } from "@ton/crypto";
import { ethers } from 'ethers';

import { Network, TransactionData } from "./index.js";
import { AttestationCapable, SignatureScheme, verifyEd25519 } from '../attestation.js';
import { log, memoize, paymentFlow, settlement, sleep, traceWithinRetryWindow, Transfer, UNATTRIBUTED, withinTraceRetryWindow } from "../utils.js";
import { proxyFetch } from '../proxy.js';

const MAX_TRACE_TRANSACTIONS = 200;
const JETTON_INTERNAL_TRANSFER = "0x178d4519";

export class TonNetwork implements Network, AttestationCapable {
  private readonly client: TonClient;
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 9;
  readonly retryDelay: number = 5000;
  readonly signatureScheme = SignatureScheme.Ed25519;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;

    this.client = new TonClient({
      endpoint: rpcUrl
    });
  }

  // Pinned to WalletContractV5R1 like transfer(): a settlement from any other wallet version won't match orderFrom.
  addressFromPublicKey(publicKey: string): string {
    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: Buffer.from(ethers.getBytes(publicKey)),
    });
    return wallet.address.toString({ bounceable: false });
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
    return verifyEd25519(publicKey, signature, preimage);
  }

  matchesAddress(publicKey: string, address: string): boolean {
    return this.rawAddress(this.addressFromPublicKey(publicKey)) === this.rawAddress(address);
  }

  async ping(): Promise<void> {
    await this.request("/v3/masterchainInfo");

    const traces = await this.request(`/v3/traces?tx_hash=${encodeURIComponent(Buffer.alloc(32).toString("base64"))}&limit=1`);

    if (!Array.isArray(traces.traces)) {
      throw new Error("Indexer does not serve /v3/traces");
    }

    await this.runGetMethod(`0:${"0".repeat(64)}`, "seqno", []);
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    return memoize(`decimals-ton-${tokenAddress}`, 86400 * 1000, async () => {
      const response = await this.request(`/v3/jetton/masters?address=${encodeURIComponent(tokenAddress)}`);

      if (response.jetton_masters?.length > 0) {
        const master = response.jetton_masters[0];
        const decimals = master.jetton_content?.decimals;

        if (decimals !== undefined && decimals !== null) {
          return typeof decimals === "string" ? parseInt(decimals, 10) : Number(decimals);
        }
      }

      return 9;
    });
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string,
    _tokenId: bigint | undefined,
    senderAddress: string
  ): Promise<TransactionData | undefined> {
    const masterchainInfo = await this.request("/v3/masterchainInfo");
    const currentSeqno = masterchainInfo.last?.seqno ?? 0;

    const txResponse = await this.request(`/v3/transactions?hash=${encodeURIComponent(txHash)}&limit=1`);

    if (!txResponse.transactions?.length) {
      return;
    }

    const tx = txResponse.transactions[0];
    const txSeqno = tx.mc_block_seqno ?? currentSeqno;
    const confirmed = currentSeqno - txSeqno >= this.confirmations;
    const timestamp = typeof tx.now === 'number' ? tx.now : 0;

    log.info(`Confirmations ${txHash}: ${currentSeqno - txSeqno}`);

    const transactions = await this.traceTransactions(txHash, tx.hash, timestamp);

    if (!transactions) {
      return;
    }

    const transfers = tokenAddress === "0x0" ? this.nativeTransfers(transactions) : await this.jettonTransfers(transactions, this.rawAddress(tokenAddress));
    const paid = paymentFlow(transfers, this.rawAddress(senderAddress), this.rawAddress(recipientAddress));

    return settlement(senderAddress, recipientAddress, tokenAddress, paid, confirmed, timestamp);
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    const keyPair = this.parsePrivateKey(privateKey);

    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey
    });

    const contract = this.client.open(wallet);
    const seqno = await contract.getSeqno();

    if (tokenAddress === "0x0") {
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: Address.parse(to),
            value,
            bounce: false
          })
        ]
      });
    } else {
      const jettonWalletAddress = await this.jettonWallet(this.rawAddress(tokenAddress), wallet.address.toRawString());

      if (!jettonWalletAddress) {
        throw new Error(`Jetton wallet not found for ${wallet.address.toString()}`);
      }

      const jettonTransferBody = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(Date.now(), 64)
        .storeCoins(value)
        .storeAddress(Address.parse(to))
        .storeAddress(wallet.address)
        .storeBit(false)
        .storeCoins(toNano("0.01"))
        .storeBit(false)
        .endCell();

      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: Address.parse(jettonWalletAddress),
            value: toNano("0.05"),
            bounce: true,
            body: jettonTransferBody
          })
        ]
      });
    }

    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(2000);
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > seqno) break;
    }

    const transactions = await this.client.getTransactions(wallet.address, { limit: 1 });

    if (transactions.length === 0) {
      throw new Error("Transaction not found after confirmation");
    }

    return transactions[0].hash().toString("hex");
  }

  private parsePrivateKey(privateKey: string): { publicKey: Buffer; secretKey: Buffer } {
    const cleanKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const secretKeyBytes = Buffer.from(cleanKey, "hex");

    if (secretKeyBytes.length === 64) {
      return keyPairFromSecretKey(secretKeyBytes);
    }

    if (secretKeyBytes.length === 32) {
      const publicKey = secretKeyBytes;
      return {
        publicKey,
        secretKey: Buffer.concat([secretKeyBytes, publicKey])
      };
    }

    throw new Error(`Invalid private key length: ${secretKeyBytes.length}`);
  }

  private async traceTransactions(txHash: string, rootHash: string, timestamp: number): Promise<any[] | undefined> {
    const traceResp = await traceWithinRetryWindow(this.request(`/v3/traces?tx_hash=${encodeURIComponent(txHash)}&limit=1`), txHash, timestamp);
    const trace = traceResp?.traces?.[0];
    const fresh = withinTraceRetryWindow(timestamp);

    if (!trace?.transactions && fresh) {
      log.info(`Trace of ${txHash} is not indexed yet`);
      return;
    }

    if (!trace?.transactions || trace.trace?.tx_hash !== rootHash) {
      log.warn(`Transaction ${txHash} is not the root of an indexed trace; refusing to attribute the trace to it`);
      return [];
    }

    if (trace.is_incomplete) {
      if (fresh) {
        log.info(`Trace of ${txHash} is not complete yet`);
        return;
      }

      log.warn(`Trace of ${txHash} is still incomplete past the retry window`);
      return [];
    }

    const transactions: any[] = Object.values(trace.transactions);

    if (transactions.length > MAX_TRACE_TRANSACTIONS) {
      log.warn(`Transaction ${txHash} trace has ${transactions.length} transactions, over the attribution cap of ${MAX_TRACE_TRANSACTIONS}`);
      return [];
    }

    return transactions;
  }

  private nativeTransfers(transactions: any[]): Transfer[] {
    return transactions.flatMap((tx: any) => (tx.out_msgs ?? [])
      .filter((msg: any) => msg.destination && msg.value)
      .map((msg: any): Transfer => [this.rawAddress(tx.account), this.rawAddress(msg.destination), BigInt(msg.value)])
    );
  }

  private async jettonTransfers(transactions: any[], master: string): Promise<Transfer[]> {
    const transfers: Transfer[] = [];

    for (const tx of transactions.filter((tx: any) => !tx.description?.aborted && tx.in_msg?.opcode === JETTON_INTERNAL_TRANSFER)) {
      const decoded = tx.in_msg.message_content?.decoded;

      if (decoded?.["@type"] !== "jetton_internal_transfer") {
        log.warn(`Jetton transfer received by ${tx.account} is not decoded`);
        continue;
      }

      const wallet = this.rawAddress(tx.account);
      const owner = await this.jettonWalletOwner(wallet);

      if (!owner || await this.jettonWallet(master, owner) !== wallet) {
        continue;
      }

      const source = this.rawAddress(tx.in_msg.source);
      const from = decoded.from?.["@type"] === "addr_std" ? this.rawAddress(`${decoded.from.workchain_id}:${decoded.from.address}`) : undefined;

      if (source === master) {
        transfers.push([UNATTRIBUTED, owner, BigInt(decoded.amount.value)]);
      } else if (from && await this.jettonWallet(master, from) === source) {
        transfers.push([from, owner, BigInt(decoded.amount.value)]);
      }
    }

    return transfers;
  }

  private jettonWallet(master: string, owner: string): Promise<string | undefined> {
    return memoize(`ton-jetton-wallet-${master}-${owner}`, 86400 * 1000, async () => {
      const ownerSlice = beginCell().storeAddress(Address.parse(owner)).endCell().toBoc().toString("base64");
      const stack = await this.runGetMethod(master, "get_wallet_address", [{ type: "slice", value: ownerSlice }]);

      return stack && this.stackAddress(stack[0]);
    }, address => address !== undefined);
  }

  private jettonWalletOwner(wallet: string): Promise<string | undefined> {
    return memoize(`ton-jetton-owner-${wallet}`, 86400 * 1000, async () => {
      const stack = await this.runGetMethod(wallet, "get_wallet_data", []);

      return stack && this.stackAddress(stack[1]);
    }, address => address !== undefined);
  }

  private async runGetMethod(address: string, method: string, stack: any[]): Promise<any[] | undefined> {
    const result = await this.request("/v3/runGetMethod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, method, stack })
    });

    return result.exit_code === 0 || result.exit_code === 1 ? result.stack : undefined;
  }

  private stackAddress(item: any): string | undefined {
    try {
      return Cell.fromBase64(item.value).beginParse().loadAddress().toRawString();
    } catch {
      return undefined;
    }
  }

  private rawAddress(address: string): string {
    try {
      return Address.parse(address).toRawString();
    } catch {
      return address.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const response = await proxyFetch(this.rpcUrl + path, options as any);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed ${response.status}: ${text.substring(0, 1024)}`);
    }

    return response.json();
  }
}
