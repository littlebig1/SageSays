# Development Guide

Complete guide for developers working on SageSays.

## Quick Start

### Prerequisites
- Node.js 20.x or later
- PostgreSQL database (for testing)
- Gemini API key

### Setup
```bash
# Install dependencies
npm install

# Set up environment variables
cp env.example .env
# Edit .env with your actual values

# Run validation (type check + build)
npm run validate

# Run tests
npm test

# Start development server
npm run dev
```

---

## Development Workflow

### 1. Before Making Changes

**Understand the codebase:**
- Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for component relationships
- Check if your change affects multiple components
- Review existing tests for similar functionality

**Create a feature branch:**
```bash
git checkout -b feature/your-feature-name
```

### 2. While Developing

**Write quality code:**
- Use TypeScript's strict mode (already enabled)
- Add JSDoc comments for public APIs
- Add runtime assertions for critical functions
- Handle errors gracefully

**Test frequently:**
```bash
# Run all tests
npm test

# Watch mode (re-runs on file changes)
npm run test:watch

# Interactive UI
npm run test:ui

# Type checking only
npm run typecheck
```

### 3. Before Committing

**Validate everything:**
```bash
npm run validate  # Runs: typecheck + build
```

This ensures:
- ✅ No TypeScript errors
- ✅ Code compiles successfully
- ✅ No linter errors (when lint is configured)

**Run tests:**
```bash
npm test
```

### 4. Commit and Push

```bash
git add .
git commit -m "feat: your descriptive commit message"
git push origin feature/your-feature-name
```

---

## Code Quality Standards

### TypeScript Best Practices

**Strict compiler options enabled:**
```typescript
// tsconfig.json includes:
{
  "noUnusedLocals": true,        // No unused variables
  "noUnusedParameters": true,    // No unused function params
  "noImplicitReturns": true,     // All code paths must return
  "noFallthroughCasesInSwitch": true
}
```

**Type everything:**
```typescript
// ✅ Good
function processQuery(sql: string): SQLResult {
  // ...
}

// ❌ Bad
function processQuery(sql) {
  // ...
}
```

### JSDoc Documentation

**All public functions must have JSDoc:**

```typescript
/**
 * Executes a SQL query against the inspected database with safety validations.
 * @param sql The SQL query string to execute.
 * @returns A Promise that resolves to an SQLResult object.
 * @throws Error if the SQL is invalid or execution fails.
 */
export async function runSQL(sql: string): Promise<SQLResult> {
  // ...
}
```

**What to document:**
- Purpose of the function
- Each parameter with type and description
- Return value
- Possible errors/exceptions
- Usage examples (for complex functions)

### Runtime Assertions

**Add assertions for critical code paths:**

```typescript
export async function runSQL(sql: string): Promise<SQLResult> {
  // Runtime assertion
  if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Invalid SQL: must be a non-empty string.');
  }
  
  // Rest of implementation...
}
```

**Where to add assertions:**
- Public API entry points
- Database operations
- File system operations
- External API calls

---

## Testing Strategy

### Test Framework: Vitest

**Why Vitest?**
- Fast, modern testing framework
- Native TypeScript support
- Compatible with Jest API
- Better ESM support

### Running Tests

```bash
# Run all tests once
npm test

# Watch mode (recommended during development)
npm run test:watch

# Interactive UI mode
npm run test:ui

# With coverage
npm test -- --coverage
```

### Writing Tests

**Test file location:**
- Place tests next to the code: `src/agent/__tests__/guard.test.ts`
- Or use `.test.ts` suffix: `src/agent/guard.test.ts`

**Example test:**

```typescript
import { describe, it, expect } from 'vitest';
import { validateSQL } from '../guard.js';

describe('SQL Guard - Safety Validations', () => {
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
  });

  describe('Valid queries', () => {
    it('should accept simple SELECT', () => {
      const result = validateSQL('SELECT * FROM users');
      expect(result.valid).toBe(true);
      expect(result.sanitizedSQL).toContain('LIMIT');
    });
  });
});
```

