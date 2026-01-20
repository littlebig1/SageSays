import readline from 'readline';
import { Orchestrator } from './agent/orchestrator.js';
import { getSchema, formatSchemaForLLM, clearSchemaCache, getInspectedDbPool } from './tools/inspectedDb.js';
import { closeAllPools } from './tools/pools.js';
import { 
  initializeControlDB, 
  getSemantics, 
  formatSemanticsForLLM,
  refreshAllMetadata,
  initializeMetadataTable,
  getAllTableMetadata,
  saveCorrection,
  getRunLogById,
  saveSuggestion,
  approveSuggestion,
  rejectSuggestion,
  getPendingSuggestions
} from './tools/controlDb.js';
import { config } from './config.js';
import { DebugMode, confidenceToPercentage, meetsConfidenceThreshold, CorrectionCapture, SemanticSuggestion, ConversationTurn } from './types.js';
import { SemanticLearner } from './agent/semanticLearner.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Global debug mode state - default to SMART
let debugMode: DebugMode = 'smart';

// Track last query for correction capture
let lastQuestion: string = '';
let lastRunLogId: string | undefined;
let lastSqlQueries: string[] = [];

// Conversation history tracking (Option 1: Conversation History Window)
const MAX_CONVERSATION_HISTORY = 3; // Keep last 3 turns
let conversationHistory: ConversationTurn[] = [];

// Global orchestrator for re-execution support (Phase 3.3)
let globalOrchestrator: Orchestrator | null = null;

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

/**
 * Extract main table name from SQL query
 * Simple heuristic: looks for FROM/JOIN clauses
 */
function extractTableFromSQL(sql: string): string | undefined {
  if (!sql) return undefined;
  
  // Try to find FROM clause
  const fromMatch = sql.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (fromMatch) {
    return fromMatch[1];
  }
  
  // Try to find JOIN clause
  const joinMatch = sql.match(/\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (joinMatch) {
    return joinMatch[1];
  }
  
  return undefined;
}

/**
 * Extract column names from SQL SELECT clause
 * Simple heuristic: looks for SELECT ... FROM pattern
 */
function extractColumnsFromSQL(sql: string): string[] {
  if (!sql) return [];
  
  const selectMatch = sql.match(/\bSELECT\s+(.+?)\s+FROM/i);
  if (!selectMatch) return [];
  
  const selectClause = selectMatch[1];
  
  // Handle SELECT * case
  if (selectClause.trim() === '*') {
    return []; // Can't determine columns from *
  }
  
  // Split by comma and extract column names (simple approach)
  const columns = selectClause
    .split(',')
    .map(col => {
      // Remove AS aliases
      const aliasMatch = col.match(/\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
      if (aliasMatch) {
        return aliasMatch[1].trim();
      }
      // Extract column name (handle table.column format)
      const colMatch = col.match(/(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*)/);
      return colMatch ? colMatch[1].trim() : col.trim();
    })
    .filter(col => col && !col.match(/^(COUNT|SUM|AVG|MIN|MAX|DISTINCT)$/i));
  
  return columns;
}

/**
 * Extract column names from answer text (if it contains structured data)
 * This is a fallback - ideally we'd get this from the SQL result
 */
function extractColumnsFromAnswer(answer: string): string[] {
  // Try to parse JSON if present
  try {
    const jsonMatch = answer.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
        return Object.keys(parsed[0]);
      }
    }
  } catch {
    // Not JSON, continue
  }
  
  return [];
}

