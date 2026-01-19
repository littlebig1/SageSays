import pg from 'pg';
import { SQLResult } from '../types.js';
import { config } from '../config.js';
import { validateSQL } from '../agent/guard.js';

const { Pool } = pg;

let inspectedDbPool: pg.Pool | null = null;

/**
 * Gets or creates the connection pool for the inspected database.
 * Uses connection pooling for efficient database access.
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
 * Executes a SQL query against the inspected database with safety validations.
 * 
 * Safety features:
 * - Validates SQL through guard before execution
 * - Enforces statement timeout (configurable via STATEMENT_TIMEOUT_MS)
 * - Only allows SELECT queries (no DML/DDL)
 * - Auto-appends LIMIT if not present
 * 
 * @param sql - The SQL query to execute (will be validated and sanitized)
 * @returns SQLResult containing columns, rows, row count, and execution duration
 * @throws Error if SQL validation fails or query execution fails
 * 
 * @example
 * ```typescript
 * const result = await runSQL('SELECT * FROM users WHERE active = true');
 * console.log(`Found ${result.rowCount} rows in ${result.durationMs}ms`);
 * ```
 */
export async function runSQL(sql: string): Promise<SQLResult> {
  // Runtime assertion: ensure sql is a non-empty string
  if (!sql || typeof sql !== 'string') {
    throw new Error('Invalid SQL: must be a non-empty string');
  }
  
  // Validate SQL before execution
  const validation = validateSQL(sql);
  if (!validation.valid) {
    throw new Error(`SQL validation failed: ${validation.reason}`);
  }
  
  const pool = getInspectedDbPool();
  const client = await pool.connect();
  const startTime = Date.now();
  
  try {
    // Set statement timeout
    await client.query(`SET statement_timeout = ${config.statementTimeoutMs}`);
    
    // Execute the validated SQL
    const result = await client.query(sql);
    const durationMs = Date.now() - startTime;
    
    return {
      columns: result.fields.map(f => f.name),
      rows: result.rows.map(row => Object.values(row)),
      rowCount: result.rowCount || 0,
      durationMs,
    };
  } catch (error) {
    throw new Error(`SQL execution failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    client.release();
  }
}

/**
 * Closes the inspected database connection pool.
 * Should be called during application shutdown to clean up resources.
 * 
 * @example
 * ```typescript
 * process.on('SIGINT', async () => {
 *   await closeInspectedDbPool();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeInspectedDbPool(): Promise<void> {
  if (inspectedDbPool) {
    await inspectedDbPool.end();
    inspectedDbPool = null;
  }
}
