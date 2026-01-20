/**
 * Metadata Validation Service
 * 
 * Business logic layer for validating SQL elements against
 * stored database metadata. Cross-references tables, columns,
 * joins, and indexes to ensure correctness.
 */

import { TableSchema, TableMetadata, GrainLevel } from '../types.js';

/**
 * Validation result for table existence check
 */
export interface TableValidationResult {
  valid: boolean;
  missing: string[];
  found: string[];
}

/**
 * Validation result for column existence check
 */
export interface ColumnValidationResult {
  valid: boolean;
  missing: Array<{ table: string; column: string }>;
  found: Array<{ table: string; column: string }>;
}

/**
 * Validation result for join validation
 */
export interface JoinValidationResult {
  valid: boolean;
  invalidJoins: string[];
  validJoins: Array<{ from: string; to: string; reason: string }>;
}

/**
 * Validate that all tables exist in metadata
 */
export function validateTablesExist(
  tables: string[],
  metadata: TableMetadata[]
): TableValidationResult {
  const metadataTableNames = new Set(metadata.map(m => m.tableName));
  const missing: string[] = [];
  const found: string[] = [];
  
  for (const table of tables) {
    if (metadataTableNames.has(table)) {
      found.push(table);
    } else {
      missing.push(table);
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
    found,
  };
}

/**
 * Validate that all columns exist for their respective tables
 */
export function validateColumnsExist(
  columns: Array<{ table: string; column: string }>,
  schema: TableSchema[]
): ColumnValidationResult {
  const schemaMap = new Map<string, TableSchema>();
  for (const table of schema) {
    schemaMap.set(table.tableName, table);
  }
  
  const missing: Array<{ table: string; column: string }> = [];
  const found: Array<{ table: string; column: string }> = [];
  
  for (const col of columns) {
    const tableSchema = schemaMap.get(col.table);
    if (!tableSchema) {
      missing.push({ table: col.table, column: col.column });
    } else {
      const columnExists = tableSchema.columns.some(c => c.columnName === col.column);
      if (columnExists) {
        found.push({ table: col.table, column: col.column });
      } else {
        missing.push({ table: col.table, column: col.column });
      }
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
    found,
  };
}

/**
 * Join information for validation
 */
export interface JoinInfo {
  from: string;
  to: string;
  condition?: string;
}

/**
 * Validate joins against foreign key relationships
 */
export function validateJoins(
  joins: JoinInfo[],
  metadata: TableMetadata[]
): JoinValidationResult {
  const invalidJoins: string[] = [];
  const validJoins: Array<{ from: string; to: string; reason: string }> = [];
  
  const metadataMap = new Map<string, TableMetadata>();
  for (const meta of metadata) {
    metadataMap.set(meta.tableName, meta);
  }
  
  for (const join of joins) {
    const fromMetadata = metadataMap.get(join.from);
    const toMetadata = metadataMap.get(join.to);
    
    if (!fromMetadata || !toMetadata) {
      invalidJoins.push(`${join.from} -> ${join.to} (metadata missing)`);
      continue;
    }
    
    // Check if there's a foreign key relationship
    const fkFromTo = fromMetadata.foreignKeys.find(fk => fk.toTable === join.to);
    const fkToFrom = toMetadata.foreignKeys.find(fk => fk.toTable === join.from);
    
    if (fkFromTo) {
      validJoins.push({
        from: join.from,
        to: join.to,
        reason: `FK: ${fkFromTo.fromColumn} -> ${fkFromTo.toTable}.${fkFromTo.toColumn}`,
      });
    } else if (fkToFrom) {
      validJoins.push({
        from: join.from,
        to: join.to,
        reason: `FK: ${fkToFrom.fromColumn} -> ${fkToFrom.toTable}.${fkToFrom.toColumn}`,
      });
    } else {
      invalidJoins.push(`${join.from} -> ${join.to} (no FK relationship found)`);
    }
  }
  
  return {
    valid: invalidJoins.length === 0,
    invalidJoins,
    validJoins,
  };
}

/**
 * Find canonical/pre-aggregated tables that match a given grain
 */
export function findCanonicalTables(
  metadata: TableMetadata[],
  grain: GrainLevel
): TableMetadata[] {
  // Look for tables with names suggesting aggregation
  const canonicalPatterns: Record<GrainLevel, string[]> = {
    'daily': ['daily', 'day', 'dailies'],
    'monthly': ['monthly', 'month', 'monthlies'],
    'customer_level': ['customer', 'user', 'account'],
    'order_level': ['order', 'transaction'],
    'row_level': [],
    'custom': [],
  };
  
  const patterns = canonicalPatterns[grain] || [];
  const matching: TableMetadata[] = [];
  
  for (const meta of metadata) {
    const tableNameLower = meta.tableName.toLowerCase();
    for (const pattern of patterns) {
      if (tableNameLower.includes(pattern)) {
        matching.push(meta);
        break;
      }
    }
  }
  
  return matching;
}

/**
 * Assess performance risk of a SQL query
 */
export function assessPerformanceRisk(
  sql: string,
  metadata: TableMetadata[],
  tablesUsed: string[]
): 'low' | 'medium' | 'high' {
  let risk: 'low' | 'medium' | 'high' = 'low';
  
  // Check table sizes
  const largeTables = metadata.filter(m => 
    tablesUsed.includes(m.tableName) && 
    (m.estimatedRowCount > 100000 || m.totalSizeBytes > 1000000000)
  );
  
  if (largeTables.length === 0) {
    return 'low';
  }
  
  // Check if WHERE clause exists (filters reduce risk)
  const hasWhere = /\bWHERE\b/i.test(sql);
  
  // Check if indexes might be used (simple heuristic)
  const hasIndexedColumns = checkIndexedColumnUsage(sql, largeTables);
  
  if (largeTables.length > 2) {
    risk = 'high';
  } else if (largeTables.length === 1 && !hasWhere) {
    risk = 'high';
  } else if (largeTables.length === 1 && hasWhere && !hasIndexedColumns) {
    risk = 'medium';
  } else if (largeTables.length === 1 && hasWhere && hasIndexedColumns) {
    risk = 'low';
  } else {
    risk = 'medium';
  }
  
  return risk;
}

/**
 * Check if SQL uses indexed columns (simple heuristic)
 */
function checkIndexedColumnUsage(sql: string, tables: TableMetadata[]): boolean {
  const sqlLower = sql.toLowerCase();
  
  for (const table of tables) {
    // Check if any indexed columns appear in WHERE clause
    for (const index of table.indexes) {
      for (const col of index.columns) {
        // Simple check: column name appears in WHERE clause
        const colPattern = new RegExp(`\\b${col}\\b`, 'i');
        if (colPattern.test(sqlLower)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Check if a column is indexed
 */
export function isColumnIndexed(
  tableName: string,
  columnName: string,
  metadata: TableMetadata[]
): boolean {
  const tableMeta = metadata.find(m => m.tableName === tableName);
  if (!tableMeta) return false;
  
  for (const index of tableMeta.indexes) {
    if (index.columns.includes(columnName)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get recommended join order based on table sizes
 */
export function getRecommendedJoinOrder(
  tables: string[],
  metadata: TableMetadata[]
): string[] {
  const tableSizes = tables.map(table => {
    const meta = metadata.find(m => m.tableName === table);
    return {
      table,
      size: meta ? meta.estimatedRowCount : 0,
    };
  });
  
  // Sort by size (smallest first)
  tableSizes.sort((a, b) => a.size - b.size);
  
  return tableSizes.map(t => t.table);
}
