import { GoogleGenerativeAI } from '@google/generative-ai';
import { Plan, PlanStep } from '../types.js';
import { config } from '../config.js';
import { formatSchemaForLLM } from '../tools/schema.js';
import { formatSemanticsForLLM } from '../tools/semantics.js';
import { getSemantics } from '../tools/semantics.js';
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
    previousSteps?: PlanStep[]
  ): Promise<Plan> {
    const schemaText = formatSchemaForLLM(schema);
    const semantics = await getSemantics();
    const semanticsText = formatSemanticsForLLM(semantics);
    
    const context = previousSteps 
      ? `Previous steps taken:\n${previousSteps.map(s => `Step ${s.stepNumber}: ${s.description}${s.sqlQuery ? `\nSQL: ${s.sqlQuery}` : ''}`).join('\n\n')}\n\n`
      : '';
    
    const prompt = `You are a SQL query planning assistant. Your role is to break down user questions into a step-by-step plan for querying a PostgreSQL database.

Database Schema:
${schemaText}

${semanticsText}

${context}User Question: ${question}

IMPORTANT: Review the Business Semantics above. If the user's question contains any terms defined in the semantics (e.g., "yesterday", "this month"), use those exact definitions when planning your steps.

Create a detailed plan with multiple steps. Each step should:
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
