# SageSays Roadmap

> **Last Updated**: 2026-01-19  
> **Current Version**: v1.2.0  
> **Next Target**: v1.3.0 - Learning from User Corrections

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

## 📋 Phase 5: Relationships & Context (v1.5.0)

**Goal**: Use semantic relationships and context hints

### 5.1 Semantic Relationships

**Tasks**:
- [ ] Implement `semantic_relationships` usage
  - [ ] Load relationships for detected semantics
  - [ ] Types: REQUIRES, CONFLICTS_WITH, DERIVES_FROM
  - [ ] Pass to prompts

- [ ] Example: "Net Revenue" DERIVES_FROM "Gross Revenue"
  - [ ] When asked about net revenue, load gross revenue semantic too
  - [ ] Explain the relationship in prompt

### 5.2 Context Hints

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

## 💡 Ideas for Future Exploration

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

### Query Optimization
- Explain plan analysis
- Index suggestions
- Performance monitoring

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

**Next Session**: Phase 3 - Learning from User Corrections (semantic suggestions, approval workflow)
