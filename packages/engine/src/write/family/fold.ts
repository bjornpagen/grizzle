import { carrierSpecOf } from "#compiler/codec/scalar.ts"
/**
 * The host's fills of a nested write (W3.P2): every column of every row a nesting writes that grizzle writes itself.
 *
 * A caller writes an owner with its families' members nested at its count fields, to any depth, a tree's nodes
 * included (write/changeset/value.ts encodeAddition). Each row's caller fields are the caller's; every other column the
 * host writes is grizzle's, and PostgreSQL proves each one again through the native that reads it:
 *
 * - a member's group, its owner's key, and a tree node's root field, its parent's;
 * - the drawn columns: an ordered family's index, a counted one's ‹i›, each family's count and ‹n›, and a tree's
 *   `children`, `start`, `end` and ‹ps› (write/family/tree.ts walk draws the same);
 * - the accumulated columns, each the copy the one axis pair that carries it gives it (ir/family.ts AxisPair): along the
 *   owner axis from its owner, along the predecessor axis from its predecessor, along the last axis from its owner's
 *   last member, and at the axis's base (a family's first slot, an empty family, a tree's root) its writing's `start`;
 * - each fold's accumulators (ir/family.ts FamilyFold), named or hidden: each plane's before is a predecessor-axis copy
 *   of its predecessor's after, the plane's identity at the first slot; its after `combine(before, x)` where the step
 *   side's selection holds and its before elsewhere; its end a last-axis copy of the last member's after, the identity
 *   for an empty family. Folds combine exactly, in the monoid's own arithmetic (bigint for count and sum's integers,
 *   Decimal and Money for sum, sets of handles for or and twos, the carrier's order for max), and an after outside its
 *   carrier is refused before any statement is sent: PostgreSQL would refuse its row (22003), since
 *   `after = combine(before, x)` is proved in exact arithmetic.
 *
 * Generated fields a copy, a step or a selection reads are evaluated on the host (`HostEvaluator`), by the expressions
 * PostgreSQL generates them by, so the host's copies agree with PostgreSQL's columns.
 *
 * The fill is one iterative depth-first walk over the nesting, so any depth walks. Each row's columns fall in two
 * phases: on entering the row, every column that reads its owner, its predecessor, its position or its own entering
 * columns; on leaving it, after its families' members, every column that reads a family's last member (a last-axis copy,
 * a tree's `end`) or another leaving column. An owner-axis copy of an owner's leaving column would read a value the walk
 * has not drawn when it reads it, and a cycle among one row's columns has no value: the filler refuses both when it is
 * built.
 */
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { predicateTable, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family, FamilyFold } from "#compiler/ir/family.ts"
import type { FamilyId, LawField, LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type EvalLeaves,
	type EvalStop,
	evaluateTable,
	literalValue,
	type RegexMember
} from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { admitValue, type CarrierSpec, compareValues } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"

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
	readonly relation: string
	readonly values: ReadonlyMap<ColumnKey, unknown>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<HostNode>
	}>
}

/** A row of a nesting filled: every column the host writes, by key, and each family it owns, with its members filled. */
export interface FilledNode {
	readonly relation: string
	readonly values: ReadonlyMap<ColumnKey, unknown>
	readonly families: ReadonlyArray<{
		readonly family: Family
		readonly members: ReadonlyArray<FilledNode>
	}>
}

/**
 * The host's evaluation of an expression over one row of `relation`, a generated field's generation expression or a
 * fold step's selection: `read` gives each field the row holds by its name, as its codec's host value, undefined where
 * the row holds none; the result is the codec's host value of the expression's type, or why the host has none.
 */
export type HostEvaluator = (
	relation: LawRelation,
	expr: ScalarExpr,
	read: (field: string) => unknown
) => Result.Result<unknown, EvalStop>

/**
 * Why a nesting cannot be filled: an expression the host cannot evaluate over a row (its stop, as the evaluator gives
 * it); or a fold's after or a copy outside its column's carrier, which PostgreSQL would refuse; each at its row, by the
 * path of count fields and member positions from the nesting's root, and its column.
 */
