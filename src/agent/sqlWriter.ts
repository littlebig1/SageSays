import { GoogleGenerativeAI } from '@google/generative-ai';
import { PlanStep, TableSchema, ConversationTurn } from '../types.js';
import { config } from '../config.js';
import { formatSchemaForLLM } from '../tools/inspectedDb.js';
import { formatSemanticsForLLM, getSemantics, formatMetadataForLLM } from '../tools/controlDb.js';
import { retryWithBackoff } from '../utils/retry.js';

export class SQLWriter {
  private genAI: GoogleGenerativeAI;
  private model: any;
  
  constructor() {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: config.geminiModel });
  }
  
  async generateSQL(
    step: PlanStep,
    question: string,
    schema: TableSchema[],
    previousResults?: Array<{ step: number; result: any }>,
    conversationHistory?: ConversationTurn[]
  ): Promise<string> {
    // Validate schema is not empty
    if (!schema || schema.length === 0) {
      throw new Error('Schema is empty - cannot generate SQL without table information');
    }
    
    const schemaText = formatSchemaForLLM(schema);
    const semantics = await getSemantics();
    const semanticsText = await formatSemanticsForLLM(semantics);
    const metadataText = formatMetadataForLLM(schema);
    
    // Extract table names for explicit reference
    const tableNames = schema.map(t => t.tableName).join(', ');
    
    const previousContext = previousResults && previousResults.length > 0
      ? `\nPrevious query results:\n${previousResults.map(pr => `Step ${pr.step}: ${JSON.stringify(pr.result.rows.slice(0, 5), null, 2)} (showing first 5 rows of ${pr.result.rowCount} total)`).join('\n\n')}\n`
      : '';
    
    // Build conversation history context
    const conversationContext = conversationHistory && conversationHistory.length > 0
      ? `\nRecent Conversation History (for context awareness):\n${conversationHistory.map((turn, i) => {
          const turnNum = conversationHistory.length - i; // Most recent is last
          return `Turn ${turnNum}:\n  Q: ${turn.question}\n  SQL: ${turn.sqlQueries[0] || 'N/A'}\n  Table: ${turn.resultTable || 'unknown'}\n  Columns: ${turn.resultColumns?.join(', ') || 'unknown'}\n`;
        }).join('\n')}\n`
      : '';
    
    const prompt = `You are a SQL query generation assistant. Generate a PostgreSQL SELECT query to answer the user's question.

Database Schema:
${schemaText}

${metadataText ? `Table Metadata (for query optimization):
${metadataText}` : ''}

Available table names: ${tableNames}

${semanticsText}

${conversationContext}${previousContext}User Question: ${question}

CONTEXT AWARENESS RULES:
${conversationHistory && conversationHistory.length > 0
  ? `- If the question uses pronouns ("them", "it", "those") or references ("also", "and", "by country", "group by"), 
    it likely refers to the PREVIOUS query shown in "Recent Conversation History" above
- Use the previous query's table and columns as the base for follow-up operations
- If asking to "group by X", modify the previous query to add "GROUP BY X"
- If asking to "display by X" or "show by X", add "GROUP BY X" and appropriate aggregations
- Maintain the same WHERE clauses and filters from the previous query unless explicitly changed`
  : ''}

Current Step: ${step.description}
Reasoning: ${step.reasoning}

METADATA AS SOURCE OF TRUTH:
1. ONLY use table names from metadata: ${tableNames}
2. ONLY use column names that exist in the schema above
3. If it's not in the metadata, it does not exist - DO NOT invent names
4. Database metadata tables are the sole source of truth

VALIDATION REQUIREMENTS:
1. Validate all tables against metadata before generating SQL - check that every table name appears in the "Available table names" list
2. Validate all columns exist for each table - verify each column name in the Database Schema section
3. Validate all JOINs against foreign_keys metadata - use the Foreign keys section to ensure correct relationships
4. Push WHERE filters before JOINs for performance - filter large tables early
5. Use indexed columns for filtering when available - check the Indexes section for each table

GRAIN MANAGEMENT:
1. State the aggregation level explicitly in comments (e.g., -- Grain: customer_level)
2. Ensure JOINs don't change the intended grain unintentionally
3. Prefer canonical/pre-aggregated tables if grain matches - check metadata for summary tables (e.g., daily_summary, monthly_aggregates)
4. If joining fact tables, ensure the grain is maintained or explicitly changed

ZERO HALLUCINATION:
1. NEVER use SELECT * - always list columns explicitly
2. NEVER invent table or column names - if it's not in the schema, it doesn't exist
3. NEVER create joins without FK validation - only join tables that have foreign key relationships in metadata
4. NEVER use placeholders or "undefined" - always use actual table/column names from schema

PERFORMANCE OPTIMIZATION:
1. Assume large tables (check estimated_row_count) are expensive - tables with >100k rows need careful handling
2. Push filters early (before JOINs) - apply WHERE clauses to large tables first
3. Use indexed columns (check indexes JSONB) for WHERE clauses - prefer indexed columns for filtering
4. Join smaller tables first (check total_size_bytes) - order JOINs by table size (smallest first)

CRITICAL INSTRUCTIONS FOR BUSINESS SEMANTICS:
1. If the user question contains ANY terms from Business Semantics (e.g., "yesterday", "this month", "revenue"):
   - You MUST use the EXACT "SQL Pattern" provided in that semantic definition
   - DO NOT create your own interpretation of time ranges, metrics, or business logic
   - Copy the SQL Pattern directly and adapt column/table names to match the actual schema
   - If an "AVOID" pattern is shown, you MUST NOT use that approach
   - Example: For "yesterday", use the provided SQL Pattern, not your own date calculation

FACTS vs ASSUMPTIONS vs UNKNOWNS:
- Facts: Verified against metadata (table exists, column exists, FK valid) - state these explicitly
- Assumptions: Explicit assumptions made (e.g., "assuming user_id is unique") - note these in comments
- Unknowns: Things that couldn't be validated (e.g., "could not verify index usage") - flag these if critical

Generate a single PostgreSQL SELECT query that:
1. Uses ONLY table names from the "Available table names" list (${tableNames.split(', ').slice(0, 5).join(', ')}...)
2. Uses EXACT SQL Patterns from Business Semantics for any matching terms
3. Only uses SELECT or WITH ... SELECT (no INSERT, UPDATE, DELETE, etc.)
4. Is syntactically correct for PostgreSQL
5. Answers the specific step described above
6. Uses appropriate JOINs, WHERE clauses, and aggregations as needed
7. Optimizes query performance using metadata (indexes, table sizes, foreign keys) when available
8. Does NOT include a LIMIT clause (it will be added automatically)
9. Lists all columns explicitly (NEVER use SELECT *)
10. Validates all elements against metadata before generating

Respond with ONLY the SQL query, nothing else. No explanations, no markdown formatting, just the raw SQL.`;

    try {
      // Wrap the LLM call with retry logic for handling API overload
      const result = await retryWithBackoff(async () => {
        return await this.model.generateContent(prompt);
      });
      
      const response = result.response;
      let sql = response.text().trim();
      
      // Clean up the SQL (remove markdown code blocks if present)
      if (sql.startsWith('```')) {
        sql = sql.replace(/^```(?:sql)?\n?/, '').replace(/\n?```$/, '');
      }
      
      // Remove trailing semicolon if present (we'll add it in guard)
      sql = sql.replace(/;+\s*$/, '').trim();
      
      return sql;
    } catch (error: any) {
      console.error('SQL generation error:', error);
      
      // User-friendly error message for API overload
      if (error?.status === 503 || error?.status === 429) {
        throw new Error(
          `Google Gemini API is currently overloaded. Please try again in a few minutes.\n\n` +
          `Suggestions:\n` +
          `  1. Wait 2-3 minutes and retry your question\n` +
          `  2. Switch to GEMINI_MODEL=gemini-2.5-pro in .env (less traffic)\n` +
          `  3. Enable billing for higher rate limits: https://console.cloud.google.com/billing`
        );
      }
      
      throw new Error(`Failed to generate SQL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
