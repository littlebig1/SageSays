# SageSays Roadmap

> **Last Updated**: 2026-01-19  
> **Current Version**: v1.2.0  
> **Next Target**: v1.3.0 - Learning from User Corrections  
> **Parallel Track**: Phase 7.1 - Testing Quick Wins (optional, recommended before Phase 4)

---

## 🎯 Vision

Transform SageSays from a basic SQL agent into an intelligent system that **learns from user interactions** and **improves over time** by capturing business semantics and query patterns.

---

## 📍 Current Status

### ✅ Phase 1: Control Database Foundation (v1.1.0) - **COMPLETED**

**Goal**: Establish solid control database foundation

**Completed Items**:
- [x] Connect to Neon control database
- [x] Document actual schema (30+ fields in semantic_entities!)
- [x] Align code with database schema
  - [x] Use `primary_table` / `primary_column` (not `table_ref`)
  - [x] Use `sql_generated` / `sql_executed` in run_logs
- [x] Test semantics retrieval (4 time period entities confirmed)
- [x] Test run logs saving
- [x] Clean up conflicting schemas and documentation
- [x] Validate everything compiles and tests pass

**Outcome**: ✅ Solid foundation with clean, documented schema

---

## ✅ Phase 2: Basic Semantic Integration (v1.2.0) - **COMPLETED**

**Goal**: Make the system use existing semantics to improve query generation

### 2.1 Integrate Semantics into Prompts ✅

**Completed Tasks**:
- [x] Updated `Planner.createPlan()` to include semantics in prompt
  - [x] Enhanced `formatSemanticsForLLM()` with better formatting
  - [x] Added explicit instructions to use semantic definitions
  - [x] Semantics properly formatted and included

- [x] Updated `SQLWriter.generateSQL()` to include semantics in prompt
  - [x] Enhanced prompt with critical instructions
  - [x] Added semantic definition application requirement
  - [x] Improved date/time handling guidance

- [x] Updated `Interpreter.interpret()` to reference semantics
  - [x] Added semantics context to interpretation
  - [x] Helps LLM understand user intent better

**Testing**:
```bash
# Test with existing semantics
npm run dev
> /show-semantics  # Should show 4 time periods
> How many orders were created yesterday?
> How many orders this month?
```

**Expected Outcome**: LLM correctly interprets "yesterday", "this month" using semantics

### 2.2 Track Semantic Usage ✅

**Completed Tasks**:
- [x] Updated `run_logs` to track semantic usage
  - [x] Populates `detected_semantics` field (semantic IDs found in question)
  - [x] Populates `semantics_applied` field (semantics used in SQL generation)

- [x] Added function `detectSemantics(question: string): string[]`
  - [x] Uses word boundary matching for accurate detection
  - [x] Returns IDs of matching semantic entities
  - [x] Tested with multiple time period questions

- [x] Updated `Orchestrator.execute()` to:
  - [x] Detect semantics before planning
  - [x] Display detection count to user
  - [x] Pass detected semantics to `saveRunLog()`

**Testing**:
```bash
npx tsx scripts/test-semantic-detection.ts
# ✅ Correctly detects "yesterday", "today", "this month", "last month"
```

### 2.3 Measure Impact ⏳ (Deferred to real-world testing)

**Deferred Tasks** (will measure through actual usage):
- [ ] Create comparison script `scripts/compare-with-without-semantics.ts`
- [ ] Run same questions with/without semantics
- [ ] Measure: Query accuracy, SQL correctness, execution success rate

**Success Criteria - ALL MET**:
- ✅ Semantics are used in prompts (Planner, SQL Writer, Interpreter)
- ✅ Semantic usage is tracked in run_logs (detected_semantics, semantics_applied)
- ⏳ Queries measurably better with semantics (requires real-world testing)

**Outcome**: ✅ **Phase 2 complete - system now actively uses semantics!**

---

## 📋 Phase 3: Learning from User Corrections (v1.3.0)

**Goal**: Automatically learn new semantics from user corrections

### 3.1 Capture Corrections

**Tasks**:
- [ ] Add correction detection in CLI
  - [ ] Detect keywords: "wrong", "incorrect", "that's not right"
  - [ ] Prompt: "What was wrong? / What should it be?"
  - [ ] Store correction details

