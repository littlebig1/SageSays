import pg from 'pg';
import { Semantic, EntityTypeDB, SourceDB, SemanticAdditionalData, mapToDBEntityType } from '../types.js';
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
 * Initialize the control database with semantic_entities and run_logs tables.
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
 * Check if a semantic entity already exists with the given name and type.
 * 
 * @param name The semantic name
 * @param entityType The entity type
 * @returns The existing semantic if found, null otherwise
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
 * Update an existing semantic entity with new information from learning.
 * This is used when AI generates a duplicate name - we merge/update instead of failing.
 * 
 * @param existingId ID of existing semantic
 * @param updates New information to merge
 * @returns Updated semantic
 */
export async function updateSemanticFromLearning(
  existingId: string,
  updates: {
    description?: string;
    sqlFragment?: string;
    synonyms?: string[];
    antiPatterns?: any;
    exampleQuestions?: string[];
    notes?: string[];
    confidence?: number;
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
      // Merge with existing synonyms (array concatenation)
      setClauses.push(`synonyms = array_cat(COALESCE(synonyms, '{}'), $${paramIndex++}::text[])`);
      values.push(updates.synonyms);
    }
    
    if (updates.antiPatterns) {
      setClauses.push(`anti_patterns = $${paramIndex++}`);
      values.push(JSON.stringify(updates.antiPatterns));
    }
    
    if (updates.exampleQuestions) {
      setClauses.push(`example_questions = array_cat(COALESCE(example_questions, '{}'), $${paramIndex++}::text[])`);
      values.push(updates.exampleQuestions);
    }
    
    if (updates.notes) {
      setClauses.push(`notes = array_cat(COALESCE(notes, '{}'), $${paramIndex++}::text[])`);
      values.push(updates.notes);
    }
    
    if (updates.confidence !== undefined) {
      // Update confidence if new one is higher
      setClauses.push(`confidence = GREATEST(COALESCE(confidence, 0), $${paramIndex++})`);
      values.push(updates.confidence);
    }
    
    // Always increment version and update timestamp
    setClauses.push('version = version + 1');
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    setClauses.push('usage_count = usage_count + 1'); // Track that it was reinforced
    
    values.push(existingId);
    
    await client.query(
      `UPDATE semantic_entities 
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}`,
      values
    );
    
    console.log(`   ✓ Updated existing semantic (ID: ${existingId}) with new learning`);
  } finally {
    client.release();
  }
}

/**
 * Saves a new semantic definition to the control database.
 * Handles duplicate names intelligently:
 * - If duplicate exists, updates it with new information
 * - If new, creates a new semantic entity
 * 
 * @param semantic The semantic object to save
 * @param source Source of the semantic ('manual', 'learned', etc.)
 * @param confidence Confidence score (0.0 to 1.0)
 * @param additionalData Optional additional fields
 * @param explicitEntityType Optional: LLM entity type to use for mapping (e.g., 'TIME_PERIOD')
 * @returns The saved or updated Semantic object
 */
