/** What the properties of families.test.ts read: its spaces, models and helpers. */

import { firstIndex, indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, assertVariant, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { failed, succeeded } from "#test/support/assert.ts"
import {
	applied,
	type Form,
	type Judges,
	type MutationStatement,
	type Outcome,
	type Program,
	programGen,
	type ProgramSpace,
	run,
	sendPlace
} from "#test/support/families/mutate.ts"
import {
	type Breach,
	type Constraint,
	type Families,
	type FamilyRow,
	familyViolations,
	type Shape,
	SHAPES,
	type Stored,
	storedOf,
	successorOf,
	theorem
} from "#test/support/families/theorem.ts"

/** A box's owner: none, or one of a count. */
type BoxOwner = { readonly kind: "absent" } | { readonly kind: "counted"; readonly count: number }

/** One owner's first slots as stored: its owner, and how many rows hold each slot. */
interface Box {
	readonly owner: BoxOwner
	readonly held: ReadonlyArray<number>
}

const boxSlots = 4

/** Every owner a box draws: none, or a count from 0 to one below the slots. */
const boxOwners: Arr.NonEmptyReadonlyArray<BoxOwner> = [
	{ kind: "absent" },
	...Arr.map(indices(boxSlots), (count): BoxOwner => ({ kind: "counted", count }))
]

/** How many rows a box's slot holds: none, one or two. */
const slotHeld = [0, 1, 2] as const

export const boxGen: Gen<Box> = (source) => ({
	owner: source.draw(element(boxOwners)),
	held: Arr.map(indices(boxSlots), () => source.draw(element(slotHeld)))
})

/**
 * A box's state: its rows numbered in slot order, each holding the successor the host draws at its slot in its owner's
 * count (theorem.ts successorOf), its own slot under no owner.
 */
export const storedOfBox = (box: Box): Stored => {
	const owner = box.owner
	const rows: Array<FamilyRow> = []
	for (const [at, held] of box.held.entries()) {
		const next = owner.kind === "absent" ? at : successorOf(at, owner.count)
		for (let row = 0; row < held; row++) {
			rows.push({ group: 0, at, next, member: rows.length })
		}
	}
	return {
		owners:
			box.owner.kind === "absent" ? new Map<number, number>() : new Map([[0, box.owner.count]]),
		rows
	}
}

export type BoxFeature =
	| "the theorem holds"
	| `breach ${Breach["kind"]}`
	| `violates ${Constraint}`
	| "a gap above the count"

export type Feature =
	| Shape
	| `form ${Form}`
	| "committed"
	| "refused at a statement"
	| "refused at commit"
	| `refused by ${Constraint}`
	| "a misordered shrink"
	| "a misorder that commits"
	| "a successor before its predecessor"
	| "an empty family"
	| "a long family"

const space: ProgramSpace = {
	families: { owners: { min: 0, max: 3 }, long: { min: 3, max: 6 } },
	steps: { min: 1, max: 8 }
}

export const programs: Gen<Program> = (source) =>
	source.draw(programGen(source.draw(element(SHAPES)), space))

/** Every state the statements leave, from the families' own, none checked. */
const statesOf = (
	before: Families,
	statements: ReadonlyArray<MutationStatement>
): Arr.NonEmptyReadonlyArray<Stored> => Arr.scan(statements, storedOf(before), applied)

/** Whether the statements are in the order every change sends them. */
const inPlace = (statements: ReadonlyArray<MutationStatement>): boolean =>
	Arr.every(
		statements,
		(s, i) => i === 0 || sendPlace[Arr.getUnsafe(statements, i - 1).kind] <= sendPlace[s.kind]
	)

/** Whether an insert lists a row before the row one slot below it in its group. */
const successorFirst = (statements: ReadonlyArray<MutationStatement>): boolean =>
	Arr.some(
		statements,
		(s) =>
			s.kind === "insert" &&
			Arr.some(s.rows, (r, i) =>
				Arr.some(s.rows.slice(i + 1), (q) => q.group === r.group && q.at === r.at - 1)
			)
	)

/** A drawn or reached state: the theorem reads it back as its families, and it breaks no constraint. */
const judgeBefore = (before: Families): void => {
	assert.deepEqual(
		succeeded(theorem(storedOf(before))),
		before,
		"the theorem reads a committed state back as its families"
	)
	assert.deepEqual(familyViolations(storedOf(before)), [], "a committed state breaks no constraint")
}

/** Whether every row holds the successor the host draws at its slot in its owner's count, every row of an owner. */
const drawnSuccessors = (state: Stored): boolean =>
	Arr.every(state.rows, (r) => {
		const count = state.owners.get(r.group)
		return count !== undefined && r.next === successorOf(r.at, count)
	})

/**
 * Any state, however reached: one that breaks no constraint satisfies the theorem, and one the theorem holds of whose
 * every successor is its slot's breaks no constraint but, possibly, the member key, which the theorem does not read.
 */
const judgeState = (state: Stored): void => {
	const found = familyViolations(state)
	const read = theorem(state)
	if (found.length === 0) {
		succeeded(read, "a state that breaks no constraint satisfies the theorem")
	}
	if (Result.isSuccess(read) && drawnSuccessors(state)) {
		assert.deepEqual(
			Arr.filter(found, (v) => v.constraint !== "identity"),
			[],
			"a state the theorem holds of, every successor its slot's, breaks no constraint of the lowering"
		)
	}
}

const noteOutcome = (c: Case<Feature>, shape: Shape, outcome: Outcome): void => {
	switch (outcome.kind) {
		case "committed":
			c.note("committed")
			return
		case "refused":
			c.note(outcome.moment.kind === "statement" ? "refused at a statement" : "refused at commit")
			for (const v of outcome.violations) {
				c.note(`refused by ${v.constraint}`)
				c.pair(shape, `refused by ${v.constraint}`)
			}
	}
}

export const judgesOf = (shape: Shape, c: Case<Feature>): Judges<never, never> => ({
	lawful: (form, m, before, after) =>
		Effect.sync(() => {
			c.note(`form ${form}`)
			c.pair(shape, `form ${form}`)
			judgeBefore(before)
			assert.ok(
				inPlace(m.statements),
				"a lawful mutation sends deletes, then moves, then seams, then the count, then inserts"
			)
			const outcome = run(shape, before, m.statements)
			assert.deepEqual(
				outcome,
				{ kind: "committed", after: m.after },
				"a lawful mutation commits to the families it states"
			)
			assert.deepEqual(after, m.after, "the machine advances to them")
			const states = statesOf(before, m.statements)
			assert.deepEqual(
				succeeded(theorem(Arr.lastNonEmpty(states))),
				m.after,
				"the theorem reads them from the state the statements leave"
			)
			for (const state of states) {
				judgeState(state)
			}
			noteOutcome(c, shape, outcome)
			if (successorFirst(m.statements)) {
				c.note("a successor before its predecessor")
			}
		}),
	breaking: (form, m, before, after) =>
		Effect.sync(() => {
			c.note(`form ${form}`)
			judgeBefore(before)
			const states = statesOf(before, m.statements)
			assert.ok(
				Arr.some(failed(theorem(Arr.lastNonEmpty(states))), (b) => b.kind === m.breaks),
				`a ${form} leaves a ${m.breaks}`
			)
			const outcome = run(shape, before, m.statements)
			assertVariant(outcome, "kind", "refused", `a ${form} is refused`)
			assert.deepEqual(after, before, "a refused mutation leaves the families as they were")
			for (const state of states) {
				judgeState(state)
			}
			noteOutcome(c, shape, outcome)
		}),
	misordered: (m, before, after) =>
		Effect.sync(() => {
			c.note("form misorder")
			judgeBefore(before)
			assert.ok(inPlace(m.prescribed), "its lawful mutation's statements are in order")
			assert.ok(!inPlace(m.statements), "a misorder sends them out of order")
			unorderedEqual(
				m.statements,
				m.prescribed,
				"a misorder sends the lawful mutation's statements"
			)
			assert.deepEqual(
				run(shape, before, m.prescribed),
				{ kind: "committed", after: m.after },
				"the lawful order commits to the families the misorder states"
			)
			const outcome = run(shape, before, m.statements)
			switch (outcome.kind) {
				case "committed":
					c.note("a misorder that commits")
					assert.deepEqual(
						outcome.after,
						m.after,
						"a misorder commits only to what its lawful order does"
					)
					assert.deepEqual(after, m.after, "the machine advances to it")
					break
				case "refused":
					assert.deepEqual(after, before, "a refused mutation leaves the families as they were")
					break
			}
			const lowered = firstIndex(
				m.statements,
				(s) =>
					s.kind === "count" &&
					s.count <
						defined(Option.getOrUndefined(Arr.findFirst(before, (f) => f.owner === s.owner)))
							.members.length
			)
			if (
				lowered !== undefined &&
				Arr.some(m.statements.slice(lowered + 1), (s) => s.kind === "delete" || s.kind === "move")
			) {
				c.note("a misordered shrink")
				c.pair(shape, "a misordered shrink")
				assert.ok(
					!(
						outcome.kind === "refused" &&
						outcome.moment.kind === "statement" &&
						outcome.moment.index === lowered
					),
					"a count lowered before the rows above it go breaks nothing at its update: no constraint a statement's end checks reads the count, and no row holds it"
				)
			}
			for (const state of statesOf(before, m.statements)) {
				judgeState(state)
			}
			noteOutcome(c, shape, outcome)
		})
})