- [ ] Create `CorrectionCapture` interface
  ```typescript
  interface CorrectionCapture {
    run_log_id: string;
    user_feedback: string;
    correct_answer?: string;
    correction_type: 'wrong_result' | 'wrong_sql' | 'wrong_interpretation';
  }
  ```

- [ ] Update `run_logs` table usage:
  - [ ] Set `was_corrected = true`
  - [ ] Store in `user_feedback` JSONB field

### 3.2 Extract Semantic Patterns

**Tasks**:
- [ ] Create `SemanticLearner` class
  - [ ] `analyzeCorrection(runLog, correction): SemanticSuggestion`
  - [ ] Use LLM to identify missing semantic knowledge
  - [ ] Generate structured suggestion

- [ ] Implement pattern extraction:
  ```typescript
  // Example: User says "Revenue should exclude canceled orders"
  // System extracts:
  {
    suggested_name: "Revenue Calculation",
    suggested_type: "BUSINESS_RULE",
    suggested_definition: {
      has_complex_logic: true,
      complex_logic: { /* rules */ },
      anti_patterns: { /* wrong approaches */ }
    }
  }
  ```

- [ ] Save to `semantic_suggestions` table
  - [ ] Status: 'pending'
  - [ ] Confidence score based on evidence strength
  - [ ] Link to source run_log_id

### 3.3 Approval Workflow

**Tasks**:
- [ ] Create `/review-suggestions` CLI command
  - [ ] List pending suggestions
  - [ ] Show evidence (original question, SQL, correction)
  - [ ] Prompt: Approve / Reject / Modify

- [ ] Approval actions:
  - [ ] Approve → Create new semantic_entity
  - [ ] Reject → Mark suggestion as rejected
  - [ ] Modify → Edit suggestion, then approve

- [ ] Update semantic_suggestions:
  - [ ] Set `reviewed_by` (username or email)
  - [ ] Set `reviewed_at` timestamp
  - [ ] Set `status` ('approved' / 'rejected')

  📋 Phase 3.3 Checklist (Future Reference)
When implementing Phase 3.3, address:
[ ] Don't reset context on query rejection
[ ] Create run_log entry for rejected queries
[ ] Add execution_status column to run_logs
[ ] Modify correction capture to handle missing execution data
[ ] Update correction prompt after rejection
[ ] Add /edit option to debug mode prompt
[ ] Test pre-execution correction flow
[ ] Update documentation
[ ] Update test plan


**Success Criteria**:
- ✅ System detects corrections
- ✅ Extracts semantic patterns automatically
- ✅ Human can review and approve
- ✅ Approved suggestions become semantics

---

## 📋 Phase 4: Complex Logic Handling (v1.4.0)

**Goal**: Handle sophisticated business rules like the order_item_states example

### 4.1 Support Complex Logic Schema

**Tasks**:
- [ ] Fully utilize `semantic_entities.complex_logic` JSONB field
  ```typescript
  interface ComplexLogic {
    correct_approach: string;
    wrong_approaches: string[];
    required_tables: string[];
    required_joins: string[];
    filters: string[];
    warnings: string[];
    examples: {
      question: string;
      correct_sql: string;
      wrong_sql: string;
      explanation: string;
    }[];
  }
  ```

- [ ] Update `formatSemanticsForLLM()` to include complex logic
- [ ] Test with revenue calculation example

### 4.2 Anti-Pattern Detection

**Tasks**:
- [ ] Use `anti_patterns` JSONB field
- [ ] Create `detectAntiPatterns(sql: string): AntiPattern[]`
- [ ] Warn user when anti-pattern detected
- [ ] Suggest correction automatically

**Example**:
```typescript
// Detect: SELECT SUM(order_value) WHERE status_latest = 'CONFIRMED'
// Warning: "Using status_latest snapshot - may miss cancellations"
// Suggest: "Use order_item_states history instead"
```

### 4.3 Real-World Example: Order Item States

**The Problem**:
- `order_items.status_latest` is a snapshot field
- Revenue queries often use it incorrectly
- Should use `order_item_states` history table instead

**Implementation**:
- [ ] Create semantic entity for "Revenue"
- [ ] Define complex_logic with correct approach
- [ ] Define anti_patterns with status_latest usage
- [ ] Test with actual queries
- [ ] Measure accuracy improvement

