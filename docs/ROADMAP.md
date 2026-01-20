# SageSays Roadmap

> **Last Updated**: 2026-01-20
> **Current Version**: v1.3.6
> **Next Target**: SQL Query Import for Semantic Enrichment

---

## 🎯 Vision

Transform SageSays from a basic SQL agent into an intelligent system that **learns from user interactions** and **improves over time** by capturing business semantics and query patterns.

---

## ✅ Recently Completed

### LLM-Interpreted State Orchestration (v1.3.8)

**Status**: ✅ Completed

**What Was Built**:
- **Intelligent orchestration**: Replaced hardcoded if/else logic with LLM-based decision making
- **Agent needs system**: Agents autonomously express needs in `state.agentNeeds`
- **LLM decision maker**: Orchestrator uses LLM to interpret agent needs and decide next actions
- **Enhanced state structure**: Added `agentNeeds`, `lastDecision`, `decisionHistory` to OrchestratorState
- **Agent modifications**: Planner, SQLWriter, Interpreter now express needs after execution
- **Decision validation**: Comprehensive validation of LLM decisions (mode/sub-state combinations, guard constraints)
- **Debug visibility**: Enhanced state display shows agent needs and LLM decisions

**Key Features**:
- **Agentic autonomy**: Agents express needs independently, Orchestrator coordinates intelligently
- **Adaptive behavior**: System adapts to new situations without hardcoded rules
- **Transparency**: All decisions logged with reasoning and confidence scores
- **Safety**: Validation ensures LLM decisions respect constraints and guard limits
- **Backward compatible**: Existing `execute()` and `executeDiscovery()` methods work unchanged

**Architecture Change**:
```
Before: Orchestrator → selectTool() → callTool() → evaluateTransition() → (hardcoded if/else)
After:  Agent → Updates state.agentNeeds → Orchestrator.decideNextAction() (LLM) → Transition
```

**Files Changed**:
- `src/types.ts` - Added AgentNeeds interfaces, OrchestrationDecision type
- `src/agent/orchestrator.ts` - Added LLM decision maker, replaced hardcoded transitions
- `src/agent/planner.ts` - Added needs expression (discovery, clarification, context gaps)
- `src/agent/sqlWriter.ts` - Added needs expression (optimization, blockers, confidence)
- `src/agent/interpreter.ts` - Added needs expression (refinement, missing data, completion)
- `docs/ARCHITECTURE.md` - Documented LLM-interpreted orchestration

---

### Mode-Based State Machine Orchestrator & Discovery Mode (v1.3.7)

**Status**: ✅ Completed

**What Was Built**:
- Hierarchical state machine architecture for Orchestrator
- MODE + SUB-STATE system (QUERY, DISCOVERY, SEMANTIC_STORING)
- Active mode tracking with automatic mode activation
- Discovery mode for schema exploration (`/explore` command)
- Pattern analysis via SemanticLearner.analyzePattern()
- Complete discovery workflow: GET_DATA → ANALYZE → VALIDATE → SUGGEST → APPROVE → STORE

**Key Features**:
- State preservation across mode switches
- NULL states indicate termination (not suspension)
- Tool routing based on MODE + SUB-STATE combination
- Backward compatible `execute()` method (uses state machine internally)
- Manual discovery trigger via `/explore <table> [column]` command

**Files Changed**:
- `src/types.ts` - Added state machine types (Mode, SubState, OrchestratorState, etc.)
- `src/agent/orchestrator.ts` - Complete refactor to state machine
- `src/agent/semanticLearner.ts` - Added `analyzePattern()` method
- `src/index.ts` - Added `/explore` command handler
- `docs/ARCHITECTURE.md` - Documented state machine architecture
- `README.md` - Added `/explore` command documentation

---

## 🚀 Next Priority: SQL Query Import for Semantic Enrichment (v1.4.0)

**Goal**: Enable bulk semantic enrichment by importing approved SQL queries with context. LLM analyzes queries, infers semantics, asks clarification questions, and enriches the knowledge base quickly.

**Why Priority**: Fastest way to build comprehensive semantic knowledge base. Users can import existing queries from their organization to bootstrap the system.

### Phase 10.1: Query Analysis & Semantic Extraction (MVP)

**Tasks**:
- [ ] **Create QuerySemanticExtractor Agent** (`src/agent/querySemanticExtractor.ts`)
  - [ ] Analyze SQL queries to extract potential semantics
  - [ ] Identify patterns: metrics, dimensions, time periods, business rules
  - [ ] Generate initial semantic hypotheses with confidence scores
  - [ ] Detect multiple semantics per query (2-5 on average)

- [ ] **Query Submission Interface**
  - [ ] Add `/import-query` CLI command
  - [ ] Collect SQL query from user
  - [ ] Collect purpose/context from user
  - [ ] Optional: business context, frequency, tags

