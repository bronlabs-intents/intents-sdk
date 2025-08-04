import * as winston from 'winston';

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }: winston.Logform.TransformableInfo) => {
      return `${timestamp} ${level}\t${message}`;
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

