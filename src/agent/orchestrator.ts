import { Planner } from './planner.js';
import { SQLWriter } from './sqlWriter.js';
import { Interpreter } from './interpreter.js';
import { 
  ConversationTurn,
  Mode,
  QuerySubState,
  DiscoverySubState,
  SemanticStoringSubState,
  SubState,
  OrchestratorState,
  ExecutionContext,
  ToolResult,
  PlannerResult,
  SQLExecutionResult,
  InterpreterResult,
  DiscoveryResult,
  SemanticSuggestion,
  AgentNeeds,
  OrchestrationDecision
} from '../types.js';
import { runSQL, getSchemaWithMetadata, getInspectedDbPool } from '../tools/inspectedDb.js';
import { validateSQL } from './guard.js';
import { saveRunLog, detectSemantics, getAllTableMetadata, insertSuggestion, approveSuggestion } from '../tools/controlDb.js';
import { validateSQLAgainstMetadata, calculateConfidence } from './sqlValidator.js';
import { config } from '../config.js';
import { SemanticLearner } from './semanticLearner.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { retryWithBackoff } from '../utils/retry.js';

export class Orchestrator {
  private planner: Planner;
  private sqlWriter: SQLWriter;
  private interpreter: Interpreter;
  private semanticLearner: SemanticLearner;
  
  constructor() {
    this.planner = new Planner();
    this.sqlWriter = new SQLWriter();
    this.interpreter = new Interpreter();
    this.semanticLearner = new SemanticLearner();
  }
  
  // ============================================================================
  // State Machine Methods
  // ============================================================================
  
  /**
   * Initialize state for a given mode and question
   */
  private initializeState(mode: Mode, question?: string, existingContext?: ExecutionContext): OrchestratorState {
    const context: ExecutionContext = existingContext || {
      question: question || '',
      executedSteps: [],
      previousResults: [],
      discoveries: [],
      sqlQueries: [],
      rowsReturned: [],
      durationsMs: [],
      startTime: Date.now(),
      iterationCount: 0,
      refinementCount: 0,
      previousPlans: [],
    };
    
    return {
      activeMode: mode,
      queryState: mode === 'QUERY' ? 'PLAN' : null,
      discoveryState: mode === 'DISCOVERY' ? 'GET_DATA' : null,
      semanticStoringState: mode === 'SEMANTIC_STORING' ? 'VALIDATE' : null,
      context,
    };
  }
  
  /**
   * Get the active sub-state for the current active mode
   */
  private getActiveSubState(state: OrchestratorState): SubState | null {
    if (state.activeMode === null) {
      return null;
    }
    
    switch (state.activeMode) {
      case 'QUERY':
        return state.queryState;
      case 'DISCOVERY':
        return state.discoveryState;
      case 'SEMANTIC_STORING':
        return state.semanticStoringState;
    }
  }
  
  /**
   * Find the next mode that needs activation (has non-null sub-state)
   */
  private findNextActiveMode(state: OrchestratorState): Mode | null {
    // Priority order: QUERY > DISCOVERY > SEMANTIC_STORING
    if (state.queryState !== null) {
      return 'QUERY';
    }
    if (state.discoveryState !== null) {
      return 'DISCOVERY';
    }
    if (state.semanticStoringState !== null) {
      return 'SEMANTIC_STORING';
    }
    return null;
  }
  
  /**
   * Check if all modes are terminated (all sub-states are null)
   */
  private allModesTerminated(state: OrchestratorState): boolean {
    return state.queryState === null && 
           state.discoveryState === null && 
           state.semanticStoringState === null;
  }
  
  /**
   * Update state with partial updates
   */
  private updateState(state: OrchestratorState, updates: Partial<OrchestratorState>): OrchestratorState {
    const contextUpdates = updates.context;
    if (!contextUpdates) {
      return { ...state, ...updates };
    }
    
    return {
      ...state,
      ...updates,
      context: {
        ...state.context,
        ...contextUpdates,
        // Ensure required arrays are always present (use updates if provided, otherwise keep existing)
        executedSteps: contextUpdates.executedSteps ?? state.context.executedSteps,
        previousResults: contextUpdates.previousResults ?? state.context.previousResults,
        discoveries: contextUpdates.discoveries ?? state.context.discoveries,
      },
    };
  }
  
  /**
   * Select next action using LLM decision making
   */
  private async selectNextAction(state: OrchestratorState): Promise<OrchestrationDecision> {
    // Use LLM to decide next action
    const decision = await this.decideNextAction(state);
    
    // Log decision for debugging
    if (!state.decisionHistory) {
      state.decisionHistory = [];
    }
    state.decisionHistory.push(decision);
    state.lastDecision = decision;
    
    return decision;
  }
  
  /**
   * Call the appropriate tool based on MODE + SUB-STATE
   */
  private async callTool(
    toolId: string,
    state: OrchestratorState,
    requestPermission?: (sql: string, stepNumber: number, totalSteps: number, hasSemantics: boolean, confidence: 'high' | 'medium' | 'low', validationResult?: import('../types.js').SQLValidationResult) => Promise<boolean>,
    askQuestion?: (prompt: string) => Promise<string>
  ): Promise<ToolResult> {
    const [mode, subState] = toolId.split(':') as [Mode, SubState];
    
    // Load schema if not already loaded
    if (!state.context.schema) {
      const pool = getInspectedDbPool();
      const client = await pool.connect();
      try {
        state.context.schema = await getSchemaWithMetadata(client);
      } finally {
        client.release();
      }
    }
    
    if (mode === 'QUERY') {
      return await this.callQueryTool(subState as QuerySubState, state, requestPermission, askQuestion);
    } else if (mode === 'DISCOVERY') {
      return await this.callDiscoveryTool(subState as DiscoverySubState, state, askQuestion);
    } else if (mode === 'SEMANTIC_STORING') {
      return await this.callSemanticStoringTool(subState as SemanticStoringSubState, state, askQuestion);
    }
    
    throw new Error(`Unknown tool: ${toolId}`);
  }
  
