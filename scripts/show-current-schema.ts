#!/usr/bin/env tsx
/**
 * Shows the current schema of the control database
 */

import pg from 'pg';
import { config } from '../src/config.js';

const { Pool } = pg;

async function showCurrentSchema() {
  if (!config.controlDbUrl) {
    console.error('❌ CONTROL_DB_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: config.controlDbUrl });
  const client = await pool.connect();

  try {
    console.log('🔍 Current Control Database Schema\n');

    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    for (const table of tablesResult.rows) {
      const tableName = table.table_name;
      console.log(`\n📋 Table: ${tableName}`);
      console.log('─'.repeat(60));

      // Get columns for this table
      const columnsResult = await client.query(`
        SELECT 
          column_name, 
          data_type, 
          is_nullable,
          column_default
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      for (const col of columnsResult.rows) {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : '';
        console.log(`  ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${nullable}${defaultVal}`);
      }

      // Get row count
      const countResult = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      console.log(`\n  📊 Row count: ${countResult.rows[0].count}`);
    }

    console.log('\n');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

showCurrentSchema();
