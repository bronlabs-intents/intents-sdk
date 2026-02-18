import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch, { type RequestInit, type Response } from 'node-fetch';

let proxyAgent: HttpsProxyAgent<string> | undefined;

if (process.env.HTTP_PROXY) {
  proxyAgent = new HttpsProxyAgent(process.env.HTTP_PROXY, {
    rejectUnauthorized: false
  });
}

export function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  return nodeFetch(url, {
    ...options,
    agent: proxyAgent
  });
}