export type FillRefusal = {
	readonly path: ReadonlyArray<string | number>
	readonly relation: string
	readonly column: string
} & (
	| { readonly kind: "evaluation"; readonly stop: EvalStop }
	| { readonly kind: "range"; readonly family: FamilyId }
)

/** A nesting's fills, built once for the families of a schema and the installation's codes. */
export type Filler = (root: HostNode) => Result.Result<FilledNode, FillRefusal>

/** A family's key: one count counts one family. */
export const familyKey = (id: FamilyId): string => `${id.owner}\u0000${id.count}`

/**
 * Where a row stands in a nesting: written by the ChangeSet itself (`top`), a family's member, or a tree's root, which
 * is its own family's owner and outside its members.
 */
type Position =
	| { readonly kind: "top" }
	| { readonly kind: "member"; readonly family: Family }
	| { readonly kind: "root"; readonly family: Family }

const positionKey = (p: Position): string =>
	p.kind === "top" ? "top" : `${p.kind}\u0000${familyKey(p.family.id)}`

/**
 * How the host fills one column of a row at one position:
 * - given: the caller's, the row's own value;
 * - owner: a member's group field, or a tree node's root field below its root: its owner's column `to`;
 * - own: a tree root's group field, its parent, and every copy its owner axis carries: its own column `to`, since the
 *   root references itself along the owner axis;
 * - index, copy, count, start, end, parentStart: a drawn natural, from where the row stands: its slot, its owner's
 *   count of the family it stands in, the count of a family it owns, a tree node's start, its end, its parent's start;
 * - ownerCopy, predecessor, last: an accumulated or hidden column carried along an axis, the target row's column `to`,
 *   and `base` at the axis's base;
 * - after: a fold plane's after, `combine(befores, x)` where the step side's selection holds and its before elsewhere;
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
	| { readonly kind: "ownerCopy"; readonly to: ColumnKey; readonly base: unknown }
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
			readonly fold: FamilyFold
			readonly plane: 0 | 1
			readonly befores: ReadonlyArray<ColumnKey>
			readonly x: ColumnKey | undefined
	  }
	| { readonly kind: "generated"; readonly expr: ScalarExpr }

/** A column the host knows of a relation: its key, its name as a refusal names it, its carrier's spec, and its rule. */
interface Column {
	readonly key: ColumnKey
	readonly name: string
	readonly spec: CarrierSpec
	readonly rule: Rule
	/** The row's own columns it reads, which are filled before it. */
	readonly reads: ReadonlyArray<ColumnKey>
	/** Whether it is filled on leaving its row, after its families' members. */
	readonly leaving: boolean
	/** Whether the host writes it: every column but a generated one. */
	readonly written: boolean
}

/** A relation's columns at one position, by key, in the order the walk fills each phase. */
interface Layout {
	readonly relation: LawRelation
	readonly columns: ReadonlyMap<ColumnKey, Column>
	readonly entering: ReadonlyArray<Column>
	readonly leaving: ReadonlyArray<Column>
	/** The families its rows own, by key. */
	readonly owns: ReadonlyArray<Family>
}

/** A field's column key. */
const keyOf = (f: LawField): ColumnKey => fieldKey(f.name)

/** The field names an expression reads of its row. */
export const readsOf = (expr: ScalarExpr): ReadonlyArray<string> => {
	const table = predicateTable(expr)
	return [
		...new Set(
			Object.values(table.exprs).flatMap((e) => (e.kind === "column" ? [e.column.name] : []))
		)
	]
}

