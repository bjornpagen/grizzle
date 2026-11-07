import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import type { ActionCore } from "#compiler/ir/write.ts"
import { completeClass } from "#compiler/ir/write.ts"
import { canonicalActionOrder, scheduleStratum } from "#compiler/write/frontend/schedule.ts"
import { assert } from "#test/support/assert.ts"
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

/** A write of one relation, or none: its op, and the id it writes (P's) or references (C's, whose own id is 1). */
const writeGen =
	(fact: (id: number) => Fact): Gen<Write | undefined> =>
	(source) =>
		source.draw(boolean)
			? {
					op: source.draw(element(["insert", "put", "delete"] as const)),
					fact: fact(source.draw(int(1, 2)))
				}
			: undefined

/**
 * Every stratum of the box: whether C is named first and whether it has a payload; P's ids and C's facts, each a
 * subset of ids 1 and 2 and of C's two facts at id 1; and a write of P, of C or both. A stratum is drawn only when its
 * state before is lawful, C's key and its reference, and its final state is too; any other is discarded.
 */
const boxGen: Gen<Box> = (source) => {
	const sourceFirst = source.draw(boolean)
	const keyed = source.draw(boolean)
	const p = source.draw(subarray(Arr.range(1, 2)))
	const c = source.draw(subarray(Arr.map(Arr.range(1, 2), (ref): Fact => [1, ref])))
	const onP = source.draw(writeGen((id) => [id, id]))
	const onC = source.draw(writeGen((ref) => [1, ref]))
	const box: Box = { sourceFirst, keyed, p, c, onP, onC }
	const finalC = onC === undefined ? c : cAfter(box, c, onC)
	const finalP = onP === undefined ? p : pAfter(p, onP)
	if (
		(onP === undefined && onC === undefined) ||
		(keyed && c.length > 1) ||
		!holds(p, c) ||
		finalC === undefined ||
		!holds(finalP, finalC)
	) {
		source.discard()
	}
	return box
}

/** The box's tapes: two names, two shapes, four P states, four C states and seven writes of each relation. */
const boxCases = 2 * 2 * 4 * 4 * 7 * 7

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
						generator: boxGen,
						literal: Formatter.format,
						limit: boxCases,
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
