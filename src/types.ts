export type GrainLevel = 
  | 'row_level'
  | 'customer_level' 
  | 'order_level'
  | 'daily'
  | 'monthly'
  | 'custom';

export interface SQLValidationResult {
  valid: boolean;
  issues: string[];
  confidence: number; // 0.0-1.0
  facts: string[]; // Verified metadata facts
  assumptions: string[]; // Explicit assumptions
  unknowns: string[]; // Blocking vs non-blocking
  grain?: GrainLevel;
  performanceRisk: 'low' | 'medium' | 'high';
  tablesValidated: boolean;
  columnsValidated: boolean;
  joinsValidated: boolean;
}

export interface PlanStep {
  stepNumber: number;
  description: string;
  sqlQuery?: string;
  reasoning: string;
  grain?: GrainLevel;
  validationResult?: SQLValidationResult;
}

export type PlanStatus = 'READY' | 'CLARIFICATION_NEEDED';

export interface Plan {
  status: PlanStatus;
  steps: PlanStep[];
  overallGoal: string;
  clarificationQuestions?: string[];
  clarificationContext?: string;
}

export interface ClarificationResponse {
  questionIndex: number;
  answer: string;
}

export interface SQLResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  durationMs: number;
}

export interface Interpretation {
  status: 'FINAL_ANSWER' | 'NEEDS_REFINEMENT';
  answer?: string;
  nextStep?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface RunLog {
  id: string;
  question: string;
  sql: string[];
  rowsReturned: number[];
  durationsMs: number[];
  detectedSemantics?: string[]; // IDs of semantic entities detected in the question
  createdAt: Date;
}

export type DebugMode = 'on' | 'off' | 'smart';

/**
 * Converts string confidence level to numeric percentage.
 * Used for SMART mode threshold checking.
 */
export function confidenceToPercentage(level: 'high' | 'medium' | 'low'): number {
  const mapping: Record<string, number> = {
    high: 95,
    medium: 70,
    low: 40,
  };
  return mapping[level] || 50;
}

/**
 * Checks if confidence level meets the required threshold.
 */
export function meetsConfidenceThreshold(
  level: 'high' | 'medium' | 'low', 
  threshold: number
): boolean {
  return confidenceToPercentage(level) >= threshold;
}

export interface Semantic {
  id: string;
  category: string;
  term: string;
  description: string;
  tableName?: string;
  columnName?: string;
  createdAt: Date;
  // Rich metadata fields for learned semantics
  sqlFragment?: string;           // The SQL pattern to use
  synonyms?: string[];             // Alternative terms
  antiPatterns?: {                 // Common mistakes
    wrong: string;
    why: string;
    correct?: string;
  };
  exampleQuestions?: string[];     // Example uses
  notes?: string[];                // Additional context
  aggregation?: string;            // For metrics: COUNT, SUM, AVG, etc.
}

export interface SemanticEntity {
  id: string;
  entityType: string;
  name: string;
  description: string;
  tableName?: string;
  columnName?: string;
  sqlPattern?: string;
  exampleValues?: string;
  parentId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TableSchema {
  tableName: string;
  columns: ColumnSchema[];
  metadata?: TableMetadata; // Optional - loaded separately
}

export interface ColumnSchema {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault?: string;
}

export interface Config {
  geminiApiKey: string;
  databaseUrl: string;
  controlDbUrl?: string;
  maxRows: number;
  statementTimeoutMs: number;
  maxResultRowsForLLM: number;
  geminiModel: string;
  debugModeConfidenceThreshold: number; // 0-100
  retry: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
  };
}

/**
 * Database constraint types - these MUST match database CHECK constraints
 */

// Entity types as they exist in the database (lowercase with underscores)
export type EntityTypeDB = 'entity' | 'metric' | 'rule' | 'time_period' | 'anti_pattern';

// Entity types as LLM returns them (uppercase with underscores)
export type EntityTypeLLM = 'TIME_PERIOD' | 'METRIC' | 'DIMENSION' | 'BUSINESS_RULE' | 'FIELD_DEFINITION' | 'ANTI_PATTERN';

// Suggestion status types (database constraint)
export type SuggestionStatusDB = 'pending' | 'approved' | 'rejected' | 'needs_review';

// Aggregation types (database constraint)
export type AggregationDB = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'NONE' | null;

// Source of semantic (database constraint)
export type SourceDB = 'manual' | 'learned' | 'imported' | 'system';

/**
 * Source of semantic learning.
 * Must match database CHECK constraint on semantic_suggestions.learned_from
 */
export type LearnedFromSource = 
  | 'user_correction'      // Learned from user correcting a query result
  | 'pattern_analysis'     // Learned from analyzing query patterns
  | 'frequency_analysis'   // Learned from frequency of similar queries
  | 'explicit_teaching';   // Manually taught by user/admin

/**
 * Mapping from LLM semantic types to database entity types
 */
export const LLM_TO_DB_ENTITY_TYPE: Record<EntityTypeLLM, EntityTypeDB> = {
  'TIME_PERIOD': 'time_period',
  'METRIC': 'metric',
  'DIMENSION': 'entity',
  'BUSINESS_RULE': 'rule',
  'FIELD_DEFINITION': 'entity',
  'ANTI_PATTERN': 'anti_pattern',
};

/**
 * Maps LLM semantic type to database entity type
 */
export function mapToDBEntityType(llmType: string): EntityTypeDB {
  const mapped = LLM_TO_DB_ENTITY_TYPE[llmType as EntityTypeLLM];
  if (!mapped) {
    console.warn(`Unknown LLM entity type: ${llmType}, defaulting to 'entity'`);
    return 'entity';
  }
  return mapped;
}

/**
 * Correction capture from user feedback
 * Used in Phase 3: Learning from User Corrections
 */
export interface CorrectionCapture {
  run_log_id?: string;
  correction_stage: 'pre_execution' | 'post_execution';
  original_question: string;
  original_sql: string;
  user_feedback: string;
  correction_type: 'wrong_sql' | 'wrong_result' | 'wrong_interpretation';
  corrected_sql?: string;
  expected_result?: string;
}

/**
 * Semantic suggestion generated from correction analysis
 * Stored in semantic_suggestions table awaiting approval
 */
export interface SemanticSuggestion {
  id: string;
  suggested_name: string;
  suggested_type: string;
  suggested_definition: Partial<SemanticEntity>; // Full entity definition as JSONB
  learned_from: LearnedFromSource;
  source_run_log_id?: string;
  learning_dialogue?: {
    original_question: string;
    generated_sql: string;
    user_correction: string;
    correction_type: string;
    [key: string]: any;
  };
  confidence: number; // 0.0 to 1.0
  evidence?: {
    correction_count?: number;
    user_was_explicit?: boolean;
    provided_example?: boolean;
    reasoning?: string;
    [key: string]: any;
  };
  status: SuggestionStatusDB;
  requires_expert_review: boolean;
  reviewed_by?: string;
  review_notes?: string;
  reviewed_at?: Date;
  created_at: Date;
}

/**
 * Additional data for semantic entity creation
 */
export interface SemanticAdditionalData {
  synonyms?: string[];
  sqlFragment?: string;
  antiPatterns?: any;
  exampleQuestions?: string[];
  notes?: string[];
  aggregation?: AggregationDB;
  approvedBy?: string;
}

/**
 * Metadata about database indexes for query optimization
 */
export interface IndexMetadata {
  indexName: string;
  columns: string[];
  isUnique: boolean;
  indexType: string;  // btree, hash, gin, etc.
  isPrimary: boolean;
  definition?: string; // Full CREATE INDEX statement
}

/**
 * Metadata about foreign key relationships
 */
export interface ForeignKeyMetadata {
  constraintName: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete?: string;  // RESTRICT, CASCADE, SET NULL, etc.
  onUpdate?: string;
}

/**
 * Comprehensive metadata about a table in the inspected database
 * Stored in control database for query optimization
 */
export interface TableMetadata {
  id?: string;
  tableName: string;
  schemaName: string;
  estimatedRowCount: number; // From pg_stat_user_tables.n_live_tup (accurate)
  totalSizeBytes: number; // pg_total_relation_size() = table + indexes
  tableSizeBytes: number; // Deprecated - kept for backward compatibility (set to 0)
  indexSizeBytes: number; // Deprecated - kept for backward compatibility (set to 0)
  primaryKeyColumns: string[];
  indexes: IndexMetadata[];
  foreignKeys: ForeignKeyMetadata[];
  lastAnalyzed: Date;
  lastUpdated: Date;
}

/**
 * Conversation history turn - tracks Q&A pairs for context awareness
 * Used for follow-up question understanding
 */
export interface ConversationTurn {
  question: string;
  answer: string;
  sqlQueries: string[];
  resultColumns?: string[]; // Columns from last result
  resultTable?: string;     // Main table from last query
  timestamp: Date;
}

// ============================================================================
// State Machine Types for Mode-Based Orchestrator
// ============================================================================

/**
 * Top-level MODE types for orchestrator state machine
 */
export type Mode = 'QUERY' | 'DISCOVERY' | 'SEMANTIC_STORING';

/**
 * Sub-states for QUERY mode (null = terminated/done, no further action)
 */
export type QuerySubState = 'PLAN' | 'CLARIFICATION' | 'EXECUTE' | 'INTERPRET' | 'ANSWER' | null;

/**
 * Sub-states for DISCOVERY mode (null = terminated/done, no further action)
 */
export type DiscoverySubState = 'GET_DATA' | 'ANALYZE' | 'VALIDATE' | 'SUGGEST' | 'APPROVE' | 'STORE' | null;

/**
 * Sub-states for SEMANTIC_STORING mode (null = terminated/done, no further action)
 */
export type SemanticStoringSubState = 'VALIDATE' | 'APPROVE' | 'STORE' | null;

/**
 * Union type for all sub-states
 */
export type SubState = QuerySubState | DiscoverySubState | SemanticStoringSubState;

/**
 * Discovery result from pattern analysis
 */
export interface Discovery {
  pattern: string;                    // Detected pattern description
  confidence: number;                 // Confidence score (0.0-1.0)
  suggestedSemantic?: Partial<SemanticSuggestion>; // Partial semantic suggestion
  validationQuery?: string;           // SQL query to validate the pattern
  tableName?: string;                 // Table where pattern was found
  columnName?: string;                // Column where pattern was found
  evidence?: {
    sampleData?: any[];               // Sample data supporting the pattern
    statistics?: Record<string, any>; // Statistical evidence
    reasoning?: string;                // Why this pattern was detected
  };
}

/**
 * Execution context shared across all modes
 */
export interface ExecutionContext {
  question?: string;
  plan?: Plan;
  executedSteps: PlanStep[];
  previousResults: Array<{ step: number; result: SQLResult }>;
  discoveries: Discovery[];
  schema?: TableSchema[];
  conversationHistory?: ConversationTurn[];
  detectedSemanticIds?: string[];     // IDs of semantic entities detected
  sqlQueries?: string[];              // All SQL queries executed
  rowsReturned?: number[];            // Row counts for each query
  durationsMs?: number[];            // Execution durations
  startTime?: number;                 // Execution start timestamp
  iterationCount?: number;            // Current iteration count
  refinementCount?: number;           // Number of plan refinements
  previousPlans?: string[];          // Plan signatures for loop detection
}

// ============================================================================
// Agent Needs Types (for LLM-interpreted orchestration)
// ============================================================================

/**
 * Planner agent needs/intentions
 */
export interface PlannerNeeds {
  needsClarification?: boolean;
  needsDiscovery?: {
    reason: string;
    target: string; // table or column
    confidence: number;
  };
  needsMoreContext?: string[]; // List of missing context items
  confidence: number; // 0.0-1.0
  canProceed?: boolean;
  blockingIssues?: string[];
}

/**
 * SQL Writer agent needs/intentions
 */
export interface SQLWriterNeeds {
  needsValidation?: boolean;
  needsOptimization?: {
    reason: string;
    suggestedApproach?: string;
  };
  blockedBy?: string; // What's preventing SQL generation
  confidence: number;
  canGenerate?: boolean;
}

/**
 * Interpreter agent needs/intentions
 */
export interface InterpreterNeeds {
  needsRefinement?: {
    reason: string;
    suggestedNextStep?: string;
  };
  needsMoreData?: string[]; // What additional data is needed
  confidence: number;
  isComplete?: boolean;
}

/**
 * Guard agent needs/intentions
 */
export interface GuardNeeds {
  validationIssues?: string[];
  safetyConcerns?: string[];
  confidence: number;
  isSafe?: boolean;
}

/**
 * Discovery agent needs/intentions
 */
export interface DiscoveryNeeds {
  canHelp?: boolean;
  suggestedTarget?: string;
  readyToExplore?: boolean;
  confidence: number;
}

/**
 * Collection of all agent needs
 */
export interface AgentNeeds {
  planner?: PlannerNeeds;
  sqlWriter?: SQLWriterNeeds;
  interpreter?: InterpreterNeeds;
  guard?: GuardNeeds;
  discovery?: DiscoveryNeeds;
}

/**
 * LLM decision result for orchestration
 */
export interface OrchestrationDecision {
  nextMode: Mode;
  nextSubState: SubState;
  reasoning: string;
  confidence: number; // 0.0-1.0
  alternativeOptions?: Array<{
    mode: Mode;
    subState: SubState;
    reasoning: string;
    confidence: number;
  }>;
}

/**
 * Complete orchestrator state with all mode sub-states
 */
export interface OrchestratorState {
  activeMode: Mode | null;            // Currently executing MODE (null = all modes terminated)
  queryState: QuerySubState;          // null = QUERY mode terminated
  discoveryState: DiscoverySubState; // null = DISCOVERY mode terminated
  semanticStoringState: SemanticStoringSubState; // null = SEMANTIC_STORING mode terminated
  context: ExecutionContext;
  agentNeeds?: AgentNeeds;            // Agent needs/intentions for LLM interpretation
  lastDecision?: OrchestrationDecision; // Last LLM decision made
  decisionHistory?: OrchestrationDecision[]; // History of decisions for debugging/learning
}

// ============================================================================
// Tool Result Types
// ============================================================================

/**
 * Base tool result interface
 */
interface BaseToolResult {
  success: boolean;
  contextUpdates?: Partial<ExecutionContext>;
}

/**
 * Planner tool result
 */
export interface PlannerResult extends BaseToolResult {
  type: 'planner';
  data: {
    plan: Plan;
    needsClarification: boolean;
  };
  nextState?: { mode: Mode; subState: SubState };
}

/**
 * SQL Writer tool result
 */
export interface SQLWriterResult extends BaseToolResult {
  type: 'sqlWriter';
  data: {
    sql: string;
    step: PlanStep;
  };
  nextState?: { mode: Mode; subState: SubState };
}

/**
 * SQL Execution result (combines SQLWriter + runSQL)
 */
export interface SQLExecutionResult extends BaseToolResult {
  type: 'sqlExecution';
  data: {
    sql: string;
    result: SQLResult;
    step: PlanStep;
  };
  nextState?: { mode: Mode; subState: SubState };
}

/**
 * Interpreter tool result
 */
export interface InterpreterResult extends BaseToolResult {
  type: 'interpreter';
  data: {
    interpretation: Interpretation;
  };
  nextState?: { mode: Mode; subState: SubState };
}

/**
 * Semantic Learner tool result
 */
export interface SemanticLearnerResult extends BaseToolResult {
  type: 'semanticLearner';
  data: {
    discovery?: Discovery;
    suggestion?: Omit<SemanticSuggestion, 'id' | 'created_at'>;
  };
  nextState?: { mode: Mode; subState: SubState };
}

/**
 * Control DB tool result
 */
export interface ControlDbResult extends BaseToolResult {
  type: 'controlDb';
  data: {
    suggestion?: SemanticSuggestion;
    semantic?: Semantic;
    runLog?: RunLog;
  };
  nextState?: { mode: Mode; subState: SubState };
}

/**
 * Discriminated union of all tool result types
 */
export type ToolResult = 
  | PlannerResult
  | SQLWriterResult
  | SQLExecutionResult
  | InterpreterResult
  | SemanticLearnerResult
  | ControlDbResult;

/**
 * Discovery execution result
 */
export interface DiscoveryResult {
  discoveries: Discovery[];
  suggestions: SemanticSuggestion[];
  completed: boolean;
  logs: {
    queries: number;
    totalRows: number;
    totalDuration: number;
  };
}
