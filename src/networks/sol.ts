import { Connection, Transaction, SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { createTransferInstruction, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { ethers } from 'ethers';

import { Network, TransactionData } from "./index.js";
import { AttestationCapable, SignatureScheme, verifyEd25519 } from '../attestation.js';
import { addDelta, log, memoize, provableContribution, sameAddress, settlement, UNATTRIBUTED } from "../utils.js";
import { proxyFetch } from '../proxy.js';

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

function tokenDeltasByOwner(preTokenBalances: any[], postTokenBalances: any[]): Map<string, bigint> {
  const accounts = new Map<number, { owner?: string; delta: bigint }>();

  for (const [balances, sign] of [[preTokenBalances, -1n], [postTokenBalances, 1n]] as const) {
    for (const balance of balances) {
      const account = accounts.get(balance.accountIndex) ?? { delta: 0n };

      account.owner = account.owner ?? balance.owner;
      account.delta += sign * BigInt(balance.uiTokenAmount.amount);
      accounts.set(balance.accountIndex, account);
    }
  }

  const deltas = new Map<string, bigint>();

  for (const [accountIndex, { owner, delta }] of accounts) {
    addDelta(deltas, owner ?? `account-${accountIndex}`, delta);
  }

  const supplyChange = [...deltas.values()].reduce((total, delta) => total + delta, 0n);

  if (supplyChange > 0n) {
    addDelta(deltas, UNATTRIBUTED, -supplyChange);
  }

  return deltas;
}

export class SolNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 9;
  readonly retryDelay: number = 5000;
  readonly signatureScheme = SignatureScheme.Ed25519;
  private readonly connection: Connection;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
  }

  async ping(): Promise<void> {
    await this.connection.getSlot();
  }

  addressFromPublicKey(publicKey: string): string {
    const bytes = ethers.getBytes(publicKey);

    if (bytes.length !== 32) {
      throw new Error(`Invalid Solana public key length: ${bytes.length} (expected 32)`);
    }

    return new PublicKey(Buffer.from(bytes)).toBase58();
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
    return verifyEd25519(publicKey, signature, preimage);
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    return memoize(`decimals-sol-${tokenAddress}`, 86400 * 1000, async () => {
      const { result } = await proxyFetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "getAccountInfo",
          params: [tokenAddress, {
            "encoding": "jsonParsed"
          }]
        })
      }).then((res) => res.json());

      return result.value.data.parsed.info.decimals;
    });
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string,
    _tokenId: bigint | undefined,
    senderAddress: string
  ): Promise<TransactionData | undefined> {
    const currentBlock = await proxyFetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getLatestBlockhash",
        params: []
      })
    }).then((res) => res.json()).then((res) => res.result.context.slot);

    const { result } = await proxyFetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getTransaction",
        params: [txHash, {
          "commitment": "confirmed",
          "maxSupportedTransactionVersion": 0,
          "encoding": "json"
        }]
      })
    }).then((res) => res.json());

    if (!result) return;

    const blockNumber = result.slot || currentBlock;
    const confirmed = currentBlock - blockNumber >= this.confirmations
    const timestamp = typeof result.blockTime === 'number' ? result.blockTime : 0;

    if (result.meta?.err) {
      log.warn(`Transaction ${txHash} failed on blockchain: ${result}`);

      return settlement("", "", "", 0n, confirmed, timestamp);
    }

    log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

    const accountKeys: string[] = [
      ...result.transaction.message.accountKeys,
      ...(result.meta.loadedAddresses?.writable ?? []),
      ...(result.meta.loadedAddresses?.readonly ?? [])
    ];

    if (tokenAddress === "0x0") {
      return settlement(senderAddress, recipientAddress, tokenAddress, this.nativeContribution(result.meta, accountKeys, senderAddress, recipientAddress), confirmed, timestamp);
    }

    const deltas = tokenDeltasByOwner(
      result.meta.preTokenBalances.filter((balance: any) => balance.mint === tokenAddress),
      result.meta.postTokenBalances.filter((balance: any) => balance.mint === tokenAddress)
    );

    const payers = new Set([...deltas.keys()].filter(owner => sameAddress(owner, senderAddress)));
    const paid = provableContribution(deltas, payers, recipientAddress);

    return paid > 0n
      ? settlement(senderAddress, recipientAddress, tokenAddress, paid, confirmed, timestamp)
      : settlement("", recipientAddress, tokenAddress, provableContribution(deltas, new Set([...payers, UNATTRIBUTED]), recipientAddress), confirmed, timestamp, { envelopeFrom: accountKeys[0] });
  }

  private nativeContribution(meta: any, accountKeys: string[], senderAddress: string, recipientAddress: string): bigint {
    const deltas = new Map<string, bigint>();

    accountKeys.forEach((key, i) => addDelta(deltas, key, BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i])));
    addDelta(deltas, accountKeys[0], BigInt(meta.fee ?? 0));

    const payers = new Set(accountKeys.filter(key => sameAddress(key, senderAddress)));
    const ownedBy = (balance: any) => !!balance?.owner && sameAddress(balance.owner, senderAddress);

    for (const pre of (meta.preTokenBalances ?? []).filter((balance: any) => balance.mint === WRAPPED_SOL_MINT)) {
      const post = (meta.postTokenBalances ?? []).find((balance: any) => balance.accountIndex === pre.accountIndex);

      if (ownedBy(pre) && (!post || ownedBy(post))) {
        payers.add(accountKeys[pre.accountIndex]);
      }
    }

    return provableContribution(deltas, payers, recipientAddress);
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    const keypair = this.base58ToKeypair(privateKey);

    if (tokenAddress === "0x0") {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(to),
          lamports: value
        })
      );

      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash

      return await this.connection.sendTransaction(
        transaction,
        [keypair]
      );
    }

    const senderTokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      keypair,
      new PublicKey(tokenAddress),
      keypair.publicKey
    );

    const receiverTokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      keypair,
      new PublicKey(tokenAddress),
      new PublicKey(to),
      true
    );

    const transaction = new Transaction().add(
      createTransferInstruction(
        senderTokenAccount.address,
        receiverTokenAccount.address,
        keypair.publicKey,
        value
      )
    );

    transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash

    return await this.connection.sendTransaction(
      transaction,
      [keypair]
    );
  }

  private base58ToKeypair(base58PrivateKey: string): Keypair {
    try {
      const privateKeyBuffer = bs58.decode(base58PrivateKey);
      return Keypair.fromSecretKey(privateKeyBuffer);
    } catch (error) {
      throw new Error("Invalid base58 private key.");
    }
  }
}