- [ ] **LLM-Powered Analysis**
  - [ ] Prompt engineering for query analysis
  - [ ] Extract: name, type, category, SQL fragment, synonyms
  - [ ] Generate confidence scores (0.0-1.0)
  - [ ] Identify which semantics need clarification

- [ ] **Clarification Integration**
  - [ ] Use existing clarification system (Phase 9.1)
  - [ ] Generate targeted questions based on confidence
  - [ ] High confidence (≥0.85): Skip clarification
  - [ ] Medium (0.60-0.84): Ask 1-2 questions
  - [ ] Low (<0.60): Ask 3-5 questions or skip

- [ ] **Semantic Refinement**
  - [ ] Refine semantic definition using clarification answers
  - [ ] Create `SemanticSuggestion` with `learned_from: 'explicit_teaching'`
  - [ ] Include complete metadata (synonyms, anti-patterns, examples)
  - [ ] Store original query as `example_sql`

- [ ] **Review & Approval Workflow**
  - [ ] Display extracted semantics for review
  - [ ] Show confidence scores and clarification Q&A
  - [ ] Allow approve/reject/edit per semantic
  - [ ] Bulk approval option for high-confidence semantics

**Example Workflow**:
```
User: /import-query
> Enter SQL: SELECT COUNT(*) FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '7 days' AND status = 'confirmed'
> Purpose: Weekly sales report - counting confirmed orders from last week

System: Analyzing query...
Extracted semantics:
1. "Last week" (TIME_PERIOD) - 75% confidence
   🤔 Clarification: What day does week start? (Monday/Sunday)
2. "Confirmed orders" (DIMENSION) - 90% confidence ✓
3. "Order count" (METRIC) - 85% confidence ✓

[Clarification questions if needed]
[Review & approve]
```

**Success Criteria**:
- ✅ Extract 2-5 semantics per query on average
- ✅ ≥90% accuracy after clarification
- ✅ Process single query in < 2 minutes
- ✅ Seamless integration with existing approval workflow

**Estimated Effort**: 6-8 hours

---

### Phase 10.2: Batch Import & Advanced Features

**Tasks**:
- [ ] **Batch Import from File**
  - [ ] `/import-batch queries.json` command
  - [ ] Process multiple queries in sequence
  - [ ] Progress tracking and skip/review options
  - [ ] Group related semantics for batch review

- [ ] **Query Pattern Recognition**
  - [ ] Detect similar queries and suggest consolidation
  - [ ] Identify variations of same concept
  - [ ] Propose canonical semantic names

- [ ] **Anti-Pattern Detection**
  - [ ] Compare submitted query with existing semantics
  - [ ] Flag potential conflicts or contradictions
  - [ ] Suggest corrections if query uses anti-patterns

- [ ] **Semantic Relationships**
  - [ ] Auto-detect dependencies (e.g., "Revenue" depends on "Confirmed orders")
  - [ ] Suggest relationships between extracted semantics
  - [ ] Build semantic knowledge graph

**Estimated Effort**: 4-6 hours

---

## 📋 Upcoming Phases (Prioritized by Impact)

> **Note**: With the introduction of LLM-interpreted orchestration (v1.3.8), some tasks may need review. The system now uses intelligent decision-making rather than hardcoded rules, which may affect implementation approaches for future features.

### High Impact - Core Functionality

#### Phase 9.1: Planner Clarification for Ambiguous Queries (v1.4.0) - **COMPLETED**

**Goal**: Planner asks for clarification when user intent is unclear or ambiguous

**Status**: ✅ Implemented - Planner detects ambiguity and asks clarification questions

---

#### Phase 4: Complex Logic Handling (v1.5.0)

**Goal**: Handle sophisticated business rules like the order_item_states example

**Impact**: High - Enables accurate revenue calculations and complex business logic

**Tasks**:
- [ ] Fully utilize `semantic_entities.complex_logic` JSONB field
- [ ] Update `formatSemanticsForLLM()` to include complex logic
- [ ] Create `detectAntiPatterns(sql: string): AntiPattern[]`
- [ ] Warn user when anti-pattern detected
- [ ] Test with revenue calculation example

**Estimated Effort**: 4-6 hours

---

#### Phase 9.2: LLM Abstraction Layer (v1.4.1)

**Goal**: Create abstraction layer for easy switching between LLM providers

**Impact**: High - Enables flexibility, cost optimization, multi-provider support

**Tasks**:
- [ ] Define `LLMProvider` interface
- [ ] Implement `GeminiProvider` (wrap current implementation)
- [ ] Update all agents to use interface
- [ ] Configuration system for provider selection
- [ ] Cost integration per provider

**Estimated Effort**: 4-6 hours

---

#### Phase 9.3: Costing Calculation & Monitoring (v1.4.2)

