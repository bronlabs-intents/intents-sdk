import { describe, expect, it, vi } from 'vitest';

import { XrpNetwork } from '../src/networks/xrp.js';

const PAYER = 'rPayer111111111111111111111111111';
const RECIPIENT = 'rRecipient111111111111111111111111';
const OTHER = 'rOther111111111111111111111111111';
const ISSUER = 'rIssuer11111111111111111111111111';
const TOKEN = `USD.${ISSUER}`;

const account = (address: string, previous: string | undefined, final: string) => ({
  ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: address, Balance: final }, PreviousFields: previous === undefined ? {} : { Balance: previous } }
});

const createdAccount = (address: string, balance: string) => ({
  CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: address, Balance: balance } }
});

const line = (holder: string, previous: string, final: string) => ({
  ModifiedNode: {
    LedgerEntryType: 'RippleState',
    FinalFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: final }, HighLimit: { issuer: ISSUER }, LowLimit: { issuer: holder } },
    PreviousFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: previous } }
  }
});

function mockedNetwork(tx: any): XrpNetwork {
  const network = new XrpNetwork('http://rpc', 1);

  vi.spyOn(network as any, 'rpcCall').mockImplementation(async (...args: any[]) =>
    args[0] === 'ledger' ? { ledger_index: 200 } : { validated: true, ledger_index: 100, date: 800000000, TransactionType: 'Payment', Account: PAYER, Fee: '12', ...tx }
  );
  vi.spyOn(network as any, 'getCurrentValidatedLedger').mockResolvedValue(200);

  return network;
}

const succeeded = (...nodes: any[]) => ({ meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: nodes } });

describe('XrpNetwork.getTxData', () => {
  it('credits a direct XRP payment net of the fee', async () => {
    const tx = await mockedNetwork(succeeded(account(PAYER, '10000000', '8999988'), account(RECIPIENT, '5000000', '6000000')))
      .getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, to: RECIPIENT, token: '0x0', amount: 1000000n, confirmed: true, timestamp: 800000000 + 946684800 });
  });

  it('credits the payment that creates the recipient account', async () => {
    const tx = await mockedNetwork(succeeded(account(PAYER, '30000000', '19999988'), createdAccount(RECIPIENT, '10000000')))
      .getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, amount: 10000000n });
  });

  it('refuses a payment signed by someone other than the payer', async () => {
    const tx = await mockedNetwork({ ...succeeded(account(PAYER, '10000000', '9000000'), account(RECIPIENT, '0', '1000000')), Account: OTHER })
      .getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a transaction that is not a Payment', async () => {
    const tx = await mockedNetwork({ ...succeeded(account(PAYER, '10000000', '8999988'), account(RECIPIENT, '0', '1000000')), TransactionType: 'CheckCash' })
      .getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a failed payment', async () => {
    const tx = await mockedNetwork({ meta: { TransactionResult: 'tecPATH_DRY', AffectedNodes: [] } }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries a transaction that is not validated yet', async () => {
    expect(await mockedNetwork({ validated: false }).getTxData('hash', '0x0', RECIPIENT, undefined, PAYER)).toBeUndefined();
  });

  it('credits an issued-token payment between holders', async () => {
    const tx = await mockedNetwork(succeeded(account(PAYER, '10000000', '9999988'), line(PAYER, '100', '75.5'), line(RECIPIENT, '0', '24.5')))
      .getTxData('hash', TOKEN, RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, token: TOKEN, amount: 24500000000000000n });
  });

  it('credits the issuer paying its own token', async () => {
    const tx = await mockedNetwork({ ...succeeded(line(RECIPIENT, '0', '10')), Account: ISSUER })
      .getTxData('hash', TOKEN, RECIPIENT, undefined, ISSUER);

    expect(tx).toMatchObject({ from: ISSUER, amount: 10000000000000000n });
  });

  it('refuses a cross-currency payment where the token comes from someone else', async () => {
    const tx = await mockedNetwork(succeeded(account(PAYER, '10000000', '7999988'), account(OTHER, '0', '2000000'), line(OTHER, '50', '40'), line(RECIPIENT, '0', '10')))
      .getTxData('hash', TOKEN, RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('ignores a line of the same currency from another issuer', async () => {
    const foreign = line(PAYER, '100', '90');
    foreign.ModifiedNode.FinalFields.HighLimit.issuer = OTHER;

    const tx = await mockedNetwork(succeeded(foreign, line(RECIPIENT, '0', '10'))).getTxData('hash', TOKEN, RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});
