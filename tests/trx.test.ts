import { describe, expect, it, vi } from 'vitest';
import { fromHex } from 'tron-format-address';

import { TrxNetwork } from '../src/networks/trx.js';

const hexAddress = (n: number) => '41' + n.toString(16).padStart(40, '0');

const RELAYER = hexAddress(1);
const WALLET = hexAddress(2);
const RECIPIENT = hexAddress(3);
const OTHER = hexAddress(4);
const ROUTER = hexAddress(5);
const TOKEN = hexAddress(6);

const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const topic = (address: string) => address.slice(2).padStart(64, '0');

const transferLog = (from: string, to: string, amount: bigint) => ({
  address: TOKEN.slice(2),
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: amount.toString(16).padStart(64, '0')
});

const note = (text: string) => Buffer.from(text).toString('hex');

const internal = (from: string, to: string, value: number, extra: any = {}) =>
  ({ caller_address: from, transferTo_address: to, callValueInfo: [{ callValue: value }], note: note('call'), ...extra });

function mockedNetwork(options: { contract?: any; internals?: any[]; logs?: any[] }): TrxNetwork {
  const network = new TrxNetwork('http://rpc', 1);

  vi.spyOn(network as any, 'request').mockImplementation(async (...args: any[]) => {
    const path = args[0] as string;

    if (path === '/wallet/getblockbylatestnum') {
      return { block: [{ block_header: { raw_data: { number: 100 } } }] };
    }

    if (path === '/wallet/gettransactionbyid') {
      return { ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [options.contract] } };
    }

    return {
      blockNumber: 50,
      blockTimeStamp: 1700000000000,
      receipt: { result: 'SUCCESS' },
      internal_transactions: options.internals,
      log: options.logs
    };
  });

  return network;
}

const walletCall = { type: 'TriggerSmartContract', parameter: { value: { owner_address: RELAYER, contract_address: WALLET } } };

describe('TrxNetwork.getTxData native', () => {
  it('keeps a plain TRX transfer untouched', async () => {
    const contract = { type: 'TransferContract', parameter: { value: { owner_address: WALLET, to_address: RECIPIENT, amount: 700 } } };

    const tx = await mockedNetwork({ contract }).getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: fromHex(WALLET), to: fromHex(RECIPIENT), amount: 700n });
  });

  it('attributes a contract wallet paying the recipient from an internal transaction', async () => {
    const tx = await mockedNetwork({ contract: walletCall, internals: [internal(WALLET, RECIPIENT, 700)] })
      .getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: fromHex(WALLET), to: fromHex(RECIPIENT), amount: 700n });
  });

  it('ignores rejected internal transactions and TRC10 values', async () => {
    const internals = [
      internal(WALLET, RECIPIENT, 700, { rejected: true }),
      { caller_address: WALLET, transferTo_address: RECIPIENT, callValueInfo: [{ callValue: 700, tokenId: '1002000' }], note: note('call') }
    ];

    const tx = await mockedNetwork({ contract: walletCall, internals }).getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses resource delegation and staking to the recipient', async () => {
    const internals = [
      internal(WALLET, RECIPIENT, 700, { note: note('delegateResourceOfEnergy') }),
      internal(WALLET, RECIPIENT, 700, { note: note('freezeForBandwidth') })
    ];

    const tx = await mockedNetwork({ contract: walletCall, internals }).getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a contract call when the expected payer is not a TRON address', async () => {
    const tx = await mockedNetwork({ contract: walletCall, internals: [internal(WALLET, RECIPIENT, 700)] })
      .getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, 'not-an-address');

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a contract call without internal transactions', async () => {
    const tx = await mockedNetwork({ contract: walletCall }).getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a third party paying the recipient while the wallet pays elsewhere', async () => {
    const internals = [internal(OTHER, RECIPIENT, 700), internal(WALLET, ROUTER, 700)];

    const tx = await mockedNetwork({ contract: walletCall, internals }).getTxData('hash', '0x0', fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});

describe('TrxNetwork.getTxData TRC20', () => {
  it('gives nothing when the transfer is routed through a router', async () => {
    const logs = [transferLog(WALLET, ROUTER, 500n), transferLog(ROUTER, RECIPIENT, 500n)];

    const tx = await mockedNetwork({ logs }).getTxData('hash', fromHex(TOKEN), fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses when the expected payer is not a TRON address', async () => {
    const logs = [transferLog(WALLET, ROUTER, 500n), transferLog(ROUTER, RECIPIENT, 500n)];

    const tx = await mockedNetwork({ logs }).getTxData('hash', fromHex(TOKEN), fromHex(RECIPIENT), undefined, 'not-an-address');

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('credits no mint to the zero address declared as the payer', async () => {
    const zero = '410000000000000000000000000000000000000000';
    const logs = [transferLog(zero, RECIPIENT, 500n)];

    const tx = await mockedNetwork({ logs }).getTxData('hash', fromHex(TOKEN), fromHex(RECIPIENT), undefined, fromHex(zero));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('attributes the payer forwarding tokens it received in the same transaction', async () => {
    const logs = [transferLog(OTHER, WALLET, 500n), transferLog(WALLET, RECIPIENT, 500n)];

    const tx = await mockedNetwork({ logs }).getTxData('hash', fromHex(TOKEN), fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: fromHex(WALLET), amount: 500n });
  });

  it('refuses a third party paying the recipient while the payer pays elsewhere', async () => {
    const logs = [transferLog(OTHER, RECIPIENT, 500n), transferLog(WALLET, ROUTER, 500n)];

    const tx = await mockedNetwork({ logs }).getTxData('hash', fromHex(TOKEN), fromHex(RECIPIENT), undefined, fromHex(WALLET));

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});
