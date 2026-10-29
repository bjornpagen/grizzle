import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { recordsetMaxRows, valuesMaxRows } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import {
	distinctSelect,
	headingTargets,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { inputSetSource } from "#compiler/lower/conservative/input-set/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type {
	ColumnDefinition,
	EmittedSql,
	Expr,
	FromItem,
	RecordsetPlaceholder,
	Select,
	ValuePlaceholder
} from "#compiler/sql/ast.ts"
import { cast, core, lit, select, types } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import type { NameMap } from "#compiler/sql/naming.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"

/** The bounds a relation input's transport is chosen by. */
export interface TransportLimits {
	readonly valuesMaxRows: number
	readonly recordsetMaxRows: number
}

/**
 * Production's bounds (core/policy.ts).
 *
 * Relation parameters: one parameter, by the fixed size rule.
 *
 * A relation-valued parameter is a set: repeated rows are one fact and an empty input is the empty relation, which
 * matches nothing. The host codec owns the set property and the null ban: it validates
 * every field, refuses null members, deduplicates complete facts, refuses same-key conflicts and encodes canonically
 * (codec/recordset.ts). So the statement reads the input as a set without a DISTINCT, which the physical analysis
 * records as the `deduplicatedInput` key of an InputSet.
 *
 * Transport, chosen per execution from the normalized facts, n of them (the meaning of every transport is identical):
 *
 * - n <= valuesMaxRows, n > 0: a VALUES list of typed literals, which gives the planner exact row estimates.
 *   The template keeps the recordset form; `specializeValues` rewrites one execution's
 *   statement into the VALUES form, renumbering the placeholders after the ones it removes.
 * - otherwise, up to recordsetMaxRows: `jsonb_to_recordset($n::jsonb) AS r(c1 <base type>, ...)`, one parameter
 *   whatever the size, so the bind limit is unreachable. The empty input travels as the empty recordset
 *   `[]`: a VALUES list needs a row.
 * - above recordsetMaxRows: the input is refused before any SQL is sent with the host bound's reason ResourceBound,
 *   which the shell raises as InputTooLarge, a write's ExecutionFailure reason and a read's ReadFailure reason.
 */
export const transportLimits: TransportLimits = Object.freeze({ valuesMaxRows, recordsetMaxRows })

/**
 * The distinct fact count `count` of an input within the recordset rule, or the refusal above it. A count is the
 * length of the input's normalized facts (codec/recordset.ts).
 */
export const relationBound = (
	count: number,
	limits: TransportLimits
): Result.Result<number, "ResourceBound"> =>
	count > limits.recordsetMaxRows ? Result.err("ResourceBound") : Result.ok(count)

/**
 * How one execution sends a relation input of the normalized facts `rows`: as a VALUES list of them, nonempty, or as
 * the recordset.
 */
export type RelationTransport<A> =
	| { readonly kind: "values"; readonly rows: NonEmptyReadonlyArray<A> }
	| { readonly kind: "recordset" }

/** The transport of an input of the normalized facts `rows`, an input within the recordset rule (relationBound). */
export const relationTransport = <A>(
	rows: ReadonlyArray<A>,
	limits: TransportLimits
): RelationTransport<A> =>
	isNonEmpty(rows) && rows.length <= limits.valuesMaxRows
		? { kind: "values", rows }
		: { kind: "recordset" }

/**
 * InputSet as a recordset read without a DISTINCT:
 *
 *   SELECT r1.c1, r1.c2 FROM jsonb_to_recordset($1::jsonb) AS r1(c1 uuid, c2 bigint)
 *
 * The definition list names base PostgreSQL types (an enum keeps its enum, a text column names the fixed collation),
 * and the JSON keys are its generated column names, recorded in the statement's relation slot. A membership's row is
 * the one-row VALUES of the values its caller names, in those types (conservative/input-set inputSetSource). The node's
 * own boundary stays a DISTINCT only where a placement realized one, which a deduplicated input or a row never needs.
 */
