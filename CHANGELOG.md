# Changelog

All notable changes to the SQL Agent CLI project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-01-19

**Summary**: Established proper database management practices with fixed schema documentation, aligned code to match the existing comprehensive control database schema, and consolidated all documentation.

### Documentation Cleanup
- **DELETED conflicting/outdated files:**
  - ❌ `/migrations/001_initial_schema.sql` (outdated schema)
  - ❌ `/scripts/init-control-db.sql` (wrong schema)
  - ❌ `/scripts/verify-control-db.ts` (checked for wrong schema)
  - ❌ `/docs/BEST_PRACTICES_SUMMARY.md` (merged into DEVELOPMENT.md)
  - ❌ `/migrations/` folder (empty after cleanup)

- **CONSOLIDATED documentation in `/docs`:**
  - ✅ Created `/docs/README.md` - Documentation index and quick links
  - ✅ Rewrote `/docs/DEVELOPMENT.md` - Complete development guide (now 500 lines vs 1,220 total before)
  - ✅ Rewrote `/docs/ARCHITECTURE.md` - Streamlined system architecture guide
  - ✅ Updated `/docs/CONTROL_DB_SCHEMA.md` - Accurate schema matching actual database

- **TESTED functionality:**
  - ✅ Created `/scripts/test-semantics.ts` - Verified semantics retrieval works
  - ✅ Created `/scripts/test-logs.ts` - Verified run logs saving works
  - ✅ All tests passed with real data

- **UPDATED references:**
  - ✅ Removed deleted script references from `package.json`
  - ✅ Updated README.md control database setup section
  - ✅ Single source of truth: `npm run show-schema` to view actual database

## [Unreleased]

### Added
- **SMART Debug Mode**
  - Three debug modes: ON, OFF, SMART (default)
  - SMART mode auto-executes queries when BOTH conditions met:
    - Semantics detected in question
    - Confidence level >= threshold (configurable via `DEBUG_MODE_CONFIDENCE_THRESHOLD`, default 95%)
  - Asks for approval when EITHER condition fails
  - Displays reasons for requiring review (no semantics OR low confidence)
  - Configurable threshold via environment variable

- **Always-Visible SQL Display**
  - SQL queries now always shown for transparency
  - Displayed regardless of debug mode
  - Full query shown (no truncation)
  - Improved user experience and debugging

- **Documentation Structure Enforcement**
  - Created `.cursorrules` with documentation rules
  - Added "Documentation Guidelines" section to `DEVELOPMENT.md`
  - Enforces 5+1 rule: exactly 5 doc files + 1 root README

### Changed
- **Debug mode default**: Changed from OFF to SMART
- **Help command**: Updated to show all three debug modes
- **Startup message**: Shows current debug mode and confidence threshold
- **Documentation cleanup**:
  - ❌ Deleted `docs/SMART_MODE.md` (consolidated into ARCHITECTURE.md)
  - ❌ Deleted `docs/PHASE2_SUMMARY.md` (archived in SESSION_NOTES.md)
  - ❌ Deleted `docs/README.md` (redundant index)
  - ✅ Consolidated SMART mode docs into ARCHITECTURE.md

## [1.2.0] - 2026-01-19

**Summary**: Implemented Phase 2 - Basic Semantic Integration. The system now actively uses business semantics to improve query generation, detects semantics in user questions, and tracks semantic usage in run logs.

### Added
- **Semantic Detection System**
  - New `detectSemantics()` function in `src/tools/semantics.ts`
  - Uses word boundary matching for accurate term detection
  - Detects time period semantics: "yesterday", "today", "this month", "last month"
  - Integrated into Orchestrator to detect semantics before planning
  - Displays detection count to user (e.g., "🔍 Detected 1 relevant semantic(s)")

- **Enhanced Semantic Integration**
  - Improved `formatSemanticsForLLM()` with clearer formatting and explicit instructions
  - Added semantics to Interpreter prompts (previously only in Planner and SQL Writer)
  - Updated all agent prompts with specific instructions to use semantic definitions
  - SQL Writer now has critical instructions to apply semantics for date/time filters

- **Semantic Usage Tracking**
  - Updated `run_logs` table to track `detected_semantics` and `semantics_applied` fields
  - Enhanced `saveRunLog()` to accept and store semantic IDs
  - Updated `RunLog` type with `detectedSemantics` field
  - Enables future analysis of semantic usage and effectiveness

