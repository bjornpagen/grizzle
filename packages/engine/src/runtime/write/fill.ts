/**
 * The host's fills of a nested write: every column of every row a nesting writes that grizzle writes itself, by
 * the schema's fill order (ir/fill.ts), which the analysis built and checked when the schema compiled
 * (analysis/theory/fill.ts).
 *
 * A caller writes an owner with its families' members nested at its count fields, to any depth, a tree's nodes
 * included (runtime/write/addition.ts additionSplitter). Each row's caller fields are the caller's; every other column the
 * host writes is grizzle's, and PostgreSQL proves each one again through the native that reads it:
 *
 * - a member's group, its owner's key: a tree node's root fields, its parent's, and its parent, its parent's start;
 * - the drawn columns: an ordered family's index, a counted one's ‹i›, each family's count and ‹s›, and a tree's
 *   `children`, `start` and `end`, its end its start plus its subtree's size, drawn in one iterative pre-order pass;
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
 * PostgreSQL generates them by, so the host's copies agree with PostgreSQL's columns; and every key generation (ir/law.ts
 * FieldWriting keyGenerated), a column grizzle writes and a CHECK proves, by the same one computation (`generation`), so
 * a row's key is filled before the nesting keys it or a member copies it.
 *
 * The fill is one iterative depth-first walk over the nesting, so any depth walks, in each row's stages: on entering it,
 * its entering columns; then the members of each sequence it owns, in its layout's order, and after each sequence's
 * members the columns that wait on it; on settling it, its settling columns. The fill order states each column's stage
 * and admits no column whose source a later stage fills, so every column a rule reads is filled when it is read.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { encodeFailure } from "#compiler/codec/fault.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import { type ExprTable, tableReads, type TypedLiteral } from "#compiler/ir/expr.ts"
import { type FillAt, type FillStep, layoutKey } from "#compiler/ir/fill.ts"
import {
	type FamilyId,
	familyKey,
	generatedLaw,
	type GeneratedLaw,
	type ColumnKey,
	columnKeyOf
} from "#compiler/ir/law.ts"
import { type CombineBuild, type CombineStep, combine, monoidSpecs } from "#compiler/ir/monoid.ts"
import type { ClosedIndex, ClosedRows, HeadingColumn, IndexedClosed } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Cells, ColumnIndex, Columns, Texts } from "#compiler/runtime/write/cells.ts"
import {
	type EvalLeaves,
	type EvalStop,
	compiledExpr,
	noParamLeaf,
	type SqlValue,
	sqlNull
} from "#compiler/scalar/compute/evaluate.ts"
import { hostOfLiteral, integerHostOf } from "#compiler/scalar/compute/literal.ts"
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
	compareValues,
	evaluatedValue,
	type HostValue,
	heldValue
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { KeyHost } from "#compiler/types/changeset/changeset.ts"

/**
 * A row of a nesting as its caller wrote it: its relation, its caller fields' values as cells of its relation's columns
 * (runtime/write/cells.ts Cells), each the host value its carrier's codec admitted (scalar/values/identity.ts
 * CarrierHost), the texts the write holds of them (cells.ts Texts), its admission's, and each family it owns, by its id,
 * with its members in slot order. A member holds no field its nesting supplies: its group, a tree node's root fields.
 */
export interface HostNode {
	readonly relation: StoredRelationName
	readonly values: Cells
	readonly texts: Texts
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<HostNode>
	}>
}

/**
 * A row of a nesting filled: its walk's own cells (`Cells`), its node's and every column the host writes, a generated
 * field it read among them, the texts the write holds of them (cells.ts Texts), its node's, which a reader of a value
 * the walk drew adds to (cells.ts textAt), and each family it owns, with its members filled.
 */
export interface FilledNode {
	readonly relation: StoredRelationName
	readonly values: Cells
	readonly texts: Texts
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<FilledNode>
	}>
}

/**
 * The fields of a relation an expression over one of its rows reads, each by its name with its type, which its host
 * value meets the evaluator by (values/identity.ts evaluatedValue), read once, where the relation the evaluator judges
 * is laid out (`evaluatedRelation`).
 */
export interface EvaluatedRelation {
	readonly types: ReadonlyMap<string, ScalarType>
}

/** A relation's fields `fields`, a LawRelation's or a fill's relation's (`FillRelation`), as the evaluator reads them
 * (`EvaluatedRelation`). */
export const evaluatedRelation = (fields: ReadonlyArray<HeadingColumn>): EvaluatedRelation => ({
	types: new Map(fields.map((f) => [f.name, f.type] as const))
})

/**
 * One conjunct of a fold's selection as the host steps it: the table of an expression over the member's row, and the
 * fields that table reads of the row (ir/expr.ts tableReads), found once where the selection is built, so a fold reads
 * them as a field at every row it steps over.
 */
interface Selection {
	readonly table: ExprTable
	readonly reads: ReadonlyArray<string>
}

