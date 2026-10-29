import { array, type Gen, int } from "@grizzle/testing/gen"
import { type Swarm, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	resolveValue,
	literalRowKey,
	type Spelling,
	type ValueSketch,
	valueClasses
} from "#test/support/oracle/gen/domain.ts"

import {
	allKeys,
	containmentFrom,
	type DataFeature,
	type GenContainment,
	type GenRelation,
	type GenSchema,
	keyIndices,
	relationNamed,
	valueSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { cyclicAt, elementAt } from "#test/support/oracle/pick.ts"

export type LiteralRow = ReadonlyArray<TypedLiteral>

/**
 * Generated facts.
 *
 * The stored state of a case: for each relation a set of facts, each a row of typed literals in column order. The
 * facts satisfy every declared law the oracle install enforces natively: no two facts share a primary or candidate key
 * under native equality (so 1.0 and 1.00, or 0 and -0, are one key value), and every contained field tuple names an
 * existing fact of its target. Values come from the small domains of domain.ts, so equal payloads, fanout and key
 * collisions are common.
 *
 * Rows are sketched with more values than any relation has columns and resolved against the schema, so the sketch
 * does not depend on the schema and the whole case is one flat, shrinkable record. A row that would break a key is
 * dropped, as is a row whose containment has no target fact to point at.
 *
 * Facts by relation name, every relation of the schema present.
 */
export type GenFacts = Readonly<Record<string, ReadonlyArray<LiteralRow>>>

export interface RowSketch {
	readonly values: ReadonlyArray<ValueSketch>
	/** Which target fact a contained field tuple copies, modulo the target's facts. */
	readonly target: number
}

/** One row list per relation slot, in declaration order. */
export type FactsSketch = ReadonlyArray<ReadonlyArray<RowSketch>>

export interface FactLimits {
	readonly maxRows: number
}

export const defaultFactLimits: FactLimits = { maxRows: 6 }

const sketchWidth = 8

export const rowSketchGen: Gen<RowSketch> = (source) => ({
	values: source.draw(array(valueSketchGen, { min: sketchWidth, max: sketchWidth })),
	target: source.draw(int(0, 7))
})

/** One row list for each of `slots` relation slots, typically the schema limits' maxRelations. */
export const factsSketchGen = (limits: FactLimits, slots: number): Gen<FactsSketch> =>
	array(array(rowSketchGen, { min: 0, max: limits.maxRows }), { min: slots, max: slots })

/** A row of `relation` from its sketch, its values resolved as stored values. */
const resolveRow = (
	relation: GenRelation,
	sketch: RowSketch,
	spelling: Spelling
): Array<TypedLiteral> =>
	Arr.map(relation.columns, (c, i) =>
		resolveValue(c.type, cyclicAt(sketch.values, i, "a row sketch's values"), spelling, "stored")
	)

/**
 * The value class and spelling the first fact of an earlier relation drew at a field of `type`, which a later
 * relation's first fact twins under "twinned".
 */
interface Twin {
	readonly type: ScalarType
	readonly value: ValueSketch
}

/**
 * A relation's row sketches as the spelling mode draws them. Under "twinned" (domain.ts SpellingMode), a field whose type
 * has value classes of more than one spelling draws among those classes only, and twins an earlier value there: the
 * first row takes, at every such field, the class of the first value an earlier relation drew at a field of its type,
 * spelled one place further on (a class of its own where none did, which `twins` then records); each later row takes,
 * at every such field outside the relation's keys, the class of the row before it, spelled one place further on. The
 * keys of a later row keep their own values, so the twins stay distinct facts; so two spellings of one class meet at
 * a merge of two relations' fields or of one relation's facts.
 */
const spelledRows = (
	relation: GenRelation,
	rows: ReadonlyArray<RowSketch>,
	spelling: Spelling,
	twins: ReadonlyArray<Twin>
): { readonly rows: ReadonlyArray<RowSketch>; readonly twins: ReadonlyArray<Twin> } => {
	if (spelling.mode !== "twinned") {
		return { rows, twins }
	}
	const known: Array<Twin> = [...twins]
	const keyed = new Set(allKeys(relation).flat())
	/** Per column, the indices of its type's classes of more than one spelling. */
	const spelled = Arr.map(relation.columns, (c) =>
		Arr.flatMap(valueClasses(c.type, spelling.edge), (cls, index) =>
			cls.length > 1 ? [index] : []
		)
	)
	const out: Array<RowSketch> = []
	for (const rs of rows) {
		const previous = out[out.length - 1]
		out.push({
			values: Arr.map(rs.values, (v, i) => {
				const classes = spelled[i] ?? []
				const column = relation.columns[i]
				if (classes.length === 0 || column === undefined) {
					return v
				}
				if (previous === undefined) {
					const twin = Arr.findFirst(known, (t) => sameScalarType(t.type, column.type))
					if (Option.isSome(twin)) {
						return { cls: twin.value.value.cls, sp: twin.value.value.sp + 1 }
					}
					const own = { cls: cyclicAt(classes, v.cls, "a type's spelled classes"), sp: v.sp }
					known.push({ type: column.type, value: own })
					return own
				}
				if (keyed.has(column.name)) {
					return v
				}
				const before = elementAt(previous.values, i, "a row sketch's values")
				return { cls: before.cls, sp: before.sp + 1 }
			}),
			target: rs.target
		})
	}
	return { rows: out, twins: known }
}

/** Whether `row` collides with `kept` on any declared key of `relation` under native equality. */
const keyConflict = (
	relation: GenRelation,
	kept: ReadonlyArray<LiteralRow>,
	row: LiteralRow
): boolean =>
	Arr.some(allKeys(relation), (key) => {
		const cols = keyIndices(relation, key)
		const k = literalRowKey(row, cols)
		return Arr.some(kept, (other) => literalRowKey(other, cols) === k)
	})

/**
 * The facts a sketch resolves to under the schema's laws. Relations are filled in declaration order, so every
 * containment's target is filled before its source.
 */
export const resolveFacts = (
	schema: GenSchema,
	sketch: FactsSketch,
	spelling: Spelling,
	swarm: Swarm<DataFeature>
): GenFacts => {
	/**
	 * The data swarm's weight for facts caps how many each relation's sketch may contribute: one, two, four, or all.
	 */
	const cap = elementAt(
		[1, 2, 4, Number.POSITIVE_INFINITY],
		weightOf(swarm, "rows"),
		"the row caps"
	)
	const facts: Record<string, ReadonlyArray<LiteralRow>> = {}
	let twins: ReadonlyArray<Twin> = []
	for (const [ri, relation] of schema.relations.entries()) {
		const rows = (sketch.length === 0 ? [] : cyclicAt(sketch, ri, "the facts sketch")).slice(0, cap)
		const containment = containmentFrom(schema, relation.name)
		const kept: Array<LiteralRow> = []
		/**
		 * A row contained in its target: its source fields copied from the target fact `pick` names, or none while the
		 * target holds no fact.
		 */
		const containedIn = (
			to: GenContainment,
			row: LiteralRow,
			pick: number
		): Option.Option<LiteralRow> => {
			const target = relationNamed(schema, to.to.relation)
			const targetRows = facts[target.name]
			if (targetRows === undefined) {
				throw new Error(`${target.name} is filled after ${relation.name}, which it contains`)
			}
			if (targetRows.length === 0) {
				return Option.none()
			}
			const source = cyclicAt(targetRows, pick, `the facts of ${target.name}`)
			const toCols = keyIndices(target, to.to.fields)
			const out = [...row]
			for (const [i, c] of keyIndices(relation, to.from.fields).entries()) {
				out[c] = elementAt(
					source,
					elementAt(toCols, i, "a containment's columns"),
					"a contained row"
				)
			}
			return Option.some(out)
		}
		const spelled = spelledRows(relation, rows, spelling, twins)
		twins = spelled.twins
		for (const rs of spelled.rows) {
			const row = resolveRow(relation, rs, spelling)
			const placed = Option.match(containment, {
				onNone: () => Option.some(row),
				onSome: (to) => containedIn(to, row, rs.target)
			})
			if (Option.isSome(placed) && !keyConflict(relation, kept, placed.value)) {
				kept.push(placed.value)
			}
		}
		facts[relation.name] = kept
	}
	return facts
}
