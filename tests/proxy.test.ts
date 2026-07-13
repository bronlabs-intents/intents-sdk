import { describe, expect, it } from 'vitest';
import { normalizeProxyUrl } from '../src/proxy.js';

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