**Success Criteria**:
- ✅ System warns about anti-patterns
- ✅ Suggests correct approaches
- ✅ Revenue calculations are accurate

---

## 📋 Phase 5: Enhanced Semantic Discovery (v1.5.0)

**Goal**: Improve semantic detection and add advanced retrieval capabilities

**Note**: After architectural review, we're deferring complex relationships and focusing on practical improvements first.

### 5.1 Semantic Search Enhancement (pgvector)

**Rationale**: As semantics grow (50+), exact text matching becomes limiting. Semantic search finds relevant semantics even with synonyms, typos, and paraphrasing.

**Tasks**:
- [ ] **Add pgvector extension to PostgreSQL**
  - [ ] Enable extension: `CREATE EXTENSION vector`
  - [ ] Add vector column to `semantic_entities`
  - [ ] Create vector index for fast similarity search

- [ ] **Generate embeddings for semantics**
  - [ ] Add `description_embedding vector(1536)` column
  - [ ] Generate embeddings on semantic create/update
  - [ ] Use OpenAI ada-002 or similar model
  - [ ] Store embeddings alongside structured data

- [ ] **Implement semantic similarity search**
  - [ ] Replace regex-based `detectSemantics()` with vector search
  - [ ] Find semantics by meaning, not just keywords
  - [ ] Handle typos: "yesturday" → "yesterday"
  - [ ] Match synonyms: "income" → "revenue"
  - [ ] Rank by relevance (cosine similarity)

- [ ] **Hybrid detection strategy**
  - [ ] Exact match (fast path): Check synonyms, abbreviations
  - [ ] Semantic search (fallback): Vector similarity when no exact match
  - [ ] Combine both: Boost exact matches, add semantic matches

**Example Improvement**:
```
Before (regex):
  "What's our income?" → No match (doesn't contain "revenue")

After (vector search):
  "What's our income?" → Matches "revenue" (95% similarity)
  "show me yesterdays sales" → Matches "yesterday" + "revenue" (handles typo)
```

**Estimated Effort**: 3-4 hours

### 5.2 Semantic Relationships (Optional - Defer if Not Needed)

**Decision**: Start without relationships table. LLMs understand context from descriptions alone.

**Add ONLY IF you observe**:
- Repeated errors where LLM misses dependencies
- Need for validation rules (contradictory semantics)
- Complex multi-step calculations requiring ordered loading

**If needed, implement**:
- [ ] Create `semantic_relationships` table
  - [ ] Types: DEPENDS_ON, REQUIRES, CONTRADICTS, RELATED_TO
  - [ ] Load related semantics automatically
  - [ ] Validate semantic combinations

**For now**: Use rich descriptions, notes, and anti_patterns instead

### 5.3 Context Hints

**Tasks**:
- [ ] Use `context_hints` table
- [ ] Load hints by domain/type
- [ ] Include in prompts
- [ ] Test with existing hints (already have 3!)

### 5.3 Query Patterns

**Tasks**:
- [ ] Implement `query_patterns` recognition
- [ ] Match question to known patterns
- [ ] Suggest cached SQL templates
- [ ] Track pattern usage

**Success Criteria**:
- ✅ Related semantics are loaded together
- ✅ Context hints improve query generation
- ✅ Common patterns are recognized and reused

---

## 📋 Phase 6: Advanced Features (v2.0.0)

### 6.1 Confidence Scoring

- [ ] Track semantic confidence scores
- [ ] Update based on usage success
- [ ] Demote low-confidence semantics
- [ ] Promote high-success semantics

### 6.2 Semantic Versioning

- [ ] Use `semantic_entities.version` field
- [ ] Track changes over time
- [ ] Allow rollback if needed
- [ ] History of modifications

### 6.3 Collaborative Learning

- [ ] Multi-user semantic contributions
- [ ] Voting on suggestions
- [ ] Expert review required for critical semantics
- [ ] Audit trail

### 6.4 Analytics Dashboard

- [ ] Web UI for reviewing semantics
- [ ] Usage statistics
- [ ] Success rates
- [ ] Learning velocity

---

## 🐛 Known Issues

**Current**:
- None blocking - all tests passing ✅

**Future Considerations**:
- Performance: Loading all semantics on every query (optimize with caching)
- LLM cost: Multiple calls per query (implement prompt caching)
- Schema changes: Control DB schema may evolve (migration strategy needed)

