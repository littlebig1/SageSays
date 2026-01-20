import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * Connection pool management for all databases.
 * 
 * Best Practice: One pool per database, shared across all modules.
 * This ensures:
 * - Efficient connection reuse
 * - Consistent transaction visibility
 * - Proper resource cleanup
 */

// Inspected database pool (the database being queried)
let inspectedDbPool: pg.Pool | null = null;

// Control database pool (stores semantics, logs, metadata)
let controlDbPool: pg.Pool | null = null;

/**
 * Gets or creates the connection pool for the inspected database.
 * This is the database that users query (read-only).
 * 
 * @returns PostgreSQL connection pool configured with DATABASE_URL
 */
export function getInspectedDbPool(): pg.Pool {
  if (!inspectedDbPool) {
    inspectedDbPool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return inspectedDbPool;
}

/**
 * Gets or creates the connection pool for the control database.
 * This database stores semantics, run logs, and metadata.
 * 
 * @returns PostgreSQL connection pool configured with CONTROL_DB_URL, or null if not configured
 */
export function getControlDbPool(): pg.Pool | null {
  if (!config.controlDbUrl) {
    return null;
  }
  if (!controlDbPool) {
    controlDbPool = new Pool({
      connectionString: config.controlDbUrl,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return controlDbPool;
}

/**
 * Closes all connection pools.
 * Should be called during application shutdown to clean up resources.
 * 
 * @example
 * ```typescript
 * process.on('SIGINT', async () => {
 *   await closeAllPools();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeAllPools(): Promise<void> {
  if (inspectedDbPool) {
    await inspectedDbPool.end();
    inspectedDbPool = null;
  }
  if (controlDbPool) {
    await controlDbPool.end();
    controlDbPool = null;
  }
}
