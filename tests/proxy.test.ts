import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { configureProxy, normalizeProxyUrl, proxyFetch } from '../src/proxy.js';

describe('normalizeProxyUrl', () => {
  it('returns a valid URL unchanged', () => {
    expect(normalizeProxyUrl('http://user:pass@proxy.example.com:3128')).toBe('http://user:pass@proxy.example.com:3128');
  });

  it('returns a URL without credentials unchanged', () => {
    expect(normalizeProxyUrl('http://proxy.example.com:3128')).toBe('http://proxy.example.com:3128');
  });

  it('keeps already percent-encoded credentials intact', () => {
    expect(normalizeProxyUrl('http://user:pa%5B%5Css@proxy.example.com:3128')).toBe('http://user:pa%5B%5Css@proxy.example.com:3128');
  });

  it('encodes URL-invalid characters in the password', () => {
    const normalized = normalizeProxyUrl('http://user:pa\\[ss@proxy.example.com:3128');
    const parsed = new URL(normalized);

    expect(parsed.hostname).toBe('proxy.example.com');
    expect(parsed.port).toBe('3128');
    expect(parsed.username).toBe('user');
    expect(decodeURIComponent(parsed.password)).toBe('pa\\[ss');
  });

  it('splits userinfo at the last @ when the password contains @', () => {
    const normalized = normalizeProxyUrl('http://user:pa\\[ss@w@proxy.example.com:3128');
    const parsed = new URL(normalized);

    expect(parsed.hostname).toBe('proxy.example.com');
    expect(parsed.port).toBe('3128');
    expect(parsed.username).toBe('user');
    expect(decodeURIComponent(parsed.password)).toBe('pa\\[ss@w');
  });

  it('throws on a URL that cannot be repaired', () => {
    expect(() => normalizeProxyUrl('not a url')).toThrow();
  });
});

describe('proxy agent keep-alive', () => {
  afterEach(() => {
    configureProxy(undefined);
  });

  it('reuses a single CONNECT tunnel for sequential requests to the same origin', async () => {
    const target = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as net.AddressInfo).port;

    let connectCount = 0;
    const proxy = net.createServer(socket => {
      socket.once('data', chunk => {
        const head = chunk.toString();
        if (!head.startsWith('CONNECT ')) {
          socket.destroy();
          return;
        }
        connectCount++;
        const upstream = net.connect(targetPort, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
      });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;

    configureProxy(`http://127.0.0.1:${proxyPort}`);

    try {
      for (let i = 0; i < 3; i++) {
        const res = await proxyFetch(`http://127.0.0.1:${targetPort}/ping`);
        expect(await res.json()).toEqual({ ok: true });
      }
      expect(connectCount).toBe(1);
    } finally {
      proxy.close();
      target.close();
    }
  });
});
