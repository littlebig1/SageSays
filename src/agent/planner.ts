import { GoogleGenerativeAI } from '@google/generative-ai';
import { Plan, PlanStep, ConversationTurn, OrchestratorState, PlannerNeeds, TableSchema } from '../types.js';
import { config } from '../config.js';
import { formatSchemaForLLM } from '../tools/inspectedDb.js';
import { formatSemanticsForLLM, getSemantics } from '../tools/controlDb.js';
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
    conversationHistory?: ConversationTurn[],
    state?: OrchestratorState
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

GRAIN MANAGEMENT RULES:
1. State the aggregation level explicitly for each step:
   - Row-level: individual records (no aggregation)
   - Customer-level: aggregated per customer
   - Order-level: aggregated per order
   - Daily: time-based aggregations by day
   - Monthly: time-based aggregations by month
2. Ensure JOINs don't change the intended grain unintentionally
3. If joining fact tables, explicitly state how grain is maintained in the reasoning
4. When planning aggregations, specify the grain level clearly

AMBIGUITY DETECTION RULES:
1. If question contains vague terms, return CLARIFICATION_NEEDED:
   - Time: "recent", "soon", "lately", "recently" → Ask for specific time range
   - Quantity: "many", "few", "some", "high-value", "low-value" → Ask for threshold/number
   - Status: "active", "important", "popular", "top" → Ask for definition/criteria
   - Comparison: "better", "worse", "more", "less" → Ask what to compare against
2. If question lacks necessary context:
   - No time range for time-series queries → Ask for date range
   - No filter criteria when multiple options exist → Ask which to use
   - Ambiguous comparisons without baseline → Ask what to compare
3. Generate 1-3 specific, actionable clarification questions
4. Only return CLARIFICATION_NEEDED if the ambiguity prevents creating a valid plan
5. If semantics provide definitions for vague terms (e.g., "yesterday" is defined), use them and proceed with READY status

VALIDATION REQUIREMENTS:
- Restate intent clearly in the overallGoal
- Plan joins explicitly - specify which tables join and why
- Note any assumptions or unknowns in the reasoning for each step
- If metadata is incomplete or uncertain, state this explicitly

Each step should:
1. Have a clear description of what data to retrieve
2. Include reasoning for why this step is needed (including grain level and any assumptions)
3. Be numbered sequentially

Respond ONLY with a JSON object in one of these formats:

Format 1 - When clarification is needed:
{
  "status": "CLARIFICATION_NEEDED",
  "clarificationContext": "Explanation of what's unclear (e.g., 'The term \"recent\" is ambiguous and could mean different time periods')",
  "clarificationQuestions": [
    "What time period counts as 'recent'? (e.g., last week, last month, last quarter)",
    "What threshold defines 'high-value'? (e.g., > $1000, > $5000)"
  ],
  "overallGoal": "Original goal (preserved for context)",
  "steps": []
}

