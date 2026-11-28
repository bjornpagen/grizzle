/**
 * A statement a lowering composes into another is never printed apart (lower/optimize/pipeline.ts lowerComposed): a
 * rule's judged query, which reads each delta by a CTE no statement binds, is read whole by the statement that reads it
 * as its block's arrays (physical/ddl/deltas.ts headed), and that statement's one print is its function's body,
 * made where the installation is printed. So an installation's compile prints nothing, however many judged queries it
 * lowers, where each judged query printed twice and threw both texts away (lower/conservative/deliver.ts
 * printedStatement, then its executable form).
 *
 * The count is work, never time: V8's precise coverage counts each call of sql/emit.ts emitText, the printer's one
 * door, and of the composed statements' text maker (sql/emit.ts unprintedText), each statement a composed lowering
 * makes (kernel/calls.ts everyCallCount). The box is exhausted: every law, judge and number of arms.
 *
 * Oracle: the specification, no print at an installation's compile, and its judged queries composed.
 *
 * Features: a whole rule's statement and a probe's.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { printsAt, type Reached, shapeGen } from "#test/unit/physical/composed-prints.fixtures.ts"

/** An installation's compile prints no statement it composes into another, however many judged queries it lowers. */
export const anInstallationsCompilePrintsNoStatementItComposesIntoAnother = property.exhaust(
	finite(shapeGen),
	{
		needs: {},
		situations: ["a whole rule's statement", "a probe's statement"] satisfies ReadonlyArray<
			ReachedOf<Reached>
		>,
		check: (_, c: Case<Reached>) => (shape) =>
			Effect.gen(function* () {
				c.note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
				const at = yield* printsAt(shape)
				assert.ok(at.composed > 0, "the rule's judged queries are composed")
				assert.equal(
					at.prints,
					0,
					`the installation's compile prints, beside its ${at.composed} composed statements`
				)
			}),
		oracle: {
			kind: "specification",
			name: "no print at an installation's compile, its judged queries composed"
		},
		box: "every rule over D, a union of one to four rules over T each selecting T by a literal of its own, a check, S's containment or a key, whole or probed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/emit.ts",
				original:
					"export const unprintedText: TextOf<UnprintedSql> = (_statement, nameMap) => ({ nameMap })\n",
				replacement:
					"export const unprintedText: TextOf<UnprintedSql> = (statement, nameMap) => ({\n\tnameMap: emitText(statement, nameMap).nameMap\n})\n",
				why: "A composed statement printed as its lowering builds it, a text nothing sends, which reads names only the statement composing it binds: the scope check refuses a judged query's, and the compile prints."
			}
		]
	}
)
