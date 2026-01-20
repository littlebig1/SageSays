import dotenv from 'dotenv';
import { Config } from './types.js';
import { RetryConfig } from './utils/retry.js';

dotenv.config();

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable: ${name}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const controlDbUrl = process.env.CONTROL_DB_URL;
  
  const retryConfig: RetryConfig = {
    maxRetries: getEnvNumber('MAX_RETRIES', 3),
    initialDelayMs: getEnvNumber('RETRY_INITIAL_DELAY_MS', 1000),
    maxDelayMs: getEnvNumber('RETRY_MAX_DELAY_MS', 10000),
    backoffMultiplier: 2,
  };
  
  return {
    geminiApiKey: getEnvVar('GEMINI_API_KEY'),
    databaseUrl: getEnvVar('DATABASE_URL'),
    controlDbUrl: controlDbUrl ? controlDbUrl : undefined,
    maxRows: getEnvNumber('MAX_ROWS', 200),
    statementTimeoutMs: getEnvNumber('STATEMENT_TIMEOUT_MS', 10000),
    maxResultRowsForLLM: getEnvNumber('MAX_RESULT_ROWS_FOR_LLM', 50),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    debugModeConfidenceThreshold: getEnvNumber('DEBUG_MODE_CONFIDENCE_THRESHOLD', 95),
    retry: retryConfig,
  };
}

export const config = loadConfig();
