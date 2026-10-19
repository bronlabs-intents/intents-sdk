import { describe, expect, it, vi } from 'vitest';

import { XrpNetwork } from '../src/networks/xrp.js';

const PAYER = 'rPayer111111111111111111111111111';
const RECIPIENT = 'rRecipient111111111111111111111111';
const OTHER = 'rOther111111111111111111111111111';
const ISSUER = 'rIssuer11111111111111111111111111';
const TOKEN = `USD.${ISSUER}`;

function mockedNetwork(tx: any): XrpNetwork {
  const network = new XrpNetwork('http://rpc', 1);

  vi.spyOn(network as any, 'rpcCall').mockImplementation(async (...args: any[]) =>
    args[0] === 'ledger'
      ? { ledger_index: 200 }
      : { validated: true, ledger_index: 100, date: 800000000, TransactionType: 'Payment', Account: PAYER, Destination: RECIPIENT, Fee: '12', ...tx }
  );
  vi.spyOn(network as any, 'getCurrentValidatedLedger').mockResolvedValue(200);

  return network;
}

const delivered = (amount: any) => ({ meta: { TransactionResult: 'tesSUCCESS', delivered_amount: amount } });

describe('XrpNetwork.getTxData', () => {
  it('credits the delivered XRP amount', async () => {
    const tx = await mockedNetwork(delivered('1000000')).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, to: RECIPIENT, token: '0x0', amount: 1000000n, confirmed: true, timestamp: 800000000 + 946684800 });
  });

  it('credits the delivered amount of the order token', async () => {
    const tx = await mockedNetwork(delivered({ currency: 'USD', issuer: ISSUER, value: '24.5' })).getTxData('hash', TOKEN, RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, token: TOKEN, amount: 24500000000000000n });
  });

  it.each([
    ['XRP for a token order', '1000000', TOKEN],
    ['a token of another issuer', { currency: 'USD', issuer: OTHER, value: '10' }, TOKEN],
    ['a token for an XRP order', { currency: 'USD', issuer: ISSUER, value: '10' }, '0x0']
  ])('gives nothing when %s was delivered', async (_, amount, token) => {
    const tx = await mockedNetwork(delivered(amount)).getTxData('hash', token, RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a payment signed by someone other than the payer', async () => {
    const tx = await mockedNetwork({ ...delivered('1000000'), Account: OTHER }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a payment to another destination', async () => {
    const tx = await mockedNetwork({ ...delivered('1000000'), Destination: OTHER }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a transaction that is not a Payment', async () => {
    const tx = await mockedNetwork({ ...delivered('1000000'), TransactionType: 'CheckCash' }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a failed payment', async () => {
    const tx = await mockedNetwork({ meta: { TransactionResult: 'tecPATH_DRY' } }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries a transaction that is not validated yet', async () => {
    expect(await mockedNetwork({ validated: false }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER)).toBeUndefined();
  });
});
