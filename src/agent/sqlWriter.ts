import { GoogleGenerativeAI } from '@google/generative-ai';
import { PlanStep, TableSchema } from '../types.js';
import { config } from '../config.js';
import { formatSchemaForLLM } from '../tools/schema.js';
import { formatSemanticsForLLM } from '../tools/semantics.js';
import { getSemantics } from '../tools/semantics.js';
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
    previousResults?: Array<{ step: number; result: any }>
  ): Promise<string> {
    // Validate schema is not empty
    if (!schema || schema.length === 0) {
      throw new Error('Schema is empty - cannot generate SQL without table information');
    }
    
    const schemaText = formatSchemaForLLM(schema);
    const semantics = await getSemantics();
    const semanticsText = formatSemanticsForLLM(semantics);
    
    // Extract table names for explicit reference
    const tableNames = schema.map(t => t.tableName).join(', ');
    
    const previousContext = previousResults && previousResults.length > 0
      ? `\nPrevious query results:\n${previousResults.map(pr => `Step ${pr.step}: ${JSON.stringify(pr.result.rows.slice(0, 5), null, 2)} (showing first 5 rows of ${pr.result.rowCount} total)`).join('\n\n')}\n`
      : '';
    
    const prompt = `You are a SQL query generation assistant. Generate a PostgreSQL SELECT query to answer the user's question.

Database Schema:
${schemaText}

Available table names: ${tableNames}

${semanticsText}

${previousContext}User Question: ${question}

Current Step: ${step.description}
Reasoning: ${step.reasoning}

2. If the user question contains terms from Business Semantics (e.g., "yesterday", "this month"), you MUST use those semantic definitions to generate the correct date/time filters.
3. DO NOT use "undefined", placeholders, or table names that are not in the schema.
4. Look at the Database Schema section to find the correct table name and column names.

Generate a single PostgreSQL SELECT query that:
1. Uses ONLY table names from the "Available table names" list (${tableNames.split(', ').slice(0, 5).join(', ')}...)
2. Applies semantic definitions for any terms mentioned in Business Semantics above
3. Only uses SELECT or WITH ... SELECT (no INSERT, UPDATE, DELETE, etc.)
3. Is syntactically correct for PostgreSQL
4. Answers the specific step described above
5. Uses appropriate JOINs, WHERE clauses, and aggregations as needed
6. Does NOT include a LIMIT clause (it will be added automatically)

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
