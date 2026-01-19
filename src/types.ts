export interface PlanStep {
  stepNumber: number;
  description: string;
  sqlQuery?: string;
  reasoning: string;
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
}