**Goal**: Track and monitor LLM API costs per inference

**Impact**: Medium - Essential for managing operational costs

**Tasks**:
- [ ] Track input/output tokens per LLM call
- [ ] Calculate cost using provider-specific pricing
- [ ] Store cost data in control database
- [ ] Add `/cost-summary` and `/cost-breakdown` commands
- [ ] Cost optimization recommendations

**Estimated Effort**: 2-3 hours

---

### Medium Impact - User Experience

#### Phase 6.5.2-6.5.4: UX Enhancements - Follow-up Detection (v1.6.0)

**Goal**: Improve follow-up question understanding

**Impact**: Medium - Better user experience for conversational queries

**Tasks**:
- [ ] Add `isFollowUpQuestion()` function
- [ ] Auto-enhance questions with previous context
- [ ] Add `/refine` and `/filter` commands
- [ ] Hybrid approach with context hints

**Estimated Effort**: 7-10 hours

---

#### Phase 9.4: Advanced Interpreter & Results Display (v1.5.0)

**Goal**: Multiple result display formats (tables, charts, summaries)

**Impact**: Medium - Better data visualization and comprehension

**Tasks**:
- [ ] Result format detection (table/chart/summary)
- [ ] Table display enhancements
- [ ] Chart/graph support
- [ ] AI-powered result summarization
- [ ] Display format options

**Estimated Effort**: 6-8 hours

---

### Lower Priority - Advanced Features

#### Phase 5: Enhanced Semantic Discovery (v1.6.0)

**Goal**: Improve semantic detection with vector search

**Impact**: Medium - Better semantic matching as knowledge base grows

**Tasks**:
- [ ] Add pgvector extension to PostgreSQL
- [ ] Generate embeddings for semantics
- [ ] Implement semantic similarity search
- [ ] Hybrid detection strategy (exact + vector)

**Estimated Effort**: 3-4 hours

---

#### Phase 8: Performance & Query Optimization (v2.1.0)

**Goal**: Intelligently handle query timeouts and optimize slow queries

**Impact**: Medium - Better performance for large datasets

**Tasks**:
- [ ] Create `QueryOptimizer` class
- [ ] Smart timeout handling with EXPLAIN analysis
- [ ] LLM-assisted query optimization
- [ ] Performance monitoring and learning

**Estimated Effort**: 17-23 hours

---

#### Phase 6: Advanced Features (v2.0.0)

**Goal**: Confidence scoring, versioning, collaborative learning

**Impact**: Low - Nice-to-have features for mature system

**Tasks**:
- [ ] Semantic confidence scoring and updates
- [ ] Semantic versioning system
- [ ] Multi-user collaborative learning
- [ ] Analytics dashboard

**Estimated Effort**: 8-12 hours

---

#### Phase 7: Testing Infrastructure (v1.x.x - Ongoing)

**Goal**: Improve test coverage and refactor for testability

**Impact**: Medium - Important for code quality and maintainability

**Priority**: Do incrementally as system stabilizes

**Tasks**:
- [ ] Phase 7.1: Quick win tests (3-4 hours)
- [ ] Phase 7.2: Architecture refactoring (4-6 hours)
- [ ] Phase 7.3: Integration tests (3-4 hours)
- [ ] Phase 7.4: CI/CD automation (2-3 hours)

**Total Estimated Effort**: 12-17 hours

---

## ✅ Completed Phases

### LLM-Interpreted State Orchestration (v1.3.8) - **COMPLETED**

**Goal**: Replace hardcoded state transitions with intelligent LLM-based orchestration

**Completed Tasks**:
- [x] Extended type definitions with AgentNeeds interfaces and OrchestrationDecision
- [x] Created LLM decision maker (`decideNextAction()`, `buildDecisionPrompt()`, `validateDecision()`)
- [x] Modified Planner, SQLWriter, Interpreter to express needs in state
- [x] Replaced `selectTool()` with `selectNextAction()` (LLM-based)
- [x] Replaced `evaluateTransition()` with `applyDecision()` (applies LLM decisions)
- [x] Updated execution loops to use LLM decisions
- [x] Enhanced debug display to show agent needs and decisions

**Outcome**: ✅ System now uses intelligent orchestration - agents express needs, LLM coordinates adaptively

---

### Phase 9.1: Planner Clarification for Ambiguous Queries (v1.4.0) - **COMPLETED**

**Goal**: Planner asks for clarification when user intent is unclear or ambiguous

**Completed Tasks**:
- [x] Extended type definitions with `PlanStatus` and clarification fields
- [x] Enhanced Planner prompt with ambiguity detection rules
- [x] Updated Planner to return `CLARIFICATION_NEEDED` status
- [x] Implemented clarification loop in Orchestrator
- [x] CLI integration for clarification prompts

