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

CRITICAL INSTRUCTIONS FOR BUSINESS SEMANTICS:
1. If the user question contains ANY terms from Business Semantics (e.g., "yesterday", "this month", "revenue"):
   - You MUST use the EXACT "SQL Pattern" provided in that semantic definition
   - DO NOT create your own interpretation of time ranges, metrics, or business logic
   - Copy the SQL Pattern directly and adapt column/table names to match the actual schema
   - If an "AVOID" pattern is shown, you MUST NOT use that approach
   - Example: For "yesterday", use the provided SQL Pattern, not your own date calculation

OPTIMIZATION GUIDELINES (if Table Metadata is provided):
1. Use indexed columns for WHERE clauses when possible - check the Indexes section for each table
2. Join smaller tables first - check estimated_row_count to determine table sizes
3. Use primary keys for efficient lookups - see Primary key section for each table
4. Leverage foreign key relationships for correct JOINs - see Foreign keys section
5. Prefer UNIQUE indexes for equality checks

2. DO NOT use "undefined", placeholders, or table names that are not in the schema.
3. Look at the Database Schema section to find the correct table name and column names.

Generate a single PostgreSQL SELECT query that:
1. Uses ONLY table names from the "Available table names" list (${tableNames.split(', ').slice(0, 5).join(', ')}...)
2. Uses EXACT SQL Patterns from Business Semantics for any matching terms
3. Only uses SELECT or WITH ... SELECT (no INSERT, UPDATE, DELETE, etc.)
4. Is syntactically correct for PostgreSQL
5. Answers the specific step described above
6. Uses appropriate JOINs, WHERE clauses, and aggregations as needed
7. Optimizes query performance using metadata (indexes, table sizes, foreign keys) when available
8. Does NOT include a LIMIT clause (it will be added automatically)

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
