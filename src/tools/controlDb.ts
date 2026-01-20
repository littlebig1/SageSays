import pg from 'pg';
import { 
  Semantic, 
  EntityTypeDB, 
  SourceDB, 
  SemanticAdditionalData, 
  SemanticSuggestion,
  SuggestionStatusDB,
  RunLog,
  CorrectionCapture,
  TableMetadata,
  mapToDBEntityType
} from '../types.js';
import { getControlDbPool } from './pools.js';

// Re-export for backward compatibility
export { getControlDbPool };

// ============================================================================
// CONTROL DATABASE - Pure DB Operations Only
// ============================================================================
// This file contains ONLY database CRUD operations for the control database.
// Business logic should be in src/services/
// Presentation/formatting should be in src/formatters/
// ============================================================================

// ----------------------------------------------------------------------------
// Initialization
// ----------------------------------------------------------------------------

/**
 * Initialize the control database connection.
 * This function is idempotent - safe to call multiple times.
 */
export async function initializeControlDB(): Promise<void> {
  const pool = getControlDbPool();
  if (!pool) {
    console.log('⚠️  CONTROL_DB_URL not set - skipping control database initialization');
    return;
  }
  const client = await pool.connect();
  
  try {
    // Note: Tables are assumed to exist (created by user's schema)
    // This function could be expanded to create tables if needed
    console.log('Control database connection verified');
  } finally {
    client.release();
  }
}

/**
 * Initialize the inspected_db_metadata table in control database
 */