**Outcome**: ✅ System now detects ambiguous queries and asks for clarification before generating SQL

---

### Phase 6.6: Tool Consolidation & Database Separation (v1.3.6) - **COMPLETED**

**Goal**: Organize database tools into clear separation between control DB and inspected DB operations

**Completed Tasks**:
- [x] Created `src/tools/controlDb.ts` - All control database operations
- [x] Created `src/tools/inspectedDb.ts` - All inspected database operations
- [x] Updated all imports across codebase
- [x] Maintained backward compatibility
- [x] Removed redundant tool files

**Outcome**: ✅ Clean database tool separation achieved

---

### Phase 4.5: Enhanced Schema Metadata Storage (v1.3.5) - **COMPLETED**

**Goal**: Store comprehensive metadata about the inspected database for query optimization

**Completed Tasks**:
- [x] Created `inspected_db_metadata` table
- [x] Implemented extraction functions (indexes, sizes, FKs, PKs)
- [x] Integrated with schema loading
- [x] Updated SQLWriter to use metadata for optimization
- [x] Added `/refresh-metadata` command

**Outcome**: ✅ Metadata system fully operational

---

### Phase 6.5.1: Conversation History Window (v1.6.0) - **COMPLETED**

**Goal**: Maintain conversation context for follow-up questions

**Completed Tasks**:
- [x] Added `ConversationTurn` interface
- [x] Implemented conversation history tracking (sliding window)
- [x] Updated Planner and SQLWriter to use history
- [x] Context awareness rules in LLM prompts

**Outcome**: ✅ Follow-up questions now understood with context

---

### Phase 3.3: Pre-Execution Corrections (v1.3.0) - **COMPLETED**

**Goal**: Capture user corrections before SQL execution and learn from manual SQL edits

**Completed Tasks**:
- [x] Pre-execution correction capture
- [x] Manual SQL edit with diff learning
- [x] Re-execution validation after approval
- [x] "All" request handling with LIMIT removal
- [x] Fixed infinite refinement loop

**Outcome**: ✅ Full correction learning workflow implemented

---

### Phase 3.1-3.2: Learning from User Corrections (v1.3.0) - **COMPLETED**

**Goal**: Automatically learn new semantics from user corrections with LLM-powered analysis

**Completed Tasks**:
- [x] Created `SemanticLearner` class
- [x] LLM-powered pattern extraction
- [x] Semantic suggestion generation
- [x] Approval workflow (`/review-suggestions`)
- [x] Post-execution correction capture

**Outcome**: ✅ SageSays now learns from user corrections

---

### Phase 2: Basic Semantic Integration (v1.2.0) - **COMPLETED**

**Goal**: Make the system use existing semantics to improve query generation

**Completed Tasks**:
- [x] Integrated semantics into Planner, SQLWriter, and Interpreter prompts
- [x] Tracked semantic usage in run_logs
- [x] Implemented `detectSemantics()` function
- [x] Enhanced semantic formatting for LLM

**Outcome**: ✅ System now actively uses semantics

---

### Phase 1: Control Database Foundation (v1.1.0) - **COMPLETED**

**Goal**: Establish solid control database foundation

**Completed Tasks**:
- [x] Connected to Neon control database
- [x] Documented actual schema (30+ fields)
- [x] Aligned code with database schema
- [x] Tested semantics retrieval and run logs

**Outcome**: ✅ Solid foundation with clean, documented schema

---

## 📊 Success Metrics

### Overall Success:
- [ ] Query accuracy > 95%
- [ ] User satisfaction high
- [ ] System continuously learning
- [ ] 50+ semantic entities in knowledge base

### Phase 10 Success (SQL Import):
- [ ] Process 10 queries in < 5 minutes
- [ ] Extract 2-5 semantics per query on average
- [ ] ≥90% accuracy after clarification
- [ ] Minimal clarification rounds needed (≤2 per query)

### Phase 4 Success (Complex Logic):
- [ ] System warns about anti-patterns
- [ ] Suggests correct approaches
- [ ] Revenue calculations are accurate

### Phase 8 Success (Performance):
- [ ] 90%+ of timed-out queries successfully optimized
- [ ] Average query execution time < 5 seconds
- [ ] Timeout rate < 5%

---

## 🔄 Review Schedule

- **Weekly**: Update progress, add notes
- **Monthly**: Review priorities, adjust roadmap
- **Quarterly**: Major version planning

---

## 💡 Ideas for Future Exploration

### Vector Database Strategy

**Current Decision**: Use PostgreSQL with pgvector extension

**Rationale**: PostgreSQL + pgvector gives 90% of vector DB benefits without complexity. Start with relational DB, add pgvector when needed (Phase 5).

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

**Next Session**: Phase 10.1 - SQL Query Import for Semantic Enrichment (MVP)
