/**
 * The host's fills of a nested write: every column of every row a nesting writes that grizzle writes itself, by
 * the schema's fill order (ir/fill.ts), which the analysis built and checked when the schema compiled
 * (analysis/theory/fill.ts).
 *
 * A caller writes an owner with its families' members nested at its count fields, to any depth, a tree's nodes
 * included (write/changeset/value.ts encodeAddition). Each row's caller fields are the caller's; every other column the
 * host writes is grizzle's, and PostgreSQL proves each one again through the native that reads it:
 *
 * - a member's group, its owner's key, and a tree node's root field, its parent's;
 * - the drawn columns: an ordered family's index, a counted one's ‹i›, each family's count and ‹n›, and a tree's
 *   `children`, `start`, `end` and ‹ps›, its end its start plus its subtree's size, drawn in one iterative pre-order
 *   pass;
 * - the accumulated columns, each the copy the one axis pair that carries it gives it (ir/family.ts AxisPair): along the
 *   owner axis from its owner, along the predecessor axis from its predecessor, along the last axis from its owner's
 *   last member, and at the axis's base (a family's first slot, an empty family, a tree's root) its writing's `start`;
 * - each fold's accumulators (ir/family.ts FamilyFold), named or hidden: each plane's before is a predecessor-axis copy
 *   of its predecessor's after, the plane's identity at the first slot; its after `combine(before, x)` where the step
 *   side's selection holds and its before elsewhere; its end a last-axis copy of the last member's after, the identity
 *   for an empty family. Folds combine exactly, in the monoid's own arithmetic (bigint for count and sum's integers,
 *   Decimal and Money for sum, sets of handles for or and twos, the carrier's order for max, text for concat), and an
 *   after outside its carrier is refused before any statement is sent: PostgreSQL would refuse its row (22003), since
 *   `after = combine(before, x)` is proved in exact arithmetic.
 *
 * Generated fields a copy, a step or a selection reads are evaluated on the host (`HostEvaluator`), by the expressions
 * PostgreSQL generates them by, so the host's copies agree with PostgreSQL's columns.
 *
 * The fill is one iterative depth-first walk over the nesting, so any depth walks, in each row's stages: on entering it,
 * its entering columns; then the members of each sequence it owns, in its layout's order, and after each sequence's
 * members the columns that wait on it; on settling it, its settling columns. The fill order states each column's stage
 * and admits no column whose source a later stage fills, so every column a rule reads is filled when it is read.
 */
import { encodeFailure } from "#compiler/codec/fault.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { dateOfDayNumber, dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import { type ExprTable, tableReads, type TypedLiteral } from "#compiler/ir/expr.ts"
import { type FillAt, layoutKey } from "#compiler/ir/fill.ts"
import {
	type FamilyId,
	familyKey,
	generatedLaw,
	type GeneratedLaw,
	type NativeColumn
} from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { PatternSource, ScalarType } from "#compiler/ir/scalar.ts"
import {
	type EvalLeaves,
	type EvalStop,
	evaluateTable,
	literalValue,
	sqlNull
} from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import { isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	admitted,
	storedValue,
	type Carrier,
	type CarrierHost,
	type CarrierSpec,
	compareValues
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { KeyHost } from "#compiler/types/changeset/changeset.ts"

/**
 * A column's key in a row's values: a field by its name, a law column by its identifier, each under its arm, so no field
 * name meets a law column's.
 */
export type ColumnKey = `field:${string}` | `law:${string}`

/** The key of a native column (`ColumnKey`). */
export const columnKey = (column: NativeColumn): ColumnKey =>
	column.kind === "field" ? `field:${column.field.name}` : `law:${column.column}`

/** The key of a field, by its name. */
export const fieldKey = (field: string): ColumnKey => `field:${field}`

/**
 * A row of a nesting as its caller wrote it: its relation, its caller fields' values by field key (`ColumnKey`), each the
 * host value its carrier's codec admitted (scalar/values/identity.ts CarrierHost), and each family it owns, by its id,
 * with its members in slot order. A member holds no field its nesting supplies: its group, and a tree node's root field.
 */
export interface HostNode {
	readonly relation: StoredRelationName
	readonly values: ReadonlyMap<ColumnKey, unknown>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<HostNode>
	}>
}

/** A row of a nesting filled: every column the host writes, by key, and each family it owns, with its members filled. */
export interface FilledNode {
	readonly relation: StoredRelationName
	readonly values: ReadonlyMap<ColumnKey, unknown>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<FilledNode>
	}>
}

/** The fields of a relation an expression over one of its rows reads, each by its name with its type: a LawRelation's,
 * or a fill's relation (`FillRelation`). */
export interface EvaluatedRelation {
	readonly fields: ReadonlyArray<HeadingColumn>
}

/**
 * The host's evaluation of an expression's table over one row of `relation`, a generated field's generation expression
 * or a fold step's selection: `read` gives each field the row holds by its name, as its codec's host value, undefined
 * where the row holds none; the result is the codec's host value of the expression's type, NULL (sqlNull) where the
 * expression is, as a closed read at a key its relation holds no row at leaves it, or why the host has none. A
 * selection holds only where its value is true: NULL, unknown, holds of no row.
 */
export type HostEvaluator = (
	relation: EvaluatedRelation,
	table: ExprTable,
	read: (field: string) => unknown
) => Result.Result<unknown, EvalStop>

