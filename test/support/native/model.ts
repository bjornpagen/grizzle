import { Array as Arr, Option, Result } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ColumnIdent, LawId, RelationIdent } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { TupleSet } from "#compiler/core/tuple-map.ts"
import {
	builtExpr,
	type LiveArgs,
	predicateTree,
	type ScalarExpr,
	type TypedLiteral,
	withArgs
} from "#compiler/ir/expr.ts"
import type { DomainCheckTerm, LawField, NativeColumn, NativeObject } from "#compiler/ir/law.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { type Atom, type ValueIdentity, sameIdentity } from "#test/support/kernel/identity.ts"
import { type EvalEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"

/** The kind of a native object of a law: its constraint, index, trigger or domain constraint. */
export type NativeKind = NativeObject["kind"]

/**
 * A host model of the native constraints grizzle installs, read from the law model's native objects (the IR of what the
 * installation creates), never from SQL text, and evaluated over database states with PostgreSQL's semantics:
 *
 * - a generated law column is `GENERATED ALWAYS AS (CASE WHEN g₁ AND … THEN t END) STORED`: its term where every
 *   conjunct of its guard is true, and NULL everywhere else; a constant column has no guard and is never NULL; a drawn
 *   law column (a family's ‹n›, a counted index, a tree's ‹ps›, a fold's accumulators) is an ordinary column the
 *   writer sends, never NULL, read by the identifier every expression names it by;
 * - a PRIMARY KEY and a UNIQUE NULLS DISTINCT refuse two rows equal at every column, and a row NULL at any column is
 *   never a duplicate; a key WITHOUT OVERLAPS refuses two rows equal at its scalars whose spans overlap, and an empty
 *   span;
 * - a FOREIGN KEY … MATCH SIMPLE refuses a row whose columns are all non-NULL and equal no target row's referenced
 *   columns; a row NULL at any referencing column references nothing; a target row NULL at a referenced column is
 *   referenced by none; ON UPDATE CASCADE carries a referenced row's new values into every row that referenced its old
 *   ones, inside the updating statement, whatever the key's deferral; a PERIOD foreign key refuses a row whose span the
 *   spans of the target rows equal at its scalars do not cover;
 * - a table CHECK refuses a row its predicate is false of (NULL passes);
 * - a contract's domain refuses a column value its CHECK is false of, at every level of a contract over a contract;
 * - a NOT DEFERRABLE constraint is checked at the end of the statement that writes it, and a DEFERRABLE INITIALLY
 *   DEFERRED one at COMMIT.
 *
 * Expressions (guards, terms, CHECK predicates, domain predicates) are evaluated by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts), a second implementation of the operator catalogue, so nothing here reads
 * the engine's own evaluation. A native kind this model does not evaluate (a closed relation's CHECK, a roster's
 * domain) refuses the installation, so a test never mistakes an unmodelled constraint for one that holds; a reverse
 * index constrains nothing.
 */

/**
 * A stored row: each field's value by its declared name, and each drawn law column's by its identifier, every column a
 * writer sends. None holds NULL.
 */
export type NativeRow = ReadonlyMap<string, CarrierValue>

/** A database state: each relation's rows by its declared name, as a multiset in no order; an absent relation is empty. */
export type NativeState = ReadonlyMap<string, ReadonlyArray<NativeRow>>

/** A column's value in a stored row: a value, or NULL, which only a generated law column holds outside its guard. */
type Cell = { readonly kind: "null" } | { readonly kind: "value"; readonly value: CarrierValue }

/** When PostgreSQL checks a constraint: at the end of the statement that writes its table, or at COMMIT. */
type Deferral = "immediate" | "deferred"

/** A column a constraint reads: a field of its table by name, or a law column the law model adds to it. */
type ColumnRead =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "law"; readonly column: ColumnIdent }

