/**
 * The closed vocabularies of a declared function (schema/function.ts fn), which its Description, its installed
 * statement and its public type read alike.
 */

/** A declared function's volatility: what PostgreSQL may assume of a call's result across a statement and a snapshot. */
export const functionVolatilities = ["immutable", "stable", "volatile"] as const
export type FunctionVolatility = (typeof functionVolatilities)[number]

/** A declared function's language: PL/pgSQL, or SQL whose body is a string of statements. */
export const declaredLanguages = ["plpgsql", "sql"] as const
export type DeclaredLanguage = (typeof declaredLanguages)[number]