export async function initializeMetadataTable(): Promise<void> {
  const pool = getControlDbPool();
  if (!pool) {
    console.log('⚠️  CONTROL_DB_URL not set - skipping metadata table initialization');
    return;
  }
  
  const client = await pool.connect();
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS inspected_db_metadata (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        table_name TEXT NOT NULL,
        schema_name TEXT DEFAULT 'public',
        
        estimated_row_count BIGINT,
        total_size_bytes BIGINT,
        table_size_bytes BIGINT,
        index_size_bytes BIGINT,
        
        primary_key_columns TEXT[] DEFAULT '{}',
        indexes JSONB DEFAULT '[]',
        foreign_keys JSONB DEFAULT '[]',
        
        last_analyzed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        UNIQUE(table_name, schema_name)
      );
      
      CREATE INDEX IF NOT EXISTS idx_metadata_table 
        ON inspected_db_metadata(table_name);
      CREATE INDEX IF NOT EXISTS idx_metadata_analyzed 
        ON inspected_db_metadata(last_analyzed);
    `);
    
    console.log('✅ Metadata table initialized');
  } catch (error) {
    console.error('❌ Error initializing metadata table:', error);
    throw error;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Semantic Entities (semantic_entities table)
// ----------------------------------------------------------------------------

/**
 * Check if a semantic entity already exists with the given name and type.
 * Pure DB query - no business logic.
 */
export async function findExistingSemantic(
  name: string,
  entityType: EntityTypeDB
): Promise<Semantic | null> {
  const pool = getControlDbPool();
  if (!pool) return null;
  
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT 
        id, 
        entity_type, 
        name, 
        category,
        description, 
        primary_table,
        primary_column,
        created_at,
        version
      FROM semantic_entities
      WHERE name = $1 AND entity_type = $2
      LIMIT 1`,
      [name, entityType]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      id: row.id,
      category: row.category || row.entity_type,
      term: row.name,
      description: row.description,
      tableName: row.primary_table || undefined,
      columnName: row.primary_column || undefined,
      createdAt: new Date(row.created_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update an existing semantic entity.
 * Pure DB update - business logic (merging rules) should be in services.
 */
export async function updateSemantic(
  existingId: string,
  updates: {
    description?: string;
    sqlFragment?: string;
    synonyms?: string[];
    antiPatterns?: any;
    exampleQuestions?: string[];
    notes?: string[];
    confidence?: number;
    incrementVersion?: boolean;
    incrementUsageCount?: boolean;
  }
): Promise<void> {
  const pool = getControlDbPool();
  if (!pool) return;
  
  const client = await pool.connect();
  
  try {
    // Build dynamic UPDATE based on what fields are provided
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (updates.description) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    
    if (updates.sqlFragment) {
      setClauses.push(`sql_fragment = $${paramIndex++}`);
      values.push(updates.sqlFragment);
    }
    
    if (updates.synonyms) {
      setClauses.push(`synonyms = $${paramIndex++}::text[]`);
      values.push(updates.synonyms);
    }
    
    if (updates.antiPatterns) {
      setClauses.push(`anti_patterns = $${paramIndex++}`);
      values.push(JSON.stringify(updates.antiPatterns));
    }
    
    if (updates.exampleQuestions) {
      setClauses.push(`example_questions = $${paramIndex++}::text[]`);
      values.push(updates.exampleQuestions);
    }
    
    if (updates.notes) {
      setClauses.push(`notes = $${paramIndex++}::text[]`);
      values.push(updates.notes);
    }
    
    if (updates.confidence !== undefined) {
      setClauses.push(`confidence = $${paramIndex++}`);
      values.push(updates.confidence);
    }
    
    if (updates.incrementVersion) {
      setClauses.push('version = version + 1');
    }
    
    if (updates.incrementUsageCount) {
      setClauses.push('usage_count = usage_count + 1');
    }
    
    // Always update timestamp
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    
    values.push(existingId);
    
    await client.query(
      `UPDATE semantic_entities 
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}`,
      values
    );
  } finally {
    client.release();
  }
}

/**
 * Insert a new semantic entity.
 * Pure DB insert - business logic (duplicate handling) should be in services.
 */
export async function insertSemantic(
  semantic: Omit<Semantic, 'id' | 'createdAt'>,
  source: SourceDB = 'manual',
  confidence?: number,
  additionalData?: SemanticAdditionalData,
  entityType?: EntityTypeDB
): Promise<Semantic> {
  const pool = getControlDbPool();
  if (!pool) {
    throw new Error('Control database not configured. Set CONTROL_DB_URL in .env');
  }
  
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `INSERT INTO semantic_entities (
        entity_type, category, name, description,
        primary_table, primary_column, sql_fragment,
        synonyms, anti_patterns, example_questions, notes,
        aggregation, source, confidence,
        approved, approved_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, entity_type, category, name, description, primary_table, primary_column, created_at`,
      [
        entityType || 'entity',
        semantic.category,
        semantic.term,
        semantic.description,
        semantic.tableName || null,
        semantic.columnName || null,
        additionalData?.sqlFragment || null,
        additionalData?.synonyms || [],
        additionalData?.antiPatterns ? JSON.stringify(additionalData.antiPatterns) : null,
        additionalData?.exampleQuestions || [],
        additionalData?.notes || [],
        additionalData?.aggregation ? String(additionalData.aggregation) : null,
        source,
        confidence || 1.00,
        true,
        additionalData?.approvedBy || null
      ]
    );
    
    const row = result.rows[0];
    return {
      id: row.id,
      category: row.category || row.entity_type,
      term: row.name,
      description: row.description,
      tableName: row.primary_table || undefined,
      columnName: row.primary_column || undefined,
      createdAt: new Date(row.created_at),
      sqlFragment: additionalData?.sqlFragment,
      synonyms: additionalData?.synonyms,
      antiPatterns: additionalData?.antiPatterns,
      exampleQuestions: additionalData?.exampleQuestions,
      notes: additionalData?.notes,
      aggregation: additionalData?.aggregation || undefined,
    };
  } finally {
    client.release();
  }
}

/**
 * Retrieve semantic definitions from the control database.
 * Pure DB query - no business logic.
 */
