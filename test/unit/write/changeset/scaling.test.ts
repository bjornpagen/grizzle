/**
 * A ChangeSet builder step reads only what it adds. Its Description is its members' own Descriptions assembled, so
 * every container of the Description before the step, and of the query it adds, is carried into the one after it by
 * reference: the step builds a fixed number of containers whatever the ChangeSet's size, where a decode of the whole
 * would copy every one. Its member states are carried by reference too, so the step computes the identity text of its
 * new member alone. Both counts are taken at four sizes. The assembled Description is the one the whole decode gives,
 * the old path, kept here as the oracle.
 *
 * Oracles: the specification for the step's reads (every step of a growth builds as many containers as its first, and
 * one member state), and the whole decode for the assembled Description (a second implementation).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, finite, int, map } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	asTheOldPath,
	built,
	counts,
	growthNames,
	growths,
	opOf
} from "#test/unit/write/changeset/scaling.fixtures.ts"

/** A ChangeSet builder step reads only what it adds builds a fixed number of containers and one member state a step, at 50, 100, 200 and 400. */
export const aChangeSetBuilderStepReadsOnlyWhatItAddsBuildsAFixedNumberOfContainersAndOneMemberStateAStepAt50100200And400 =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(growthNames)),
					source.draw(map(int(0, 3), (doublings) => 50 * 2 ** doublings))
				] as const
		),
		{
			needs: {},
			situations: [],
			check:
				() =>
				([name, n]) =>
					Effect.sync(() => {
						const steps = counts(growths[name], n)
						const first = defined(steps[0], "the first step")
						assert.equal(first.members, 1)
						for (const [i, step] of steps.entries()) {
							assert.deepEqual(step, first, `step ${i + 1} of ${n}`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "a step builds a fixed number of containers and one member state, whatever the ChangeSet's size"
			},
			box: "each growth (a query member; an array member into its group then a query member; a query member after a bind) at 50, 100, 200 and 400 steps",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original:
						"\t\tstrata: released.strata.map((s, i) => (i === last ? withMember(s, member) : s)),",
					replacement:
						"\t\tstrata: released.strata.map((s, i) => {\n\t\t\tconst copied = s.map((m) => ({ ...m }))\n\t\t\treturn i === last ? withMember(copied, member) : copied\n\t\t}),",
					why: "A step that copies every earlier member's state (write/changeset/value.ts scopeWith)."
				}
			]
		}
	)

/**
 * A ChangeSet builder step reads only what it adds assembles the Description the whole decode gives, over generated
 * programs.
 *
 * Budget: 300 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/scaling.test.ts:318 at 8cad5bce, its runs and its coverage's cases).
 */
export const aChangeSetBuilderStepReadsOnlyWhatItAddsAssemblesTheDescriptionTheWholeDecodeGivesOverGeneratedPrograms =
	property.explore(
		(source) =>
			Arr.map(source.draw(array(int(0, 9), { min: 1, max: 12 })), (kind) =>
				opOf(kind, source.draw(int(1, 4)))
			),
		{
			needs: {},
			budget: { runs: 300, steered: 0 },
			situations: [],
			check: () => (ops) =>
				Effect.sync(() => {
					for (const value of built(ops)) {
						asTheOldPath(value)
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the whole decode of the Description, the old path, with its keys' order"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original:
						"\t\tcanonicalStrata([...x.strata, ...y.strata]),\n\t\t[...x.reads, ...y.reads],\n\t\tbound\n",
					replacement:
						"\t\tcanonicalStrata([...x.strata, ...y.strata]),\n\t\t[...x.reads],\n\t\tbound\n",
					why: "Operator mutant (element) in sequenceOf: `[...x.reads, ...y.reads]` becomes `[...x.reads]`, so a sequence drops its second ChangeSet's read-backs; the property fails (lane CATCH, grizzle 0baff5d6, its original requoted at the read-back set, lane READBACK)."
				}
			]
		}
	)