---

## 📋 Phase 8: Performance & Query Optimization (v2.1.0)

**Goal**: Intelligently handle query timeouts and optimize slow queries

### 8.1 Smart Timeout Handling

**Current Behavior**:
- Query times out → Error shown → User stuck
- No insight into why query is slow
- No automatic optimization attempts

**Proposed Flow**:

```
1. Query Execution
   ↓
2. Timeout Detected (> STATEMENT_TIMEOUT_MS)
   ↓
3. Run EXPLAIN on the query
   ↓
4. Analyze EXPLAIN Output (LLM-assisted)
   - Detect: Full table scans on large tables
   - Identify: Missing indexes
   - Find: Inefficient joins or subqueries
   - Check: Suboptimal query patterns
   ↓
5. Generate Optimized Query (LLM-assisted)
   - Add better WHERE conditions
   - Optimize JOIN order
   - Simplify complex subqueries
   - Add appropriate indexes in suggestion
   ↓
6. Present Options to User:
   "⏱️ Query timed out after 10s. I analyzed the query and found:"
   - Issue: Full table scan on 'orders' (5M rows)
   - Suggestion: Add WHERE created_date >= ... to reduce dataset
   
   Options:
   a) Try optimized query (recommended)
   b) Extend timeout to 30s and retry original
   c) Simplify question and try again
   d) Cancel
   ↓
7. User Selects Option
   ↓
8a. Option A: Execute Optimized Query
    - Show both queries side-by-side
    - Execute with extended timeout (2x original)
    - If successful → Offer to save as semantic pattern
    ↓
8b. Option B: Retry with Extended Timeout
    - Increase timeout temporarily
    - Re-execute original query
    - Warn about performance implications
    ↓
9. If Still Times Out:
   - Show EXPLAIN plan comparison
   - Suggest specific indexes:
     CREATE INDEX idx_orders_date ON orders(created_date);
   - Offer to break into smaller queries
   - Save as "difficult query" for learning
```

**Tasks**:
- [ ] **Create `QueryOptimizer` class** (`src/tools/queryOptimizer.ts`)
  - [ ] `runExplain(sql: string): Promise<ExplainOutput>`
  - [ ] `analyzeExplainPlan(explain: ExplainOutput): OptimizationInsights`
  - [ ] `generateOptimizedQuery(sql, insights, schema): Promise<string>`
  - [ ] `compareQueries(original, optimized): ComparisonReport`

- [ ] **Extend Database Tools** (`src/tools/db.ts`)
  - [ ] Add EXPLAIN query support
  - [ ] Add query cancellation support
  - [ ] Track query execution times
  - [ ] Add timeout extension capability

- [ ] **Update Orchestrator** (`src/agent/orchestrator.ts`)
  - [ ] Catch timeout errors gracefully
  - [ ] Trigger optimization workflow
  - [ ] Present options to user
  - [ ] Handle user choice
  - [ ] Retry with optimized query

- [ ] **Add CLI Commands**
  - [ ] `/explain <query>` - Show EXPLAIN plan
  - [ ] `/optimize` - Re-optimize last timed-out query
  - [ ] `/timeout <seconds>` - Adjust timeout threshold

- [ ] **LLM Prompts for Optimization**
  - [ ] Prompt to analyze EXPLAIN output
  - [ ] Prompt to generate optimized query
  - [ ] Include table size information
  - [ ] Include available indexes
  - [ ] Include query patterns from semantics

**Estimated Effort**: 6-8 hours

---

### 8.2 Proactive Performance Analysis

**Tasks**:
- [ ] **Query Complexity Scoring**
  - [ ] Estimate complexity before execution
  - [ ] Warn user if query likely to be slow
  - [ ] Suggest simplifications upfront

- [ ] **Table Statistics Integration**
  - [ ] Query pg_stats for table sizes
  - [ ] Get row count estimates
  - [ ] Include in optimization decisions

- [ ] **Index Recommendations**
  - [ ] Analyze common query patterns
  - [ ] Suggest missing indexes
  - [ ] Generate CREATE INDEX statements
  - [ ] Track which indexes would help most queries

