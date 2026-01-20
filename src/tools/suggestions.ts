import pg from 'pg';
import { SemanticSuggestion, SemanticAdditionalData, AggregationDB, SuggestionStatusDB } from '../types.js';
import { config } from '../config.js';
import { saveSemantic } from './semantics.js';

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
 * Save a semantic suggestion to the semantic_suggestions table.
 * 
 * @param suggestion - Suggestion details (without id and created_at)
 * @returns Promise<SemanticSuggestion | null>
 */
export async function saveSuggestion(
  suggestion: Omit<SemanticSuggestion, 'id' | 'created_at'>
): Promise<SemanticSuggestion | null> {
  const pool = getControlDbPool();
  if (!pool) {
    console.warn('⚠️  Control database not configured - skipping suggestion save');
    return null;
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO semantic_suggestions (
        suggested_name,
        suggested_type,
        suggested_definition,
        learned_from,
        source_run_log_id,
        learning_dialogue,
        confidence,
        evidence,
        status,
        requires_expert_review
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING 
        id,
        suggested_name,
        suggested_type,
        suggested_definition,
        learned_from,
        source_run_log_id,
        learning_dialogue,
        confidence,
        evidence,
        status,
        requires_expert_review,
        reviewed_by,
        review_notes,
        reviewed_at,
        created_at
      `,
      [
        suggestion.suggested_name,
        suggestion.suggested_type,
        JSON.stringify(suggestion.suggested_definition),
        suggestion.learned_from,
        suggestion.source_run_log_id || null,
        suggestion.learning_dialogue ? JSON.stringify(suggestion.learning_dialogue) : null,
        suggestion.confidence,
        suggestion.evidence ? JSON.stringify(suggestion.evidence) : null,
        suggestion.status,
        suggestion.requires_expert_review
      ]
    );

    return mapRowToSuggestion(result.rows[0]);
  } catch (error) {
    console.error('❌ Error saving suggestion:', error);
    throw error;
  }
}

/**
 * Get all pending suggestions for review.
 * 
 * @returns Promise<SemanticSuggestion[]>
 */
export async function getPendingSuggestions(): Promise<SemanticSuggestion[]> {
  const pool = getControlDbPool();
  if (!pool) {
    return [];
  }

  try {
    const result = await pool.query(
      `
      SELECT 
        id,
        suggested_name,
        suggested_type,
        suggested_definition,
        learned_from,
        source_run_log_id,
        learning_dialogue,
        confidence,
        evidence,
        status,
        requires_expert_review,
        reviewed_by,
        review_notes,
        reviewed_at,
        created_at
      FROM semantic_suggestions
      WHERE status = 'pending'
      ORDER BY 
        requires_expert_review DESC,
        confidence DESC,
        created_at DESC
      `
    );

    return result.rows.map(mapRowToSuggestion);
  } catch (error) {
    console.error('❌ Error fetching pending suggestions:', error);
    return [];
  }
}

/**
 * Update suggestion status (approve/reject).
 * 
 * @param id - Suggestion ID
 * @param status - New status
 * @param reviewedBy - Who reviewed it
 * @param notes - Optional review notes
 * @returns Promise<void>
 */
export async function updateSuggestionStatus(
  id: string,
  status: SuggestionStatusDB,
  reviewedBy: string,
  notes?: string
): Promise<void> {
  const pool = getControlDbPool();
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `
      UPDATE semantic_suggestions
      SET 
        status = $1,
        reviewed_by = $2,
        review_notes = $3,
        reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $4
      `,
      [status, reviewedBy, notes || null, id]
    );
  } catch (error) {
    console.error('❌ Error updating suggestion status:', error);
    throw error;
  }
}

/**
 * Approve a suggestion and create the semantic entity.
 * This is the main approval workflow function.
 * Intelligently handles duplicates by updating existing semantics instead of failing.
 * 
 * @param suggestion - Suggestion to approve
 * @param reviewedBy - Who approved it
 * @returns Promise<void>
 */
export async function approveSuggestion(
  suggestion: SemanticSuggestion,
  reviewedBy: string = 'user'
): Promise<void> {
  // 1. Extract all data from suggestion
  const entity = suggestion.suggested_definition;
  const metadata = entity.metadata || {};
  
  // Build semantic record
  // IMPORTANT: category is for DISPLAY (e.g., "Time Periods")
  //            suggested_type is for MAPPING (e.g., "TIME_PERIOD")
  //            We pass suggested_type separately to saveSemantic for correct DB mapping
  const semanticRecord = {
    category: metadata.category || suggestion.suggested_type,  // Display name
    term: suggestion.suggested_name,
    description: entity.description || '',
    tableName: entity.tableName,
    columnName: entity.columnName,
  };
  
  // Build additional data from metadata
  const additionalData: SemanticAdditionalData = {
    synonyms: metadata.synonyms || [],
    sqlFragment: entity.sqlPattern,
    antiPatterns: metadata.anti_patterns,
    exampleQuestions: metadata.example_questions || [],
    notes: metadata.notes || [],
    aggregation: metadata.aggregation as AggregationDB,
    approvedBy: reviewedBy
  };
  
  // 2. Save with 'learned' source and suggestion's confidence
  // This will handle duplicates automatically (merge instead of fail)
  // Pass suggested_type explicitly so it maps correctly (not the category display name)
  await saveSemantic(
    semanticRecord,
    'learned',
    suggestion.confidence,
    additionalData,
    suggestion.suggested_type  // ✅ Pass the LLM type for correct mapping
  );
  
  // 3. Update suggestion status to 'approved'
  await updateSuggestionStatus(
    suggestion.id,
    'approved',
    reviewedBy,
    'Approved and semantic entity created or updated'
  );
}

/**
 * Reject a suggestion with optional reason.
 * 
 * @param id - Suggestion ID
 * @param reviewedBy - Who rejected it
 * @param reason - Optional rejection reason
 * @returns Promise<void>
 */
export async function rejectSuggestion(
  id: string,
  reviewedBy: string,
  reason?: string
): Promise<void> {
  await updateSuggestionStatus(id, 'rejected', reviewedBy, reason);
}

/**
 * Map database row to SemanticSuggestion interface.
 * Handles JSONB field parsing.
 */
function mapRowToSuggestion(row: any): SemanticSuggestion {
  return {
    id: row.id,
    suggested_name: row.suggested_name,
    suggested_type: row.suggested_type,
    suggested_definition: typeof row.suggested_definition === 'string' 
      ? JSON.parse(row.suggested_definition)
      : row.suggested_definition,
    learned_from: row.learned_from,
    source_run_log_id: row.source_run_log_id,
    learning_dialogue: typeof row.learning_dialogue === 'string'
      ? JSON.parse(row.learning_dialogue)
      : row.learning_dialogue,
    confidence: parseFloat(row.confidence),
    evidence: typeof row.evidence === 'string'
      ? JSON.parse(row.evidence)
      : row.evidence,
    status: row.status,
    requires_expert_review: row.requires_expert_review,
    reviewed_by: row.reviewed_by,
    review_notes: row.review_notes,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at) : undefined,
    created_at: new Date(row.created_at)
  };
}
