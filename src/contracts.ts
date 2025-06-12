import { ethers } from 'ethers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const initOrderEngine = (orderEngineAddress: string, provider: ethers.providers.JsonRpcProvider | ethers.Signer) =>
  new ethers.Contract(
    orderEngineAddress,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../abi/OrderEngine.json'), 'utf8')),
    provider
  );

export const initOracleAggregator = (oracleAggregatorAddress: string, provider: ethers.providers.JsonRpcProvider | ethers.Signer) =>
  new ethers.Contract(
    oracleAggregatorAddress,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../abi/OracleAggregator.json'), 'utf8')),
    provider
  );
