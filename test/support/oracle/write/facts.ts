import { array, type Gen } from "@grizzle/testing/gen"
import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import type { Fact } from "#test/support/oracle/addwins.ts"
import { cyclicAt, elementAt, recordEntryOf } from "#test/support/oracle/pick.ts"
import { typeInfo, valueIdentity } from "#test/support/oracle/write/domain.ts"
import {
	columnOf,
	type WContainment,
	type WGroup,
	type WRelation
} from "#test/support/oracle/write/schema.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

export type { Fact }

/**
 * Generated stored facts of one group.
 *
 * The initial state of a write case: each relation's facts as host records, drawn from the small value pools of
 * domain.ts so that a ChangeSet meets present facts, occupied keys and equal payloads often. The facts satisfy every
 * law of the group: no two facts share a primary or candidate key under native equality, no two selected facts share a
 * capacity's fields, and every contained field tuple names a fact of its target, which the relations' declaration order
 * fills first. A row that would break a key, or whose containment has no target fact, is dropped, so any sketch
 * resolves to a lawful state.
 *
 * Facts by relation name, every relation of the group present.
 */
export type WFacts = Readonly<Record<string, ReadonlyArray<Fact>>>

/** One row: a pick into each column's value pool, and which target fact a contained tuple copies. */
export interface RowSketch {
	readonly values: ReadonlyArray<number>
	readonly target: number
}

export const rowSketchGen: Gen<RowSketch> = (source) => ({
	values: source.draw(array(pickGen, { min: 4, max: 4 })),
	target: source.draw(pickGen)
})

/** One row list per relation slot of a group. */
export type FactsSketch = ReadonlyArray<ReadonlyArray<RowSketch>>

export const factsSketchGen = (maxRows: number): Gen<FactsSketch> =>
	array(array(rowSketchGen, { min: 0, max: maxRows }), { min: 3, max: 3 })

/** The value a pick selects from column `i`'s pool, shifted `shift` places along it. */
export const poolValue = (relation: WRelation, i: number, pick: number, shift: number): unknown => {
	const pool = typeInfo[elementAt(relation.columns, i, `${relation.name}'s columns`).kind].values
	return elementAt(pool, (pickIndex(pick, pool.length) + shift) % pool.length, "a value pool")
}

/**
 * A complete fact of `relation` from a row sketch. A row sketch draws four values and column i reads value i modulo
 * their count, so every column has one; elementAt throws on the sketch that has none, which no generator draws.
 */
export const resolveRow = (relation: WRelation, row: RowSketch): Record<string, unknown> => {
	const fact: Record<string, unknown> = {}
	for (const [i, c] of relation.columns.entries()) {
		fact[c.name] = poolValue(
			relation,
			i,
			elementAt(row.values, i % row.values.length, "the row sketch's values"),
			0
		)
	}
	return fact
}

/**
 * The identity of a fact's values on `fields`, equal exactly under PostgreSQL's equality on each: each value's canonical
 * identity text (domain.ts valueIdentity), joined by NUL, which no PostgreSQL text holds.
 */
export const keyOf = (relation: WRelation, fields: ReadonlyArray<string>, fact: Fact): string =>
	Arr.join(
		Arr.map(fields, (f) => valueIdentity(columnOf(relation, f).kind, fact[f])),
		"\u0000"
	)

export const factKey = (relation: WRelation, fact: Fact): string =>
	keyOf(relation, relation.primaryKey, fact)

const allKeys = (relation: WRelation): ReadonlyArray<ReadonlyArray<string>> => [
	relation.primaryKey,
	...relation.keys
]

/** Whether `fact` shares a primary, candidate or capacity key with one of `kept`. */
const collides = (
	group: WGroup,
	relation: WRelation,
	kept: ReadonlyArray<Fact>,
	fact: Fact
): boolean => {
	const sharesKey = Arr.some(allKeys(relation), (k) => {
		const id = keyOf(relation, k, fact)
		return Arr.some(kept, (other) => keyOf(relation, k, other) === id)
	})
	if (sharesKey) {
		return true
	}
	return Arr.some(group.capacities, (c) => {
		if (c.source.relation !== relation.name || fact[c.source.selector] !== true) {
			return false
		}
		const id = keyOf(relation, c.source.fields, fact)
		return Arr.some(
			kept,
			(other) => other[c.source.selector] === true && keyOf(relation, c.source.fields, other) === id
		)
	})
}

export const resolveFacts = (group: WGroup, sketch: FactsSketch): WFacts => {
	const facts: Record<string, ReadonlyArray<Fact>> = {}
	for (const [ri, relation] of group.relations.entries()) {
		/**
		 * A facts sketch draws one row list per relation slot (factsSketchGen), relation ri reading slot ri modulo their
		 * count; cyclicAt throws on a sketch of no slot, which no generator draws.
		 */
		const rows = cyclicAt(sketch, ri, "the facts sketch's relation slots")
		const containment = Arr.findFirst(group.containments, (c) => c.from.relation === relation.name)
		/**
		 * A fact contained in its target: its source fields copied from the target fact `pick` names, or none while the
		 * target holds no fact.
		 */
		const containedIn = (to: WContainment, fact: Fact, pick: number): Option.Option<Fact> => {
			const targets = recordEntryOf(facts, to.to.relation, "the facts drawn so far")
			if (targets.length === 0) {
				return Option.none()
			}
			const source = elementAt(
				targets,
				pickIndex(pick, targets.length),
				`the facts of ${to.to.relation}`
			)
			return Option.some({
				...fact,
				...Rec.fromEntries(
					Arr.map(
						to.from.fields,
						(f, i) =>
							[f, source[elementAt(to.to.fields, i, "a containment's target fields")]] as const
					)
				)
			})
		}
		const kept: Array<Fact> = []
		for (const row of rows) {
			const fact = resolveRow(relation, row)
			const placed = Option.match(containment, {
				onNone: () => Option.some(fact),
				onSome: (to) => containedIn(to, fact, row.target)
			})
			if (Option.isSome(placed) && !collides(group, relation, kept, placed.value)) {
				kept.push(placed.value)
			}
		}
		facts[relation.name] = kept
	}
	return facts
}