- [ ] **Query Plan Caching**
  - [ ] Cache EXPLAIN results for similar queries
  - [ ] Detect pattern changes (new data, schema changes)
  - [ ] Invalidate cache when needed

**Estimated Effort**: 4-5 hours

---

### 8.3 Performance Monitoring & Learning

**Tasks**:
- [ ] **Track Query Performance** (extend `run_logs`)
  - [ ] Add `execution_time_ms` field
  - [ ] Add `timeout_occurred` boolean
  - [ ] Add `optimization_applied` boolean
  - [ ] Add `explain_plan` JSONB field
  - [ ] Add `optimization_details` JSONB field

- [ ] **Learn from Optimizations**
  - [ ] Save successful optimizations as semantic patterns
  - [ ] Create "performance semantics" category
  - [ ] Example: "Revenue queries should filter by date_range first"
  - [ ] Example: "Order item queries should JOIN states table efficiently"

- [ ] **Performance Dashboard Data**
  - [ ] Average query execution time
  - [ ] Timeout rate
  - [ ] Optimization success rate
  - [ ] Most expensive queries
  - [ ] Most improved queries

**Estimated Effort**: 3-4 hours

---

### 8.4 Advanced Optimization Strategies

**Tasks**:
- [ ] **Query Splitting**
  - [ ] Detect queries that are too broad
  - [ ] Suggest breaking into multiple steps
  - [ ] Offer to run in parallel
  - [ ] Combine results intelligently

- [ ] **Materialized View Suggestions**
  - [ ] Detect repeated expensive queries
  - [ ] Suggest creating materialized views
  - [ ] Generate CREATE MATERIALIZED VIEW statements

- [ ] **Query Result Caching**
  - [ ] Cache results for expensive queries
  - [ ] Invalidation strategy based on data freshness
  - [ ] Show cached result age to user

**Estimated Effort**: 4-6 hours

---

### Success Criteria

- ✅ **Timeout Handling**: 
  - 90%+ of timed-out queries successfully optimized
  - User always has clear options when timeout occurs
  
- ✅ **Query Performance**:
  - Average query execution time < 5 seconds
  - < 5% timeout rate
  
- ✅ **Learning**:
  - Performance optimizations saved as semantics
  - Future similar queries benefit automatically
  
- ✅ **User Experience**:
  - Clear explanations of why queries are slow
  - Actionable suggestions for improvement
  - Transparent performance insights

**Total Estimated Effort**: 17-23 hours (can be done incrementally)

---

## 📋 Phase 7: Testing Infrastructure (v1.x.x - Ongoing)

**Goal**: Improve test coverage and refactor architecture for better testability

**Current Status**: ~5-10% test coverage (only Guard unit tests)

### 7.1 Quick Win Tests (No Refactoring Required)

**Priority**: HIGH - Can implement immediately

**Tasks**:
- [ ] **Semantic Detection Tests** (`src/tools/semantics.ts`)
  - [ ] Test `detectSemantics()` word boundary matching
  - [ ] Test synonym detection (e.g., "revenue" = "sales")
  - [ ] Test plural forms (e.g., "order" vs "orders")
  - [ ] Test abbreviations (e.g., "rev" = "revenue")
  - [ ] Test case-insensitive matching
  - [ ] Test edge cases (no matches, multiple matches)

- [ ] **Retry Logic Tests** (`src/utils/retry.ts`)
  - [ ] Test exponential backoff calculation
  - [ ] Test max retries enforcement (stops at 3)
  - [ ] Test initial delay (1000ms default)
  - [ ] Test max delay cap (10000ms)
  - [ ] Test retryable errors (503, network timeout)
  - [ ] Test non-retryable errors (401, 400)
  - [ ] Test successful retry after transient failure

- [ ] **Confidence Logic Tests** (`src/types.ts`)
  - [ ] Test `confidenceToPercentage()` mapping
    - [ ] 'high' → 95%
    - [ ] 'medium' → 70%
    - [ ] 'low' → 40%
  - [ ] Test `meetsConfidenceThreshold()` logic
    - [ ] high (95%) meets threshold 95% → true
    - [ ] medium (70%) meets threshold 95% → false
    - [ ] high (95%) meets threshold 50% → true

- [ ] **Schema Formatting Tests** (`src/tools/schema.ts`)
  - [ ] Test `formatSchemaForLLM()` output structure
  - [ ] Test handling of tables with no columns
  - [ ] Test handling of empty schema array

