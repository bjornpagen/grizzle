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

/**
 * What a declared function does with a NULL argument: `called`, PostgreSQL's CALLED ON NULL INPUT, runs its body at
 * every argument, NULL ones among them; `strict`, PostgreSQL's STRICT (RETURNS NULL ON NULL INPUT), runs its body only
 * where every argument is a value, and a call with any NULL argument is NULL, a function of rows returning none,
 * without running it, so inside its body every parameter is a value.
 */
export const functionNullInputs = ["called", "strict"] as const
export type FunctionNullInput = (typeof functionNullInputs)[number]