/** A carrier value as the evaluator holds it, from a codec's host value: integers as bigint, spans of bigints. */
const evalValue = (spec: CarrierSpec, value: unknown): CarrierValue | undefined => {
	switch (spec.carrier) {
		case "int2":
		case "int4":
			return typeof value === "number" ? BigInt(value) : undefined
		case "range4":
			return isSpan(value) && typeof value.start === "number" && typeof value.end === "number"
				? { start: BigInt(value.start), end: BigInt(value.end) }
				: undefined
		case "vector":
			return undefined
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
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

/** A codec's host value of a carrier from the evaluator's: smallint's and integer's numbers, a range4's endpoints. */
const hostValue = (spec: CarrierSpec, value: CarrierValue): unknown => {
	switch (spec.carrier) {
		case "int2":
		case "int4":
			return typeof value === "bigint" ? Number(value) : value
		case "range4":
			return isSpan(value) && typeof value.start === "bigint" && typeof value.end === "bigint"
				? { start: Number(value.start), end: Number(value.end) }
				: value
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "text":
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
 * The host evaluator over the closed relations `closed` answers and the text package's regex membership: a row's field
 * read through its relation's carrier, and the result back as the expression type's host value.
 */
export const hostEvaluator =
	(codes: Codebook, closed: EvalLeaves["closed"], regexMember: RegexMember): HostEvaluator =>
	(relation, expr, read) => {
		const table = predicateTable(expr)
		const specOf = new Map(
			relation.fields.map((f) => [f.name, carrierSpecOf(f.type, codes)] as const)
		)
		const leaves: EvalLeaves = {
			value: undefined,
			column: (ref) => {
				const spec = specOf.get(ref.name)
				const value = read(ref.name)
				return spec === undefined || value === undefined ? undefined : evalValue(spec, value)
			},
			closed
		}
		return Result.map(evaluateTable(table.exprs, table.root, leaves, regexMember), (v) =>
			hostValue(carrierSpecOf(expr.type, codes), v)
		)
	}

/** A closed relation as the host reads it: its heading's names, its key's width, and its rows in heading order. */
export interface ClosedRows {
	readonly heading: ReadonlyArray<{ readonly name: string }>
	readonly key: number
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

/** A key's text in an index of closed rows: each component's text, length first, so no two keys share one. */
const keyText = (values: ReadonlyArray<CarrierValue>): string =>
	values
		.map((v) => {
			const t =
				typeof v === "object"
					? JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? `${x}n` : x))
					: `${typeof v}:${String(v)}`
			return `${t.length}:${t}`
		})
		.join("")

/**
 * The closed reads the host evaluates a generation expression's C.at and C.row by, over the closed relations `closed`
 * holds, by name: C.at's cell is the field's value at the row whose key is its arguments, none where no row is; C.row's
 * set is the last key field's value of every row whose key begins with its arguments. Each relation is indexed by key
 * on its first read.
 */
export const closedLeaf = (closed: ReadonlyMap<string, ClosedRows>): EvalLeaves["closed"] => {
	const cells = new Map<string, ReadonlyMap<string, ReadonlyArray<TypedLiteral>>>()
	const prefixes = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>()
	return (relation, field, args) => {
		const c = closed.get(relation)
		if (c === undefined) {
			return undefined
		}
		if (field !== undefined) {
			let index = cells.get(relation)
			if (index === undefined) {
				index = new Map(
					c.rows.map((row) => [keyText(row.slice(0, c.key).map(literalValue)), row] as const)
				)
				cells.set(relation, index)
			}
			const column = c.heading.findIndex((h) => h.name === field)
			const row = index.get(keyText(args))
			const cell = row?.[column]
			return cell === undefined ? undefined : literalValue(cell)
		}
		let index = prefixes.get(relation)
		if (index === undefined) {
			const built = new Map<string, Set<string>>()
			for (const row of c.rows) {
				const last = row[c.key - 1]
				const value = last === undefined ? undefined : literalValue(last)
				if (typeof value !== "string") {
					continue
				}
				const prefix = keyText(row.slice(0, c.key - 1).map(literalValue))
				const set = built.get(prefix) ?? new Set<string>()
				set.add(value)
				built.set(prefix, set)
			}
			index = built
			prefixes.set(relation, index)
		}
		return new Set(index.get(keyText(args)) ?? [])
	}
}

/** The type of a column of a family's member: a field's own; ‹n› and ‹i› the count's natural, ‹ps› the tree's start's,
 * a hidden accumulator its plane's end's; none for a law column the family does not draw. */
export const familyColumnType = (family: Family, column: NativeColumn): ScalarType | undefined => {
	if (column.kind === "field") {
		return column.field.type
	}
	if (column.column === family.copy) {
		return family.count.type
	}
	if (family.index.kind === "law" && family.index.column === column.column) {
		return family.count.type
	}
	if (family.members.kind === "tree" && family.members.parentStart === column.column) {
		return family.members.start.type
	}
	for (const fold of family.folds) {
		for (const plane of fold.planes) {
			if (
				(plane.before.kind === "law" && plane.before.column === column.column) ||
				(plane.after.kind === "law" && plane.after.column === column.column)
			) {
				return plane.end.type
			}
		}
	}
	return undefined
}

/** The refusal of a filler that cannot be built. */
const unfillable = (detail: string): CompileError =>
	unsupported(SourceLoc("ChangeSet.insert", []), detail)

/**
 * The base of an accumulated column: an accumulated field's start, a hidden before's plane identity; none for a column
 * carried with no base (a caller's column the axis also carries, which its row supplies).
 */
export const baseOf = (
	family: Family,
	column: NativeColumn,
	spec: CarrierSpec
): { readonly kind: "base"; readonly value: unknown } | { readonly kind: "none" } => {
	if (column.kind === "field") {
		return column.field.writing.kind === "accumulated"
			? { kind: "base", value: literalHost(spec, column.field.writing.start) }
			: { kind: "none" }
	}
	for (const fold of family.folds) {
		for (const plane of fold.planes) {
			if (plane.before.kind === "law" && plane.before.column === column.column) {
				return { kind: "base", value: literalHost(spec, plane.identity) }
			}
		}
	}
	return { kind: "none" }
}

/**
 * Whether the host fills a column carried along an axis of `family` as a copy: an accumulated field, or a fold's
 * hidden accumulator. The drawn columns an axis carries (‹n› → n, a tree's ‹ps› → start) are drawn where the walk
 * stands, and a caller's column its row supplies.
 */
const carried = (family: Family, column: NativeColumn): boolean =>
	column.kind === "field"
		? column.field.writing.kind === "accumulated"
		: family.folds.some((fold) =>
				fold.planes.some(
					(plane) =>
						(plane.before.kind === "law" && plane.before.column === column.column) ||
						(plane.after.kind === "law" && plane.after.column === column.column)
				)
			)

/** Builds one relation's layout at one position. */
const layoutOf = (
	relation: LawRelation,
	position: Position,
	families: ReadonlyArray<Family>,
	codes: Codebook
): Result.Result<Layout, CompileError> => {
	const rules = new Map<
		ColumnKey,
		{ readonly name: string; readonly type: ScalarType; rule: Rule }
	>()
	const set = (key: ColumnKey, name: string, type: ScalarType, rule: Rule): void => {
		rules.set(key, { name, type, rule })
	}
	for (const field of relation.fields) {
		switch (field.writing.kind) {
			case "caller":
			case "serial":
				set(keyOf(field), field.name, field.type, { kind: "given" })
				break
			case "generated":
				set(keyOf(field), field.name, field.type, { kind: "generated", expr: field.writing.expr })
				break
			case "drawn":
			case "accumulated":
				break
		}
	}
	const owns = families.filter((f) => f.owner.name === relation.name)
	for (const f of owns) {
		set(keyOf(f.count), f.count.name, f.count.type, { kind: "count", family: familyKey(f.id) })
		for (const pair of f.axes.last) {
			if (pair.from.kind !== "field" || !carried(f, pair.from)) {
				continue
			}
			const spec = carrierSpecOf(pair.from.field.type, codes)
			const base = baseOf(f, pair.from, spec)
			if (base.kind === "none") {
				return Result.err(unfillable(`the last-slot copy ${pair.from.field.name} has no start`))
			}
			set(keyOf(pair.from.field), pair.from.field.name, pair.from.field.type, {
				kind: "last",
				family: familyKey(f.id),
				to: columnKey(pair.to),
				base: base.value
			})
		}
	}
	if (position.kind !== "top") {
		const f = position.family
		const root = position.kind === "root"
		const group = f.group
		for (const g of group) {
			set(
				keyOf(g.member),
				g.member.name,
				g.member.type,
				root ? { kind: "own", to: keyOf(g.owner) } : { kind: "owner", to: keyOf(g.owner) }
			)
		}
		if (f.index.kind === "field") {
			set(keyOf(f.index.field), f.index.field.name, f.index.field.type, { kind: "index" })
		} else {
			set(columnKey(f.index), f.index.column, f.count.type, { kind: "index" })
		}
		set(`law:${f.copy}`, f.copy, f.count.type, { kind: "copy" })
		if (f.members.kind === "tree") {
			const t = f.members
			set(keyOf(t.start), t.start.name, t.start.type, { kind: "start" })
			set(keyOf(t.end), t.end.name, t.end.type, { kind: "end" })
			set(`law:${t.parentStart}`, t.parentStart, t.start.type, { kind: "parentStart" })
			if (!root) {
				set(keyOf(t.root), t.root.name, t.root.type, { kind: "owner", to: keyOf(t.root) })
			}
		}
		for (const pair of f.axes.owner) {
			if (!carried(f, pair.from)) {
				continue
			}
			const type = familyColumnType(f, pair.from)
			if (type === undefined) {
				return Result.err(
					unfillable(`a column the owner axis of ${f.id.owner}.${f.id.count} carries`)
				)
			}
			const spec = carrierSpecOf(type, codes)
			const base = baseOf(f, pair.from, spec)
			set(
				columnKey(pair.from),
				nameOf(pair.from),
				type,
				root
					? { kind: "own", to: columnKey(pair.to) }
					: {
							kind: "ownerCopy",
							to: columnKey(pair.to),
							base: base.kind === "base" ? base.value : undefined
						}
			)
		}
		for (const pair of f.axes.predecessor) {
			if (!carried(f, pair.from)) {
				continue
			}
			const type = familyColumnType(f, pair.from)
			if (type === undefined) {
				return Result.err(
					unfillable(`a column the predecessor axis of ${f.id.owner}.${f.id.count} carries`)
				)
			}
			const spec = carrierSpecOf(type, codes)
			const base = baseOf(f, pair.from, spec)
			if (base.kind === "none") {
				return Result.err(unfillable(`the predecessor copy ${nameOf(pair.from)} has no start`))
			}
			set(columnKey(pair.from), nameOf(pair.from), type, {
				kind: "predecessor",
				to: columnKey(pair.to),
				base: base.value
			})
		}
		for (const fold of f.folds) {
			const befores = fold.planes.map((p) => columnKey(p.before))
			for (const [p, plane] of fold.planes.entries()) {
				const type = familyColumnType(f, plane.after) ?? plane.end.type
				set(columnKey(plane.after), nameOf(plane.after), type, {
					kind: "after",
					family: f.id,
					fold,
					plane: p === 0 ? 0 : 1,
					befores,
					x: fold.step.kind === "value" ? keyOf(fold.step.field) : undefined
				})
			}
		}
	}
	/** The row's own columns a rule reads. */
	const readsOfRule = (rule: Rule): ReadonlyArray<ColumnKey> => {
		switch (rule.kind) {
			case "own":
				return [rule.to]
			case "after":
				return [
					...rule.befores,
					...(rule.x === undefined ? [] : [rule.x]),
					...rule.fold.where.flatMap((w) => readsOf(w).map(fieldKey))
				]
			case "generated":
				return readsOf(rule.expr).map(fieldKey)
			case "given":
			case "owner":
			case "index":
			case "copy":
			case "count":
			case "start":
			case "end":
			case "parentStart":
			case "ownerCopy":
			case "predecessor":
			case "last":
				return []
		}
	}
	/** Each column's phase, by a depth-first pass over its reads that refuses a cycle. */
	const leaving = new Map<ColumnKey, boolean>()
	const visiting = new Set<ColumnKey>()
	const phaseOf = (key: ColumnKey): Result.Result<boolean, CompileError> => {
		const known = leaving.get(key)
		if (known !== undefined) {
			return Result.ok(known)
		}
		const entry = rules.get(key)
		if (entry === undefined) {
			return Result.err(
				unfillable(
					`${relation.name} reads ${key.slice(key.indexOf(":") + 1)}, a column the host does not fill`
				)
			)
		}
		if (visiting.has(key)) {
			return Result.err(
				unfillable(`the columns of ${relation.name} read each other in a cycle at ${entry.name}`)
			)
		}
		visiting.add(key)
		let phase = entry.rule.kind === "end" || entry.rule.kind === "last"
		for (const read of readsOfRule(entry.rule)) {
			const p = phaseOf(read)
			if (!p.ok) {
				return p
			}
			phase = phase || p.value
		}
		visiting.delete(key)
		leaving.set(key, phase)
		return Result.ok(phase)
	}
	const columns = new Map<ColumnKey, Column>()
	for (const [key, entry] of rules) {
		const phase = phaseOf(key)
		if (!phase.ok) {
			return phase
		}
		columns.set(key, {
			key,
			name: entry.name,
			spec: carrierSpecOf(entry.type, codes),
			rule: entry.rule,
			reads: readsOfRule(entry.rule),
			leaving: phase.value,
			written: entry.rule.kind !== "generated"
		})
	}
	const all = [...columns.values()]
	return Result.ok({
		relation,
		columns,
		entering: all.filter((c) => !c.leaving),
		leaving: all.filter((c) => c.leaving),
		owns
	})
}

const nameOf = (column: NativeColumn): string =>
	column.kind === "field" ? column.field.name : column.column

/** One step of a monoid's combine on host values, at the after's carrier; undefined when the result leaves it. */
export const combineHost = (
	fold: FamilyFold,
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
	}
}

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
	const left = admitValue(spec, a)
	const right = admitValue(spec, b)
	if (!left.ok || !right.ok) {
		return undefined
	}
	return compareValues(spec, left.value, right.value) >= 0 ? left.value : right.value
}

/** A row being filled: its layout, its values so far, where it stands, and what its rules read beyond it. */
interface Row {
	readonly layout: Layout
	readonly values: Map<ColumnKey, unknown>
	readonly path: ReadonlyArray<string | number>
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
	/** A tree node's interval and its parent's start; its end is drawn on leaving it. */
	readonly tree: { readonly start: number; end: number; readonly parentStart: number } | undefined
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
		throw defect(`a column ${key} of ${row.layout.relation.name} the filler laid out`)
	}
	const value = ruleValue(row, column, evaluate)
	if (!value.ok) {
		return value
	}
	row.values.set(key, value.value)
	return value
}

