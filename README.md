# SQL Agent CLI - Level 2 Orchestration

A complete, runnable CLI tool for querying PostgreSQL databases using Google Gemini with **Level-2 agentic orchestration** and **LLM-interpreted decision making**. The system uses a Planner, SQL Writer, and Interpreter to break down complex questions into multi-step SQL queries, with intelligent orchestration that adapts to agent needs.

## Architecture

- **Orchestrator**: **LLM-interpreted orchestration** - agents express needs, LLM intelligently decides next actions
- **Planner**: Breaks down user questions into step-by-step plans and expresses needs (discovery, clarification, context gaps)
- **SQL Writer**: Generates PostgreSQL queries for each plan step and expresses needs (optimization, blockers)
- **Interpreter**: Analyzes query results and expresses needs (refinement, missing data)
- **Guard**: Validates SQL for safety (SELECT only, auto-LIMIT, timeouts)
- **Control Database**: Stores business semantics and run logs separately from the inspected database

## Project Structure

```
sql-agent/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── config.ts             # Environment configuration
│   ├── types.ts              # TypeScript type definitions
│   ├── agent/
│   │   ├── orchestrator.ts   # Main orchestration loop
│   │   ├── planner.ts        # Planning role
│   │   ├── sqlWriter.ts      # SQL generation role
│   │   ├── interpreter.ts    # Results interpretation role
│   │   └── guard.ts          # SQL safety validation
│   └── tools/
│       ├── db.ts             # Database connection and SQL execution
│       ├── schema.ts         # Schema loading and caching
│       ├── semantics.ts      # Business semantics CRUD
│       └── logs.ts           # Run history storage
├── data/                     # Local schema cache (fallback)
├── .env.example              # Environment variable template
├── package.json
├── tsconfig.json
└── README.md
```

---

## PART A: Environment Prerequisites

### 1. Node.js Installation

**macOS (using Homebrew):**
```bash
brew install node
```

**Or download from:**
- https://nodejs.org/ (recommended: LTS version 20.x or later)

**Verify installation:**
```bash
node --version  # Should show v20.x.x or later
npm --version   # Should show 10.x.x or later
```

### 2. Git Setup

**macOS:**
```bash
# Git is usually pre-installed, verify:
git --version

# If not installed:
brew install git
```

### 3. Project Initialization

If you're starting from scratch in this directory:

```bash
cd /Users/kevinlee/SageSays
npm install
```

---

## PART B: LLM API Setup (Google Gemini)

### 1. Create a Google Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Choose to create a new Google Cloud project or use an existing one
5. Copy the generated API key (starts with `AIza...`)

### 2. Enable Billing (if needed)

- The Gemini API has a free tier with generous limits
- For production use, you may need to enable billing in Google Cloud Console
- Visit: https://console.cloud.google.com/billing

### 3. Test the API Key

You can test your key with a simple curl command:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=YOUR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

Replace `YOUR_API_KEY` with your actual key. You should get a JSON response.

---

## PART C: Inspected Database Setup

Since you already have a PostgreSQL database set up, you need to create a **read-only user** for safety.

### 1. Create a Read-Only User

Connect to your PostgreSQL database as a superuser and run:

```sql
-- Create a read-only user
CREATE USER readonly_user WITH PASSWORD 'your_secure_password_here';

-- Grant connection privilege
GRANT CONNECT ON DATABASE your_database_name TO readonly_user;

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO readonly_user;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;

-- Grant SELECT on all future tables (optional, for convenience)
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT SELECT ON TABLES TO readonly_user;

-- Grant SELECT on all sequences (if needed)
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO readonly_user;
```

**Replace:**
- `readonly_user` with your desired username
- `your_secure_password_here` with a strong password
- `your_database_name` with your actual database name

### 2. Format for DATABASE_URL

Your `DATABASE_URL` should be in this format:

```
postgresql://readonly_user:your_secure_password_here@localhost:5432/your_database_name
```

**For remote databases:**
```
postgresql://readonly_user:password@host.example.com:5432/database_name
```

**For SSL connections:**
```
postgresql://readonly_user:password@host:5432/database_name?sslmode=require
```

---

## PART D: Control Database Setup

We recommend **Neon** (free tier, easy setup) for the control database. This is a **separate** database from your inspected database.

### Option 1: Neon (Recommended)

1. Go to https://neon.tech
2. Sign up for a free account
3. Create a new project
4. Copy the connection string (it will look like: `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb`)
5. This will be your `CONTROL_DB_URL`

### Option 2: Supabase

1. Go to https://supabase.com
2. Create a new project
3. Go to Settings → Database
4. Copy the connection string
5. Use it as `CONTROL_DB_URL`

### Option 3: Railway

1. Go to https://railway.app
2. Create a new project
3. Add a PostgreSQL service
4. Copy the connection string from the Variables tab
5. Use it as `CONTROL_DB_URL`

