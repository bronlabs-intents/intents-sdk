import { BigNumber } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as ed25519 from '@noble/ed25519';
import Big from 'big.js';
import fetch from 'node-fetch';

import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import { expRetry } from './utils.js';


export class CantonNetwork implements Network {
  private readonly scanApiUrl: string;
  private readonly validatorApiUrl: string;
  private readonly authUrl: string;

  private readonly nativeAssetDecimals: number = 10;
  readonly retryDelay: number = 5000;

  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly senderPartyId?: string;

  private readonly proxyAgent?: HttpsProxyAgent<string>;

  private accessToken?: string;
  private accessTokenExpiresAt: number = 0;

  constructor(validatorApiUrl: string, scanApiUrl?: string, authUrl?: string, clientId?: string, clientSecret?: string, senderPartyId?: string) {
    this.validatorApiUrl = validatorApiUrl;
    this.scanApiUrl = scanApiUrl || validatorApiUrl;
    this.authUrl = authUrl || 'mainnet-canton-mpch.eu.auth0.com';

    this.proxyAgent = process.env.HTTP_PROXY ? new HttpsProxyAgent(process.env.HTTP_PROXY, {
      rejectUnauthorized: false
    }) : undefined;

    this.clientId = clientId;
    this.clientSecret = clientSecret;

    this.senderPartyId = senderPartyId;
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === '0x0') {
      return this.nativeAssetDecimals;
    }

    throw new Error("Canton does not support tokens");
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {
    const updateId = txHash.split(':')[0];

    const result = await fetch(`${this.scanApiUrl}/v2/updates/${updateId}`, {
      method: 'GET',
      agent: this.proxyAgent
    });

    if (!result.ok) {
      throw new Error(`Couldn't get Canton tx data for ${txHash}: ${result.status} ${result.statusText}`);
    }

    const json = await result.json();

    if (!json || json.error) {
      throw new Error(`Couldn't get Canton tx data for ${txHash}: ${json?.error || 'unknown error'}`);
    }

    const fetchedEvent = json.events_by_id[`${updateId}:0`];
    const to = fetchedEvent.choice_argument.receiver;

    const amount = new Big(fetchedEvent.choice_argument.amount)
      .mul(Big(10).pow(this.nativeAssetDecimals))
      .toNumber();

    if (tokenAddress === '0x0') {
      return {
        to: to,
        token: tokenAddress,
        amount: BigNumber.from(amount),
        confirmed: true
      };
    }

    throw new Error("Canton does not support tokens");
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {
    if (tokenAddress != '0x0') {
      throw new Error("Canton does not support tokens");
    }

    const publicKey = (await ed25519.utils.getExtendedPublicKey(privateKey)).point.toHex().toUpperCase();

    let nonce;
    try {
      const resp = await this.nodeRequest({
        method: 'GET',
        uri: `/v0/scan-proxy/transfer-command-counter/${this.senderPartyId}`,
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
        "sender_party_id": this.senderPartyId,
        "receiver_party_id": to,
        "amount": new Big(value.toString()).div(new Big(10).pow(this.nativeAssetDecimals)).toString(),
        "expires_at": new Date(Date.now() + 86400000).toISOString(),
        "nonce": nonce
      }
    });

    const { update_id } = await this.nodeRequest({
      method: 'POST',
      uri: `/v0/admin/external-party/transfer-preapproval/submit-send`,
      body: {
        "submission": {
          "party_id": this.senderPartyId,
          "transaction": prepareSend.transaction,
          "signed_tx_hash": Buffer.from(await ed25519.sign(prepareSend.tx_hash, Buffer.from(privateKey, 'hex'))).toString('hex').toUpperCase(),
          "public_key": publicKey
        }
      }
    });

    return expRetry(async () => {
      log.info(`Waiting for transaction ${update_id} confirmation...`);

      const result = await fetch(`${this.scanApiUrl}/v2/updates/${update_id}`);

      if (!result.ok) {
        throw new Error(`Couldn't get Canton tx data for ${update_id}: ${result.status} ${result.statusText}`);
      }

      const json = await result.json();

      if (!json || json.error) {
        throw new Error(`Couldn't get Canton tx data for ${update_id}: ${json?.error || 'unknown error'}`);
      }

      const event: any = Object.values(json.events_by_id)
        .find((e: any) => e.event_type == 'exercised_event' && e.choice == 'ExternalPartyAmuletRules_CreateTransferCommand');

      const transferCommandCid = event?.exercise_result?.transferCommandCid;

      if (!transferCommandCid) {
        throw new Error(`Couldn't find transfer command cid in Canton tx data for ${update_id}`);
      }

      return `${update_id}:${transferCommandCid}`;
    }, 10);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 30_000) {
      return this.accessToken;
    }

    const response = await fetch(`https://${this.authUrl}/oauth/token`, {
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
      throw new Error(`Failed to get access token from https://${this.authUrl}/oauth/token: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();

    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + (data.expires_in * 1000);

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

      const resp = await fetch(`${node || this.validatorApiUrl}${uri}`, {
        method,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        agent: this.proxyAgent
      })

      let msg = `${method} ${node || this.validatorApiUrl}${uri} - ${resp.status} ${resp.statusText} (${Date.now() - start}ms)`

      if (!resp.ok) {
        msg += `: ${await resp.text()}`
        log.error(msg)

        throw new Error(`Failed to ${msg}`);
      }

      log.info(msg)

      return await resp.json();
    }, retry ? 3 : 0)
  }
}