/** The conjunct `table` of a fold's selection, its reads found (`Selection`). */
const selection = (table: ExprTable): Selection => ({ table, reads: tableReads(table) })

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
) => Result.Result<SqlValue, EvalStop>

/**
 * Why a fill has no value for a column, the nesting's walk and a family's edit alike: an expression the host cannot
 * evaluate over its row, a fold's selection among them (its stop, as the evaluator gives it); a generated field the fill
 * reads that is NULL, a closed read at a key its relation holds no row at, by the field's law, which its column's NOT
 * NULL refuses; or a value it draws, a fold's after or a copy outside its column's carrier, which PostgreSQL would refuse.
 */
export type FillStop =
	| { readonly kind: "evaluation"; readonly stop: EvalStop }
	| { readonly kind: "null"; readonly law: GeneratedLaw }
	| { readonly kind: "range" }

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
const selects = <E>(
	relation: EvaluatedRelation,
	where: ReadonlyArray<Selection>,
	evaluate: HostEvaluator,
	read: (field: string) => Result.Result<unknown, E>,
	unevaluated: (stop: EvalStop) => E
): Result.Result<boolean, E> => {
	for (const w of where) {
		const values = new Map<string, unknown>()
		for (const field of w.reads) {
			const value = read(field)
			if (!value.ok) {
				return value
			}
			values.set(field, value.value)
		}
		const holds = evaluate(relation, w.table, (field) => values.get(field))
		if (!holds.ok) {
			return Result.err(unevaluated(holds.error))
		}
		if (holds.value !== true) {
			return Result.ok(false)
		}
	}
	return Result.ok(true)
}

/**
 * The columns of each relation's rows a fill leaves to the statement that writes them, by relation: a nesting's, those
 * its family statement fills after the walk, its stamps' and its counted families' (write/family/nesting.ts
 * NestedLayout pending), which no column the walk fills reads; a fresh fill's, its stamps' and every generated field
 * over one (runtime/write/binding.ts FreshStratum `left`); none of a relation it fills whole.
 */
export type StatementFills = ReadonlyMap<
	StoredRelationName,
	{ readonly pending: ReadonlySet<ColumnKey> }
>

/** A fill that leaves no column of any relation to its statement: one over rows that hold every column it reads. */
export const fillsWhole: StatementFills = new Map()

/** A nesting's fills, built once for the families of a schema and the installation's codes: a row and what it owns,
 * filled where it stands (`position`), the walk's start, a tree's root or the insert's own row, or a family's member
 * whose own columns there its values already hold, whose counted families' counts and ends a fresh fill draws; every
 * column of each row but those `left` leaves to its statement, which it never holds. */
export type Filler = (
	root: HostNode,
	position: FillAt,
	left: StatementFills
) => Result.Result<FilledNode, FillRefusal>

/** A relation as the host fills its rows (`HostFill`): its name, its fields with their types, which an expression over a
 * row reads, and its declared keys by their fields' names, the primary key first, which a refusal states a row by. */
