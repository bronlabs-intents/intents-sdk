import * as winston from 'winston';
import rTracer from 'cls-rtracer';
import { inspect } from 'node:util';

const kibanaFormats = () => {
  return [
    winston.format.errors({ stack: true }),
    winston.format((info) => {
      // @ts-ignore
      const splat = info[Symbol.for('splat')];
      const isSplatTypeMessage =
        typeof info.message === 'string' && (info.message.includes('%s') || info.message.includes('%d') || info.message.includes('%j'));
      if (isSplatTypeMessage) {
        return info;
      }

      function formatObject(param: unknown) {
        function isObject(value: unknown) {
          const type = typeof value;
          return value != null && (type === 'object' || type === 'function');
        }

        if (isObject(param)) {
          try {
            return JSON.stringify(param);
          } catch (_e) {
            // If for some reason circular references are present, we can use inspect
            return inspect(param, { depth: 5 });
          }
        }
        return param;
      }

      const rest = (Array.isArray(splat) ? splat : [])
        .map((s: unknown) => {
          if (typeof s === 'undefined') {
            return 'undefined';
          }

          const casted = s as { message?: string; stack?: string };

          // if splat is stack trace and we already have stack, then skip this
          if (casted.stack && info.stack) {
            return '';
          }

          if (casted.stack && !info.stack) {
            info.stack = casted.stack;
          }

          if (casted.message) {
            return casted.message;
          }
          return formatObject(s);
        })
        .join(' ');

      info.message = `${formatObject(info.message)} ${rest}`;

      return info;
    })(),
    winston.format((info) => {
      if (info.level === 'silly') {
        info.level = 'trace';
      }
      info.level = info.level.toUpperCase();
      if (typeof process.env.ENV === 'undefined') {
        info.level = info.level.substring(0, 3);
      }
      return info;
    })(),
    winston.format((info) => {
      // @ts-ignore
      info.correlation_id = rTracer.id() ? rTracer.id().correlationId : undefined;
      return info;
    })(),
    // set default logger_name
    winston.format((info) => {
      info.logger_name = info.logger_name ?? 'default';

      return info;
    })(),
    // hide secrets from logs and trim log to certain size
    winston.format((info) => {
      if (typeof info.message === 'string') {
        info.message = info.message.replace(/secret:::[a-zA-Z0-9=_-]+/g, '[secret]'); // .substring(0, this.options.trimSize);
      }

      return info;
    })(),
    winston.format.timestamp(),
    winston.format((info) => {
      if (typeof info.message === 'string') {
        info.message = info.message.substring(0, (info.trimLength as number) ?? 1024);
      }

      return info;
    })(),
    // delete non-interesting fields
    winston.format((info) => {
      if (info.exception) {
        delete info.date;
        delete info.process;
        delete info.os;
        delete info.trace;
        delete info.error;
      }

      if (info.stack) {
        info.stack_trace = info.stack;
        delete info.stack;
      }

      delete info.trimLength;

      return info;
    })(),
  ].concat(
    typeof process.env.ENV === 'undefined'
      ? [
        winston.format.colorize({
          all: true,
        }),
        winston.format.timestamp({
          format: 'HH:mm:ss.SSS',
        }),
        winston.format.printf(
          (info) =>
            ` ${info.level} ${info.timestamp} \x1b[33m${(info.logger_name as string).substring(-25).padEnd(25, ' ')} ${info.message}${info.stack_trace ? `\n${info.stack_trace}` : ''}`,
        ),
      ]
      : [winston.format.json()],
  );
}


// @ts-ignore
const consoleFormats = () => {
  return winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }: winston.Logform.TransformableInfo) => {
      return `${timestamp} ${level}\t${message}`;
    })
  )
}

const finalFormats = () => {
  console.log("process.env.IS_CONSOLE_LOGS", process.env.IS_CONSOLE_LOGS)
  // @ts-ignores
  if (process.env.IS_CONSOLE_LOGS == true) {
    console.log("true true true true true true true true")
    return consoleFormats()
  } else {
    console.log("false false false false false false")
    return winston.format.combine(...kibanaFormats())
  }
}

export const log = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: finalFormats(),
    transports: new winston.transports.Console()
  })
;

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
