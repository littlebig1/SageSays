# System Architecture

High-level architecture and design decisions for SageSays.

## Overview

SageSays is a **Level-2 agentic system** that uses role-based orchestration to convert natural language questions into SQL queries, execute them safely, and provide natural language answers.

**Level-2 Agentic System** means:
- Multiple specialized roles (Planner, SQL Writer, Interpreter, Guard)
- Multi-step query decomposition and execution
- Self-refinement based on intermediate results
- Context preservation across steps

---

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    CLI (index.ts)                        │
│  • Command handling (/debug, /help, /show-*)            │
│  • User interaction loop                                │
│  • Debug mode management                                │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│              Orchestrator (orchestrator.ts)              │
│  • Multi-step workflow coordination                     │
│  • Schema loading & caching                             │
│  • Plan refinement (max 3 iterations)                   │
│  • Context management for multi-step queries            │
└──┬──────────┬──────────┬──────────┬─────────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐
│Planner │ │SQL     │ │Interpret.│ │Guard   │
│        │ │Writer  │ │          │ │        │
└────────┘ └────────┘ └──────────┘ └────────┘
   │          │          │          │
   └──────────┴──────────┴──────────┘
                   │
                   ▼
         ┌──────────────────────┐
         │    Tools Layer        │
         │  • db.ts (SQL exec)  │
         │  • schema.ts (cache) │
         │  • semantics.ts      │
         │  • logs.ts           │
         └──────────────────────┘
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
   ┌──────────┐      ┌──────────────┐
   │Inspected │      │  Control DB  │
   │ Database │      │  (optional)  │
   │(Read-only)│     │ • Semantics  │
   │          │      │ • Run logs   │
   └──────────┘      └──────────────┘
```

---

## Core Components

### 1. Orchestrator (`orchestrator.ts`)

**Responsibility**: Main workflow coordination

**Key Functions**:
- `execute(question, requestPermission?)` - Main entry point
  - Loads database schema
  - Creates initial plan
  - Executes plan steps
  - Manages refinement loop (max 3 iterations)
  - Saves run logs

**Flow**:
1. Load schema from inspected database
2. Create plan via Planner
3. For each step in plan:
   - Generate SQL via SQL Writer
   - Validate via Guard
   - Request permission if debug mode
   - Execute SQL
   - Interpret results via Interpreter
   - Decide: continue, refine, or finalize
4. Save run log (if control DB configured)

**Context Management**:
- Maintains `previousResults` array for SQL Writer context
- Passes executed steps to Interpreter for decision-making
- Allows plan refinement based on intermediate results

---

### 2. Planner (`planner.ts`)

**Responsibility**: Break down questions into step-by-step plans

**Key Functions**:
- `createPlan(question, schema, previousSteps?)` - Generate execution plan

**Process**:
1. Receives user question + database schema + semantics
2. Sends to Gemini LLM with structured prompt
3. Returns JSON plan with steps

**Output Format**:
```typescript
{
  overallGoal: "Description of what we're trying to achieve",
  steps: [
    {
      stepNumber: 1,
      description: "What to do in this step",
      reasoning: "Why this step is necessary"
    },
    // ... more steps
  ]
}
```

**Refinement**: Can be called multiple times if initial results are insufficient.

---

### 3. SQL Writer (`sqlWriter.ts`)

**Responsibility**: Generate PostgreSQL SELECT queries

**Key Functions**:
- `generateSQL(step, question, schema, previousResults?)` - Generate SQL for a plan step

**Process**:
1. Receives plan step + schema + semantics + previous results
2. Constructs prompt with:
   - Available table names (explicit list)
   - Schema details
   - Business semantics
   - Context from previous queries
3. Sends to Gemini LLM
4. Returns raw SQL (cleaned of markdown)

**Safety**:
- Does NOT add LIMIT (Guard does this)
- Does NOT execute SQL (Orchestrator does this)
- Explicitly warned against using "undefined" as table name

---

### 4. Interpreter (`interpreter.ts`)

**Responsibility**: Analyze results and decide next action

**Key Functions**:
- `interpret(question, step, result, allSteps, completedSteps)` - Analyze query results

**Output**:
```typescript
{
  status: 'FINAL_ANSWER' | 'NEEDS_REFINEMENT',
  answer?: string,              // If FINAL_ANSWER
  nextStep?: string,            // If NEEDS_REFINEMENT
  confidence: 'high' | 'medium' | 'low'
}
```

**Logic**:
- If results fully answer question → `FINAL_ANSWER`
- If more queries needed → `NEEDS_REFINEMENT`
- Considers data completeness, anomalies, empty results

---

### 5. Guard (`guard.ts`)

**Responsibility**: Validate SQL for safety and correctness

**Key Functions**:
- `validateSQL(sql)` - Validate and sanitize SQL

**Checks**:
1. ✅ Empty SQL
2. ✅ Dangerous keywords (INSERT, UPDATE, DELETE, DROP, etc.)
3. ✅ Only SELECT or WITH...SELECT allowed
4. ✅ "undefined" as table name (LLM hallucination)
5. ✅ Multiple statements
6. ✅ Auto-append LIMIT if missing

**Output**:
```typescript
{
  valid: boolean,
  reason?: string,           // If invalid
  sanitizedSQL?: string      // If valid (with LIMIT added)
}
```

---

## Tools Layer

### Database (`db.ts`)

**Functions**:
- `getInspectedDbPool()` - Singleton connection pool
- `runSQL(sql)` - Execute SQL with validation
- `closeInspectedDbPool()` - Cleanup

**Safety**:
- Read-only user (recommended)
- Statement timeout (default: 10 seconds)
- Auto-validation via Guard
- Row limit enforcement

---

### Schema (`schema.ts`)

**Functions**:
- `loadSchemaFromDB(client)` - Load from database
- `getSchema(client, useCache?)` - Load with caching
- `formatSchemaForLLM(schema, tableName?)` - Format for prompts
- `clearSchemaCache()` - Invalidate cache

**Caching**:
- In-memory cache (fastest)
- File cache (`data/schema_cache.json`)
- Database load (slowest, but always current)

**Cache Strategy**:
1. Check in-memory cache
2. If miss, check file cache
3. If miss, load from database and cache

---

### Semantics (`semantics.ts`)

**Functions**:
- `initializeControlDB()` - Create tables if needed
- `getSemantics(category?, term?)` - Retrieve semantics
- `saveSemantic(semantic)` - Save new semantic
- `getSemanticEntities(entityType?)` - Full entity retrieval
- `formatSemanticsForLLM(semantics)` - Format for prompts

**Purpose**: Store business logic, domain concepts, calculation rules

**Schema**: See [`CONTROL_DB_SCHEMA.md`](./CONTROL_DB_SCHEMA.md)

---

### Logs (`logs.ts`)

**Functions**:
- `saveRunLog(question, sqlQueries, rowsReturned, durationsMs)` - Save execution log
- `getRecentRunLogs(limit)` - Retrieve recent logs

**Purpose**: Track query history for learning and optimization

---

## Data Flow

### Typical Query Flow

```
1. User asks: "How many orders were created yesterday?"
   ↓
