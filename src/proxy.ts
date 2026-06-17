import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch, { type RequestInit, type Response } from 'node-fetch';
import { log } from './utils.js';

let proxyAgent: HttpsProxyAgent<string> | undefined;
let nonProxyHosts: string[] = [];

export function configureProxy(url?: string, noProxyHosts: string[] = []): void {
  proxyAgent = url
    ? new HttpsProxyAgent(url, { rejectUnauthorized: false })
    : undefined;
  nonProxyHosts = noProxyHosts;

  if (proxyAgent) {
    log.info(`Using proxy: ${proxyAgent.proxy.hostname}:${proxyAgent.proxy.port}`)
  }
}

export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  return proxyAgent;
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
  if (nonProxyHosts.length === 0) {
    return false;
  }

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