/**
 * What every constraint carries: the name its violation reports (a table constraint's identifier, or a domain's
 * contract, by which the installation names the domain), its owner, the laws it discharges and when it is checked.
 */
interface Named {
	readonly name: string
	readonly laws: NonEmptyReadonlyArray<LawId>
	readonly timing: Deferral
}

/** A constraint over one table: its relation and that relation's installed table. */
interface OnTable {
	readonly relation: string
	readonly owner: RelationIdent
}

/** A constraint as the model checks it. */
export type NativeConstraint = Named &
	(
		| (OnTable & {
				readonly kind: "PrimaryKey" | "Unique"
				readonly columns: NonEmptyReadonlyArray<ColumnRead>
		  })
		| (OnTable & {
				readonly kind: "WithoutOverlaps"
				readonly scalars: ReadonlyArray<ColumnRead>
				readonly span: ColumnRead
		  })
		| (OnTable & {
				readonly kind: "ForeignKey"
				readonly columns: NonEmptyReadonlyArray<ColumnRead>
				readonly target: string
				readonly targetColumns: NonEmptyReadonlyArray<ColumnRead>
				readonly onUpdate: "cascade" | "noAction"
		  })
		| (OnTable & {
				readonly kind: "PeriodForeignKey"
				readonly columns: ReadonlyArray<ColumnRead>
				readonly span: ColumnRead
				readonly target: string
				readonly targetColumns: ReadonlyArray<ColumnRead>
				readonly targetSpan: ColumnRead
		  })
		| (OnTable & { readonly kind: "TableCheck"; readonly predicate: ScalarExpr })
		| {
				readonly kind: "Domain"
				readonly owner: string
				/** The contract whose values the domain holds: every field typed by it, at any level, is checked. */
				readonly contract: string
				readonly terms: NonEmptyReadonlyArray<DomainCheckTerm>
		  }
	)

/** A generated law column of a relation: its identifier, and the guard and term it is generated from. */
interface GeneratedOf {
	readonly column: ColumnIdent
	readonly guard: ReadonlyArray<ScalarExpr>
	readonly term: ScalarExpr
}

/** A relation as the model stores it: its fields with their types, its drawn and its generated law columns. */
interface RelationOf {
	readonly name: string
	readonly fields: ReadonlyArray<LawField>
	readonly drawn: ReadonlySet<ColumnIdent>
	readonly generated: ReadonlyArray<GeneratedOf>
}

/** An installation as the model evaluates it: its relations and every constraint, each once. */
export interface NativeInstallation {
	readonly relations: ReadonlyMap<string, RelationOf>
	readonly constraints: ReadonlyArray<NativeConstraint>
}

/**
 * Why the model does not evaluate an installation: a native kind it has no semantics for, or a constraint PostgreSQL
 * refuses to create: a key that names a column twice (42701); a foreign key whose referenced columns repeat one, differ
 * in number from its own, or are no PRIMARY KEY's or UNIQUE's column set (42830); a cascade into a generated column
 * (42P17).
 */
export type Unevaluable =
	| { readonly kind: "native"; readonly native: NativeKind }
	| { readonly kind: "refused"; readonly constraint: string; readonly why: string }