  /**
   * Call QUERY mode tools
   */
  private async callQueryTool(
    subState: QuerySubState,
    state: OrchestratorState,
    requestPermission?: (sql: string, stepNumber: number, totalSteps: number, hasSemantics: boolean, confidence: 'high' | 'medium' | 'low', validationResult?: import('../types.js').SQLValidationResult) => Promise<boolean>,
    _askQuestion?: (prompt: string) => Promise<string>
  ): Promise<ToolResult> {
    // _askQuestion is not used in QUERY mode - "all" request handling is done in execute() method
    const schema = state.context.schema!;
    const question = state.context.question || '';
    
    switch (subState) {
      case 'PLAN': {
        console.log('📋 Creating plan...');
        const plan = await this.planner.createPlan(
          question,
          schema,
          state.context.executedSteps.length > 0 ? state.context.executedSteps : undefined,
          state.context.conversationHistory,
          state
        );
        
        const result: PlannerResult = {
          type: 'planner',
          success: true,
          data: {
            plan,
            needsClarification: plan.status === 'CLARIFICATION_NEEDED',
          },
          contextUpdates: {
            plan,
          },
        };
        
        if (plan.status === 'CLARIFICATION_NEEDED') {
          result.nextState = { mode: 'QUERY', subState: 'CLARIFICATION' };
        } else {
          result.nextState = { mode: 'QUERY', subState: 'EXECUTE' };
        }
        
        return result;
      }
      
      case 'CLARIFICATION': {
        // This is handled in the transition logic
        // Return a result that triggers clarification handling
        const plan = state.context.plan!;
        const result: PlannerResult = {
          type: 'planner',
          success: true,
          data: {
            plan,
            needsClarification: true,
          },
        };
        return result;
      }
      
      case 'EXECUTE': {
        const plan = state.context.plan!;
        const currentStepIndex = state.context.executedSteps.length;
        const step = plan.steps[currentStepIndex];
        
        if (!step) {
          // No more steps, move to INTERPRET
          return {
            type: 'interpreter',
            success: true,
            data: {
              interpretation: {
                status: 'FINAL_ANSWER',
                answer: 'All plan steps completed.',
                confidence: 'high',
              },
            },
            nextState: { mode: 'QUERY', subState: 'INTERPRET' },
          };
        }
        
        console.log(`\n📝 Step ${step.stepNumber}: ${step.description}`);
        console.log(`   Reasoning: ${step.reasoning}`);
        console.log('   Generating SQL...');
        
        const sql = await this.sqlWriter.generateSQL(
          step,
          question,
          schema,
          state.context.previousResults,
          state.context.conversationHistory,
          state
        );
        
        // Validate SQL
        const safetyValidation = validateSQL(sql);
        if (!safetyValidation.valid) {
          throw new Error(`SQL validation failed: ${safetyValidation.reason}`);
        }
        
        const sanitizedSQL = safetyValidation.sanitizedSQL || sql;
        step.sqlQuery = sanitizedSQL;
        
        // Metadata validation
        let metadataValidation;
        let confidence: 'high' | 'medium' | 'low' = 'medium';
        const hasSemantics = (state.context.detectedSemanticIds?.length || 0) > 0;
        
        try {
          const metadata = await getAllTableMetadata();
          if (metadata.length > 0) {
            metadataValidation = await validateSQLAgainstMetadata(sanitizedSQL, schema, metadata);
            if (!metadataValidation.valid) {
              throw new Error(`SQL metadata validation failed: ${metadataValidation.issues.join(', ')}`);
            }
            confidence = calculateConfidence(metadataValidation, hasSemantics);
            step.validationResult = metadataValidation;
          }
        } catch (error: any) {
          if (error.message.includes('metadata validation failed')) {
            throw error;
          }
          console.warn(`   ⚠️  Metadata validation warning: ${error.message}`);
        }
        
        console.log(`   📄 SQL: ${sanitizedSQL}`);
        
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
        
        // Request permission if callback provided
        if (requestPermission) {
          const approved = await requestPermission(
            sanitizedSQL,
            step.stepNumber,
            plan.steps.length,
            hasSemantics,
            confidence,
            metadataValidation
          );
          
          if (!approved) {
            return {
              type: 'sqlWriter',
              success: false,
              data: { sql: sanitizedSQL, step },
            };
          }
        }
        
        // Execute SQL
        console.log('   Executing query...');
        const startTime = Date.now();
        const result = await runSQL(sanitizedSQL);
        const duration = Date.now() - startTime;
        
        console.log(`   ✓ Query executed: ${result.rowCount} rows in ${duration}ms`);
        
        const executionResult: SQLExecutionResult = {
          type: 'sqlExecution',
          success: true,
          data: {
            sql: sanitizedSQL,
            result,
            step,
          },
          contextUpdates: {
            sqlQueries: [...(state.context.sqlQueries || []), sanitizedSQL],
            rowsReturned: [...(state.context.rowsReturned || []), result.rowCount],
            durationsMs: [...(state.context.durationsMs || []), duration],
            previousResults: [...state.context.previousResults, { step: step.stepNumber, result }],
            executedSteps: [...state.context.executedSteps, step],
          },
          nextState: { mode: 'QUERY', subState: 'INTERPRET' },
        };
        
        return executionResult;
      }
      
      case 'INTERPRET': {
        const plan = state.context.plan!;
        const lastResult = state.context.previousResults[state.context.previousResults.length - 1];
        const step = lastResult ? state.context.executedSteps.find(s => s.stepNumber === lastResult.step) : undefined;
        
        if (!step || !lastResult) {
          throw new Error('No result to interpret');
        }
        
        console.log('   Interpreting results...');
        const interpretation = await this.interpreter.interpret(
          question,
          step,
          lastResult.result,
          plan.steps,
          state.context.executedSteps.map(s => s.stepNumber),
          state
        );
        
        console.log(`   Interpretation: ${interpretation.status} (confidence: ${interpretation.confidence})`);
        
        const result: InterpreterResult = {
          type: 'interpreter',
          success: true,
          data: { interpretation },
        };
        
        if (interpretation.status === 'FINAL_ANSWER') {
          result.nextState = { mode: 'QUERY', subState: 'ANSWER' };
        } else if (interpretation.status === 'NEEDS_REFINEMENT') {
          // Check if we should refine
          const refinementCount = state.context.refinementCount || 0;
          const maxRefinements = 3;
          const isLastStep = state.context.executedSteps.length === plan.steps.length;
          
          if (refinementCount < maxRefinements && isLastStep) {
            // Check for loops
            const planSignature = plan.steps.map(s => s.description).join('|');
            const previousPlans = state.context.previousPlans || [];
            
            if (previousPlans.includes(planSignature)) {
              console.log(`\n⚠️  Detected refinement loop - same plan generated again.`);
              console.log(`   Treating current results as final answer.\n`);
              result.nextState = { mode: 'QUERY', subState: 'ANSWER' };
            } else {
              result.nextState = { mode: 'QUERY', subState: 'PLAN' };
              result.contextUpdates = {
                refinementCount: refinementCount + 1,
                previousPlans: [...previousPlans, planSignature],
              };
            }
          } else {
            result.nextState = { mode: 'QUERY', subState: 'ANSWER' };
          }
        } else {
          // Continue with next step
          result.nextState = { mode: 'QUERY', subState: 'EXECUTE' };
        }
        
        return result;
      }
      
      case 'ANSWER': {
        // Terminal state - handled in transition logic
        return {
          type: 'interpreter',
          success: true,
          data: {
            interpretation: {
              status: 'FINAL_ANSWER',
              answer: state.context.previousResults.length > 0 
                ? 'Answer generated from query results.'
                : 'No results returned from queries.',
              confidence: 'high',
            },
          },
        };
      }
      
      default:
        throw new Error(`Unknown QUERY sub-state: ${subState}`);
    }
  }
  
