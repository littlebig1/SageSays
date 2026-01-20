# Control Database Schema

This document defines the **official schema** for the SageSays control database as currently deployed.

> **Note**: This schema was automatically discovered from your existing control database. It represents a comprehensive semantic learning system with rich metadata fields.

## Purpose

The control database stores:
- **Semantic knowledge** - Business logic, domain concepts, calculation rules with rich metadata
- **Query patterns** - Learned patterns from user interactions  
- **Run logs** - Detailed history of executed queries for learning
- **Semantic suggestions** - Learning from user corrections
- **Context hints** - Domain-specific hints for better query generation

## Database Requirements

- **PostgreSQL 12+** (recommended: Neon serverless Postgres)
- Connection via `CONTROL_DB_URL` environment variable

## Current Schema

### Table: semantic_entities

Stores business concepts, metrics, dimensions, and calculation rules with extensive metadata.

```sql
CREATE TABLE semantic_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,              -- e.g., 'METRIC', 'DIMENSION', 'FILTER'
  name TEXT NOT NULL,                     -- Canonical name
  display_name TEXT,                      -- Human-friendly display name
  category TEXT NOT NULL,                 -- Broader categorization
  description TEXT NOT NULL,              -- Full explanation
  synonyms TEXT[] DEFAULT '{}',           -- Alternative names
  plural_form TEXT,                       -- Plural version of name
  abbreviations TEXT[] DEFAULT '{}',      -- Common abbreviations
  primary_table TEXT,                     -- Main database table
  primary_column TEXT,                    -- Main database column
  sql_fragment TEXT,                      -- SQL template/pattern
  aggregation TEXT,                       -- Aggregation function (SUM, AVG, etc.)
  has_complex_logic BOOLEAN DEFAULT false,-- Indicates complex calculation
  complex_logic JSONB,                    -- Detailed logic definition
  anti_patterns JSONB,                    -- Known incorrect approaches
  example_questions TEXT[] DEFAULT '{}',  -- Sample user questions
  example_sql TEXT,                       -- Example query
  notes TEXT[] DEFAULT '{}',              -- Additional notes
  common_mistakes JSONB,                  -- Common errors to avoid
  source TEXT DEFAULT 'manual',           -- 'manual', 'learned', 'imported'
  confidence NUMERIC DEFAULT 1.00,        -- Confidence score (0-1)
  usage_count INTEGER DEFAULT 0,          -- How many times used
  success_rate NUMERIC,                   -- Query success rate
  last_used_at TIMESTAMP,                 -- Last usage timestamp
  created_by TEXT,                        -- Who created it
  approved BOOLEAN DEFAULT false,         -- Approval status
  approved_by TEXT,                       -- Who approved it
  version INTEGER DEFAULT 1,              -- Version number
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_semantic_entities_type ON semantic_entities(entity_type);
CREATE INDEX idx_semantic_entities_name ON semantic_entities(name);
CREATE INDEX idx_semantic_entities_table ON semantic_entities(primary_table);
```

**Example Entry:**
```json
{
  "entity_type": "METRIC",
  "name": "Revenue",
  "display_name": "Total Revenue",
  "category": "Financial",
  "description": "Sum of all confirmed order values, excluding canceled orders",
  "synonyms": ["sales", "income", "earnings"],
  "primary_table": "orders",
  "primary_column": "order_value",
  "sql_fragment": "SUM(o.order_value)",
  "aggregation": "SUM",
  "has_complex_logic": true,
  "complex_logic": {
    "requires": ["order_items", "order_item_states"],
    "filter": "NOT EXISTS (SELECT 1 FROM order_item_states WHERE status = 'CANCEL')",
    "warning": "Use state history, not status_latest snapshot"
  }
}
```

### Table: semantic_relationships

Defines hierarchical and associative relationships between semantic entities.

```sql
CREATE TABLE semantic_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES semantic_entities(id),
  child_id UUID REFERENCES semantic_entities(id),
  relationship_type TEXT NOT NULL,        -- e.g., 'DEPENDS_ON', 'CONTRADICTS', 'RELATED_TO'
  strength NUMERIC DEFAULT 1.00,          -- Relationship strength (0-1)
  properties JSONB,                       -- Additional properties
  notes TEXT,                             -- Relationship notes
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_relationships_parent ON semantic_relationships(parent_id);
CREATE INDEX idx_relationships_child ON semantic_relationships(child_id);
CREATE INDEX idx_relationships_type ON semantic_relationships(relationship_type);
```

### Table: semantic_suggestions

