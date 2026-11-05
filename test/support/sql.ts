import { Array as Arr, Order } from "effect"
import type { FlightStatement } from "#adapter/wire/batch.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { CompileBound } from "#compiler/core/errors.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import * as EngineResult from "#compiler/core/result.ts"
import {
	bitText,
	cellWidth,
	constantOf,
	type KeyCollision,
	type Layout,
	spaceSize
} from "#compiler/ir/cells.ts"
import type { ColumnDef, EmittedText, ObjectName, TypeRef, TypeSchema } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import {
	applied,
	type ConstantDomainCheck,
	type ConstantExpr,
	column,
	domainValue,
	inSet,
	keyIn,
	mixedRadix,
	packCell,
	printConstantExpr,
	printConstantStatement,
	repoint,
	unpackCell
} from "#compiler/sql/constants.ts"
import { printObjectName, printStatement, printType, quoteIdent } from "#compiler/sql/print.ts"
import { nonEmpty } from "#test/support/assert.ts"

/**
 * The tests' one door of SQL text to grizzle's wire: a statement a wire suite sends that neither the engine's AST nor
 * its catalog-read AST expresses (pg_sleep, pg_terminate_backend, a planted fault, a scripted answer's text). Product
 * code sends only the engine printer's text or a reviewed migration file's statement (adapter/wire/batch.ts SentText);
 * a test that needs another passes it through here, where a reader sees it is written by hand.
 */
export const testSql = nominal<string, EmittedText>()

/**
 * The tests' one door of a named type's schema (sql/ast.ts TypeSchema): an oracle or a fixture that builds a type of a
 * schema it names by its text, an installation's or the vector extension's. Product code takes it from the naming door
 * (physical/ddl/names.ts) or the snapshot's codec.
 */
export const testTypeSchema = nominal<string, TypeSchema>()

/** The SQL text a flight statement runs: a server statement's, or the unnamed statement's own. */
export const statementSql = (statement: FlightStatement): string =>
	"server" in statement ? statement.server.sql : statement.sql

/**
 * A key column of a closed relation built by hand (ClosedRelation): the int2 column, named `C`, that holds its code, and
 * the size of its code space.
 */
export interface CodeColumn<C extends string> {
	readonly column: C
	readonly codes: number
}

/**
 * A closed relation built by hand in a scratch schema: the law-cost bench's own fixture, never grizzle's lowering of a
 * declared relation. Its constant, the statements that pack, read, re-point and drop it, and the domain whose check reads
 * it are the engine's (ir/cells.ts, sql/constants.ts, sql/print.ts); only the tables that place a law on it are written
 * here by hand (`tableOfCodes`, `checkConstraint`, `generatedColumn`), since the engine's table AST holds no constant
 * expression.
 *
 * - Its key columns index its cells row-major in their order, and `payload` holds the code spaces of its payload
 *   coordinates, none for a set, as a layout's (ir/cells.ts Layout) do.
 * - A cell's rank is its index times `stride` modulo the cell count, a permutation of the cells when `stride` is coprime
 *   to the count. The `members` cells of lowest rank are its members, so they are scattered over the whole constant,
 *   and a member's payload code is its rank modulo the size of its payload space.
 */
export interface ClosedRelation<C extends string> {
	readonly name: string
	readonly key: Arr.NonEmptyReadonlyArray<CodeColumn<C>>
	readonly payload: ReadonlyArray<number>
	readonly members: number
	readonly stride: number
}

/** A relation's coordinates, as the cells encoder reads them. */
const layoutOf = (relation: ClosedRelation<string>): Layout => ({
	key: Arr.map(relation.key, (k) => k.codes),
	payload: relation.payload
})

/** The cells of a relation's constant: the points of its key's space. */
export const cellCount = (relation: ClosedRelation<string>): number =>
	Number(spaceSize(layoutOf(relation).key))

/** The bits of one of a relation's cells, as the cells encoder sizes it. */
export const widthOf = (relation: ClosedRelation<string>): number =>
	cellWidth(spaceSize(relation.payload))

/** The bits of a relation's constant. */
export const constantBits = (relation: ClosedRelation<string>): number =>
	cellCount(relation) * widthOf(relation)