/**
 * Why a fill has no value for a column, the nesting's walk and a family's edit alike: an expression the host cannot
 * evaluate over its row, a fold's selection among them (its stop, as the evaluator gives it); a generated field the fill
 * reads that is NULL, a closed read at a key its relation holds no row at, by the field's law, which its column's NOT
 * NULL refuses; or a fold's after or a copy outside its column's carrier, which PostgreSQL would refuse.
 */
export type FillStop =
	| { readonly kind: "evaluation"; readonly stop: EvalStop }
	| { readonly kind: "null"; readonly law: GeneratedLaw }
	| { readonly kind: "range"; readonly family: FamilyId }

/**
 * Why a nesting cannot be filled (`FillStop`), at its row, by the path of count fields and member positions from the
 * nesting's root, and its column; and the row's key as the walk filled it, its first declared key whose every field the
 * walk holds, by field name (runtime/write/witness.ts statedKey), none where none is whole.
 */
export interface FillRefusal {
	readonly path: ReadonlyArray<string | number>
	readonly relation: StoredRelationName
	readonly column: string
	readonly stop: FillStop
	readonly key: Readonly<Record<string, KeyHost>> | undefined
}

/**
 * A generated field with no value at a row a fill reads, by its law: the write is `invariant-rejected` on that law, as
 * PostgreSQL's NOT NULL refuses the row (23502) where no fill reads the field.
 */
export interface GeneratedNull {
	readonly _tag: "GeneratedNull"
	readonly law: GeneratedLaw
}

/**
 * What a fill's stop refuses its write with: an encoding failure at `place` before any statement is sent, factShape for
 * a value the host cannot evaluate and integerRange for one outside its column's carrier; or, for a generated field
 * with no value, that field's law (`GeneratedNull`).
 */
export const fillRefusal = (
	stop: FillStop,
	place: EncodingPlace
): EncodingFailure | GeneratedNull => {
	switch (stop.kind) {
		case "evaluation":
			return encodeFailure("factShape", place)
		case "range":
			return encodeFailure("integerRange", place)
		case "null":
			return { _tag: "GeneratedNull", law: stop.law }
	}
}

/**
 * Whether a fold steps over a row of `relation`: each conjunct of its selection in order, up to the first that is not
 * true, NULL holding of no row. `read` gives each field a conjunct reads, or why the row has none, which stops the
 * selection there; `unevaluated` is the stop of a conjunct the host cannot evaluate.
 */
export const selects = <E>(
	relation: EvaluatedRelation,
	where: ReadonlyArray<ExprTable>,
	evaluate: HostEvaluator,
	read: (field: string) => Result.Result<unknown, E>,
	unevaluated: (stop: EvalStop) => E
): Result.Result<boolean, E> => {
	for (const w of where) {
		const values = new Map<string, unknown>()
		for (const field of tableReads(w)) {
			const value = read(field)
			if (!value.ok) {
				return value
			}
			values.set(field, value.value)
		}
		const holds = evaluate(relation, w, (field) => values.get(field))
		if (!holds.ok) {
			return Result.err(unevaluated(holds.error))
		}
		if (holds.value !== true) {
			return Result.ok(false)
		}
	}
	return Result.ok(true)
}

/** A nesting's fills, built once for the families of a schema and the installation's codes: a row and what it owns,
 * filled where it stands (`position`), the walk's start, a tree's root or the insert's own row, or a family's member
 * whose own columns there its values already hold, whose counted families' counts and ends a fresh fill draws. */
export type Filler = (root: HostNode, position: FillAt) => Result.Result<FilledNode, FillRefusal>

/** A relation as the host fills its rows (`HostFill`): its name, its fields with their types, which an expression over a
 * row reads, and its declared keys by their fields' names, the primary key first, which a refusal states a row by. */
export interface FillRelation extends EvaluatedRelation {
	readonly name: StoredRelationName
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
}

/** A family as the host walks it (`HostFill`): its id, its count field, which a refusal's path names, its member
 * relation, and whether its members are a tree of that relation, its owner. */
export interface FillFamily {
	readonly id: FamilyId
	readonly count: string
	readonly member: StoredRelationName
	readonly tree: boolean
}

/** A fold as the host steps it (ir/family.ts FamilyFold): its monoid, and its step side's selection, each conjunct the
 * table of an expression over the member's row. */
export interface FillFold {
	readonly monoid: MonoidName
	readonly where: ReadonlyArray<ExprTable>
}

/**
 * How the host fills one column of a row at its position, as data (ir/fill.ts FillRule): its targets by column key, its
 * families by id, its bases as their literals, a fold as `FillFold`, and a generated field's expression as its table.
 * A tree root's parent (`self`) is its own column, as `own` is.
 */
export type FillRuleData =
	| { readonly kind: "given" | "index" | "copy" | "start" | "end" | "parentStart" }
	| { readonly kind: "owner" | "own" | "ownerCopy"; readonly to: ColumnKey }
	| { readonly kind: "count"; readonly family: FamilyId }
	| { readonly kind: "predecessor"; readonly to: ColumnKey; readonly base: TypedLiteral }
	| {
			readonly kind: "last"
			readonly family: FamilyId
			readonly to: ColumnKey
			readonly base: TypedLiteral
	  }
	| {
			readonly kind: "after"
			readonly family: FamilyId
			readonly fold: FillFold
			readonly plane: 0 | 1
			readonly befores: ReadonlyArray<ColumnKey>
			readonly x: ColumnKey | undefined
	  }
	| { readonly kind: "generated"; readonly expr: ExprTable }

/** A column of a relation at one position, as data (ir/fill.ts FillColumn): its key, its name as a refusal names it, its
 * type, its rule, and the stage that fills it, a sequence's members' by the family's id. */
