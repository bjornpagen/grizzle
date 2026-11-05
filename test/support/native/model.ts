import { Array as Arr, Option, Result } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	ConstraintName,
	DomainName,
	LawId,
	RelationIdent
} from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	builtExpr,
	type LiveArgs,
	predicateTree,
	type ScalarExpr,
	type TypedLiteral,
	withArgs
} from "#compiler/ir/expr.ts"
import type { DomainCheckTerm, LawField, NativeColumn, NativeKind } from "#compiler/ir/law.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { type EvalEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"

/**
 * A host model of the native constraints grizzle installs, read from the law model's native objects (the IR of what the
 * installation creates), never from SQL text, and evaluated over database states with PostgreSQL's semantics:
 *
 * - a law column is `GENERATED ALWAYS AS (CASE WHEN g₁ AND … THEN t END) STORED`: its term where every conjunct of its
 *   guard is true, and NULL everywhere else; a constant column has no guard and is never NULL;
 * - a PRIMARY KEY and a UNIQUE NULLS DISTINCT refuse two rows equal at every column, and a row NULL at any column is
 *   never a duplicate;
 * - a FOREIGN KEY … MATCH SIMPLE refuses a row whose columns are all non-NULL and equal no target row's referenced
 *   columns; a row NULL at any referencing column references nothing; a target row NULL at a referenced column is
 *   referenced by none;
 * - a table CHECK refuses a row its predicate is false of (NULL passes);
 * - a contract's domain refuses a column value its CHECK is false of, at every level of a contract over a contract;
 * - a NOT DEFERRABLE constraint is checked at the end of the statement that writes it, and a DEFERRABLE INITIALLY
 *   DEFERRED one at COMMIT.
 *
 * Expressions (guards, terms, CHECK predicates, domain predicates) are evaluated by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts), a second implementation of the operator catalogue, so nothing here reads
 * the engine's own evaluation. A native kind this model does not evaluate (span keys and PERIOD foreign keys, closed
 * relations' enums and finite checks) and any residual law refuse the installation, so a test never mistakes an
 * unmodelled constraint for one that holds.
 */

/** A stored row: each field's value by its declared name. A field never holds NULL. */
export type NativeRow = ReadonlyMap<string, CarrierValue>

/** A database state: each relation's rows by its declared name, as a multiset in no order; an absent relation is empty. */
export type NativeState = ReadonlyMap<string, ReadonlyArray<NativeRow>>

/** A column's value in a stored row: a value, or NULL, which only a law column holds outside its guard. */
type Cell = { readonly kind: "null" } | { readonly kind: "value"; readonly value: CarrierValue }

/** When PostgreSQL checks a constraint: at the end of the statement that writes its table, or at COMMIT. */
export type Timing = "immediate" | "deferred"

/** A column a constraint reads: a field of its table by name, or a law column the law model adds to it. */
type ColumnRead =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "law"; readonly column: ColumnIdent }

/** What every constraint carries: its installed name, its owner, the laws it discharges and when it is checked. */
interface Named {
	readonly name: ConstraintName
	readonly laws: NonEmptyReadonlyArray<LawId>
	readonly timing: Timing
}

/** A constraint as the model checks it. */
export type NativeConstraint = Named &
	(
		| {
				readonly kind: "PrimaryKey" | "Unique"
				readonly relation: string
				readonly owner: RelationIdent
				readonly columns: NonEmptyReadonlyArray<ColumnRead>
		  }
		| {
				readonly kind: "ForeignKey"
				readonly relation: string
				readonly owner: RelationIdent
				readonly columns: NonEmptyReadonlyArray<ColumnRead>
				readonly target: string
				readonly targetColumns: NonEmptyReadonlyArray<ColumnRead>
		  }
		| {
				readonly kind: "TableCheck"
				readonly relation: string
				readonly owner: RelationIdent
				readonly predicate: ScalarExpr
		  }
		| {
				readonly kind: "Domain"
				readonly owner: DomainName
				/** The contract whose values the domain holds: every column typed by it, at any level, is checked. */
				readonly contract: string
				readonly terms: NonEmptyReadonlyArray<DomainCheckTerm>
		  }
	)