/**
 * Digit `i` of `index` in the space whose coordinates hold `sizes` codes each, the first most significant, `size` being
 * coordinate i's: the index divided by the product of the later coordinates' sizes, reduced by `size` but for the
 * first. Inside the space the digits are those ir/cells.ts rowMajorIndex reads back; an index past its end carries
 * into the first digit, which then lies outside its coordinate.
 */
const digitOf = (sizes: ReadonlyArray<number>, size: number, i: number, index: number): number => {
	const quotient = Math.floor(
		index / Arr.reduce(Arr.drop(sizes, i + 1), 1, (product, later) => product * later)
	)
	return i === 0 ? quotient : quotient % size
}

/** The key codes at a cell of a relation's constant: one past the end, the first lies outside its code space. */
export const digitsAt = (
	relation: ClosedRelation<string>,
	index: number
): Arr.NonEmptyReadonlyArray<number> => {
	const sizes = layoutOf(relation).key
	return Arr.map(sizes, (size, i) => digitOf(sizes, size, i, index))
}

/** A member of a relation: its key's codes in key order, its rank, and its payload code, 0 for a set's. */
interface Member {
	readonly key: Arr.NonEmptyReadonlyArray<number>
	readonly rank: number
	readonly code: number
}

const byRank: Order.Order<Member> = Order.mapInput(Order.Number, (m: Member) => m.rank)

/** Every member of a relation, in rank order: the one place its membership is decided. */
export const membersOf = (relation: ClosedRelation<string>): ReadonlyArray<Member> => {
	const cells = cellCount(relation)
	const codes = Number(spaceSize(relation.payload))
	const members: Array<Member> = []
	for (let index = 0; index < cells; index++) {
		const rank = (index * relation.stride) % cells
		if (rank < relation.members) {
			members.push({ key: digitsAt(relation, index), rank, code: rank % codes })
		}
	}
	return Arr.sort(members, byRank)
}

/**
 * A relation's constant as the host's cells encoder builds it from its members, in PostgreSQL's bit-string text
 * (ir/cells.ts constantOf, bitText): the oracle the constant PostgreSQL packs must equal. Its members lie at distinct
 * cells, so the key holds, and the text is far below the longest string V8 builds.
 */
export const hostBits = (
	relation: ClosedRelation<string>
): EngineResult.Result<string, KeyCollision | CompileBound> =>
	EngineResult.flatMap(
		constantOf(
			layoutOf(relation),
			Arr.map(membersOf(relation), (m) => ({
				key: m.key,
				payload: Arr.map(relation.payload, (size, i) => digitOf(relation.payload, size, i, m.code))
			}))
		),
		(constant) => bitText(constant, maxStringLength.value)
	)

/** A member's columns in its relation's members table, beside its key: its rank and its payload code. */
export const memberColumns = { rank: "rank", code: "code" } as const

/** A statement and its parameters, each text-cast by the statement's SQL. */
interface Statement {
	readonly sql: string
	readonly params: ReadonlyArray<unknown>
}

const plainColumn = (name: string, type: TypeRef): ColumnDef => ({
	name,
	type,
	collation: undefined,
	generated: undefined
})

/**
 * A relation's members table, the seeded relation the erasure replaces and a foreign key's target, in two statements:
 * the engine's table of its key codes, its rank and its payload code, keyed by its key columns; then its members
 * (membersOf), one array parameter a column read in lockstep by unnest.
 */
