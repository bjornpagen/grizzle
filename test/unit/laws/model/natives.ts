import { Array as Arr, Option, Order, Result } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { ColumnIdent, LawId } from "#compiler/core/ids.ts"
import * as EngineResult from "#compiler/core/result.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { AxisKind, Family } from "#compiler/ir/family.ts"
import type { Drawn, LawRelation, NativeColumn, NativeObject, NativeOf } from "#compiler/ir/law.ts"
import { compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { own } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { type SqlStatement, type TableConstraint, tableConstraints } from "#compiler/sql/ast.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { decodedSchema, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { declinedOps, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"

/**
 * What the law model's unit boxes read of a compiled schema: its natives by structure, each column by what it is, and
 * the value of a generated CHECK or law column on a row, by the reference evaluator (test/support/oracle/evaluate), a
 * second implementation of the operator catalogue, never the engine's own.
 */

/** A schema description's law model, or the refusal the owner or the law model gives it. */
export const compiledModel = (desc: SchemaDesc): EngineResult.Result<LawModel, CompileError> =>
	EngineResult.flatMap(own(decodedSchema(desc)), (owned) => compileLaws(owned, everySlice(owned)))

/** A schema description's law model, which must compile. */
export const modelOf = (desc: SchemaDesc): LawModel => succeeded(compiledModel(desc))

/** Every native object of the model, once each. */
export const nativesOf = (model: LawModel): ReadonlyArray<NativeObject> =>
	Arr.map(model.natives, (n) => n.object)

/** The natives of one kind on one relation. */
export const onRelation = <
	K extends "Unique" | "ForeignKey" | "TableCheck" | "LawColumn" | "ReverseIndex"
>(
	model: LawModel,
	kind: K,
	relation: string
): ReadonlyArray<NativeOf<K>> =>
	Arr.filter(
		nativesOf(model),
		(o): o is NativeOf<K> => o.kind === kind && "relation" in o && o.relation.name === relation
	)

/** The law column natives of a relation, by identifier. */
export const lawColumnsOf = (
	model: LawModel,
	relation: string
): ReadonlyMap<ColumnIdent, NativeOf<"LawColumn">> =>
	new Map(Arr.map(onRelation(model, "LawColumn", relation), (c) => [c.column, c] as const))

/** What a drawn column draws, as text: its kind, and a fold's position and plane. */
const drawnText = (d: Drawn): string =>
	d.kind === "before" || d.kind === "after" ? `${d.kind} ${d.fold}.${d.plane}` : d.kind

/**
 * A column of a native by what it is: a field by its name, a drawn law column by what it draws, a generated one by the
 * field whose values it holds. Every law column a native reads is a native of its relation.
 */
export const columnText = (model: LawModel, relation: LawRelation, c: NativeColumn): string => {
	if (c.kind === "field") {
		return c.field.name
	}
	const native = defined(
		lawColumnsOf(model, relation.name).get(c.column),
		`the law column ${c.column} a native reads is a native of ${relation.name}`
	)
	return native.value.kind === "drawn"
		? `‹${drawnText(native.value.draws)}›`
		: `‹generated ${native.field.name}›`
}

/** A foreign key as its contract reads it: its relations, its pairs of referencing and referenced columns as a set,
 * its update action and its deferral. */
export interface ForeignKeyShape {
	readonly from: string
	readonly to: string
	readonly pairs: ReadonlyArray<string>
	readonly onUpdate: "cascade" | "noAction"
	readonly deferrable: boolean
}

/** Each pair of a foreign key's columns, `from → to`, in sorted order: its order is no part of its contract. */
const pairsOf = (model: LawModel, fk: NativeOf<"ForeignKey">): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(
			Arr.zip(fk.columns, fk.targetColumns),
			([a, b]) => `${columnText(model, fk.relation, a)} → ${columnText(model, fk.target, b)}`
		),
		Order.String
	)

const foreignKeyShape = (model: LawModel, fk: NativeOf<"ForeignKey">): ForeignKeyShape => ({
	from: fk.relation.name,
	to: fk.target.name,
	pairs: pairsOf(model, fk),
	onUpdate: fk.onUpdate,
	deferrable: fk.deferrable
})

