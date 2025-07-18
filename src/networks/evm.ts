import { BigNumber, ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';

interface EthTransactionReceipt {
  to: string;
  logs: {
    topics: string[];
    data: string;
  }[];
  blockNumber: number;
}

export class EvmNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 5000;

  constructor(rpcUrl: string, confirmations: number = 6) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.confirmations = confirmations;
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
        method: "eth_call",
        params: [
          {
            to: tokenAddress,
            data: "0x313ce567"
          },
          "latest"
        ]
      })
    });

    const { result } = await response.json();
    return parseInt(result, 16);
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {
    const currentBlock = await this.provider.getBlockNumber();

    // Native token - ETH
    if (tokenAddress === "0x0") {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "eth_getTransactionByHash",
          params: [txHash]
        })
      });

      const { result } = await response.json();

      if (!result || result.status == "0x0") {
        log.info(`Transaction ${txHash} failed`);
        return {
          to: "",
          token: "",
          amount: BigNumber.from(0),
          confirmed: true
        };
      }

      const { to, value, blockNumber } = result;

      log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`)

      return {
        to: to,
        token: tokenAddress,
        amount: BigNumber.from(value),
        confirmed: (currentBlock - blockNumber) >= this.confirmations
      };
    }

    // ERC20 token
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "eth_getTransactionReceipt",
        params: [txHash]
      })
    });

    const { result } = await response.json();

    if (!result || result.status == "0x0") {
      log.info(`Transaction ${txHash} failed`);
      return {
        to: "",
        token: "",
        amount: BigNumber.from(0),
        confirmed: true
      };
    }

    const receipt = result as EthTransactionReceipt;

    log.info(`Confirmations ${txHash}: ${currentBlock - receipt.blockNumber}`)

    return {
      to: '0x' + receipt.logs[0].topics[2].slice(26),
      token: receipt.to,
      amount: BigNumber.from(receipt.logs[0].data),
      confirmed: (currentBlock - receipt.blockNumber) >= this.confirmations
    };
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {
    const signer = new ethers.Wallet(privateKey, this.provider);

    if (tokenAddress === "0x0") {
      const { hash } = await signer.sendTransaction({ to, value });
      return hash;
    }

    const tokenContract = new ethers.Contract(tokenAddress, [
      'function transfer(address to, uint256 amount) returns (bool)'
    ], signer);

    const { hash } = await tokenContract.transfer(to, value);
    return hash;
  }
}