/** A law column of a relation: its identifier, and the guard and term it is generated from. */
interface LawColumnOf {
	readonly column: ColumnIdent
	readonly guard: ReadonlyArray<ScalarExpr>
	readonly term: ScalarExpr
}

/** A relation as the model stores it: its fields with their types, and its law columns. */
interface RelationOf {
	readonly name: string
	readonly fields: ReadonlyArray<LawField>
	readonly lawColumns: ReadonlyArray<LawColumnOf>
}

/** An installation as the model evaluates it: its relations and every constraint, each once. */
export interface NativeInstallation {
	readonly relations: ReadonlyMap<string, RelationOf>
	readonly constraints: ReadonlyArray<NativeConstraint>
}

/** Why the model does not evaluate an installation: a residual law, or a native kind it has no semantics for. */
export type Unmodelled =
	| { readonly kind: "residual"; readonly laws: NonEmptyReadonlyArray<LawId> }
	| { readonly kind: "native"; readonly native: NativeKind }

/** One constraint a state breaks. */
export interface NativeViolation {
	readonly constraint: ConstraintName
	readonly kind: NativeConstraint["kind"]
	/** The table or domain the constraint is scoped to, which a violation's report names beside the constraint. */
	readonly owner: RelationIdent | DomainName
	readonly laws: NonEmptyReadonlyArray<LawId>
	readonly timing: Timing
	/** A key's duplicates: each pair of its table's rows it holds equal, by their places among the state's rows. */
	readonly duplicates: ReadonlyArray<Duplicate>
}

/** Two rows of a relation a key holds equal, by their places among the state's rows of it, the first earlier. */
export interface Duplicate {
	readonly relation: string
	readonly first: number
	readonly second: number
}

const columnRead = (c: NativeColumn): ColumnRead =>
	c.kind === "field" ? { kind: "field", field: c.field.name } : { kind: "law", column: c.column }

const columnReads = (
	columns: NonEmptyReadonlyArray<NativeColumn>
): NonEmptyReadonlyArray<ColumnRead> => Arr.map(columns, columnRead)

/** The installation's constraints and law columns, or the first native or residual law the model has no semantics for. */
export const nativeInstallation = (
	model: LawModel
): Result.Result<NativeInstallation, Unmodelled> => {
	const [residual, ...residuals] = Arr.map(model.residuals, (r) => r.lawId)
	if (residual !== undefined) {
		return Result.fail({ kind: "residual", laws: [residual, ...residuals] })
	}
	const fields = new Map<string, ReadonlyArray<LawField>>()
	const lawColumns = new Map<string, Array<LawColumnOf>>()
	const constraints: Array<NativeConstraint> = []
	const place = (n: NamedNative): Option.Option<Unmodelled> => {
		switch (n.namespace) {
			case "constraint": {
				const o = n.object
				fields.set(o.relation.name, o.relation.fields)
				const named = { name: identifierOf(n.named), laws: o.lawIds, owner: n.owner }
				switch (o.kind) {
					case "PrimaryKey":
						constraints.push({
							...named,
							kind: "PrimaryKey",
							relation: o.relation.name,
							timing: "immediate",
							columns: Arr.map(o.columns, (f) => ({ kind: "field", field: f.name }))
						})
						return Option.none()
					case "Unique":
						constraints.push({
							...named,
							kind: "Unique",
							relation: o.relation.name,
							timing: "immediate",
							columns: columnReads(o.columns)
						})
						return Option.none()
					case "ForeignKey":
						fields.set(o.target.name, o.target.fields)
						constraints.push({
							...named,
							kind: "ForeignKey",
							relation: o.relation.name,
							timing: o.deferrable ? "deferred" : "immediate",
							columns: columnReads(o.columns),
							target: o.target.name,
							targetColumns: columnReads(o.targetColumns)
						})
						return Option.none()
					case "TableCheck":
						constraints.push({
							...named,
							kind: "TableCheck",
							relation: o.relation.name,
							timing: "immediate",
							predicate: o.predicate
						})
						return Option.none()
					case "WithoutOverlaps":
					case "TemporalUnique":
					case "PeriodForeignKey":
					case "FiniteCheck":
						return Option.some({ kind: "native", native: o.kind })
				}
			}
			case "column": {
				const o = n.object
				const of = lawColumns.get(o.relation.name) ?? []
				of.push({ column: o.column, guard: o.value.guard, term: o.value.term })
				lawColumns.set(o.relation.name, of)
				return Option.none()
			}
			case "domain":
				if (n.check.kind === "checked") {
					constraints.push({
						kind: "Domain",
						name: n.check.ident,
						owner: n.owner,
						laws: n.object.lawIds,
						timing: "immediate",
						contract: n.object.name,
						terms: n.check.terms
					})
				}
				return Option.none()
			case "unnamed":
				return n.object.kind === "ReverseIndex"
					? Option.none()
					: Option.some({ kind: "native", native: n.object.kind })
		}
	}
	for (const n of model.natives) {
		const refused = place(n)
		if (Option.isSome(refused)) {
			return Result.fail(refused.value)
		}
	}
	const relations = new Map<string, RelationOf>(
		Arr.map([...fields], ([name, of]) => [
			name,
			{ name, fields: of, lawColumns: lawColumns.get(name) ?? [] }
		])
	)
	return Result.succeed({ relations, constraints })
}