  /**
   * Call DISCOVERY mode tools
   */
  private async callDiscoveryTool(
    subState: DiscoverySubState,
    state: OrchestratorState,
    askQuestion?: (prompt: string) => Promise<string>
  ): Promise<ToolResult> {
    const schema = state.context.schema!;
    const question = state.context.question || '';
    
    // Extract exploration target from question (e.g., "/explore orders" or "/explore orders status")
    const exploreMatch = question.match(/\/explore\s+(\w+)(?:\s+(\w+))?/i);
    const tableName = exploreMatch?.[1] || '';
    const columnName = exploreMatch?.[2];
    
    switch (subState) {
      case 'GET_DATA': {
        console.log(`\n🔍 Exploring ${tableName}${columnName ? ` (column: ${columnName})` : ''}...`);
        
        // Generate exploration query
        let explorationSQL: string;
        if (columnName) {
          // Explore specific column
          explorationSQL = `SELECT ${columnName}, COUNT(*) as count FROM ${tableName} GROUP BY ${columnName} ORDER BY count DESC LIMIT 50`;
        } else {
          // Explore entire table - get sample rows
          explorationSQL = `SELECT * FROM ${tableName} LIMIT 100`;
        }
        
        console.log(`   📄 Exploration SQL: ${explorationSQL}`);
        console.log('   Executing query...');
        
        const startTime = Date.now();
        const result = await runSQL(explorationSQL);
        const duration = Date.now() - startTime;
        
        console.log(`   ✓ Query executed: ${result.rowCount} rows in ${duration}ms`);
        
        return {
          type: 'sqlExecution',
          success: true,
          data: {
            sql: explorationSQL,
            result,
            step: {
              stepNumber: 1,
              description: `Explore ${tableName}${columnName ? ` column ${columnName}` : ''}`,
              reasoning: 'Gathering sample data for pattern analysis',
            },
          },
          contextUpdates: {
            ...state.context,
            sqlQueries: [...(state.context.sqlQueries || []), explorationSQL],
            rowsReturned: [...(state.context.rowsReturned || []), result.rowCount],
            durationsMs: [...(state.context.durationsMs || []), duration],
          },
          nextState: { mode: 'DISCOVERY', subState: 'ANALYZE' },
        };
      }
      
      case 'ANALYZE': {
        const lastResult = state.context.previousResults[state.context.previousResults.length - 1];
        if (!lastResult) {
          throw new Error('No data to analyze');
        }
        
        console.log('\n🧠 Analyzing patterns in the data...');
        
        const discovery = await this.semanticLearner.analyzePattern(
          lastResult.result,
          schema,
          tableName,
          columnName
        );
        
        console.log(`   ✓ Pattern detected: ${discovery.pattern}`);
        console.log(`   📊 Confidence: ${(discovery.confidence * 100).toFixed(0)}%`);
        
        return {
          type: 'semanticLearner',
          success: true,
          data: { discovery },
          contextUpdates: {
            ...state.context,
            discoveries: [...state.context.discoveries, discovery],
          },
          nextState: { mode: 'DISCOVERY', subState: 'VALIDATE' },
        };
      }
      
      case 'VALIDATE': {
        const lastDiscovery = state.context.discoveries[state.context.discoveries.length - 1];
        if (!lastDiscovery || !lastDiscovery.validationQuery) {
          // Skip validation if no query provided
          return {
            type: 'semanticLearner',
            success: true,
            data: { discovery: lastDiscovery },
            nextState: { mode: 'DISCOVERY', subState: 'SUGGEST' },
          };
        }
        
        console.log('\n✅ Validating pattern...');
        console.log(`   📄 Validation SQL: ${lastDiscovery.validationQuery}`);
        
        const startTime = Date.now();
        const validationResult = await runSQL(lastDiscovery.validationQuery);
        const duration = Date.now() - startTime;
        
        console.log(`   ✓ Validation query executed: ${validationResult.rowCount} rows in ${duration}ms`);
        
        // Update discovery with validation results
        const validatedDiscovery = {
          ...lastDiscovery,
          confidence: Math.min(lastDiscovery.confidence + 0.1, 1.0), // Boost confidence after validation
          evidence: {
            ...lastDiscovery.evidence,
            validationResults: {
              rowCount: validationResult.rowCount,
              sampleRows: validationResult.rows.slice(0, 10),
            },
          },
        };
        
        return {
          type: 'semanticLearner',
          success: true,
          data: { discovery: validatedDiscovery },
          contextUpdates: {
            ...state.context,
            discoveries: state.context.discoveries.map((d, i) => 
              i === state.context.discoveries.length - 1 ? validatedDiscovery : d
            ),
            sqlQueries: [...(state.context.sqlQueries || []), lastDiscovery.validationQuery],
            rowsReturned: [...(state.context.rowsReturned || []), validationResult.rowCount],
            durationsMs: [...(state.context.durationsMs || []), duration],
          },
          nextState: { mode: 'DISCOVERY', subState: 'SUGGEST' },
        };
      }
      
      case 'SUGGEST': {
        const lastDiscovery = state.context.discoveries[state.context.discoveries.length - 1];
        if (!lastDiscovery || !lastDiscovery.suggestedSemantic) {
          throw new Error('No semantic suggestion found in discovery');
        }
        
        console.log('\n💡 Creating semantic suggestion...');
        
        const suggestionData = lastDiscovery.suggestedSemantic;
        if (!suggestionData || !suggestionData.suggested_name || !suggestionData.suggested_type) {
          throw new Error('Invalid semantic suggestion data');
        }
        
        // Ensure all required fields are present
        const completeSuggestion: Omit<SemanticSuggestion, 'id' | 'created_at'> = {
          suggested_name: suggestionData.suggested_name,
          suggested_type: suggestionData.suggested_type,
          suggested_definition: suggestionData.suggested_definition || {},
          learned_from: suggestionData.learned_from || 'pattern_analysis',
          confidence: suggestionData.confidence || 0.70,
          status: suggestionData.status || 'pending',
          requires_expert_review: suggestionData.requires_expert_review !== undefined ? suggestionData.requires_expert_review : (suggestionData.confidence || 0.70) < 0.70,
        };
        
        const savedSuggestion = await insertSuggestion(completeSuggestion);
        
        if (!savedSuggestion) {
          throw new Error('Failed to save semantic suggestion');
        }
        
        console.log(`   ✓ Suggestion created: ${savedSuggestion.suggested_name}`);
        
        // Store saved suggestion in context for APPROVE step
        return {
          type: 'controlDb',
          success: true,
          data: { suggestion: savedSuggestion },
          contextUpdates: {
            ...state.context,
            savedSuggestion: savedSuggestion,
          } as any,
          nextState: { mode: 'DISCOVERY', subState: 'APPROVE' },
        };
      }
      
      case 'APPROVE': {
        // Get saved suggestion from SUGGEST step (stored in context)
        const savedSuggestion = (state.context as any).savedSuggestion as SemanticSuggestion | undefined;
        if (!savedSuggestion || !askQuestion) {
          throw new Error('No suggestion to approve or no askQuestion callback');
        }
        
        console.log('\n📋 Semantic Suggestion:');
        console.log(`   Name: ${savedSuggestion.suggested_name}`);
        console.log(`   Type: ${savedSuggestion.suggested_type}`);
        console.log(`   Description: ${savedSuggestion.suggested_definition?.description || 'N/A'}`);
        console.log(`   SQL Pattern: ${savedSuggestion.suggested_definition?.sqlPattern || 'N/A'}`);
        console.log(`   Confidence: ${(savedSuggestion.confidence * 100).toFixed(0)}%`);
        
        const approval = await askQuestion('\n   Approve this semantic? (y/n): ');
        const approved = approval.trim().toLowerCase() === 'y' || approval.trim().toLowerCase() === 'yes';
        
        if (!approved) {
          console.log('   ❌ Suggestion rejected.\n');
          return {
            type: 'controlDb',
            success: false,
            data: {},
            nextState: { mode: 'DISCOVERY', subState: null }, // Terminate discovery
          };
        }
        
        console.log('   ✓ Suggestion approved.\n');
        return {
          type: 'controlDb',
          success: true,
          data: { suggestion: savedSuggestion },
          nextState: { mode: 'DISCOVERY', subState: 'STORE' },
        };
      }
      
      case 'STORE': {
        // Get saved suggestion from context (set in SUGGEST, approved in APPROVE)
        const savedSuggestion = (state.context as any).savedSuggestion as SemanticSuggestion | undefined;
        if (!savedSuggestion) {
          throw new Error('No suggestion to store');
        }
        
        console.log('\n💾 Storing semantic...');
        
        // Approve the suggestion (which creates the semantic entity)
        await approveSuggestion(savedSuggestion, 'user');
        
        console.log('   ✓ Semantic stored successfully.\n');
        
        return {
          type: 'controlDb',
          success: true,
          data: {},
          nextState: { mode: 'DISCOVERY', subState: null }, // Terminate discovery
        };
      }
      
      default:
        throw new Error(`Unknown DISCOVERY sub-state: ${subState}`);
    }
  }
  