### Option 4: Local Postgres

If you have PostgreSQL installed locally:

```bash
# Create a new database
createdb control_db

# The connection string will be:
# postgresql://your_username@localhost:5432/control_db
```

### Control Database Schema

**⚠️ IMPORTANT**: The control database uses a comprehensive, fixed schema for semantic learning.

**Your control database should already have this schema.** If you're setting up a new control database, refer to your existing database structure.

#### View Your Schema

To see your current control database structure:

```bash
npm run show-schema
```

This displays all tables, columns, and row counts.

#### Schema Overview

The control database includes these tables:

1. **`semantic_entities`** - Business concepts, metrics, dimensions, and rules (30+ fields!)
2. **`semantic_relationships`** - Relationships between semantic entities
3. **`semantic_suggestions`** - User feedback and corrections for learning
4. **`run_logs`** - History of all query executions
5. **`query_patterns`** - Learned query patterns for optimization
6. **`context_hints`** - Domain-specific hints for query generation

**Full Documentation**: See [`docs/CONTROL_DB_SCHEMA.md`](docs/CONTROL_DB_SCHEMA.md) for complete schema definition, field descriptions, and examples.

---

## PART E: Environment Variable Setup

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` with your actual values:

```env
# Gemini API Configuration
GEMINI_API_KEY=AIzaSyC...your_actual_key_here

# Inspected Database (Postgres) - the database you want to query
DATABASE_URL=postgresql://readonly_user:password@localhost:5432/your_database

# Control Database (Postgres) - stores semantics and run logs
CONTROL_DB_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb

# Safety Configuration
MAX_ROWS=200
STATEMENT_TIMEOUT_MS=10000
MAX_RESULT_ROWS_FOR_LLM=50
```

**Important:** Never commit your `.env` file to git. It's already in `.gitignore`.

---

## PART F: Running the Project

### 1. Install Dependencies

```bash
npm install
```

This will install:
- `@google/generative-ai` - Gemini API client
- `pg` - PostgreSQL client
- `dotenv` - Environment variable loading
- TypeScript and development tools

### 2. Build the Project (Optional)

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

### 3. Run in Development Mode

```bash
npm run dev
```

This uses `tsx` to run TypeScript directly without building.

### 4. Test with a Sample Question

Once the CLI starts, you'll see:

```
🚀 SQL Agent CLI - Level 2 Orchestration
==========================================

🔧 Initializing control database...
✓ Control database initialized

🔧 Testing inspected database connection...
✓ Inspected database connection successful

Ready! Type a question or /help for commands.

>
```

Try asking a question like:
```
> How many users are in the database?
```

Or:
```
> What are the top 10 products by sales?
```

### 5. Available CLI Commands

- `/debug [on|off|smart]` - Toggle debug mode (default: smart)
  - `on` - Always review queries before execution
  - `off` - Execute all queries automatically  
  - `smart` - Review only queries without semantics OR confidence < 95%
- `/refresh-schema` - Refresh the database schema cache
- `/refresh-metadata` - Refresh table metadata (indexes, sizes, foreign keys) from inspected DB
- `/show-schema [table]` - Show database schema (optionally filtered by table name)
- `/show-semantics` - Show business semantics definitions
- `/review-suggestions` - Review pending semantic suggestions for approval
- `/explore <table> [column]` - Explore database schema to discover semantic patterns
  - `table` - Table name to explore (required)
  - `column` - Optional column name to explore
  - Example: `/explore orders` or `/explore orders status`
  - Discovers patterns in data and creates semantic suggestions
- `/help` - Show help message
- `/exit` or `/quit` - Exit the CLI

### 6. Debug Mode

SageSays has three debug modes to control SQL execution:

#### SMART Mode (Default) 🧠

Intelligently decides when to ask for approval based on semantics and confidence:

```
> How many orders were created yesterday?
🔍 Detected 1 relevant semantic(s)
📄 SQL: SELECT COUNT(*) FROM orders WHERE created_at >= ...
✓ Auto-executing (semantics: ✓, confidence: 95%)
```

**Auto-executes when BOTH**:
- ✅ Semantics detected in question
- ✅ Confidence level >= 95% (configurable via `DEBUG_MODE_CONFIDENCE_THRESHOLD`)

**Asks for approval when EITHER**:
- ❌ No semantics detected
- ❌ Confidence < threshold

```
> List all products
📄 SQL: SELECT * FROM products LIMIT 200

🤔 [SMART MODE] Step 1/1 - Review required:
⚠️  Reason(s): no semantics detected
   - Semantics: ✗ None
   - Confidence: 95% (threshold: 95%)