async function handleCommand(cmd: string, args: string[]): Promise<boolean> {
  switch (cmd) {
    case '/debug': {
      const mode = args[0]?.toLowerCase();
      if (mode === 'on' || mode === 'true' || mode === '1') {
        debugMode = 'on';
        console.log('🐛 Debug mode: ON\n   All SQL queries will require approval before execution.\n');
      } else if (mode === 'off' || mode === 'false' || mode === '0') {
        debugMode = 'off';
        console.log('✓ Debug mode: OFF\n   All SQL queries will execute automatically.\n');
      } else if (mode === 'smart') {
        debugMode = 'smart';
        console.log(`🧠 Debug mode: SMART (threshold: ${config.debugModeConfidenceThreshold}%)\n   Queries without semantics OR low confidence require approval.\n`);
      } else if (!args[0]) {
        // Toggle behavior: off → smart → on → off
        if (debugMode === 'off') debugMode = 'smart';
        else if (debugMode === 'smart') debugMode = 'on';
        else debugMode = 'off';
        
        const messages = {
          on: '🐛 Debug mode: ON - All queries require approval',
          off: '✓ Debug mode: OFF - All queries execute automatically',
          smart: `🧠 Debug mode: SMART (threshold: ${config.debugModeConfidenceThreshold}%) - Reviews queries without semantics or low confidence`
        };
        console.log(messages[debugMode] + '\n');
      } else {
        console.log(`Current debug mode: ${debugMode.toUpperCase()}`);
        console.log('Usage: /debug [on|off|smart]');
        console.log('  on    - Always ask for approval');
        console.log('  off   - Never ask for approval');
        console.log(`  smart - Ask only when no semantics OR confidence < ${config.debugModeConfidenceThreshold}%\n`);
      }
      return false;
    }
    
    case '/refresh-schema': {
      console.log('🔄 Refreshing schema cache...');
      clearSchemaCache();
      const pool = getInspectedDbPool();
      const client = await pool.connect();
      try {
        await getSchema(client, false);
        console.log('✓ Schema cache refreshed\n');
      } finally {
        client.release();
      }
      return false;
    }
    
    case '/refresh-metadata': {
      if (!config.controlDbUrl) {
        console.log('\n⚠️  Control database not configured. Set CONTROL_DB_URL to use metadata.\n');
        return false;
      }
      
      try {
        const pool = getInspectedDbPool();
        const client = await pool.connect();
        try {
          await refreshAllMetadata(client);
          console.log('\n✅ Metadata refreshed successfully!\n');
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('\n❌ Error refreshing metadata:', error);
      }
      
      return false;
    }
    
    case '/show-schema': {
      const tableName = args[0];
      const pool = getInspectedDbPool();
      const client = await pool.connect();
      try {
        const schema = await getSchema(client);
        const formatted = formatSchemaForLLM(schema, tableName);
        console.log('\n' + formatted + '\n');
      } finally {
        client.release();
      }
      return false;
    }
    
    case '/show-semantics': {
      if (!config.controlDbUrl) {
        console.log('\n⚠️  Control database not configured. Set CONTROL_DB_URL to use semantics.\n');
        return false;
      }
      const semantics = await getSemantics();
      const formatted = await formatSemanticsForLLM(semantics);
      console.log('\n' + formatted + '\n');
      return false;
    }
    
    case '/refresh-semantics': {
      if (!config.controlDbUrl) {
        console.log('\n⚠️  Control database not configured. Set CONTROL_DB_URL to use semantics.\n');
        return false;
      }
      // Force a fresh query by calling getSemantics (no cache, but ensures fresh connection)
      const semantics = await getSemantics();
      console.log(`\n✅ Semantics refreshed. Found ${semantics.length} semantic(s).\n`);
      return false;
    }
    
    case '/review-suggestions': {
      if (!config.controlDbUrl) {
        console.log('\n⚠️  Control database not configured. Set CONTROL_DB_URL to use suggestions.\n');
        return false;
      }
      await reviewPendingSuggestions();
      return false;
    }
    
    case '/exit':
    case '/quit':
      return true;
    
    case '/help': {
      console.log(`
Available commands:
  /debug [on|off|smart]    - Toggle debug mode (default: smart)
      on    - Always review queries before execution
      off   - Execute all queries automatically
      smart - Review only queries without semantics OR confidence < ${config.debugModeConfidenceThreshold}%
  /refresh-schema          - Refresh the database schema cache
  /refresh-metadata        - Refresh table metadata (indexes, sizes, FKs) from inspected DB
  /refresh-semantics       - Refresh semantics from control database (force fresh query)
  /show-schema [table]     - Show database schema (optionally filtered by table)
  /show-semantics          - Show business semantics definitions
  /review-suggestions      - Review pending semantic suggestions for approval
  /help                    - Show this help message
  /exit, /quit            - Exit the CLI

Debug Mode Options:
  When SQL is shown during debug mode, you can:
    - Type "y" to execute the query
    - Type "n" to reject and provide text feedback (I'll learn from it)
    - Type "edit" to manually correct the SQL (I'll learn from the diff and re-run)

Semantic Learning:
  - Say "that's wrong" after a query to trigger correction capture
  - Approve/reject suggestions immediately or use /review-suggestions later

Ask a question to get started!
`);
      return false;
    }
    
    default:
      console.log(`Unknown command: ${cmd}. Type /help for available commands.`);
      return false;
  }
}

/**
 * Capture a post-execution correction from the user and trigger immediate learning.
 * This is the main Phase 3 correction capture workflow.
 */
async function capturePostExecutionCorrection(
  runLogId: string,
  originalQuestion: string,
  _sqlQueries: string[], // Prefixed with _ to indicate intentionally unused
  _feedback: string // Prefixed with _ to indicate intentionally unused
): Promise<void> {
  console.log('\n🔍 I detected you\'re not satisfied with the result.');
  console.log('\nWhat specifically was wrong?');
  console.log('  1) The SQL query was incorrect');
  console.log('  2) The result doesn\'t match reality');
  console.log('  3) I misunderstood your question');
  
  const choice = await question('\nYour choice (1/2/3): ');
  
  const typeMap: Record<string, 'wrong_sql' | 'wrong_result' | 'wrong_interpretation'> = {
    '1': 'wrong_sql',
    '2': 'wrong_result',
    '3': 'wrong_interpretation'
  };
  
  const correctionType = typeMap[choice] || 'wrong_sql';
  
  console.log('\n📝 Please explain what was wrong:');
  const explanation = await question('> ');
  
  // Get the run log details
  const runLog = await getRunLogById(runLogId);
  
  if (!runLog) {
    console.log('⚠️  Could not find run log. Correction not saved.\n');
    return;
  }
  
  const correction: CorrectionCapture = {
    run_log_id: runLogId,
    correction_stage: 'post_execution',
    original_question: originalQuestion,
    original_sql: runLog.sql_generated?.[0] || '', // First SQL query
    user_feedback: explanation,
    correction_type: correctionType
  };
  
  // Save correction
  try {
    await saveCorrection(runLogId, correction);
    console.log('\n✅ Correction saved.');
  } catch (error) {
    console.error('\n❌ Error saving correction:', error);
    return;
  }
  
  // Trigger immediate learning with LLM analysis
  console.log('\n🧠 Analyzing your correction...');
  
  try {
    const learner = new SemanticLearner();
    const pool = getInspectedDbPool();
    const client = await pool.connect();
    let schema;
    try {
      schema = await getSchema(client);
    } finally {
      client.release();
    }
    const suggestionData = await learner.analyzeCorrection(runLog, correction, schema);
    
    if (!suggestionData) {
      console.log('⚠️  Could not generate semantic suggestion from this correction.');
      console.log('   Your feedback has been saved for future analysis.\n');
      return;
    }
    
    // Save suggestion to database
    const suggestion = await saveSuggestion(suggestionData);
    
    if (!suggestion) {
      console.log('⚠️  Could not save suggestion (control DB may not be configured).\n');
      return;
    }
    
    // Show immediate approval prompt
    await showImmediateApprovalPrompt(suggestion);
    
  } catch (error) {
    console.error('\n❌ Error during learning:', error);
    console.log('   Your correction was saved, but semantic learning failed.\n');
  }
}

/**
 * Show immediate approval prompt for a semantic suggestion.
 * This is the Option B workflow: immediate approval during the session.
 * Returns true if approved, false otherwise.
 */
async function showImmediateApprovalPrompt(suggestion: SemanticSuggestion): Promise<boolean> {
  console.log('\n💡 I learned a pattern from your correction:\n');
  console.log('═'.repeat(60));
  console.log(`Semantic: ${suggestion.suggested_name}`);
  console.log(`Type: ${suggestion.suggested_type}`);
  
  const def = suggestion.suggested_definition;
  const category = def.metadata?.category || 'General';
  console.log(`Category: ${category}`);
  console.log();
  
  console.log(`Description:`);
  console.log(`  ${def.description}`);
  console.log();
  
  if (def.sqlPattern) {
    console.log(`SQL Pattern:`);
    console.log(`  ${def.sqlPattern}`);
    console.log();
  }
  
  if (def.metadata?.synonyms && def.metadata.synonyms.length > 0) {
    console.log(`Synonyms: ${def.metadata.synonyms.join(', ')}`);
    console.log();
  }
  
  if (def.metadata?.anti_patterns) {
    const ap = def.metadata.anti_patterns;
    console.log(`Common Mistake to Avoid:`);
    console.log(`  Wrong: ${ap.wrong}`);
    console.log(`  Why: ${ap.why}`);
    console.log();
  }
  
  console.log(`Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`);
  console.log('═'.repeat(60));
  console.log();
  
  const response = await question('Is this correct? (y/n/later): ');
  const choice = response.trim().toLowerCase();
  
  if (choice === 'y' || choice === 'yes') {
    try {
      await approveSuggestion(suggestion, 'user');
      console.log('\n✅ Semantic saved! I\'ll use this knowledge from now on.\n');
      return true;
    } catch (error) {
      console.error('\n❌ Error approving suggestion:', error);
      return false;
    }
  } else if (choice === 'later' || choice === 'l') {
    console.log('\n📝 Saved for later review. Use /review-suggestions to review.\n');
    return false;
  } else {
    try {
      await rejectSuggestion(suggestion.id, 'user', 'User rejected during immediate review');
      console.log('\n❌ Suggestion rejected.\n');
      return false;
    } catch (error) {
      console.error('\n❌ Error rejecting suggestion:', error);
      return false;
    }
  }
}

/**
 * Review pending semantic suggestions.
 * This is the deferred approval workflow (Option A).
 */
async function reviewPendingSuggestions(): Promise<void> {
  console.log('\n📋 Fetching pending suggestions...\n');
  
  const suggestions = await getPendingSuggestions();
  
  if (suggestions.length === 0) {
    console.log('✅ No pending suggestions to review!\n');
    return;
  }
  
  console.log(`Found ${suggestions.length} pending suggestion(s):\n`);
  
  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Suggestion ${i + 1} of ${suggestions.length}`);
    console.log('═'.repeat(60));
    
    await showImmediateApprovalPrompt(suggestion);
    
    // Continue to next suggestion
    if (i < suggestions.length - 1) {
      console.log('Moving to next suggestion...\n');
    }
  }
  
  console.log('\n✅ All suggestions reviewed!\n');
}

/**
 * Capture user feedback when they reject a query before execution.
 * This is a pre-execution correction - no run_log exists yet.
 * Phase 3.3: Pre-execution corrections
 */
async function capturePreExecutionFeedback(
  originalQuestion: string,
  generatedSql: string
): Promise<void> {
  console.log('\n💭 What was wrong with the generated SQL?');
  const feedback = await question('Your feedback: ');
  
  if (!feedback.trim()) {
    console.log('⚠️  No feedback provided.\n');
    return;
  }
  
  // Build correction object (no run_log_id for pre-execution)
  const correction: CorrectionCapture = {
    correction_stage: 'pre_execution',
    original_question: originalQuestion,
    original_sql: generatedSql,
    user_feedback: feedback.trim(),
    correction_type: 'wrong_sql', // Pre-execution is always about SQL
    // No run_log_id - query wasn't executed
  };
  
  // Same learning flow as post-execution
  console.log('\n🧠 Analyzing your feedback...');
  
  try {
    const learner = new SemanticLearner();
    const pool = getInspectedDbPool();
    const client = await pool.connect();
    let schema;
    try {
      schema = await getSchema(client);
    } finally {
      client.release();
    }
    
    const suggestionData = await learner.analyzeCorrection(null, correction, schema);
    
    if (!suggestionData) {
      console.log('⚠️  Could not generate semantic suggestion from this feedback.\n');
      return;
    }
    
    const suggestion = await saveSuggestion(suggestionData);
    
    if (!suggestion) {
      console.log('⚠️  Could not save suggestion (control DB may not be configured).\n');
      return;
    }
    
    // Show immediate approval prompt (reuse existing function)
    await showImmediateApprovalPrompt(suggestion);
    
  } catch (error) {
    console.error('\n❌ Error during learning:', error);
  }
}

/**
 * Handle manual SQL editing with learning from diff.
 * User edits SQL → System learns from changes → Asks for approval → Re-runs with new knowledge.
 * Phase 3.3: Pre-execution corrections with manual SQL edit
 */
async function handleManualSqlEdit(
  originalQuestion: string,
  generatedSql: string,
  _stepNumber: number,
  _totalSteps: number
): Promise<void> {
  console.log('\n✏️  Edit the SQL below (press Enter when done):');
  console.log('Original SQL:');
  console.log(generatedSql);
  console.log('\nEnter your corrected SQL:');
  
  const editedSql = await question('> ');
  
  if (!editedSql.trim() || editedSql.trim() === generatedSql.trim()) {
    console.log('⚠️  No changes made.\n');
    return;
  }
  
  console.log('\n🧠 Analyzing the SQL changes to learn what was wrong...');
  
  try {
    const learner = new SemanticLearner();
    const pool = getInspectedDbPool();
    const client = await pool.connect();
    let schema;
    try {
      schema = await getSchema(client);
    } finally {
      client.release();
    }
    
    // Use new method to analyze SQL diff
    const suggestionData = await learner.analyzeSqlDiff(
      originalQuestion,
      generatedSql,
      editedSql.trim(),
      schema
    );
    
    if (!suggestionData) {
      console.log('⚠️  Could not learn from SQL changes.\n');
      console.log('💡 Tip: Provide more context about what was wrong.\n');
      return;
    }
    
    const suggestion = await saveSuggestion(suggestionData);
    
    if (!suggestion) {
      console.log('⚠️  Could not save suggestion (control DB may not be configured).\n');
      return;
    }
    
    // Show approval prompt and track if approved
    const wasApproved = await showImmediateApprovalPrompt(suggestion);
    
    if (wasApproved && globalOrchestrator) {
      console.log('\n🔄 Re-running your original question with the new knowledge...\n');
      
      try {
        // Execute without permission callback to auto-run (pass empty history for re-execution)
        const result = await globalOrchestrator.execute(originalQuestion, [], undefined, question);
        
        console.log(`\n💡 Answer (with learned semantic):\n${result.answer}\n`);
        console.log(`📊 Summary: ${result.logs.steps} steps, ${result.logs.queries} queries\n`);
        console.log('✅ Verify that this answer is now correct!\n');
      } catch (error) {
        console.error('❌ Error re-running question:', error);
      }
    }
    
  } catch (error) {
    console.error('\n❌ Error during SQL diff learning:', error);
  }
}

async function main() {
  console.log('🚀 SQL Agent CLI - Level 2 Orchestration');
  console.log('==========================================\n');
  
  // Initialize control database (optional)
  try {
    console.log('🔧 Initializing control database...');
    await initializeControlDB();
    if (config.controlDbUrl) {
      console.log('✓ Control database initialized');
      
      // Initialize metadata table
      try {
        await initializeMetadataTable();
      } catch (error) {
        console.warn('⚠️  Metadata table initialization failed:', error);
      }
      
      // Check if metadata needs refresh (older than 7 days)
      try {
        const metadata = await getAllTableMetadata();
        const needsRefresh = metadata.length === 0 || 
          metadata.some(m => {
            const daysSinceUpdate = (Date.now() - m.lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
            return daysSinceUpdate > 7;
          });
        
        if (needsRefresh) {
          console.log('📊 Metadata appears stale, refreshing...');
          const pool = getInspectedDbPool();
          const client = await pool.connect();
          try {
            await refreshAllMetadata(client);
          } finally {
            client.release();
          }
        }
      } catch (error) {
        // Silently ignore - metadata refresh is optional
      }
      
      console.log('');
    } else {
      console.log('⚠️  Control database not configured (optional)\n');
    }
  } catch (error) {
    console.warn('⚠️  Control database initialization failed:', error);
    console.warn('Continuing without control database (semantics and logs will be disabled)\n');
  }
  
  // Test inspected database connection
  try {
    console.log('🔧 Testing inspected database connection...');
    const pool = getInspectedDbPool();
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      console.log('✓ Inspected database connection successful\n');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('✗ Failed to connect to inspected database:', error);
    console.error('Make sure DATABASE_URL is set correctly.\n');
    process.exit(1);
  }
  
  const orchestrator = new Orchestrator();
  globalOrchestrator = orchestrator; // Make globally accessible for re-execution (Phase 3.3)
  
  console.log(`🧠 Debug mode: ${debugMode.toUpperCase()}`);
  if (debugMode === 'smart') {
    console.log(`   Confidence threshold: ${config.debugModeConfidenceThreshold}%`);
    console.log('   Auto-executes when: semantics ✓ AND confidence ✓\n');
  } else {
    console.log();
  }
  
  console.log('Ready! Type a question or /help for commands.\n');
  
  while (true) {
    const input = await question('> ');
    const trimmed = input.trim();
    
    if (!trimmed) {
      continue;
    }
    
    // Check for correction keywords
    const correctionKeywords = [
      'wrong', 'incorrect', 'not right', "that's wrong",
      'not correct', 'nope', 'bad result', "that's incorrect",
      'that is wrong', 'that is incorrect'
    ];
    
    if (correctionKeywords.some(kw => trimmed.toLowerCase().includes(kw)) && lastRunLogId) {
      await capturePostExecutionCorrection(lastRunLogId, lastQuestion, lastSqlQueries, trimmed);
      continue; // Don't treat as new question
    }
    
    // Check if it's a command
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);
      const shouldExit = await handleCommand(cmd, args);
      if (shouldExit) {
        break;
      }
      continue;
    }
    
    // It's a question
    try {
      // Create permission callback for debug mode
      const requestPermission = async (
        sql: string, 
        stepNumber: number, 
        totalSteps: number,
        hasSemantics: boolean,
        confidence: 'high' | 'medium' | 'low'
      ): Promise<boolean> => {
        // OFF mode: always approve
        if (debugMode === 'off') {
          return true;
        }
        
        // ON mode: always ask
        if (debugMode === 'on') {
          console.log(`\n🐛 [DEBUG] Step ${stepNumber}/${totalSteps} - Query ready for execution:`);
          console.log(`\n${sql}\n`);
          
          const response = await question('Execute this query? (y/n/edit): ');
          const input = response.trim().toLowerCase();
          
          if (input === 'y' || input === 'yes') {
            return true;
          }
          
          if (input === 'edit' || input === 'e') {
            // Handle manual SQL edit (Phase 3.3)
            await handleManualSqlEdit(trimmed, sql, stepNumber, totalSteps);
            return false; // Cancel current execution
          }
          
          // User said 'n' or 'no' - show options
          console.log('\n📝 What would you like to do?');
          console.log('  1. Provide feedback (help me learn why this SQL is wrong)');
          console.log('  2. Try a different question');
          const choice = await question('Choose (1/2): ');
          
          if (choice.trim() === '1') {
            // Handle text feedback (Phase 3.3)
            await capturePreExecutionFeedback(trimmed, sql);
          }
          
          console.log('❌ Query execution cancelled.\n');
          return false;
        }
        
        // SMART mode: check both semantics AND confidence
        if (debugMode === 'smart') {
          const confidencePercentage = confidenceToPercentage(confidence);
          const meetsThreshold = meetsConfidenceThreshold(confidence, config.debugModeConfidenceThreshold);
          
          // Auto-approve if BOTH conditions met:
          // 1. Semantics detected
          // 2. Confidence meets threshold
          if (hasSemantics && meetsThreshold) {
            console.log(`   ✓ Auto-executing (semantics: ✓, confidence: ${confidencePercentage}%)`);
            return true;
          }
          
          // Ask for approval if EITHER condition fails
          const reasons: string[] = [];
          if (!hasSemantics) {
            reasons.push('no semantics detected');
          }
          if (!meetsThreshold) {
            reasons.push(`confidence ${confidencePercentage}% < ${config.debugModeConfidenceThreshold}%`);
          }
          
          console.log(`\n🤔 [SMART MODE] Step ${stepNumber}/${totalSteps} - Review required:`);
          console.log(`\n${sql}\n`);
          console.log(`⚠️  Reason(s): ${reasons.join(', ')}`);
          console.log(`   - Semantics: ${hasSemantics ? '✓ Detected' : '✗ None'}`);
          console.log(`   - Confidence: ${confidencePercentage}% (threshold: ${config.debugModeConfidenceThreshold}%)\n`);
          
          const response = await question('Execute this query? (y/n/edit): ');
          const input = response.trim().toLowerCase();
          
          if (input === 'y' || input === 'yes') {
            return true;
          }
          
          if (input === 'edit' || input === 'e') {
            // Handle manual SQL edit (Phase 3.3)
            await handleManualSqlEdit(trimmed, sql, stepNumber, totalSteps);
            return false; // Cancel current execution
          }
          
          // User said 'n' or 'no' - show options
          console.log('\n📝 What would you like to do?');
          console.log('  1. Provide feedback (help me learn why this SQL is wrong)');
          console.log('  2. Try a different question');
          const choice = await question('Choose (1/2): ');
          
          if (choice.trim() === '1') {
            // Handle text feedback (Phase 3.3)
            await capturePreExecutionFeedback(trimmed, sql);
          }
          
          console.log('❌ Query execution cancelled.\n');
          return false;
        }
        
        return true; // Fallback
      };
      
      // Pass conversation history to orchestrator
      const { answer, logs, cancelled, sqlQueries } = await orchestrator.execute(
        trimmed, 
        conversationHistory, // Pass history for context awareness
        requestPermission, 
        question
      );
      
      if (cancelled) {
        console.log('⚠️  Execution cancelled. Context has been reset.\n');
        // Reset tracking on cancellation
        lastQuestion = '';
        lastRunLogId = undefined;
        lastSqlQueries = [];
        conversationHistory = []; // Clear conversation history on cancellation
      } else {
        console.log(`\n💡 Answer:\n${answer}\n`);
        console.log(`📊 Summary: ${logs.steps} steps, ${logs.queries} queries, ${logs.totalRows} total rows, ${logs.totalDuration}ms total\n`);
        
        // Track for correction capture
        lastQuestion = trimmed;
        lastRunLogId = logs.runLogId;
        lastSqlQueries = sqlQueries || [];
        
        // Add to conversation history
        const mainSQL = sqlQueries && sqlQueries.length > 0 ? sqlQueries[0] : '';
        const resultTable = extractTableFromSQL(mainSQL);
        const resultColumns = mainSQL ? extractColumnsFromSQL(mainSQL) : extractColumnsFromAnswer(answer);
        
        conversationHistory.push({
          question: trimmed,
          answer: answer,
          sqlQueries: sqlQueries || [],
          resultColumns: resultColumns.length > 0 ? resultColumns : undefined,
          resultTable: resultTable,
          timestamp: new Date(),
        });
        
        // Keep only recent history (sliding window)
        if (conversationHistory.length > MAX_CONVERSATION_HISTORY) {
          conversationHistory.shift();
        }
      }
    } catch (error) {
      console.error(`\n✗ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  
  // Cleanup
  await closeAllPools();
  rl.close();
  console.log('\n👋 Goodbye!');
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  await closeAllPools();
  rl.close();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