Stores corrections and improvements learned from user feedback.

```sql
CREATE TABLE semantic_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggested_name TEXT NOT NULL,
  suggested_type TEXT NOT NULL,
  suggested_definition JSONB NOT NULL,    -- Full entity definition
  learned_from TEXT NOT NULL              -- Source of learning (ENUM: see below)
    CHECK (learned_from = ANY (ARRAY[
      'user_correction'::text,           -- Learned from user correcting a query result
      'pattern_analysis'::text,          -- Learned from analyzing query patterns
      'frequency_analysis'::text,        -- Learned from frequency of similar queries
      'explicit_teaching'::text          -- Manually taught by user/admin
    ])),
  source_run_log_id UUID REFERENCES run_logs(id),
  learning_dialogue JSONB,                -- Conversation that led to suggestion
  confidence NUMERIC NOT NULL,            -- Confidence score (0.0 to 1.0)
  evidence JSONB,                         -- Supporting evidence
  status TEXT DEFAULT 'pending'           -- 'pending', 'approved', 'rejected', 'needs_revision'
    CHECK (status = ANY (ARRAY[
      'pending'::text,
      'approved'::text,
      'rejected'::text,
      'needs_revision'::text
    ])),
  requires_expert_review BOOLEAN DEFAULT false,
  reviewed_by TEXT,
  review_notes TEXT,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_suggestions_status ON semantic_suggestions(status);
CREATE INDEX idx_suggestions_learned_from ON semantic_suggestions(learned_from);
```

**Important Constraints:**
- `learned_from`: Must be one of the four predefined values (enforced by CHECK constraint)
- `status`: Must be one of the four workflow states
- `confidence`: Should be between 0.0 and 1.0 (validated in application code)

### Table: run_logs

Comprehensive logging of all query executions for learning and debugging.

```sql
CREATE TABLE run_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  detected_semantics TEXT[],              -- Semantics identified in question
  sql_generated TEXT[] NOT NULL,          -- Generated SQL queries
  sql_executed TEXT[],                    -- Actually executed SQL (may differ)
  rows_returned INT[] NOT NULL,
  durations_ms INT[] NOT NULL,
  was_corrected BOOLEAN DEFAULT false,    -- User corrected the result
  correction_type TEXT,                   -- Type of correction
  user_feedback JSONB,                    -- Structured feedback
  generated_semantic_id UUID,             -- If new semantic was learned
  semantics_applied TEXT[],               -- Which semantics were used
  user_rating INTEGER,                    -- User satisfaction (1-5)
  user_comment TEXT,                      -- Free-form user comment
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_run_logs_created ON run_logs(created_at DESC);
CREATE INDEX idx_run_logs_question ON run_logs USING gin(to_tsvector('english', question));
```

### Table: query_patterns

Learns reusable query patterns for common question types.

```sql
CREATE TABLE query_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL,                  -- Pattern template
  variables TEXT[] DEFAULT '{}',          -- Variable placeholders
  related_semantics TEXT[],               -- Associated semantic entities
  usage_count INTEGER DEFAULT 0,
  example_expansions TEXT[] DEFAULT '{}', -- Example filled patterns
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_patterns_usage ON query_patterns(usage_count DESC);
```

### Table: context_hints

Domain-specific hints to guide query generation.

```sql
CREATE TABLE context_hints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT,                            -- Domain/scope (null = global)
  hint_type TEXT,                         -- Type of hint
  content TEXT NOT NULL,                  -- The hint text
  related_semantics TEXT[],               -- Related semantic entities
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_hints_domain ON context_hints(domain);
CREATE INDEX idx_hints_type ON context_hints(hint_type);
```

## Code Integration

The application code uses these tables as follows:

- **`getSemantics()`** - Queries `semantic_entities` with fields: `primary_table`, `primary_column`
- **`saveSemantic()`** - Inserts into `semantic_entities`
- **`saveRunLog()`** - Inserts into `run_logs` with fields: `sql_generated`, `sql_executed`
- **`getSemanticEntities()`** - Full entity retrieval with all metadata

## Field Mapping

Application interface → Database columns:

| Application Field | Database Column |
|-------------------|-----------------|
| `tableName` | `primary_table` |
| `columnName` | `primary_column` |
| `sqlPattern` | `sql_fragment` |
| `category` | `category` or `entity_type` |
| `term` | `name` |

## Critical Constraints & Enums

### ⚠️ Must Follow These Constraints in Code

