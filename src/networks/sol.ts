import { Connection, Transaction, SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { createTransferInstruction, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import bs58 from "bs58";

import { Network, TransactionData } from "./index.js";
import { log } from "../utils.js";

export class SolNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 9; // SOL has 9 decimals
  readonly retryDelay: number = 5000;
  private readonly connection: Connection;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    const { result } = await fetch(this.rpcUrl, {
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
  }

  async getTxData(
    txHash: string,
    tokenAddress: string
  ): Promise<TransactionData | undefined> {
    const currentBlock = await fetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getLatestBlockhash",
        params: []
      })
    }).then((res) => res.json()).then((res) => res.result.context.slot);

    const { result } = await fetch(this.rpcUrl, {
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

    if (result.meta?.err) {
      log.warn(`Transaction ${txHash} failed on blockchain: ${result}`);

      return {
        to: "",
        token: "",
        amount: 0n,
        confirmed
      };
    }

    log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

    // Native token - SOL
    if (tokenAddress === "0x0") {
      if (Number(result.meta.postBalances[0] - result.meta.preBalances[0]) > 0) {
        return {
          to: result.transaction.message.accountKeys[0],
          token: tokenAddress,
          amount: BigInt(result.meta.postBalances[0]) - BigInt(result.meta.preBalances[0]),
          confirmed
        };
      } else {
        return {
          to: result.transaction.message.accountKeys[1],
          token: tokenAddress,
          amount: BigInt(result.meta.postBalances[1]) - BigInt(result.meta.preBalances[1]),
          confirmed
        }
      }
    }

    // ERC20 token
    const postTokenBalances = result.meta.postTokenBalances.filter((balance: any) => balance.mint === tokenAddress)
    const preTokenBalances = result.meta.preTokenBalances.filter((balance: any) => balance.mint === tokenAddress)

    const senderAddress = (() => {
      // Find the account that has less tokens in postTokenBalances than in preTokenBalances
      for (const postBalance of postTokenBalances) {
        const preBalance = preTokenBalances.find((balance: any) =>
          balance.owner === postBalance.owner
        );

        if (preBalance && BigInt(postBalance.uiTokenAmount.amount) < BigInt(preBalance.uiTokenAmount.amount)) {
          return preBalance.owner;
        }
      }

      throw new Error("No sender found");
    })();

    const postTokenBalanceOfReceiver = postTokenBalances.find((balance: any) => balance.owner != senderAddress)
    const preTokenBalanceOfReceiver = preTokenBalances.find((balance: any) => balance.owner != senderAddress)

    let preBalance = 0n
    if (preTokenBalanceOfReceiver?.uiTokenAmount.amount) {
      preBalance = BigInt(preTokenBalanceOfReceiver.uiTokenAmount.amount)
    }

    return {
      to: postTokenBalanceOfReceiver.owner,
      token: postTokenBalanceOfReceiver.mint,
      amount: BigInt(postTokenBalanceOfReceiver.uiTokenAmount.amount) - preBalance,
      confirmed
    };
  }

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
      true // Allow creating a token account for the receiver if it doesn't exist
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
