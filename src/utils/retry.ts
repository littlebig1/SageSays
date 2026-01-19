/**
 * Retry utility with exponential backoff for handling API rate limits and temporary failures
 */

/**
 * Retry configuration for API calls
 */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,      // Start with 1 second
  maxDelayMs: 10000,         // Cap at 10 seconds
  backoffMultiplier: 2,      // Double each time: 1s, 2s, 4s
};

/**
 * Checks if an error is retryable (503, 429, network errors)
 * @param error The error to check
 * @returns True if the error should trigger a retry
 */
function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  // Check for HTTP status codes
  if (error.status === 503 || error.status === 429) {
    return true; // Service unavailable or rate limit
  }
  
  // Check for network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }
  
  return false;
}

/**
 * Calculate delay with exponential backoff
 * @param attempt The current attempt number (0-indexed)
 * @param config Retry configuration
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Sleep for specified milliseconds
 * @param ms Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * 
 * @param fn The async function to retry
 * @param config Retry configuration (uses defaults if not provided)
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // Try to execute the function
      const result = await fn();
      
      // Success! Return the result
      if (attempt > 0) {
        console.log(`✓ Retry succeeded on attempt ${attempt + 1}`);
      }
      return result;
      
    } catch (error) {
      lastError = error;
      
      // Check if we should retry
      if (!isRetryableError(error)) {
        // Not a retryable error, fail immediately
        throw error;
      }
      
      // Check if we have retries left
      if (attempt < config.maxRetries) {
        const delay = calculateDelay(attempt, config);
        console.log(`⚠️  API overloaded. Retrying in ${delay/1000}s... (attempt ${attempt + 1}/${config.maxRetries})`);
        await sleep(delay);
      } else {
        // Out of retries
        console.log(`❌ All ${config.maxRetries} retry attempts failed`);
      }
    }
  }
  
  // All retries exhausted, throw the last error
  throw lastError;
}
