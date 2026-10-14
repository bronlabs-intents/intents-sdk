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

const TRACE_TIMEOUT_MS = 8000;

export const TRACE_RETRY_SECONDS = 600;

export async function traceWithinRetryWindow<T>(trace: Promise<T>, txHash: string, timestamp: number): Promise<T | undefined> {
  try {
    return await withTimeout(trace, TRACE_TIMEOUT_MS, `Trace of ${txHash} timed out after ${TRACE_TIMEOUT_MS}ms`);
  } catch (e) {
    if (Date.now() / 1000 - timestamp < TRACE_RETRY_SECONDS) {
      throw e;
    }

    log.warn(`Trace of ${txHash} still failing after ${TRACE_RETRY_SECONDS}s: ${(e as Error).message}`);
    return undefined;
  }
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

export type Transfer = [from: string, to: string, amount: bigint];

export function settlement(from: string, to: string, token: string, amount: bigint, confirmed: boolean, timestamp: number, extra: Partial<TransactionData> = {}): TransactionData {
  return amount > 0n
    ? { from, to, token, amount, confirmed, timestamp, ...extra }
    : { from: "", to: "", token: "", amount: 0n, confirmed, timestamp };
}

export function paymentFlow(transfers: Transfer[], payer: string, recipient: string): bigint {
  const gross = new Map<string, Map<string, bigint>>();

  const edges = (graph: Map<string, Map<string, bigint>>, from: string): Map<string, bigint> => {
    if (!graph.has(from)) {
      graph.set(from, new Map());
    }

    return graph.get(from)!;
  };

  for (const [from, to, amount] of transfers) {
    if (from !== to && amount > 0n) {
      edges(gross, from).set(to, (edges(gross, from).get(to) ?? 0n) + amount);
    }
  }

  const capacity = new Map<string, Map<string, bigint>>();

  for (const [from, outgoing] of gross) {
    for (const [to, amount] of outgoing) {
      const net = amount - (gross.get(to)?.get(from) ?? 0n);

      if (net > 0n) {
        edges(capacity, from).set(to, net);
      }
    }
  }

  let recipientGain = 0n;

  for (const [from, to, amount] of transfers) {
    if (from !== to && amount > 0n) {
      recipientGain += to === recipient ? amount : from === recipient ? -amount : 0n;
    }
  }

  if (recipientGain <= 0n) {
    return 0n;
  }

  let flow = 0n;

  while (payer !== recipient && flow < recipientGain) {
    const previous = new Map<string, string>([[payer, payer]]);
    const queue = [payer];

    while (queue.length && !previous.has(recipient)) {
      const node = queue.shift()!;

      for (const [next, amount] of capacity.get(node) ?? []) {
        if (amount > 0n && !previous.has(next)) {
          previous.set(next, node);
          queue.push(next);
        }
      }
    }

    if (!previous.has(recipient)) {
      break;
    }

    const path: [string, string][] = [];

    for (let node = recipient; node !== payer; node = previous.get(node)!) {
      path.push([previous.get(node)!, node]);
    }

    const bottleneck = path
      .map(([from, to]) => capacity.get(from)!.get(to)!)
      .reduce((min, amount) => amount < min ? amount : min);

    for (const [from, to] of path) {
      edges(capacity, from).set(to, capacity.get(from)!.get(to)! - bottleneck);
      edges(capacity, to).set(from, (capacity.get(to)?.get(from) ?? 0n) + bottleneck);
    }

    flow += bottleneck;
  }

  return flow < recipientGain ? flow : recipientGain;
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