  /**
   * Call SEMANTIC_STORING mode tools
   */
  private async callSemanticStoringTool(
    _subState: SemanticStoringSubState,
    _state: OrchestratorState,
    _askQuestion?: (prompt: string) => Promise<string>
  ): Promise<ToolResult> {
    // Implementation will be added later
    throw new Error('SEMANTIC_STORING mode not yet implemented');
  }
  
  /**
   * Apply LLM decision to state
   */
  private applyDecision(
    state: OrchestratorState,
    decision: OrchestrationDecision
  ): OrchestratorState {
    const { nextMode, nextSubState } = decision;
    
    // Update the sub-state for the specified mode
    let newState = state;
    if (nextMode === 'QUERY') {
      newState = { ...newState, queryState: nextSubState as QuerySubState };
    } else if (nextMode === 'DISCOVERY') {
      newState = { ...newState, discoveryState: nextSubState as DiscoverySubState };
    } else if (nextMode === 'SEMANTIC_STORING') {
      newState = { ...newState, semanticStoringState: nextSubState as SemanticStoringSubState };
    }
    
    // If sub-state is null, the mode terminated
    if (nextSubState === null) {
      // If this was the active mode, set activeMode to null
      if (newState.activeMode === nextMode) {
        newState = { ...newState, activeMode: null };
      }
    } else {
      // Set active mode to the new mode
      newState = { ...newState, activeMode: nextMode };
    }
    
    return newState;
  }
  
  /**
   * Check if execution should continue
   */
  private shouldContinue(state: OrchestratorState): boolean {
    return !this.allModesTerminated(state);
  }
  
  /**
   * Format current state for display (debug mode)
   */
  private formatState(state: OrchestratorState): string {
    const states: string[] = [];
    
    if (state.activeMode) {
      states.push(`Active: ${state.activeMode}`);
    } else {
      states.push('Active: null (all modes terminated)');
    }
    
    if (state.queryState !== null) {
      states.push(`QUERY: ${state.queryState}`);
    } else {
      states.push('QUERY: null (terminated)');
    }
    
    if (state.discoveryState !== null) {
      states.push(`DISCOVERY: ${state.discoveryState}`);
    } else {
      states.push('DISCOVERY: null (terminated)');
    }
    
    if (state.semanticStoringState !== null) {
      states.push(`SEMANTIC_STORING: ${state.semanticStoringState}`);
    } else {
      states.push('SEMANTIC_STORING: null (terminated)');
    }
    
    // Add agent needs summary
    if (state.agentNeeds) {
      const needsSummary = this.summarizeNeeds(state.agentNeeds);
      if (needsSummary) {
        states.push(`Needs: ${needsSummary}`);
      }
    }
    
    // Add last decision
    if (state.lastDecision) {
      states.push(`Decision: ${state.lastDecision.nextMode}:${state.lastDecision.nextSubState} (${(state.lastDecision.confidence * 100).toFixed(0)}%)`);
    }
    
    const iteration = state.context.iterationCount || 0;
    const queries = state.context.sqlQueries?.length || 0;
    
    return `[State: ${states.join(' | ')} | Iteration: ${iteration} | Queries: ${queries}]`;
  }
  
