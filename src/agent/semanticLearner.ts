import { GoogleGenerativeAI } from '@google/generative-ai';
import { CorrectionCapture, SemanticSuggestion, TableSchema, SQLResult, Discovery } from '../types.js';
import { config } from '../config.js';
import { formatSchemaForLLM } from '../tools/inspectedDb.js';
import { retryWithBackoff } from '../utils/retry.js';

/**
 * SemanticLearner analyzes user corrections and extracts reusable semantic patterns.
 * This is the core of Phase 3: Learning from User Corrections.
 */
export class SemanticLearner {
  private genAI: GoogleGenerativeAI;
  private model: any;
  
  constructor() {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: config.geminiModel });
  }
  
  /**
   * Analyze a correction and generate a semantic suggestion.
   * Uses LLM to extract patterns, SQL fragments, and metadata.
   * 
   * @param runLog - Original run log with query details
   * @param correction - User's correction feedback
   * @param schema - Database schema for context
   * @returns SemanticSuggestion or null if analysis fails
   */
  async analyzeCorrection(
    _runLog: any, // Prefixed with _ to indicate intentionally unused
    correction: CorrectionCapture,
    schema: TableSchema[]
  ): Promise<Omit<SemanticSuggestion, 'id' | 'created_at'> | null> {
    
    const schemaText = formatSchemaForLLM(schema);
    
    const prompt = `You are a semantic learning system. Analyze this user correction and extract reusable semantic knowledge.

CONTEXT:
Database Schema:
${schemaText}

Original Question: ${correction.original_question}
Generated SQL: ${correction.original_sql}
User Correction: ${correction.user_feedback}
Correction Type: ${correction.correction_type}

TASK:
Extract the semantic knowledge that was missing. What rule should the system learn for future queries?

Consider:
1. What concept/term needs definition? (name)
2. What type is it? Choose ONE:
   - TIME_PERIOD: Date/time ranges (yesterday, last month, etc.)
   - METRIC: Measurable values (revenue, count, average, etc.)
   - DIMENSION: Categorical attributes (customer type, region, status, etc.)
   - BUSINESS_RULE: Complex calculation rules or logic
   - FIELD_DEFINITION: Database field meaning/usage explanation
3. What category? (Time Periods, Financial Metrics, User Dimensions, etc.)
4. What's the correct SQL pattern/fragment?
5. What are common synonyms or related terms?
6. What mistakes should be avoided (anti_patterns)?
7. How confident are you? (0.0 to 1.0)
   - 0.90-1.00: Very strong evidence (explicit correction with SQL example)
   - 0.70-0.89: Good evidence (clear correction)
   - 0.50-0.69: Moderate evidence (inferred pattern)
   - 0.30-0.49: Weak evidence (tentative)

IMPORTANT GUIDELINES:
- For TIME_PERIOD: Focus on date range logic, intervals, and time calculations
- For METRIC: Include aggregation function (SUM, AVG, COUNT, etc.)
- For DIMENSION: Identify the categorical attribute and table/column
- For BUSINESS_RULE: Capture complex logic, anti-patterns, and correct approaches
- For FIELD_DEFINITION: Explain field meaning and common mistakes

OUTPUT (JSON only, no markdown, no code blocks):
{
  "suggested_name": "yesterday",
  "suggested_type": "TIME_PERIOD",
  "category": "Time Periods",
  "description": "The full calendar day before today (00:00:00 to 23:59:59). Use date range for accurate 24-hour period coverage.",
  "sql_fragment": "created_date >= CURRENT_DATE - INTERVAL '1 day' AND created_date < CURRENT_DATE",
  "primary_table": "orders",
  "primary_column": "created_date",
  "synonyms": ["past day", "the day before", "previous day"],
  "aggregation": null,
  "anti_patterns": {
    "wrong": "created_date = CURRENT_DATE - 1",
    "why": "Date equality doesn't capture full 24-hour period",
    "correct": "Use INTERVAL-based date range"
  },
  "example_questions": ["How many orders yesterday?", "Show sales from yesterday"],
  "notes": ["Works with DATE and TIMESTAMP columns", "Ensures full 24-hour period"],
  "confidence": 0.90,
  "reasoning": "User provided explicit SQL correction with clear date range pattern"
}

Generate suggestion now:`;

    try {
      const result: any = await retryWithBackoff(
        () => this.model.generateContent(prompt),
        config.retry
      );
      
      const text = result.response.text();
      
      // Extract JSON from response (LLM might wrap it in markdown)
      let jsonText = text.trim();
      
      // Remove markdown code blocks if present
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      }
      
      // Find JSON object
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        console.error('❌ Failed to extract JSON from LLM response');
        console.error('LLM Response:', text.substring(0, 500));
        return null;
      }
      
      const extracted = JSON.parse(jsonMatch[0]);
      
      // Build full suggestion with proper structure
      const suggestion: Omit<SemanticSuggestion, 'id' | 'created_at'> = {
        suggested_name: extracted.suggested_name,
        suggested_type: extracted.suggested_type,
        suggested_definition: {
          entityType: extracted.suggested_type,
          name: extracted.suggested_name,
          description: extracted.description,
          tableName: extracted.primary_table,
          columnName: extracted.primary_column,
          sqlPattern: extracted.sql_fragment,
          metadata: {
            category: extracted.category,
            synonyms: extracted.synonyms || [],
            aggregation: extracted.aggregation,
            anti_patterns: extracted.anti_patterns,
            example_questions: extracted.example_questions || [],
            notes: extracted.notes || [],
            source: 'learned',
            approved: false
          }
        } as any,
        learned_from: 'user_correction', // Must match CHECK constraint: 'user_correction' | 'pattern_analysis' | 'frequency_analysis' | 'explicit_teaching'
        source_run_log_id: correction.run_log_id,
        learning_dialogue: {
          original_question: correction.original_question,
          generated_sql: correction.original_sql,
          user_correction: correction.user_feedback,
          correction_type: correction.correction_type,
          context: `User correction on query: "${correction.original_question}"` // Detailed context moved here
        },
        confidence: extracted.confidence || 0.70,
        evidence: {
          correction_count: 1,
          user_was_explicit: true,
          provided_example: correction.corrected_sql ? true : false,
          reasoning: extracted.reasoning || 'User provided direct correction'
        },
        status: 'pending',
        requires_expert_review: (extracted.confidence || 0.70) < 0.70
      };
      
      return suggestion;
      
    } catch (error) {
      console.error('❌ Error analyzing correction:', error);
      return null;
    }
  }
  
  /**
   * Analyze the difference between original and edited SQL to learn semantics.
   * This is more precise than text feedback since we have the actual correct SQL pattern.
   * Phase 3.3: Learn from manual SQL edits
   * 
   * @param originalQuestion - User's original question
   * @param originalSql - SQL that was generated (incorrect)
   * @param editedSql - SQL that user edited (correct)
   * @param schema - Database schema for context
   * @returns SemanticSuggestion or null if analysis fails
   */
  async analyzeSqlDiff(
    originalQuestion: string,
    originalSql: string,
    editedSql: string,
    schema: TableSchema[]
  ): Promise<Omit<SemanticSuggestion, 'id' | 'created_at'> | null> {
    
    const schemaText = formatSchemaForLLM(schema);
    
    const prompt = `You are a semantic learning system. Analyze the difference between the original (incorrect) SQL and the user's edited (correct) SQL to extract reusable semantic knowledge.

CONTEXT:
Database Schema:
${schemaText}

Original Question: ${originalQuestion}

INCORRECT SQL (generated):
${originalSql}

CORRECT SQL (user edited):
${editedSql}

TASK:
Compare the two SQL queries and identify:
1. What semantic knowledge was missing that caused the incorrect SQL?
2. What pattern/rule should be learned for future queries?
3. What specific change did the user make (added WHERE clause, changed JOIN, etc.)?

Focus on extracting the SEMANTIC concept that was missing, not just the SQL syntax difference.

Examples of what to learn:
- If user added "WHERE status != 'deleted'", learn: "active users = users excluding deleted"
- If user changed "DATE = X" to "DATE >= X AND DATE < Y", learn: time period definitions
- If user added a JOIN, learn: relationship between entities
- If user changed aggregation, learn: metric calculation rules

Choose the correct type:
- TIME_PERIOD: Date/time ranges (yesterday, last month, etc.)
- METRIC: Measurable values (revenue, count, average, etc.)
- DIMENSION: Categorical attributes (customer type, region, status, etc.)
- BUSINESS_RULE: Complex calculation rules or logic
- FIELD_DEFINITION: Database field meaning/usage explanation

OUTPUT (JSON only, no markdown):
{
  "suggested_name": "active users",
  "suggested_type": "BUSINESS_RULE",
  "category": "User Filters",
  "description": "Users that are not deleted. Active users should always exclude records where status is 'deleted' or 'inactive'.",
  "sql_fragment": "status NOT IN ('deleted', 'inactive')",
  "primary_table": "users",
  "primary_column": "status",
  "synonyms": ["non-deleted users", "valid users"],
  "aggregation": null,
  "anti_patterns": {
    "wrong": "SELECT * FROM users",
    "why": "Doesn't filter out deleted users",
    "correct": "SELECT * FROM users WHERE status NOT IN ('deleted', 'inactive')"
  },
  "example_questions": ["How many active users?", "Show me valid users"],
  "notes": ["Always check status column", "Multiple inactive statuses exist"],
  "confidence": 0.95,
  "reasoning": "User explicitly added WHERE clause to exclude deleted users. The intent is clear from the SQL diff."
}

Generate suggestion:`;

    try {
      const result: any = await retryWithBackoff(
        () => this.model.generateContent(prompt),
        config.retry
      );
      
      const text = result.response.text();
      
      // Extract JSON from response
      let jsonText = text.trim();
      
      // Remove markdown code blocks if present
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      }
      
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        console.error('❌ Failed to extract JSON from LLM response');
        console.error('LLM Response:', text.substring(0, 500));
        return null;
      }
      
      const extracted = JSON.parse(jsonMatch[0]);
      
      // Build suggestion (similar to analyzeCorrection)
      const suggestion: Omit<SemanticSuggestion, 'id' | 'created_at'> = {
        suggested_name: extracted.suggested_name,
        suggested_type: extracted.suggested_type,
        suggested_definition: {
          entityType: extracted.suggested_type,
          name: extracted.suggested_name,
          description: extracted.description,
          tableName: extracted.primary_table,
          columnName: extracted.primary_column,
          sqlPattern: extracted.sql_fragment,
          metadata: {
            category: extracted.category,
            synonyms: extracted.synonyms || [],
            aggregation: extracted.aggregation,
            anti_patterns: extracted.anti_patterns,
            example_questions: extracted.example_questions || [],
            notes: extracted.notes || [],
            source: 'learned',
            approved: false
          }
        } as any,
        learned_from: 'user_correction', // SQL edit is a type of user correction
        learning_dialogue: {
          original_question: originalQuestion,
          generated_sql: originalSql,
          user_correction: `User edited SQL to: ${editedSql}`,
          correction_type: 'sql_edit',
          sql_diff: {
            original: originalSql,
            edited: editedSql
          },
          context: `User manually edited SQL for query: "${originalQuestion}"`
        },
        confidence: extracted.confidence || 0.85,
        evidence: {
          correction_count: 1,
          user_was_explicit: true,
          provided_example: true,
          sql_edit: true,
          reasoning: extracted.reasoning || 'User provided explicit SQL correction'
        },
        status: 'pending',
        requires_expert_review: (extracted.confidence || 0.85) < 0.70
      };
      
      return suggestion;
      
    } catch (error) {
      console.error('❌ Error analyzing SQL diff:', error);
      return null;
    }
  }
  
  /**
   * Analyze data patterns from exploration queries to discover semantic rules.
   * Used in DISCOVERY mode for schema exploration.
   * 
   * @param data - SQL query result containing sample data
   * @param schema - Database schema for context
   * @param tableName - Table being explored
   * @param columnName - Optional column being explored
   * @returns Discovery object with detected patterns and suggested semantics
   */
  async analyzePattern(
    data: SQLResult,
    schema: TableSchema[],
    tableName: string,
    columnName?: string
  ): Promise<Discovery> {
    const schemaText = formatSchemaForLLM(schema);
    const tableSchema = schema.find(t => t.tableName === tableName);
    const columnSchema = columnName ? tableSchema?.columns.find(c => c.columnName === columnName) : undefined;
    
    // Limit data sent to LLM
    const sampleRows = data.rows.slice(0, 20);
    const sampleData = sampleRows.map((row) => {
      const rowObj: Record<string, any> = {};
      data.columns.forEach((col, colIdx) => {
        rowObj[col] = row[colIdx];
      });
      return rowObj;
    });
    
    const prompt = `You are a semantic discovery system. Analyze the sample data from a database table to identify patterns and infer semantic rules.

CONTEXT:
Database Schema:
${schemaText}

Table: ${tableName}
${columnName ? `Column: ${columnName} (${columnSchema?.dataType || 'unknown type'})` : 'Exploring entire table'}

Sample Data (${sampleRows.length} of ${data.rowCount} rows):
${JSON.stringify(sampleData, null, 2)}

TASK:
Analyze the data patterns and identify semantic rules that could be learned:

1. **Data Patterns**: What patterns do you see in the data?
   - Value distributions (e.g., status values, date ranges, numeric ranges)
   - Relationships between columns
   - Common value sets or enumerations
   - Business logic indicators (e.g., active/inactive flags, date-based rules)

2. **Semantic Inferences**: What semantic knowledge could be extracted?
   - Field definitions (what does this column mean?)
   - Business rules (what logic governs these values?)
   - Time periods (if date columns exist)
   - Metrics (if numeric aggregations are relevant)
   - Dimensions (if categorical data exists)

3. **Confidence**: How confident are you in these patterns? (0.0-1.0)
   - 0.90-1.00: Very clear patterns (e.g., enum values, clear date logic)
   - 0.70-0.89: Strong patterns (e.g., consistent value ranges)
   - 0.50-0.69: Moderate patterns (e.g., inferred relationships)
   - 0.30-0.49: Weak patterns (e.g., tentative observations)

4. **Validation Query**: Suggest a SQL query to validate the pattern

OUTPUT (JSON only, no markdown):
{
  "pattern": "Description of the detected pattern (e.g., 'status column contains enum values: active, inactive, pending')",
  "confidence": 0.85,
  "suggestedSemantic": {
    "suggested_name": "active users",
    "suggested_type": "BUSINESS_RULE",
    "category": "User Status",
    "description": "Users with status='active' are considered active users",
    "sql_fragment": "status = 'active'",
    "primary_table": "${tableName}",
    "primary_column": "${columnName || 'status'}",
    "synonyms": ["enabled users", "live users"],
    "example_questions": ["How many active users?", "Show active users"]
  },
  "validationQuery": "SELECT DISTINCT ${columnName || 'status'} FROM ${tableName} ORDER BY ${columnName || 'status'}",
  "tableName": "${tableName}",
  "columnName": "${columnName || null}",
  "evidence": {
    "sampleData": ${JSON.stringify(sampleData.slice(0, 5))},
    "statistics": {
      "uniqueValues": ${columnName ? `Number of unique ${columnName} values` : 'N/A'},
      "rowCount": ${data.rowCount}
    },
    "reasoning": "Explanation of why this pattern was detected"
  }
}

Generate discovery:`;

    try {
      const result: any = await retryWithBackoff(
        () => this.model.generateContent(prompt),
        config.retry
      );
      
      const text = result.response.text();
      
      // Extract JSON from response
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      }
      
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to extract JSON from LLM response');
      }
      
      const extracted = JSON.parse(jsonMatch[0]);
      
      const discovery: Discovery = {
        pattern: extracted.pattern,
        confidence: extracted.confidence || 0.70,
        suggestedSemantic: extracted.suggestedSemantic ? {
          suggested_name: extracted.suggestedSemantic.suggested_name,
          suggested_type: extracted.suggestedSemantic.suggested_type,
          suggested_definition: {
            entityType: extracted.suggestedSemantic.suggested_type,
            name: extracted.suggestedSemantic.suggested_name,
            description: extracted.suggestedSemantic.description,
            tableName: extracted.suggestedSemantic.primary_table,
            columnName: extracted.suggestedSemantic.primary_column,
            sqlPattern: extracted.suggestedSemantic.sql_fragment,
            metadata: {
              category: extracted.suggestedSemantic.category,
              synonyms: extracted.suggestedSemantic.synonyms || [],
              example_questions: extracted.suggestedSemantic.example_questions || [],
            },
          } as any,
          learned_from: 'pattern_analysis',
          confidence: extracted.confidence || 0.70,
          status: 'pending',
          requires_expert_review: (extracted.confidence || 0.70) < 0.70,
        } : undefined,
        validationQuery: extracted.validationQuery,
        tableName: extracted.tableName || tableName,
        columnName: extracted.columnName || columnName,
        evidence: extracted.evidence || {},
      };
      
      return discovery;
    } catch (error) {
      console.error('Error analyzing pattern:', error);
      throw error;
    }
  }
}