/** One constraint a state breaks. */
export interface NativeViolation {
	readonly constraint: string
	readonly kind: NativeConstraint["kind"]
	/** The table or domain the constraint is scoped to, which a violation's report names beside the constraint. */
	readonly owner: string
	readonly laws: NonEmptyReadonlyArray<LawId>
	readonly timing: Deferral
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

/** The installation's constraints and law columns, or the first native the model has no semantics for. */
export const nativeInstallation = (
	model: LawModel
): Result.Result<NativeInstallation, Unevaluable> => {
	const fields = new Map<string, ReadonlyArray<LawField>>()
	const drawn = new Map<string, Set<ColumnIdent>>()
	const generatedColumns = new Map<string, Array<GeneratedOf>>()
	const constraints: Array<NativeConstraint> = []
	const place = (n: NamedNative): Option.Option<Unevaluable> => {
		switch (n.namespace) {
			case "constraint": {
				const o = n.object
				fields.set(o.relation.name, o.relation.fields)
				const on = {
					name: identifierOf(n.named),
					laws: o.lawIds,
					owner: n.owner,
					relation: o.relation.name
				}
				switch (o.kind) {
					case "PrimaryKey":
						constraints.push({
							...on,
							kind: "PrimaryKey",
							timing: "immediate",
							columns: Arr.map(o.columns, (f) => ({ kind: "field", field: f.name }))
						})
						return Option.none()
					case "Unique":
						constraints.push({
							...on,
							kind: "Unique",
							timing: "immediate",
							columns: columnReads(o.columns)
						})
						return Option.none()
					case "WithoutOverlaps":
						constraints.push({
							...on,
							kind: "WithoutOverlaps",
							timing: "immediate",
							scalars: Arr.map(o.key.scalars, columnRead),
							span: columnRead(o.span)
						})
						return Option.none()
					case "ForeignKey":
						fields.set(o.target.name, o.target.fields)
						constraints.push({
							...on,
							kind: "ForeignKey",
							timing: o.deferrable ? "deferred" : "immediate",
							columns: columnReads(o.columns),
							target: o.target.name,
							targetColumns: columnReads(o.targetColumns),
							onUpdate: o.onUpdate
						})
						return Option.none()
					case "PeriodForeignKey":
						fields.set(o.target.name, o.target.fields)
						constraints.push({
							...on,
							kind: "PeriodForeignKey",
							timing: o.deferrable ? "deferred" : "immediate",
							columns: Arr.map(o.columns, columnRead),
							span: columnRead(o.span),
							target: o.target.name,
							targetColumns: Arr.map(o.targetColumns, columnRead),
							targetSpan: columnRead(o.targetSpan)
						})
						return Option.none()
					case "TableCheck":
						constraints.push({
							...on,
							kind: "TableCheck",
							timing: "immediate",
							predicate: o.predicate
						})
						return Option.none()
					case "ClosedCheck":
						return Option.some({ kind: "native", native: o.kind })
				}
			}
			case "column": {
				const o = n.object
				const relation = o.relation.name
				fields.set(relation, o.relation.fields)
				if (o.value.kind === "drawn") {
					const of = drawn.get(relation) ?? new Set<ColumnIdent>()
					of.add(o.column)
					drawn.set(relation, of)
					return Option.none()
				}
				const of = generatedColumns.get(relation) ?? []
				of.push({ column: o.column, guard: o.value.guard, term: o.value.term })
				generatedColumns.set(relation, of)
				return Option.none()
			}
			case "domain": {
				const o = n.object
				if (o.check.kind === "checked") {
					constraints.push({
						kind: "Domain",
						name: o.name,
						owner: o.name,
						laws: o.lawIds,
						timing: "immediate",
						contract: o.name,
						terms: o.check.terms
					})
				}
				return Option.none()
			}
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
			{
				name,
				fields: of,
				drawn: drawn.get(name) ?? new Set<ColumnIdent>(),
				generated: generatedColumns.get(name) ?? []
			}
		])
	)
	const refused = Arr.findFirst(constraints, (c) => refusalOf(relations, constraints, c))
	return Option.isSome(refused)
		? Result.fail(refused.value)
		: Result.succeed({ relations, constraints })
}

const readKey = (c: ColumnRead): string =>
	c.kind === "field" ? `field ${c.field}` : `law ${c.column}`

/** Whether a column list names a column twice. */
const repeats = (columns: ReadonlyArray<ColumnRead>): boolean =>
	new Set(Arr.map(columns, readKey)).size !== columns.length

/** Whether two column lists name one set of columns, in any order. */
const sameColumns = (a: ReadonlyArray<ColumnRead>, b: ReadonlyArray<ColumnRead>): boolean => {
	const of = new Set(Arr.map(a, readKey))
	return a.length === b.length && Arr.every(b, (c) => of.has(readKey(c)))
}

