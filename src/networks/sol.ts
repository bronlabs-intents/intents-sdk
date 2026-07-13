import { Connection, Transaction, SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { createTransferInstruction, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { ethers } from 'ethers';

import { Network, TransactionData } from "./index.js";
import { AttestationCapable, SignatureScheme, verifyEd25519 } from '../attestation.js';
import { log, memoize } from "../utils.js";
import { proxyFetch } from '../proxy.js';

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
    recipientAddress: string
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

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed,
        timestamp
      };
    }

    log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

    // `from` must be the account that actually FUNDED the transfer, not accountKeys[0] (the fee
    // payer). Returning the fee payer lets an attacker fund a settlement from an address they don't
    // control while signing with a throwaway fee payer that derives to the declared orderFrom —
    // the oracle's senderValid would then check the wrong account.
    const accountKeys: string[] = result.transaction.message.accountKeys;
    const numSigners: number = result.transaction.message.header?.numRequiredSignatures ?? 1;
    const isSigner = (i: number) => i < numSigners;

    if (tokenAddress === "0x0") {
      const idx = accountKeys.findIndex((key: string) => key === recipientAddress);

      if (idx === -1) {
        return {
          from: "",
          to: "",
          token: "",
          amount: 0n,
          confirmed,
          timestamp
        };
      }

      const amount = BigInt(result.meta.postBalances[idx]) - BigInt(result.meta.preBalances[idx]);

      // funder = a signing account (other than the recipient) whose lamports dropped by at least the
      // credited amount. Attribution must be unambiguous: with several qualifying signers we cannot
      // tell which one funded the transfer, so fail closed (empty from → senderValid fails).
      const funders: string[] = [];
      for (let i = 0; i < accountKeys.length; i++) {
        if (i === idx || !isSigner(i)) {
          continue;
        }
        const decrease = BigInt(result.meta.preBalances[i]) - BigInt(result.meta.postBalances[i]);
        if (decrease >= amount) {
          funders.push(accountKeys[i]);
        }
      }

      const from = funders.length === 1 ? funders[0] : "";

      return {
        from,
        to: accountKeys[idx],
        token: tokenAddress,
        amount,
        confirmed,
        timestamp
      };
    }

    // ERC20 token
    const postTokenBalances = result.meta.postTokenBalances.filter((balance: any) => balance.mint === tokenAddress)
    const preTokenBalances = result.meta.preTokenBalances.filter((balance: any) => balance.mint === tokenAddress)

    const senderAddress = (() => {
      for (const postBalance of postTokenBalances) {
        const preBalance = preTokenBalances.find((balance: any) =>
          balance.owner === postBalance.owner
        );

        if (preBalance && BigInt(postBalance.uiTokenAmount.amount) < BigInt(preBalance.uiTokenAmount.amount)) {
          return preBalance.owner;
        }
      }

      return "";
    })();

    const postTokenBalanceOfReceiver = postTokenBalances.find((balance: any) => balance.owner === recipientAddress)
    const preTokenBalanceOfReceiver = preTokenBalances.find((balance: any) => balance.owner === recipientAddress)

    if (!senderAddress || !postTokenBalanceOfReceiver) {
      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed,
        timestamp
      };
    }

    let preBalance = 0n
    if (preTokenBalanceOfReceiver?.uiTokenAmount.amount) {
      preBalance = BigInt(preTokenBalanceOfReceiver.uiTokenAmount.amount)
    }

    // `from` is the token-account owner whose balance dropped (computed above), required to be a
    // signer of the tx — not accountKeys[0]. A non-signing funder means we can't bind the payment to
    // the attester, so reject (empty from → senderValid fails).
    const senderIsSigner = accountKeys.slice(0, numSigners).includes(senderAddress);

    return {
      from: senderIsSigner ? senderAddress : "",
      to: postTokenBalanceOfReceiver.owner,
      token: postTokenBalanceOfReceiver.mint,
      amount: BigInt(postTokenBalanceOfReceiver.uiTokenAmount.amount) - preBalance,
      confirmed,
      timestamp
    };
  }

  /**
   * @deprecated Signs from a raw private key — do not use in production. Kept for local tooling/tests.
   */
  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    const keypair = this.base58ToKeypair(privateKey);

    if (tokenAddress === "0x0") {
      // Send SOL (native token)
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