export const membersTableSql = (
	table: ObjectName,
	relation: ClosedRelation<string>
): readonly [create: string, fill: Statement] => {
	const members = membersOf(relation)
	const columns = Arr.appendAll(
		Arr.map(relation.key, (k) => plainColumn(k.column, types.smallint)),
		[
			plainColumn(memberColumns.rank, types.integer),
			plainColumn(memberColumns.code, types.smallint)
		]
	)
	const arrays: ReadonlyArray<ReadonlyArray<number>> = [
		...Arr.map(relation.key, (_, i) => Arr.map(members, (m) => Arr.getUnsafe(m.key, i))),
		Arr.map(members, (m) => m.rank),
		Arr.map(members, (m) => m.code)
	]
	return [
		printStatement({
			kind: "createTable",
			table,
			columns,
			primaryKey: {
				kind: "primaryKey",
				name: `${table.name}_key`,
				columns: Arr.map(relation.key, (k) => ({ column: k.column, withoutOverlaps: false }))
			},
			secondary: []
		}),
		{
			sql: `INSERT INTO ${printObjectName(table)} (${Arr.join(
				Arr.map(columns, (c) => quoteIdent(c.name)),
				", "
			)}) SELECT * FROM pg_catalog.unnest(${Arr.join(
				Arr.map(columns, (c, i) => `$${i + 1}::${printType({ ...c.type, array: true })}`),
				", "
			)})`,
			params: arrays
		}
	]
}

/** A cell's index over the codes `digit` reads, row-major in key order (sql/constants.ts mixedRadix). */
const indexOver = (
	relation: ClosedRelation<string>,
	digit: (key: CodeColumn<string>) => ConstantExpr
): ConstantExpr => mixedRadix(Arr.map(relation.key, (k) => ({ digit: digit(k), radix: k.codes })))

/** A cell's index from the codes of a row's key columns, inside a table's DDL. */
const rowIndex = (relation: ClosedRelation<string>): ConstantExpr =>
	indexOver(relation, (k) => column(undefined, k.column))

/**
 * The law that the cell at `index` is present in the constant `constant`: a set's one-bit cell equal to B'1', or a
 * function's cell above 0 (sql/constants.ts inSet, keyIn).
 */
const present = (
	constant: ObjectName,
	relation: ClosedRelation<string>,
	index: ConstantExpr
): ConstantExpr =>
	relation.payload.length === 0 ? inSet(constant, index) : keyIn(constant, index, widthOf(relation))

/** The cell of the codes `code` reads, in key order: shifts and ORs, no constant (sql/constants.ts packCell). */
export const cellExpr = (
	relation: ClosedRelation<string>,
	code: (key: CodeColumn<string>) => ConstantExpr
): ConstantExpr => packCell(Arr.map(relation.key, code))

/** The law over a row's codes: its cell is present in the constant. */
export const rowLaw = (constant: ObjectName, relation: ClosedRelation<string>): ConstantExpr =>
	present(constant, relation, rowIndex(relation))

/** A derived column's expression: the payload code at the row's cell, NULL where it is absent (sql/constants.ts applied). */
export const derivedExpr = (constant: ObjectName, relation: ClosedRelation<string>): ConstantExpr =>
	applied(constant, rowIndex(relation), widthOf(relation))

/**
 * The migration's pack of a relation's constant into the IMMUTABLE function `constant`, the engine's DO block
 * (sql/constants.ts Pack): its members as VALUES rows, joined to the cells' index space. A row's names are its key
 * codes' texts.
 */
export const packSql = (constant: ObjectName, relation: ClosedRelation<string>): string =>
	printConstantStatement({
		kind: "pack",
		function: constant,
		radices: layoutOf(relation).key,
		width: widthOf(relation),
		rows: nonEmpty(
			Arr.map(membersOf(relation), (m) => ({
				key: m.key,
				payload: m.code,
				names: Arr.map(m.key, (code) => String(code))
			})),
			`the members of ${relation.name}`
		)
	})

/** The drop of a constant's function, RESTRICT: it fails while a domain, CHECK or column still reads it. */
export const dropConstantSql = (constant: ObjectName): string =>
	printConstantStatement({ kind: "dropConstant", name: { ...constant, args: [] } })

/** The one check of a cell's domain, under one name whatever constant it reads, so a re-point keeps it. */
const domainCheckName = "member"

/**
 * A cell domain's check: each code read back from VALUE (sql/constants.ts unpackCell), the cell's index computed from
 * them, and the constant read there.
 */
const domainCheck = (
	constant: ObjectName,
	relation: ClosedRelation<string>
): ConstantDomainCheck => ({
	name: domainCheckName,
	predicate: present(
		constant,
		relation,
		mixedRadix(unpackCell(domainValue, layoutOf(relation).key))
	)
})