/** The order foreign key shapes are compared in: by their relations, then their pairs. */
export const foreignKeyOrder: Order.Order<ForeignKeyShape> = Order.mapInput(
	Order.String,
	(fk: ForeignKeyShape) => `${fk.from} ${fk.to} ${Arr.join(fk.pairs, ";")}`
)

/** Every foreign key of the model as its contract reads it, sorted. */
export const foreignKeyShapes = (model: LawModel): ReadonlyArray<ForeignKeyShape> =>
	Arr.sort(
		Arr.map(
			Arr.filter(nativesOf(model), (o): o is NativeOf<"ForeignKey"> => o.kind === "ForeignKey"),
			(fk) => foreignKeyShape(model, fk)
		),
		foreignKeyOrder
	)

/** A key's columns as a sorted set. */
const columnSet = (
	model: LawModel,
	relation: LawRelation,
	columns: ReadonlyArray<NativeColumn>
): string =>
	Arr.join(
		Arr.sort(
			Arr.map(columns, (c) => columnText(model, relation, c)),
			Order.String
		),
		", "
	)

/** Every UNIQUE and PRIMARY KEY of a relation, each as its sorted column set. */
export const keySets = (model: LawModel, relation: string): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(nativesOf(model), (o): ReadonlyArray<string> => {
			if (o.kind === "Unique" && o.relation.name === relation) {
				return [columnSet(model, o.relation, o.columns)]
			}
			if (o.kind === "PrimaryKey" && o.relation.name === relation) {
				return [
					columnSet(
						model,
						o.relation,
						Arr.map(o.columns, (field) => ({ kind: "field" as const, field }))
					)
				]
			}
			return []
		}),
		Order.String
	)

/** The law a statement of the given detail kind states over the family `family`. */
export const familyLaw = (model: LawModel, family: Family["id"]): LawId =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				model.theory.laws,
				(l) =>
					(l.detail.kind === "family" || l.detail.kind === "tree") &&
					l.detail.family.id.owner === family.owner &&
					l.detail.family.id.count === family.count
			)
		),
		`the law of the family ${family.owner}.${family.count}`
	).id

/** The laws of every fold over the family, by their position among its folds. */
export const foldLaws = (model: LawModel): ReadonlyArray<LawId> =>
	Arr.flatMap(model.theory.laws, (l) => (l.detail.kind === "fold" ? [l.id] : []))

/** The containment laws that ride `axis`, by the theory's resolution. */
export const ridingLaws = (model: LawModel, axis: AxisKind): ReadonlyArray<LawId> =>
	Arr.flatMap(model.theory.laws, (l) =>
		l.detail.kind === "containment" &&
		l.detail.lowers.kind === "rides" &&
		l.detail.lowers.axis === axis
			? [l.id]
			: []
	)

/** The native objects that discharge a law: each whose law list names it. */
export const loweringOf = (model: LawModel, law: LawId): ReadonlyArray<NativeObject> =>
	Arr.map(
		Arr.filter(model.natives, (n) => Arr.contains(n.object.lawIds, law)),
		(n) => n.object
	)

/** The generated CHECKs a law installs on a relation: at most one. */
export const checksOf = (
	model: LawModel,
	relation: string,
	law: LawId
): ReadonlyArray<NativeOf<"TableCheck">> =>
	Arr.filter(
		onRelation(model, "TableCheck", relation),
		(c) => c.check.kind === "generated" && c.check.law === law
	)

/** A row's values, each field by its name and each drawn law column by its identifier. */
export type Row = ReadonlyMap<string, CarrierValue>

/** Whether an expression holds a node the reference evaluator declines by design: a set's algebra, which it leaves to
 * PostgreSQL. */
const declines = (e: ScalarExpr): boolean =>
	(e.kind === "op" && declinedOps.has(e.op)) || Arr.some(e.args, declines)

const isSet = (v: CarrierValue | undefined): v is ReadonlySet<string> => v instanceof Set

const sameValue = (a: CarrierValue, b: CarrierValue): boolean =>
	isSet(a) && isSet(b) ? a.size === b.size && Arr.every([...a], (x) => b.has(x)) : a === b

/**
 * An expression's value over a row, or undefined for NULL. A subtree with no declined node is the reference
 * evaluator's; a node over a set's algebra is this second implementation's, a set of handles each: union and
 * intersection as sets, equality as set equality, and the connectives over three values.
 */