  /**
   * Summarize agent needs concisely
   */
  private summarizeNeeds(agentNeeds: AgentNeeds): string {
    const parts: string[] = [];
    
    if (agentNeeds.planner) {
      const p = agentNeeds.planner;
      if (p.needsClarification) parts.push('Planner:clarification');
      if (p.needsDiscovery) parts.push(`Planner:discovery(${p.needsDiscovery.target})`);
      if (p.blockingIssues && p.blockingIssues.length > 0) parts.push('Planner:blocked');
    }
    
    if (agentNeeds.sqlWriter) {
      const s = agentNeeds.sqlWriter;
      if (s.blockedBy) parts.push('SQLWriter:blocked');
      if (s.needsOptimization) parts.push('SQLWriter:optimize');
    }
    
    if (agentNeeds.interpreter) {
      const i = agentNeeds.interpreter;
      if (i.needsRefinement) parts.push('Interpreter:refine');
      if (i.needsMoreData && i.needsMoreData.length > 0) parts.push('Interpreter:moreData');
    }
    
    if (agentNeeds.guard) {
      const g = agentNeeds.guard;
      if (g.validationIssues && g.validationIssues.length > 0) parts.push('Guard:issues');
      if (!g.isSafe) parts.push('Guard:unsafe');
    }
    
    if (agentNeeds.discovery) {
      const d = agentNeeds.discovery;
      if (d.canHelp) parts.push('Discovery:ready');
    }
    
    return parts.length > 0 ? parts.join(', ') : '';
  }
  
  /**
   * Check if guards pass
   */
  private passesGuards(state: OrchestratorState, _result: ToolResult): boolean {
    // Guard checks: iteration limits, time limits, loop detection, resource limits
    const iterationCount = state.context.iterationCount || 0;
    const maxIterations = 50; // Safety limit
    
    if (iterationCount >= maxIterations) {
      console.log('⚠️  Max iterations reached');
      return false;
    }
    
    const startTime = state.context.startTime || Date.now();
    const maxDurationMs = 60000; // 60 seconds
    
    if (Date.now() - startTime > maxDurationMs) {
      console.log('⚠️  Time limit reached');
      return false;
    }
    
    const queriesExecuted = state.context.sqlQueries?.length || 0;
    const maxQueries = 20;
    
    if (queriesExecuted >= maxQueries) {
      console.log('⚠️  Max queries reached');
      return false;
    }
    
    return true;
  }
  
  // ============================================================================
  // LLM Decision Maker Methods
  // ============================================================================
  
  /**
   * Use LLM to decide next action based on current state and agent needs
   */
  private async decideNextAction(
    state: OrchestratorState
  ): Promise<OrchestrationDecision> {
    const agentNeeds = state.agentNeeds || {};
    const currentMode = state.activeMode;
    const currentSubState = this.getActiveSubState(state);
    
    // Build comprehensive prompt
    const prompt = this.buildDecisionPrompt(state, agentNeeds, currentMode, currentSubState);
    
    // Call LLM
    const decision = await this.llmGenerateDecision(prompt);
    
    // Validate and return
    return this.validateDecision(decision, state);
  }
  
  /**
   * Build comprehensive prompt for LLM decision making
   */
  private buildDecisionPrompt(
    state: OrchestratorState,
    agentNeeds: AgentNeeds,
    currentMode: Mode | null,
    currentSubState: SubState | null
  ): string {
    const agentNeedsText = this.formatAgentNeeds(agentNeeds);
    
    return `You are an intelligent orchestrator for a SQL query assistant system.

CURRENT STATE:
- Active Mode: ${currentMode || 'null'}
- Current Sub-State: ${currentSubState || 'null'}
- Query State: ${state.queryState || 'null'}
- Discovery State: ${state.discoveryState || 'null'}
- Semantic Storing State: ${state.semanticStoringState || 'null'}

AGENT NEEDS:
${agentNeedsText}

CONTEXT:
- Question: ${state.context.question || 'N/A'}
- Plan Goal: ${state.context.plan?.overallGoal || 'N/A'}
- Executed Steps: ${state.context.executedSteps.length}
- Iteration: ${state.context.iterationCount || 0}
- Queries Executed: ${state.context.sqlQueries?.length || 0}

DECISION GUIDELINES:
1. If Planner needs discovery, consider switching to DISCOVERY mode
2. If SQLWriter is blocked, identify what unblocks it
3. If Interpreter needs refinement, decide whether to re-plan or continue
4. Prioritize answering user question efficiently
5. Respect mode priorities: QUERY > DISCOVERY > SEMANTIC_STORING
6. Only transition to null sub-state when mode is truly complete
7. If current mode is QUERY and sub-state is CLARIFICATION, stay in CLARIFICATION (requires user input)
8. If current mode is QUERY and sub-state is ANSWER, transition to null (query complete)

VALID MODE/SUB-STATE COMBINATIONS:
- QUERY: PLAN, CLARIFICATION, EXECUTE, INTERPRET, ANSWER, null
- DISCOVERY: GET_DATA, ANALYZE, VALIDATE, SUGGEST, APPROVE, STORE, null
- SEMANTIC_STORING: VALIDATE, APPROVE, STORE, null

Respond with ONLY a JSON object in this exact format:
{
  "nextMode": "QUERY" | "DISCOVERY" | "SEMANTIC_STORING",
  "nextSubState": "..." | null,
  "reasoning": "Why this decision",
  "confidence": 0.0-1.0,
  "alternativeOptions": [
    {
      "mode": "...",
      "subState": "..." | null,
      "reasoning": "...",
      "confidence": 0.0-1.0
    }
  ]
}`;
  }
  
