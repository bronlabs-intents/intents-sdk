import * as winston from 'winston';

import type { TransactionData } from './networks/index.js';

const jsonFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    return JSON.stringify({
      '@timestamp': timestamp,
      level: level.toUpperCase(),
      message: stack || message
    });
  })
);

const textFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ level, message, stack }: winston.Logform.TransformableInfo) => {
    return stack ? `${level}\t${message}\n${stack}` : `${level}\t${message}`;
  })
);

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.LOG_FORMAT === 'json' ? jsonFormat : textFormat,
  transports: [new winston.transports.Console()]
});

export function configureLog(options: { format?: 'json' | 'text'; level?: string }) {
  if (options.format) {
    log.format = options.format === 'json' ? jsonFormat : textFormat;
  }

  if (options.level) {
    log.level = options.level;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message || `Timeout after ${ms}ms`)), ms)
    )
  ]);
}

export const sameAddress = (a: string | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();

export function addDelta(deltas: Map<string, bigint>, address: string, amount: bigint): void {
  deltas.set(address, (deltas.get(address) ?? 0n) + amount);
}

// Every non-payer debit (a mint pseudo-account included) must reach otherDebit: leaving one out lets
// a third-party payout to the recipient count as the payer's own payment.
export function provableContribution(deltas: Map<string, bigint>, payers: Set<string>, recipient: string): bigint {
  let credit = 0n;
  let payerDebit = 0n;
  let otherDebit = 0n;

  for (const [address, delta] of deltas) {
    if (address === recipient) {
      credit = delta > 0n ? delta : 0n;
    } else if (delta < 0n && payers.has(address)) {
      payerDebit -= delta;
    } else if (delta < 0n) {
      otherDebit -= delta;
    }
  }

  const covered = credit - otherDebit;
  const contribution = covered < payerDebit ? covered : payerDebit;

  return contribution > 0n ? contribution : 0n;
}

export const UNATTRIBUTED = "unattributed";

export type Transfer = [from: string, to: string, amount: bigint];

export function settlement(from: string, to: string, token: string, amount: bigint, confirmed: boolean, timestamp: number, extra: Partial<TransactionData> = {}): TransactionData {
  return amount > 0n
    ? { from, to, token, amount, confirmed, timestamp, ...extra }
    : { from: "", to: "", token: "", amount: 0n, confirmed, timestamp };
}

export function directPayment(transfers: Transfer[], payer: string, recipient: string): bigint {
  const paid = transfers.reduce((sum, [from, to, amount]) =>
    from === payer && to === recipient ? sum + amount : from === recipient && to === payer ? sum - amount : sum, 0n);

  return paid > 0n ? paid : 0n;
}

export async function expRetry<T>(fn: () => Promise<T>, maxRetries: number = 3, retryIf: (e: Error) => boolean = () => true): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      if (error instanceof Error && retryIf(error)) {
        log.warn(`Retry attempt #${attempt + 1}: ${error.message}`);

        const delay = Math.pow(2, attempt) * 3000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw Error(`Retry failed: maxRetries=${maxRetries}`);
}

type MemoEntry = { value?: unknown; expiresAt: number; promise?: Promise<unknown> };

const __memoCache = new Map<string, MemoEntry>();

const __gc = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of __memoCache.entries()) {
    if (v.expiresAt <= now && !v.promise) {
      __memoCache.delete(k);
    }
  }
}, 60_000);
(__gc as any).unref?.();

export function memoize<T>(key: string, durationMs: number, cb: () => Promise<T> | T): Promise<T> {
  const now = Date.now();
  const existing = __memoCache.get(key);

  if (existing && existing.expiresAt > now && !existing.promise) {
    return Promise.resolve(existing.value as T);
  }

  if (existing?.promise) {
    return existing.promise as Promise<T>;
  }

  const expiresAt = now + durationMs;

  const p = Promise.resolve()
    .then(cb)
    .then(v => {
      __memoCache.set(key, { value: v, expiresAt });
      return v;
    })
    .catch(e => {
      __memoCache.delete(key);
      throw e;
    });

  __memoCache.set(key, { promise: p, expiresAt });

  return p;
}