2. Orchestrator loads schema + semantics
   ↓
3. Planner creates plan:
   Step 1: Get count of orders with created_date = yesterday
   ↓
4. SQL Writer generates:
   SELECT COUNT(*) FROM orders 
   WHERE created_date >= CURRENT_DATE - INTERVAL '1 day'
   AND created_date < CURRENT_DATE
   ↓
5. Guard validates and adds LIMIT:
   SELECT COUNT(*) FROM orders 
   WHERE created_date >= CURRENT_DATE - INTERVAL '1 day'
   AND created_date < CURRENT_DATE
   LIMIT 200;
   ↓
6. Database executes query → returns 1 row: [42]
   ↓
7. Interpreter analyzes:
   Status: FINAL_ANSWER
   Answer: "42 orders were created yesterday"
   ↓
8. Orchestrator saves run log
   ↓
9. CLI displays answer to user
```

---

## Design Decisions

### 1. Why Separate Roles?

**Benefit**: Each role has a focused responsibility
- Planner: High-level strategy
- SQL Writer: Technical SQL generation
- Interpreter: Result analysis
- Guard: Safety validation

**Alternative considered**: Single LLM call for everything
**Why rejected**: Less flexible, harder to debug, can't iterate on plan

---

### 2. Why Level-2 (Multi-Step)?

**Benefit**: Handle complex questions that require multiple queries

**Example**:
```
Question: "Which product category has the highest average order value?"