  /**
   * Format agent needs for LLM prompt
   */
  private formatAgentNeeds(agentNeeds: AgentNeeds): string {
    const parts: string[] = [];
    
    if (agentNeeds.planner) {
      const p = agentNeeds.planner;
      parts.push(`PLANNER:
- Needs Clarification: ${p.needsClarification || false}
- Needs Discovery: ${p.needsDiscovery ? `${p.needsDiscovery.reason} (target: ${p.needsDiscovery.target}, confidence: ${p.needsDiscovery.confidence})` : 'No'}
- Needs More Context: ${p.needsMoreContext?.join(', ') || 'None'}
- Confidence: ${p.confidence}
- Can Proceed: ${p.canProceed || false}
- Blocking Issues: ${p.blockingIssues?.join(', ') || 'None'}`);
    }
    
    if (agentNeeds.sqlWriter) {
      const s = agentNeeds.sqlWriter;
      parts.push(`SQL WRITER:
- Needs Validation: ${s.needsValidation || false}
- Needs Optimization: ${s.needsOptimization ? `${s.needsOptimization.reason}` : 'No'}
- Blocked By: ${s.blockedBy || 'Nothing'}
- Confidence: ${s.confidence}
- Can Generate: ${s.canGenerate || false}`);
    }
    
    if (agentNeeds.interpreter) {
      const i = agentNeeds.interpreter;
      parts.push(`INTERPRETER:
- Needs Refinement: ${i.needsRefinement ? `${i.needsRefinement.reason} (suggested: ${i.needsRefinement.suggestedNextStep || 'N/A'})` : 'No'}
- Needs More Data: ${i.needsMoreData?.join(', ') || 'None'}
- Confidence: ${i.confidence}
- Is Complete: ${i.isComplete || false}`);
    }
    
    if (agentNeeds.guard) {
      const g = agentNeeds.guard;
      parts.push(`GUARD:
- Validation Issues: ${g.validationIssues?.join(', ') || 'None'}
- Safety Concerns: ${g.safetyConcerns?.join(', ') || 'None'}
- Confidence: ${g.confidence}
- Is Safe: ${g.isSafe || false}`);
    }
    
    if (agentNeeds.discovery) {
      const d = agentNeeds.discovery;
      parts.push(`DISCOVERY:
- Can Help: ${d.canHelp || false}
- Suggested Target: ${d.suggestedTarget || 'None'}
- Ready To Explore: ${d.readyToExplore || false}
- Confidence: ${d.confidence}`);
    }
    
    return parts.length > 0 ? parts.join('\n\n') : 'No agent needs expressed.';
  }
  
  /**
   * Get valid sub-states for a given mode
   */
  private getValidSubStates(mode: Mode): SubState[] {
    switch (mode) {
      case 'QUERY':
        return ['PLAN', 'CLARIFICATION', 'EXECUTE', 'INTERPRET', 'ANSWER', null];
      case 'DISCOVERY':
        return ['GET_DATA', 'ANALYZE', 'VALIDATE', 'SUGGEST', 'APPROVE', 'STORE', null];
      case 'SEMANTIC_STORING':
        return ['VALIDATE', 'APPROVE', 'STORE', null];
      default:
        return [];
    }
  }
  
  /**
   * Validate LLM decision output
   */
  private validateDecision(
    decision: any,
    state: OrchestratorState
  ): OrchestrationDecision {
    // Validate mode is valid
    if (!['QUERY', 'DISCOVERY', 'SEMANTIC_STORING'].includes(decision.nextMode)) {
      throw new Error(`Invalid mode: ${decision.nextMode}`);
    }
    
    // Validate sub-state matches mode
    const validSubStates = this.getValidSubStates(decision.nextMode);
    if (!validSubStates.includes(decision.nextSubState)) {
      throw new Error(`Invalid sub-state ${decision.nextSubState} for mode ${decision.nextMode}`);
    }
    
    // Apply guard constraints (iteration limits, etc.)
    if (!this.passesGuards(state, { success: true, type: 'planner', data: { plan: { status: 'READY', steps: [], overallGoal: '' }, needsClarification: false } })) {
      // Override decision to terminate
      return {
        nextMode: state.activeMode || 'QUERY',
        nextSubState: null,
        reasoning: 'Guard constraints reached (iteration/time/query limits)',
        confidence: 1.0,
      };
    }
    
    // Ensure confidence is in valid range
    if (decision.confidence < 0 || decision.confidence > 1) {
      decision.confidence = Math.max(0, Math.min(1, decision.confidence));
    }
    
    return decision as OrchestrationDecision;
  }
  
