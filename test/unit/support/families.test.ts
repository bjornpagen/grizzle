import { describe, it } from "@effect/vitest"
import { runProgram } from "@grizzle/testing/commands"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { firstIndex, indices } from "#compiler/core/array.ts"
import {
	assert,
	assertVariant,
	defined,
	failed,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import {
	applied,
	type Form,
	type Judges,
	machineOf,
	type Outcome,
	placeOf,
	type Program,
	type ProgramSpace,
	programGen,
	realOf,
	type MutationStatement,
	run
} from "#test/support/families/mutate.ts"
import {
	type Breach,
	breachesOf,
	type Constraint,
	type Families,
	familyViolations,
	type FamilyRow,
	type Part,
	partOf,
	SHAPES,
	type Shape,
	type Stored,
	storedOf,
	theorem
} from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The family generators and the model they are judged by (test/support/families): the oracle every family test runs
 * against PostgreSQL is checked here first, because an oracle's failures are silent.
 *
 * The lowering's constraints are the theorem: over every state of one owner's first four slots, each holding no row,
 * one or two, under no owner or an owner of count 0 to 3, the constraints hold exactly when the theorem does, and
 * part by part, the key by the key, within by the copy and the bound, covers by the last slot and the closure below the
 * copy, which leaves a gap above the count to the bound alone.
 *
 * Programs of mutations, as a state machine: every state drawn and every state a program reaches is one the theorem
 * reads back as its families and no constraint refuses; a lawful mutation sends its statements in the order every
 * change sends them and commits to the families it states, which the theorem also reads from the raw state its
 * statements leave; a breaking one leaves a state with the breach it was drawn for and is refused; a misorder sends
 * the lawful statements in another order, commits only to what the lawful order does, and a count it lowers before the
 * rows above that count are gone is refused at that update or before, by the bound its cascade breaks. Every state
 * any statement leaves on the way, the out-of-order ones included, satisfies the theorem when it breaks no constraint,
 * and breaks none but the member key when the theorem holds and every copy is its owner's count.
 */

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

const boxGen: Gen<Box> = (source) => ({
	owner: source.draw(element(boxOwners)),
	held: Arr.map(indices(boxSlots), () => source.draw(element(slotHeld)))
})

/** A box's state: its rows numbered in slot order, each copying the count, or past every slot under no owner. */
const storedOfBox = (box: Box): Stored => {
	const copy = box.owner.kind === "absent" ? boxSlots : box.owner.count
	const rows: Array<FamilyRow> = []
	for (const [at, held] of box.held.entries()) {
		for (let row = 0; row < held; row++) {
			rows.push({ group: 0, at, copy, member: rows.length })
		}
	}
	return {
		owners:
			box.owner.kind === "absent" ? new Map<number, number>() : new Map([[0, box.owner.count]]),
		rows
	}
}

type BoxFeature =
	| "the theorem holds"
	| `breach ${Breach["kind"]}`
	| `violates ${Constraint}`
	| "a gap above the count"

describe("the family lowering", () => {
	it.effect("holds exactly the theorem, each part by its own constraints", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: { kind: "unstated" },
					oracle: { kind: "unstated" },
					suite: "unit/support/families/lowering",
					generator: boxGen,
					literal: Formatter.format,
					limit: boxOwners.length * slotHeld.length ** boxSlots,
					coverage: requiredInSpace<BoxFeature>([
						"the theorem holds",
						"breach twice",
						"breach orphan",
						"breach beyond",
						"breach gap",
						"violates key",
						"violates bound",
						"violates copy",
						"violates last",
						"violates closure",
						"a gap above the count"
					]),
					caseHang
				},
				(box, c) =>
					Effect.sync(() => {
						const stored = storedOfBox(box)
						const found = familyViolations(stored)
						const breaches = breachesOf(stored)
						const broken = (part: Part) => Arr.some(breaches, (b) => partOf[b.kind] === part)
						const breaks = (constraints: ReadonlyArray<Constraint>) =>
							Arr.some(found, (v) => constraints.includes(v.constraint))
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
							assert.equal(
								broken("within"),
								breaks(["copy", "bound"]),
								"within is the copy and the bound"
							)
							assert.equal(
								broken("covers"),
								breaks(["last", "closure"]),
								"covers is the last slot and the closure below the copy"
							)
							const count = box.owner.count
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
					})
			)
		)
	)
})

type Feature =
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

const programs: Gen<Program> = (source) =>
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
		(s, i) => i === 0 || placeOf[Arr.getUnsafe(statements, i - 1).kind] <= placeOf[s.kind]
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

/**
 * Any state, however reached: one that breaks no constraint satisfies the theorem, and one the theorem holds of whose
 * copies are its owners' counts breaks no constraint but, possibly, the member key, which the theorem does not read.
 */
const judgeState = (state: Stored): void => {
	const found = familyViolations(state)
	const read = theorem(state)
	if (found.length === 0) {
		succeeded(read, "a state that breaks no constraint satisfies the theorem")
	}
	if (Result.isSuccess(read) && !Arr.some(found, (v) => v.constraint === "copy")) {
		assert.deepEqual(
			Arr.filter(found, (v) => v.constraint !== "identity"),
			[],
			"a state the theorem holds of, every copy its owner's count, breaks no constraint of the lowering"
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

const judgesOf = (shape: Shape, c: Case<Feature>): Judges<never, never> => ({
	lawful: (form, m, before, after) =>
		Effect.sync(() => {
			c.note(`form ${form}`)
			c.pair(shape, `form ${form}`)
			judgeBefore(before)
			assert.ok(
				inPlace(m.statements),
				"a lawful mutation sends deletes, then moves, then the count, then inserts"
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
				assertVariant(
					outcome,
					"kind",
					"refused",
					"a count lowered before the rows above it go is refused"
				)
				assertVariant(outcome.moment, "kind", "statement", "at a statement")
				assert.ok(outcome.moment.index <= lowered, "at the count update or before it")
				if (outcome.moment.index === lowered) {
					assert.ok(
						Arr.some(outcome.violations, (v) => v.constraint === "bound"),
						"by the bound the count's cascade breaks"
					)
				}
			}
			for (const state of statesOf(before, m.statements)) {
				judgeState(state)
			}
			noteOutcome(c, shape, outcome)
		})
})

describe("family programs", () => {
	it.effect(
		"commit lawful mutations to their families, refuse breaking ones and misordered shrinks, and never commit a breach",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/support/families/programs",
						draw: drawn(programs),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
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
								"refused by bound",
								"refused by copy",
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
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) =>
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
						})
				)
			)
	)
})
