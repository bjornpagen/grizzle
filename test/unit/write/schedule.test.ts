import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import type { ActionCore } from "#compiler/ir/write.ts"
import { completeClass } from "#compiler/ir/write.ts"
import { canonicalActionOrder, scheduleStratum } from "#compiler/write/frontend/schedule.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A stratum's schedule holds an immediate foreign key at every statement: one stratum's actions over a relation C and a
 * pure set P that C references immediately, the foreign key grizzle makes immediate only into a pure set, from every
 * lawful state of a small box to every lawful state its actions reach, keep every C fact's reference in P after each
 * statement they send, in the order the schedule gives them.
 *
 * The oracle is a model of the statements each action sends, not of the schedule's rule: a deletion removes its fact; an
 * insertion adds it; a put of a relation with a payload displaces the occupant of its key, then inserts; and a pure set's
 * put inserts alone, since its fact at a key is the key. C has a payload or is a pure set itself, and the two relations
 * are named in both orders, so the canonical order, by name, puts either first. A stratum whose final state breaks the
 * key or the reference is refused whatever its order, and is no case.
 */

/** A fact: P's an id; C's an id and the P id it references. */
type Fact = readonly [id: number, p: number]

type Op = "insert" | "put" | "delete"

interface Write {
	readonly op: Op
	readonly fact: Fact
}

interface Box {
	/** Whether C sorts before P by name, so the canonical order puts C's action first. */
	readonly sourceFirst: boolean
	/** Whether C has a payload, its reference outside its key, so its put displaces the occupant of its key. */
	readonly keyed: boolean
	readonly p: ReadonlyArray<number>
	readonly c: ReadonlyArray<Fact>
	readonly onP: Write | undefined
	readonly onC: Write | undefined
}

const same = (a: Fact, b: Fact): boolean => a[0] === b[0] && a[1] === b[1]

/** C's facts after a write of it, or none where the write is refused by C's key: an insertion at an occupied key. */
const cAfter = (
	box: Box,
	facts: ReadonlyArray<Fact>,
	w: Write
): ReadonlyArray<Fact> | undefined => {
	switch (w.op) {
		case "delete":
			return Arr.filter(facts, (f) => !same(f, w.fact))
		case "insert":
			if (Arr.some(facts, (f) => same(f, w.fact))) {
				return facts
			}
			return box.keyed && Arr.some(facts, (f) => f[0] === w.fact[0])
				? undefined
				: [...facts, w.fact]
		case "put":
			return box.keyed
				? [...Arr.filter(facts, (f) => f[0] !== w.fact[0]), w.fact]
				: Arr.some(facts, (f) => same(f, w.fact))
					? facts
					: [...facts, w.fact]
	}
}

const pAfter = (ids: ReadonlyArray<number>, w: Write): ReadonlyArray<number> => {
	const [id] = w.fact
	return w.op === "delete"
		? Arr.filter(ids, (x) => x !== id)
		: ids.includes(id)
			? ids
			: [...ids, id]
}

const holds = (p: ReadonlyArray<number>, c: ReadonlyArray<Fact>): boolean =>
	Arr.every(c, ([, ref]) => p.includes(ref))

/** One action's statements, each a change of the state, in the order the action sends them. */
type State = { readonly p: ReadonlyArray<number>; readonly c: ReadonlyArray<Fact> }
const statementsOf = (
	box: Box,
	relation: "C" | "P",
	w: Write
): ReadonlyArray<(s: State) => State> => {
	if (relation === "P") {
		return [(s) => ({ ...s, p: pAfter(s.p, w) })]
	}
	const insert = (s: State): State =>
		Arr.some(s.c, (f) => same(f, w.fact)) ? s : { ...s, c: [...s.c, w.fact] }
	switch (w.op) {
		case "delete":
			return [(s) => ({ ...s, c: Arr.filter(s.c, (f) => !same(f, w.fact)) })]
		case "insert":
			return [insert]
		case "put":
			return box.keyed
				? [
						(s) => ({ ...s, c: Arr.filter(s.c, (f) => f[0] !== w.fact[0] || same(f, w.fact)) }),
						insert
					]
				: [insert]
	}
}