  /**
   * Generate decision using LLM
   */
  private async llmGenerateDecision(prompt: string): Promise<OrchestrationDecision> {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: config.geminiModel });
    
    const result = await retryWithBackoff(
      async () => {
        const response = await model.generateContent(prompt);
        const text = response.response.text();
        
        // Extract JSON from response (may have markdown code blocks)
        let jsonText = text.trim();
        if (jsonText.startsWith('```')) {
          // Remove markdown code block markers
          jsonText = jsonText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
        }
        
        return JSON.parse(jsonText);
      },
      config.retry
    );
    
    return result as OrchestrationDecision;
  }
  
  /**
   * Execute discovery mode
   */
  async executeDiscovery(
    question: string,
    context?: ExecutionContext,
    askQuestion?: (prompt: string) => Promise<string>
  ): Promise<DiscoveryResult> {
    // Runtime assertion: ensure question is valid
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('Invalid question: must be a non-empty string');
    }
    
    console.log(`\n🔍 Discovery Mode: ${question}\n`);
    
    // Initialize state machine for DISCOVERY mode
    const initialState = this.initializeState('DISCOVERY', question, {
      question,
      executedSteps: [],
      previousResults: [],
      discoveries: [],
      schema: undefined, // Will be loaded in first tool call
      sqlQueries: [],
      rowsReturned: [],
      durationsMs: [],
      startTime: Date.now(),
      iterationCount: 0,
      refinementCount: 0,
      previousPlans: [],
      ...context,
    });
    
    let state = initialState;
    
    // State machine loop
    while (this.shouldContinue(state)) {
      // Increment iteration count
      state = this.updateState(state, {
        context: {
          ...state.context,
          iterationCount: (state.context.iterationCount || 0) + 1,
        },
      });
      
      // Show state if debug mode is ON (indicated by askQuestion being provided)
      if (askQuestion) {
        console.log(`   🔍 ${this.formatState(state)}`);
      }
      
      // Check guards
      if (!this.passesGuards(state, { success: true, type: 'semanticLearner', data: {} })) {
        break;
      }
      
      // If activeMode is null, find next mode to activate
      if (state.activeMode === null) {
        const nextMode = this.findNextActiveMode(state);
        if (nextMode === null) {
          break; // All modes terminated
        }
        state = { ...state, activeMode: nextMode };
        if (askQuestion) {
          console.log(`   🔄 Mode activated: ${nextMode}`);
        }
      }
      
      const activeSubState = this.getActiveSubState(state);
      if (activeSubState === null) {
        // Current mode terminated, set activeMode to null and check others
        state = { ...state, activeMode: null };
        if (askQuestion) {
          console.log(`   ✓ Mode terminated`);
        }
        continue;
      }
      
      // Call tool (agents update state.agentNeeds)
      const toolId = `${state.activeMode}:${activeSubState}`;
      const toolResult = await this.callTool(toolId, state, undefined, askQuestion);
      
      // Apply tool result context updates
      if (toolResult.contextUpdates) {
        state = this.updateState(state, { 
          context: {
            ...state.context,
            ...toolResult.contextUpdates,
          }
        });
      }
      
      // LLM decides next action based on agent needs
      const decision = await this.selectNextAction(state);
      
      // Apply decision
      const previousState = { ...state };
      state = this.applyDecision(state, decision);
      
      // Show state transition if debug mode is ON
      if (askQuestion) {
        const stateChanged = 
          previousState.activeMode !== state.activeMode ||
          previousState.queryState !== state.queryState ||
          previousState.discoveryState !== state.discoveryState ||
          previousState.semanticStoringState !== state.semanticStoringState;
        
        if (stateChanged) {
          console.log(`   ➡️  State transition: ${this.formatState(state)}`);
          console.log(`   🧠 Decision: ${decision.reasoning} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`);
        }
      }
      
      // If discovery terminated, break
      if (state.discoveryState === null) {
        break;
      }
    }
    
    // Extract discoveries and suggestions
    const discoveries = state.context.discoveries;
    const suggestions: SemanticSuggestion[] = discoveries
      .filter(d => d.suggestedSemantic)
      .map(d => d.suggestedSemantic!)
      .filter((s): s is SemanticSuggestion => s !== undefined);
    
    return {
      discoveries,
      suggestions,
      completed: state.discoveryState === null,
      logs: {
        queries: state.context.sqlQueries?.length || 0,
        totalRows: state.context.rowsReturned?.reduce((a, b) => a + b, 0) || 0,
        totalDuration: state.context.durationsMs?.reduce((a, b) => a + b, 0) || 0,
      },
    };
  }
  
  // ============================================================================
  // Legacy Execute Method (Backward Compatibility)
  // ============================================================================
  
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
    
    // Initialize state machine for QUERY mode
    const initialState = this.initializeState('QUERY', question, {
      question,
      executedSteps: [],
      previousResults: [],
      discoveries: [],
      schema: undefined, // Will be loaded in first tool call
      conversationHistory,
      detectedSemanticIds,
      sqlQueries: [],
      rowsReturned: [],
      durationsMs: [],
      startTime: Date.now(),
      iterationCount: 0,
      refinementCount: 0,
      previousPlans: [],
    });
    
    let state = initialState;
    let finalAnswer: string | null = null;
    let cancelled = false;
    
    // State machine loop
    while (this.shouldContinue(state)) {
      // Increment iteration count
      state = this.updateState(state, {
        context: {
          ...state.context,
          iterationCount: (state.context.iterationCount || 0) + 1,
        },
      });
      
      // Show state if debug mode is ON (indicated by requestPermission being provided)
      if (requestPermission) {
        console.log(`   🔍 ${this.formatState(state)}`);
      }
      
      // Check guards
      if (!this.passesGuards(state, { success: true, type: 'planner', data: { plan: state.context.plan || { status: 'READY', steps: [], overallGoal: '' }, needsClarification: false } })) {
        break;
      }
      
      // If activeMode is null, find next mode to activate
      if (state.activeMode === null) {
        const nextMode = this.findNextActiveMode(state);
        if (nextMode === null) {
          break; // All modes terminated
        }
        state = { ...state, activeMode: nextMode };
        if (requestPermission) {
          console.log(`   🔄 Mode activated: ${nextMode}`);
        }
      }
      
      const activeSubState = this.getActiveSubState(state);
      if (activeSubState === null) {
        // Current mode terminated, set activeMode to null and check others
        state = { ...state, activeMode: null };
        if (requestPermission) {
          console.log(`   ✓ Mode terminated`);
        }
        continue;
      }
      
      // Handle CLARIFICATION sub-state specially (requires user interaction)
      if (state.activeMode === 'QUERY' && activeSubState === 'CLARIFICATION') {
        const plan = state.context.plan!;
        if (!askQuestion) {
          throw new Error('Clarification needed but no askQuestion callback provided. Cannot proceed without user input.');
        }
        
        const clarificationRound = (state.context.refinementCount || 0) + 1;
        const maxClarifications = 3;
        
        if (clarificationRound > maxClarifications) {
          console.log(`\n⚠️  Maximum clarification rounds (${maxClarifications}) reached. Proceeding with best-effort plan.\n`);
          state = this.updateState(state, {
            context: {
              ...state.context,
              plan: {
                status: 'READY',
                overallGoal: state.context.question || '',
                steps: [{
                  stepNumber: 1,
                  description: 'Query the database to answer the question with available information',
                  reasoning: 'Proceeding with best-effort plan after clarification limit reached',
                }],
              },
            },
          });
          state = { ...state, queryState: 'EXECUTE' };
          continue;
        }
        
        console.log(`\n🤔 Clarification needed (round ${clarificationRound}/${maxClarifications}):`);
        console.log(`   ${plan.clarificationContext || 'The question needs clarification.'}\n`);
        
        const clarificationAnswers: string[] = [];
        for (let i = 0; i < plan.clarificationQuestions!.length; i++) {
          const clarificationQuestion = plan.clarificationQuestions![i];
          const answer = await askQuestion(`   ${i + 1}. ${clarificationQuestion}\n   Your answer: `);
          clarificationAnswers.push(answer.trim());
        }
        
        const clarifiedParts: string[] = [state.context.question || ''];
        for (let i = 0; i < clarificationAnswers.length; i++) {
          clarifiedParts.push(`(${plan.clarificationQuestions![i]} → ${clarificationAnswers[i]})`);
        }
        const clarifiedQuestion = clarifiedParts.join(' ');
        
        console.log(`\n✓ Clarified question: ${clarifiedQuestion}\n`);
        console.log('📋 Re-planning with clarification...');
        
        // Update question and re-plan
        state = this.updateState(state, {
          context: {
            ...state.context,
            question: clarifiedQuestion,
            refinementCount: clarificationRound,
          },
        });
        state = { ...state, queryState: 'PLAN' };
        continue;
      }
      
      // Call tool (agents update state.agentNeeds)
      const toolId = `${state.activeMode}:${activeSubState}`;
      const toolResult = await this.callTool(toolId, state, requestPermission, askQuestion);
      
      // Handle cancellation (before LLM decision)
      if (!toolResult.success && state.activeMode === 'QUERY' && activeSubState === 'EXECUTE') {
        cancelled = true;
        break;
      }
      
      // Apply tool result context updates
      if (toolResult.contextUpdates) {
        state = this.updateState(state, { 
          context: {
            ...state.context,
            ...toolResult.contextUpdates,
          }
        });
      }
      
      // Handle "all" request with LIMIT removal (special case - before LLM decision)
      if (state.activeMode === 'QUERY' && activeSubState === 'EXECUTE' && toolResult.type === 'sqlExecution' && askQuestion) {
        const askedForAll = /\b(all|every|entire|complete)\b/i.test(state.context.question || '');
        const result = toolResult.data.result;
        const sql = toolResult.data.sql;
        const hitLimit = result.rowCount === config.maxRows && sql.includes('LIMIT');
        
        if (askedForAll && hitLimit) {
          console.log(`\n⚠️  Query returned exactly ${config.maxRows} rows (LIMIT reached).`);
          console.log(`   You asked for "all" - there may be more rows.`);
          const removeLimit = await askQuestion('   Remove LIMIT to get all rows? (y/n): ');
          
          if (removeLimit.trim().toLowerCase() === 'y' || removeLimit.trim().toLowerCase() === 'yes') {
            const sqlWithoutLimit = sql.replace(/\s+LIMIT\s+\d+/i, '');
            console.log('   Re-executing without LIMIT...');
            
            const startTime2 = Date.now();
            const result2 = await runSQL(sqlWithoutLimit);
            const duration2 = Date.now() - startTime2;
            
            console.log(`   ✓ Query executed: ${result2.rowCount} rows in ${duration2}ms`);
            
            if (result2.rowCount > 10000) {
              console.log(`\n⚠️  Warning: Query returned ${result2.rowCount} rows. This is a large result set.`);
            }
            
            // Update state with full result
            const lastStep = state.context.executedSteps[state.context.executedSteps.length - 1];
            state = this.updateState(state, {
              context: {
                ...state.context,
                sqlQueries: state.context.sqlQueries?.map((q, i) => i === state.context.sqlQueries!.length - 1 ? sqlWithoutLimit : q) || [sqlWithoutLimit],
                rowsReturned: state.context.rowsReturned?.map((r, i) => i === state.context.rowsReturned!.length - 1 ? result2.rowCount : r) || [result2.rowCount],
                durationsMs: state.context.durationsMs?.map((d, i) => i === state.context.durationsMs!.length - 1 ? duration2 : d) || [duration2],
                previousResults: state.context.previousResults.map((pr, i) => 
                  i === state.context.previousResults.length - 1 
                    ? { step: lastStep?.stepNumber || 1, result: result2 }
                    : pr
                ),
              },
            });
            
            // Continue to INTERPRET with full result (skip LLM decision for this special case)
            state = { ...state, queryState: 'INTERPRET' };
            continue;
          }
        }
      }
      
      // LLM decides next action based on agent needs
      const decision = await this.selectNextAction(state);
      
      // Apply decision
      const previousState = { ...state };
      state = this.applyDecision(state, decision);
      
      // Show state transition if debug mode is ON
      if (requestPermission) {
        const stateChanged = 
          previousState.activeMode !== state.activeMode ||
          previousState.queryState !== state.queryState ||
          previousState.discoveryState !== state.discoveryState ||
          previousState.semanticStoringState !== state.semanticStoringState;
        
        if (stateChanged) {
          console.log(`   ➡️  State transition: ${this.formatState(state)}`);
          console.log(`   🧠 Decision: ${decision.reasoning} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`);
        }
      }
      
      // Handle ANSWER state (terminal)
      if (state.queryState === 'ANSWER') {
        const lastInterpretation = state.context.previousResults.length > 0 
          ? await this.interpreter.interpret(
              state.context.question || '',
              state.context.executedSteps[state.context.executedSteps.length - 1],
              state.context.previousResults[state.context.previousResults.length - 1].result,
              state.context.plan?.steps || [],
              state.context.executedSteps.map(s => s.stepNumber)
            )
          : null;
        
        if (lastInterpretation && lastInterpretation.status === 'FINAL_ANSWER') {
          finalAnswer = lastInterpretation.answer || 'Answer generated from query results.';
        } else {
          // Generate answer from results
          if (state.context.previousResults.length > 0) {
            const lastResult = state.context.previousResults[state.context.previousResults.length - 1].result;
            const limitedRows = lastResult.rows.slice(0, 10);
            finalAnswer = `Query completed. Returned ${lastResult.rowCount} rows. Sample results:\n${JSON.stringify(limitedRows, null, 2)}`;
          } else {
            finalAnswer = 'No results returned from queries.';
          }
        }
        
        state = { ...state, queryState: null, activeMode: null };
        break;
      }
    }
    
    // Generate final answer if not set
    if (!finalAnswer) {
      if (state.context.previousResults.length > 0) {
        const lastResult = state.context.previousResults[state.context.previousResults.length - 1].result;
        const limitedRows = lastResult.rows.slice(0, 10);
        finalAnswer = `Query completed. Returned ${lastResult.rowCount} rows. Sample results:\n${JSON.stringify(limitedRows, null, 2)}`;
      } else {
        finalAnswer = 'No results returned from queries.';
      }
    }
    
    // Save run log
    let runLogId: string | undefined;
    try {
      const runLog = await saveRunLog(
        state.context.question || question,
        state.context.sqlQueries || [],
        state.context.rowsReturned || [],
        state.context.durationsMs || [],
        state.context.detectedSemanticIds || []
      );
      if (runLog) {
        runLogId = runLog.id;
      }
    } catch (error) {
      // Silently ignore - control DB is optional
    }
    
    return {
      answer: finalAnswer,
      logs: {
        steps: state.context.executedSteps.length,
        queries: state.context.sqlQueries?.length || 0,
        totalRows: state.context.rowsReturned?.reduce((a, b) => a + b, 0) || 0,
        totalDuration: state.context.durationsMs?.reduce((a, b) => a + b, 0) || 0,
        runLogId,
      },
      cancelled,
      runLogId,
      sqlQueries: state.context.sqlQueries,
    };
  }
}