/**
 * A relation's domain over its int8 cell, in two statements: the domain, then its check over the constant `constant`,
 * added as a re-point adds it.
 */
export const cellDomainSql = (
	domain: ObjectName,
	constant: ObjectName,
	relation: ClosedRelation<string>
): readonly [create: string, check: string] => [
	printStatement({
		kind: "createDomain",
		name: domain,
		base: types.bigint,
		collation: undefined,
		constraints: []
	}),
	printConstantStatement({
		kind: "alterDomain",
		name: domain,
		action: { kind: "addConstraint", constraint: domainCheck(constant, relation), notValid: false }
	})
]

/**
 * The re-point of a cell domain at the constant `constant` of `relation`, a relation of the same key, in three
 * statements (sql/constants.ts repoint): its check dropped, added again NOT VALID over the new constant, so no stored
 * row is read, then VALIDATEd, which reads every column of the domain's type in every table and names the table of a
 * row the constant refuses.
 */
export const repointSql = (
	domain: ObjectName,
	constant: ObjectName,
	relation: ClosedRelation<string>
): readonly [drop: string, add: string, validate: string] => {
	const [drop, add, validate] = repoint(domain, domainCheck(constant, relation))
	return [
		printConstantStatement(drop),
		printConstantStatement(add),
		printConstantStatement(validate)
	]
}

/** The re-derivation of a table's generated `column` as `expr`: SET EXPRESSION, which rewrites the table. */
export const setExpressionSql = (table: ObjectName, name: string, expr: ConstantExpr): string =>
	printConstantStatement({
		kind: "alterTable",
		table,
		actions: [{ kind: "setExpression", column: name, expr }]
	})

/** A table of `codes`, each a NOT NULL int2, and nothing else, written by hand: the engine's table has a primary key. */
export const tableOfCodes = (
	table: ObjectName,
	codes: Arr.NonEmptyReadonlyArray<CodeColumn<string>>
): string =>
	`CREATE TABLE ${printObjectName(table)} (${Arr.join(
		Arr.map(codes, (k) => `${quoteIdent(k.column)} ${printType(types.smallint)} NOT NULL`),
		", "
	)})`

/**
 * A CHECK of `predicate` on a table, written by hand around the engine's print of it, as the engine prints a domain's
 * check: `(predicate) IS TRUE`, so NULL refuses too.
 */
export const checkConstraint = (table: ObjectName, name: string, predicate: ConstantExpr): string =>
	`ALTER TABLE ${printObjectName(table)} ADD CONSTRAINT ${quoteIdent(name)} CHECK ((${printConstantExpr(predicate)}) IS TRUE)`

/** A STORED generated column of `type`, `expr` of the row, written by hand around the engine's print of it. */
export const generatedColumn = (
	table: ObjectName,
	name: string,
	type: TypeRef,
	expr: ConstantExpr
): string =>
	`ALTER TABLE ${printObjectName(table)} ADD COLUMN ${quoteIdent(name)} ${printType(type)} GENERATED ALWAYS AS (${printConstantExpr(expr)}) STORED`

/** A NOT NULL column of `type` added to a table, the engine's ALTER TABLE: a cell the host writes. */
export const addColumnSql = (table: ObjectName, name: string, type: TypeRef): string =>
	printStatement({
		kind: "alterTable",
		table,
		actions: [{ kind: "addColumn", column: plainColumn(name, type) }]
	})

/**
 * The engine's foreign key, immediate, from a table's codes of `relation`'s key into the members table `target`, as
 * grizzle adds every foreign key: its own ALTER TABLE, MATCH SIMPLE.
 */
export const foreignKeySql = (
	table: ObjectName,
	name: string,
	relation: ClosedRelation<string>,
	target: ObjectName
): string => {
	const columns = Arr.map(relation.key, (k) => ({ column: k.column, period: false }))
	return printStatement({
		kind: "alterTable",
		table,
		actions: [
			{
				kind: "addConstraint",
				constraint: {
					kind: "foreignKey",
					name,
					columns,
					references: target,
					referencedColumns: columns,
					deferrable: undefined
				},
				notValid: false
			}
		]
	})
}