/** The relation a table constraint is on; a domain is on none. */
const tableOf = (c: NativeConstraint): string | undefined =>
	c.kind === "Domain" ? undefined : c.relation

/** The columns of a key in its index: a key's columns, a span key's scalars then its span. */
const keyColumns = (k: NativeConstraint): ReadonlyArray<ColumnRead> | undefined => {
	switch (k.kind) {
		case "PrimaryKey":
		case "Unique":
			return k.columns
		case "WithoutOverlaps":
			return [...k.scalars, k.span]
		case "ForeignKey":
		case "PeriodForeignKey":
		case "TableCheck":
		case "Domain":
			return undefined
	}
}

/**
 * The refusal PostgreSQL gives a constraint's creation, if any: a key naming a column twice (42701); a foreign key whose
 * referenced columns repeat one or differ in number from its own, or that no key of its target holds as its column set
 * (42830); an ON UPDATE CASCADE whose referencing columns include a generated column (42P17). Every key the model reads
 * is NOT DEFERRABLE, which a referenced key must be.
 */
const refusalOf = (
	relations: ReadonlyMap<string, RelationOf>,
	constraints: ReadonlyArray<NativeConstraint>,
	c: NativeConstraint
): Option.Option<Unevaluable> => {
	const refused = (why: string): Option.Option<Unevaluable> =>
		Option.some({ kind: "refused", constraint: c.name, why })
	const keyed = (target: string, columns: ReadonlyArray<ColumnRead>) =>
		Arr.some(constraints, (k) => {
			const of = keyColumns(k)
			return of !== undefined && tableOf(k) === target && sameColumns(of, columns)
		})
	switch (c.kind) {
		case "PrimaryKey":
		case "Unique":
		case "WithoutOverlaps": {
			const of = keyColumns(c) ?? []
			return repeats(of) ? refused("a key names a column twice") : Option.none()
		}
		case "ForeignKey": {
			if (repeats(c.targetColumns) || c.columns.length !== c.targetColumns.length) {
				return refused(
					"a foreign key's referenced columns repeat one or differ in number from its own"
				)
			}
			const generatedColumns = new Set(
				Arr.map(relations.get(c.relation)?.generated ?? [], (g) => g.column)
			)
			if (
				c.onUpdate === "cascade" &&
				Arr.some(c.columns, (col) => col.kind === "law" && generatedColumns.has(col.column))
			) {
				return refused("a cascade writes a generated column")
			}
			return keyed(c.target, c.targetColumns)
				? Option.none()
				: refused("no key of the target holds the referenced columns")
		}
		case "PeriodForeignKey": {
			const referenced = [...c.targetColumns, c.targetSpan]
			if (repeats(referenced) || c.columns.length !== c.targetColumns.length) {
				return refused(
					"a PERIOD foreign key's referenced columns repeat one or differ in number from its own"
				)
			}
			return keyed(c.target, referenced)
				? Option.none()
				: refused("no key of the target holds the referenced columns")
		}
		case "TableCheck":
		case "Domain":
			return Option.none()
	}
}

/** The relation's record, which every relation a constraint names has. */
const relationOf = (installation: NativeInstallation, name: string): RelationOf => {
	const found = installation.relations.get(name)
	if (found === undefined) {
		throw new Error(`the installation holds no relation ${name}`)
	}
	return found
}

/** A row's columns, for the reference evaluator to read by name: a field by its name, a drawn column by its identifier. */
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

/** A stored row with its generated law columns, each its term where its guard holds. */
interface Generated {
	readonly row: NativeRow
	readonly generated: ReadonlyMap<ColumnIdent, Cell>
}