export async function saveSemantic(
  semantic: Omit<Semantic, 'id' | 'createdAt'>,
  source: SourceDB = 'manual',
  confidence?: number,
  additionalData?: SemanticAdditionalData,
  explicitEntityType?: string
): Promise<Semantic> {
  const pool = getControlDbPool();
  if (!pool) {
    throw new Error('Control database not configured. Set CONTROL_DB_URL in .env');
  }
  
  // Map the entity type to database format
  // Use explicit type if provided (from LLM suggestion), otherwise try to map from category
  const entityType = explicitEntityType 
    ? mapToDBEntityType(explicitEntityType)
    : mapToDBEntityType(semantic.category);
  
  // Check if duplicate exists
  const existing = await findExistingSemantic(semantic.term, entityType);
  
  if (existing) {
    // Duplicate found - update instead of creating
    console.log(`   ⚠️  Semantic "${semantic.term}" (type: ${entityType}) already exists`);
    console.log(`   📝 Merging new information into existing semantic...`);
    
    await updateSemanticFromLearning(existing.id, {
      description: semantic.description,
      sqlFragment: additionalData?.sqlFragment,
      synonyms: additionalData?.synonyms,
      antiPatterns: additionalData?.antiPatterns,
      exampleQuestions: additionalData?.exampleQuestions,
      notes: additionalData?.notes,
      confidence: confidence,
    });
    
    return existing; // Return existing semantic (caller should handle that it was merged)
  }
  
  // No duplicate - create new semantic
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
        entityType,
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
        additionalData?.aggregation || null,
        source,
        confidence || 1.00,
        true, // approved = true when creating from approved suggestion
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
    };
  } catch (error: any) {
    // Catch unique constraint violation as backup
    if (error.code === '23505') {
      console.warn(`   ⚠️  Race condition: Semantic "${semantic.term}" was created by another process`);
      // Re-check and update
      const existing = await findExistingSemantic(semantic.term, entityType);
      if (existing) {
        await updateSemanticFromLearning(existing.id, {
          description: semantic.description,
          sqlFragment: additionalData?.sqlFragment,
          synonyms: additionalData?.synonyms,
          antiPatterns: additionalData?.antiPatterns,
          exampleQuestions: additionalData?.exampleQuestions,
          notes: additionalData?.notes,
          confidence: confidence,
        });
        return existing;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retrieves semantic definitions from the control database.
 * Uses the official schema: semantic_entities table with fixed columns.
 * 
 * @param category Optional entity_type to filter semantics (e.g., 'METRIC', 'DIMENSION')
 * @param term Optional name to filter semantics
 * @returns Array of Semantic objects
 */
export async function getSemantics(category?: string, term?: string): Promise<Semantic[]> {
  const pool = getControlDbPool();
  if (!pool) {
    return []; // Return empty array if control DB not configured
  }
  const client = await pool.connect();
  
  try {
    // Query from semantic_entities table (using actual schema)
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
      // Rich metadata fields
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

/**
 * Format semantics for LLM context in a clear, readable format.
 * Includes all rich metadata, especially SQL patterns, to guide LLM in generating correct queries.
 * 
 * @param semantics Array of semantic definitions
 * @returns Formatted string for LLM prompt
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
      
      // SQL Fragment (most important!)
      if (semantic.sqlFragment) {
        output += `    SQL Pattern: ${semantic.sqlFragment}\n`;
      }
      
      // Table/column reference
      if (semantic.tableName) {
        output += `    Table: ${semantic.tableName}`;
        if (semantic.columnName) {
          output += `, Column: ${semantic.columnName}`;
        }
        output += '\n';
      }
      
      // Aggregation for metrics
      if (semantic.aggregation) {
        output += `    Aggregation: ${semantic.aggregation}\n`;
      }
      
      // Synonyms
      if (semantic.synonyms && semantic.synonyms.length > 0) {
        output += `    Synonyms: ${semantic.synonyms.join(', ')}\n`;
      }
      
      // Anti-patterns (what NOT to do)
      if (semantic.antiPatterns) {
        output += `    AVOID: ${semantic.antiPatterns.wrong}\n`;
        output += `    Reason: ${semantic.antiPatterns.why}\n`;
        if (semantic.antiPatterns.correct) {
          output += `    Use instead: ${semantic.antiPatterns.correct}\n`;
        }
      }
      
      // Example questions
      if (semantic.exampleQuestions && semantic.exampleQuestions.length > 0) {
        output += `    Examples: ${semantic.exampleQuestions.join('; ')}\n`;
      }
      
      // Notes
      if (semantic.notes && semantic.notes.length > 0) {
        output += `    Notes: ${semantic.notes.join('; ')}\n`;
      }
      
      output += '\n';
    }
  }
  
  return output.trim();
}

/**
 * Detect which semantics are relevant to a given question.
 * Simple keyword matching for now (can be enhanced with embeddings later).
 * 
 * @param question User's question
 * @returns Array of semantic IDs that were detected
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