| Table | Column | Allowed Values | Type | Notes |
|-------|--------|----------------|------|-------|
| `semantic_entities` | `entity_type` | `'entity'`, `'metric'`, `'rule'`, `'time_period'`, `'anti_pattern'` | CHECK constraint | Lowercase with underscores |
| `semantic_entities` | `source` | `'manual'`, `'learned'`, `'imported'`, `'system'` | CHECK constraint | |
| `semantic_entities` | `aggregation` | `'COUNT'`, `'SUM'`, `'AVG'`, `'MIN'`, `'MAX'`, `'NONE'`, `NULL` | CHECK constraint | Uppercase |
| `semantic_entities` | `confidence` | 0.0 to 1.0 | CHECK constraint | Numeric range |
| `semantic_entities` | `(entity_type, name)` | Must be unique | UNIQUE INDEX | Can't duplicate names per type |
| `semantic_suggestions` | `learned_from` | `'user_correction'`, `'pattern_analysis'`, `'frequency_analysis'`, `'explicit_teaching'` | CHECK constraint | |
| `semantic_suggestions` | `status` | `'pending'`, `'approved'`, `'rejected'`, `'needs_review'` | CHECK constraint | Note: `'needs_review'` not `'needs_revision'` |
| `semantic_suggestions` | `confidence` | 0.0 to 1.0 | CHECK constraint | Numeric range |
| `run_logs` | `correction_type` | `'wrong_sql'`, `'wrong_result'`, `'wrong_interpretation'` | Application-enforced | Not DB constraint |
| `run_logs` | `user_rating` | 1 to 5 | CHECK constraint | Integer range |

**These constraints are enforced at the database level.** Attempting to insert values outside these enums will cause error code:
- `23514` - CHECK constraint violation
- `23505` - UNIQUE constraint violation

**TypeScript Types:** These constraints are mirrored in `src/types.ts` as:
- `EntityTypeDB` - Database entity types (lowercase)
- `EntityTypeLLM` - LLM entity types (uppercase, mapped automatically)
- `LLM_TO_DB_ENTITY_TYPE` - Mapping function
- `SuggestionStatusDB` - Status values
- `LearnedFromSource` - Learning sources
- `AggregationDB` - Aggregation types
- `SourceDB` - Semantic sources

## Duplicate Handling Strategy

### Unique Constraint on `semantic_entities`

The database enforces a **UNIQUE constraint** on `(entity_type, name)`:
```sql
CREATE UNIQUE INDEX unique_name_per_type 
ON semantic_entities (entity_type, name)
```

### Smart Duplicate Resolution

When the AI generates a semantic name that already exists, the system **does NOT fail**. Instead, it:

1. **Detects the duplicate** before attempting insert
2. **Updates the existing semantic** with new information:
   - Merges synonyms (array concatenation)
   - Merges example_questions (array concatenation)
   - Merges notes (array concatenation)
   - Updates description if provided
   - Updates SQL fragment if provided
   - Updates confidence to higher value
   - Increments `version` number
   - Increments `usage_count` (tracks reinforcement)
3. **Logs the merge** to console for transparency
4. **Returns the existing semantic** (updated)

This ensures that:
- ✅ User corrections are never lost
- ✅ Semantics get richer over time (accumulate knowledge)
- ✅ Confidence increases with repeated corrections
- ✅ No manual intervention needed
- ✅ Natural deduplication

**Example:**
```
Attempt 1: Create "yesterday" (time_period)
  → Creates new semantic

Attempt 2: Create "yesterday" (time_period) again
  → Detects duplicate
  → Merges new synonyms: ["past day", "previous day"]
  → Updates confidence: 0.90 → 0.95
  → Increments version: 1 → 2
  → Result: Enhanced semantic, no error
```

## Development Guidelines

1. **Never modify the schema directly in production**
2. **Use migrations for schema changes**
3. **Keep this documentation updated** when schema evolves
4. **Follow naming conventions**: `snake_case` for columns, `UUID` for IDs
5. **Leverage rich metadata fields** - use `synonyms`, `anti_patterns`, `complex_logic` for better learning
6. **Always check constraint enums** before inserting data into tables with CHECK constraints
7. **Trust the duplicate handler** - don't try to prevent duplicates in application code, let the DB-level handler manage it

## Viewing Current Schema

To see the live schema at any time:

```bash
npm run show-schema  # or: npx tsx scripts/show-current-schema.ts
```

## Schema Philosophy

This schema supports a **learning system** that:
- Captures rich business semantics beyond simple table mappings
- Learns from user corrections and feedback
- Tracks confidence and success rates
- Supports approval workflows for quality control
- Maintains versioning and audit trails