export interface FillRelation {
	readonly name: StoredRelationName
	readonly fields: ReadonlyArray<HeadingColumn>
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
 * A tree root's parent (`self`) is its own start.
 */
export type FillRuleData =
	| { readonly kind: "given" | "index" | "next" | "start" | "end" }
	| { readonly kind: "owner" | "self" | "ownerCopy"; readonly to: ColumnKey }
	| { readonly kind: "base"; readonly base: TypedLiteral }
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
			readonly step: FillStep<ColumnKey>
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
 * How the host fills one column of a row at its position (`FillRuleData`), its targets at their positions among their
 * rows' relations' columns (runtime/write/cells.ts Columns) and its bases as host values:
 * - given: the caller's, the row's own value;
 * - owner: its owner's column `to`; self: its own column `to`, a tree root's parent, its own start;
 * - base: a tree root's copy along its owner axis, the copy's start as a host value;
 * - index, next, count, start, end: a drawn natural, from where the row stands;
 * - ownerCopy, predecessor, last: a column carried along an axis, the target row's column `to`, and `base` at the
 *   predecessor and last axes' base;
 * - after: a fold plane's after;
 * - generated: a generated field, PostgreSQL's, evaluated where another column reads it and never written, its value as
 *   its field of type `type` holds it (values/identity.ts heldValue).
 */
type Rule =
	| { readonly kind: "given" }
	| { readonly kind: "owner"; readonly to: number }
	| { readonly kind: "self"; readonly to: number }
	| { readonly kind: "base"; readonly base: unknown }
	| { readonly kind: "index" }
	| { readonly kind: "next" }
	| { readonly kind: "count"; readonly family: FillFamily }
	| { readonly kind: "start" }
	| { readonly kind: "end" }
	| { readonly kind: "ownerCopy"; readonly to: number }
	| { readonly kind: "predecessor"; readonly to: number; readonly base: unknown }
	| {
			readonly kind: "last"
			readonly family: FillFamily
			readonly to: number
			readonly base: unknown
	  }
	| {
			readonly kind: "after"
			readonly family: FamilyId
			readonly fold: HostFold
			readonly plane: 0 | 1
			readonly befores: ReadonlyArray<number>
			readonly step: FillStep<number>
	  }
	| { readonly kind: "generated"; readonly expr: ExprTable; readonly type: ScalarType }

/** A fold as the host steps it (`FillFold`): its monoid, and each conjunct of its step side's selection with the fields
 * it reads (`Selection`). */
interface HostFold {
	readonly monoid: MonoidName
	readonly where: ReadonlyArray<Selection>
}

/** A column the host fills of a relation: its position among its relation's columns, its name as a refusal names it, its
 * carrier's spec, and its rule. */
interface Column {
	readonly at: number
	readonly name: string
	readonly spec: CarrierSpec
	readonly rule: Rule
}

/**
 * A relation's columns at one position, by key, by position and by the stage that fills each, the columns waiting on a
 * sequence by that sequence (`FillFamily`, the walk's own), and the families its rows own; and the relation as the
 * evaluator reads it (`EvaluatedRelation`), which a generated field or a fold's selection over its rows is evaluated
 * over.
 */
interface Layout {
	readonly relation: FillRelation
	readonly evaluated: EvaluatedRelation
	readonly columns: ReadonlyMap<ColumnKey, Column>
	readonly byPosition: ReadonlyMap<number, Column>
	readonly entering: ReadonlyArray<Column>
	readonly after: ReadonlyMap<FillFamily, ReadonlyArray<Column>>
	readonly settling: ReadonlyArray<Column>
	/** The families its rows own, its sequences first: the order the walk fills their members in. */
	readonly owns: ReadonlyArray<FillFamily>
}

/**
 * The relations whose rows a layout's rules read (`hostRule`), by their columns: its own relation's, its row's owner's
 * where it stands in a family, and each family's members'; and each family of the write's fill by its id, as the walk
 * holds it (`FillFamily`), which a rule and a layout name a family by.
 */
interface RuleTargets {
	readonly own: Columns
	readonly owner: Columns | undefined
	readonly family: (id: FamilyId) => FillFamily
	readonly members: (family: FillFamily) => Columns
}

/** A fill rule as the host fills it, under the installation's codes, each target at its position among its row's
 * relation's columns (`RuleTargets`). */
const hostRule = (
	rule: FillRuleData,
	type: ScalarType,
	spec: CarrierSpec,
	targets: RuleTargets
): Rule => {
	switch (rule.kind) {
		case "given":
		case "index":
		case "next":
		case "start":
		case "end":
			return { kind: rule.kind }
		case "owner":
		case "ownerCopy": {
			if (targets.owner === undefined) {
				defect(`an owner a member's ${rule.kind} rule reads, at a position in a family`)
			}
			return { kind: rule.kind, to: targets.owner.at(rule.to) }
		}
		case "self":
			return { kind: "self", to: targets.own.at(rule.to) }
		case "base":
			return { kind: "base", base: hostOfLiteral(spec.carrier, rule.base) }
		case "count":
			return { kind: "count", family: targets.family(rule.family) }
		case "predecessor":
			return {
				kind: "predecessor",
				to: targets.own.at(rule.to),
				base: hostOfLiteral(spec.carrier, rule.base)
			}
		case "last": {
			const family = targets.family(rule.family)
			return {
				kind: "last",
				family,
				to: targets.members(family).at(rule.to),
				base: hostOfLiteral(spec.carrier, rule.base)
			}
		}
		case "after":
			return {
				kind: "after",
				family: rule.family,
				fold: { monoid: rule.fold.monoid, where: rule.fold.where.map(selection) },
				plane: rule.plane,
				befores: rule.befores.map(targets.own.at),
				step:
					rule.step.kind === "one" ? rule.step : { kind: "value", x: targets.own.at(rule.step.x) }
			}
		case "generated":
			return { kind: "generated", expr: rule.expr, type }
	}
}

/** A fill's relation with its fields as the evaluator reads them, read once for the fill (`filler`). */
interface FilledRelation {
	readonly relation: FillRelation
	readonly evaluated: EvaluatedRelation
}

/** A layout as the host fills it (`FillLayoutData`), of `filled`'s relation, under the installation's codes, each column
 * and each target of its rule at its position (`RuleTargets`), but the columns `pending` its statement fills, which the
 * host never lays out. */
const hostLayout = (
	layout: FillLayoutData,
	filled: FilledRelation,
	codes: Codebook,
	targets: RuleTargets,
	pending: ReadonlySet<ColumnKey>
): Layout => {
	const columns = new Map<ColumnKey, Column>()
	const byPosition = new Map<number, Column>()
	const entering: Array<Column> = []
	const after = new Map<FillFamily, Array<Column>>()
	const settling: Array<Column> = []
	for (const c of layout.columns.filter((column) => !pending.has(column.key))) {
		const spec = carrierSpecOf(c.type, codes)
		const column: Column = {
			at: targets.own.at(c.key),
			name: c.name,
			spec,
			rule: hostRule(c.rule, c.type, spec, targets)
		}
		columns.set(c.key, column)
		byPosition.set(column.at, column)
		switch (c.stage.kind) {
			case "entering":
				entering.push(column)
				break
			case "after": {
				const family = targets.family(c.stage.family)
				after.getOrInsertComputed(family, () => []).push(column)
				break
			}
			case "settling":
				settling.push(column)
				break
		}
	}
	return {
		relation: filled.relation,
		evaluated: filled.evaluated,
		columns,
		byPosition,
		entering,
		after,
		settling,
		owns: layout.owns.map(targets.family)
	}
}

/**
 * The host evaluator over the closed relations `closed` answers and the compiled program's admitted patterns
 * (scalar/regex/patterns.ts ProgramPatterns): a row's field read as the relation it judges holds it, its codec's host
 * value as the evaluator computes with it (values/identity.ts evaluatedValue), and the result the evaluator's value of the
 * expression's type, which a generated field's fill holds as its field does (`ruleValue`).
 */
export const hostEvaluator =
	(closed: EvalLeaves["closed"], patterns: PatternReads): HostEvaluator =>
	(relation, table, read) => {
		const leaves: EvalLeaves = {
			value: undefined,
			column: (ref) => {
				const type = relation.types.get(ref.name)
				const value = read(ref.name)
				return type === undefined || value === undefined
					? undefined
					: value === sqlNull
						? sqlNull
						: evaluatedValue(type, value)
			},
			closed,
			param: noParamLeaf
		}
		return compiledExpr(table)(leaves, patterns)
	}

/**
 * The evaluator of a term over one call, over the closed relations `closed` answers and the program's admitted patterns:
 * its declared parameters, each by its id, as `param` reads them, and no row, as a computed field's term reads the call
 * alone (runtime/write/binding.ts ComputedFields).
 */
export type CallEvaluator = (
	table: ExprTable,
	param: EvalLeaves["param"]
) => Result.Result<SqlValue, EvalStop>

/** The evaluator of terms over one call (CallEvaluator), its leaves the call's parameters and the closed relations. */
export const callEvaluator =
	(closed: EvalLeaves["closed"], patterns: PatternReads): CallEvaluator =>
	(table, param) =>
		compiledExpr(table)({ value: undefined, column: () => undefined, closed, param }, patterns)

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
 * (`closedTableOf`); where a served login loads, its file's, each once (served/forms.ts
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

/** A closed relation's key cell as its host value: a closed id's handle, which every key field is. */
const keyHost = (cell: TypedLiteral): HostValue => hostOfLiteral("code", cell)

/**
 * A closed relation indexed for the host's reads of it (ir/rel.ts IndexedClosed): each row by its key, the tuple of its
 * key fields' values, and each key's prefix short of its last field by the last field's values that complete it, each
 * value a closed id's handle, which every key field is.
 */
const indexedClosed = (c: ClosedRows): IndexedClosed => {
	const rows = new TupleMap<ReadonlyArray<HostValue>, ReadonlyArray<TypedLiteral>>()
	const completions = new TupleMap<ReadonlyArray<HostValue>, Set<string>>()
	for (const row of c.rows) {
		const key = row.slice(0, c.key).map(keyHost)
		rows.set(key, row)
		const last = key[c.key - 1]
		if (typeof last !== "string") {
			continue
		}
		const prefix = key.slice(0, c.key - 1)
		const set = completions.getOrInsertComputed(prefix, () => new Set<string>())
		set.add(last)
	}
	return Object.freeze({ heading: c.heading, rows, completions })
}

/**
 * Each closed relation's index (`indexedClosed`), by the rows it indexes: a function of them alone, made once for
 * every evaluator that reads them (a schema's relation's rows are one value, check/schema.ts ClosedRelation `host`; a
 * served file's, one for the file), and dropped with them.
 */
const indexes = new WeakMap<ClosedRows, IndexedClosed>()

/** The closed relations of `table` indexed for the host's reads of them, by name, each indexed once (`indexes`). */
export const closedIndexOf = (table: ClosedTable): ClosedIndex =>
	new Map(
		Array.from(table, ([name, c]) => [name, indexes.getOrInsertComputed(c, indexedClosed)] as const)
	)

/**
 * The closed reads the host evaluates a generation expression's C.at, C.row and C.has by, over the closed relations
 * `closed` indexes, by name: C.at's cell is the field's value at the row whose key is its arguments, NULL where no row is;
 * C.row's set is a fresh Set of the last key field's value of every row whose key begins with its arguments; C.has is
 * whether a row's key is its arguments, false where none is. It reads the index alone, so it is made wherever an
 * evaluation is, the index where its closed relations are (`closedIndexOf`).
 */
export const closedLeaf =
	(closed: ClosedIndex): EvalLeaves["closed"] =>
	(read, args) => {
		const c = closed.get(read.relation)
		if (c === undefined) {
			return undefined
		}
		switch (read.kind) {
			case "closedAt": {
				const row = c.rows.get(args)
				if (row === undefined) {
					return sqlNull
				}
				const cell = row[c.heading.findIndex((h) => h.name === read.field)]
				return cell === undefined ? undefined : hostOfLiteral(baseOf(read.type).carrier, cell)
			}
			case "closedHas":
				return c.rows.has(args)
			case "closedRow":
				return new Set(c.completions.get(args) ?? [])
		}
	}

/**
 * A fold plane's after at a row its selection holds of: `combine(before, x)` (`combineHost`), admitted to the plane's
 * carrier as PostgreSQL would store it; stopped where it leaves the carrier, as PostgreSQL would refuse its row (22003).
 */
const stepped = (
	fold: { readonly monoid: MonoidName },
	plane: 0 | 1,
	befores: ReadonlyArray<unknown>,
	x: unknown,
	spec: CarrierSpec
): Result.Result<unknown, FillStop> => {
	const after = combineHost(fold, plane, befores, x, spec)
	if (after === undefined) {
		return Result.err(outsideCarrier)
	}
	const stored = storedValue(spec, after)
	return stored.ok ? Result.ok(stored.value) : Result.err(outsideCarrier)
}

/** A value a fill draws or combines outside its column's carrier, which PostgreSQL would refuse (22003). */
const outsideCarrier: FillStop = Object.freeze({ kind: "range" })

/**
 * A value grizzle draws, an index, a count or a copy of one, or a tree's start or end, at its column's carrier as
 * PostgreSQL would store it: a JavaScript integer for smallint and integer, a bigint for bigint, a drawn type's own
 * (scalar/natural.ts isDrawnType). One past the carrier is refused before any statement is sent, where PostgreSQL would
 * refuse its row (22003); one past a contract's bound within it is its CHECK's to refuse.
 */
const drawnValue = (
	row: Row,
	column: Column,
	value: number
): Result.Result<unknown, FillRefusal> => {
	const stored = storedValue(column.spec, integerHostOf(column.spec.carrier, BigInt(value)))
	return stored.ok ? Result.ok(stored.value) : Result.err(refusalAt(row, column, outsideCarrier))
}

/** One step of a fold's combine on host values (ir/monoid.ts combine), plane `plane`'s after, at the after's carrier, a
 * set's a fresh Set; undefined when the result leaves it. */
const combineHost = (
	fold: { readonly monoid: MonoidName },
	plane: 0 | 1,
	befores: ReadonlyArray<unknown>,
	x: unknown,
	spec: CarrierSpec
): unknown => {
	const monoid = monoidSpecs[fold.monoid]
	if (!isNonEmpty(befores)) {
		defect("a fold's after reads a before per plane")
	}
	const step: CombineStep<unknown> =
		monoid.step === "none" ? { kind: "one" } : { kind: "value", expr: x }
	return combine(monoid, befores, step, hostCombine(spec))[plane]
}

/**
 * How the host builds a combine: the bigint one a count adds, and each scalar operation over host values at the
 * after's carrier, undefined where an operand is not of it or the result leaves it.
 */
const hostCombine = (spec: CarrierSpec): CombineBuild<unknown> => ({
	one: 1n,
	apply: (fn, a, b) => {
		switch (fn) {
			case "add":
				return sumHost(a, b)
			case "union":
				return isSetOf(a) && isSetOf(b) ? new Set([...a, ...b]) : undefined
			case "intersection":
				return isSetOf(a) && isSetOf(b) ? new Set([...a].filter((h) => b.has(h))) : undefined
			case "greatest":
				return maxHost(spec, a, b)
			case "concat":
				return concatHost(a, b)
		}
	}
})

/**
 * Text's concatenation, of two storable texts a storable text; undefined past V8's longest string, which no host text
 * holds, so the write is refused before any statement, as PostgreSQL would refuse its row past 1 GB.
 */
const concatHost = (a: unknown, b: unknown): unknown =>
	typeof a === "string" && typeof b === "string" && a.length + b.length <= maxStringLength
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

/** A tree node's interval, its end its start plus its subtree's size. */
interface Interval {
	readonly start: number
	readonly end: number
}

/**
 * Where a row being filled stands (ir/fill.ts FillAt): a row the ChangeSet writes itself (`top`); a walk's first row at a
 * member's position, of its family by key, its owner outside the walk, as a fresh owner's counted fill enters a nested
 * owner (write/bind.ts freshOwners, `entered`); a tree's root, of its tree's family, at its tree's first interval
 * (`root`); or a member the walk reaches in its owner's family, by key, at its slot `at` under the family's count field
 * `count`, after the member before it (`predecessor`, none at its first slot), a tree node at its interval (`tree`, none
 * for a member of a family that is no tree of its relation). A member holds its one step from its owner, never its whole
 * path, which `pathOf` walks only for a refusal, so a chain of any depth fills in linear time and space.
 */
type Place =
	| { readonly kind: "top" }
	| { readonly kind: "entered"; readonly family: FillFamily }
	| { readonly kind: "root"; readonly family: FillFamily; readonly tree: Interval }
	| {
			readonly kind: "member"
			readonly family: FillFamily
			readonly owner: Row
			readonly count: string
			readonly at: number
			readonly predecessor: Row | undefined
			readonly tree: Interval | undefined
	  }

/** A row being filled: its layout, its cells so far (runtime/write/cells.ts Cells) and the texts its node held of them
 * (cells.ts Texts), where it stands, and what its rules read beyond it. */
interface Row {
	readonly layout: Layout
	readonly values: Array<unknown>
	readonly texts: Texts
	readonly place: Place
	/** Each family it owns, with the count of its members. */
	readonly counts: ReadonlyMap<FillFamily, number>
	/** Each family it owns, with its last member once filled; none for an empty family. */
	readonly last: Map<FillFamily, Row>
}

/** The value of a row's column at `at`, filling it and every column it reads first; a refusal when it has none. */
const valueOf = (
	row: Row,
	at: number,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	const held = row.values[at]
	if (held !== undefined) {
		return Result.ok(held)
	}
	const column = row.layout.byPosition.get(at)
	if (column === undefined) {
		defect(`a column at ${at} of ${row.layout.relation.name} the fill order laid out`)
	}
	const value = ruleValue(row, column, evaluate)
	if (!value.ok) {
		return value
	}
	row.values[at] = value.value
	return value
}

/** A row's path from the nesting's root: each owner's count field and member position, root first. */
const pathOf = (row: Row): ReadonlyArray<string | number> => {
	const steps: Array<string | number> = []
	for (let at = row.place; at.kind === "member"; at = at.owner.place) {
		steps.push(at.at, at.count)
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
export const keyHostOf = (value: CarrierHost[Carrier]): KeyHost | undefined =>
	isSet(value) || isAdmittedBytes(value) ? undefined : value

/**
 * A row's key: the first of a relation's declared keys `keys`, its primary key first, whose every field `read` gives a
 * key value of, by field name; none where none is whole. The walk's rows (`keyOf`) and the witness's stated rows
 * (runtime/write/witness.ts statedKey) are keyed by it.
 */
export const wholeKey = (
	keys: ReadonlyArray<ReadonlyArray<string>>,
	read: (field: string) => KeyHost | undefined
): Readonly<Record<string, KeyHost>> | undefined => {
	for (const key of keys) {
		const values: Record<string, KeyHost> = {}
		let whole = true
		for (const name of key) {
			const value = read(name)
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

/** A row's key as the walk holds it (`wholeKey`), each field's value admitted at its column's carrier. */
const keyOf = (row: Row): Readonly<Record<string, KeyHost>> | undefined =>
	wholeKey(row.layout.relation.keys, (name) => {
		const column = row.layout.columns.get(columnKeyOf(name))
		const raw = column === undefined ? undefined : row.values[column.at]
		return column === undefined || raw === undefined
			? undefined
			: keyHostOf(admitted(column.spec, raw))
	})

/**
 * A column of a row the walk filled before the row it fills now reads it, which the fill order guarantees: its value, a
 * generated field's evaluated where it is first read, over the columns of its row it reads, each filled before it
 * too. No write carries a generated field, so a row whose walk entered it with the columns an earlier walk wrote holds
 * none, as a fresh owner's counted fill holds its owner, whose sequences that walk filled (write/bind.ts freshOwners).
 */
const filledBefore = (
	from: Row,
	at: number,
	reader: Row,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	const held = from.values[at]
	if (held !== undefined) {
		return Result.ok(held)
	}
	if (from.layout.byPosition.get(at)?.rule.kind === "generated") {
		return valueOf(from, at, evaluate)
	}
	defect(`the column at ${at} of a row the walk filled before ${reader.layout.relation.name}'s`)
}

/** A tree node's interval: a tree root's, or a member's of a family that is a tree of its relation. */
const treeOf = (row: Row): Interval => {
	const place = row.place
	if (place.kind === "top" || place.kind === "entered" || place.tree === undefined) {
		defect(`a tree node of ${row.layout.relation.name}`)
	}
	return place.tree
}

/** A member's owner row. */
const ownerOf = (row: Row): Row => {
	if (row.place.kind !== "member") {
		defect(`an owner of ${row.layout.relation.name}'s member`)
	}
	return row.place.owner
}

const ruleValue = (
	row: Row,
	column: Column,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	const rule = column.rule
	switch (rule.kind) {
		case "given":
			defect(`the caller's ${column.name} of ${row.layout.relation.name}, admitted`)
		case "owner":
		case "ownerCopy":
			return filledBefore(ownerOf(row), rule.to, row, evaluate)
		case "self":
			return valueOf(row, rule.to, evaluate)
		case "base":
			return Result.ok(rule.base)
		case "index":
			return drawnValue(row, column, row.place.kind === "member" ? row.place.at : 0)
		case "next":
			switch (row.place.kind) {
				case "top":
					defect(`a row of ${row.layout.relation.name} in a family`)
				case "entered":
				case "root":
					return drawnValue(row, column, 0)
				case "member": {
					const at = row.place.at
					return drawnValue(
						row,
						column,
						at + 1 < (row.place.owner.counts.get(row.place.family) ?? 0) ? at + 1 : at
					)
				}
			}
		case "count":
			return drawnValue(row, column, row.counts.get(rule.family) ?? 0)
		case "start":
			return drawnValue(row, column, treeOf(row).start)
		case "end":
			return drawnValue(row, column, treeOf(row).end)
		case "predecessor":
			return row.place.kind !== "member" || row.place.predecessor === undefined
				? Result.ok(rule.base)
				: filledBefore(row.place.predecessor, rule.to, row, evaluate)
		case "last": {
			const last = row.last.get(rule.family)
			return last === undefined ? Result.ok(rule.base) : filledBefore(last, rule.to, row, evaluate)
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
				row.layout.evaluated,
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
			const x =
				rule.step.kind === "one" ? Result.ok(undefined) : valueOf(row, rule.step.x, evaluate)
			if (!x.ok) {
				return x
			}
			const after = stepped(rule.fold, rule.plane, befores, x.value, column.spec)
			return after.ok ? after : Result.err(refusalAt(row, column, after.error))
		}
		case "generated":
			return Result.mapError(
				generation(
					evaluate,
					row.layout.evaluated,
					{
						expr: rule.expr,
						type: rule.type,
						law: generatedLaw(row.layout.relation.name, column.name)
					},
					readerOf(row, evaluate)
				),
				(stop) => refusalAt(row, column, stop)
			)
	}
}

/**
 * A generated field as the host computes it: the expression PostgreSQL generates it by (`expr`), of the field's type
 * `type`, and the field's law, which its NOT NULL refuses a NULL by.
 */
export interface Generation {
	readonly expr: ExprTable
	readonly type: ScalarType
	readonly law: GeneratedLaw
}

/**
 * The one host computation of a generated field over a row of `relation`, each field `read` gives by its name: its
 * expression's value as its field holds it (values/identity.ts heldValue), or why the row has none, an expression the
 * host cannot evaluate over it, or NULL, which the field's NOT NULL refuses by its law. A nesting's walk fills a row's
 * generated columns by it (`ruleValue`), and normalization a stated fact's key generations, before any key of it is
 * compared (runtime/write/normalize.ts filledFacts), so every key the host compares is the key PostgreSQL stores.
 */
export const generation = (
	evaluate: HostEvaluator,
	relation: EvaluatedRelation,
	generated: Generation,
	read: (field: string) => unknown
): Result.Result<HostValue, Exclude<FillStop, { readonly kind: "range" }>> => {
	const v = evaluate(relation, generated.expr, read)
	return !v.ok
		? Result.err({ kind: "evaluation", stop: v.error })
		: v.value === sqlNull
			? Result.err({ kind: "null", law: generated.law })
			: Result.ok(heldValue(generated.type, v.value))
}

/** A row's field, filled on demand: its value, none where the row has no such column, or why it has none. */
const fieldOf = (
	row: Row,
	field: string,
	evaluate: HostEvaluator
): Result.Result<unknown, FillRefusal> => {
	const column = row.layout.columns.get(columnKeyOf(field))
	return column === undefined ? Result.ok(undefined) : valueOf(row, column.at, evaluate)
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
		const v = valueOf(row, column.at, evaluate)
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
const subtreeSizes = (
	root: HostNode,
	tree: FillFamily,
	family: (id: FamilyId) => FillFamily
): ReadonlyMap<HostNode, number> => {
	const order: Array<HostNode> = []
	const pending: Array<HostNode> = [root]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		order.push(node)
		for (const g of node.families) {
			if (family(g.family) === tree) {
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
			if (family(g.family) !== tree) {
				continue
			}
			for (const m of g.members) {
				const sized = sizes.get(m)
				if (sized === undefined) {
					defect("a tree node sized after its children")
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
 * laid out under the installation's codes when the walk first meets them, each column at its position among its
 * relation's columns in the write's index `columns` (runtime/write/cells.ts ColumnIndex), and each relation's fields as
 * the evaluator reads them, read once as the filler is built. The fill order the write's fill is sliced from admits no
 * column whose source is filled after it, so every fill finds what it reads.
 */
export const filler = (
	fill: HostFill,
	codes: Codebook,
	evaluate: HostEvaluator,
	columns: ColumnIndex
): Filler => {
	const byKey = new Map(fill.families.map((f) => [familyKey(f.id), f] as const))
	/** Each family id a node or a rule names, by the id itself, as the walk holds its family: found by its key where it is
	 * first met, so no row's walk spells a family's key. */
	const byId = new Map<FamilyId, FillFamily>()
	const familyOf = (id: FamilyId): FillFamily => {
		const known = byId.get(id)
		if (known !== undefined) {
			return known
		}
		const family = byKey.get(familyKey(id))
		if (family === undefined) {
			defect(`the family ${id.owner}.${id.count} of the write's fill`)
		}
		byId.set(id, family)
		return family
	}
	const relations = new Map(
		fill.relations.map(
			(relation) =>
				[relation.name, { relation, evaluated: evaluatedRelation(relation.fields) }] as const
		)
	)
	/** A walk's layouts under what it leaves to its statement (`StatementFills`): each relation's at each position it
	 * meets, laid out where it first meets it, and each family's members' by the family, so a member's row finds its
	 * layout by its family, never by a key spelled for it; built once for each `left` a walk is given. */
	interface Layouts {
		readonly at: (relation: StoredRelationName, position: FillAt) => Layout
		readonly member: (family: FillFamily) => Layout
	}
	const layoutsByLeft = new WeakMap<StatementFills, Layouts>()
	const layoutsOf = (left: StatementFills): Layouts => {
		const known = layoutsByLeft.get(left)
		if (known !== undefined) {
			return known
		}
		const byLayoutKey = new Map<string, Layout>()
		const at = (relation: StoredRelationName, position: FillAt): Layout => {
			const key = layoutKey(relation, position)
			const held = byLayoutKey.get(key)
			if (held !== undefined) {
				return held
			}
			const layout = fill.layouts.get(key)
			if (layout === undefined) {
				defect(`the layout of ${relation} at a position the write's fill lays out`)
			}
			const built = hostLayout(
				layout,
				defined(relations.get(layout.relation), `the fill's relation ${layout.relation}`),
				codes,
				{
					own: columns(layout.relation),
					owner: position.kind === "member" ? columns(position.family.id.owner) : undefined,
					family: familyOf,
					members: (family) => columns(family.member)
				},
				left.get(layout.relation)?.pending ?? new Set()
			)
			byLayoutKey.set(key, built)
			return built
		}
		const byFamily = new Map<FillFamily, Layout>()
		const member = (family: FillFamily): Layout => {
			const held = byFamily.get(family)
			if (held !== undefined) {
				return held
			}
			const layout = at(family.member, { kind: "member", family })
			byFamily.set(family, layout)
			return layout
		}
		const made: Layouts = { at, member }
		layoutsByLeft.set(left, made)
		return made
	}
	/** A node's families resolved, sequences first, each in the order its relation owns them. */
	const resolved = (node: HostNode, layout: Layout): ReadonlyArray<Owned> => {
		const owned = node.families.map((g, place): Owned => ({
			family: familyOf(g.family),
			members: g.members,
			place
		}))
		const rank = (o: Owned): number => layout.owns.indexOf(o.family)
		return owned.toSorted((a, b) => rank(a) - rank(b))
	}
	const rowOf = (node: HostNode, layout: Layout, place: Place): Row => ({
		layout,
		values: node.values.slice(),
		texts: node.texts.slice(),
		place,
		counts: new Map(node.families.map((g) => [familyOf(g.family), g.members.length] as const)),
		last: new Map()
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
	return (
		root: HostNode,
		position: FillAt,
		left: StatementFills
	): Result.Result<FilledNode, FillRefusal> => {
		const layouts = layoutsOf(left)
		const tree = position.kind === "root" ? familyOf(position.family.id) : undefined
		const sizes =
			tree === undefined ? new Map<HostNode, number>() : subtreeSizes(root, tree, familyOf)
		const intervalOf = (node: HostNode, start: number): Interval => {
			const size = sizes.get(node)
			if (size === undefined) {
				defect(`the subtree size of a node of ${node.relation}`)
			}
			return { start, end: start + size }
		}
		const entry = ((): Place => {
			switch (position.kind) {
				case "top":
					return { kind: "top" }
				case "member":
					return { kind: "entered", family: familyOf(position.family.id) }
				case "root":
					return { kind: "root", family: familyOf(position.family.id), tree: intervalOf(root, 0) }
			}
		})()
		const first = rowOf(root, layouts.at(root.relation, position), entry)
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
					if (frame.previous !== undefined) {
						frame.row.last.set(current.family, frame.previous)
					}
					const waited = fillStage(
						frame.row,
						frame.row.layout.after.get(current.family) ?? [],
						evaluate
					)
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
				const row = rowOf(node, layouts.member(current.family), {
					kind: "member",
					family: current.family,
					owner: frame.row,
					count: current.family.count,
					at,
					predecessor: frame.previous,
					tree: start === undefined ? undefined : intervalOf(node, start)
				})
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
				values: frame.row.values,
				texts: frame.row.texts,
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
				defect("a member's owner fills the family it walks")
			}
			const into = parent.filled[owned.place]
			if (into === undefined) {
				defect("a member's owner holds the family it walks")
			}
			into.members.push(done)
		}
		defect("the walk ends at its root")
	}
}
