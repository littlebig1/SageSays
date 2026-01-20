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

export interface Plan {
  steps: PlanStep[];
  overallGoal: string;
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
