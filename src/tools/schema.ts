import pg from 'pg';
import { TableSchema, ColumnSchema } from '../types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let schemaCache: TableSchema[] | null = null;
const CACHE_FILE = join(__dirname, '../../data/schema_cache.json');

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
 * 
 * @param client - PostgreSQL client connection to query the information_schema
 * @param useCache - Whether to use cached schema (default: true). Set to false to force refresh.
 * @returns Array of TableSchema objects containing table and column information
 * 
 * @example
 * ```typescript
 * const pool = getInspectedDbPool();
 * const client = await pool.connect();
 * const schema = await getSchema(client);
 * console.log(`Found ${schema.length} tables`);
 * client.release();
 * ```
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
 * Formats database schema into a human-readable text format for LLM consumption.
 * 
 * @param schema - Array of TableSchema objects to format
 * @param tableName - Optional table name to filter results (shows only that table)
 * @returns Formatted string with table and column information
 * 
 * @example
 * ```typescript
 * const formatted = formatSchemaForLLM(schema);
 * // Output:
 * // Table: users
 * // Columns:
 * //   - id: integer NOT NULL
 * //   - name: text NOT NULL
 * //   - email: text NULL
 * ```
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
