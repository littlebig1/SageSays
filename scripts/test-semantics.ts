#!/usr/bin/env npx tsx
/**
 * Test script to verify semantics functionality
 */

import { getSemantics, formatSemanticsForLLM } from '../src/tools/semantics.js';

async function testSemantics() {
  console.log('🧪 Testing Semantics Functionality\n');

  try {
    console.log('1️⃣ Fetching all semantics...');
    const allSemantics = await getSemantics();
    console.log(`   ✅ Found ${allSemantics.length} semantic entities\n`);

    if (allSemantics.length > 0) {
      console.log('2️⃣ Sample semantic entity:');
      const sample = allSemantics[0];
      console.log(`   ID: ${sample.id}`);
      console.log(`   Category: ${sample.category}`);
      console.log(`   Term: ${sample.term}`);
      console.log(`   Description: ${sample.description.substring(0, 100)}...`);
      if (sample.tableName) {
        console.log(`   Table: ${sample.tableName}`);
      }
      if (sample.columnName) {
        console.log(`   Column: ${sample.columnName}`);
      }
      console.log('');

      console.log('3️⃣ Formatted for LLM:');
      const formatted = await formatSemanticsForLLM(allSemantics);
      console.log(formatted);
      console.log('');
    } else {
      console.log('⚠️  No semantic entities found in database.');
      console.log('   This is normal if you haven\'t added any yet.\n');
    }

    console.log('✅ All tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testSemantics();
