import { Planner } from './planner.js';
import { SQLWriter } from './sqlWriter.js';
import { Interpreter } from './interpreter.js';
import { PlanStep, SQLResult } from '../types.js';
import { runSQL } from '../tools/db.js';
import { getSchema } from '../tools/schema.js';
import { getInspectedDbPool } from '../tools/db.js';
import { validateSQL } from './guard.js';
import { saveRunLog } from '../tools/logs.js';
import { detectSemantics } from '../tools/semantics.js';

export class Orchestrator {
  private planner: Planner;
  private sqlWriter: SQLWriter;
  private interpreter: Interpreter;
  
  constructor() {
    this.planner = new Planner();
    this.sqlWriter = new SQLWriter();
    this.interpreter = new Interpreter();
  }
  
  /**
   * Executes a Level-2 agentic workflow to answer a user question.
   * 
   * Orchestration flow:
   * 1. Loads database schema
   * 2. Creates a multi-step plan using Planner
   * 3. For each step:
   *    - Generates SQL using SQLWriter
   *    - Validates SQL with Guard
   *    - Requests permission (if in debug mode)
   *    - Executes SQL against inspected database
   *    - Interprets results using Interpreter
   * 4. Refines plan if needed (max 3 refinements)
   * 5. Returns final answer or cancels if permission denied
   * 
   * @param question - The natural language question to answer
   * @param requestPermission - Optional callback for debug mode (returns true to execute, false to cancel)
   * @returns Object containing answer, execution logs, and cancelled flag
   * 
   * @example
   * ```typescript
   * const orchestrator = new Orchestrator();
   * const result = await orchestrator.execute('How many users are active?');
   * console.log(result.answer);
   * ```
   */
  async execute(
    question: string, 
    requestPermission?: (
      sql: string, 
      stepNumber: number, 
      totalSteps: number,
      hasSemantics: boolean,
      confidence: 'high' | 'medium' | 'low'
    ) => Promise<boolean>
  ): Promise<{ answer: string; logs: any; cancelled?: boolean }> {
    // Runtime assertion: ensure question is valid
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('Invalid question: must be a non-empty string');
    }
    
    console.log(`\n🤔 Question: ${question}\n`);
    
    // Detect relevant semantics
    const detectedSemanticIds = await detectSemantics(question);
    const hasSemantics = detectedSemanticIds.length > 0;
    
    if (hasSemantics) {
      console.log(`🔍 Detected ${detectedSemanticIds.length} relevant semantic(s)\n`);
    }
    
    // Load schema
    const pool = getInspectedDbPool();
    const client = await pool.connect();
    let schema;
    try {
      schema = await getSchema(client);
    } finally {
      client.release();
    }
    
    // Create initial plan
    console.log('📋 Creating plan...');
    let plan = await this.planner.createPlan(question, schema);
    console.log(`✓ Plan created with ${plan.steps.length} step(s): ${plan.overallGoal}\n`);
    
    const executedSteps: PlanStep[] = [];
    const sqlQueries: string[] = [];
    const rowsReturned: number[] = [];
    const durationsMs: number[] = [];
    const previousResults: Array<{ step: number; result: SQLResult }> = [];
    
    let finalAnswer: string | null = null;
    let refinementCount = 0;
    const maxRefinements = 3;
    
    // Execute plan steps
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const stepNumber = step.stepNumber;
      
      console.log(`\n📝 Step ${stepNumber}: ${step.description}`);
      console.log(`   Reasoning: ${step.reasoning}`);
      
      try {
        // Generate SQL
        console.log('   Generating SQL...');
        let sql = await this.sqlWriter.generateSQL(step, question, schema, previousResults);
        
        // Validate and sanitize SQL
        const validation = validateSQL(sql);
        if (!validation.valid) {
          throw new Error(`SQL validation failed: ${validation.reason}`);
        }
        
        sql = validation.sanitizedSQL || sql;
        step.sqlQuery = sql;
        
        // ALWAYS show the generated SQL for transparency
        console.log(`   📄 SQL: ${sql}`);
        
        // Request permission if callback provided (debug mode)
        if (requestPermission) {
          // For now, use medium confidence as default
          // In future, could extract from Planner/SQLWriter responses
          const preliminaryConfidence: 'high' | 'medium' | 'low' = 'medium';
          
          const approved = await requestPermission(
            sql, 
            stepNumber, 
            plan.steps.length,
            hasSemantics,
            preliminaryConfidence
          );
          
          if (!approved) {
            // User rejected - return without saving context
            return {
              answer: '',
              logs: {
                steps: 0,
                queries: 0,
                totalRows: 0,
                totalDuration: 0,
              },
              cancelled: true,
            };
          }
        }
        
        // Execute SQL
        console.log('   Executing query...');
        const startTime = Date.now();
        const result = await runSQL(sql);
        const duration = Date.now() - startTime;
        
        sqlQueries.push(sql);
        rowsReturned.push(result.rowCount);
        durationsMs.push(duration);
        
        console.log(`   ✓ Query executed: ${result.rowCount} rows in ${duration}ms`);
        
        // Store result
        previousResults.push({ step: stepNumber, result });
        executedSteps.push(step);
        
        // Interpret results
        console.log('   Interpreting results...');
        const interpretation = await this.interpreter.interpret(
          question,
          step,
          result,
          plan.steps,
          executedSteps.map(s => s.stepNumber)
        );
        
        console.log(`   Interpretation: ${interpretation.status} (confidence: ${interpretation.confidence})`);
        
        if (interpretation.status === 'FINAL_ANSWER') {
          finalAnswer = interpretation.answer || 'Answer generated from query results.';
          break;
        } else if (interpretation.status === 'NEEDS_REFINEMENT') {
          // Check if we should create a refined plan
          if (refinementCount < maxRefinements && i === plan.steps.length - 1) {
            console.log(`\n🔄 Creating refined plan based on results...`);
            refinementCount++;
            plan = await this.planner.createPlan(question, schema, executedSteps);
            console.log(`✓ Refined plan created with ${plan.steps.length} step(s)\n`);
            // Continue loop with new plan steps
            i = -1; // Reset to start of new plan (will be incremented to 0)
            continue;
          }
        }
      } catch (error) {
        console.error(`   ✗ Error in step ${stepNumber}:`, error);
        throw error;
      }
    }
    
    // If no final answer yet, generate one from results
    if (!finalAnswer) {
      if (previousResults.length > 0) {
        const lastResult = previousResults[previousResults.length - 1].result;
        const limitedRows = lastResult.rows.slice(0, 10);
        finalAnswer = `Query completed. Returned ${lastResult.rowCount} rows. Sample results:\n${JSON.stringify(limitedRows, null, 2)}`;
      } else {
        finalAnswer = 'No results returned from queries.';
      }
    }
    
    // Save run log with detected semantics (optional - only if control DB is configured)
    let runLogId: string | undefined;
    try {
      const runLog = await saveRunLog(question, sqlQueries, rowsReturned, durationsMs, detectedSemanticIds);
      if (runLog) {
        runLogId = runLog.id;
      }
    } catch (error) {
      // Silently ignore - control DB is optional
    }
    
    return {
      answer: finalAnswer,
      logs: {
        steps: executedSteps.length,
        queries: sqlQueries.length,
        totalRows: rowsReturned.reduce((a, b) => a + b, 0),
        totalDuration: durationsMs.reduce((a, b) => a + b, 0),
        runLogId, // Include run_log_id for corrections
      },
      cancelled: false,
    };
  }
}
