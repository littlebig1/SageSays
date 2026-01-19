import pg from 'pg';
import { Semantic, SemanticEntity } from '../types.js';
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
 * Initializes the control database with the official schema.
 * For full schema documentation, see docs/CONTROL_DB_SCHEMA.md
 * 
 * NOTE: This creates a minimal subset of tables. For complete setup,
 * use: npm run init-control-db
 */
export async function initializeControlDB(): Promise<void> {
  if (!config.controlDbUrl) {
    console.log('⚠️  CONTROL_DB_URL not set - skipping control database initialization');
    return;
  }
  const pool = getControlDbPool();
  if (!pool) {
    return;
  }
  const client = await pool.connect();
  
  try {
    // Create semantic_entities table with official schema (matching actual database)
    await client.query(`
      CREATE TABLE IF NOT EXISTS semantic_entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        primary_table TEXT,
        primary_column TEXT,
        sql_fragment TEXT,
        example_values TEXT,
        parent_id UUID REFERENCES semantic_entities(id) ON DELETE CASCADE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create run_logs table with official schema (matching actual database)
    await client.query(`
      CREATE TABLE IF NOT EXISTS run_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question TEXT NOT NULL,
        sql_generated TEXT[] NOT NULL,
        sql_executed TEXT[],
        rows_returned INT[] NOT NULL,
        durations_ms INT[] NOT NULL,
        success BOOLEAN DEFAULT true,
        error_message TEXT,
        user_feedback TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create indexes (using correct column names)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_semantic_entities_type ON semantic_entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_semantic_entities_name ON semantic_entities(name);
      CREATE INDEX IF NOT EXISTS idx_semantic_entities_table ON semantic_entities(primary_table);
      CREATE INDEX IF NOT EXISTS idx_run_logs_created ON run_logs(created_at DESC);
    `);
  } finally {
    client.release();
  }
}

/**
 * Saves a new semantic definition to the control database.
 * Uses the official schema: semantic_entities table.
 * 
 * @param semantic The semantic object to save
 * @returns The saved Semantic object with id and createdAt
 */
export async function saveSemantic(semantic: Omit<Semantic, 'id' | 'createdAt'>): Promise<Semantic> {
  const pool = getControlDbPool();
  if (!pool) {
    throw new Error('Control database not configured. Set CONTROL_DB_URL in .env');
  }
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `INSERT INTO semantic_entities (entity_type, category, name, description, primary_table, primary_column)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, entity_type, category, name, description, primary_table, primary_column, created_at`,
      [semantic.category, semantic.category, semantic.term, semantic.description, semantic.tableName || null, semantic.columnName || null]
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
        created_at 
      FROM semantic_entities 
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (category) {
      query += ` AND (entity_type = $${paramIndex} OR category = $${paramIndex})`;
      paramIndex++;
      params.push(category);
    }
    
    if (term) {
      query += ` AND name = $${paramIndex++}`;
      params.push(term);
    }
    
    query += ' ORDER BY entity_type, name';
    
    const result = await client.query(query, params);
    
    return result.rows.map(row => ({
      id: row.id,
      category: row.category || row.entity_type,
      term: row.name,
      description: row.description,
      tableName: row.primary_table || undefined,
      columnName: row.primary_column || undefined,
      createdAt: new Date(row.created_at),
    }));
  } finally {
    client.release();
  }
}

/**
 * Gets semantic entities with full details from the enhanced schema.
 * Returns all fields from the official semantic_entities table.
 * 
 * @param entityType Optional filter by entity_type
 * @returns Array of SemanticEntity objects with all fields
 */
export async function getSemanticEntities(entityType?: string): Promise<SemanticEntity[]> {
  const pool = getControlDbPool();
  if (!pool) {
    return [];
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
        aggregation,
        complex_logic,
        created_at, 
        updated_at 
      FROM semantic_entities 
      WHERE 1=1
    `;
    const params: any[] = [];
    
    if (entityType) {
      query += ` AND entity_type = $1`;
      params.push(entityType);
    }
    
    query += ' ORDER BY entity_type, name';
    
    const result = await client.query(query, params);
    
    return result.rows.map(row => ({
      id: row.id,
      entityType: row.entity_type,
      name: row.name,
      description: row.description,
      tableName: row.primary_table || undefined,
      columnName: row.primary_column || undefined,
      sqlPattern: row.sql_fragment || undefined,
      exampleValues: row.synonyms?.join(', ') || undefined,
      parentId: undefined, // Not using parent_id in current schema
      metadata: row.complex_logic || undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  } finally {
    client.release();
  }
}

/**
 * Detects which semantics are relevant to a given question.
 * Uses simple keyword matching on term names.
 * 
 * @param question The user's question
 * @returns Array of semantic entity IDs that are relevant
 */
export async function detectSemantics(question: string): Promise<string[]> {
  const semantics = await getSemantics();
  if (semantics.length === 0) {
    return [];
  }
  
  const questionLower = question.toLowerCase();
  const detectedIds: string[] = [];
  
  for (const semantic of semantics) {
    // Check if the exact term appears in the question (with word boundaries)
    const termLower = semantic.term.toLowerCase();
    
    // Use word boundary matching to avoid partial matches
    // e.g., "yesterday" should match "yesterday" but not "yesterdays"
    const regex = new RegExp(`\\b${termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    
    if (regex.test(questionLower)) {
      detectedIds.push(semantic.id);
    }
  }
  
  return detectedIds;
}

export async function formatSemanticsForLLM(semantics: Semantic[]): Promise<string> {
  if (semantics.length === 0) {
    return '';
  }
  
  const parts: string[] = [
    '=== BUSINESS SEMANTICS ===',
    'Use these definitions to correctly interpret the user\'s question:',
    ''
  ];
  
  const byCategory = new Map<string, Semantic[]>();
  for (const sem of semantics) {
    if (!byCategory.has(sem.category)) {
      byCategory.set(sem.category, []);
    }
    byCategory.get(sem.category)!.push(sem);
  }
  
  for (const [category, items] of byCategory.entries()) {
    parts.push(`${category}:`);
    for (const item of items) {
      parts.push(`  • "${item.term}": ${item.description}`);
      if (item.tableName && item.columnName) {
        parts.push(`    Database mapping: ${item.tableName}.${item.columnName}`);
      } else if (item.tableName) {
        parts.push(`    Related table: ${item.tableName}`);
      }
    }
    parts.push(''); // Empty line between categories
  }
  
  parts.push('IMPORTANT: When you see these terms in questions, use the definitions above.\n');
  
  return parts.join('\n');
}