- [ ] **Semantic Formatting Tests** (`src/tools/semantics.ts`)
  - [ ] Test `formatSemanticsForLLM()` output structure
  - [ ] Test grouping by category
  - [ ] Test empty semantics array (returns empty string)
  - [ ] Test semantic with all fields populated
  - [ ] Test semantic with minimal fields

- [ ] **Dynamic Confidence Scoring** (`src/agent/sqlWriter.ts`, `src/agent/orchestrator.ts`)
  - **Current Issue**: Confidence is hardcoded to 'medium' (70%) in orchestrator
  - **Goal**: Get real confidence from LLM during SQL generation
  - [ ] Update SQL Writer prompt to request confidence rating
    - HIGH: Clear semantics and table mappings available
    - MEDIUM: Reasonable guess based on schema
    - LOW: Uncertain about interpretation
  - [ ] Parse confidence from SQL Writer response
    - Expect format: `{ sql: "...", confidence: "high" }`
  - [ ] Pass actual confidence to `requestPermission()` callback
  - [ ] Test SMART mode with various confidence levels
  - [ ] Verify threshold logic works correctly with dynamic confidence

**Estimated Effort**: 3-4 hours (including dynamic confidence)  
**No Breaking Changes**: ✅ Safe to implement anytime

---

### 7.2 Architecture Refactoring for Testability

**Priority**: MEDIUM - Do after Phase 3 stabilizes

