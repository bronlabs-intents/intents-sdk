import { BigNumberish } from "ethers";
import { fromHex } from "tron-format-address";
import { TronWeb } from "tronweb";

import { Network, TransactionData } from "./index.js";
import { log } from "../utils.js";

export class TrxNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 6;
  readonly retryDelay: number = 5000;
  private tronWeb: TronWeb;

  constructor(rpcUrl: string, confirmations: number = 20) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.tronWeb = new TronWeb({
      fullHost: rpcUrl
    });
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    const response = await fetch(`${this.rpcUrl}/wallet/triggerconstantcontract`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ owner_address: tokenAddress, contract_address: tokenAddress, function_selector: "decimals()", parameter: "", visible: true })
    }).then((res) => res.json());

    return parseInt(response.constant_result[0], 16);
  }

  async getTxData(
    txHash: string,
    tokenAddress: string
  ): Promise<TransactionData | undefined> {
    const currentBlock = await fetch(`${this.rpcUrl}/wallet/getblockbylatestnum`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ num: 1 })
    }).then((res) => res.json()).then((res) => res.block[0].block_header.raw_data.number);

    // Native token - TRX
    if (tokenAddress === "0x0") {
      const response = await fetch(`${this.rpcUrl}/wallet/gettransactionbyid`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ value: txHash })
      }).then((res) => res.json());

      if (!response) return;

      const blockNumber = await fetch(
        `${this.rpcUrl}/wallet/gettransactioninfobyid`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ value: txHash })
        }
      ).then((res) => res.json()).then((res) => res.blockNumber);

      const confirmed = currentBlock - blockNumber >= this.confirmations;

      if (response.ret[0].contractRet != "SUCCESS") {
        log.warn(`Transaction ${txHash} failed on blockchain: ${response}`);

        return {
          to: "",
          token: "",
          amount: 0,
          confirmed
        };
      }

      log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

      return {
        to: fromHex(response.raw_data.contract[0].parameter.value.to_address),
        token: tokenAddress,
        amount: Number(response.raw_data.contract[0].parameter.value.amount),
        confirmed
      };
    }

    // ERC20 token
    const response = await fetch(
      `${this.rpcUrl}/wallet/gettransactioninfobyid`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ value: txHash })
      }
    ).then((res) => res.json());

    if (!response) return;

    const confirmed = currentBlock - response.blockNumber >= this.confirmations;

    if (response.receipt.result != "SUCCESS") {
      log.warn(`Transaction ${txHash} failed on blockchain: ${response}`);

      return {
        to: "",
        token: "",
        amount: 0,
        confirmed
      };
    }

    return {
      to: fromHex("0x" + response.log[0].topics[2].toString().slice(24)),
      token: fromHex(response.contract_address),
      amount: Number(parseInt(response.log[0].data, 16)),
      confirmed
    };
  }

  async transfer(privateKey: string, to: string, value: BigNumberish, tokenAddress: string): Promise<string> {
    // Set private key
    this.tronWeb.setPrivateKey(privateKey);

    if (tokenAddress === "0x0") {
      // Send TRX (native token)
      const tx = await this.tronWeb.trx.sendTransaction(to, Number(value));
      return tx.txid;
    }

    const { abi } = await this.tronWeb.trx.getContract(tokenAddress)

    // Send USDT or other TRC20 tokens
    const contract = this.tronWeb.contract(abi.entrys, tokenAddress);
    return await contract.methods.transfer(to, Number(value)).send();
  }
}
