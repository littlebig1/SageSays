/**
 * Test script for semantic detection functionality.
 * Tests the detectSemantics() function with various questions.
 */

import { detectSemantics, getSemantics } from '../src/tools/semantics.js';

async function main() {
  console.log('🧪 Testing Semantic Detection\n');
  
  // Load all semantics first
  const allSemantics = await getSemantics();
  console.log(`📚 Loaded ${allSemantics.length} semantic entities\n`);
  
  // Test questions
  const testQuestions = [
    "How many orders were created yesterday?",
    "Show me sales from last month",
    "What is the revenue today?",
    "List all products ordered this month",
    "How many users signed up this week?", // Should not detect anything (no semantic for "this week")
  ];
  
  for (const question of testQuestions) {
    console.log(`\n❓ Question: "${question}"`);
    const detectedIds = await detectSemantics(question);
    
    if (detectedIds.length === 0) {
      console.log('   ⚠️  No semantics detected');
    } else {
      console.log(`   ✅ Detected ${detectedIds.length} semantic(s):`);
      for (const id of detectedIds) {
        const semantic = allSemantics.find(s => s.id === id);
        if (semantic) {
          console.log(`      - "${semantic.term}" (${semantic.category})`);
        }
      }
    }
  }
  
  console.log('\n✅ Semantic detection tests complete!');
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
