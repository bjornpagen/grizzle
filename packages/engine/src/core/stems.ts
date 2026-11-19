import type { CompileError } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import type { Result } from "#compiler/core/result.ts"

/**
 * A login's or a role's stem, the PostgreSQL role its identity spells, which `grizzle generate` commits, computed once
 * as login(...) or role(...) builds the value (schema/stem.ts): an installation installs it under its role prefix
 * (roleNameOf). Its refusal, a declared name the naming door refuses or a role past PostgreSQL's 63 bytes, is kept as
 * the stem, for roleNameOf to throw and generate to report.
 */
export type WorldStem = Result<string, CompileError>

/**
 * Each login's and role's stem, by the value its builder made (schema/world.ts): the builders' own bookkeeping, which
 * roleNameOf reads and no type of the value states, so a caller reads a role's PostgreSQL role through roleNameOf alone.
 * A WeakMap holds nothing alive and is never enumerated, so it is no cache.
 */
const stems = new WeakMap<object, WorldStem>()

/** Records the stem of `value`, a login or a role its builder has just made. */
export const recordStem = (value: object, stem: WorldStem): void => {
	stems.set(value, stem)
}

/** The stem of a login or a role, as its builder recorded it. */
export const stemOf = (value: object): WorldStem =>
	defined(
		stems.get(value),
		"a login or a role login(...) or role(...) built, which recorded its stem"
	)
