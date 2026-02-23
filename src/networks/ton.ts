import { Address, beginCell, internal, SendMode, toNano, TonClient, WalletContractV5R1 } from "@ton/ton";
import { keyPairFromSecretKey } from "@ton/crypto";

import { Network, TransactionData } from "./index.js";
import { log, memoize } from "../utils.js";
import { proxyFetch } from '../proxy.js';

export class TonNetwork implements Network {
  private readonly client: TonClient;
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 9;
  readonly retryDelay: number = 5000;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;

    this.client = new TonClient({
      endpoint: rpcUrl
    });
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    return memoize(`decimals-ton-${tokenAddress}`, 86400 * 1000, async () => {
      const response = await this.request(`/api/v3/jetton/masters?address=${encodeURIComponent(tokenAddress)}`);

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
    recipientAddress: string
  ): Promise<TransactionData | undefined> {
    const masterchainInfo = await this.request("/api/v3/masterchainInfo");
    const currentSeqno = masterchainInfo.last?.seqno ?? 0;

    const txResponse = await this.request(`/api/v3/transactions?hash=${encodeURIComponent(txHash)}&limit=1`);

    if (!txResponse.transactions?.length) {
      return;
    }

    const tx = txResponse.transactions[0];
    const txSeqno = tx.mc_block_seqno ?? currentSeqno;
    const confirmed = currentSeqno - txSeqno >= this.confirmations;

    // exit_code is in description.compute_ph.exit_code for transactionsByMessage API
    // exit_code 0 = success, 1 = alternative success
    // skipped compute phase (no compute_ph) is ok for simple transfers
    const computePh = tx.description?.compute_ph;
    const exitCode = computePh?.exit_code;
    const computeSuccess = computePh?.success;

    if (computePh && computeSuccess === false) {
      log.warn(`Transaction ${txHash} failed: exit_code=${exitCode}`);

      return {
        from: this.normalizeAddress(tx.account) || "",
        to: "",
        token: "",
        amount: 0n,
        confirmed
      };
    }

    log.info(`Confirmations ${txHash}: ${currentSeqno - txSeqno}`);

    if (tokenAddress === "0x0") {
      return this.parseNativeTransfer(tx, recipientAddress, confirmed);
    }

    return this.parseJettonTransfer(txHash, tokenAddress, recipientAddress, confirmed);
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
      const jettonWalletAddress = await this.getJettonWalletAddress(tokenAddress, wallet.address.toString());

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

    // Wait for seqno to change (transaction confirmed)
    for (let attempt = 0; attempt < 30; attempt++) {
      await this.sleep(2000);
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > seqno) break;
    }

    // Get the latest transaction hash
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

  private parseNativeTransfer(
    tx: any,
    recipientAddress: string,
    confirmed: boolean
  ): TransactionData | undefined {
    const outMsgs = tx.out_msgs || [];

    // For outgoing messages, the sender is the account that owns this transaction
    const txAccount = this.normalizeAddress(tx.account);

    for (const msg of outMsgs) {
      if (msg.destination) {
        const destAddress = this.normalizeAddress(msg.destination);

        if (this.addressesMatch(destAddress, recipientAddress)) {
          return {
            from: txAccount,
            to: destAddress,
            token: "0x0",
            amount: BigInt(msg.value || 0),
            confirmed
          };
        }
      }
    }

    // For incoming messages, the sender is the source of the in_msg
    if (tx.in_msg?.value) {
      const from = this.normalizeAddress(tx.in_msg.source);

      return {
        from,
        to: this.normalizeAddress(tx.account),
        token: "0x0",
        amount: BigInt(tx.in_msg.value),
        confirmed
      };
    }

    return;
  }

  private async parseJettonTransfer(
    txHash: string,
    tokenAddress: string,
    _recipientAddress: string,
    confirmed: boolean
  ): Promise<TransactionData | undefined> {
    const transfers = await this.request(
      `/api/v3/jetton/transfers?transaction_hash=${encodeURIComponent(txHash)}&limit=10`
    );

    if (transfers.jetton_transfers?.length > 0) {
      const transfer = transfers.jetton_transfers[0];
      const fromAddress = this.normalizeAddress(transfer.source?.address || transfer.source);
      const destAddress = this.normalizeAddress(transfer.destination?.address || transfer.destination);

      return {
        from: fromAddress,
        to: destAddress,
        token: tokenAddress,
        amount: BigInt(transfer.amount || 0),
        confirmed
      };
    }

    const transfersByMaster = await this.request(
      `/api/v3/jetton/transfers?jetton_master=${encodeURIComponent(tokenAddress)}&limit=100`
    );

    if (!transfersByMaster.jetton_transfers?.length) {
      return;
    }

    for (const transfer of transfersByMaster.jetton_transfers) {
      if (transfer.transaction_hash === txHash) {
        const fromAddress = this.normalizeAddress(transfer.source?.address || transfer.source);
        const destAddress = this.normalizeAddress(transfer.destination?.address || transfer.destination);

        return {
          from: fromAddress,
          to: destAddress,
          token: tokenAddress,
          amount: BigInt(transfer.amount || 0),
          confirmed
        };
      }
    }

    return;
  }

  private async getJettonWalletAddress(jettonMaster: string, ownerAddress: string): Promise<string> {
    const response = await this.request(
      `/api/v3/jetton/wallets?owner_address=${encodeURIComponent(ownerAddress)}&jetton_address=${encodeURIComponent(jettonMaster)}&limit=1`
    );

    if (response.jetton_wallets?.length > 0) {
      return response.jetton_wallets[0].address;
    }

    throw new Error(`Jetton wallet not found for ${ownerAddress}`);
  }

  private normalizeAddress(address: any, bounceable: boolean = false): string {
    if (!address) return "";

    let rawAddress: string;

    if (typeof address === "string") {
      rawAddress = address;
    } else if (typeof address === "object" && address.address) {
      rawAddress = address.address;
    } else {
      rawAddress = String(address);
    }

    try {
      return Address.parse(rawAddress).toString({ bounceable });
    } catch {
      return rawAddress;
    }
  }

  private addressesMatch(a: string, b: string): boolean {
    try {
      const addrA = Address.parse(a);
      const addrB = Address.parse(b);
      return addrA.equals(addrB);
    } catch {
      const normalize = (addr: string) => addr.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normalize(a) === normalize(b);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
