/**
 * The family generators and the model they are judged by (test/support/families): the oracle every family test runs
 * against PostgreSQL is checked here first, because an oracle's failures are silent.
 *
 * The lowering's constraints are the theorem: over every state of one owner's first four slots, each holding no row,
 * one or two, under no owner or an owner of count 0 to 3, every row the successor its slot's, the constraints hold
 * exactly when the theorem does, and part by part: the key by the key, within by the owner axis and the closure of the
 * rows at or past the count, whose predecessors no slot's successor names, covers by the last slot and the closure of
 * the rows below it, a gap above the count among the closure's past it.
 *
 * Programs of mutations, as a state machine: every state drawn and every state a program reaches is one the theorem
 * reads back as its families and no constraint refuses; a lawful mutation sends its statements in the order every
 * change sends them and commits to the families it states, which the theorem also reads from the raw state its
 * statements leave; a breaking one leaves a state with the breach it was drawn for and is refused; a misorder sends
 * the lawful statements in another order, commits only to what the lawful order does, and a count it lowers before the
 * rows above that count are gone breaks nothing at that update, no row holding it, but the owner axis where it lowers
 * the count to 0 over a row. Every state any statement leaves on the way, the out-of-order ones included, satisfies
 * the theorem when it breaks no constraint, and breaks none but the member key when the theorem holds and every
 * successor is its slot's.
 *
 * Oracles: the specification. The lowering is exhausted over its box against the theorem, part by part; the programs
 * run as a state machine (commands.ts runProgram) whose judges restate every claim above. Features: the theorem
 * holding, every breach and every violated constraint, a gap above the count; both shapes, every mutation form, each
 * outcome and refusal, a misordered shrink and a misorder that commits, a successor inserted first, an empty and a
 * long family, and the shapes paired with the forms and refusals that differ between them.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { runProgram } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { machineOf, realOf } from "#test/support/families/mutate.ts"
import {
	breachesOf,
	type Constraint,
	familyViolations,
	type Part,
	partOf,
	storedOf,
	theorem
} from "#test/support/families/theorem.ts"
import {
	type BoxFeature,
	boxGen,
	type Feature,
	judgesOf,
	programs,
	storedOfBox
} from "#test/unit/support/families.fixtures.ts"

/** The family lowering holds exactly the theorem, each part by its own constraints. */
export const theFamilyLoweringHoldsExactlyTheTheoremEachPartByItsOwnConstraints = property.exhaust(
	finite(boxGen),
	{
		needs: {},
		situations: [
			"the theorem holds",
			"breach twice",
			"breach orphan",
			"breach beyond",
			"breach gap",
			"violates key",
			"violates holding",
			"violates last",
			"violates closure",
			"a gap above the count"
		] satisfies ReadonlyArray<Reached<BoxFeature>>,
		check: (_, c: Case<BoxFeature>) => (box) =>
			Effect.sync(() => {
				const stored = storedOfBox(box)
				const found = familyViolations(stored)
				const breaches = breachesOf(stored)
				const broken = (part: Part) => Arr.some(breaches, (b) => partOf[b.kind] === part)
				const breaks = (constraints: ReadonlyArray<Constraint>) =>
					Arr.some(found, (v) => constraints.includes(v.constraint))
				/** Whether the closure refuses a row whose slot `at` meets `where`. */
				const closedAt = (where: (at: number) => boolean) =>
					Arr.some(
						found,
						(v) =>
							v.constraint === "closure" &&
							Arr.some(stored.rows, (r) => r.member === v.member && where(r.at))
					)
				assert.equal(
					found.length === 0,
					breaches.length === 0,
					"the constraints hold exactly when the theorem does"
				)
				const read = theorem(stored)
				if (Result.isSuccess(read)) {
					c.note("the theorem holds")
					unorderedEqual(
						storedOf(read.success).rows,
						stored.rows,
						"the families the theorem reads store as the state they were read from"
					)
				}
				if (box.owner.kind === "counted") {
					assert.equal(broken("key"), breaks(["key"]), "the key is the unique slot")
					const count = box.owner.count
					assert.equal(
						broken("within"),
						breaks(["holding"]) || closedAt((at) => at >= count),
						"within is the owner axis, its holding reference, and the closure of the rows at or past the count"
					)
					assert.equal(
						broken("covers"),
						breaks(["last"]) || closedAt((at) => at < count),
						"covers is the last slot and the closure of the rows below the count"
					)
					const gapAbove = Arr.some(
						stored.rows,
						(r) => r.at > count && !Arr.some(stored.rows, (q) => q.at === r.at - 1)
					)
					if (gapAbove && !broken("covers")) {
						c.note("a gap above the count")
					}
				}
				for (const b of breaches) {
					c.note(`breach ${b.kind}`)
				}
				for (const v of found) {
					c.note(`violates ${v.constraint}`)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the family theorem, part by part against the lowering's constraints"
		},
		box: "every state of one owner's first four slots, each holding no row, one or two, under no owner or one of count 0 to 3",
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/array.ts",
				original: "\t\tout.push(i)",
				replacement: "\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/core/array.ts:26 in indices: `out.push(i)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/**
 * Family programs commit lawful mutations to their families, refuse breaking ones and misordered shrinks, and never
 * commit a breach.
 *
 * Budget: its suite's count before the conversion (unit/support/families/programs: 300 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (counted
 * → a misordered shrink; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200,
 * which it stops short of once every situation is reached.
 */
export const familyProgramsCommitLawfulMutationsToTheirFamiliesRefuseBreakingOnesAndMisorderedShrinksAndNeverCommitABreach =
	property.explore(programs, {
		needs: {},
		situations: [
			"ordered",
			"counted",
			"form create",
			"form append",
			"form remove",
			"form insert-at",
			"form swap",
			"form replace",
			"form drop",
			"form count-edit",
			"form beyond",
			"form gap",
			"form twice",
			"form orphan",
			"form misorder",
			"committed",
			"refused at a statement",
			"refused at commit",
			"refused by identity",
			"refused by key",
			"refused by holding",
			"refused by last",
			"refused by closure",
			"a misordered shrink",
			"a misorder that commits",
			"a successor before its predecessor",
			"an empty family",
			"a long family",
			["ordered", "form remove"],
			["counted", "form remove"],
			["ordered", "refused by closure"],
			["counted", "refused by closure"],
			["ordered", "a misordered shrink"],
			["counted", "a misordered shrink"]
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (p) =>
			Effect.gen(function* () {
				c.note(p.shape)
				if (Arr.some(p.families, (f) => f.members.length === 0)) {
					c.note("an empty family")
				}
				if (Arr.some(p.families, (f) => f.members.length >= 3)) {
					c.note("a long family")
				}
				yield* runProgram(
					machineOf(p.shape, p.families, p.forms),
					realOf(judgesOf(p.shape, c)),
					p.steps
				)
			}),
		oracle: {
			kind: "specification",
			name: "the theorem read from every state a program's statements leave, and each mutation form's claim"
		},
		budget: { runs: 300, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/array.ts",
				original: "\tfor (let i = 0; i < n; i++) {",
				replacement: "\tfor (let i = 0; i >= n; i++) {",
				why: "Operator mutant (comparison) at packages/engine/src/core/array.ts:25 in indices: `<` becomes `>=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