**What to test:**
- ✅ Happy path scenarios
- ✅ Error conditions
- ✅ Edge cases (empty input, null, undefined)
- ✅ Security validations
- ✅ Data transformations

### Test Coverage Goals

- **Critical paths**: 100% (Guard, DB operations)
- **Business logic**: 80%+
- **Overall**: 70%+

---

## Common Patterns

### 1. Database Connections

**Use singleton pattern for connection pools:**

```typescript
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}
```

### 2. Error Handling

**Always provide context in errors:**

```typescript
try {
  const result = await client.query(sql);
  return result;
} catch (error) {
  throw new Error(
    `SQL execution failed: ${error instanceof Error ? error.message : String(error)}`
  );
}
```

### 3. Async/Await

**Always await promises, handle errors:**

```typescript
// ✅ Good
async function loadData() {
  try {
    const data = await fetchData();
    return processData(data);
  } catch (error) {
    console.error('Failed to load data:', error);
    throw error;
  }
}

// ❌ Bad - missing await
async function loadData() {
  const data = fetchData();  // Returns Promise, not data!
  return processData(data);
}
```

### 4. Configuration Management

**Use centralized config:**

```typescript
import { config } from '../config.js';

// ✅ Good
const apiKey = config.geminiApiKey;

// ❌ Bad
const apiKey = process.env.GEMINI_API_KEY;
```

---

## Anti-Patterns to Avoid

### ❌ Don't: Dynamic Schema Detection

```typescript
// BAD - adds complexity, hides schema mismatches
const columns = await getAvailableColumns();
if (columns.includes('table_name')) { ... }
```

**Instead:** Use fixed, documented schema.

### ❌ Don't: Swallow Errors Silently

```typescript
// BAD
try {
  await riskyOperation();
} catch (error) {
  // Silent failure - hard to debug!
}
```

**Instead:** Log errors or rethrow with context.

### ❌ Don't: Mutate Function Parameters

```typescript
// BAD
function addLimit(query: string[]): string[] {
  query.push('LIMIT 100');  // Mutates input!
  return query;
}
```

**Instead:** Return new values, don't mutate.

### ❌ Don't: Use `any` Type

```typescript
// BAD
function process(data: any): any { ... }
```

**Instead:** Define proper types or use `unknown`.

---

## npm Scripts Reference

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript | Before deployment |
| `npm run dev` | Start CLI in development mode | Local testing |
| `npm start` | Run compiled JavaScript | Production |
| `npm run typecheck` | Type check without building | Quick validation |
| `npm test` | Run all tests | Before committing |
| `npm run test:watch` | Run tests in watch mode | During development |
| `npm run test:ui` | Interactive test UI | Debugging tests |
| `npm run validate` | Typecheck + build | Pre-commit check |
| `npm run show-schema` | Display control DB schema | Verify database structure |

---

## Debugging Tips

### 1. Enable Debug Mode in CLI

```bash
npm run dev
> /debug on
> your question here
```

This shows each SQL query before execution.

### 2. Check Schema Cache

```bash
# View cached schema
cat data/schema_cache.json

# Clear cache
rm data/schema_cache.json
```

### 3. Inspect Control Database

```bash
npm run show-schema
```

### 4. Test SQL Validation

```typescript
import { validateSQL } from './src/agent/guard.js';

const result = validateSQL('your SQL here');
console.log(result);
```

---

## Project Structure Best Practices

### File Organization

```
src/
├── agent/           # Core agent roles
│   ├── orchestrator.ts
│   ├── planner.ts
│   ├── sqlWriter.ts
│   ├── interpreter.ts
│   ├── guard.ts
│   └── __tests__/   # Tests next to code
├── tools/           # Utility functions
│   ├── db.ts
│   ├── schema.ts
│   ├── semantics.ts
│   └── logs.ts
├── types.ts         # Shared types
├── config.ts        # Configuration
└── index.ts         # CLI entry point
```

### Naming Conventions