const valueOn = (expr: ScalarExpr, row: Row): CarrierValue | undefined => {
	if (!declines(expr)) {
		return referenceValue(expr, row)
	}
	const args = Arr.map(expr.args, (a) => valueOn(a, row))
	if (expr.kind === "cast" || expr.kind === "domainCast") {
		return args[0]
	}
	if (expr.kind !== "op") {
		return assert.fail(`a set's node the test evaluates; ${expr.kind} is none`)
	}
	const fn = defined(nativeOp(expr.op), "a native operator").fn
	const node = setNodes[fn]
	return node === undefined
		? assert.fail(`a set's node the test evaluates; ${fn} is none`)
		: node(args)
}

const asSet = (v: CarrierValue | undefined): ReadonlySet<string> =>
	isSet(v) ? v : assert.fail("a set operand")

/** The nodes over a set's algebra this second implementation evaluates, each over its operands' values. */
const setNodes: Readonly<
	Record<string, (args: ReadonlyArray<CarrierValue | undefined>) => CarrierValue | undefined>
> = {
	union: ([a, b]) => new Set([...asSet(a), ...asSet(b)]),
	intersection: ([a, b]) => new Set(Arr.filter([...asSet(a)], (x) => asSet(b).has(x))),
	difference: ([a, b]) => new Set(Arr.filter([...asSet(a)], (x) => !asSet(b).has(x))),
	eq: ([a, b]) => (a === undefined || b === undefined ? undefined : sameValue(a, b)),
	ne: ([a, b]) => (a === undefined || b === undefined ? undefined : !sameValue(a, b)),
	and: (args) =>
		Arr.some(args, (v) => v === false)
			? false
			: Arr.every(args, (v) => v === true)
				? true
				: undefined,
	or: (args) =>
		Arr.some(args, (v) => v === true)
			? true
			: Arr.every(args, (v) => v === false)
				? false
				: undefined,
	not: ([a]) => (a === undefined ? undefined : a === false)
}

/** An expression's value over a row by the reference evaluator, or undefined for NULL; any other stop is a defect of
 * the test's row. */
const referenceValue = (expr: ScalarExpr, row: Row): CarrierValue | undefined => {
	const v = evaluate(expr, {
		kind: "row",
		column: (ref) =>
			row.has(ref.name)
				? row.get(ref.name)
				: assert.fail(`the row holds the column ${ref.name} the expression reads`),
		param: () => undefined,
		regexMember: patternMember
	})
	if (Result.isFailure(v)) {
		return v.failure.kind === "undefined"
			? undefined
			: assert.fail(`the row evaluates: ${v.failure.kind}`)
	}
	return v.success
}

/** Whether PostgreSQL's CHECK accepts a row: its predicate is not false. */
export const accepts = (check: NativeOf<"TableCheck">, row: Row): boolean =>
	valueOn(check.predicate, row) !== false

/** A generated law column's value on a row: its term where every conjunct of its guard holds, and NULL elsewhere. */
export const generatedOn = (column: NativeOf<"LawColumn">, row: Row): CarrierValue | undefined => {
	const value = column.value
	if (value.kind !== "generated") {
		return assert.fail(`the law column ${column.column} is generated`)
	}
	return Arr.every(value.guard, (g) => valueOn(g, row) === true)
		? valueOn(value.term, row)
		: undefined
}

/** The identifier of the one law column of a relation that draws `kind`. */
export const drawnColumn = (model: LawModel, relation: string, text: string): ColumnIdent =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				[...lawColumnsOf(model, relation).values()],
				(c) => c.value.kind === "drawn" && drawnText(c.value.draws) === text
			)
		),
		`the drawn ${text} of ${relation}`
	).column

/** The one generated law column of a relation holding `field`'s values. */
export const generatedColumn = (
	model: LawModel,
	relation: string,
	field: string
): NativeOf<"LawColumn"> => {
	const found = Arr.filter(
		[...lawColumnsOf(model, relation).values()],
		(c) => c.value.kind === "generated" && c.field.name === field
	)
	assert.equal(found.length, 1, `one generated law column of ${relation} holds ${field}`)
	return defined(found[0])
}