export const inputSetLowerer =
	(facts: ShapeFacts): NodeLowerer<"InputSet"> =>
	(node, cx) => {
		const { item, map } = inputSetSource(node, cx)
		const targets = headingTargets(node.heading, map)
		if (facts.realization(node) === "distinct" && !facts.unique(node)) {
			return distinctSelect(targets, [item], [])
		}
		return select(core(targets, [item], undefined))
	}

/** A statement as the template holds it: its AST, its name map and its slots in number order. */
export interface SpecializableStatement<S> {
	readonly ast: Select
	readonly nameMap: NameMap
	readonly params: ReadonlyArray<S>
}

/** One cell of a VALUES row: a normalized text, and the recordset column of the slot it is written for. */
export interface ValuesCell {
	readonly column: { readonly definition: ColumnDefinition }
	readonly text: string
}

/**
 * A relation input that travels as VALUES in one execution: the recordset placeholder of its slot, and its rows, each
 * fact's cells over the slot's columns.
 */
export interface ValuesInput {
	readonly slot: RecordsetPlaceholder
	readonly rows: NonEmptyReadonlyArray<ReadonlyArray<ValuesCell>>
}

/**
 * One typed literal of a normalized text form: the text through the column type's input function, money through
 * numeric, whose text the codec writes, and the definition's collation kept. A recordset's text column
 * names pg_catalog.pg_c_utf8 in its definition list; a bare 'x'::text in a VALUES list has the database default
 * collation instead, and a recursive CTE seeded from it then fails with 42P21 against its step's stored columns,
 * so the VALUES form would not mean what the recordset form means.
 */
const valuesLiteral = ({ text, column }: ValuesCell): Expr => {
	const definition = column.definition
	const type = definition.type
	const value =
		type.kind === "builtin" && type.name === "money"
			? cast(lit.text(text, types.numeric), type)
			: lit.text(text, type)
	return definition.collation === undefined
		? value
		: { kind: "collate", expr: value, collation: definition.collation }
}

/**
 * The statement of one execution whose relation inputs `values` travel as VALUES: every recordset over one of their
 * placeholders becomes `(VALUES (...), ...) AS r(c1, ...)` with the same alias and column names, each cell a literal of
 * its column's definition, their slots are removed, and every other slot is renumbered below the ones removed. One walk
 * reaches every expression and FROM item of the statement (sql/transform.ts), so every placeholder is renumbered
 * against the template's numbers at once. The result leaves through sql/emit like every emitted statement.
 */
export const specializeValues = <S extends ValuePlaceholder | RecordsetPlaceholder>(
	statement: SpecializableStatement<S>,
	values: NonEmptyReadonlyArray<ValuesInput>
): {
	readonly ast: Select
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<S>
} => {
	const rowsOf = new Map(values.map((v) => [v.slot.number, v.rows] as const))
	const removed = values.map((v) => v.slot.number)
	const renumbered = <P extends ValuePlaceholder | RecordsetPlaceholder>(p: P): P => {
		const below = removed.filter((n) => n < p.number).length
		return below === 0 ? p : { ...p, number: p.number - below }
	}
	const ast = transformSelect(statement.ast, {
		...identityHooks,
		replaceFromItem: (item) => {
			if (item.kind !== "recordset") {
				return undefined
			}
			const rows = rowsOf.get(item.source.number)
			if (rows === undefined) {
				const source = renumbered(item.source)
				return source === item.source ? item : { ...item, source }
			}
			return {
				kind: "values",
				rows: mapNonEmpty(rows, (row) => row.map(valuesLiteral)),
				alias: item.alias,
				columns: item.columns.map((d) => d.name)
			} satisfies FromItem
		},
		expr: (e) => {
			if (e.kind !== "param") {
				return e
			}
			const slot = renumbered(e.slot)
			return slot === e.slot ? e : { ...e, slot }
		}
	})
	return {
		ast,
		sql: emitText(ast, statement.nameMap),
		params: statement.params.filter((p) => !removed.includes(p.number)).map(renumbered)
	}
}