/** The relation's record, which every relation a constraint names has. */
const relationOf = (installation: NativeInstallation, name: string): RelationOf => {
	const found = installation.relations.get(name)
	if (found === undefined) {
		throw new Error(`the installation holds no relation ${name}`)
	}
	return found
}

/** A row's field values, for the reference evaluator to read by column name. */
const rowEnv = (row: NativeRow): EvalEnv => ({
	kind: "row",
	column: (ref) => row.get(ref.name),
	param: () => undefined,
	regexMember: patternMember
})

/** An expression's value over a row: a stop is a defect of the installation or of the state, never a verdict. */
const valueOver = (expr: ScalarExpr, env: EvalEnv, what: string): CarrierValue => {
	const v = evaluate(expr, env)
	if (Result.isFailure(v)) {
		throw new Error(`${what} has no value: ${v.failure.kind} ${v.failure.what}`)
	}
	return v.success
}

/** Whether a predicate holds, which a boolean expression's value is. */
const holdsOver = (expr: ScalarExpr, env: EvalEnv, what: string): boolean => {
	const v = valueOver(expr, env, what)
	if (typeof v !== "boolean") {
		throw new Error(`${what} is not a predicate`)
	}
	return v
}

/** A stored row with its law columns: each field as itself, each law column its term where its guard holds. */
interface Generated {
	readonly row: NativeRow
	readonly lawColumns: ReadonlyMap<ColumnIdent, Cell>
}

const generated = (relation: RelationOf, row: NativeRow): Generated => {
	const env = rowEnv(row)
	return {
		row,
		lawColumns: new Map(
			Arr.map(relation.lawColumns, (c): readonly [ColumnIdent, Cell] => [
				c.column,
				Arr.every(c.guard, (g) => holdsOver(g, env, `the guard of ${c.column}`))
					? { kind: "value", value: valueOver(c.term, env, `the term of ${c.column}`) }
					: { kind: "null" }
			])
		)
	}
}

const cellOf = (g: Generated, c: ColumnRead): Cell => {
	if (c.kind === "law") {
		const cell = g.lawColumns.get(c.column)
		if (cell === undefined) {
			throw new Error(
				`a constraint reads the law column ${c.column}, which its table does not hold`
			)
		}
		return cell
	}
	const v = g.row.get(c.field)
	if (v === undefined) {
		throw new Error(`a row without its field ${c.field}`)
	}
	return { kind: "value", value: v }
}

/**
 * A value's text as an equality key: PostgreSQL's equality on the carriers the model evaluates, integers, booleans,
 * text and UUIDs, which compare by value. Any other carrier is a defect of the test that wrote it.
 */
