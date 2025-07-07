import { BigNumber, ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import * as ed25519 from '@noble/ed25519';
import { expRetry } from './utils.js';
import { ppid } from 'process';

export class CantonNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly node: string;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 5000;
  private readonly nativeAssetAddress: string = "00b5aad80a523ce3ca2e1e3c7b622df84efd37c5cfd00f112a64a4c48b27ad1062ca101220409710acc9bdb03ac71876b747c090d00270891ad9836ed60a6e4b8b41d8dfae";
  private accessToken?: string;
  private accessTokenExpiresAt: Date = new Date(0);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly address: string;

  constructor(rpcUrl: string, node: string, clientId: string, clientSecret: string, address: string) {
    this.rpcUrl = rpcUrl;
    this.node = node;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.address = address;
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === '0x0') {
      return this.nativeAssetDecimals;
    }
    throw new Error("Canton does not support tokens");
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {

    const result = await fetch(`${this.rpcUrl}/api/update/${txHash}`).then((res) => res.json());

    if (!result || result.error) {
      throw new Error(`Couldnt get Canton tx data for ${txHash}`);
    }

    const fetchedEvent = result.json.events_by_id[`${txHash}:0`];
    const to = fetchedEvent.choice_argument.receiver;
    const amount = fetchedEvent.choice_argument.amount.split('.')[0];

    // Native token - Canton
    if (tokenAddress === '0x0') {
      return {
        to: to,
        token: tokenAddress,
        amount: BigNumber.from(amount),
        confirmed: true
      };
    }

    // ERC20 token
    throw new Error("Canton does not support tokens");
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {

    if (this.node === "" || this.clientId === "" || this.clientSecret === "") {
      throw new Error("Canton network config is not set");
    }

    if (tokenAddress != '0x0') {
      throw new Error("Canton does not support tokens");
    }

    // Setup
    const publicKey = (await ed25519.utils.getExtendedPublicKey(privateKey)).point.toHex().toUpperCase();

    // Transfer
    let nonce;
    try {
      const resp = await this.nodeRequest({
        method: 'GET',
        uri: `/v0/scan-proxy/transfer-command-counter/${this.address}`,
        retry: false
      });

      nonce = parseInt(resp.transfer_command_counter.contract.payload.nextNonce, 10);
    } catch (e) {
      if (e instanceof Error && e.message.includes('No TransferCommandCounter found for party')) {
        nonce = 0;
      } else {
        throw e;
      }
    }

    const prepareSend = await this.nodeRequest({
      method: 'POST',
      uri: `/v0/admin/external-party/transfer-preapproval/prepare-send`,
      body: {
        "sender_party_id": this.address,
        "receiver_party_id": to,
        "amount": value.toString(),
        "expires_at": new Date(Date.now() + 86400000).toISOString(),
        "nonce": nonce
      }
    });

    const submitSend = await this.nodeRequest({
      method: 'POST',
      uri: `/v0/admin/external-party/transfer-preapproval/submit-send`,
      body: {
        "submission": {
          "party_id": this.address,
          "transaction": prepareSend.transaction,
          "signed_tx_hash": Buffer.from(await ed25519.sign(prepareSend.tx_hash, Buffer.from(privateKey, 'hex'))).toString('hex').toUpperCase(),
          "public_key": publicKey
        }
      }
    });

    return submitSend.update_id;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > new Date(Date.now() + 30_000)) {
      return this.accessToken;
    }

    const response = await fetch(`https://mainnet-canton-mpch.eu.auth0.com/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        'client_id': this.clientId,
        'client_secret': this.clientSecret,
        'audience': 'https://canton.network.global',
        'grant_type': 'client_credentials'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();

    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000);

    return this.accessToken!;
  }

  private async nodeRequest({ method, uri, body = undefined, node = undefined, retry = true }: {
    method: string,
    uri: string,
    body?: any,
    node?: string;
    retry?: boolean
  }): Promise<any> {
    return expRetry(async () => {
      const start = Date.now()
      const accessToken = await this.getAccessToken();

      const resp = await fetch(`${node || this.node}${uri}`, {
        method,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      })

      let msg = `${method} ${uri} - ${resp.status} ${resp.statusText} (${Date.now() - start}ms)`

      if (!resp.ok) {
        msg += `: ${await resp.text()}`
        log.error(msg)

        throw new Error(`Failed to ${msg}`);
      }

      log.debug(msg)

      return await resp.json();
    }, retry ? 3 : 0)
  }
}
