import * as winston from 'winston';

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.LOG_FORMAT === 'json'
    ? winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, stack }) => {
          return JSON.stringify({
            '@timestamp': timestamp,
            level: level.toUpperCase(),
            message: stack || message
          });
        })
      )
    : winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.colorize(),
        winston.format.printf(({ level, message, stack }: winston.Logform.TransformableInfo) => {
          return stack ? `${level}\t${message}\n${stack}` : `${level}\t${message}`;
        })
      ),
  transports: [new winston.transports.Console()]
});

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