/** A refusal at a row's column. */
const refusalAt = (
	row: Row,
	column: Column,
	refusal:
		| { readonly kind: "evaluation"; readonly stop: EvalStop }
		| { readonly kind: "range"; readonly family: FamilyId }
): FillRefusal => ({
	path: row.path,
	relation: row.layout.relation.name,
	column: column.name,
	...refusal
})

/** A value of a column's carrier, admitted as PostgreSQL would store it, or refused as outside it. */
const admittedAt = (
	row: Row,
	column: Column,
	family: FamilyId,
	value: unknown
): Result.Result<unknown, FillRefusal> => {
	if (value === undefined) {
		return Result.err(refusalAt(row, column, { kind: "range", family }))
	}
	const admitted = admitValue(column.spec, value)
	return admitted.ok
		? Result.ok(admitted.value)
		: Result.err(refusalAt(row, column, { kind: "range", family }))
}

/** A column of a row the walk filled before the row it fills now reads it. */
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
			return Result.ok(row.owner === undefined ? rule.base : filledBefore(row.owner, rule.to, row))
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
			for (const w of rule.fold.where) {
				const holds = evaluate(row.layout.relation, w, readerOf(row, evaluate))
				if (!holds.ok) {
					return Result.err(refusalAt(row, column, { kind: "evaluation", stop: holds.error }))
				}
				if (holds.value !== true) {
					return Result.ok(befores[rule.plane])
				}
			}
			if (rule.x === undefined) {
				return admittedAt(
					row,
					column,
					rule.family,
					combineHost(rule.fold, rule.plane, befores, undefined, column.spec)
				)
			}
			const x = valueOf(row, rule.x, evaluate)
			if (!x.ok) {
				return x
			}
			return admittedAt(
				row,
				column,
				rule.family,
				combineHost(rule.fold, rule.plane, befores, x.value, column.spec)
			)
		}
		case "generated": {
			const v = evaluate(row.layout.relation, rule.expr, readerOf(row, evaluate))
			return v.ok
				? Result.ok(v.value)
				: Result.err(refusalAt(row, column, { kind: "evaluation", stop: v.error }))
		}
	}
}

