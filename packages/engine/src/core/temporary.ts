/**
 * The session's own temporary schema as a statement names it, and as EXPLAIN (VERBOSE) names the schema of a temporary
 * table the session created: no statement grizzle installs or serves names it, none of them DDL, so a connection's life
 * after install makes no object there (write/carriers/carriers.ts, physical/ddl/rules.ts addRules).
 */
export const temporarySchema = "pg_temp"
