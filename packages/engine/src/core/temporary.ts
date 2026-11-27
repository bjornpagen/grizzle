/**
 * The session's own temporary schema as a statement names it, and as EXPLAIN (VERBOSE) names the schema of a temporary
 * table the session created: a rule judge's deltas live there (physical/ddl/deltas.ts), and no served statement names
 * it (write/carriers/carriers.ts).
 */
export const temporarySchema = "pg_temp"