/** A row's field reader for the evaluator: each field's value, filled on demand, undefined where it has none. */
const readerOf =
	(row: Row, evaluate: HostEvaluator) =>
	(field: string): unknown => {
		const key = fieldKey(field)
		if (!row.layout.columns.has(key)) {
			return undefined
		}
		const v = valueOf(row, key, evaluate)
		return v.ok ? v.value : undefined
	}

/** A row met by the walk: its row, its node, the families it owns resolved, and where its walk over them stands. */
interface Frame {
	readonly row: Row
	readonly families: ReadonlyArray<{
		readonly family: Family
		readonly members: ReadonlyArray<HostNode>
	}>
	/** The family it is filling, and the next member of it. */
	family: number
	member: number
	/** The last member of that family filled so far. */
	previous: Row | undefined
	readonly filled: Array<{ readonly family: Family; readonly members: Array<FilledNode> }>
	/** The counter of the tree it is a node of: the start of the next node the tree meets. */
	readonly tree: { next: number } | undefined
}

/** Every column of a phase of a row filled, in any order: each fills what it reads first. */
const fillPhase = (
	row: Row,
	columns: ReadonlyArray<Column>,
	evaluate: HostEvaluator
): Result.Result<void, FillRefusal> => {
	for (const column of columns) {
		const v = valueOf(row, column.key, evaluate)
		if (!v.ok) {
			return Result.err(v.error)
		}
	}
	return Result.ok(undefined)
}