- **Files**: `camelCase.ts` (e.g., `sqlWriter.ts`)
- **Classes**: `PascalCase` (e.g., `class Orchestrator`)
- **Functions**: `camelCase` (e.g., `function validateSQL()`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `const MAX_ROWS = 200`)
- **Interfaces**: `PascalCase` (e.g., `interface SQLResult`)

---

## Contributing Checklist

Before submitting a pull request:

- [ ] Code compiles: `npm run typecheck`
- [ ] Tests pass: `npm test`
- [ ] Added tests for new functionality
- [ ] Added JSDoc comments for public APIs
- [ ] Updated CHANGELOG.md
- [ ] Updated relevant documentation
- [ ] No console.log (use proper logging)
- [ ] No hardcoded values (use config)
- [ ] Error handling implemented
- [ ] Types defined (no `any`)

---

## Getting Help

- **Setup issues**: See main [`README.md`](../README.md)
- **Architecture questions**: See [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Database questions**: See [`CONTROL_DB_SCHEMA.md`](./CONTROL_DB_SCHEMA.md)

## Reference

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Vitest Documentation](https://vitest.dev/)
- [pg (node-postgres) Documentation](https://node-postgres.com/)
- [Google Gemini API](https://ai.google.dev/docs)

---

## Documentation Guidelines

### The 5+1 Rule

We maintain exactly **5 documentation files** in `/docs` + 1 root README:

1. **`README.md`** (root) - New developer onboarding (< 300 lines)
2. **`docs/ARCHITECTURE.md`** - How the system works (technical design)
3. **`docs/ROADMAP.md`** - Where we're going (future plans)
4. **`docs/SESSION_NOTES.md`** - What we built (session logs)
5. **`docs/CONTROL_DB_SCHEMA.md`** - Database reference
6. **`docs/DEVELOPMENT.md`** - How to contribute (this file)

### Where Does New Content Go?

**"How does X work?"** → `ARCHITECTURE.md` (add a section)  
**"We should build Y"** → `ROADMAP.md` (add to appropriate phase)  
**"We just built Z"** → `SESSION_NOTES.md` (add at top)  
**"How do I set up?"** → `README.md` (keep brief, link to docs)  
**"How do I contribute?"** → `DEVELOPMENT.md` (add pattern/workflow)  
**"What's in the database?"** → `CONTROL_DB_SCHEMA.md` (update schema)

### ❌ Never Create

- ❌ Feature-specific docs (e.g., `SMART_MODE.md`) → Use `ARCHITECTURE.md` sections instead
- ❌ Phase summaries (e.g., `PHASE2_SUMMARY.md`) → Use `SESSION_NOTES.md`
- ❌ Duplicate guides or READMEs
- ❌ Index files (e.g., `docs/README.md`) → Unnecessary with only 5 files

### ✅ When to Update

- **Every session**: Update `SESSION_NOTES.md` at top
- **After feature**: Add section to `ARCHITECTURE.md`
- **New idea/plan**: Add to `ROADMAP.md`
- **Schema change**: Update `CONTROL_DB_SCHEMA.md`
- **New pattern**: Add to `DEVELOPMENT.md`

### Pre-Commit Documentation Checklist

Before committing changes:

- [ ] No new files in `/docs` (only the 5 allowed files)
- [ ] `SESSION_NOTES.md` updated with today's work
- [ ] If new feature: Added section to `ARCHITECTURE.md`
- [ ] If schema changed: Updated `CONTROL_DB_SCHEMA.md`
- [ ] If new pattern: Added to `DEVELOPMENT.md`
- [ ] Documentation follows the 5+1 rule

### Why This Structure?

1. **Simple** - Only 6 files to maintain
2. **Clear** - Each file has one distinct purpose
3. **Enforceable** - Rules in this guide + `.cursorrules`
4. **Scalable** - Works as project grows
5. **No Redundancy** - Each piece of info lives in one place
6. **Easy to Navigate** - New devs know where to look

---

**Happy coding!** 🚀