Step 1: Get all product categories
Step 2: For each category, calculate average order value
Step 3: Find the maximum
```

**Alternative considered**: Single SQL query
**Why rejected**: LLM often fails at complex JOINs and subqueries

---

### 3. Why Separate Control Database?

**Benefits**:
- Don't pollute inspected database
- Can use different database provider (Neon, Supabase)
- Semantics survive across different inspected DBs
- Optional - system works without it

**Alternative considered**: Store in inspected database
**Why rejected**: Requires write permissions, mixes concerns

---

### 4. Why PostgreSQL Only?

**Current**: System is PostgreSQL-specific
- Schema introspection queries
- SQL syntax (e.g., `::` casting)
- Array types in control DB

**Future**: Could be extended to other databases with:
- Abstraction layer for schema loading
- Database-specific SQL generation
- Dialect configuration

---

### 5. Why Debug Mode?

**Use Cases**:
- Development and testing
- Understanding query generation
- Building trust with users
- Learning system behavior

**Implementation**: Optional callback in Orchestrator

---

### 6. SMART Debug Mode

**What is SMART Mode?**

SMART mode is an intelligent debug mode (default) that automatically decides when to ask for user approval before executing SQL queries. It considers **both** semantic coverage and confidence level.

**Decision Logic**:
```
Query Ready to Execute
│
├─ Has semantics detected?
│  ├─ YES → Check confidence level
│  │  ├─ Confidence >= 95% → ✅ AUTO-EXECUTE
│  │  └─ Confidence < 95%  → ⚠️  ASK FOR APPROVAL
│  │
│  └─ NO  → ⚠️  ASK FOR APPROVAL
```

**Auto-execute requires BOTH**:
1. ✅ Semantics detected in user question
2. ✅ Confidence level meets threshold (configurable via `DEBUG_MODE_CONFIDENCE_THRESHOLD`, default: 95%)

**Ask for approval if EITHER fails**:
1. ❌ No semantics detected
2. ❌ Confidence below threshold

**Three Debug Modes Available**:
- **SMART** (default) - Intelligent approval based on semantics + confidence
- **ON** - Always ask for approval (safety first)
- **OFF** - Never ask for approval (speed first)

**Configuration**:
```env
DEBUG_MODE_CONFIDENCE_THRESHOLD=95  # Percentage (0-100)
# 95 = conservative (default)
# 80 = balanced
# 60 = aggressive
# 0 = semantics-only (ignore confidence)
```

**Benefits**:
- Safety + Speed - High-quality queries execute immediately
- Intelligent Automation - System learns when to trust itself
- Semantic Incentive - Users see value of semantics
- Configurable Risk Tolerance - Adjust threshold to needs
- Full Transparency - SQL always displayed

**User Experience Example**:
```
# With semantics (auto-execute):
📄 SQL: SELECT COUNT(*) FROM orders WHERE...
✓ Auto-executing (semantics: ✓, confidence: 95%)

# Without semantics (ask):
📄 SQL: SELECT * FROM products LIMIT 200
🤔 [SMART MODE] - Review required:
⚠️  Reason(s): no semantics detected
Execute this query? (y/n):
```

---

### 7. Semantic Storage Design

**Core Principle**: Trust requires transparency and control

#### **Why Relational Database (PostgreSQL)?**

We chose PostgreSQL over vector databases or document stores for semantic storage because:

**1. User Trust & Transparency**

Users need to **see, understand, edit, and delete** semantics to trust the system.

```
Relational DB:
┌──────────┬──────────┬─────────────┬──────────┬──────────┐
│ Name     │ Category │ Confidence  │ Source   │ Approved │
├──────────┼──────────┼─────────────┼──────────┼──────────┤
│ yesterday│ Time     │ 95%         │ learned  │ ✓        │
│ GMV      │ Metrics  │ 100%        │ manual   │ ✓        │
│ revenue  │ Metrics  │ 85%         │ learned  │ pending  │
└──────────┴──────────┴─────────────┴──────────┴──────────┘
✅ Human-readable, auditable, editable

Vector DB:
[0.234, -0.876, 0.123, ... 1533 more floats]
❌ Black box, no visibility, hard to trust
```

**2. Structured Data Nature**

Semantics ARE structured:
- Name, category, description (strings)
- SQL fragments (code)
- Confidence scores (numbers)
- Approval status (boolean)
- Timestamps, relationships (IDs)

This fits relational models perfectly.

**3. Complex Querying**

Common operations require structured queries:
```sql
-- Filter pending suggestions with high confidence
SELECT * FROM semantic_suggestions 
WHERE status = 'pending' 
  AND confidence > 0.80
ORDER BY created_at DESC;

-- Find all learned semantics by category
SELECT * FROM semantic_entities
WHERE source = 'learned'
  AND category = 'Financial Metrics';

