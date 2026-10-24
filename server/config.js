import 'dotenv/config';
import crypto from 'node:crypto';

const isProd = process.env.NODE_ENV === 'production';
let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.startsWith('change-me')) {
  if (isProd) throw new Error('JWT_SECRET must be set in production');
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set - using a random dev secret (logins reset on restart).');
}

export const config = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  jwtSecret,
  dbPath: process.env.DB_PATH || './data/quizforge.db',
  nebius: {
    apiKey: process.env.NEBIUS_API_KEY || '',
    baseUrl: (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
    model: process.env.NEBIUS_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
    timeoutMs: Number(process.env.NEBIUS_TIMEOUT_MS) || 45000,
  },
};