const generated = (relation: RelationOf, row: NativeRow): Generated => {
	const env = rowEnv(row)
	return {
		row,
		generated: new Map(
			Arr.map(relation.generated, (c): readonly [ColumnIdent, Cell] => [
				c.column,
				Arr.every(c.guard, (g) => holdsOver(g, env, `the guard of ${c.column}`))
					? { kind: "value", value: valueOver(c.term, env, `the term of ${c.column}`) }
					: { kind: "null" }
			])
		)
	}
}

/** A column's value in a generated row: a generated column's cell, or a written column, a field or a drawn one. */
const cellOf = (g: Generated, c: ColumnRead): Cell => {
	if (c.kind === "law") {
		const cell = g.generated.get(c.column)
		if (cell !== undefined) {
			return cell
		}
	}
	const name = c.kind === "field" ? c.field : c.column
	const v = g.row.get(name)
	if (v === undefined) {
		throw new Error(`a row without its column ${name}`)
	}
	return { kind: "value", value: v }
}

/** A span's endpoints: the carrier a range column holds. */
interface SpanValue {
	readonly start: bigint
	readonly end: bigint
}

const spanOf = (v: CarrierValue): SpanValue => {
	if (typeof v === "object" && "start" in v) {
		return v
	}
	throw new Error("a span column holds a value that is no range")
}

/**
 * A value's identity under PostgreSQL's equality on the carriers the model evaluates, integers, booleans, text, UUIDs
 * and integer ranges, which compare by value: its kind, then its atoms, a range's two ends, so the atoms of several
 * values in a row are self-delimiting (kernel/identity.ts). Any other carrier is a defect of the test that wrote it.
 */
const valueAtoms = (v: CarrierValue): ValueIdentity => {
	if (typeof v === "bigint") {
		return ["i", v]
	}
	if (typeof v === "boolean") {
		return ["b", v]
	}
	if (typeof v === "string") {
		return ["s", v]
	}
	if (typeof v === "object" && "start" in v) {
		return ["r", v.start, v.end]
	}
	throw new Error("the native model compares integers, booleans, text, UUIDs and ranges only")
}

/**
 * The columns' values as one key, each value's atoms in column order, or none when one of them is NULL: such a row is
 * outside every key and reference.
 */
const keyOf = (g: Generated, columns: ReadonlyArray<ColumnRead>): Option.Option<ValueIdentity> => {
	const parts: Array<Atom> = []
	for (const c of columns) {
		const cell = cellOf(g, c)
		if (cell.kind === "null") {
			return Option.none()
		}
		appendAll(parts, valueAtoms(cell.value))
	}
	return Option.some(parts)
}

/** Whether two rows' keys are one key, neither NULL anywhere. */
const sameKey = (a: Option.Option<ValueIdentity>, b: Option.Option<ValueIdentity>): boolean =>
	Option.isSome(a) && Option.isSome(b) && sameIdentity(a.value, b.value)

/** A column's span, or none where it is NULL. */
const spanAt = (g: Generated, c: ColumnRead): Option.Option<SpanValue> => {
	const cell = cellOf(g, c)
	return cell.kind === "null" ? Option.none() : Option.some(spanOf(cell.value))
}

const overlap = (a: SpanValue, b: SpanValue): boolean => a.start < b.end && b.start < a.end

