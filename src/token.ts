const MULTI_TOKEN_SEPARATOR = ":::";
const ISSUER_FIRST_NETWORKS = new Set(["CC", "testCC"]);
const MAX_UINT256 = (1n << 256n) - 1n;

export type ParsedToken =
  | { kind: "issuer"; issuer: string; address: string }
  | { kind: "plain"; address: string }
  | { kind: "nft"; address: string; tokenId: bigint };

export function parseTokenAddress(networkId: string, token: string): ParsedToken {
  if (token === "0x0" || !token.includes(MULTI_TOKEN_SEPARATOR)) {
    return { kind: "plain", address: token };
  }

  const sepIndex = token.indexOf(MULTI_TOKEN_SEPARATOR);
  const left = token.slice(0, sepIndex);
  const right = token.slice(sepIndex + MULTI_TOKEN_SEPARATOR.length);

  if (ISSUER_FIRST_NETWORKS.has(networkId)) {
    return { kind: "issuer", issuer: left, address: right };
  }

  return { kind: "nft", address: left, tokenId: parseTokenId(right) };
}

export function encodeTokenId(address: string, tokenId: string): string {
  return `${address}${MULTI_TOKEN_SEPARATOR}${canonicalTokenId(tokenId)}`;
}

export function parseTokenId(raw: string): bigint {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid tokenId, expected a base-10 uint256: ${raw}`);
  }

  const value = BigInt(raw);

  if (value > MAX_UINT256) {
    throw new Error(`tokenId out of uint256 range: ${raw}`);
  }

  return value;
}

export function canonicalTokenId(raw: string): string {
  return parseTokenId(raw).toString(10);
}

export function decodeErc6909TransferAmount(data: string): bigint {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  return BigInt("0x" + hex.slice(64, 128));
}