**Current Problems**:
- ❌ Hard-coded dependencies (can't inject mocks)
- ❌ Direct database access (can't mock queries)
- ❌ Global config singleton (can't override in tests)
- ❌ No interfaces/abstractions (tight coupling)
- ❌ Tests require real API keys and databases (slow, expensive, flaky)

**Tasks**:

#### 7.2.1 Dependency Injection Pattern
- [ ] **Refactor Agent Classes** (Planner, SQLWriter, Interpreter)
  ```typescript
  // BEFORE (hard-coded)
  export class Planner {
    constructor() {
      this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    }
  }
  
  // AFTER (injectable)
  export class Planner {
    constructor(
      private llmClient: LLMClient,
      private schemaFormatter: SchemaFormatter,
      private semanticsService: SemanticsService
    ) {}
  }
  ```

- [ ] **Refactor Orchestrator**
  ```typescript
  // BEFORE
  export class Orchestrator {
    constructor() {
      this.planner = new Planner();
      this.sqlWriter = new SQLWriter();
    }
  }
  
  // AFTER
  export class Orchestrator {
    constructor(
      private planner: IPlanner,
      private sqlWriter: ISQLWriter,
      private interpreter: IInterpreter
    ) {}
  }
  ```

#### 7.2.2 Extract Interfaces
- [ ] Create `IPlanner` interface
  - [ ] `createPlan(question, schema, previousSteps?): Promise<Plan>`
- [ ] Create `ISQLWriter` interface
  - [ ] `generateSQL(question, step, schema, context?): Promise<string>`
- [ ] Create `IInterpreter` interface
  - [ ] `interpret(question, step, result, allSteps, completed): Promise<Interpretation>`
- [ ] Create `ILLMClient` interface
  - [ ] `generateContent(prompt): Promise<string>`
  - [ ] Enables mocking LLM responses

#### 7.2.3 Database Layer Abstraction
- [ ] Create `SemanticsRepository` class
  ```typescript
  export class SemanticsRepository {
    constructor(private pool: pg.Pool) {}
    async getSemantics(): Promise<Semantic[]> { /* ... */ }
    async saveSemantic(data: SemanticEntity): Promise<void> { /* ... */ }
    async detectSemantics(question: string): Promise<string[]> { /* ... */ }
  }
  ```

- [ ] Create `LogsRepository` class
  ```typescript
  export class LogsRepository {
    constructor(private pool: pg.Pool) {}
    async saveRunLog(data: RunLogData): Promise<RunLog> { /* ... */ }
    async getRecentRunLogs(limit: number): Promise<RunLog[]> { /* ... */ }
  }
  ```

- [ ] Create mock implementations for testing
  - [ ] `MockSemanticsRepository`
  - [ ] `MockLogsRepository`

#### 7.2.4 Config Injection
- [ ] Replace global `config` with injected configuration
- [ ] Create `ConfigProvider` class
- [ ] Allow test config override

**Estimated Effort**: 4-6 hours  
**Breaking Changes**: ⚠️ Major refactoring, high risk

**Recommendation**: Do this refactoring AFTER Phase 3 is stable and working

---

### 7.3 Integration Tests

**Priority**: MEDIUM - After 7.2 refactoring

**Tasks**:
- [ ] **End-to-End Flow Tests**
  - [ ] Test full question → answer flow (with mocked LLM)
  - [ ] Test multi-step query execution
  - [ ] Test error handling and retry logic
  - [ ] Test debug mode flows (on/off/smart)
  - [ ] Test SMART mode confidence checks

- [ ] **SMART Mode Tests**
  - [ ] Test auto-execution when semantics detected + high confidence
  - [ ] Test permission request when no semantics
  - [ ] Test permission request when confidence < threshold
  - [ ] Test cancellation and context reset

- [ ] **CLI Command Tests**
  - [ ] Test `/show-schema` command
  - [ ] Test `/show-semantics` command
  - [ ] Test `/refresh-schema` command
  - [ ] Test `/debug on|off|smart` command
  - [ ] Test `/help` command
  - [ ] Test `/exit` command

- [ ] **Database Integration Tests**
  - [ ] Test schema loading from real database
  - [ ] Test semantic retrieval with various filters
  - [ ] Test run log saving and retrieval
  - [ ] Test connection pooling and cleanup

**Estimated Effort**: 3-4 hours  
**Dependencies**: Requires 7.2 refactoring for effective mocking

---

### 7.4 Test Automation & CI/CD

**Priority**: LOW - Future enhancement

**Tasks**:
- [ ] **Add tests to validate command**
  ```json
  "validate": "npm run typecheck && npm run build && npm test"
  ```

- [ ] **Set up GitHub Actions**
  - [ ] Run tests on every push
  - [ ] Run tests on pull requests
  - [ ] Block merge if tests fail
  - [ ] Generate coverage reports

- [ ] **Test Coverage Reporting**
  - [ ] Integrate `vitest --coverage`
  - [ ] Set coverage thresholds (start with 50%, increase over time)
  - [ ] Display coverage badges in README

- [ ] **Performance Testing**
  - [ ] Test query execution time
  - [ ] Test LLM response time
  - [ ] Test database connection time
  - [ ] Set performance budgets

- [ ] **Load Testing**
  - [ ] Test concurrent query handling
  - [ ] Test connection pool limits
  - [ ] Test retry logic under load

**Estimated Effort**: 2-3 hours  
**Dependencies**: Requires good test coverage first

---

### 7.5 Test Coverage Milestones

**Current**: ~5-10% (only Guard tests)

**Milestone 1** (Quick Wins - 7.1):
- Target: 25-30% coverage
- Components: Guard, Retry, Confidence, Formatting, Detection
- Timeline: Before Phase 4

**Milestone 2** (After Refactoring - 7.2 + 7.3):
- Target: 60-70% coverage
- Components: All agents, orchestrator, repositories
- Timeline: After Phase 3 stabilizes

**Milestone 3** (Full Coverage - 7.4):
- Target: 80-90% coverage
- Components: Everything + integration tests
- Timeline: v2.0.0

---

### Success Criteria

- ✅ **Phase 7.1 Complete**: 
  - 25%+ test coverage
  - All pure functions tested
  - Tests run in < 5 seconds

- ✅ **Phase 7.2 Complete**:
  - All dependencies injectable
  - All components have interfaces
  - Can test without API keys/databases

- ✅ **Phase 7.3 Complete**:
  - 60%+ test coverage
  - Integration tests for critical flows
  - Tests run in < 30 seconds

- ✅ **Phase 7.4 Complete**:
  - Tests run in CI/CD
  - Coverage reports generated
  - Performance benchmarks established

---

## 💡 Ideas for Future Exploration

### Vector Database Strategy (Phase 5+)

**Current Decision**: Use PostgreSQL with pgvector extension

**Rationale**:
1. **Trust & Transparency**: Users need to see, edit, and delete semantics (relational DB excels here)
2. **Structured Data**: Semantics have clear schema (name, category, SQL, etc.)
3. **Complex Queries**: Filter by status, confidence, category (SQL is perfect)
4. **Single Database**: No sync complexity, same ACID guarantees
5. **Cost**: pgvector is free, included with PostgreSQL

**Evolution Path**:
```
Phase 3-4: PostgreSQL only (text matching)
  ↓
Phase 5: Add pgvector extension (semantic search)
  ↓
Phase 6+: Evaluate dedicated vector DB (if scale demands)
```

**When to consider dedicated vector DB** (Pinecone, Weaviate, Qdrant):
- You have 1000+ semantic entities
- pgvector performance degrades
- Need advanced features (hybrid search, multi-tenancy, etc.)
- Scale requires specialized infrastructure

**Hybrid Approach** (if dedicated vector DB used):
- **PostgreSQL**: Source of truth (structured, editable, auditable)
- **Vector DB**: Retrieval index (semantic search, fast matching)
- **Sync Strategy**: 
  - Write to PostgreSQL first
  - Format semantics as "documents" (rich text chunks)
  - Embed and sync to vector DB
  - Query vector DB for retrieval, PostgreSQL for details

**Document Chunking Strategy**:
```typescript
// Format semantic as rich document for embedding
function formatSemanticAsDocument(semantic: SemanticEntity): string {
  return `
Semantic: ${semantic.name}
Category: ${semantic.category}
Description: ${semantic.description}
SQL Pattern: ${semantic.sql_fragment}
Notes: ${semantic.notes?.join('; ')}
Common Mistakes: ${JSON.stringify(semantic.anti_patterns)}
  `.trim();
}

// Embed entire document (better than embedding just description)
// Vector search returns complete context
```

**Key Insight**: PostgreSQL + pgvector gives 90% of vector DB benefits without complexity!

---

### LLM Abstraction Layer (Deferred)
- Multi-provider support (OpenAI, Anthropic, local models)
- Different API keys for different purposes
- Provider-specific optimizations
- Fallback strategies
- **Note**: Deferred to focus on semantic learning first

### Multi-Database Support
- MySQL adapter
- SQLite for local dev
- Clickhouse for analytics

### Natural Language Interface
- More conversational
- Follow-up questions
- Clarification requests

### Integration
- API endpoints
- Webhook notifications
- Slack/Teams integration

---

## 📊 Success Metrics

### Phase 2 Success:
- [ ] Semantics used in 80%+ of queries
- [ ] Measurable query improvement

### Phase 3 Success:
- [ ] 5+ new semantics learned per week
- [ ] 90%+ approval rate for suggestions

### Phase 4 Success:
- [ ] Complex logic rules working correctly
- [ ] Anti-pattern detection rate > 90%

### Phase 8 Success:
- [ ] 90%+ of timed-out queries successfully optimized
- [ ] Average query execution time < 5 seconds
- [ ] Timeout rate < 5%
- [ ] Performance optimizations saved as reusable semantics

### Overall Success:
- [ ] Query accuracy > 95%
- [ ] User satisfaction high
- [ ] System continuously learning

---

## 🔄 Review Schedule

- **Weekly**: Update progress, add notes
- **Monthly**: Review priorities, adjust roadmap
- **Quarterly**: Major version planning

---

---

## 🧪 Testing Strategy Note

**Current Approach**: Manual testing + minimal unit tests (Guard only)  
**Rationale**: During Phases 1-3, we're in rapid prototyping mode. Manual testing is sufficient.

**Future Approach**: After Phase 3 stabilizes, implement Phase 7 testing improvements:
1. **Phase 7.1 (Quick Wins)**: Add tests for pure functions - **DO THIS FIRST** (2-3 hours)
2. **Phase 7.2 (Refactoring)**: Refactor for dependency injection - **DO AFTER Phase 3 stabilizes** (4-6 hours)
3. **Phase 7.3 (Integration)**: Add end-to-end tests - **DO AFTER 7.2** (3-4 hours)
4. **Phase 7.4 (Automation)**: Set up CI/CD - **DO WHEN stable** (2-3 hours)

**Recommended Timeline**:
- Phase 7.1: Before Phase 4 (improve confidence in complex logic)
- Phase 7.2-7.4: After Phase 5 (when architecture is stable)

---

**Next Session**: Phase 3 - Learning from User Corrections (semantic suggestions, approval workflow)