export async function getSemantics(category?: string, term?: string): Promise<Semantic[]> {
  const pool = getControlDbPool();
  if (!pool) {
    return []; // Return empty array if control DB not configured
  }
  const client = await pool.connect();
  
  try {
    let query = `
      SELECT 
        id, 
        entity_type, 
        name, 
        category,
        description, 
        primary_table,
        primary_column,
        sql_fragment,
        synonyms,
        anti_patterns,
        example_questions,
        notes,
        aggregation,
        created_at
      FROM semantic_entities
      WHERE 1=1
    `;
    const params: any[] = [];
    
    if (category) {
      params.push(category);
      query += ` AND (entity_type = $${params.length} OR category = $${params.length})`;
    }
    
    if (term) {
      params.push(term);
      query += ` AND name = $${params.length}`;
    }
    
    query += ' ORDER BY usage_count DESC, name ASC';
    
    const result = await client.query(query, params);
    
    return result.rows.map(row => ({
      id: row.id,
      category: row.category || row.entity_type,
      term: row.name,
      description: row.description,
      tableName: row.primary_table || undefined,
      columnName: row.primary_column || undefined,
      createdAt: new Date(row.created_at),
      sqlFragment: row.sql_fragment || undefined,
      synonyms: row.synonyms || undefined,
      antiPatterns: row.anti_patterns || undefined,
      exampleQuestions: row.example_questions || undefined,
      notes: row.notes || undefined,
      aggregation: row.aggregation || undefined,
    }));
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Semantic Suggestions (semantic_suggestions table)
// ----------------------------------------------------------------------------

/**
 * Save a semantic suggestion to the semantic_suggestions table.
 * Pure DB insert.
 */
export async function insertSuggestion(
  suggestion: Omit<SemanticSuggestion, 'id' | 'created_at'>
): Promise<SemanticSuggestion | null> {
  const pool = getControlDbPool();
  if (!pool) {
    console.warn('⚠️  Control database not configured - skipping suggestion save');
    return null;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
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
  } finally {
    client.release();
  }
}

/**
 * Get all pending suggestions for review.
 * Pure DB query.
 */
export async function getPendingSuggestions(): Promise<SemanticSuggestion[]> {
  const pool = getControlDbPool();
  if (!pool) {
    return [];
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
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
  } finally {
    client.release();
  }
}

/**
 * Update suggestion status (approve/reject).
 * Pure DB update.
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

  const client = await pool.connect();
  
  try {
    await client.query(
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
  } finally {
    client.release();
  }
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

// ----------------------------------------------------------------------------
// Run Logs (run_logs table)
// ----------------------------------------------------------------------------

/**
 * Save a run log entry to the control database.
 * Pure DB insert.
 */
export async function insertRunLog(
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
 * Retrieve recent run logs from the control database.
 * Pure DB query.
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

/**
 * Get a specific run log by ID.
 * Pure DB query.
 */
export async function getRunLogById(runLogId: string): Promise<any | null> {
  const pool = getControlDbPool();
  if (!pool) {
    return null;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
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
  } finally {
    client.release();
  }
}

/**
 * Update a run log with correction information.
 * Pure DB update.
 */
export async function updateRunLogCorrection(
  runLogId: string,
  correction: CorrectionCapture
): Promise<void> {
  const pool = getControlDbPool();
  if (!pool) {
    console.warn('⚠️  Control database not configured - skipping correction save');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
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
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Inspected DB Metadata (inspected_db_metadata table)
// ----------------------------------------------------------------------------

/**
 * Store table metadata in control database.
 * Pure DB insert/update.
 */
export async function saveTableMetadata(
  metadata: TableMetadata
): Promise<TableMetadata> {
  const pool = getControlDbPool();
  if (!pool) {
    throw new Error('Control database not configured. Set CONTROL_DB_URL in .env');
  }
  
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `INSERT INTO inspected_db_metadata (
        table_name, schema_name,
        estimated_row_count, total_size_bytes, table_size_bytes, index_size_bytes,
        primary_key_columns, indexes, foreign_keys,
        last_analyzed, last_updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (table_name, schema_name) 
      DO UPDATE SET
        estimated_row_count = EXCLUDED.estimated_row_count,
        total_size_bytes = EXCLUDED.total_size_bytes,
        table_size_bytes = COALESCE(EXCLUDED.table_size_bytes, 0),
        index_size_bytes = COALESCE(EXCLUDED.index_size_bytes, 0),
        primary_key_columns = EXCLUDED.primary_key_columns,
        indexes = EXCLUDED.indexes,
        foreign_keys = EXCLUDED.foreign_keys,
        last_analyzed = EXCLUDED.last_analyzed,
        last_updated = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        metadata.tableName,
        metadata.schemaName,
        metadata.estimatedRowCount,
        metadata.totalSizeBytes,
        metadata.tableSizeBytes || 0,
        metadata.indexSizeBytes || 0,
        metadata.primaryKeyColumns,
        JSON.stringify(metadata.indexes),
        JSON.stringify(metadata.foreignKeys),
      ]
    );
    
    const row = result.rows[0];
    return mapRowToMetadata(row);
  } finally {
    client.release();
  }
}

/**
 * Get metadata for a specific table.
 * Pure DB query.
 */
export async function getTableMetadata(
  tableName: string,
  schemaName: string = 'public'
): Promise<TableMetadata | null> {
  const pool = getControlDbPool();
  if (!pool) return null;
  
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT * FROM inspected_db_metadata
       WHERE table_name = $1 AND schema_name = $2`,
      [tableName, schemaName]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return mapRowToMetadata(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Get metadata for all tables.
 * Pure DB query.
 */
export async function getAllTableMetadata(): Promise<TableMetadata[]> {
  const pool = getControlDbPool();
  if (!pool) return [];
  
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT * FROM inspected_db_metadata
       ORDER BY table_name`
    );
    
    return result.rows.map(mapRowToMetadata);
  } finally {
    client.release();
  }
}

/**
 * Helper to map database row to TableMetadata
 */
function mapRowToMetadata(row: any): TableMetadata {
  return {
    id: row.id,
    tableName: row.table_name,
    schemaName: row.schema_name,
    estimatedRowCount: parseInt(row.estimated_row_count) || 0,
    totalSizeBytes: parseInt(row.total_size_bytes) || 0,
    tableSizeBytes: row.table_size_bytes ? parseInt(row.table_size_bytes) : 0,
    indexSizeBytes: row.index_size_bytes ? parseInt(row.index_size_bytes) : 0,
    primaryKeyColumns: row.primary_key_columns || [],
    indexes: row.indexes || [],
    foreignKeys: row.foreign_keys || [],
    lastAnalyzed: new Date(row.last_analyzed),
    lastUpdated: new Date(row.last_updated),
  };
}

// ============================================================================
// TEMPORARY: Business Logic Functions (TO BE MOVED TO src/services/)
// ============================================================================
// These functions contain business logic and should be moved to services/
// They are kept here temporarily for backward compatibility during refactoring.
// ============================================================================

/**
 * @deprecated This function contains business logic (duplicate detection, merging).
 * Should be moved to src/services/semanticService.ts
 * 
 * Saves a semantic with intelligent duplicate handling.
 * This is a high-level function that orchestrates multiple DB operations.
 */
export async function saveSemantic(
  semantic: Omit<Semantic, 'id' | 'createdAt'>,
  source: SourceDB = 'manual',
  confidence?: number,
  additionalData?: SemanticAdditionalData,
  explicitEntityType?: string
): Promise<Semantic> {
  // Map the entity type to database format
  const entityType = explicitEntityType 
    ? mapToDBEntityType(explicitEntityType)
    : mapToDBEntityType(semantic.category);
  
  // Check if duplicate exists
  const existing = await findExistingSemantic(semantic.term, entityType);
  
  if (existing) {
    // Duplicate found - update instead of creating
    console.log(`   ⚠️  Semantic "${semantic.term}" (type: ${entityType}) already exists`);
    console.log(`   📝 Merging new information into existing semantic...`);
    
    await updateSemantic(existing.id, {
      description: semantic.description,
      sqlFragment: additionalData?.sqlFragment,
      synonyms: additionalData?.synonyms,
      antiPatterns: additionalData?.antiPatterns,
      exampleQuestions: additionalData?.exampleQuestions,
      notes: additionalData?.notes,
      confidence: confidence,
      incrementVersion: true,
      incrementUsageCount: true,
    });
    
    return existing;
  }
  
  // No duplicate - create new semantic
  try {
    return await insertSemantic(semantic, source, confidence, additionalData, entityType);
  } catch (error: any) {
    // Catch unique constraint violation as backup
    if (error.code === '23505') {
      console.warn(`   ⚠️  Race condition: Semantic "${semantic.term}" was created by another process`);
      // Re-check and update
      const existing = await findExistingSemantic(semantic.term, entityType);
      if (existing) {
        await updateSemantic(existing.id, {
          description: semantic.description,
          sqlFragment: additionalData?.sqlFragment,
          synonyms: additionalData?.synonyms,
          antiPatterns: additionalData?.antiPatterns,
          exampleQuestions: additionalData?.exampleQuestions,
          notes: additionalData?.notes,
          confidence: confidence,
          incrementVersion: true,
          incrementUsageCount: true,
        });
        return existing;
      }
    }
    throw error;
  }
}

/**
 * @deprecated This function contains business logic (data transformation, orchestration).
 * Should be moved to src/services/suggestionService.ts
 * 
 * Approve a suggestion and create the semantic entity.
 * This orchestrates multiple DB operations and contains business logic.
 */
export async function approveSuggestion(
  suggestion: SemanticSuggestion,
  reviewedBy: string = 'user'
): Promise<void> {
  // Extract all data from suggestion
  const entity = suggestion.suggested_definition;
  const metadata = entity.metadata || {};
  
  // Build semantic record
  const semanticRecord = {
    category: metadata.category || suggestion.suggested_type,
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
    aggregation: metadata.aggregation as any,
    approvedBy: reviewedBy
  };
  
  // Save with 'learned' source and suggestion's confidence
  await saveSemantic(
    semanticRecord,
    'learned',
    suggestion.confidence,
    additionalData,
    suggestion.suggested_type
  );
  
  // Update suggestion status to 'approved'
  await updateSuggestionStatus(
    suggestion.id,
    'approved',
    reviewedBy,
    'Approved and semantic entity created or updated'
  );
}

/**
 * @deprecated This function contains business logic (keyword matching algorithm).
 * Should be moved to src/services/semanticService.ts
 * 
 * Detect which semantics are relevant to a given question.
 */
export async function detectSemantics(question: string): Promise<string[]> {
  const allSemantics = await getSemantics();
  const questionLower = question.toLowerCase();
  const detected: string[] = [];
  
  for (const semantic of allSemantics) {
    // Check if semantic term appears in question
    const termLower = semantic.term.toLowerCase();
    if (questionLower.includes(termLower)) {
      detected.push(semantic.id);
    }
  }
  
  return detected;
}

/**
 * @deprecated This function contains presentation/formatting logic.
 * Should be moved to src/formatters/semanticFormatter.ts
 * 
 * Format semantics for LLM context in a clear, readable format.
 */
export async function formatSemanticsForLLM(semantics: Semantic[]): Promise<string> {
  if (semantics.length === 0) {
    return 'Business Semantics: No business semantics defined yet.';
  }

  let output = 'Business Semantics:\n\n';
  
  // Group by category
  const grouped = semantics.reduce((acc, semantic) => {
    const cat = semantic.category || 'General';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(semantic);
    return acc;
  }, {} as Record<string, Semantic[]>);
  
  for (const [category, items] of Object.entries(grouped)) {
    output += `${category}:\n`;
    for (const semantic of items) {
      output += `  - ${semantic.term}: ${semantic.description}\n`;
      
      if (semantic.sqlFragment) {
        output += `    SQL Pattern: ${semantic.sqlFragment}\n`;
      }
      
      if (semantic.tableName) {
        output += `    Table: ${semantic.tableName}`;
        if (semantic.columnName) {
          output += `, Column: ${semantic.columnName}`;
        }
        output += '\n';
      }
      
      if (semantic.aggregation) {
        output += `    Aggregation: ${semantic.aggregation}\n`;
      }
      
      if (semantic.synonyms && semantic.synonyms.length > 0) {
        output += `    Synonyms: ${semantic.synonyms.join(', ')}\n`;
      }
      
      if (semantic.antiPatterns) {
        output += `    AVOID: ${semantic.antiPatterns.wrong}\n`;
        output += `    Reason: ${semantic.antiPatterns.why}\n`;
        if (semantic.antiPatterns.correct) {
          output += `    Use instead: ${semantic.antiPatterns.correct}\n`;
        }
      }
      
      if (semantic.exampleQuestions && semantic.exampleQuestions.length > 0) {
        output += `    Examples: ${semantic.exampleQuestions.join('; ')}\n`;
      }
      
      if (semantic.notes && semantic.notes.length > 0) {
        output += `    Notes: ${semantic.notes.join('; ')}\n`;
      }
      
      output += '\n';
    }
  }
  
  return output.trim();
}

/**
 * @deprecated This function contains presentation/formatting logic.
 * Should be moved to src/formatters/metadataFormatter.ts
 * 
 * Format metadata for LLM prompt.
 */
export function formatMetadataForLLM(
  schema: Array<{ tableName: string; metadata?: TableMetadata }>
): string {
  const parts: string[] = [];
  
  for (const table of schema) {
    if (!table.metadata) continue;
    
    const m = table.metadata;
    parts.push(`Table: ${table.tableName}`);
    
    if (m.estimatedRowCount > 0) {
      parts.push(`  Estimated rows: ${m.estimatedRowCount.toLocaleString()}`);
    }
    
    if (m.primaryKeyColumns.length > 0) {
      parts.push(`  Primary key: ${m.primaryKeyColumns.join(', ')}`);
    }
    
    if (m.indexes.length > 0) {
      parts.push(`  Indexes:`);
      for (const idx of m.indexes) {
        const unique = idx.isUnique ? 'UNIQUE ' : '';
        const primary = idx.isPrimary ? ' (PRIMARY KEY)' : '';
        parts.push(`    - ${unique}${idx.indexName} on (${idx.columns.join(', ')})${primary}`);
      }
    }
    
    if (m.foreignKeys.length > 0) {
      parts.push(`  Foreign keys:`);
      for (const fk of m.foreignKeys) {
        parts.push(`    - ${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`);
      }
    }
    
    parts.push('');
  }
  
  return parts.join('\n');
}

/**
 * @deprecated This function contains business logic (orchestration).
 * Should be moved to src/services/metadataService.ts
 * 
 * Refresh metadata for all tables (extract from inspected DB and store in control DB).
 */
export async function refreshAllMetadata(
  inspectedDbClient: pg.PoolClient
): Promise<TableMetadata[]> {
  // Import from inspectedDb to avoid circular dependency
  const { extractAllTableMetadata } = await import('./inspectedDb.js');
  
  console.log('📊 Extracting metadata from inspected database...');
  const allMetadata = await extractAllTableMetadata(inspectedDbClient);
  
  console.log(`   Found ${allMetadata.length} tables`);
  
  if (allMetadata.length === 0) {
    return [];
  }
  
  const pool = getControlDbPool();
  if (!pool) {
    console.warn('⚠️  Control database not configured - metadata not saved');
    return allMetadata;
  }
  
  console.log('💾 Storing metadata in control database...');
  
  // Store all metadata (use transaction for atomicity)
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const metadata of allMetadata) {
      await saveTableMetadata(metadata);
    }
    
    await client.query('COMMIT');
    console.log(`✅ Metadata stored for ${allMetadata.length} tables`);
    
    return allMetadata;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// Backward Compatibility Aliases
// ============================================================================
// These aliases maintain compatibility with existing code during migration.
// They will be removed once all imports are updated.
// ============================================================================

// Run Logs aliases
export const saveRunLog = insertRunLog;
export const saveCorrection = updateRunLogCorrection;

// Suggestions aliases
export const saveSuggestion = insertSuggestion;
export async function rejectSuggestion(
  id: string,
  reviewedBy: string,
  reason?: string
): Promise<void> {
  await updateSuggestionStatus(id, 'rejected', reviewedBy, reason);
}