-- Join suggestions with their source queries
SELECT s.*, r.question, r.sql_generated
FROM semantic_suggestions s
JOIN run_logs r ON s.source_run_log_id = r.id;
```

These are trivial in SQL, painful in vector databases.

**4. Transactional Integrity**

Approval workflow requires ACID guarantees:
```sql
BEGIN;
  -- Approve suggestion
  UPDATE semantic_suggestions 
  SET status = 'approved', reviewed_by = 'user@example.com'
  WHERE id = $1;
  
  -- Create semantic entity
  INSERT INTO semantic_entities (...) 
  VALUES (...);
COMMIT;
```

Must happen atomically or not at all.

**5. Familiar Tooling**

- SQL queries for debugging
- pgAdmin/DataGrip for inspection
- Standard backup/restore
- Your team already knows it

#### **What About Vector Search?**

**Current (Phase 3-4)**: Simple text matching
```typescript
// Exact match on name, synonyms, abbreviations
if (question.includes(semantic.name)) { /* match */ }
```

**Sufficient for**: < 50 semantics, common terms

**Future (Phase 5+)**: Add pgvector extension
```sql
-- Add vector column to existing table
ALTER TABLE semantic_entities 
ADD COLUMN description_embedding vector(1536);

-- Semantic similarity search
SELECT name, description,
       1 - (description_embedding <=> $1) as similarity
FROM semantic_entities
WHERE 1 - (description_embedding <=> $1) > 0.7
ORDER BY similarity DESC;
```

**Benefits**:
- Find semantics by meaning, not keywords
- Handle typos: "yesturday" → "yesterday"
- Match synonyms: "income" → "revenue"
- **Still in PostgreSQL** - no sync complexity!

**When to use separate vector DB** (Pinecone, Weaviate):
- Only if you have 1000+ semantics
- Only if pgvector performance degrades
- Not needed for 99% of use cases

#### **Hybrid Approach**

If you eventually need a dedicated vector DB:

```
PostgreSQL (Source of Truth)
  ├─ Structured fields (name, category, SQL, confidence)
  ├─ User can see, edit, delete
  ├─ Approval workflow, transactions
  └─ Single source of truth
       ↓
    [Sync on write]
       ↓
Vector DB (Retrieval Index)
  ├─ Format semantics as documents
  ├─ Embed full context (not just description)
  ├─ Fast semantic search
  └─ Return IDs → fetch details from PostgreSQL
```

**Document Format** (better than per-field embeddings):
```typescript
function formatSemanticAsDocument(semantic: SemanticEntity): string {
  return `
Semantic: ${semantic.name} (${semantic.category})
Description: ${semantic.description}
SQL: ${semantic.sql_fragment}
Tables: ${semantic.primary_table}
Notes: ${semantic.notes?.join('; ')}
Common Mistakes: ${semantic.anti_patterns?.wrong}
  `.trim();
}
// Embed entire document → Rich context for retrieval
```

#### **UI/UX Implications**

**Critical for trust**: Users must be able to:

1. **View All Semantics**
   - Filterable table (by category, source, confidence)
   - Search by name
   - See full details on click

2. **Edit Semantics**
   - Inline editing of descriptions
   - Update SQL fragments
   - Add notes, fix mistakes
   - Version history (future)

3. **Delete Semantics**
   - Soft delete (mark as inactive)
   - Hard delete (admin only)
   - Audit trail of deletions

4. **Approve Suggestions**
   - Review queue (pending suggestions)
   - Side-by-side comparison (before/after)
   - Accept/Reject/Modify workflow
   - Review notes and reasoning

5. **Track Learning**
   - Which semantics came from corrections?
   - Success rate of learned semantics
   - Most-used vs never-used semantics
   - Learning velocity over time

**Future**: Web UI for semantic management (currently CLI-only)

#### **Key Takeaway**

**Relational database for semantics = transparency = trust**

Users can't trust a black box. They need to:
- See what the system knows
- Understand where it learned it
- Fix mistakes when they happen
- Delete bad semantics
- Control the knowledge base

PostgreSQL provides this. Vector databases don't (yet).

---

## Safety Mechanisms

### 1. SQL Validation (Guard)

- Block dangerous keywords
- Only SELECT or WITH...SELECT
- Auto-LIMIT to prevent large result sets
- Detect LLM hallucinations ("undefined" table)

### 2. Database Safety

- Read-only user (recommended)
- Statement timeout (10 seconds default)
- Connection pooling with limits
- Automatic cleanup

### 3. Result Limiting

- Auto-append LIMIT 200 to queries
- Configurable via `MAX_ROWS` env var
- Truncate results sent to LLM (`MAX_RESULT_ROWS_FOR_LLM`)

### 4. Error Handling

- Graceful degradation (control DB optional)
- Context-rich error messages
- Proper error propagation
- User-friendly error display

### 5. Retry Logic with Exponential Backoff

All LLM API calls (Planner, SQL Writer, Interpreter) include automatic retry logic to handle temporary failures:

**Retryable Errors**:
- **503 Service Unavailable** - API temporarily overloaded
- **429 Too Many Requests** - Rate limit exceeded
- **Network Errors** - ECONNRESET, ETIMEDOUT, ENOTFOUND

**Configuration** (in `src/utils/retry.ts`):
```typescript
{
  maxRetries: 3,              // Maximum retry attempts
  initialDelayMs: 1000,       // Start with 1 second
  maxDelayMs: 10000,          // Cap at 10 seconds
  backoffMultiplier: 2,       // Double each time: 1s, 2s, 4s
}
```

**Behavior**:
1. Attempt 1: Immediate execution → Fails with 503
2. Wait 1 second → Attempt 2: Retry → Fails
3. Wait 2 seconds → Attempt 3: Retry → Fails
4. Wait 4 seconds → Attempt 4: Retry → Success or give up

**User Experience**:
- Progress updates during retries: `⚠️  API overloaded. Retrying in 2s... (attempt 2/3)`
- Success notification: `✓ Retry succeeded on attempt 3`
- User-friendly error after exhaustion with actionable suggestions

**Implementation**: See `retryWithBackoff()` in `src/utils/retry.ts`

---

## Extension Points

### Adding New Commands

Add to `handleCommand()` in `index.ts`:

```typescript
case '/your-command':
  // Your logic here
  return false;  // false = don't exit, true = exit