export interface FillColumnData {
	readonly key: ColumnKey
	readonly name: string
	readonly type: ScalarType
	readonly rule: FillRuleData
	readonly stage:
		| { readonly kind: "entering" | "settling" }
		| { readonly kind: "after"; readonly family: FamilyId }
}

/** A relation's layout at one position, as data (ir/fill.ts FillLayout): its relation by name, its columns, and the
 * families its rows own, by id, in the order the walk fills them. */
export interface FillLayoutData {
	readonly relation: StoredRelationName
	readonly columns: ReadonlyArray<FillColumnData>
	readonly owns: ReadonlyArray<FamilyId>
}

/**
 * What the host fills a write's rows by, as data: each layout one of its walks or fresh fills meets, by its key
 * (ir/fill.ts layoutKey), the relations those layouts are of and the families their rows own. A write's
 * compile slices it from the schema's fill order (write/program/decide.ts), so it holds no layout the write never
 * meets.
 */
export interface HostFill {
	readonly relations: ReadonlyArray<FillRelation>
	readonly families: ReadonlyArray<FillFamily>
	readonly layouts: ReadonlyMap<string, FillLayoutData>
}

/**
 * How the host fills one column of a row at its position (`FillRuleData`), its targets by column key and its bases
 * as host values:
 * - given: the caller's, the row's own value;
 * - owner: its owner's column `to`; own: its own column `to`, a tree root's parent and copies of itself;
 * - index, copy, count, start, end, parentStart: a drawn natural, from where the row stands;
 * - ownerCopy, predecessor, last: a column carried along an axis, the target row's column `to`, and `base` at the
 *   predecessor and last axes' base;
 * - after: a fold plane's after;
 * - generated: a generated field, PostgreSQL's, evaluated where another column reads it and never written.
 */
type Rule =
	| { readonly kind: "given" }
	| { readonly kind: "owner"; readonly to: ColumnKey }
	| { readonly kind: "own"; readonly to: ColumnKey }
	| { readonly kind: "index" }
	| { readonly kind: "copy" }
	| { readonly kind: "count"; readonly family: string }
	| { readonly kind: "start" }
	| { readonly kind: "end" }
	| { readonly kind: "parentStart" }
	| { readonly kind: "ownerCopy"; readonly to: ColumnKey }
	| { readonly kind: "predecessor"; readonly to: ColumnKey; readonly base: unknown }
	| {
			readonly kind: "last"
			readonly family: string
			readonly to: ColumnKey
			readonly base: unknown
	  }
	| {
			readonly kind: "after"
			readonly family: FamilyId
			readonly fold: FillFold
			readonly plane: 0 | 1
			readonly befores: ReadonlyArray<ColumnKey>
			readonly x: ColumnKey | undefined
	  }
	| { readonly kind: "generated"; readonly expr: ExprTable }

/** A column the host fills of a relation: its key, its name as a refusal names it, its carrier's spec, and its rule. */
interface Column {
	readonly key: ColumnKey
	readonly name: string
	readonly spec: CarrierSpec
	readonly rule: Rule
	/** Whether the host writes it: every column but a generated one. */
	readonly written: boolean
}

/**
 * A relation's columns at one position, by key and by the stage that fills each, the columns waiting on a sequence by
 * that sequence's key, and the families its rows own.
 */
interface Layout {
	readonly relation: FillRelation
	readonly columns: ReadonlyMap<ColumnKey, Column>
	readonly entering: ReadonlyArray<Column>
	readonly after: ReadonlyMap<string, ReadonlyArray<Column>>
	readonly settling: ReadonlyArray<Column>
	/** The families its rows own, by key, its sequences first: the order the walk fills their members in. */
	readonly owns: ReadonlyArray<string>
}

/** A fill rule as the host fills it, under the installation's codes. */
const hostRule = (rule: FillRuleData, spec: CarrierSpec): Rule => {
	switch (rule.kind) {
		case "given":
		case "index":
		case "copy":
		case "start":
		case "end":
		case "parentStart":
			return { kind: rule.kind }
		case "owner":
		case "own":
		case "ownerCopy":
			return { kind: rule.kind, to: rule.to }
		case "count":
			return { kind: "count", family: familyKey(rule.family) }
		case "predecessor":
			return { kind: "predecessor", to: rule.to, base: literalHost(spec, rule.base) }
		case "last":
			return {
				kind: "last",
				family: familyKey(rule.family),
				to: rule.to,
				base: literalHost(spec, rule.base)
			}
		case "after":
		case "generated":
			return rule
	}
}

/** A layout as the host fills it (`FillLayoutData`), of `relation`, under the installation's codes. */
const hostLayout = (layout: FillLayoutData, relation: FillRelation, codes: Codebook): Layout => {
	const columns = new Map<ColumnKey, Column>()
	const entering: Array<Column> = []
	const after = new Map<string, Array<Column>>()
	const settling: Array<Column> = []
	for (const c of layout.columns) {
		const spec = carrierSpecOf(c.type, codes)
		const column: Column = {
			key: c.key,
			name: c.name,
			spec,
			rule: hostRule(c.rule, spec),
			written: c.rule.kind !== "generated"
		}
		columns.set(column.key, column)
		switch (c.stage.kind) {
			case "entering":
				entering.push(column)
				break
			case "after": {
				const key = familyKey(c.stage.family)
				after.set(key, [...(after.get(key) ?? []), column])
				break
			}
			case "settling":
				settling.push(column)
				break
		}
	}
	return { relation, columns, entering, after, settling, owns: layout.owns.map(familyKey) }
}