const valueKey = (v: CarrierValue): string => {
	if (typeof v === "bigint") {
		return `i${v}`
	}
	if (typeof v === "boolean") {
		return v ? "t" : "f"
	}
	if (typeof v === "string") {
		return `s${v.length}:${v}`
	}
	throw new Error("the native model compares integers, booleans, text and UUIDs only")
}

/** The columns' values as one key, or none when one of them is NULL: such a row is outside every key and reference. */
const keyOf = (g: Generated, columns: ReadonlyArray<ColumnRead>): Option.Option<string> => {
	const parts: Array<string> = []
	for (const c of columns) {
		const cell = cellOf(g, c)
		if (cell.kind === "null") {
			return Option.none()
		}
		parts.push(valueKey(cell.value))
	}
	return Option.some(Arr.join(parts, "\u0000"))
}

/** A VALUE of a domain's base as a literal of the reference evaluator, which a domain predicate reads it as. */
const literalOf = (v: CarrierValue): TypedLiteral => {
	if (typeof v === "bigint") {
		return { kind: "int", value: v }
	}
	if (typeof v === "boolean") {
		return { kind: "bool", value: v }
	}
	if (typeof v === "string") {
		return { kind: "text", value: v }
	}
	throw new Error("the native model checks domains over integers, booleans and text only")
}

/** The predicate with every VALUE read as `value`, of the domain's base type. */
const withValue = (expr: ScalarExpr, value: CarrierValue, base: ScalarType): ScalarExpr =>
	expr.kind === "value"
		? builtExpr(
				{ kind: "literal", value: literalOf(value), type: base, args: [], nonNull: "literal" },
				expr.id
			)
		: builtExpr(
				withArgs<LiveArgs, LiveArgs>(expr, (a) => withValue(a, value, base)),
				expr.id
			)

/** Whether a domain's CHECK holds of a value of its base type: every term, its pattern and its predicate. */
const domainHolds = (
	terms: ReadonlyArray<DomainCheckTerm>,
	value: CarrierValue,
	base: ScalarType
): boolean =>
	Arr.every(terms, (term) => {
		switch (term.kind) {
			case "pattern":
				return typeof value === "string" && patternMember(term.regex, value)
			case "predicate": {
				const tree = predicateTree(term.predicate)
				if (!tree.ok) {
					throw tree.error
				}
				return holdsOver(
					withValue(tree.value, value, base),
					{ kind: "constant" },
					"a domain predicate"
				)
			}
		}
	})

/** The contracts a field's type is, outermost first: the domain it is typed by, then each domain that one is over. */
const contractsOf = (type: ScalarType): ReadonlyArray<string> => {
	const names: Array<string> = []
	for (let at = contractOf(type); at !== undefined; at = contractOf(at.base)) {
		names.push(at.name)
	}
	return names
}

/** The rows of a relation in a state, each with its law columns. */
const generatedRows = (
	installation: NativeInstallation,
	state: NativeState,
	relation: string
): ReadonlyArray<Generated> => {
	const of = relationOf(installation, relation)
	return Arr.map(state.get(relation) ?? [], (row) => generated(of, row))
}

/** What a state does to a constraint: it holds, or the state breaks it, with a key's duplicates. */
type Checked =
	| { readonly kind: "holds" }
	| { readonly kind: "broken"; readonly duplicates: ReadonlyArray<Duplicate> }

const holds: Checked = { kind: "holds" }
const brokenIf = (broken: boolean): Checked => (broken ? { kind: "broken", duplicates: [] } : holds)