Format 2 - When ready to proceed:
{
  "status": "READY",
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
      
      // Handle clarification needed
      if (planData.status === 'CLARIFICATION_NEEDED') {
        const clarificationPlan: Plan = {
          status: 'CLARIFICATION_NEEDED',
          clarificationQuestions: planData.clarificationQuestions || [],
          clarificationContext: planData.clarificationContext || 'The question needs clarification before a plan can be created.',
          overallGoal: planData.overallGoal || question,
          steps: [],
        };
        
        // Express needs
        if (state) {
          this.expressNeeds(clarificationPlan, question, schema, state);
        }
        
        return clarificationPlan;
      }
      
      // Normal plan (READY status)
      const plan: Plan = {
        status: planData.status || 'READY',
        overallGoal: planData.overallGoal || 'Answer the user question',
        steps: planData.steps || [],
      };
      
      // Express needs
      if (state) {
        this.expressNeeds(plan, question, schema, state);
      }
      
      return plan;
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
      const fallbackPlan: Plan = {
        status: 'READY',
        overallGoal: 'Answer the user question',
        steps: [{
          stepNumber: 1,
          description: 'Query the database to answer the question',
          reasoning: 'Initial query to gather information',
        }],
      };
      
      // Express needs for fallback plan
      if (state) {
        this.expressNeeds(fallbackPlan, question, schema, state);
      }
      
      return fallbackPlan;
    }
  }
  
  /**
   * Express planner needs in state
   */
  private expressNeeds(
    plan: Plan,
    question: string,
    schema: TableSchema[],
    state: OrchestratorState
  ): void {
    const needs: PlannerNeeds = {
      needsClarification: plan.status === 'CLARIFICATION_NEEDED',
      needsDiscovery: this.analyzeContextGaps(plan, question, schema),
      needsMoreContext: this.identifyMissingContext(plan, question, schema),
      confidence: this.calculateConfidence(plan),
      canProceed: plan.status === 'READY',
      blockingIssues: plan.status === 'CLARIFICATION_NEEDED' 
        ? [plan.clarificationContext || 'Unknown ambiguity']
        : [],
    };
    
    if (!state.agentNeeds) {
      state.agentNeeds = {};
    }
    state.agentNeeds.planner = needs;
  }
  
  /**
   * Analyze if plan needs discovery to fill context gaps
   */
  private analyzeContextGaps(
    plan: Plan,
    question: string,
    schema: TableSchema[]
  ): PlannerNeeds['needsDiscovery'] {
    // Check if plan mentions tables/columns that might need exploration
    const questionLower = question.toLowerCase();
    const schemaTableNames = schema.map(t => t.tableName.toLowerCase());
    
    // Look for table/column references in question that might need discovery
    const potentialTables = schemaTableNames.filter(table => 
      questionLower.includes(table) || questionLower.includes(table.replace('_', ' '))
    );
    
    // Check if plan steps mention uncertainty or missing information
    const planText = JSON.stringify(plan).toLowerCase();
    const hasUncertainty = planText.includes('unknown') || 
                           planText.includes('uncertain') || 
                           planText.includes('assume') ||
                           planText.includes('might');
    
    // If clarification is needed, discovery might help
    if (plan.status === 'CLARIFICATION_NEEDED') {
      // Check if clarification is about table/column structure
      if (plan.clarificationContext?.toLowerCase().includes('table') ||
          plan.clarificationContext?.toLowerCase().includes('column')) {
        return {
          reason: 'Need to explore database schema to understand structure',
          target: potentialTables[0] || 'unknown',
          confidence: 0.6,
        };
      }
    }
    
    // If plan has uncertainty and mentions tables, suggest discovery
    if (hasUncertainty && potentialTables.length > 0) {
      return {
        reason: 'Plan contains assumptions about table structure that could be validated through discovery',
        target: potentialTables[0],
        confidence: 0.5,
      };
    }
    
    return undefined;
  }
  
  /**
   * Identify missing context items
   */
  private identifyMissingContext(
    plan: Plan,
    question: string,
    _schema: TableSchema[]
  ): string[] {
    const missing: string[] = [];
    
    // Check for clarification needs
    if (plan.status === 'CLARIFICATION_NEEDED') {
      missing.push('User clarification needed');
      if (plan.clarificationQuestions) {
        missing.push(...plan.clarificationQuestions.map((q, i) => `Clarification ${i + 1}: ${q}`));
      }
    }
    
    // Check if plan has empty steps (might indicate missing context)
    if (plan.steps.length === 0 && plan.status === 'READY') {
      missing.push('Plan has no steps - may need more context');
    }
    
    // Check for vague terms in question that might need semantics
    const vagueTerms = ['recent', 'soon', 'lately', 'many', 'few', 'high', 'low', 'top', 'active'];
    const questionLower = question.toLowerCase();
    const foundVagueTerms = vagueTerms.filter(term => questionLower.includes(term));
    if (foundVagueTerms.length > 0 && plan.status === 'READY') {
      missing.push(`Vague terms detected: ${foundVagueTerms.join(', ')} - may need semantic definitions`);
    }
    
    return missing;
  }
  
  /**
   * Calculate confidence in the plan
   */
  private calculateConfidence(plan: Plan): number {
    // Base confidence
    let confidence = 0.8;
    
    // Reduce confidence if clarification is needed
    if (plan.status === 'CLARIFICATION_NEEDED') {
      confidence = 0.4;
    }
    
    // Reduce confidence if plan has no steps
    if (plan.steps.length === 0) {
      confidence = 0.3;
    }
    
    // Increase confidence if plan has clear steps with reasoning
    if (plan.steps.length > 0 && plan.steps.every(s => s.reasoning && s.reasoning.length > 20)) {
      confidence = Math.min(0.95, confidence + 0.1);
    }
    
    // Reduce confidence if overallGoal is vague
    if (!plan.overallGoal || plan.overallGoal.length < 10) {
      confidence = Math.max(0.2, confidence - 0.2);
    }
    
    return Math.max(0.0, Math.min(1.0, confidence));
  }
}