/** Whether the union of `spans` covers `s`, which an empty span is by every union. */
const covered = (s: SpanValue, spans: ReadonlyArray<SpanValue>): boolean => {
	let reached = s.start
	for (const t of Arr.sort(spans, (a: SpanValue, b: SpanValue) =>
		a.start < b.start ? -1 : a.start > b.start ? 1 : 0
	)) {
		if (reached >= s.end) {
			return true
		}
		if (t.start > reached) {
			return false
		}
		if (t.end > reached) {
			reached = t.end
		}
	}
	return reached >= s.end
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

/** The rows of a relation in a state, each with its generated law columns. */
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

/** Every pair of rows `same` holds equal, by their places, the first earlier. */
const pairsOf = (
	relation: string,
	rows: ReadonlyArray<Generated>,
	same: (a: Generated, b: Generated) => boolean
): ReadonlyArray<Duplicate> =>
	Arr.flatMap(rows, (b, second) =>
		Arr.flatMap(rows.slice(0, second), (a, first) =>
			same(a, b) ? [{ relation, first, second }] : []
		)
	)

/** Whether a constraint holds of a state, every relation's law columns generated. */
const checkIn = (
	installation: NativeInstallation,
	rows: (relation: string) => ReadonlyArray<Generated>,
	c: NativeConstraint
): Checked => {
	switch (c.kind) {
		case "PrimaryKey":
		case "Unique": {
			const duplicates = pairsOf(c.relation, rows(c.relation), (a, b) =>
				sameKey(keyOf(a, c.columns), keyOf(b, c.columns))
			)
			return duplicates.length === 0 ? holds : { kind: "broken", duplicates }
		}
		case "WithoutOverlaps": {
			const of = rows(c.relation)
			const empty = Arr.some(of, (g) =>
				Option.match(spanAt(g, c.span), { onNone: () => false, onSome: (s) => s.start >= s.end })
			)
			const duplicates = pairsOf(c.relation, of, (a, b) => {
				const [x, y] = [spanAt(a, c.span), spanAt(b, c.span)]
				return (
					sameKey(keyOf(a, c.scalars), keyOf(b, c.scalars)) &&
					Option.isSome(x) &&
					Option.isSome(y) &&
					overlap(x.value, y.value)
				)
			})
			return duplicates.length === 0 && !empty ? holds : { kind: "broken", duplicates }
		}
		case "ForeignKey": {
			const referenced = new TupleSet<ValueIdentity>()
			for (const g of rows(c.target)) {
				const k = keyOf(g, c.targetColumns)
				if (Option.isSome(k)) {
					referenced.add(k.value)
				}
			}
			return brokenIf(
				!Arr.every(rows(c.relation), (g) =>
					Option.match(keyOf(g, c.columns), {
						onNone: () => true,
						onSome: (k) => referenced.has(k)
					})
				)
			)
		}
		case "PeriodForeignKey": {
			const targets = rows(c.target)
			return brokenIf(
				!Arr.every(rows(c.relation), (g) => {
					const k = keyOf(g, c.columns)
					const s = spanAt(g, c.span)
					if (Option.isNone(k) || Option.isNone(s)) {
						return true
					}
					const spans = Arr.flatMap(targets, (t) => {
						const at = keyOf(t, c.targetColumns)
						return Option.isSome(at) && sameIdentity(at.value, k.value)
							? Option.toArray(spanAt(t, c.targetSpan))
							: []
					})
					return covered(s.value, spans)
				})
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
	timings: ReadonlyArray<Deferral>
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
		: b.kind === "value" && sameIdentity(valueAtoms(a.value), valueAtoms(b.value))

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
 * Columns' values a statement matches rows by: a row matches when it holds each listed value at its column, every
 * other column free.
 */
export type NativeMatch = ReadonlyMap<string, CarrierValue>

/**
 * One statement of a transaction over one table: an INSERT of its rows; a DELETE of every row a match holds of; or an
 * UPDATE that sets columns of every row its match holds of, a referenced row's new values cascading into the rows that
 * referenced its old ones through each ON UPDATE CASCADE key, within the statement.
 */
export type NativeStatement =
	| { readonly kind: "insert"; readonly relation: string; readonly rows: ReadonlyArray<NativeRow> }
	| {
			readonly kind: "delete"
			readonly relation: string
			readonly where: ReadonlyArray<NativeMatch>
	  }
	| {
			readonly kind: "update"
			readonly relation: string
			readonly where: NativeMatch
			readonly set: NativeMatch
	  }

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

const matches = (row: NativeRow, match: NativeMatch): boolean =>
	Arr.every([...match], ([column, v]) => {
		const held = row.get(column)
		return held !== undefined && sameIdentity(valueAtoms(held), valueAtoms(v))
	})

/** A row with the given columns set. */
const withSet = (row: NativeRow, set: NativeMatch): NativeRow => new Map([...row, ...set])

/** The written column a referencing column is: a field by its name, a drawn column by its identifier. */
const writtenName = (c: ColumnRead): string => (c.kind === "field" ? c.field : c.column)

/**
 * The state an UPDATE leaves: its rows set, and each update cascaded through every ON UPDATE CASCADE key into the rows
 * that referenced the updated row's old values, and from those rows on.
 */
const updated = (
	installation: NativeInstallation,
	state: NativeState,
	relation: string,
	where: (row: NativeRow) => boolean,
	set: (row: NativeRow) => NativeRow
): NativeState => {
	const next = new Map(state)
	const of = relationOf(installation, relation)
	const changes: Array<readonly [Generated, Generated]> = []
	next.set(
		relation,
		Arr.map(state.get(relation) ?? [], (row) => {
			if (!where(row)) {
				return row
			}
			const after = set(row)
			changes.push([generated(of, row), generated(of, after)])
			return after
		})
	)
	let cascaded: NativeState = next
	for (const c of installation.constraints) {
		if (c.kind !== "ForeignKey" || c.onUpdate !== "cascade" || c.target !== relation) {
			continue
		}
		for (const [before, after] of changes) {
			const old = keyOf(before, c.targetColumns)
			const now = keyOf(after, c.targetColumns)
			if (Option.isNone(old) || (Option.isSome(now) && sameIdentity(now.value, old.value))) {
				continue
			}
			const values = Arr.map(c.targetColumns, (t) => cellOf(after, t))
			const source = relationOf(installation, c.relation)
			cascaded = updated(
				installation,
				cascaded,
				c.relation,
				(row) =>
					Option.exists(keyOf(generated(source, row), c.columns), (k) =>
						sameIdentity(k, old.value)
					),
				(row) =>
					withSet(
						row,
						new Map(
							Arr.map(c.columns, (column, i) => {
								const cell = values[i]
								if (cell === undefined || cell.kind === "null") {
									throw new Error(`a cascade of ${c.name} sets a referencing column to NULL`)
								}
								return [writtenName(column), cell.value] as const
							})
						)
					)
			)
		}
	}
	return cascaded
}

const appliedTo = (
	installation: NativeInstallation,
	state: NativeState,
	statement: NativeStatement
): NativeState => {
	const current = state.get(statement.relation) ?? []
	switch (statement.kind) {
		case "insert": {
			const next = new Map(state)
			next.set(statement.relation, [...current, ...statement.rows])
			return next
		}
		case "delete": {
			const next = new Map(state)
			next.set(
				statement.relation,
				Arr.filter(current, (row) => !Arr.some(statement.where, (m) => matches(row, m)))
			)
			return next
		}
		case "update":
			return updated(
				installation,
				state,
				statement.relation,
				(row) => matches(row, statement.where),
				(row) => withSet(row, statement.set)
			)
	}
}

/**
 * A transaction from a committed state: each statement applied in order, its cascades within it, the immediate
 * constraints checked at its end, and the deferred ones at COMMIT. Its verdict is the first point where a constraint
 * checked there is broken, with every constraint broken there, or the state its statements leave.
 */
export const transact = (
	installation: NativeInstallation,
	before: NativeState,
	statements: ReadonlyArray<NativeStatement>
): TransactionVerdict => {
	let state = before
	for (const [index, statement] of statements.entries()) {
		state = appliedTo(installation, state, statement)
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
		(c.kind === "ForeignKey" || c.kind === "PeriodForeignKey") &&
		c.timing === "immediate" &&
		c.relation !== c.target
			? [{ from: c.relation, to: c.target }]
			: []
	)
