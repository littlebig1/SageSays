import pg from 'pg';
import { RunLog } from '../types.js';
import { config } from '../config.js';

const { Pool } = pg;

function getControlDbPool(): pg.Pool | null {
  if (!config.controlDbUrl) {
    return null;
  }
  const pool = new Pool({
    connectionString: config.controlDbUrl,
    max: 5,
    idleTimeoutMillis: 30000,
  });
  return pool;
}

/**
 * Saves a run log entry to the control database.
 * Uses the official schema: run_logs table with sql_generated, detected_semantics fields.
 * 
 * @param question The user's question
 * @param sqlQueries Array of SQL queries executed
 * @param rowsReturned Array of row counts returned
 * @param durationsMs Array of execution durations in milliseconds
 * @param detectedSemanticIds Array of semantic entity IDs detected in the question (optional)
 */
export async function saveRunLog(
  question: string,
  sqlQueries: string[],
  rowsReturned: number[],
  durationsMs: number[],
  detectedSemanticIds?: string[]
): Promise<RunLog | null> {
  const pool = getControlDbPool();
  if (!pool) {
    return null; // Silently skip if control DB not configured
  }
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `INSERT INTO run_logs (question, sql_generated, sql_executed, rows_returned, durations_ms, detected_semantics, semantics_applied)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, question, sql_generated, rows_returned, durations_ms, detected_semantics, created_at`,
      [
        question, 
        sqlQueries, 
        sqlQueries, 
        rowsReturned, 
        durationsMs, 
        detectedSemanticIds || [],
        detectedSemanticIds || [] // For now, assume all detected semantics were applied
      ]
    );
    
    const row = result.rows[0];
    return {
      id: row.id,
      question: row.question,
      sql: row.sql_generated,
      rowsReturned: row.rows_returned,
      durationsMs: row.durations_ms,
      detectedSemantics: row.detected_semantics || [],
      createdAt: new Date(row.created_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Retrieves recent run logs from the control database.
 * Uses the official schema: run_logs table.
 * 
 * @param limit Maximum number of logs to retrieve (default: 10)
 * @returns Array of RunLog objects
 */
export async function getRecentRunLogs(limit = 10): Promise<RunLog[]> {
  const pool = getControlDbPool();
  if (!pool) {
    return []; // Return empty array if control DB not configured
  }
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT id, question, sql_generated, rows_returned, durations_ms, created_at
       FROM run_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    
    return result.rows.map(row => ({
      id: row.id,
      question: row.question,
      sql: row.sql_generated,
      rowsReturned: row.rows_returned,
      durationsMs: row.durations_ms,
      createdAt: new Date(row.created_at),
    }));
  } finally {
    client.release();
  }
}