- **Testing Infrastructure**
  - New `scripts/test-semantic-detection.ts` for testing detection accuracy
  - Validates detection of all 4 time period semantics
  - Confirms no false positives with word boundary matching

- **Exponential backoff retry logic** (from previous session)
  - Automatically retries on 503/429 errors (API overload/rate limit)
  - Max 3 retries with exponential delays (1s, 2s, 4s)
  - User-friendly error messages after exhausting retries
  - Applied to Planner, SQL Writer, and Interpreter
  - New utility: `src/utils/retry.ts`

### Changed
- **Documentation Updates**
  - Updated `docs/ROADMAP.md`: Phase 2 marked complete, now on v1.2.0
  - Updated `docs/SESSION_NOTES.md`: Added Phase 2 completion notes
  - Updated `docs/ARCHITECTURE.md`: Added retry logic section
  - Updated `README.md`: Added error handling & retry logic section
  - ❌ Deleted `docs/RETRY_LOGIC.md` (redundant, integrated into ARCHITECTURE.md)

### Fixed
- Fixed `initializeControlDB()` schema mismatch - updated to use correct column names (`primary_table`, `primary_column`, `sql_generated`) matching actual database
- Fixed semantic detection to use word boundaries, preventing false positives

### Technical Details
- Modified files: `semantics.ts`, `planner.ts`, `sqlWriter.ts`, `interpreter.ts`, `orchestrator.ts`, `logs.ts`, `types.ts`
- All tests passing: 16/16
- TypeScript compilation: Clean, no errors
- Backward compatible: No breaking changes

### Added
- **Control Database Schema Documentation**
  - Documented existing comprehensive schema in `docs/CONTROL_DB_SCHEMA.md`
  - Added schema inspection script: `scripts/show-current-schema.ts`
  - New npm script: `npm run show-schema` to view current database schema
  - Schema includes: semantic_entities (30+ fields!), semantic_relationships, semantic_suggestions, run_logs, query_patterns, context_hints
- Added `SemanticEntity` interface for enhanced semantic knowledge tree
- Added `getSemanticEntities()` function to retrieve entities with all metadata

### Changed
- **Code aligned to match existing database schema** (not the other way around!)
- Updated semantics functions to use actual column names:
  - `primary_table` / `primary_column` (not `table_ref` / `column_ref`)
  - `sql_fragment` (not `sql_pattern`)
  - `category` field added alongside `entity_type`
- Updated logs functions to use actual column names:
  - `sql_generated` / `sql_executed` (not `sql_queries`)
- Removed unused `randomUUID` imports (database generates UUIDs)
- Enhanced README with control database schema documentation links

### Fixed
- Fixed missing `await` keyword in `/show-semantics` command handler that caused `[object Promise]` to be displayed
- Fixed code to match actual database schema instead of assuming schema structure
- Removed dynamic column detection in favor of documented fixed schema
- Debug mode with query approval (`/debug on|off` command)
- Validation for undefined table names in SQL guard
- Comprehensive JSDoc documentation for all critical functions
- Vitest testing framework with initial test suite for SQL guard
- Runtime assertions in critical functions (runSQL, orchestrator.execute)
- Stricter TypeScript compiler options (noUnusedLocals, noUnusedParameters, noImplicitReturns)
- npm scripts for validation: `typecheck`, `test`, `validate`
- Architecture documentation in README

### Changed
- Updated Gemini model from `gemini-pro` to `gemini-2.5-flash` (current API)
- Made control database optional (app works without CONTROL_DB_URL)
- Improved SQL Writer prompt to explicitly list available table names
- Enhanced error messages for better debugging

### Fixed
- SQL guard now catches "undefined" table references before execution
- Permission errors resolved by using correct npm permissions
- Schema loading properly validates empty results

## [1.0.0] - 2026-01-19

### Added
- Initial release of SQL Agent CLI
- Level-2 orchestration with Planner, SQL Writer, and Interpreter roles
- PostgreSQL database inspection with read-only safety
- Gemini LLM integration for natural language to SQL
- SQL safety guard (SELECT only, auto-LIMIT, timeouts)
- Schema caching (in-memory and file-based)
- Control database for semantics and run logs
- Interactive CLI with commands (/refresh-schema, /show-schema, /show-semantics)
- Multi-step query planning with refinement logic
- Comprehensive README with setup instructions

### Security
- Read-only database access enforced
- SQL injection protection through validation
- Statement timeout enforcement (default: 10s)
- Row limit enforcement (default: 200)
- No DML/DDL operations allowed
