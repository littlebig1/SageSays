/**
 * Result of SQL validation, including sanitized query if valid.
 */
export interface ValidationResult {
  /** Whether the SQL passed all safety checks */
  valid: boolean;
  /** Reason for validation failure (only present if valid is false) */
  reason?: string;
  /** Sanitized SQL with auto-added LIMIT and semicolon (only present if valid is true) */
  sanitizedSQL?: string;
}

/**
 * Validates SQL queries for safety before execution.
 * 
 * Safety checks performed:
 * - Only allows SELECT or WITH ... SELECT statements
 * - Rejects dangerous keywords (DROP, DELETE, INSERT, UPDATE, etc.)
 * - Blocks SELECT * queries (zero hallucination rule - must list columns explicitly)
 * - Blocks queries with "undefined" table names (common LLM error)
 * - Prevents multiple statement execution
 * - Auto-appends LIMIT 200 if not present
 * - Ensures query ends with semicolon
 * 
 * @param sql - The SQL query string to validate
 * @returns ValidationResult with valid flag, optional reason for failure, and sanitized SQL
 * 
 * @example
 * ```typescript
 * const result = validateSQL('SELECT * FROM users');
 * if (result.valid) {
 *   console.log(result.sanitizedSQL); // "SELECT * FROM users LIMIT 200;"
 * } else {
 *   console.error(result.reason);
 * }
 * ```
 */
export function validateSQL(sql: string): ValidationResult {
  const trimmed = sql.trim();
  
  if (!trimmed) {
    return { valid: false, reason: 'Empty SQL statement' };
  }
  
  // Check for dangerous keywords
  const dangerousKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 
    'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL'
  ];
  
  for (const keyword of dangerousKeywords) {
    // Use word boundaries to avoid false positives
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(trimmed)) {
      return { valid: false, reason: `Dangerous keyword detected: ${keyword}` };
    }
  }
  
  // Only allow SELECT or WITH ... SELECT
  const hasSelect = /\bSELECT\b/i.test(trimmed);
  const hasWith = /\bWITH\b/i.test(trimmed);
  
  if (!hasSelect && !hasWith) {
    return { valid: false, reason: 'Only SELECT or WITH ... SELECT statements are allowed' };
  }
  
  // Check for SELECT * (zero hallucination rule)
  if (/\bSELECT\s+\*\b/i.test(trimmed)) {
    return { 
      valid: false, 
      reason: 'SELECT * is not allowed. Always list columns explicitly. This ensures zero hallucination and validates against metadata.' 
    };
  }
  
  // Check for undefined table names (common LLM error)
  if (/\bFROM\s+["']?undefined["']?/i.test(trimmed) || /\bJOIN\s+["']?undefined["']?/i.test(trimmed)) {
    return { valid: false, reason: 'SQL contains "undefined" as table name - this indicates the LLM did not properly identify the table. Please check the schema and try again.' };
  }
  
  // Check for multiple statements (semicolon followed by non-comment content)
  const statements = trimmed.split(';').filter(s => s.trim().length > 0);
  if (statements.length > 1) {
    return { valid: false, reason: 'Multiple statements are not allowed' };
  }
  
  // Auto-append LIMIT if not present
  let sanitized = trimmed;
  if (!/\bLIMIT\s+\d+/i.test(sanitized)) {
    // Check if it's a CTE (WITH clause) - LIMIT should go after the final SELECT
    if (hasWith) {
      // Find the last SELECT in the query
      const lastSelectIndex = sanitized.lastIndexOf('SELECT');
      if (lastSelectIndex !== -1) {
        const afterSelect = sanitized.substring(lastSelectIndex);
        
        // Check if there's already an ORDER BY, then LIMIT goes after it
        if (/\bORDER\s+BY\b/i.test(afterSelect)) {
          sanitized = sanitized.replace(/\bORDER\s+BY\s+[^;]+/i, (match) => {
            return match + ' LIMIT 200';
          });
        } else {
          // No ORDER BY, add LIMIT at the end before semicolon
          sanitized = sanitized.replace(/;?\s*$/, ' LIMIT 200;');
        }
      }
    } else {
      // Simple SELECT, add LIMIT before semicolon or at end
      if (/\bORDER\s+BY\b/i.test(sanitized)) {
        sanitized = sanitized.replace(/\bORDER\s+BY\s+[^;]+/i, (match) => {
          return match + ' LIMIT 200';
        });
      } else {
        sanitized = sanitized.replace(/;?\s*$/, ' LIMIT 200;');
      }
    }
  }
  
  // Ensure it ends with semicolon
  if (!sanitized.trim().endsWith(';')) {
    sanitized = sanitized.trim() + ';';
  }
  
  return { valid: true, sanitizedSQL: sanitized };
}