Execute this query? (y/n):
```

#### Other Modes

- **ON**: Always ask for approval (safety first)
  ```
  > /debug on
  🐛 Debug mode: ON - All queries require approval
  ```

- **OFF**: Never ask for approval (speed first)
  ```
  > /debug off
  ✓ Debug mode: OFF - All queries execute automatically
  ```

**Toggle modes**: Type `/debug` without arguments to cycle: OFF → SMART → ON → OFF

**Features:**
- SQL always displayed for transparency
- SMART mode encourages semantic coverage
- Configurable confidence threshold
- Context reset on rejection

### 7. Refresh Schema Cache

If your database schema changes, run:

```
> /refresh-schema
```

Or restart the CLI - it will automatically load the schema on startup.

### 8. Refresh Table Metadata

The system stores metadata about your database tables (indexes, sizes, foreign keys) to optimize queries. To refresh this metadata:

```
> /refresh-metadata
```

Metadata is automatically refreshed on startup if it's missing or older than 7 days. This metadata helps the SQLWriter:
- Use indexed columns for efficient WHERE clauses
- Join smaller tables first
- Use primary keys for lookups
- Leverage foreign keys for correct JOINs

---

## PART G: Safety Features

The SQL Guard enforces the following safety rules:

1. **SELECT Only**: Only allows `SELECT` or `WITH ... SELECT` statements
2. **No DML/DDL**: Blocks `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, etc.
3. **Auto-LIMIT**: Automatically appends `LIMIT 200` if not present
4. **Single Statement**: Blocks multiple statements separated by semicolons
5. **Statement Timeout**: 10 seconds default (configurable via `STATEMENT_TIMEOUT_MS`)
6. **Result Limiting**: Only sends first 50 rows to the LLM (configurable via `MAX_RESULT_ROWS_FOR_LLM`)

### Error Handling & Retry Logic

The system includes automatic retry logic with exponential backoff for LLM API calls:

- **Automatic Retries**: Up to 3 retry attempts for temporary API failures (503, 429)
- **Exponential Backoff**: Delays of 1s, 2s, 4s between retries
- **User Feedback**: Progress updates during retries and helpful error messages
- **Graceful Degradation**: User-friendly guidance when retries are exhausted

Example user experience:
```
⚠️  API overloaded. Retrying in 1s... (attempt 1/3)
⚠️  API overloaded. Retrying in 2s... (attempt 2/3)
✓ Retry succeeded on attempt 3
```

See `docs/ARCHITECTURE.md` for technical details.

---

## PART G: Development & Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Open test UI
npm run test:ui

# Type check without building
npm run typecheck

# Full validation (type check + build)
npm run validate
```

### Development Workflow

Before committing changes:
1. Run `npm run validate` to ensure type safety
2. Run `npm test` to verify all tests pass
3. Use `/debug on` in the CLI to test query generation
4. Review changes with `git diff`

See `docs/DEVELOPMENT.md` for detailed development guidelines.

### Project Documentation

- `README.md` - Setup and usage instructions (this file)
- `CHANGELOG.md` - Version history and changes
- `docs/ARCHITECTURE.md` - System design and architecture decisions
- `docs/DEVELOPMENT.md` - Development workflow and guidelines

---

## PART H: Optional Deployment Guide

### Docker Container

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t sql-agent .
docker run --env-file .env sql-agent
```

### Internal CLI Deployment

1. Build the project: `npm run build`
2. Package as a tarball: `npm pack`
3. Distribute the tarball to team members
4. They can install with: `npm install -g sql-agent-1.0.0.tgz`
5. They need to set up their own `.env` file

---

## Troubleshooting

### "Missing required environment variable"
- Make sure your `.env` file exists and has all required variables
- Check that variable names match exactly (case-sensitive)

### "Failed to connect to inspected database"
- Verify `DATABASE_URL` is correct
- Check that the database is running
- Ensure the read-only user has proper permissions
- Test connection with: `psql $DATABASE_URL`

### "Failed to initialize control database"
- Verify `CONTROL_DB_URL` is correct
- Check that the control database exists
- Ensure the user has CREATE TABLE permissions

### "SQL validation failed"
- The guard is blocking potentially dangerous SQL
- Only SELECT queries are allowed
- Check that your question doesn't require write operations

### Gemini API Errors
- Verify your API key is correct
- Check your Google Cloud billing status
- Review API quotas in Google Cloud Console

---

## Adding Business Semantics

You can add business semantics to help the agent understand your domain. Connect to your control database and insert directly:

```sql
INSERT INTO semantic_entities (
  entity_type,
  name,
  category,
  description,
  primary_table,
  primary_column,
  sql_fragment,
  source,
  approved
)
VALUES (
  'DIMENSION',
  'active_user',
  'User Dimensions',
  'A user who has logged in within the last 30 days',
  'users',
  'last_login',
  'last_login >= CURRENT_DATE - INTERVAL ''30 days''',
  'manual',
  true
);
```

> **Note**: In Phase 3+, semantics can be learned automatically from user corrections. See `/review-suggestions` command.

---

## License

MIT
