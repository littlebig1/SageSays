import pg from 'pg';
import { SQLResult, TableSchema, ColumnSchema, TableMetadata, IndexMetadata, ForeignKeyMetadata } from '../types.js';
import { getInspectedDbPool } from './pools.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Re-export for backward compatibility
export { getInspectedDbPool };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// INSPECTED DATABASE - Pure DB Operations Only
// ============================================================================
// This file contains ONLY database operations for the inspected database
// (the database being queried by users).
// Business logic (validation, transformation) should be in src/services/
// Presentation/formatting should be in src/formatters/
// ============================================================================

let schemaCache: TableSchema[] | null = null;
const CACHE_FILE = join(__dirname, '../../data/schema_cache.json');

// ----------------------------------------------------------------------------
// Query Execution
// ----------------------------------------------------------------------------

/**
 * Execute a SQL query against the inspected database.
 * Pure query execution - no validation, no transformation.
 * Business logic (validation, timeout, LIMIT) should be in services.
 * 
 * @param sql - The SQL query to execute
 * @param timeoutMs - Optional statement timeout in milliseconds
 * @returns SQLResult containing columns, rows, row count, and execution duration
 */
export async function executeQuery(
  sql: string,
  timeoutMs?: number
): Promise<SQLResult> {
  const pool = getInspectedDbPool();
  const client = await pool.connect();
  const startTime = Date.now();
  
  try {
    // Set statement timeout if provided
    if (timeoutMs) {
      await client.query(`SET statement_timeout = ${timeoutMs}`);
    }
    
    // Execute the SQL
    const result = await client.query(sql);
    const durationMs = Date.now() - startTime;
    
    return {
      columns: result.fields.map(f => f.name),
      rows: result.rows.map(row => Object.values(row)),
      rowCount: result.rowCount || 0,
      durationMs,
    };
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Schema Loading
// ----------------------------------------------------------------------------

/**
 * Load database schema from the inspected database.
 * Pure DB query - queries information_schema.
 */
export async function loadSchemaFromDB(client: pg.PoolClient): Promise<TableSchema[]> {
  const query = `
    SELECT 
      t.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default
    FROM information_schema.tables t
    JOIN information_schema.columns c ON t.table_name = c.table_name 
      AND t.table_schema = c.table_schema
    WHERE t.table_schema = 'public' 
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name, c.ordinal_position;
  `;

  const result = await client.query(query);
  
  const schemaMap = new Map<string, TableSchema>();
  
  for (const row of result.rows) {
    const tableName = row.table_name;
    if (!schemaMap.has(tableName)) {
      schemaMap.set(tableName, {
        tableName,
        columns: [],
      });
    }
    
    const column: ColumnSchema = {
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      columnDefault: row.column_default || undefined,
    };
    
    schemaMap.get(tableName)!.columns.push(column);
  }
  
  return Array.from(schemaMap.values());
}

/**
 * Retrieves the database schema (tables and columns) from the inspected database.
 * Uses a two-level caching strategy: in-memory cache and file cache.
 * Caching is infrastructure, not business logic, so it's acceptable here.
 * 
 * @param client - PostgreSQL client connection to query the information_schema
 * @param useCache - Whether to use cached schema (default: true). Set to false to force refresh.
 * @returns Array of TableSchema objects containing table and column information
 */
export async function getSchema(client: pg.PoolClient, useCache = true): Promise<TableSchema[]> {
  if (useCache && schemaCache) {
    return schemaCache;
  }
  
  // Try to load from file cache
  if (useCache && existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      schemaCache = cached;
      return cached;
    } catch (error) {
      console.warn('Failed to load schema cache from file:', error);
    }
  }
  
  // Load from database
  const schema = await loadSchemaFromDB(client);
  schemaCache = schema;
  
  // Save to file cache
  try {
    const dataDir = join(__dirname, '../../data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(CACHE_FILE, JSON.stringify(schema, null, 2));
  } catch (error) {
    console.warn('Failed to save schema cache to file:', error);
  }
  
  return schema;
}

/**
 * Clear the schema cache (both in-memory and file).
 * Infrastructure operation.
 */
export function clearSchemaCache(): void {
  schemaCache = null;
  if (existsSync(CACHE_FILE)) {
    try {
      unlinkSync(CACHE_FILE);
    } catch (error) {
      console.warn('Failed to delete schema cache file:', error);
    }
  }
}

// ----------------------------------------------------------------------------
// Metadata Extraction (from inspected DB)
// ----------------------------------------------------------------------------

/**
 * Extract table size statistics from PostgreSQL system catalogs.
 * Uses pg_stat_user_tables for accurate row counts.
 * Pure DB query - queries inspected DB system catalogs.
 */
export async function extractTableSizes(
  client: pg.PoolClient,
  tableName: string,
  schemaName: string = 'public'
): Promise<{
  estimatedRowCount: number;
  totalSizeBytes: number;
}> {
  const query = `
    SELECT 
      COALESCE(st.n_live_tup::BIGINT, 0) as estimated_row_count,
      pg_total_relation_size(c.oid) as total_size_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables st 
      ON st.schemaname = n.nspname 
      AND st.relname = c.relname
    WHERE n.nspname = $1 AND c.relname = $2
  `;
  
  const result = await client.query(query, [schemaName, tableName]);
  
  if (result.rows.length === 0) {
    return {
      estimatedRowCount: 0,
      totalSizeBytes: 0,
    };
  }
  
  const row = result.rows[0];
  return {
    estimatedRowCount: parseInt(row.estimated_row_count) || 0,
    totalSizeBytes: parseInt(row.total_size_bytes) || 0,
  };
}

/**
 * Extract index information for a table.
 * Uses pg_index directly.
 * Pure DB query - queries inspected DB system catalogs.
 */
export async function extractIndexes(
  client: pg.PoolClient,
  tableName: string,
  schemaName: string = 'public'
): Promise<IndexMetadata[]> {
  const query = `
    SELECT
      n.nspname  AS schema_name,
      t.relname  AS table_name,
      i.relname  AS index_name,
      pg_get_indexdef(ix.indexrelid) AS index_definition,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      a.attname AS column_name,
      am.amname AS index_type
    FROM pg_index ix
    JOIN pg_class t
      ON t.oid = ix.indrelid
    JOIN pg_class i
      ON i.oid = ix.indexrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    JOIN pg_am am
      ON am.oid = i.relam
    JOIN pg_attribute a
      ON a.attrelid = t.oid
     AND a.attnum = ANY(ix.indkey)
    WHERE n.nspname = $1
      AND t.relname = $2
    ORDER BY
      table_name,
      index_name,
      array_position(ix.indkey, a.attnum)
  `;
  
  const result = await client.query(query, [schemaName, tableName]);
  
  // Group by index name
  const indexMap = new Map<string, IndexMetadata>();
  
  for (const row of result.rows) {
    const indexName = row.index_name;
    
    if (!indexMap.has(indexName)) {
      indexMap.set(indexName, {
        indexName,
        columns: [],
        isUnique: row.is_unique,
        indexType: row.index_type || 'btree',
        isPrimary: row.is_primary,
        definition: row.index_definition,
      });
    }
    
    indexMap.get(indexName)!.columns.push(row.column_name);
  }
  
  return Array.from(indexMap.values());
}

/**
 * Extract primary key columns for a table.
 * Pure DB query - queries inspected DB system catalogs.
 */
export async function extractPrimaryKeys(
  client: pg.PoolClient,
  tableName: string,
  schemaName: string = 'public'
): Promise<string[]> {
  const query = `
    SELECT a.attname
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = $1 
      AND c.relname = $2 
      AND i.indisprimary = true
    ORDER BY array_position(i.indkey, a.attnum)
  `;
  
  const result = await client.query(query, [schemaName, tableName]);
  return result.rows.map(row => row.attname);
}

/**
 * Extract foreign key relationships for a table.
 * Uses pg_constraint directly.
 * Pure DB query - queries inspected DB system catalogs.
 */
export async function extractForeignKeys(
  client: pg.PoolClient,
  tableName: string,
  schemaName: string = 'public'
): Promise<ForeignKeyMetadata[]> {
  const query = `
    SELECT
      n1.nspname AS table_schema,
      c1.relname AS table_name,
      a1.attname AS column_name,
      n2.nspname AS foreign_table_schema,
      c2.relname AS foreign_table_name,
      a2.attname AS foreign_column_name,
      con.conname AS constraint_name,
      CASE 
        WHEN con.confdeltype = 'c' THEN 'CASCADE'
        WHEN con.confdeltype = 'n' THEN 'SET NULL'
        WHEN con.confdeltype = 'd' THEN 'SET DEFAULT'
        WHEN con.confdeltype = 'r' THEN 'RESTRICT'
        WHEN con.confdeltype = 'a' THEN 'NO ACTION'
        ELSE 'RESTRICT'
      END AS on_delete,
      CASE 
        WHEN con.confupdtype = 'c' THEN 'CASCADE'
        WHEN con.confupdtype = 'n' THEN 'SET NULL'
        WHEN con.confupdtype = 'd' THEN 'SET DEFAULT'
        WHEN con.confupdtype = 'r' THEN 'RESTRICT'
        WHEN con.confupdtype = 'a' THEN 'NO ACTION'
        ELSE 'RESTRICT'
      END AS on_update
    FROM pg_constraint con
    JOIN pg_class c1
      ON con.conrelid = c1.oid
    JOIN pg_namespace n1
      ON c1.relnamespace = n1.oid
    JOIN pg_attribute a1
      ON a1.attrelid = c1.oid
     AND a1.attnum = ANY (con.conkey)
    JOIN pg_class c2
      ON con.confrelid = c2.oid
    JOIN pg_namespace n2
      ON c2.relnamespace = n2.oid
    JOIN pg_attribute a2
      ON a2.attrelid = c2.oid
     AND a2.attnum = ANY (con.confkey)
    WHERE con.contype = 'f'
      AND n1.nspname = $1
      AND c1.relname = $2
    ORDER BY
      table_name,
      column_name
  `;
  
  const result = await client.query(query, [schemaName, tableName]);
  
  return result.rows.map(row => ({
    constraintName: row.constraint_name,
    fromColumn: row.column_name,
    toTable: row.foreign_table_name,
    toColumn: row.foreign_column_name,
    onDelete: row.on_delete,
    onUpdate: row.on_update,
  }));
}

/**
 * Extract complete metadata for a single table.
 * Pure DB queries - orchestrates multiple extraction functions.
 */
export async function extractTableMetadata(
  client: pg.PoolClient,
  tableName: string,
  schemaName: string = 'public'
): Promise<TableMetadata> {
  const [sizes, indexes, primaryKeys, foreignKeys] = await Promise.all([
    extractTableSizes(client, tableName, schemaName),
    extractIndexes(client, tableName, schemaName),
    extractPrimaryKeys(client, tableName, schemaName),
    extractForeignKeys(client, tableName, schemaName),
  ]);
  
  return {
    tableName,
    schemaName,
    estimatedRowCount: sizes.estimatedRowCount,
    totalSizeBytes: sizes.totalSizeBytes,
    tableSizeBytes: 0, // Deprecated - kept for backward compatibility
    indexSizeBytes: 0, // Deprecated - kept for backward compatibility
    primaryKeyColumns: primaryKeys,
    indexes,
    foreignKeys,
    lastAnalyzed: new Date(),
    lastUpdated: new Date(),
  };
}

/**
 * Extract metadata for all tables in the schema.
 * Pure DB queries - orchestrates extraction for multiple tables.
 */
export async function extractAllTableMetadata(
  client: pg.PoolClient,
  schemaName: string = 'public'
): Promise<TableMetadata[]> {
  // Get list of all tables
  const tablesQuery = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  
  const tablesResult = await client.query(tablesQuery, [schemaName]);
  const tableNames = tablesResult.rows.map(row => row.table_name);
  
  // Extract metadata for each table (in parallel for speed)
  const metadataPromises = tableNames.map(name => 
    extractTableMetadata(client, name, schemaName)
  );
  
  return Promise.all(metadataPromises);
}

// ============================================================================
// TEMPORARY: Business Logic Functions (TO BE MOVED TO src/services/)
// ============================================================================
// These functions contain business logic and should be moved to services/
// They are kept here temporarily for backward compatibility during refactoring.
// ============================================================================

/**
 * @deprecated This function contains business logic (validation, timeout, LIMIT).
 * Should be moved to src/services/queryService.ts
 * 
 * Executes a SQL query with safety validations.
 * This is a high-level function that orchestrates validation and execution.
 */
export async function runSQL(sql: string): Promise<SQLResult> {
  // Import guard dynamically to avoid circular dependency
  const { validateSQL } = await import('../agent/guard.js');
  const { config } = await import('../config.js');
  
  // Runtime assertion: ensure sql is a non-empty string
  if (!sql || typeof sql !== 'string') {
    throw new Error('Invalid SQL: must be a non-empty string');
  }
  
  // Validate SQL before execution
  const validation = validateSQL(sql);
  if (!validation.valid) {
    throw new Error(`SQL validation failed: ${validation.reason}`);
  }
  
  const sanitizedSQL = validation.sanitizedSQL || sql;
  
  return executeQuery(sanitizedSQL, config.statementTimeoutMs);
}

/**
 * @deprecated This function contains presentation/formatting logic.
 * Should be moved to src/formatters/schemaFormatter.ts
 * 
 * Formats database schema into a human-readable text format for LLM consumption.
 */
export function formatSchemaForLLM(schema: TableSchema[], tableName?: string): string {
  const tables = tableName 
    ? schema.filter(t => t.tableName === tableName)
    : schema;
  
  if (tables.length === 0) {
    return tableName ? `Table "${tableName}" not found.` : 'No tables found.';
  }
  
  const parts: string[] = [];
  
  for (const table of tables) {
    parts.push(`Table: ${table.tableName}`);
    parts.push('Columns:');
    for (const col of table.columns) {
      const nullable = col.isNullable ? 'NULL' : 'NOT NULL';
      const defaultVal = col.columnDefault ? ` DEFAULT ${col.columnDefault}` : '';
      parts.push(`  - ${col.columnName}: ${col.dataType} ${nullable}${defaultVal}`);
    }
    parts.push('');
  }
  
  return parts.join('\n');
}

/**
 * @deprecated This function contains business logic (orchestration).
 * Should be moved to src/services/schemaService.ts
 * 
 * Get schema with optional metadata enrichment from control database.
 */
export async function getSchemaWithMetadata(
  client: pg.PoolClient,
  useCache = true
): Promise<TableSchema[]> {
  const schema = await getSchema(client, useCache);
  
  // Load metadata from control DB if available
  const { getAllTableMetadata } = await import('./controlDb.js');
  const allMetadata = await getAllTableMetadata();
  const metadataMap = new Map(
    allMetadata.map(m => [m.tableName, m])
  );
  
  // Enrich schema with metadata
  return schema.map(table => ({
    ...table,
    metadata: metadataMap.get(table.tableName),
  }));
}