/** Whether a family is the tree of the relation `relation`: a family of it over itself whose members are a tree's. */
const isTreeOf = (family: Family, relation: string): boolean =>
	family.members.kind === "tree" &&
	family.member.name === relation &&
	family.owner.name === relation

/**
 * The filler of nestings over `families`, the law model's (laws/model/model.ts LawModel.families): each relation's
 * columns laid out once per position it can stand at, with their phases. Refused when a copy reads a value its walk
 * has not drawn when it reads it: an owner-axis copy of an owner's leaving column, or a cycle among one row's columns.
 */
export const filler = (
	families: ReadonlyArray<Family>,
	codes: Codebook,
	evaluate: HostEvaluator
): Result.Result<Filler, CompileError> => {
	const byKey = new Map(families.map((f) => [familyKey(f.id), f] as const))
	const relations = new Map<string, LawRelation>()
	for (const f of families) {
		relations.set(f.owner.name, f.owner)
		relations.set(f.member.name, f.member)
	}
	const layouts = new Map<string, Layout>()
	const layout = (
		relation: LawRelation,
		position: Position
	): Result.Result<Layout, CompileError> => {
		const key = `${relation.name}\u0000${positionKey(position)}`
		const known = layouts.get(key)
		if (known !== undefined) {
			return Result.ok(known)
		}
		const built = layoutOf(relation, position, families, codes)
		if (built.ok) {
			layouts.set(key, built.value)
		}
		return built
	}
	/** Every position a relation can stand at: a tree's root, a family's member, or written by the ChangeSet itself
	 * when it is no family's member. */
	const positionsOf = (relation: string): ReadonlyArray<Position> => {
		const tree = families.find((f) => isTreeOf(f, relation))
		const memberOf = families.filter((f) => f.member.name === relation)
		return [
			...(tree === undefined ? [] : [{ kind: "root", family: tree } as const]),
			...memberOf.map((family) => ({ kind: "member", family }) as const),
			...(memberOf.length === 0 ? [{ kind: "top" } as const] : [])
		]
	}
	for (const [name, relation] of relations) {
		for (const position of positionsOf(name)) {
			const built = layout(relation, position)
			if (!built.ok) {
				return built
			}
		}
	}
	for (const f of families) {
		const member = layout(f.member, { kind: "member", family: f })
		if (!member.ok) {
			return member
		}
		for (const column of member.value.columns.values()) {
			const rule = column.rule
			if (rule.kind !== "owner" && rule.kind !== "ownerCopy") {
				continue
			}
			for (const position of positionsOf(f.owner.name)) {
				const owner = layout(f.owner, position)
				if (!owner.ok) {
					return owner
				}
				if (owner.value.columns.get(rule.to)?.leaving !== false) {
					return Result.err(
						unfillable(
							`${f.member.name}.${column.name} copies ${f.owner.name}'s ${rule.to.slice(rule.to.indexOf(":") + 1)} along the owner axis of ${f.id.owner}.${f.id.count}, a column its owner fills only after its members`
						)
					)
				}
			}
		}
	}
	/** A row's layout at a position, which the filler laid out when it was built. */
	const laidOut = (relation: string, position: Position): Layout => {
		const r = relations.get(relation)
		const built = r === undefined ? undefined : layout(r, position)
		if (built === undefined || !built.ok) {
			throw defect(`the layout of ${relation} the filler built`)
		}
		return built.value
	}
	/** A node's families resolved, each family its relation owns in the node's order. */
	const resolved = (node: HostNode): Frame["families"] =>
		node.families.map((g) => {
			const family = byKey.get(familyKey(g.family))
			if (family === undefined) {
				throw defect(`the family ${g.family.owner}.${g.family.count} of the law model`)
			}
			return { family, members: g.members }
		})
	const rowOf = (
		node: HostNode,
		position: Position,
		at: {
			readonly path: ReadonlyArray<string | number>
			readonly owner: Row | undefined
			readonly predecessor: Row | undefined
			readonly at: number
			readonly tree: Row["tree"]
		}
	): Row => ({
		layout: laidOut(node.relation, position),
		values: new Map(node.values),
		path: at.path,
		owner: at.owner,
		predecessor: at.predecessor,
		at: at.at,
		family: position.kind === "top" ? undefined : familyKey(position.family.id),
		counts: new Map(node.families.map((g) => [familyKey(g.family), g.members.length] as const)),
		last: new Map(),
		tree: at.tree
	})
	return Result.ok((root: HostNode): Result.Result<FilledNode, FillRefusal> => {
		const tree = families.find((f) => isTreeOf(f, root.relation))
		const position: Position = tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
		const first = rowOf(root, position, {
			path: [],
			owner: undefined,
			predecessor: undefined,
			at: 0,
			tree: tree === undefined ? undefined : { start: 0, end: 1, parentStart: 0 }
		})
		const entered = fillPhase(first, first.layout.entering, evaluate)
		if (!entered.ok) {
			return Result.err(entered.error)
		}
		const stack: Array<Frame> = [
			{
				row: first,
				families: resolved(root),
				family: 0,
				member: 0,
				previous: undefined,
				filled: [],
				tree: tree === undefined ? undefined : { next: 1 }
			}
		]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const current = frame.families[frame.family]
			if (current !== undefined) {
				if (frame.member === 0) {
					frame.filled.push({ family: current.family, members: [] })
				}
				const node = current.members[frame.member]
				if (node === undefined) {
					if (frame.previous !== undefined) {
						frame.row.last.set(familyKey(current.family.id), frame.previous)
					}
					frame.family += 1
					frame.member = 0
					frame.previous = undefined
					continue
				}
				const at = frame.member
				frame.member += 1
				const inTree =
					isTreeOf(current.family, frame.row.layout.relation.name) && frame.tree !== undefined
				const counter = inTree ? frame.tree : undefined
				const start = counter === undefined ? undefined : counter.next
				if (counter !== undefined) {
					counter.next += 1
				}
				const row = rowOf(
					node,
					{ kind: "member", family: current.family },
					{
						path: [...frame.row.path, current.family.count.name, at],
						owner: frame.row,
						predecessor: frame.previous,
						at,
						tree:
							start === undefined
								? undefined
								: { start, end: start + 1, parentStart: treeOf(frame.row).start }
					}
				)
				const filled = fillPhase(row, row.layout.entering, evaluate)
				if (!filled.ok) {
					return Result.err(filled.error)
				}
				stack.push({
					row,
					families: resolved(node),
					family: 0,
					member: 0,
					previous: undefined,
					filled: [],
					tree: counter
				})
				continue
			}
			if (frame.row.tree !== undefined && frame.tree !== undefined) {
				frame.row.tree.end = frame.tree.next
			}
			const left = fillPhase(frame.row, frame.row.layout.leaving, evaluate)
			if (!left.ok) {
				return Result.err(left.error)
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
			parent.filled.at(-1)?.members.push(done)
		}
		throw defect("the walk ends at its root")
	})
}
