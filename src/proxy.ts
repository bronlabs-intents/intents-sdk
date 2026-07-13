import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch, { type RequestInit, type Response } from 'node-fetch';
import { log } from './utils.js';

// In-cluster traffic must never go through the corporate proxy (the proxy can't resolve cluster DNS).
// Always bypassed, on top of any configured nonProxyHosts.
const ALWAYS_NO_PROXY = ['*.svc.cluster.local'];

let proxyAgent: HttpsProxyAgent<string> | undefined;
let nonProxyHosts: string[] = [];

export function configureProxy(url?: string, noProxyHosts: string[] = []): void {
  proxyAgent = url
    ? new HttpsProxyAgent(normalizeProxyUrl(url), { rejectUnauthorized: false })
    : undefined;
  nonProxyHosts = [...ALWAYS_NO_PROXY, ...noProxyHosts];

  if (proxyAgent) {
    log.info(`Using proxy: ${proxyAgent.proxy.hostname}:${proxyAgent.proxy.port}`)
  }
}

// Proxy credentials may contain characters that are invalid in a raw URL (e.g. `\` or `[`).
// Percent-encode the userinfo in that case; https-proxy-agent decodes it back for Proxy-Authorization.
export function normalizeProxyUrl(url: string): string {
  try {
    new URL(url);
    return url;
  } catch (e) {
    const match = url.match(/^([a-z][\w+.-]*:\/\/)?(.*)@([^@]+)$/i);

    if (!match) {
      throw e;
    }

    const [, scheme = '', userinfo, host] = match;
    const sep = userinfo.indexOf(':');
    const auth = sep === -1
      ? encodeURIComponent(userinfo)
      : `${encodeURIComponent(userinfo.slice(0, sep))}:${encodeURIComponent(userinfo.slice(sep + 1))}`;

    return `${scheme}${auth}@${host}`;
  }
}

export function getProxyAgentForUrl(url: string): HttpsProxyAgent<string> | undefined {
  if (!proxyAgent || isNonProxyHost(url)) {
    return undefined;
  }

  return proxyAgent;
}

export function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  return nodeFetch(url, {
    ...options,
    agent: getProxyAgentForUrl(url)
  });
}

function isNonProxyHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return nonProxyHosts.some(pattern => {
    const p = pattern.toLowerCase();

    if (p.length > 1 && p.startsWith('*')) {
      return host.endsWith(p.slice(1));
    }

    if (p.length > 1 && p.endsWith('*')) {
      return host.startsWith(p.slice(0, -1));
    }

    return host === p;
  });
}