/**
 * The installation's natives are well formed, as PostgreSQL would create them: every law column a constraint reads, a
 * span key's and a PERIOD reference's included, is a native of its table; every foreign key pairs as many columns on
 * each side, references no column twice, and references a PRIMARY KEY or UNIQUE whose column set is exactly its
 * referenced columns; and every key names each column once.
 */
export const assertWellFormed = (model: LawModel): void => {
	const natives = nativesOf(model)
	for (const o of natives) {
		switch (o.kind) {
			case "Unique":
			case "ReverseIndex": {
				const set = Arr.map(o.columns, (c) => columnText(model, o.relation, c))
				assert.equal(
					new Set(set).size,
					set.length,
					`a key of ${o.relation.name} names each column once`
				)
				break
			}
			case "ForeignKey": {
				assert.equal(o.columns.length, o.targetColumns.length, "a reference pairs its columns")
				const target = Arr.map(o.targetColumns, (c) => columnText(model, o.target, c))
				assert.equal(
					new Set(target).size,
					target.length,
					"a reference names each referenced column once"
				)
				for (const c of o.columns) {
					columnText(model, o.relation, c)
				}
				const set = columnSet(model, o.target, o.targetColumns)
				assert.ok(
					Arr.contains(keySets(model, o.target.name), set),
					`a key of ${o.target.name} over exactly (${set})`
				)
				break
			}
			case "WithoutOverlaps":
				for (const c of [o.span, ...o.key.scalars]) {
					columnText(model, o.relation, c)
				}
				break
			case "PeriodForeignKey":
				for (const c of [o.span, ...o.columns]) {
					columnText(model, o.relation, c)
				}
				for (const c of [o.targetSpan, ...o.targetColumns]) {
					columnText(model, o.target, c)
				}
				break
			case "PrimaryKey":
			case "Domain":
			case "TableCheck":
			case "RosterDomain":
			case "ClosedCheck":
			case "LawColumn":
				break
		}
	}
}

/** A database state: each relation's rows, each field by its name and each drawn law column by its identifier. */
export type State = ReadonlyMap<string, ReadonlyArray<Row>>

/** A column's value on a row: a field's or a drawn column's as the row holds it, a generated column's from the row. */
const cellOf = (
	model: LawModel,
	relation: string,
	c: NativeColumn,
	row: Row
): CarrierValue | undefined => {
	if (c.kind === "field") {
		return row.has(c.field.name)
			? row.get(c.field.name)
			: assert.fail(`the row holds ${relation}.${c.field.name}`)
	}
	const native = defined(
		lawColumnsOf(model, relation).get(c.column),
		`the law column ${c.column} of ${relation}`
	)
	return native.value.kind === "drawn"
		? row.has(c.column)
			? row.get(c.column)
			: assert.fail(`the row holds the drawn ${drawnText(native.value.draws)} of ${relation}`)
		: generatedOn(native, row)
}

/** A row's tuple over columns, or undefined when one is NULL: such a row is outside a key and references nothing. */
const tupleOf = (
	model: LawModel,
	relation: string,
	columns: ReadonlyArray<NativeColumn>,
	row: Row
): ReadonlyArray<CarrierValue> | undefined => {
	const cells: Array<CarrierValue> = []
	for (const c of columns) {
		const v = cellOf(model, relation, c, row)
		if (v === undefined) {
			return undefined
		}
		cells.push(v)
	}
	return cells
}

const sameTuple = (a: ReadonlyArray<CarrierValue>, b: ReadonlyArray<CarrierValue>): boolean =>
	a.length === b.length && Arr.every(a, (v, i) => sameValue(v, defined(b[i])))

/**
 * The natives a state breaks, by PostgreSQL's semantics: a PRIMARY KEY or UNIQUE NULLS DISTINCT, two rows equal at
 * every column, none NULL; a FOREIGN KEY MATCH SIMPLE, a row with no NULL column whose tuple no target row holds; a
 * CHECK, a row its predicate is false of. A native kind with no semantics here (a span key, a PERIOD reference, a
 * closed CHECK) refuses the state, so no test mistakes an unmodelled native for one that holds.
 */
export const brokenBy = (model: LawModel, state: State): ReadonlyArray<NativeObject> =>
	Arr.filter(nativesOf(model), (o) => breaks(model, o, state))

