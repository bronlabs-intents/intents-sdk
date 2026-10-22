import { fromHex, toHex } from "tron-format-address";
import { TronWeb } from "tronweb";
import { ethers } from 'ethers';

import { Network, TransactionData } from "./index.js";
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { directPayment, log, memoize, settlement, Transfer, unpaid } from "../utils.js";
import { proxyFetch } from '../proxy.js';

const TRC20_TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const VALUE_TRANSFER_NOTES = new Set(["call", "create", "suicide"]);

const addrBody = (s: string): string => (s || "").replace(/^0x/, "").toLowerCase().slice(-40);

const base58Body = (address: string): string | undefined => {
  try {
    return addrBody(toHex(address));
  } catch {
    return undefined;
  }
};

export class TrxNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly authHeaders: Record<string, string> = {};
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 6;
  readonly retryDelay: number = 10000;
  readonly signatureScheme = SignatureScheme.Secp256k1;
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

  addressFromPublicKey(publicKey: string): string {
    return fromHex('41' + ethers.computeAddress(publicKey).slice(2));
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
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
    recipientAddress: string,
    _tokenId: bigint | undefined,
    senderAddress: string
  ): Promise<TransactionData | undefined> {
    const currentBlock = await this.request(`/wallet/getblockbylatestnum`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ num: 1 })
    }).then((res) => res.block[0].block_header.raw_data.number);

    const payerBody = base58Body(senderAddress);
    const recipientBody = base58Body(recipientAddress);
    const paid = (transfers: Transfer[]): bigint => payerBody && recipientBody ? directPayment(transfers, payerBody, recipientBody) : 0n;

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

      const info = await this.request(
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

      const blockNumber = info.blockNumber;
      const confirmed = currentBlock - blockNumber >= this.confirmations;
      const timestamp = info.blockTimeStamp ? Math.floor(info.blockTimeStamp / 1000) : 0;

      if (response.ret[0].contractRet != "SUCCESS") {
        log.warn(`Transaction ${txHash} failed on blockchain: ${response}`);

        return unpaid(confirmed, timestamp);
      }

      log.info(`Confirmations ${txHash}: ${currentBlock - blockNumber}`);

      const contract = response.raw_data?.contract?.[0];

      return settlement(senderAddress, recipientAddress, tokenAddress, paid(this.nativeTransfers(txHash, contract, info.internal_transactions ?? [])), confirmed, timestamp, { txId: info.id });
    }

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
    const timestamp = response.blockTimeStamp ? Math.floor(response.blockTimeStamp / 1000) : 0;

    if (response.receipt.result != "SUCCESS") {
      log.warn(`Transaction ${txHash} failed on blockchain: ${response}`);

      return unpaid(confirmed, timestamp);
    }

    const tokenBody = addrBody(toHex(tokenAddress));

    const transfers: Transfer[] = (response.log || [])
      .filter((l: any) =>
        addrBody(l.address) === tokenBody &&
        (l.topics?.[0] || "").replace(/^0x/, "").toLowerCase() === TRC20_TRANSFER_TOPIC &&
        l.topics?.length === 3
      )
      .map((l: any): Transfer => {
        const data = (l.data || "").replace(/^0x/, "");
        return [addrBody(l.topics[1]), addrBody(l.topics[2]), data ? BigInt("0x" + data) : 0n];
      });

    return settlement(senderAddress, recipientAddress, tokenAddress, paid(transfers), confirmed, timestamp, { txId: response.id });
  }

  private nativeTransfers(txHash: string, contract: any, internalTransactions: any[]): Transfer[] {
    const call = contract?.parameter?.value;

    if (contract?.type === "TransferContract") {
      return [[addrBody(call.owner_address), addrBody(call.to_address), BigInt(call.amount)]];
    }

    if (contract?.type !== "TriggerSmartContract") {
      log.warn(`Transaction ${txHash} moves no native TRX: ${contract?.type}`);
      return [];
    }

    const transfers: Transfer[] = [[addrBody(call.owner_address), addrBody(call.contract_address), BigInt(call.call_value ?? 0)]];

    for (const internal of internalTransactions) {
      if (internal.rejected || !VALUE_TRANSFER_NOTES.has(Buffer.from(internal.note ?? "", "hex").toString())) {
        continue;
      }

      for (const { callValue: value, tokenId } of internal.callValueInfo ?? []) {
        if (tokenId === undefined && value) {
          transfers.push([addrBody(internal.caller_address), addrBody(internal.transferTo_address), BigInt(value)]);
        }
      }
    }

    return transfers;
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    this.tronWeb.setPrivateKey(privateKey);

    if (tokenAddress === "0x0") {
      const tx = await this.tronWeb.trx.sendTransaction(to, Number(value));
      return tx.txid;
    }

    const { abi } = await this.tronWeb.trx.getContract(tokenAddress)

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