/** Whether a constraint holds of a state, every relation's law columns generated. */
const checkIn = (
	installation: NativeInstallation,
	rows: (relation: string) => ReadonlyArray<Generated>,
	c: NativeConstraint
): Checked => {
	switch (c.kind) {
		case "PrimaryKey":
		case "Unique": {
			const relation = c.relation
			const seen = new Map<string, Array<number>>()
			const duplicates: Array<Duplicate> = []
			for (const [at, g] of rows(relation).entries()) {
				const k = keyOf(g, c.columns)
				if (Option.isNone(k)) {
					continue
				}
				const earlier = seen.get(k.value) ?? []
				for (const first of earlier) {
					duplicates.push({ relation, first, second: at })
				}
				seen.set(k.value, [...earlier, at])
			}
			return duplicates.length === 0 ? holds : { kind: "broken", duplicates }
		}
		case "ForeignKey": {
			const referenced = new Set(
				Arr.flatMap(rows(c.target), (g) => Option.toArray(keyOf(g, c.targetColumns)))
			)
			return brokenIf(
				!Arr.every(rows(c.relation), (g) =>
					Option.match(keyOf(g, c.columns), {
						onNone: () => true,
						onSome: (k) => referenced.has(k)
					})
				)
			)
		}
		case "TableCheck":
			return brokenIf(
				!Arr.every(rows(c.relation), (g) =>
					holdsOver(c.predicate, rowEnv(g.row), `the CHECK ${c.name}`)
				)
			)
		case "Domain":
			return brokenIf(
				!Arr.every([...installation.relations.values()], (relation) =>
					Arr.every(relation.fields, (field) => {
						if (!contractsOf(field.type).includes(c.contract)) {
							return true
						}
						const base = baseOf(field.type)
						return Arr.every(rows(relation.name), (g) => {
							const v = g.row.get(field.name)
							if (v === undefined) {
								throw new Error(`a row of ${relation.name} without its field ${field.name}`)
							}
							return domainHolds(c.terms, v, base)
						})
					})
				)
			)
	}
}

/** Every constraint of the given timings that the state breaks, in the installation's order. */
const violationsOf = (
	installation: NativeInstallation,
	state: NativeState,
	timings: ReadonlyArray<Timing>
): ReadonlyArray<NativeViolation> => {
	const cache = new Map<string, ReadonlyArray<Generated>>()
	const rows = (relation: string): ReadonlyArray<Generated> => {
		const hit = cache.get(relation)
		if (hit !== undefined) {
			return hit
		}
		const made = generatedRows(installation, state, relation)
		cache.set(relation, made)
		return made
	}
	return Arr.flatMap(installation.constraints, (c): ReadonlyArray<NativeViolation> => {
		if (!timings.includes(c.timing)) {
			return []
		}
		const checked = checkIn(installation, rows, c)
		return checked.kind === "holds"
			? []
			: [
					{
						constraint: c.name,
						kind: c.kind,
						owner: c.owner,
						laws: c.laws,
						timing: c.timing,
						duplicates: checked.duplicates
					}
				]
	})
}

/**
 * What a state shows of the constraints' NULL semantics: `distinctNulls`, two rows a UNIQUE holds apart only because
 * NULLs are distinct (equal at every column where both hold a value, and NULL together somewhere); `skippedReference`,
 * a row a FOREIGN KEY references nothing from because one of its referencing columns is NULL.
 */
export interface NullUse {
	readonly distinctNulls: boolean
	readonly skippedReference: boolean
}

const sameCell = (a: Cell, b: Cell): boolean =>
	a.kind === "null"
		? b.kind === "null"
		: b.kind === "value" && valueKey(a.value) === valueKey(b.value)

export const nullUseOf = (installation: NativeInstallation, state: NativeState): NullUse => {
	const rows = (relation: string) => generatedRows(installation, state, relation)
	const distinctNulls = Arr.some(installation.constraints, (c) => {
		if (c.kind !== "Unique") {
			return false
		}
		const cells = Arr.map(rows(c.relation), (g) =>
			Arr.map(c.columns, (column) => cellOf(g, column))
		)
		return Arr.some(cells, (a, i) =>
			Arr.some(
				cells.slice(i + 1),
				(b) =>
					Arr.every(a, (cell, k) => {
						const other = b[k]
						return other !== undefined && sameCell(cell, other)
					}) && Arr.some(a, (cell) => cell.kind === "null")
			)
		)
	})
	const skippedReference = Arr.some(
		installation.constraints,
		(c) =>
			c.kind === "ForeignKey" &&
			Arr.some(rows(c.relation), (g) => Option.isNone(keyOf(g, c.columns)))
	)
	return { distinctNulls, skippedReference }
}

