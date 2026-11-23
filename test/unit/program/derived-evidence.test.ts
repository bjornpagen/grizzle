import { defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { carrierScope } from "#compiler/sql/naming.ts"
import { changeSetOver as ChangeSet, changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import {
	type EvidenceFeature,
	installedOf,
	projectionOf,
	shown,
	space
} from "#test/unit/program/derived-evidence.fixtures.ts"

/** A query over a stored derived relation rests its optimized proof, and a read-back's of it, on its table's key. */
export const aQueryOverAStoredDerivedRelationRestsItsOptimizedProofAndAReadBacksOfItOnItsTablesKey =
	property.exhaust(finite(space), {
		needs: {},
		situations: [
			"DocWords",
			"LongLines",
			"read-back over a stored relation"
		] satisfies ReadonlyArray<Reached<EvidenceFeature>>,
		check:
			(_, c: Case<EvidenceFeature>) =>
			({ view, columns }) =>
				Effect.sync(() => {
					c.note(view.relation.name)
					const { index, artifacts } = installedOf(view)
					const what = `the projection of ${view.relation.name} to ${Arr.join(columns, ", ")}`
					const template = compileTemplate(projectionOf(view, columns), view.schema, testCompile)
					if (!template.ok) {
						throw new Error(`${what} does not compile: ${template.error.message}`)
					}
					const premises = Arr.flatMap(template.value.certificates, (certificate) =>
						Arr.flatMap(certificate.premises, (p) =>
							p.kind === "constraint" ? [p.constraint] : []
						)
					)
					if (!premises.includes(index)) {
						throw new Error(`${what} rests on ${shown(premises)}, not on its table's key ${index}`)
					}
					/** A ChangeSet whose one read-back is the projection. */
					const readBack = ChangeSet.empty(view.schema).read("projection", () =>
						projectionOf(view, columns)
					)
					const write = compileWrite(
						checking(view.schema),
						defined(changeSetDesc(readBack), "the ChangeSet's Description"),
						{
							names: artifacts.names,
							reads: artifacts.reads,
							claims: { kind: "every" },
							world: { kind: "reality" },
							laws: artifacts.laws,
							derived: artifacts.derived,
							level: "serializable",
							clock: noClock,
							source: transactionClock,
							carrierScope: carrierScope(undefined)
						}
					)
					if (!write.ok) {
						throw new Error(`a read-back of ${what} does not compile: ${write.error.message}`)
					}
					const cited = Arr.flatMap(write.value.certificates, (certificate) =>
						Arr.flatMap(certificate.premises, (p) =>
							p.kind === "constraint" ? [p.constraint] : []
						)
					)
					if (!cited.includes(index)) {
						throw new Error(
							`a read-back of ${what} rests on ${shown(cited)}, not on its table's key ${index}`
						)
					}
					c.note("read-back over a stored relation")
				}),
		oracle: {
			kind: "specification",
			name: "a projection keeping a stored relation's inherited key rests on its table's key, in a template and in a read-back"
		},
		box: "every projection of the box's stored DocWords and LongLines that keeps its inherited key and drops another column",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/annotate.ts",
				original:
					"export const queryEvidence: LogicalEnv = Object.freeze({ ...checkerEvidence, keyedViews: true })",
				replacement:
					"export const queryEvidence: LogicalEnv = Object.freeze({ ...checkerEvidence, keyedViews: false })",
				why: "A query's evidence keys no view."
			}
		]
	})
