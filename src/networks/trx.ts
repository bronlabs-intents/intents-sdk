import { fromHex, toHex } from "tron-format-address";
import { TronWeb } from "tronweb";

import { Network, TransactionData } from "./index.js";
import { log, memoize } from "../utils.js";
import { proxyFetch } from '../proxy.js';

const TRC20_TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const addrBody = (s: string): string => (s || "").replace(/^0x/, "").toLowerCase().slice(-40);

export class TrxNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly authHeaders: Record<string, string> = {};
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 6;
  readonly retryDelay: number = 10000;
  private tronWeb: TronWeb;

  constructor(rpcUrl: string, confirmations: number = 20) {
    if (rpcUrl.includes('@')) {
      const [rpcUrlPart, apiKey] = rpcUrl.split('@', 2);

      this.rpcUrl = rpcUrlPart;
      this.authHeaders = { 'x-api-key': apiKey };
    } else {
      this.rpcUrl = rpcUrl;
    }

    this.confirmations = confirmations;

    this.tronWeb = new TronWeb({
      fullHost: rpcUrl,
      headers: this.authHeaders
    });
  }

  async ping(): Promise<void> {
    await this.request('/wallet/getnowblock', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    return memoize(`decimals-trx-${tokenAddress}`, 86400 * 1000, async () => {
      const response = await this.request(`/wallet/triggerconstantcontract`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ owner_address: tokenAddress, contract_address: tokenAddress, function_selector: "decimals()", parameter: "", visible: true })
      });

      return parseInt(response.constant_result[0], 16);
    });
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string
  ): Promise<TransactionData | undefined> {
    const currentBlock = await this.request(`/wallet/getblockbylatestnum`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ num: 1 })
    }).then((res) => res.block[0].block_header.raw_data.number);

    // Native token - TRX
    if (tokenAddress === "0x0") {
      const response = await this.request(`/wallet/gettransactionbyid`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ value: txHash })
      });

      if (!response) return;

      const blockNumber = await this.request(
        `/wallet/gettransactioninfobyid`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ value: txHash })
        }
      ).then((res) => res.blockNumber);

      const confirmed = currentBlock - blockNumber >= this.confirmations;

      if (response.ret[0].contractRet != "SUCCESS") {
        log.warn(`Transaction ${txHash} failed on blockchain: ${response}`);

        return {
          from: "",
          to: "",
          token: "",
          amount: 0n,
          confirmed
        };
      }

      log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

      const contract = response.raw_data?.contract?.[0];

      if (contract?.type !== "TransferContract") {
        log.warn(`Transaction ${txHash} is not a native TRX transfer: ${contract?.type}`);

        return {
          from: "",
          to: "",
          token: "",
          amount: 0n,
          confirmed
        };
      }

      return {
        from: fromHex(contract.parameter.value.owner_address),
        to: fromHex(contract.parameter.value.to_address),
        token: tokenAddress,
        amount: BigInt(contract.parameter.value.amount),
        confirmed
      };
    }

    // TRC20 token
    const response = await this.request(
      `/wallet/gettransactioninfobyid`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ value: txHash })
      }
    );

    if (!response || !response.receipt) return;

    const confirmed = currentBlock - response.blockNumber >= this.confirmations;

    if (response.receipt.result != "SUCCESS") {
      log.warn(`Transaction ${txHash} failed on blockchain: ${response}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed
      };
    }

    // TRC20 — trust only a Transfer emitted by the token contract itself, to the expected
    // recipient. Reading log[0] blindly lets approve() / events from other contracts satisfy
    // validation with no real transfer.
    const tokenBody = addrBody(toHex(tokenAddress));
    const recipientBody = addrBody(toHex(recipientAddress));

    const transferLog = (response.log || []).find((l: any) =>
      addrBody(l.address) === tokenBody &&
      (l.topics?.[0] || "").replace(/^0x/, "").toLowerCase() === TRC20_TRANSFER_TOPIC &&
      l.topics?.length === 3 &&
      addrBody(l.topics[2]) === recipientBody
    );

    if (!transferLog) {
      log.warn(`Transaction ${txHash} has no TRC20 Transfer of ${tokenAddress} to ${recipientAddress}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed
      };
    }

    const amountHex = (transferLog.data || "").replace(/^0x/, "");

    return {
      from: fromHex("0x" + addrBody(transferLog.topics[1])),
      to: fromHex("0x" + addrBody(transferLog.topics[2])),
      token: fromHex("0x" + tokenBody),
      amount: amountHex ? BigInt("0x" + amountHex) : 0n,
      confirmed
    };
  }

  /**
   * @deprecated Signs from a raw private key — do not use in production. Kept for local tooling/tests.
   */
  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
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

  private async request(url: string, options?: RequestInit): Promise<any> {
    const resp = await proxyFetch(this.rpcUrl + url, {
      ...options,
      headers: { ...this.authHeaders, ...(options?.headers as Record<string, string>) }
    } as any);

    if (!resp.ok) {
      throw new Error(`Request error ${resp.status}: ${(await resp.text()).substring(0, 1024)}`);
    }

    try {
      return resp.json();
    } catch (err) {
      const text = await resp.text();
      throw new Error(`Invalid json response ${resp.status}: ${text.substring(0, 1024)}...`);
    }
  }
}
