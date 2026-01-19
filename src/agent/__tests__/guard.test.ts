import { describe, it, expect } from 'vitest';
import { validateSQL } from '../guard.js';

describe('SQL Guard - Safety Validations', () => {
  describe('Undefined table name detection', () => {
    it('should reject SQL with "undefined" as table name', () => {
      const result = validateSQL('SELECT * FROM "undefined"');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('undefined');
    });

    it('should reject SQL with undefined in JOIN clause', () => {
      const result = validateSQL('SELECT * FROM users JOIN "undefined" ON users.id = undefined.user_id');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('undefined');
    });
  });

  describe('Dangerous keyword detection', () => {
    it('should reject DROP statements', () => {
      const result = validateSQL('DROP TABLE users');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DROP');
    });

    it('should reject DELETE statements', () => {
      const result = validateSQL('DELETE FROM users WHERE id = 1');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DELETE');
    });

    it('should reject INSERT statements', () => {
      const result = validateSQL('INSERT INTO users (name) VALUES (\'test\')');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('INSERT');
    });

    it('should reject UPDATE statements', () => {
      const result = validateSQL('UPDATE users SET name = \'test\'');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('UPDATE');
    });
  });

  describe('Valid SELECT statements', () => {
    it('should accept simple SELECT', () => {
      const result = validateSQL('SELECT * FROM users');
      expect(result.valid).toBe(true);
    });

    it('should accept SELECT with WHERE clause', () => {
      const result = validateSQL('SELECT id, name FROM users WHERE active = true');
      expect(result.valid).toBe(true);
    });

    it('should accept WITH CTE', () => {
      const result = validateSQL('WITH active_users AS (SELECT * FROM users WHERE active = true) SELECT * FROM active_users');
      expect(result.valid).toBe(true);
    });
  });

  describe('Auto-LIMIT functionality', () => {
    it('should add LIMIT 200 to queries without LIMIT', () => {
      const result = validateSQL('SELECT * FROM users');
      expect(result.valid).toBe(true);
      expect(result.sanitizedSQL).toContain('LIMIT 200');
    });

    it('should not add LIMIT if already present', () => {
      const result = validateSQL('SELECT * FROM users LIMIT 10');
      expect(result.valid).toBe(true);
      expect(result.sanitizedSQL).toMatch(/LIMIT 10/);
      expect(result.sanitizedSQL).not.toMatch(/LIMIT 200/);
    });

    it('should add LIMIT after ORDER BY', () => {
      const result = validateSQL('SELECT * FROM users ORDER BY created_at DESC');
      expect(result.valid).toBe(true);
      expect(result.sanitizedSQL).toMatch(/ORDER BY created_at DESC LIMIT 200/);
    });
  });

  describe('Multiple statement detection', () => {
    it('should reject multiple statements', () => {
      // Note: Dangerous keywords are checked first, so this catches DROP before multiple statements
      const result = validateSQL('SELECT * FROM users; SELECT * FROM orders;');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Multiple statements');
    });
    
    it('should catch dangerous keywords before multiple statement check', () => {
      // This should fail on DROP, not on multiple statements
      const result = validateSQL('SELECT * FROM users; DROP TABLE users;');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DROP');
    });
  });

  describe('Empty SQL detection', () => {
    it('should reject empty string', () => {
      const result = validateSQL('');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Empty');
    });

    it('should reject whitespace only', () => {
      const result = validateSQL('   ');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Empty');
    });
  });
});