/**
 * A carrier value as the evaluator holds it, from a codec's host value: integers as bigint, spans of bigints, a date
 * span's endpoints as their day numbers, a bytes value as its admitted value, whose digest Compute.sha256 reads.
 */
export const evalValue = (spec: CarrierSpec, value: unknown): CarrierValue | undefined => {
	switch (spec.carrier) {
		case "int2":
		case "int4":
			return typeof value === "number" ? BigInt(value) : undefined
		case "range4":
			return isSpan(value) && typeof value.start === "number" && typeof value.end === "number"
				? { start: BigInt(value.start), end: BigInt(value.end) }
				: undefined
		case "rangeDate": {
			if (!isSpan(value)) {
				return undefined
			}
			const start = toCalendarDate(value.start)
			const end = toCalendarDate(value.end)
			return start.ok && end.ok
				? { start: BigInt(dayNumber(start.value)), end: BigInt(dayNumber(end.value)) }
				: undefined
		}
		case "vector":
			return undefined
		case "bytes":
			return isAdmittedBytes(value) ? value : undefined
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "bits":
		case "range8":
		case "exactInteger":
		case "exactMoney":
			return isCarrierValue(value) ? value : undefined
	}
}

const isSpan = (value: unknown): value is { readonly start: unknown; readonly end: unknown } =>
	typeof value === "object" && value !== null && "start" in value && "end" in value

const isCarrierValue = (value: unknown): value is CarrierValue =>
	typeof value === "bigint" ||
	typeof value === "number" ||
	typeof value === "boolean" ||
	typeof value === "string" ||
	value instanceof Decimal ||
	value instanceof Money ||
	value instanceof Set ||
	isSpan(value)

/**
 * A codec's host value of a carrier from the evaluator's: smallint's and integer's numbers, a range4's endpoints, a
 * date span's endpoints as the dates their day numbers are.
 */
const hostValue = (spec: CarrierSpec, value: CarrierValue): unknown => {
	switch (spec.carrier) {
		case "int2":
		case "int4":
			return typeof value === "bigint" ? Number(value) : value
		case "range4":
			return isSpan(value) && typeof value.start === "bigint" && typeof value.end === "bigint"
				? { start: Number(value.start), end: Number(value.end) }
				: value
		case "rangeDate":
			return isSpan(value) && typeof value.start === "bigint" && typeof value.end === "bigint"
				? { start: dateOfDayNumber(value.start), end: dateOfDayNumber(value.end) }
				: value
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return value
	}
}

/** A typed literal as a column's host value: a base, an identity or a start. */
export const literalHost = (spec: CarrierSpec, literal: TypedLiteral): unknown =>
	hostValue(spec, literalValue(literal))

/**
 * The host evaluator over the closed relations `closed` answers and the compiled program's admitted patterns
 * (scalar/regex/patterns.ts ProgramPatterns): a row's field read through its relation's carrier, and the result back as
 * the expression type's host value.
 */
export const hostEvaluator =
	(codes: Codebook, closed: EvalLeaves["closed"], patterns: PatternReads): HostEvaluator =>
	(relation, table, read) => {
		const specOf = new Map(
			relation.fields.map((f) => [f.name, carrierSpecOf(f.type, codes)] as const)
		)
		const leaves: EvalLeaves = {
			value: undefined,
			column: (ref) => {
				const spec = specOf.get(ref.name)
				const value = read(ref.name)
				return spec === undefined || value === undefined
					? undefined
					: value === sqlNull
						? sqlNull
						: evalValue(spec, value)
			},
			closed
		}
		const type = defined(table.exprs[table.root], "an expression table's root").type
		return Result.map(evaluateTable(table.exprs, table.root, leaves, patterns), (v) =>
			v === sqlNull ? sqlNull : hostValue(carrierSpecOf(type, codes), v)
		)
	}

/**
 * What the host's evaluator reads beside a row, for the expressions a write evaluates: the name of each closed
 * relation they read, whose rows its installation's closed table holds (`ClosedTable`), and every admitted pattern they
 * are checked against (scalar/regex/patterns.ts tablePatterns, typePatterns).
 */
export interface Evaluation {
	readonly closed: ReadonlyArray<string>
	readonly patterns: ReadonlyArray<PatternSource>
}

/**
 * The closed relations an installation's evaluators read, by name: where a write compiles, its schema's
 * (write/program/decide.ts closedTableOf); where a served login loads, its file's, each once (served/forms.ts
 * ServedFile closed).
 */
export type ClosedTable = ReadonlyMap<string, ClosedRows>

/** The closed relations `names` of `table`: what one evaluator reads, each by its name. */
export const closedNamed = (names: ReadonlyArray<string>, table: ClosedTable): ClosedTable =>
	new Map(
		names.map(
			(name) =>
				[name, defined(table.get(name), `the closed relation ${name} an evaluator reads`)] as const
		)
	)

