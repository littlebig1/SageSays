import { Planner } from './planner.js';
import { SQLWriter } from './sqlWriter.js';
import { Interpreter } from './interpreter.js';
import { PlanStep, SQLResult, ConversationTurn } from '../types.js';
import { runSQL, getSchemaWithMetadata, getInspectedDbPool } from '../tools/inspectedDb.js';
import { validateSQL } from './guard.js';
import { saveRunLog, detectSemantics, getAllTableMetadata } from '../tools/controlDb.js';
import { validateSQLAgainstMetadata, calculateConfidence } from './sqlValidator.js';
import { config } from '../config.js';

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
   * @param conversationHistory - Optional array of previous conversation turns for context
   * @param requestPermission - Optional callback for debug mode (returns true to execute, false to cancel)
   * @param askQuestion - Optional callback for interactive prompts
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
    conversationHistory?: ConversationTurn[],
    requestPermission?: (
      sql: string, 
      stepNumber: number, 
      totalSteps: number,
      hasSemantics: boolean,
      confidence: 'high' | 'medium' | 'low',
      validationResult?: import('../types.js').SQLValidationResult
    ) => Promise<boolean>,
    askQuestion?: (prompt: string) => Promise<string>
  ): Promise<{ answer: string; logs: any; cancelled?: boolean; runLogId?: string; sqlQueries?: string[] }> {
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
    
    // Load schema with metadata enrichment
    const pool = getInspectedDbPool();
    const client = await pool.connect();
    let schema;
    try {
      schema = await getSchemaWithMetadata(client);
    } finally {
      client.release();
    }
    
    // Create initial plan (with conversation history for context)
    console.log('📋 Creating plan...');
    let plan = await this.planner.createPlan(question, schema, undefined, conversationHistory);
    console.log(`✓ Plan created with ${plan.steps.length} step(s): ${plan.overallGoal}\n`);
    
    const executedSteps: PlanStep[] = [];
    const sqlQueries: string[] = [];
    const rowsReturned: number[] = [];
    const durationsMs: number[] = [];
    const previousResults: Array<{ step: number; result: SQLResult }> = [];
    
    let finalAnswer: string | null = null;
    let refinementCount = 0;
    const maxRefinements = 3;
    const previousPlans: string[] = []; // Track plan signatures to detect loops
    
    // Execute plan steps
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const stepNumber = step.stepNumber;
      
      console.log(`\n📝 Step ${stepNumber}: ${step.description}`);
      console.log(`   Reasoning: ${step.reasoning}`);
      
      try {
        // Generate SQL (with conversation history for context)
        console.log('   Generating SQL...');
        let sql = await this.sqlWriter.generateSQL(step, question, schema, previousResults, conversationHistory);
        
        // Validate and sanitize SQL (safety checks)
        const safetyValidation = validateSQL(sql);
        if (!safetyValidation.valid) {
          throw new Error(`SQL validation failed: ${safetyValidation.reason}`);
        }
        
        sql = safetyValidation.sanitizedSQL || sql;
        step.sqlQuery = sql;
        
        // Validate SQL against metadata (zero hallucination checks)
        let metadataValidation;
        let confidence: 'high' | 'medium' | 'low' = 'medium';
        
        try {
          const metadata = await getAllTableMetadata();
          if (metadata.length > 0) {
            metadataValidation = await validateSQLAgainstMetadata(sql, schema, metadata);
            
            if (!metadataValidation.valid) {
              throw new Error(`SQL metadata validation failed: ${metadataValidation.issues.join(', ')}`);
            }
            
            // Calculate confidence based on validation
            confidence = calculateConfidence(metadataValidation, hasSemantics);
            
            // Store validation result in step
            step.validationResult = metadataValidation;
          }
        } catch (error: any) {
          // If metadata validation fails, log warning but continue if it's not critical
          if (error.message.includes('metadata validation failed')) {
            throw error; // Re-throw critical validation failures
          }
          console.warn(`   ⚠️  Metadata validation warning: ${error.message}`);
        }
        
        // ALWAYS show the generated SQL for transparency
        console.log(`   📄 SQL: ${sql}`);
        
        // Show validation details if available
        if (metadataValidation) {
          if (metadataValidation.facts.length > 0) {
            console.log(`   ✓ Facts: ${metadataValidation.facts.slice(0, 3).join('; ')}${metadataValidation.facts.length > 3 ? '...' : ''}`);
          }
          if (metadataValidation.assumptions.length > 0) {
            console.log(`   ⚠️  Assumptions: ${metadataValidation.assumptions.slice(0, 2).join('; ')}${metadataValidation.assumptions.length > 2 ? '...' : ''}`);
          }
          if (metadataValidation.unknowns.length > 0) {
            console.log(`   ❓ Unknowns: ${metadataValidation.unknowns.slice(0, 2).join('; ')}${metadataValidation.unknowns.length > 2 ? '...' : ''}`);
          }
          console.log(`   📊 Confidence: ${(metadataValidation.confidence * 100).toFixed(0)}% (${confidence}) | Performance Risk: ${metadataValidation.performanceRisk}`);
        }
        
        // Request permission if callback provided (debug mode)
        if (requestPermission) {
          const approved = await requestPermission(
            sql, 
            stepNumber, 
            plan.steps.length,
            hasSemantics,
            confidence,
            metadataValidation
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
        
        // Check if user asked for "all" and we hit the LIMIT
        const askedForAll = /\b(all|every|entire|complete)\b/i.test(question);
        const hitLimit = result.rowCount === config.maxRows && sql.includes('LIMIT');
        
        if (askedForAll && hitLimit && askQuestion) {
          // User asked for "all" but we hit the LIMIT - offer to remove it
          console.log(`\n⚠️  Query returned exactly ${config.maxRows} rows (LIMIT reached).`);
          console.log(`   You asked for "all" - there may be more rows.`);
          const removeLimit = await askQuestion('   Remove LIMIT to get all rows? (y/n): ');
          
          if (removeLimit.trim().toLowerCase() === 'y' || removeLimit.trim().toLowerCase() === 'yes') {
            // Remove LIMIT and re-execute
            const sqlWithoutLimit = sql.replace(/\s+LIMIT\s+\d+/i, '');
            console.log('   Re-executing without LIMIT...');
            
            const startTime2 = Date.now();
            const result2 = await runSQL(sqlWithoutLimit);
            const duration2 = Date.now() - startTime2;
            
            console.log(`   ✓ Query executed: ${result2.rowCount} rows in ${duration2}ms`);
            
            // Warn if too many rows
            if (result2.rowCount > 10000) {
              console.log(`\n⚠️  Warning: Query returned ${result2.rowCount} rows. This is a large result set.`);
            }
            
            // Update with the full result
            sqlQueries[sqlQueries.length - 1] = sqlWithoutLimit; // Replace last query
            rowsReturned[rowsReturned.length - 1] = result2.rowCount; // Replace last count
            durationsMs[durationsMs.length - 1] = duration2; // Replace last duration
            
            // Store the full result
            previousResults.push({ step: stepNumber, result: result2 });
            executedSteps.push(step);
            
            // Continue with interpretation using full result
            console.log('   Interpreting results...');
            const interpretation = await this.interpreter.interpret(
              question,
              step,
              result2,
              plan.steps,
              executedSteps.map(s => s.stepNumber)
            );
            
            console.log(`   Interpretation: ${interpretation.status} (confidence: ${interpretation.confidence})`);
            
            if (interpretation.status === 'FINAL_ANSWER') {
              finalAnswer = interpretation.answer || 'Answer generated from query results.';
              break;
            }
            
            // Skip the rest of the loop iteration since we already interpreted
            continue;
          }
        }
        
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
            // Create plan signature to detect loops
            const planSignature = plan.steps.map(s => s.description).join('|');
            
            // Check if we've seen this plan before (loop detection)
            if (previousPlans.includes(planSignature)) {
              console.log(`\n⚠️  Detected refinement loop - same plan generated again.`);
              console.log(`   Treating current results as final answer.\n`);
              // Break out and use current results as final answer
              break;
            }
            
            previousPlans.push(planSignature);
            
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
      runLogId: runLogId,
      sqlQueries: sqlQueries, // Return SQL queries for conversation history
    };
  }
}
