import readline from 'readline';
import { Orchestrator } from './agent/orchestrator.js';
import { getSchema, formatSchemaForLLM, clearSchemaCache } from './tools/schema.js';
import { getInspectedDbPool, closeInspectedDbPool } from './tools/db.js';
import { initializeControlDB, getSemantics, formatSemanticsForLLM } from './tools/semantics.js';
import { config } from './config.js';
import { DebugMode, confidenceToPercentage, meetsConfidenceThreshold } from './types.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Global debug mode state - default to SMART
let debugMode: DebugMode = 'smart';

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
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
  /show-schema [table]     - Show database schema (optionally filtered by table)
  /show-semantics          - Show business semantics definitions
  /help                    - Show this help message
  /exit, /quit            - Exit the CLI

Ask a question to get started!
`);
      return false;
    }
    
    default:
      console.log(`Unknown command: ${cmd}. Type /help for available commands.`);
      return false;
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
      console.log('✓ Control database initialized\n');
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
          
          const response = await question('Execute this query? (y/n): ');
          const approved = response.trim().toLowerCase() === 'y' || response.trim().toLowerCase() === 'yes';
          
          if (!approved) {
            console.log('❌ Query execution cancelled by user.\n');
          }
          
          return approved;
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
          
          const response = await question('Execute this query? (y/n): ');
          const approved = response.trim().toLowerCase() === 'y' || response.trim().toLowerCase() === 'yes';
          
          if (!approved) {
            console.log('❌ Query execution cancelled by user.\n');
          }
          
          return approved;
        }
        
        return true; // Fallback
      };
      
      const { answer, logs, cancelled } = await orchestrator.execute(trimmed, requestPermission);
      
      if (cancelled) {
        console.log('⚠️  Execution cancelled. Context has been reset.\n');
      } else {
        console.log(`\n💡 Answer:\n${answer}\n`);
        console.log(`📊 Summary: ${logs.steps} steps, ${logs.queries} queries, ${logs.totalRows} total rows, ${logs.totalDuration}ms total\n`);
      }
    } catch (error) {
      console.error(`\n✗ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  
  // Cleanup
  await closeInspectedDbPool();
  rl.close();
  console.log('\n👋 Goodbye!');
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  await closeInspectedDbPool();
  rl.close();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
