/**
 * A compiled write's stand-ups (runtime/write/flight.ts StandUp): the session objects its flight reads and writes, which
 * its session makes once before its first call of the write, each from the one emitter that names it: every carrier the
 * artifact's statements empty and fill, the program's own and each statement's staged ones (write/carriers/carriers.ts
 * carrierStandUp), in the order the statements name them; then each table the write writes that the rule judge holds,
 * in code point order, by the call of its stand-up (physical/ddl/rules.ts addStandUps).
 */
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { judgedRelations, type LawModel } from "#compiler/laws/model/model.ts"
import type { StandUp } from "#compiler/runtime/write/flight.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import { calledAlone } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { carrierStandUp, carrierTable } from "#compiler/write/carriers/carriers.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"

/**
 * The stand-ups of `artifact` (see the header): its carriers', each once, then the judged tables' it writes, each
 * stand-up's function in the installation's schema `schema`, which the judge's functions live in.
 */
export const writeStandUps = (
	artifact: WriteArtifact,
	laws: LawModel,
	schema: string
): ReadonlyArray<StandUp<EmittedText>> => {
	const tables = [
		...artifact.carriers.map(carrierTable),
		...artifact.statements.flatMap((s) =>
			s.staged.kind === "carriers" ? s.staged.carriers.map((c) => c.table) : []
		)
	]
	const carriers = tables.filter((t, at) => tables.findIndex((u) => u.name === t.name) === at)
	const written = new Set(Object.keys(artifact.deltas))
	return [
		...carriers.map(carrierStandUp),
		...judgedRelations(laws)
			.filter((relation) => written.has(relation))
			.map((relation): StandUp<EmittedText> => ({
				kind: "judged",
				call: emitText(
					calledAlone({ schema, name: identifierOf(identity.ruleStandUp(relation)) }),
					emptyNameMap
				).text
			}))
	]
}
