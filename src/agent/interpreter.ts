import { GoogleGenerativeAI } from '@google/generative-ai';
import { Interpretation, SQLResult, PlanStep } from '../types.js';
import { config } from '../config.js';
import { retryWithBackoff } from '../utils/retry.js';
import { formatSemanticsForLLM, getSemantics } from '../tools/controlDb.js';

export class Interpreter {
  private genAI: GoogleGenerativeAI;
  private model: any;
  
  constructor() {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: config.geminiModel });
  }
  
  async interpret(
    question: string,
    step: PlanStep,
    sqlResult: SQLResult,
    allSteps: PlanStep[],
    completedSteps: number[]
  ): Promise<Interpretation> {
    // Limit the result rows sent to LLM
    const limitedRows = sqlResult.rows.slice(0, config.maxResultRowsForLLM);
    const hasMoreRows = sqlResult.rows.length > config.maxResultRowsForLLM;
    
    // Load semantics for context
    const semantics = await getSemantics();
    const semanticsText = await formatSemanticsForLLM(semantics);
    
    const prompt = `You are a SQL result interpretation assistant. Analyze the query results and determine if we have enough information to answer the user's question, or if we need more queries.

${semanticsText}

User Question: ${question}

Current Step: ${step.description} (Step ${step.stepNumber} of ${allSteps.length})
SQL Executed: ${step.sqlQuery || 'N/A'}

Query Results:
- Columns: ${sqlResult.columns.join(', ')}
- Rows returned: ${sqlResult.rowCount}${hasMoreRows ? ` (showing first ${limitedRows.length} rows)` : ''}
- Execution time: ${sqlResult.durationMs}ms

Sample Data (first ${limitedRows.length} rows):
${JSON.stringify(limitedRows, null, 2)}

Completed Steps: ${completedSteps.join(', ')}
Remaining Steps: ${allSteps.filter(s => !completedSteps.includes(s.stepNumber)).map(s => s.stepNumber).join(', ')}

CRITICAL RULES:
1. If the query returned results that directly answer the user's question, return FINAL_ANSWER
2. LIMIT clauses are safety features - they don't invalidate an answer. If a query returns data that answers the question (even if limited), it's a FINAL_ANSWER
3. "Show me all X" or "list all X" questions are answered by showing a representative sample (the LIMIT is intentional for safety)
4. Only return NEEDS_REFINEMENT if:
   - The query returned NO results and we need to try a different approach
   - The query returned results but they're clearly wrong/irrelevant to the question
   - We need additional data from other tables to complete the answer
5. DO NOT return NEEDS_REFINEMENT just because there's a LIMIT clause - that's expected behavior

Determine if:
1. We have enough information to provide a FINAL_ANSWER
2. We need to continue with more steps (NEEDS_REFINEMENT)

Respond with ONLY a JSON object in this exact format:
{
  "status": "FINAL_ANSWER" or "NEEDS_REFINEMENT",
  "answer": "The answer to the user's question (only if status is FINAL_ANSWER)",
  "nextStep": "What to do next (only if status is NEEDS_REFINEMENT)",
  "confidence": "high" or "medium" or "low"
}`;

    try {
      // Wrap the LLM call with retry logic for handling API overload
      const result = await retryWithBackoff(async () => {
        return await this.model.generateContent(prompt);
      });
      
      const response = result.response;
      let text = response.text().trim();
      
      // Extract JSON from response
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const interpretation = JSON.parse(text);
      
      return {
        status: interpretation.status === 'FINAL_ANSWER' ? 'FINAL_ANSWER' : 'NEEDS_REFINEMENT',
        answer: interpretation.answer,
        nextStep: interpretation.nextStep,
        confidence: interpretation.confidence || 'medium',
      };
    } catch (error: any) {
      console.error('Interpretation error:', error);
      
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
      
      // Fallback interpretation for other errors
      if (sqlResult.rowCount > 0 && completedSteps.length >= allSteps.length) {
        return {
          status: 'FINAL_ANSWER',
          answer: `Query returned ${sqlResult.rowCount} rows. Here are the results:\n${JSON.stringify(limitedRows, null, 2)}`,
          confidence: 'medium',
        };
      }
      return {
        status: 'NEEDS_REFINEMENT',
        nextStep: 'Continue with next step in plan',
        confidence: 'low',
      };
    }
  }
}
