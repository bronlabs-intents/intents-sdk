import { BigNumber } from "ethers";
import { Connection, PublicKey, Transaction, SystemProgram, Keypair } from "@solana/web3.js";
import { createTransferInstruction, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";

import { Network, TransactionData } from "./index.js";
import { log } from "../utils.js";
import bs58 from "bs58";

export class SolNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 9; // SOL has 9 decimals
  readonly retryDelay: number = 5000;
  private connection: Connection;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getAccountInfo",
        params: [tokenAddress, {                         
          "encoding": "jsonParsed"
        }]
      })
    });

    const { result } = await response.json();
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

    const response = await fetch(this.rpcUrl, {
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
    }).then((res) => res.json()).then((res) => res.result);

    if (!response || response.meta?.err) {
      log.info(`Transaction ${txHash} failed`);
      return {
        to: "",
        token: "",
        amount: BigNumber.from(0),
        confirmed: true,
      };
    }

    const blockNumber = response.slot;
    log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

    // Native token - SOL
    if (tokenAddress === "0x0") {
      return {
        to: response.transaction.message.accountKeys[1],
        token: tokenAddress,
        amount: BigNumber.from(response.meta.postBalances[1] - response.meta.preBalances[1]),
        confirmed: currentBlock - blockNumber >= this.confirmations,
      };
    }

    // ERC20 token
    return {
      to: response.meta.postTokenBalances[1].owner,
      token: response.meta.postTokenBalances[0].mint,
      amount: BigNumber.from(response.meta.postTokenBalances[1].uiTokenAmount.amount - response.meta.preTokenBalances[1].uiTokenAmount.amount),
      confirmed: currentBlock - blockNumber >= this.confirmations,
    };
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {
    
    const keypair = this.base58ToKeypair(privateKey);
    const toPubkey = new PublicKey(to);

    if (tokenAddress === "0x0") {
      // Send SOL (native token)
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: toPubkey,
          lamports: value.toNumber(),
        })
      );
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash

      const signature = await this.connection.sendTransaction(
        transaction,
        [keypair]
      );

      return signature;
    }

    const senderTokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      keypair,
      new PublicKey(tokenAddress),
      keypair.publicKey,
    );

    const receiverTokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      keypair,
      new PublicKey(tokenAddress),
      new PublicKey(to),
      true, // Allow creating a token account for the receiver if it doesn't exist
    );

    const transaction = new Transaction().add(
      createTransferInstruction(
        senderTokenAccount.address,
        receiverTokenAccount.address,
        keypair.publicKey, 
        value.toNumber()
      )
    );
    transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash

    const signature = await this.connection.sendTransaction(
      transaction,
      [keypair]
    );

    return signature;
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
