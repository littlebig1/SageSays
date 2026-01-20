import { GoogleGenerativeAI } from '@google/generative-ai';
import { Plan, PlanStep, ConversationTurn } from '../types.js';
import { config } from '../config.js';
import { formatSchemaForLLM } from '../tools/inspectedDb.js';
import { formatSemanticsForLLM, getSemantics } from '../tools/controlDb.js';
import { TableSchema } from '../types.js';
import { retryWithBackoff } from '../utils/retry.js';

export class Planner {
  private genAI: GoogleGenerativeAI;
  private model: any;
  
  constructor() {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: config.geminiModel });
  }
  
  async createPlan(
    question: string,
    schema: TableSchema[],
    previousSteps?: PlanStep[],
    conversationHistory?: ConversationTurn[]
  ): Promise<Plan> {
    const schemaText = formatSchemaForLLM(schema);
    const semantics = await getSemantics();
    const semanticsText = await formatSemanticsForLLM(semantics);
    
    const context = previousSteps 
      ? `Previous steps taken:\n${previousSteps.map(s => `Step ${s.stepNumber}: ${s.description}${s.sqlQuery ? `\nSQL: ${s.sqlQuery}` : ''}`).join('\n\n')}\n\n`
      : '';
    
    // Build conversation history context
    const conversationContext = conversationHistory && conversationHistory.length > 0
      ? `\nRecent Conversation History (for context awareness):\n${conversationHistory.map((turn, i) => {
          const turnNum = conversationHistory.length - i; // Most recent is last
          return `Turn ${turnNum}:\n  Q: ${turn.question}\n  A: ${turn.answer.substring(0, 200)}${turn.answer.length > 200 ? '...' : ''}\n  Tables: ${turn.resultTable || 'unknown'}\n  Columns: ${turn.resultColumns?.join(', ') || 'unknown'}\n`;
        }).join('\n')}\n`
      : '';
    
    const prompt = `You are a SQL query planning assistant. Your role is to break down user questions into a step-by-step plan for querying a PostgreSQL database.

Database Schema:
${schemaText}

${semanticsText}

${conversationContext}${context}User Question: ${question}

CONTEXT AWARENESS RULES:
${conversationHistory && conversationHistory.length > 0 
  ? `- If the question uses pronouns ("them", "it", "those") or references ("also", "and", "by country", "group by"), 
    it likely refers to the PREVIOUS question's results shown in "Recent Conversation History" above
- Check the "Recent Conversation History" to understand what was just queried
- If asking to "group by", "display by", "filter", or "show by", use the same base query from the previous turn but add the requested operation
- The previous query's table and columns are shown above - use them as context for follow-up questions`
  : ''}

CRITICAL PLANNING RULES:
1. Review the Business Semantics above - these provide pre-built SQL patterns for specific terms
2. If the user's question can be answered with a SINGLE query (count/filter/aggregate with semantics), use ONLY ONE step
3. Only create multiple steps when TRULY necessary:
   - Complex subqueries requiring intermediate results
   - Multiple independent aggregations to be combined
   - Data from one query needed to filter another query
4. DO NOT decompose simple queries into multiple conceptual steps (select, filter, count)
5. When semantics provide SQL patterns for time periods, metrics, or business rules, incorporate them directly into a single step

Each step should:
1. Have a clear description of what data to retrieve
2. Include reasoning for why this step is needed
3. Be numbered sequentially

Respond ONLY with a JSON object in this exact format:
{
  "overallGoal": "Brief description of what we're trying to achieve",
  "steps": [
    {
      "stepNumber": 1,
      "description": "What to do in this step",
      "reasoning": "Why this step is necessary"
    },
    {
      "stepNumber": 2,
      "description": "Next step",
      "reasoning": "Why this step is necessary"
    }
  ]
}

Do not include SQL queries in the plan - that will be generated separately. Focus on the logical steps needed to answer the question.`;

    try {
      // Wrap the LLM call with retry logic for handling API overload
      const result = await retryWithBackoff(async () => {
        return await this.model.generateContent(prompt);
      });
      
      const response = result.response;
      const text = response.text();
      
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const planData = JSON.parse(jsonText);
      
      return {
        overallGoal: planData.overallGoal || 'Answer the user question',
        steps: planData.steps || [],
      };
    } catch (error: any) {
      console.error('Planning error:', error);
      
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
      
      // Fallback to a simple single-step plan for other errors
      return {
        overallGoal: 'Answer the user question',
        steps: [{
          stepNumber: 1,
          description: 'Query the database to answer the question',
          reasoning: 'Initial query to gather information',
        }],
      };
    }
  }
}
