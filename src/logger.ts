import { pino } from 'pino';
import { config } from './config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'storage-service' },
});

export type Logger = typeof logger;
