/**
 * The session's own temporary schema as a statement names it, and as EXPLAIN (VERBOSE) names the schema of a temporary
 * table the session created: a write's carriers live there (write/program/staged.ts).
 */
export const temporarySchema = "pg_temp"
