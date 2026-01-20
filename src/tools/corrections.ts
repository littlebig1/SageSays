import pg from 'pg';
import { CorrectionCapture } from '../types.js';
import { config } from '../config.js';

const { Pool } = pg;

let controlDbPool: pg.Pool | null = null;

function getControlDbPool(): pg.Pool | null {
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
 * Save a user correction to the run_logs table.
 * Updates the was_corrected flag and stores correction details in user_feedback JSONB field.
 * 
 * @param runLogId - ID of the run_log entry to update
 * @param correction - Correction details from user
 * @returns Promise<void>
 */
export async function saveCorrection(
  runLogId: string,
  correction: CorrectionCapture
): Promise<void> {
  const pool = getControlDbPool();
  if (!pool) {
    console.warn('⚠️  Control database not configured - skipping correction save');
    return;
  }

  try {
    await pool.query(
      `
      UPDATE run_logs
      SET 
        was_corrected = true,
        correction_type = $1,
        user_feedback = $2
      WHERE id = $3
      `,
      [
        correction.correction_type,
        JSON.stringify(correction),
        runLogId
      ]
    );
  } catch (error) {
    console.error('❌ Error saving correction:', error);
    throw error;
  }
}

/**
 * Get a specific run log by ID (needed for correction analysis).
 * 
 * @param runLogId - ID of the run_log to retrieve
 * @returns Promise<any | null>
 */
export async function getRunLogById(runLogId: string): Promise<any | null> {
  const pool = getControlDbPool();
  if (!pool) {
    return null;
  }

  try {
    const result = await pool.query(
      `
      SELECT 
        id,
        question,
        detected_semantics,
        semantics_applied,
        sql_generated,
        sql_executed,
        rows_returned,
        durations_ms,
        was_corrected,
        correction_type,
        user_feedback,
        created_at
      FROM run_logs
      WHERE id = $1
      `,
      [runLogId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error('❌ Error fetching run log:', error);
    return null;
  }
}
