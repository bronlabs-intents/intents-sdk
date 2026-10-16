import { Address, beginCell, Cell, internal, SendMode, toNano, TonClient, WalletContractV5R1 } from "@ton/ton";
import { keyPairFromSecretKey } from "@ton/crypto";
import { ethers } from 'ethers';

import { Network, TransactionData } from "./index.js";
import { AttestationCapable, SignatureScheme, verifyEd25519 } from '../attestation.js';
import { directPayment, log, memoize, settlement, sleep, Transfer } from "../utils.js";
import { proxyFetch } from '../proxy.js';

const MAX_CHAIN_TRANSACTIONS = 200;
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

    const consumers = await this.request(`/v3/transactionsByMessage?msg_hash=${encodeURIComponent(Buffer.alloc(32).toString("base64"))}&direction=in&limit=1`);
    const getMethod = await this.runGetMethod(`0:${"0".repeat(64)}`, "seqno", []);

    if (!Array.isArray(consumers.transactions) || typeof getMethod.exit_code !== "number") {
      throw new Error("Indexer does not serve /v3/transactionsByMessage and /v3/runGetMethod");
    }
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

    const transactions = await this.chainTransactions(tx);
    const payer = this.rawAddress(senderAddress);
    const recipient = this.rawAddress(recipientAddress);

    const paid = tokenAddress === "0x0"
      ? directPayment(this.nativeTransfers(transactions), payer, recipient)
      : await this.jettonPayment(transactions, this.rawAddress(tokenAddress), payer, recipient);

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

  private async chainTransactions(root: any): Promise<any[]> {
    const transactions = [root];

    for (let i = 0; i < transactions.length && transactions.length < MAX_CHAIN_TRANSACTIONS; i++) {
      for (const msg of transactions[i].out_msgs ?? []) {
        if (!msg.destination) {
          continue;
        }

        const { transactions: [consumer] } = await this.request(`/v3/transactionsByMessage?msg_hash=${encodeURIComponent(msg.hash)}&direction=in&limit=1`);

        if (!consumer) {
          throw new Error(`Message ${msg.hash} from ${transactions[i].account} is not processed yet`);
        }

        transactions.push(consumer);
      }
    }

    return transactions;
  }

  private nativeTransfers(transactions: any[]): Transfer[] {
    return transactions.flatMap((tx: any) => (tx.out_msgs ?? [])
      .filter((msg: any) => msg.destination && msg.value)
      .map((msg: any): Transfer => [this.rawAddress(tx.account), this.rawAddress(msg.destination), BigInt(msg.value)])
    );
  }

  private async jettonPayment(transactions: any[], master: string, payer: string, recipient: string): Promise<bigint> {
    const transfers = transactions
      .filter((tx: any) => !tx.description?.aborted && tx.in_msg?.opcode === JETTON_INTERNAL_TRANSFER)
      .map((tx: any): Transfer => [this.rawAddress(tx.in_msg.source), this.rawAddress(tx.account), Cell.fromBase64(tx.in_msg.message_content.body).beginParse().skip(96).loadCoins()]);

    return directPayment(transfers, await this.jettonWallet(master, payer), await this.jettonWallet(master, recipient));
  }

  private jettonWallet(master: string, owner: string): Promise<string> {
    return memoize(`ton-jetton-wallet-${master}-${owner}`, 86400 * 1000, async () => {
      const ownerSlice = beginCell().storeAddress(Address.parse(owner)).endCell().toBoc().toString("base64");
      const { exit_code, stack } = await this.runGetMethod(master, "get_wallet_address", [{ type: "slice", value: ownerSlice }]);

      if (exit_code !== 0 && exit_code !== 1) {
        throw new Error(`get_wallet_address of ${master} failed with exit code ${exit_code}`);
      }

      return Cell.fromBase64(stack[0].value).beginParse().loadAddress().toRawString();
    });
  }

  private runGetMethod(address: string, method: string, stack: any[]): Promise<any> {
    return this.request("/v3/runGetMethod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, method, stack })
    });
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
