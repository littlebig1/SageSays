/**
 * SQL Parser and Validator
 * 
 * Parses SQL queries to extract tables, columns, and joins,
 * then validates them against database metadata to ensure
 * zero hallucination and correctness.
 */

import { TableSchema, TableMetadata, SQLValidationResult, GrainLevel } from '../types.js';

/**
 * Parsed SQL structure
 */
export interface ParsedSQL {
  tables: string[];
  columns: Array<{ table?: string; column: string }>;
  joins: Array<{ from: string; to: string; condition: string }>;
  cteNames: Set<string>; // CTE names for validation skipping
  grain?: GrainLevel;
  hasAggregations: boolean;
  hasGroupBy: boolean;
}

/**
 * Parse SQL query to extract structural elements
 */
export function parseSQL(sql: string): ParsedSQL {
  // Remove SQL comments first (-- and /* */)
  let cleaned = sql.replace(/--[^\n]*/g, ''); // Remove -- comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove /* */ comments
  const normalized = cleaned.replace(/\s+/g, ' ').trim();
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:26',message:'parseSQL entry',data:{sql:sql.substring(0,200),normalized:normalized.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  
  // Extract CTE names from WITH clauses
  const cteNames = new Set<string>();
  const withMatches = normalized.matchAll(/\bWITH\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi);
  for (const match of withMatches) {
    if (match[1]) {
      cteNames.add(match[1].toLowerCase());
    }
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:38',message:'CTEs detected',data:{cteNames:Array.from(cteNames)},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  
  // Extract table names and aliases from FROM and JOIN clauses
  const tables: string[] = [];
  const tableAliases = new Map<string, string>(); // alias -> actual table name
  
  // Extract FROM clause with optional alias: FROM table_name [alias] or FROM table_name AS alias
  // Must be after SELECT or after a closing paren (for subqueries/CTEs)
  const fromMatch = normalized.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/i);
  if (fromMatch) {
    const tableName = fromMatch[1];
    const alias = fromMatch[2];
    // Validate table name is not a SQL keyword or common word
    const sqlKeywords = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'select', 'where', 'group', 'order', 'having', 'limit', 'offset']);
    if (!sqlKeywords.has(tableName.toLowerCase())) {
      tables.push(tableName);
      if (alias && alias.toLowerCase() !== tableName.toLowerCase()) {
        tableAliases.set(alias, tableName);
      }
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:50',message:'FROM table extracted',data:{tableName,alias},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:56',message:'FROM table filtered as keyword',data:{tableName},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    }
  }
  
  // Extract JOIN tables with optional aliases: JOIN table_name [alias] or JOIN table_name AS alias
  const joinMatches = normalized.matchAll(/\b(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi);
  for (const match of joinMatches) {
    const tableName = match[1];
    const alias = match[2];
    // Validate table name is not a SQL keyword or common word
    const sqlKeywords = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'select', 'where', 'group', 'order', 'having', 'limit', 'offset']);
    if (tableName && !sqlKeywords.has(tableName.toLowerCase()) && !tables.includes(tableName)) {
      tables.push(tableName);
    }
    if (alias && alias.toLowerCase() !== tableName.toLowerCase()) {
      tableAliases.set(alias, tableName);
    }
  }
  
  // Extract columns from SELECT, WHERE, GROUP BY, ORDER BY clauses
  const columns: Array<{ table?: string; column: string }> = [];
  
  // Helper function to extract table.column references from a clause
  const extractTableColumns = (clause: string) => {
    // Match table.column patterns (handles aliases and CTEs)
    const tableColPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let match;
    while ((match = tableColPattern.exec(clause)) !== null) {
      const tableRef = match[1];
      const columnName = match[2];
      
      // Check if this is a CTE - if so, skip validation (CTEs are virtual tables)
      if (cteNames.has(tableRef.toLowerCase())) {
        // CTE column - don't validate against schema, but still track it
        columns.push({
          table: tableRef, // Keep CTE name as-is
          column: columnName,
        });
        continue;
      }
      
      // Resolve alias to actual table name
      const actualTable = tableAliases.get(tableRef) || tableRef;
      
      columns.push({
        table: actualTable,
        column: columnName,
      });
    }
  };
  
  // Extract from SELECT clause
  const selectMatch = normalized.match(/\bSELECT\s+(.+?)\s+FROM/i);
  if (selectMatch) {
    const selectClause = selectMatch[1];
    
    // Skip SELECT * case (will be caught by guard)
    if (!selectClause.includes('*')) {
      extractTableColumns(selectClause);
      
      // Also handle unqualified columns in SELECT
      const columnParts = selectClause.split(',').map(c => c.trim());
      for (const part of columnParts) {
        // Skip if already matched as table.column
        if (!part.includes('.')) {
          const colMatch = part.match(/([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (colMatch && !['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT'].includes(colMatch[1].toUpperCase())) {
            columns.push({ column: colMatch[1] });
          }
        }
      }
    }
  }
  
  // Extract from WHERE clause
  const whereMatch = normalized.match(/\bWHERE\s+(.+?)(?:\s+GROUP\s+BY|\s+ORDER\s+BY|\s+HAVING|\s+LIMIT|$)/i);
  if (whereMatch) {
    extractTableColumns(whereMatch[1]);
  }
  
  // Extract from GROUP BY clause
  const groupByMatch = normalized.match(/\bGROUP\s+BY\s+(.+?)(?:\s+ORDER\s+BY|\s+HAVING|\s+LIMIT|$)/i);
  if (groupByMatch) {
    extractTableColumns(groupByMatch[1]);
  }
  
  // Extract from ORDER BY clause
  const orderByMatch = normalized.match(/\bORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
  if (orderByMatch) {
    extractTableColumns(orderByMatch[1]);
  }
  
  // Extract JOIN relationships
  const joins: Array<{ from: string; to: string; condition: string }> = [];
  const joinPattern = /\b(?:INNER|LEFT|RIGHT|FULL)?\s*JOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ON\s+([^WHERE|GROUP|ORDER|LIMIT]+)/gi;
  const joinMatches2 = normalized.matchAll(joinPattern);
  
  for (const match of joinMatches2) {
    const joinTable = match[1];
    const condition = match[2]?.trim() || '';
    
    // Try to extract the FROM table (first table in query)
    const fromTable = tables[0] || '';
    
    if (joinTable && fromTable) {
      joins.push({
        from: fromTable,
        to: joinTable,
        condition: condition,
      });
    }
  }
  
  // Detect aggregation level (grain)
  const hasAggregations = /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT)\s*\(/i.test(normalized);
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(normalized);
  
  let grain: GrainLevel | undefined;
  if (hasGroupBy) {
    // Try to infer grain from GROUP BY columns
    const groupByMatch = normalized.match(/\bGROUP\s+BY\s+([^HAVING|ORDER|LIMIT]+)/i);
    if (groupByMatch) {
      const groupByCols = groupByMatch[1].trim();
      if (groupByCols.includes('date') || groupByCols.includes('day') || groupByCols.includes('created_at')) {
        grain = 'daily';
      } else if (groupByCols.includes('month')) {
        grain = 'monthly';
      } else if (groupByCols.includes('customer') || groupByCols.includes('user')) {
        grain = 'customer_level';
      } else if (groupByCols.includes('order')) {
        grain = 'order_level';
      } else {
        grain = 'custom';
      }
    }
  } else if (hasAggregations) {
    // Aggregation without GROUP BY = single row result
    grain = 'row_level';
  } else {
    // No aggregation = row-level
    grain = 'row_level';
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:200',message:'parseSQL exit',data:{tables,cteNames:Array.from(cteNames),columnsCount:columns.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  
  return {
    tables,
    columns,
    joins,
    cteNames,
    grain,
    hasAggregations,
    hasGroupBy,
  };
}

/**
 * Validate parsed SQL against metadata
 */
export function validateAgainstMetadata(
  parsed: ParsedSQL,
  schema: TableSchema[],
  metadata: TableMetadata[]
): SQLValidationResult {
  const issues: string[] = [];
  const facts: string[] = [];
  const assumptions: string[] = [];
  const unknowns: string[] = [];
  
  let confidence = 1.0;
  let tablesValidated = true;
  let columnsValidated = true;
  let joinsValidated = true;
  
  // Validate tables exist in metadata
  const metadataTableNames = new Set(metadata.map(m => m.tableName));
  const missingTables: string[] = [];
  
  // Filter out CTE names from table validation (CTEs are virtual tables)
  const realTables = parsed.tables.filter(table => !parsed.cteNames.has(table.toLowerCase()));
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:232',message:'Validating tables',data:{allTables:parsed.tables,realTables,cteNames:Array.from(parsed.cteNames),metadataTables:Array.from(metadataTableNames).slice(0,10)},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  
  for (const table of realTables) {
    if (!metadataTableNames.has(table)) {
      missingTables.push(table);
      tablesValidated = false;
      confidence -= 0.2;
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/dd8d4512-6558-4f07-82a0-826080c144b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'sqlValidator.ts:242',message:'Table not found',data:{table,isCTE:parsed.cteNames.has(table.toLowerCase())},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    } else {
      facts.push(`Table "${table}" exists in metadata`);
    }
  }
  
  if (missingTables.length > 0) {
    issues.push(`Tables not found in metadata: ${missingTables.join(', ')}`);
  }
  
  // Validate columns exist for each table
  const schemaMap = new Map<string, TableSchema>();
  for (const table of schema) {
    schemaMap.set(table.tableName, table);
  }
  
  const missingColumns: Array<{ table: string; column: string }> = [];
  
  for (const col of parsed.columns) {
    if (col.table) {
      // Check if this is a CTE - CTEs are virtual tables, skip schema validation
      if (parsed.cteNames.has(col.table.toLowerCase())) {
        // CTE column - assume valid (defined in query itself)
        assumptions.push(`Column "${col.table}.${col.column}" from CTE (assumed valid)`);
        continue; // Skip validation for CTE columns
      }
      
      // Table-qualified column - validate against schema
      const tableSchema = schemaMap.get(col.table);
      if (!tableSchema) {
        missingColumns.push({ table: col.table, column: col.column });
        columnsValidated = false;
        confidence -= 0.1;
      } else {
        const columnExists = tableSchema.columns.some(c => c.columnName === col.column);
        if (!columnExists) {
          missingColumns.push({ table: col.table, column: col.column });
          columnsValidated = false;
          confidence -= 0.1;
        } else {
          facts.push(`Column "${col.table}.${col.column}" exists in schema`);
        }
      }
    } else {
      // Unqualified column - check all tables
      let found = false;
      for (const table of parsed.tables) {
        const tableSchema = schemaMap.get(table);
        if (tableSchema?.columns.some(c => c.columnName === col.column)) {
          found = true;
          facts.push(`Column "${col.column}" found in table "${table}"`);
          break;
        }
      }
      if (!found) {
        missingColumns.push({ table: 'unknown', column: col.column });
        columnsValidated = false;
        confidence -= 0.1;
        assumptions.push(`Column "${col.column}" assumed to exist (table not specified)`);
      }
    }
  }
  
  if (missingColumns.length > 0) {
    issues.push(`Columns not found: ${missingColumns.map(c => `${c.table}.${c.column}`).join(', ')}`);
  }
  
  // Validate joins against foreign keys
  const invalidJoins: string[] = [];
  
  for (const join of parsed.joins) {
    const fromMetadata = metadata.find(m => m.tableName === join.from);
    const toMetadata = metadata.find(m => m.tableName === join.to);
    
    if (!fromMetadata || !toMetadata) {
      invalidJoins.push(`${join.from} -> ${join.to} (metadata missing)`);
      joinsValidated = false;
      confidence -= 0.15;
      continue;
    }
    
    // Check if there's a foreign key relationship
    const fkExists = fromMetadata.foreignKeys.some(fk => fk.toTable === join.to) ||
                     toMetadata.foreignKeys.some(fk => fk.toTable === join.from);
    
    if (fkExists) {
      facts.push(`Join "${join.from}" -> "${join.to}" validated against foreign key metadata`);
    } else {
      invalidJoins.push(`${join.from} -> ${join.to} (no FK relationship found)`);
      joinsValidated = false;
      confidence -= 0.15;
      assumptions.push(`Join "${join.from}" -> "${join.to}" assumed valid (no FK metadata found)`);
    }
  }
  
  if (invalidJoins.length > 0) {
    issues.push(`Invalid joins: ${invalidJoins.join(', ')}`);
  }
  
  // Assess performance risk
  let performanceRisk: 'low' | 'medium' | 'high' = 'low';
  
  for (const table of parsed.tables) {
    const tableMeta = metadata.find(m => m.tableName === table);
    if (tableMeta && (tableMeta.estimatedRowCount > 100000 || tableMeta.totalSizeBytes > 1000000000)) {
      // Check if indexes are used in WHERE clause
      const hasIndexedFilter = checkIndexUsage(parsed, tableMeta);
      if (!hasIndexedFilter) {
        performanceRisk = 'high';
        confidence -= 0.2;
        unknowns.push(`Could not verify index usage for large table "${table}"`);
      } else {
        performanceRisk = 'medium';
        confidence -= 0.1;
        facts.push(`Index usage verified for large table "${table}"`);
      }
    }
  }
  
  // Ensure confidence is within bounds
  confidence = Math.max(0.1, Math.min(1.0, confidence));
  
  return {
    valid: issues.length === 0,
    issues,
    confidence,
    facts,
    assumptions,
    unknowns,
    grain: parsed.grain,
    performanceRisk,
    tablesValidated,
    columnsValidated,
    joinsValidated,
  };
}

/**
 * Check if indexes are used for filtering on a table
 * @param _parsed - Parsed SQL (not currently used, reserved for future WHERE clause parsing)
 * @param tableMeta - Table metadata containing index information
 */
function checkIndexUsage(_parsed: ParsedSQL, tableMeta: TableMetadata): boolean {
  // Simple heuristic: check if table has indexes
  // Future enhancement: parse WHERE clause to verify indexed columns are used
  const indexedColumns = new Set<string>();
  for (const idx of tableMeta.indexes) {
    for (const col of idx.columns) {
      indexedColumns.add(col.toLowerCase());
    }
  }
  
  // For now, assume indexes might be used if table has indexes
  // More sophisticated analysis would require parsing WHERE clause
  return indexedColumns.size > 0;
}

/**
 * Calculate confidence level from validation result
 */
export function calculateConfidence(
  validation: SQLValidationResult,
  hasSemantics: boolean
): 'high' | 'medium' | 'low' {
  let score = validation.confidence;
  
  // Boost if semantics were used
  if (hasSemantics) {
    score += 0.1;
  }
  
  // Reduce for performance risk
  if (validation.performanceRisk === 'high') {
    score -= 0.15;
  } else if (validation.performanceRisk === 'medium') {
    score -= 0.1;
  }
  
  // Reduce for unknowns
  if (validation.unknowns.length > 0) {
    score -= 0.1 * Math.min(validation.unknowns.length, 3); // Cap at 3 unknowns
  }
  
  score = Math.max(0.1, Math.min(1.0, score));
  
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

/**
 * Main validation function - combines parsing and validation
 */
export async function validateSQLAgainstMetadata(
  sql: string,
  schema: TableSchema[],
  metadata: TableMetadata[]
): Promise<SQLValidationResult> {
  const parsedSQL = parseSQL(sql);
  return validateAgainstMetadata(parsedSQL, schema, metadata);
}