const ops: ReadonlyArray<Op> = ["insert", "put", "delete"]
const pWrites: ReadonlyArray<Write | undefined> = [
	undefined,
	...Arr.flatMap(ops, (op) => Arr.map([1, 2], (id): Write => ({ op, fact: [id, id] })))
]
const cWrites: ReadonlyArray<Write | undefined> = [
	undefined,
	...Arr.flatMap(ops, (op) => Arr.map([1, 2], (ref): Write => ({ op, fact: [1, ref] })))
]
const pStates: ReadonlyArray<ReadonlyArray<number>> = [[], [1], [2], [1, 2]]
const cStates = (keyed: boolean): ReadonlyArray<ReadonlyArray<Fact>> =>
	keyed
		? [[], [[1, 1]], [[1, 2]]]
		: [
				[],
				[[1, 1]],
				[[1, 2]],
				[
					[1, 1],
					[1, 2]
				]
			]

/** Every case of the box: lawful before, a write of one or both relations, lawful after. */
const boxes: Arr.NonEmptyReadonlyArray<Box> = nonEmpty(
	Arr.flatMap([true, false], (sourceFirst) =>
		Arr.flatMap([true, false], (keyed) =>
			Arr.flatMap(pStates, (p) =>
				Arr.flatMap(cStates(keyed), (c) =>
					Arr.flatMap(pWrites, (onP) =>
						Arr.flatMap(cWrites, (onC): ReadonlyArray<Box> => {
							const box: Box = { sourceFirst, keyed, p, c, onP, onC }
							if ((onP === undefined && onC === undefined) || !holds(p, c)) {
								return []
							}
							const finalC = onC === undefined ? c : cAfter(box, c, onC)
							const finalP = onP === undefined ? p : pAfter(p, onP)
							return finalC !== undefined && holds(finalP, finalC) ? [box] : []
						})
					)
				)
			)
		)
	),
	"the lawful strata of the box"
)

type Situation =
	| "both put, the source named first"
	| "both put, the target named first"
	| "both deleted"
	| "both inserted"

const nameOf = (box: Box, relation: "C" | "P"): string =>
	(relation === "C") === box.sourceFirst ? "A" : "B"

const action = (box: Box, relation: "C" | "P", w: Write): ActionCore => {
	const source = { kind: "enumerated", slot: ParamId(`${relation} member`) } as const
	const name = nameOf(box, relation)
	switch (w.op) {
		case "insert":
			return { op: "insert", serial: completeClass, relation: name, source }
		case "put":
			return { op: "put", relation: name, source }
		case "delete":
			return { op: "delete", relation: name, source }
	}
}

describe("a stratum's schedule", () => {
	it.effect(
		"holds an immediate foreign key into a pure set at every statement of every lawful stratum of the box",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/schedule",
						generator: element(boxes),
						literal: Formatter.format,
						limit: boxes.length,
						coverage: requiredInSpace<Situation>([
							"both put, the source named first",
							"both put, the target named first",
							"both deleted",
							"both inserted"
						]),
						caseHang
					},
					(box, c) =>
						Effect.sync(() => {
							const written = Arr.flatMap(
								[
									["C", box.onC],
									["P", box.onP]
								] as const,
								([relation, w]) => (w === undefined ? [] : [{ relation, w }])
							)
							const scheduled = scheduleStratum(
								canonicalActionOrder(
									Arr.map(written, ({ relation, w }) => ({
										action: action(box, relation, w),
										pureSet: relation === "P" || !box.keyed,
										relation,
										w
									}))
								),
								[{ from: nameOf(box, "C"), to: nameOf(box, "P") }]
							)
							let state: State = { p: box.p, c: box.c }
							for (const { scheduled: s } of scheduled) {
								for (const statement of statementsOf(box, s.relation, s.w)) {
									state = statement(state)
									assert.ok(
										holds(state.p, state.c),
										`${s.relation}'s ${s.w.op} leaves a C fact referencing no P fact`
									)
								}
							}
							if (box.onC?.op === "put" && box.onP?.op === "put") {
								c.note(
									box.sourceFirst
										? "both put, the source named first"
										: "both put, the target named first"
								)
							}
							if (box.onC?.op === "delete" && box.onP?.op === "delete") {
								c.note("both deleted")
							}
							if (box.onC?.op === "insert" && box.onP?.op === "insert") {
								c.note("both inserted")
							}
						})
				)
			)
	)
})