/** Whether a state breaks one native (`brokenBy`). */
export const breaks = (model: LawModel, o: NativeObject, state: State): boolean => {
	const rows = (relation: string): ReadonlyArray<Row> => state.get(relation) ?? []
	switch (o.kind) {
		case "PrimaryKey":
		case "Unique": {
			const columns: ReadonlyArray<NativeColumn> =
				o.kind === "PrimaryKey"
					? Arr.map(o.columns, (field) => ({ kind: "field" as const, field }))
					: o.columns
			const tuples = Arr.flatMap(rows(o.relation.name), (r) => {
				const t = tupleOf(model, o.relation.name, columns, r)
				return t === undefined ? [] : [t]
			})
			return Arr.some(tuples, (t, i) => Arr.some(tuples, (u, j) => j > i && sameTuple(t, u)))
		}
		case "ForeignKey": {
			const targets = Arr.flatMap(rows(o.target.name), (r) => {
				const t = tupleOf(model, o.target.name, o.targetColumns, r)
				return t === undefined ? [] : [t]
			})
			return Arr.some(rows(o.relation.name), (r) => {
				const t = tupleOf(model, o.relation.name, o.columns, r)
				return t !== undefined && !Arr.some(targets, (u) => sameTuple(t, u))
			})
		}
		case "TableCheck":
			return Arr.some(rows(o.relation.name), (r) => !accepts(o, r))
		case "LawColumn":
		case "ReverseIndex":
		case "Domain":
		case "RosterDomain":
			return false
		case "WithoutOverlaps":
		case "PeriodForeignKey":
		case "ClosedCheck":
			return assert.fail(`a native the test evaluates; ${o.kind} is none`)
	}
}

/** Whether PostgreSQL checks a native at the end of the statement that writes it, rather than at COMMIT. */
export const immediate = (o: NativeObject): boolean => !(o.kind === "ForeignKey" && o.deferrable)

/**
 * An installation's statements hold every column before a constraint names it, as PostgreSQL requires (42703): each
 * key, exclusion constraint and foreign key names only columns its table, and the table it references, hold by then,
 * from its CREATE TABLE or an earlier ALTER TABLE ... ADD COLUMN, a law column's among them.
 */
export const assertColumnsBeforeConstraints = (statements: ReadonlyArray<SqlStatement>): void => {
	const columns = new Map<string, Set<string>>()
	const tableKey = (name: { readonly schema: string; readonly name: string }): string =>
		`${name.schema}.${name.name}`
	const holds = (table: string, names: ReadonlyArray<string>, what: string): void => {
		const own = columns.get(table) ?? new Set<string>()
		for (const c of names) {
			assert.ok(own.has(c), `${what} names ${table}.${c} after its table holds it`)
		}
	}
	const constrain = (table: string, c: TableConstraint): void => {
		switch (c.kind) {
			case "primaryKey":
			case "unique":
				holds(
					table,
					Arr.map(c.columns, (k) => k.column),
					`the key ${c.name}`
				)
				return
			case "exclude":
				holds(
					table,
					Arr.map(c.elements, (e) => e.column),
					`the exclusion constraint ${c.name}`
				)
				return
			case "foreignKey":
				holds(
					table,
					Arr.map(c.columns, (k) => k.column),
					`the foreign key ${c.name}`
				)
				holds(
					tableKey(c.references),
					Arr.map(c.referencedColumns, (k) => k.column),
					`the foreign key ${c.name}`
				)
				return
			case "check":
				return
		}
	}
	for (const s of statements) {
		if (s.kind === "createTable") {
			const table = tableKey(s.table)
			columns.set(table, new Set(Arr.map(s.columns, (c) => c.name)))
			for (const c of tableConstraints(s)) {
				constrain(table, c)
			}
		}
		if (s.kind === "alterTable") {
			const table = tableKey(s.table)
			for (const a of s.actions) {
				if (
					a.kind === "addColumn" ||
					a.kind === "addColumnPlaceholder" ||
					a.kind === "addColumnDefault"
				) {
					const own = columns.get(table) ?? new Set<string>()
					own.add(a.column.name)
					columns.set(table, own)
				}
				if (a.kind === "addConstraint") {
					constrain(table, a.constraint)
				}
			}
		}
	}
}
