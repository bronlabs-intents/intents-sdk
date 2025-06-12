import { BigNumber } from "ethers";
import { fromHex, toHex } from "tron-format-address";
import { TronWeb } from "tronweb";

import { Network, TransactionData } from "./index.js";
import { log } from "../utils.js";

export class TrxNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 5000;
  private tronWeb: TronWeb;

  constructor(rpcUrl: string, confirmations: number) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.tronWeb = new TronWeb({
      fullHost: rpcUrl,
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
          "content-type": "application/json",
        },
        body: JSON.stringify({ owner_address: tokenAddress, contract_address: tokenAddress, function_selector: "decimals()", parameter: "", visible: true }),
      }).then((res) => res.json()).then((res) => res.constant_result[0]);

    return parseInt(response, 16);
  }

  async getTxData(
    txHash: string,
    tokenAddress: string
  ): Promise<TransactionData | undefined> {
    const currentBlock = await fetch(`${this.rpcUrl}/wallet/getblockbylatestnum`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ num: 1 }),
      }).then((res) => res.json()).then((res) => res.block[0].block_header.raw_data.number);

    // Native token - TRX
    if (tokenAddress === "0x0") {
      const response = await fetch(`${this.rpcUrl}/wallet/gettransactionbyid`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: txHash }),
      }).then((res) => res.json());

      if (!response || response.ret[0].contractRet != "SUCCESS") {
        log.info(`Transaction ${txHash} failed`);
        return {
          to: "",
          token: "",
          amount: BigNumber.from(0),
          confirmed: true,
        };
      }

      const to = fromHex(
        response.raw_data.contract[0].parameter.value.to_address
      );
      const value = response.raw_data.contract[0].parameter.value.amount;
      const blockNumber = await fetch(
        `${this.rpcUrl}/wallet/gettransactioninfobyid`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: txHash }),
        }
      ).then((res) => res.json()).then((res) => res.blockNumber);

      log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

      return {
        to: to,
        token: tokenAddress,
        amount: BigNumber.from(value),
        confirmed: currentBlock - blockNumber >= this.confirmations,
      };
    }

    // ERC20 token
    const response = await fetch(
      `${this.rpcUrl}/wallet/gettransactioninfobyid`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: txHash }),
      }
    ).then((res) => res.json());

    if (!response || response.result != "SUCCESS") {
        log.info(`Transaction ${txHash} failed`);
        return {
            to: "",
            token: "",
            amount: BigNumber.from(0),
            confirmed: true,
        };
    }

    log.info(`Confirmations ${txHash}: ${currentBlock - response.blockNumber}`);

    return {
      to: fromHex(response.log[0].topics[3].slice(24)),
      token: fromHex(response.contract_address),
      amount: BigNumber.from(parseInt(response.log[0].data, 16)),
      confirmed: currentBlock - response.blockNumber >= this.confirmations,
    };
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {
    // Set private key
    this.tronWeb.setPrivateKey(privateKey);

    const { abi } = await this.tronWeb.trx.getContract(tokenAddress)
    
    if (tokenAddress === "0x0") {
        // Send TRX (native token)
        const tx = await this.tronWeb.trx.sendTransaction(to, value.toNumber());
        return tx.txid;
    }
    
    // Send USDT or other TRC20 tokens
    const contract = await this.tronWeb.contract(abi.entrys, tokenAddress);
    const tx = await contract.methods.transfer(to, value.toNumber()).send();
    return tx.txid;
    
  }
}
