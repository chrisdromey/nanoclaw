import pino from 'pino';

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
  },
  level: process.env.LOG_LEVEL || 'info',
});