```

### Adding New Agent Roles

1. Create new file in `src/agent/`
2. Follow pattern: class with methods
3. Initialize in Orchestrator
4. Call during execution flow

### Adding New Database

1. Create adapter in `tools/` (e.g., `mysql.ts`)
2. Implement same interface as `db.ts`
3. Update config to select database type
4. Update SQL Writer prompts for dialect

---

## Performance Considerations

### 1. Schema Caching

- In-memory cache for speed
- File cache persists across restarts
- Refresh with `/refresh-schema` command

### 2. LLM Calls

- Most expensive operation
- 3 calls per simple query (Planner, SQL Writer, Interpreter)
- More calls if refinement needed
- Consider caching common patterns

### 3. Database Queries

- Read-only recommended (faster)
- Connection pooling (max 5 connections)
- Timeouts prevent hanging
- Indexes on control DB for semantics lookup

---

## Security Considerations

### 1. SQL Injection

**Mitigation**:
- LLM generates SQL (not user input directly)
- Guard validates all SQL
- Parameterized queries where possible

**Remaining risk**: LLM could still be prompt-injected

### 2. Data Exposure

**Mitigation**:
- Read-only database user
- Row limits on results
- Control DB isolated

### 3. API Key Security

**Mitigation**:
- Keys in `.env` (not committed)
- `.gitignore` includes `.env`
- No logging of API keys

---

## Testing Strategy

### Unit Tests

- **Guard**: All validation rules
- **Tools**: Database operations, schema loading
- **Config**: Environment variable loading

### Integration Tests

- End-to-end query execution
- Multi-step query flows
- Error handling paths

### Manual Testing

- CLI commands
- Debug mode
- Schema refresh
- Real database queries

---

## Future Enhancements

### Planned

1. **Semantic Learning**
   - Automatic extraction from conversations
   - User correction capture
   - Approval workflow

2. **Query Pattern Recognition**
   - Learn common question types
   - Cache successful patterns
   - Suggest similar past queries

3. **Multi-Database Support**
   - MySQL, SQLite, etc.
   - Database adapter pattern
   - Dialect-aware SQL generation

### Under Consideration

- Web UI instead of CLI
- Query visualization
- Explain mode (show query logic)
- Batch query processing
- API endpoint for programmatic access

---

## Related Documentation

- **Setup**: [`../README.md`](../README.md)
- **Development**: [`DEVELOPMENT.md`](./DEVELOPMENT.md)
- **Database Schema**: [`CONTROL_DB_SCHEMA.md`](./CONTROL_DB_SCHEMA.md)
- **Roadmap**: [`ROADMAP.md`](./ROADMAP.md)
- **Changelog**: [`../CHANGELOG.md`](../CHANGELOG.md)
