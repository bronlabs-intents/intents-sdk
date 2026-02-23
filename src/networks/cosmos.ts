import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import { decodeTxRaw, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';

export class CosmosNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly nativeDenom: string;
  private readonly confirmations: number;
  readonly retryDelay: number = 15000;
  private readonly bech32: string;
  private readonly gasPrice: number;

  constructor(rpcUrl: string, nativeDenom: string, bech32: string, gasPrice: number, confirmations: number = 1) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.gasPrice = gasPrice;
    this.nativeDenom = nativeDenom;
    this.bech32 = bech32
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    let denom = tokenAddress;
    if (tokenAddress === "0x0") {
      denom = this.nativeDenom;
    }

    const firstLetter = denom[0];
    if (firstLetter === 'u') {
      // micro
      return 6;
    }

    if (firstLetter === 'a') {
      // atto
      return 18;
    }

    if (firstLetter === 'n') {
      // nano
      return 9;
    }

    return 0;
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {
    const client = await StargateClient.connect(this.rpcUrl)
    const resp = await client.getTx(txHash);

    if (!resp) {
      return;
    }

    if (resp.code !== 0) {
      log.warn(`Transaction ${txHash} failed on blockchain: ${JSON.stringify(resp)}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false
      }
    }

    const decodedTx = decodeTxRaw(resp.tx)

    const txMessage = decodedTx.body.messages.find(
      (message) =>
        message.typeUrl === '/cosmos.bank.v1beta1.MsgSend'
    )

    if (!txMessage) {
      log.warn(`Transaction ${txHash} has no MsgSend message: ${JSON.stringify(resp)}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false
      }
    }

    const decodedMsg = MsgSend.decode(txMessage.value)

    let denom = tokenAddress
    // Native token - specified denom
    if (tokenAddress === "0x0") {
      denom = this.nativeDenom;
    }

    const messageAmount = decodedMsg.amount.find((a: any) => a.denom === denom);

    if (!messageAmount) {
      log.warn(`Transaction ${txHash} has no amount for denom ${denom}: ${JSON.stringify(resp)}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false
      }
    }

    const currentBlockResp = await client.getBlock()
    const currentBlock = currentBlockResp.header.height

    const txBlock = resp.height

    const confirmed = (currentBlock - txBlock) >= this.confirmations;

    log.info(`Confirmations ${txHash}: ${currentBlock}, confirmed: ${confirmed}`)

    return {
      from: decodedMsg.fromAddress,
      to: decodedMsg.toAddress,
      token: tokenAddress,
      amount: BigInt(messageAmount.amount),
      confirmed: confirmed
    }
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string) {
    // 1) Create wallet/signer
    const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(privateKey, 'hex'), this.bech32);
    const [account] = await wallet.getAccounts();
    const sender = account.address;

    // 2) Connect signing client
    const gasPrice = GasPrice.fromString(`${this.gasPrice}${this.nativeDenom}`); // chain-specific denom + price
    const client = await SigningStargateClient.connectWithSigner(this.rpcUrl, wallet, {gasPrice});

    const denom = tokenAddress === "0x0" ? this.nativeDenom : tokenAddress;

    // 3) Build amount (in *base* denom)
    const amount = [{denom, amount: value.toString()}];

    // CosmosJs simulates tx and do transfer
    const resultAuto = await client.sendTokens(sender, to, amount, "auto");

    return resultAuto.transactionHash
  }
}
