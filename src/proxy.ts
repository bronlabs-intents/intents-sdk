import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch, { type RequestInit, type Response } from 'node-fetch';

let proxyAgent: HttpsProxyAgent<string> | undefined;

export function configureProxy(url?: string): void {
  proxyAgent = url
    ? new HttpsProxyAgent(url, { rejectUnauthorized: false })
    : undefined;
}

export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  return proxyAgent;
}

export function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  return nodeFetch(url, {
    ...options,
    agent: proxyAgent
  });
}
