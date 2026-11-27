/**
 * A compiled write's stand-ups (runtime/write/flight.ts StandUp): the session objects its flight writes, which its
 * session makes once before its first call of the write: each table the write writes that the installation's rule judge
 * holds (laws/model/model.ts LawModel `judged`), whatever level states the rule that reads it, in code point order, by
 * the call of its stand-up (physical/ddl/rules.ts addStandUps). Its carriers are no session object: they travel in its
 * transaction's settings (write/carriers/carriers.ts).
 */
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { StandUp } from "#compiler/runtime/write/flight.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { calledAlone } from "#compiler/sql/build.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"

/** The stand-ups of `artifact` (see the header), each the statement that calls its stand-up's function in the
 * installation's schema `schema`, which the judge's functions live in. */
export const writeStandUps = (
	artifact: WriteArtifact,
	laws: LawModel,
	schema: string
): ReadonlyArray<StandUp<Select>> => {
	const written = new Set(Object.keys(artifact.deltas))
	return laws.judged
		.filter((relation) => written.has(relation))
		.map((relation): StandUp<Select> => ({
			kind: "judged",
			call: calledAlone({ schema, name: identifierOf(identity.ruleStandUp(relation)) })
		}))
}
