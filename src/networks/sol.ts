import { BigNumber } from "ethers";
import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createTransferInstruction } from "@solana/spl-token";

import { Network, TransactionData } from "./index.js";
import { log } from "../utils.js";

export class SolNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 9; // SOL has 9 decimals
  readonly retryDelay: number = 5000;
  private connection: Connection;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.connection = new Connection(rpcUrl, 'confirmed');
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
    }).then((res) => res.json()).then((res) => res.result.value.lastValidBlockHeight);

    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getTransaction",
        params: [txHash]
      })
    }).then((res) => res.json());

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
      to: response.meta.postTokenBalances[0].owner,
      token: response.meta.postTokenBalances[0].mint,
      amount: BigNumber.from(response.meta.postTokenBalances[0].uiTokenAmount.amount),
      confirmed: currentBlock - blockNumber >= this.confirmations,
    };
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {
    const keypair = Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
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

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [keypair]
      );
      return signature;
    }

    // Send SPL tokens
    const mint = new PublicKey(tokenAddress);
    const fromTokenAccount = await getAssociatedTokenAddress(
      mint,
      keypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const toTokenAccount = await getAssociatedTokenAddress(
      mint,
      toPubkey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const transaction = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        keypair.publicKey,
        value.toNumber()
      )
    );

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [keypair]
    );
    return signature;
  }
}