/** Every constraint the state breaks, whenever PostgreSQL checks it: what COMMIT of exactly this state would meet. */
export const stateViolations = (
	installation: NativeInstallation,
	state: NativeState
): ReadonlyArray<NativeViolation> => violationsOf(installation, state, ["immediate", "deferred"])

/**
 * One statement of a transaction over one table: an INSERT of its rows, or a DELETE of every row equal at every field
 * to one listed, which a relation of immutable facts writes a change by.
 */
export type NativeStatement =
	| { readonly kind: "insert"; readonly relation: string; readonly rows: ReadonlyArray<NativeRow> }
	| { readonly kind: "delete"; readonly relation: string; readonly rows: ReadonlyArray<NativeRow> }

/** Where a transaction is refused: at the end of one of its statements, by its index, or at COMMIT. */
export type RefusedAt =
	| { readonly kind: "statement"; readonly index: number }
	| { readonly kind: "commit" }

/** What PostgreSQL does with a transaction: commits it to the state its statements leave, or refuses it. */
export type TransactionVerdict =
	| { readonly kind: "committed"; readonly state: NativeState }
	| {
			readonly kind: "refused"
			readonly at: RefusedAt
			readonly violations: NonEmptyReadonlyArray<NativeViolation>
	  }

const rowKey = (row: NativeRow): string =>
	Arr.join(
		Arr.map(
			Arr.sort([...row.keys()], (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)),
			(field) => {
				const v = row.get(field)
				return `${field}=${v === undefined ? "" : valueKey(v)}`
			}
		),
		"\u0000"
	)

const appliedTo = (state: NativeState, statement: NativeStatement): NativeState => {
	const next = new Map(state)
	const current = state.get(statement.relation) ?? []
	switch (statement.kind) {
		case "insert":
			next.set(statement.relation, [...current, ...statement.rows])
			return next
		case "delete": {
			const gone = new Set(Arr.map(statement.rows, rowKey))
			next.set(
				statement.relation,
				Arr.filter(current, (row) => !gone.has(rowKey(row)))
			)
			return next
		}
	}
}

/**
 * A transaction from a committed state: each statement applied in order, the immediate constraints checked at its end,
 * and the deferred ones at COMMIT. Its verdict is the first point where a constraint checked there is broken, with
 * every constraint broken there, or the state its statements leave.
 */
export const transact = (
	installation: NativeInstallation,
	before: NativeState,
	statements: ReadonlyArray<NativeStatement>
): TransactionVerdict => {
	let state = before
	for (const [index, statement] of statements.entries()) {
		state = appliedTo(state, statement)
		const [first, ...rest] = violationsOf(installation, state, ["immediate"])
		if (first !== undefined) {
			return { kind: "refused", at: { kind: "statement", index }, violations: [first, ...rest] }
		}
	}
	const [first, ...rest] = violationsOf(installation, state, ["deferred"])
	return first === undefined
		? { kind: "committed", state }
		: { kind: "refused", at: { kind: "commit" }, violations: [first, ...rest] }
}

/**
 * The order an immediate foreign key imposes on a writer that sends one statement per table and change: the target's
 * additions before the source's, and the source's removals before the target's. A self-reference orders nothing, since
 * one statement writes both of its ends; a deferred reference orders nothing until COMMIT.
 */
export interface Precedence {
	readonly from: string
	readonly to: string
}

/** Every immediate foreign key of the installation between two tables, as the precedence it imposes. */
export const immediateReferences = (installation: NativeInstallation): ReadonlyArray<Precedence> =>
	Arr.flatMap(installation.constraints, (c): ReadonlyArray<Precedence> =>
		c.kind === "ForeignKey" && c.timing === "immediate" && c.relation !== c.target
			? [{ from: c.relation, to: c.target }]
			: []
	)
