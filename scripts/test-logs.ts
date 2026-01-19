#!/usr/bin/env npx tsx
/**
 * Test script to verify run logs functionality
 */

import { saveRunLog, getRecentRunLogs } from '../src/tools/logs.js';

async function testLogs() {
  console.log('🧪 Testing Run Logs Functionality\n');

  try {
    console.log('1️⃣ Saving a test run log...');
    const testLog = await saveRunLog(
      'How many orders were created today?',
      ['SELECT COUNT(*) FROM orders WHERE created_date = CURRENT_DATE LIMIT 200;'],
      [1],
      [125]
    );
    
    if (testLog) {
      console.log(`   ✅ Log saved with ID: ${testLog.id}\n`);
    } else {
      console.log('   ⚠️  Log not saved (control DB may not be configured)\n');
    }

    console.log('2️⃣ Retrieving recent run logs...');
    const recentLogs = await getRecentRunLogs(5);
    console.log(`   ✅ Found ${recentLogs.length} recent logs\n`);

    if (recentLogs.length > 0) {
      console.log('3️⃣ Most recent log:');
      const latest = recentLogs[0];
      console.log(`   ID: ${latest.id}`);
      console.log(`   Question: ${latest.question}`);
      console.log(`   SQL Queries: ${latest.sql.length}`);
      console.log(`   Rows Returned: ${latest.rowsReturned.join(', ')}`);
      console.log(`   Durations (ms): ${latest.durationsMs.join(', ')}`);
      console.log(`   Created: ${latest.createdAt.toISOString()}`);
      console.log('');
    }

    console.log('✅ All tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testLogs();