/** A closed relation as the host reads it: its heading's names, its key's width, and its rows in heading order. */
export interface ClosedRows {
	readonly heading: ReadonlyArray<{ readonly name: string }>
	readonly key: number
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

/**
 * The closed reads the host evaluates a generation expression's C.at, C.row and C.has by, over the closed relations
 * `closed` holds, by name: C.at's cell is the field's value at the row whose key is its arguments, NULL where no row is;
 * C.row's set is a fresh Set of the last key field's value of every row whose key begins with its arguments; C.has is
 * whether a row's key is its arguments, false where none is. Each relation is indexed by key on its first read, which
 * C.at and C.has share, each key the tuple of its values: a closed relation's key is closed ids, whose values are their
 * handles, texts a Map compares by content, so a key is its values themselves, never one text joined from them.
 */
export const closedLeaf = (closed: ReadonlyMap<string, ClosedRows>): EvalLeaves["closed"] => {
	const cells = new Map<
		string,
		ReadonlyTupleMap<ReadonlyArray<CarrierValue>, ReadonlyArray<TypedLiteral>>
	>()
	const prefixes = new Map<
		string,
		ReadonlyTupleMap<ReadonlyArray<CarrierValue>, ReadonlySet<string>>
	>()
	const keyed = (
		relation: string,
		c: ClosedRows
	): ReadonlyTupleMap<ReadonlyArray<CarrierValue>, ReadonlyArray<TypedLiteral>> => {
		const held = cells.get(relation)
		if (held !== undefined) {
			return held
		}
		const built = new TupleMap<ReadonlyArray<CarrierValue>, ReadonlyArray<TypedLiteral>>()
		for (const row of c.rows) {
			built.set(row.slice(0, c.key).map(literalValue), row)
		}
		cells.set(relation, built)
		return built
	}
	const completed = (
		relation: string,
		c: ClosedRows
	): ReadonlyTupleMap<ReadonlyArray<CarrierValue>, ReadonlySet<string>> => {
		const held = prefixes.get(relation)
		if (held !== undefined) {
			return held
		}
		const built = new TupleMap<ReadonlyArray<CarrierValue>, Set<string>>()
		for (const row of c.rows) {
			const last = row[c.key - 1]
			const value = last === undefined ? undefined : literalValue(last)
			if (typeof value !== "string") {
				continue
			}
			const prefix = row.slice(0, c.key - 1).map(literalValue)
			const set = built.get(prefix) ?? new Set<string>()
			set.add(value)
			built.set(prefix, set)
		}
		prefixes.set(relation, built)
		return built
	}
	return (read, args) => {
		const c = closed.get(read.relation)
		if (c === undefined) {
			return undefined
		}
		switch (read.kind) {
			case "closedAt": {
				const row = keyed(read.relation, c).get(args)
				if (row === undefined) {
					return sqlNull
				}
				const cell = row[c.heading.findIndex((h) => h.name === read.field)]
				return cell === undefined ? undefined : literalValue(cell)
			}
			case "closedHas":
				return keyed(read.relation, c).has(args)
			case "closedRow":
				return new Set(completed(read.relation, c).get(args) ?? [])
		}
	}
}

/**
 * A fold plane's after at a row its selection holds of: `combine(before, x)` (`combineHost`), admitted to the plane's
 * carrier as PostgreSQL would store it; stopped where it leaves the carrier, as PostgreSQL would refuse its row (22003).
 */
export const stepped = (
	fold: { readonly monoid: MonoidName },
	family: FamilyId,
	plane: 0 | 1,
	befores: ReadonlyArray<unknown>,
	x: unknown,
	spec: CarrierSpec
): Result.Result<unknown, FillStop> => {
	const after = combineHost(fold, plane, befores, x, spec)
	if (after === undefined) {
		return Result.err({ kind: "range", family })
	}
	const stored = storedValue(spec, after)
	return stored.ok ? Result.ok(stored.value) : Result.err({ kind: "range", family })
}

/** One step of a monoid's combine on host values, at the after's carrier, a set's a fresh Set; undefined when the result
 * leaves it. */
const combineHost = (
	fold: { readonly monoid: MonoidName },
	plane: 0 | 1,
	befores: ReadonlyArray<unknown>,
	x: unknown,
	spec: CarrierSpec
): unknown => {
	const before = befores[plane]
	switch (fold.monoid) {
		case "count":
			return typeof before === "bigint" ? before + 1n : undefined
		case "sum":
			return sumHost(before, x)
		case "max":
			return maxHost(spec, before, x)
		case "or":
			return isSetOf(before) && isSetOf(x) ? new Set([...before, ...x]) : undefined
		case "twos": {
			const [ones, twos] = befores
			if (!isSetOf(ones) || !isSetOf(twos) || !isSetOf(x)) {
				return undefined
			}
			return plane === 0
				? new Set([...ones, ...x])
				: new Set([...twos, ...[...ones].filter((h) => x.has(h))])
		}
		case "concat":
			return concatHost(before, x)
	}
}

/**
 * Text's concatenation, of two storable texts a storable text; undefined past V8's longest string, which no host text
 * holds, so the write is refused before any statement, as PostgreSQL would refuse its row past 1 GB.
 */
const concatHost = (a: unknown, b: unknown): unknown =>
	typeof a === "string" && typeof b === "string" && a.length + b.length <= maxStringLength.value
		? a + b
		: undefined

const isSetOf = (v: unknown): v is ReadonlySet<string> => v instanceof Set

/** An exact sum: integers in bigint, numeric by numeric.c's addition, money in minor units. */
const sumHost = (a: unknown, b: unknown): unknown => {
	if (typeof a === "number" && typeof b === "number") {
		const s = BigInt(a) + BigInt(b)
		return s >= BigInt(Number.MIN_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(s)
			: undefined
	}
	if (typeof a === "bigint" && typeof b === "bigint") {
		return a + b
	}
	if (a instanceof Decimal && b instanceof Decimal) {
		const s = N.add(a, b)
		return s.ok ? s.value : undefined
	}
	if (a instanceof Money && b instanceof Money) {
		const s = Money.make(a.minorUnits + b.minorUnits)
		return s.ok ? s.value : undefined
	}
	return undefined
}

/** The greater of two values of one carrier, by PostgreSQL's order for it (a closed id's by code). */
const maxHost = (spec: CarrierSpec, a: unknown, b: unknown): unknown => {
	const left = storedValue(spec, a)
	const right = storedValue(spec, b)
	if (!left.ok || !right.ok) {
		return undefined
	}
	return compareValues(spec, left.value, right.value) >= 0 ? left.value : right.value
}

/** A row being filled: its layout, its values so far, where it stands, and what its rules read beyond it. */
interface Row {
	readonly layout: Layout
	readonly values: Map<ColumnKey, unknown>
	/** Where it stands in its owner's family, the count field and the member position its path ends with; none for the
	 * nesting's root. A row holds this one step, never the whole path, which `pathOf` walks only for a refusal, so a
	 * chain of any depth fills in linear time and space. */
	readonly step: { readonly count: string; readonly at: number } | undefined
	/** Its owner: a member's owner row, a tree node's parent; none for a row the ChangeSet writes itself. */
	readonly owner: Row | undefined
	/** The member before it in its family, none at its first slot. */
	readonly predecessor: Row | undefined
	/** Its slot in its family, 0 for a tree's root and a row the ChangeSet writes itself. */
	readonly at: number
	/** The family its position names: a member's, a tree root's own; none for a row the ChangeSet writes itself. */
	readonly family: string | undefined
	/** Each family it owns, by key, with the count of its members. */
	readonly counts: ReadonlyMap<string, number>
	/** Each family it owns, by key, with its last member once filled; none for an empty family. */
	readonly last: Map<string, Row>
	/** A tree node's interval, its end its start plus its subtree's size, and its parent's start. */
	readonly tree:
		| { readonly start: number; readonly end: number; readonly parentStart: number }
		| undefined
}

/** The value of a column of a row, filling it and every column it reads first; a refusal when it has none. */
const valueOf = (
	row: Row,
	key: ColumnKey,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	if (row.values.has(key)) {
		return Result.ok(row.values.get(key))
	}
	const column = row.layout.columns.get(key)
	if (column === undefined) {
		throw defect(`a column ${key} of ${row.layout.relation.name} the fill order laid out`)
	}
	const value = ruleValue(row, column, evaluate)
	if (!value.ok) {
		return value
	}
	row.values.set(key, value.value)
	return value
}

/** A row's path from the nesting's root: each owner's count field and member position, root first. */
const pathOf = (row: Row): ReadonlyArray<string | number> => {
	const steps: Array<string | number> = []
	for (let at: Row | undefined = row; at?.step !== undefined; at = at.owner) {
		steps.push(at.step.at, at.step.count)
	}
	return steps.toReversed()
}

/** A refusal at a row's column. */
const refusalAt = (row: Row, column: Column, stop: FillStop): FillRefusal => ({
	path: pathOf(row),
	relation: row.layout.relation.name,
	column: column.name,
	stop,
	key: keyOf(row)
})

/** Whether an admitted value is a set's. */
const isSet = (value: CarrierHost[Carrier]): value is ReadonlySet<string> => value instanceof Set

/** A key field's admitted value as a key value, none for a set's or bytes', which no key holds. */
const keyHostOf = (value: CarrierHost[Carrier]): KeyHost | undefined =>
	isSet(value) || isAdmittedBytes(value) ? undefined : value

/**
 * A row's key as the walk holds it: its relation's first declared key, the primary key first, whose every field the
 * row holds, by field name; none where none is whole.
 */
const keyOf = (row: Row): Readonly<Record<string, KeyHost>> | undefined => {
	for (const key of row.layout.relation.keys) {
		const values: Record<string, KeyHost> = {}
		let whole = true
		for (const name of key) {
			const column = row.layout.columns.get(fieldKey(name))
			const raw = row.values.get(fieldKey(name))
			const value =
				column === undefined || raw === undefined
					? undefined
					: keyHostOf(admitted(column.spec, raw))
			if (value === undefined) {
				whole = false
				break
			}
			values[name] = value
		}
		if (whole) {
			return Object.freeze(values)
		}
	}
	return undefined
}

/** A column of a row the walk filled before the row it fills now reads it, which the fill order guarantees. */
const filledBefore = (from: Row, key: ColumnKey, reader: Row): unknown => {
	if (!from.values.has(key)) {
		throw defect(`${key} of a row the walk filled before ${reader.layout.relation.name}'s`)
	}
	return from.values.get(key)
}

const treeOf = (row: Row): NonNullable<Row["tree"]> => {
	if (row.tree === undefined) {
		throw defect(`a tree node of ${row.layout.relation.name}`)
	}
	return row.tree
}

const familyOf = (row: Row): string => {
	if (row.family === undefined) {
		throw defect(`a row of ${row.layout.relation.name} in a family`)
	}
	return row.family
}

const ruleValue = (
	row: Row,
	column: Column,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	const rule = column.rule
	switch (rule.kind) {
		case "given":
			if (!row.values.has(column.key)) {
				throw defect(`the caller's ${column.name} of ${row.layout.relation.name}, admitted`)
			}
			return Result.ok(row.values.get(column.key))
		case "owner":
			if (row.owner === undefined) {
				throw defect(`an owner of ${row.layout.relation.name}'s member`)
			}
			return Result.ok(filledBefore(row.owner, rule.to, row))
		case "own":
			return valueOf(row, rule.to, evaluate)
		case "index":
			return Result.ok(BigInt(row.at))
		case "copy": {
			const counts = row.owner === undefined ? row.counts : row.owner.counts
			return Result.ok(BigInt(counts.get(familyOf(row)) ?? 0))
		}
		case "count":
			return Result.ok(BigInt(row.counts.get(rule.family) ?? 0))
		case "start":
			return Result.ok(BigInt(treeOf(row).start))
		case "end":
			return Result.ok(BigInt(treeOf(row).end))
		case "parentStart":
			return Result.ok(BigInt(treeOf(row).parentStart))
		case "ownerCopy":
			if (row.owner === undefined) {
				throw defect(`an owner of ${row.layout.relation.name}'s member`)
			}
			return Result.ok(filledBefore(row.owner, rule.to, row))
		case "predecessor":
			return Result.ok(
				row.predecessor === undefined ? rule.base : filledBefore(row.predecessor, rule.to, row)
			)
		case "last": {
			const last = row.last.get(rule.family)
			return Result.ok(last === undefined ? rule.base : filledBefore(last, rule.to, row))
		}
		case "after": {
			const befores: Array<unknown> = []
			for (const b of rule.befores) {
				const v = valueOf(row, b, evaluate)
				if (!v.ok) {
					return v
				}
				befores.push(v.value)
			}
			const selected = selects(
				row.layout.relation,
				rule.fold.where,
				evaluate,
				(field) => fieldOf(row, field, evaluate),
				(stop) => refusalAt(row, column, { kind: "evaluation", stop })
			)
			if (!selected.ok) {
				return selected
			}
			if (!selected.value) {
				return Result.ok(befores[rule.plane])
			}
			const x = rule.x === undefined ? Result.ok(undefined) : valueOf(row, rule.x, evaluate)
			if (!x.ok) {
				return x
			}
			const after = stepped(rule.fold, rule.family, rule.plane, befores, x.value, column.spec)
			return after.ok ? after : Result.err(refusalAt(row, column, after.error))
		}
		case "generated": {
			const v = evaluate(row.layout.relation, rule.expr, readerOf(row, evaluate))
			return !v.ok
				? Result.err(refusalAt(row, column, { kind: "evaluation", stop: v.error }))
				: v.value === sqlNull
					? Result.err(
							refusalAt(row, column, {
								kind: "null",
								law: generatedLaw(row.layout.relation.name, column.name)
							})
						)
					: Result.ok(v.value)
		}
	}
}

/** A row's field, filled on demand: its value, none where the row has no such column, or why it has none. */
const fieldOf = (
	row: Row,
	field: string,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	const key = fieldKey(field)
	return row.layout.columns.has(key) ? valueOf(row, key, evaluate) : Result.ok(undefined)
}

/** A row's field reader for the evaluator: each field's value, filled on demand, undefined where it has none. */
const readerOf =
	(row: Row, evaluate: HostEvaluator) =>
	(field: string): unknown => {
		const v = fieldOf(row, field, evaluate)
		return v.ok ? v.value : undefined
	}

/** A family a node owns, resolved, with its members, and its place among the node's families as the caller nested them. */
interface Owned {
	readonly family: FillFamily
	readonly members: ReadonlyArray<HostNode>
	readonly place: number
}

/** A row met by the walk: its row, the families it owns in the order the walk fills them, and where it stands. */
interface Frame {
	readonly row: Row
	/** Its families, sequences first, each at its place among the node's families. */
	readonly families: ReadonlyArray<Owned>
	/** The family it is filling, and the next member of it. */
	family: number
	member: number
	/** The last member of that family filled so far. */
	previous: Row | undefined
	/** Each of its families' filled members, at its place among the node's families. */
	readonly filled: ReadonlyArray<{ readonly family: FamilyId; readonly members: Array<FilledNode> }>
	/** The counter of the tree it is a node of: the start of the next node the tree meets. */
	readonly tree: { next: number } | undefined
}

/** Every column of a stage of a row filled, in any order: each fills what it reads first. */
const fillStage = (
	row: Row,
	stage: ReadonlyArray<Column>,
	evaluate: HostEvaluator
): Result.Result<void, FillRefusal> => {
	for (const column of stage) {
		const v = valueOf(row, column.key, evaluate)
		if (!v.ok) {
			return Result.err(v.error)
		}
	}
	return Result.ok(undefined)
}

/**
 * The size of each tree node's subtree in a nesting, itself included, by node: one pass over the nesting, members before
 * their owners, so any depth sizes. Only the nodes of the tree `tree` is the family of are sized.
 */
const subtreeSizes = (root: HostNode, tree: FamilyId): ReadonlyMap<HostNode, number> => {
	const id = familyKey(tree)
	const order: Array<HostNode> = []
	const pending: Array<HostNode> = [root]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		order.push(node)
		for (const g of node.families) {
			if (familyKey(g.family) === id) {
				for (const m of g.members) {
					pending.push(m)
				}
			}
		}
	}
	const sizes = new Map<HostNode, number>()
	for (const node of order.toReversed()) {
		let size = 1
		for (const g of node.families) {
			if (familyKey(g.family) !== id) {
				continue
			}
			for (const m of g.members) {
				const sized = sizes.get(m)
				if (sized === undefined) {
					throw defect("a tree node sized after its children")
				}
				size += sized
			}
		}
		sizes.set(node, size)
	}
	return sizes
}

/**
 * The filler of nestings by a write's host fill (`HostFill`): each relation's columns at each position it stands at,
 * laid out under the installation's codes when the walk first meets them. The fill order the write's fill is sliced
 * from admits no column whose source is filled after it, so every fill finds what it reads.
 */
export const filler = (fill: HostFill, codes: Codebook, evaluate: HostEvaluator): Filler => {
	const byKey = new Map(fill.families.map((f) => [familyKey(f.id), f] as const))
	const relations = new Map(fill.relations.map((r) => [r.name, r] as const))
	const layouts = new Map<string, Layout>()
	/** A row's layout at a position, which the write's fill laid out. */
	const laidOut = (relation: StoredRelationName, position: FillAt): Layout => {
		const key = layoutKey(relation, position)
		const known = layouts.get(key)
		if (known !== undefined) {
			return known
		}
		const layout = fill.layouts.get(key)
		if (layout === undefined) {
			throw defect(`the layout of ${relation} at a position the write's fill lays out`)
		}
		const built = hostLayout(
			layout,
			defined(relations.get(layout.relation), `the fill's relation ${layout.relation}`),
			codes
		)
		layouts.set(key, built)
		return built
	}
	/** A node's families resolved, sequences first, each in the order its relation owns them. */
	const resolved = (node: HostNode, layout: Layout): ReadonlyArray<Owned> => {
		const owned = node.families.map((g, place): Owned => {
			const family = byKey.get(familyKey(g.family))
			if (family === undefined) {
				throw defect(`the family ${g.family.owner}.${g.family.count} of the write's fill`)
			}
			return { family, members: g.members, place }
		})
		const rank = (o: Owned): number => layout.owns.indexOf(familyKey(o.family.id))
		return owned.toSorted((a, b) => rank(a) - rank(b))
	}
	const rowOf = (
		node: HostNode,
		position: FillAt,
		at: {
			readonly step: Row["step"]
			readonly owner: Row | undefined
			readonly predecessor: Row | undefined
			readonly at: number
			readonly tree: Row["tree"]
		}
	): Row => ({
		layout: laidOut(node.relation, position),
		values: new Map(node.values),
		step: at.step,
		owner: at.owner,
		predecessor: at.predecessor,
		at: at.at,
		family: position.kind === "top" ? undefined : familyKey(position.family.id),
		counts: new Map(node.families.map((g) => [familyKey(g.family), g.members.length] as const)),
		last: new Map(),
		tree: at.tree
	})
	const frameOf = (row: Row, node: HostNode, tree: Frame["tree"]): Frame => ({
		row,
		families: resolved(node, row.layout),
		family: 0,
		member: 0,
		previous: undefined,
		filled: node.families.map((g) => ({ family: g.family, members: [] })),
		tree
	})
	return (root: HostNode, position: FillAt): Result.Result<FilledNode, FillRefusal> => {
		const tree = position.kind === "root" ? position.family.id : undefined
		const sizes = tree === undefined ? new Map<HostNode, number>() : subtreeSizes(root, tree)
		const intervalOf = (node: HostNode, start: number, parentStart: number): Row["tree"] => {
			const size = sizes.get(node)
			if (size === undefined) {
				throw defect(`the subtree size of a node of ${node.relation}`)
			}
			return { start, end: start + size, parentStart }
		}
		const first = rowOf(root, position, {
			step: undefined,
			owner: undefined,
			predecessor: undefined,
			at: 0,
			tree: tree === undefined ? undefined : intervalOf(root, 0, 0)
		})
		const entered = fillStage(first, first.layout.entering, evaluate)
		if (!entered.ok) {
			return Result.err(entered.error)
		}
		const stack: Array<Frame> = [frameOf(first, root, tree === undefined ? undefined : { next: 1 })]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const current = frame.families[frame.family]
			if (current !== undefined) {
				const node = current.members[frame.member]
				if (node === undefined) {
					const id = familyKey(current.family.id)
					if (frame.previous !== undefined) {
						frame.row.last.set(id, frame.previous)
					}
					const waited = fillStage(frame.row, frame.row.layout.after.get(id) ?? [], evaluate)
					if (!waited.ok) {
						return Result.err(waited.error)
					}
					frame.family += 1
					frame.member = 0
					frame.previous = undefined
					continue
				}
				const at = frame.member
				frame.member += 1
				const inTree =
					current.family.tree && current.family.member === frame.row.layout.relation.name
				const counter = inTree ? frame.tree : undefined
				const start = counter === undefined ? undefined : counter.next
				if (counter !== undefined) {
					counter.next += 1
				}
				const row = rowOf(
					node,
					{ kind: "member", family: current.family },
					{
						step: { count: current.family.count, at },
						owner: frame.row,
						predecessor: frame.previous,
						at,
						tree: start === undefined ? undefined : intervalOf(node, start, treeOf(frame.row).start)
					}
				)
				const filled = fillStage(row, row.layout.entering, evaluate)
				if (!filled.ok) {
					return Result.err(filled.error)
				}
				stack.push(frameOf(row, node, counter))
				continue
			}
			const settled = fillStage(frame.row, frame.row.layout.settling, evaluate)
			if (!settled.ok) {
				return Result.err(settled.error)
			}
			const done: FilledNode = Object.freeze({
				relation: frame.row.layout.relation.name,
				values: new Map(
					[...frame.row.layout.columns.values()].flatMap((c) =>
						c.written ? [[c.key, frame.row.values.get(c.key)] as const] : []
					)
				),
				families: Object.freeze(
					frame.filled.map((g) =>
						Object.freeze({ family: g.family, members: Object.freeze(g.members) })
					)
				)
			})
			stack.pop()
			const parent = stack.at(-1)
			if (parent === undefined) {
				return Result.ok(done)
			}
			parent.previous = frame.row
			const owned = parent.families[parent.family]
			if (owned === undefined) {
				throw defect("a member's owner fills the family it walks")
			}
			const into = parent.filled[owned.place]
			if (into === undefined) {
				throw defect("a member's owner holds the family it walks")
			}
			into.members.push(done)
		}
		throw defect("the walk ends at its root")
	}
}
