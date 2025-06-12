import * as winston from 'winston';

export const log = winston.createLogger({
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