/** How a copy of the facts relabels a column's values (../perturb.ts): integers by their value, uuids by their text. */
type Relabeling = "int" | "uuid"

const relabelingOf = (kind: WRelation["columns"][number]["kind"]): Relabeling | undefined =>
	kind === "int4" || kind === "int8" || kind === "bigserial" || kind === "serial"
		? "int"
		: kind === "uuid"
			? "uuid"
			: undefined

/**
 * How a copy of `relation` relabels each column: the key columns no containment or capacity of the relation reads, or
 * none when some key of it has no such column. A capacity's fields keep their values, so a copy's selected facts would
 * share them with the original's: a relation with a capacity is not copied.
 */
const relabeledColumns = (
	group: WGroup,
	relation: WRelation
): ReadonlyArray<Relabeling | undefined> | undefined => {
	if (Arr.some(group.capacities, (c) => c.source.relation === relation.name)) {
		return undefined
	}
	const fromRelation = Arr.filter(group.containments, (c) => c.from.relation === relation.name)
	const contained = new Set(Arr.flatMap(fromRelation, (c) => c.from.fields))
	const keys = allKeys(relation)
	const keyed = new Set(keys.flat())
	const columns = Arr.map(relation.columns, (c) =>
		keyed.has(c.name) && !contained.has(c.name) ? relabelingOf(c.kind) : undefined
	)
	const relabeled = (name: string) =>
		Option.exists(
			Arr.findFirstIndex(relation.columns, (c) => c.name === name),
			(i) => columns[i] !== undefined
		)
	return Arr.every(keys, (key) => Arr.some(key, relabeled)) ? columns : undefined
}

const relabelText = (how: Relabeling, value: unknown): string | undefined =>
	how === "int"
		? typeof value === "number" || typeof value === "bigint"
			? String(value)
			: undefined
		: typeof value === "string"
			? value
			: undefined

/**
 * The initial facts of a case repeated `multiplier` times, every copy past the first under fresh keys: the write
 * oracle's fact multiplier (../perturb.ts, whose header gives the relabeling). A copy is a bystander to the case's
 * ChangeSet, which was drawn over the facts as generated, except where a described member's predicate or a delta
 * reaches it, which the add-wins expectation over the multiplied facts accounts for.
 */
export const multiplyWriteFacts = (group: WGroup, facts: WFacts, multiplier: number): WFacts => {
	if (multiplier <= 1) {
		return facts
	}
	const plans = Arr.map(group.relations, (relation) => ({
		relation,
		columns: relabeledColumns(group, relation)
	}))
	const seen: Record<Relabeling, Array<string>> = { int: [], uuid: [] }
	for (const { relation, columns } of plans) {
		if (columns === undefined) {
			continue
		}
		for (const fact of recordEntryOf(facts, relation.name, "the group's facts")) {
			for (const [i, c] of relation.columns.entries()) {
				const how = columns[i]
				const text = how === undefined ? undefined : relabelText(how, fact[c.name])
				if (how !== undefined && text !== undefined) {
					seen[how].push(text)
				}
			}
		}
	}
	const ranks = new Map<string, number>()
	for (const how of ["int", "uuid"] as const) {
		for (const [rank, text] of Arr.sort([...new Set(seen[how])], Order.String).entries()) {
			ranks.set(`${how}:${text}`, rank)
		}
	}
	const out: Record<string, ReadonlyArray<Fact>> = { ...facts }
	for (const { relation, columns } of plans) {
		if (columns === undefined) {
			continue
		}
		const rows = recordEntryOf(facts, relation.name, "the group's facts")
		const copies: Array<Fact> = [...rows]
		/** A fact's copy `copy`: each relabelled column at its rank in the copy's own range. */
		const copyOf = (fact: Fact, copy: number): Fact => {
			const next: Record<string, unknown> = { ...fact }
			for (const [i, c] of relation.columns.entries()) {
				const how = columns[i]
				const text = how === undefined ? undefined : relabelText(how, fact[c.name])
				const rank = text === undefined ? undefined : ranks.get(`${how}:${text}`)
				if (how === undefined || rank === undefined) {
					continue
				}
				next[c.name] =
					how === "uuid"
						? `f0000000-0000-4000-8000-${pipe((4096 * copy + rank).toString(16), Str.padStart(12, "0"))}`
						: c.kind === "int4" || c.kind === "serial"
							? 1000 * copy + rank
							: BigInt(1000 * copy + rank)
			}
			return next
		}
		for (let copy = 1; copy < multiplier; copy++) {
			copies.push(...Arr.map(rows, (fact) => copyOf(fact, copy)))
		}
		out[relation.name] = copies
	}
	return out
}
