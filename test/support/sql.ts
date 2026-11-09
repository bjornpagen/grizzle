import { Array as Arr, Order, String as Str } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import type { CompileBound } from "#compiler/core/errors.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import * as EngineResult from "#compiler/core/result.ts"
import {
	cellWidth,
	type Constant,
	constantDigestOf,
	constantOf,
	type KeyCollision,
	type CellLayout,
	keyCells,
	literalOf,
	spaceSize
} from "#compiler/ir/cells.ts"
import type {
	AlterTable,
	ColumnDef,
	EmittedText,
	Expr,
	ObjectName,
	OperandSelect,
	TypeRef,
	TypeSchema
} from "#compiler/sql/ast.ts"
import { binary, col, gt, lit, ne, tableCol, types } from "#compiler/sql/build.ts"
import {
	applied,
	cellCode,
	cellOfKey,
	constantValue,
	inSet,
	pack
} from "#compiler/sql/constants.ts"
import {
	type CarrierName,
	carrierDigestHex,
	carrierPrefix,
	carrierSeparator,
	isDecimal
} from "#compiler/sql/naming.ts"
import {
	printExpr,
	printObjectName,
	printStatement,
	printType,
	quoteIdent
} from "#compiler/sql/print.ts"
import { type AstHooks, Transform } from "#compiler/sql/transform.ts"
import { hexOfText, installedText } from "#test/support/closed/bit-text.ts"

/** A query that may stand only as an operand, rebuilt by `hooks` (sql/transform.ts). */
export const transformOperand = (s: OperandSelect, hooks: AstHooks): OperandSelect =>
	new Transform(hooks).select(s)

/** A key is present in a function's constant: its cell is not 0 (sql/constants.ts cellCode). */
const keyIn = (constant: ObjectName, index: Expr, width: number): Expr =>
	gt(cellCode(constant, index, width), lit.int(0, types.integer))

const isLowerHex = (text: string): boolean => {
	for (const ch of text) {
		if (!((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f"))) {
			return false
		}
	}
	return true
}

/**
 * Whether a value spells a carrier (sql/naming.ts carrierName): a types digest of carrierDigestHex lowercase hex
 * digits, then an ordinal from 1 with no leading zero, a safe integer.
 */
export const isCarrierName = (u: unknown): u is CarrierName => {
	if (typeof u !== "string" || !Str.startsWith(carrierPrefix)(u)) {
		return false
	}
	const digest = Str.slice(carrierPrefix.length, carrierPrefix.length + carrierDigestHex.value)(u)
	const rest = Str.slice(carrierPrefix.length + carrierDigestHex.value)(u)
	if (
		digest.length !== carrierDigestHex.value ||
		!isLowerHex(digest) ||
		!Str.startsWith(carrierSeparator)(rest)
	) {
		return false
	}
	const ordinal = Str.slice(carrierSeparator.length)(rest)
	return isDecimal(ordinal) && ordinal !== "0" && Number.isSafeInteger(Number(ordinal))
}

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
 * declared relation. Its constant, the statements that pack, read and drop it, the tables' CHECKs and generated
 * columns, and the foreign key are the engine's (sql/constants.ts builders, sql/print.ts printStatement); only the bare
 * table of codes is written by hand (`tableOfCodes`), since the engine's table has a primary key. The host's string of
 * its members is the test oracle's (test/support/closed/bit-text.ts bitText, R8).
 *
 * - Its key columns index its cells row-major in their order, and `payload` holds the code spaces of its payload
 *   coordinates, none for a set, as a layout's (ir/cells.ts CellLayout) do.
 * - A cell's rank is its index times `stride` modulo the cell count, a permutation of the cells when `stride` is coprime
 *   to the count. The `members` cells of lowest rank are its members, so they are scattered over the whole constant,
 *   and a member's payload code is its rank modulo the size of its payload space.
 */
export interface HandClosed<C extends string> {
	readonly name: string
	readonly key: Arr.NonEmptyReadonlyArray<CodeColumn<C>>
	readonly payload: ReadonlyArray<number>
	readonly members: number
	readonly stride: number
}

/** The code spaces of a relation's key coordinates, in key order. */
const keySizes = (relation: HandClosed<string>): Arr.NonEmptyReadonlyArray<number> =>
	Arr.map(relation.key, (k) => k.codes)

/** A relation's coordinates, as the cells encoder reads them: a product of its key's codes. */
const layoutOf = (relation: HandClosed<string>): CellLayout => ({
	key: { kind: "product", sizes: keySizes(relation) },
	payload: relation.payload
})

/** The cells of a relation's constant: the points of its key's space. */
export const cellCount = (relation: HandClosed<string>): number =>
	Number(keyCells(layoutOf(relation).key))

/** The bits of one of a relation's cells, as the cells encoder sizes it. */
export const widthOf = (relation: HandClosed<string>): number =>
	cellWidth(spaceSize(relation.payload))

/** The bits of a relation's constant. */
export const constantBits = (relation: HandClosed<string>): number =>
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
	relation: HandClosed<string>,
	index: number
): Arr.NonEmptyReadonlyArray<number> => {
	const sizes = keySizes(relation)
	return Arr.map(sizes, (size, i) => digitOf(sizes, size, i, index))
}

/** A member of a relation: its cell, its key's codes in key order, its rank, and its payload code, 0 for a set's. */
interface Member {
	readonly index: number
	readonly key: Arr.NonEmptyReadonlyArray<number>
	readonly rank: number
	readonly code: number
}

const byRank: Order.Order<Member> = Order.mapInput(Order.Number, (m: Member) => m.rank)

/** Every member of a relation, in rank order: the one place its membership is decided. */
export const membersOf = (relation: HandClosed<string>): ReadonlyArray<Member> => {
	const cells = cellCount(relation)
	const codes = Number(spaceSize(relation.payload))
	const members: Array<Member> = []
	for (let index = 0; index < cells; index++) {
		const rank = (index * relation.stride) % cells
		if (rank < relation.members) {
			members.push({ index, key: digitsAt(relation, index), rank, code: rank % codes })
		}
	}
	return Arr.sort(members, byRank)
}

/** A relation's constant as the host's encoder builds it from its members (ir/cells.ts constantOf). */
const hostConstant = (relation: HandClosed<string>): EngineResult.Result<Constant, KeyCollision> =>
	constantOf(
		layoutOf(relation),
		Arr.map(membersOf(relation), (m) => ({
			key: m.key,
			payload: Arr.map(relation.payload, (size, i) => digitOf(relation.payload, size, i, m.code))
		}))
	)

/**
 * A relation's constant as the host builds it from its members, in PostgreSQL's bit-string text once installed
 * (ir/cells.ts constantOf's entries, written by the test oracle installedText, padded to whole hex digits): what the
 * constant PostgreSQL holds must equal. Its members lie at distinct cells, so the key holds, and the text is far below
 * the longest string V8 builds.
 */
export const hostBits = (
	relation: HandClosed<string>
): EngineResult.Result<string, KeyCollision | CompileBound> =>
	EngineResult.flatMap(hostConstant(relation), (constant) =>
		installedText(constant, maxStringLength.value)
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

/** The array of a builtin scalar type, the type of an unnest parameter; a members table holds no other. */
const arrayOf = (type: TypeRef): TypeRef => {
	if (type.kind !== "builtin" || type.name === "bit" || type.name === "numeric") {
		throw new Error(`a members table's columns are builtin integers, not ${printType(type)}`)
	}
	return { ...type, array: true }
}

/**
 * A relation's members table, the seeded relation the erasure replaces and a foreign key's target, in two statements:
 * the engine's table of its key codes, its rank and its payload code, keyed by its key columns; then its members
 * (membersOf), one array parameter a column read in lockstep by ROWS FROM of one-argument unnests: PostgreSQL reads a
 * multi-argument unnest as ROWS FROM only when its name is unqualified, and every name here is qualified.
 */
export const membersTableSql = (
	table: ObjectName,
	relation: HandClosed<string>
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
			)}) SELECT * FROM ROWS FROM (${Arr.join(
				Arr.map(columns, (c, i) => `pg_catalog.unnest($${i + 1}::${printType(arrayOf(c.type))})`),
				", "
			)})`,
			params: arrays
		}
	]
}

/** A cell's index over the codes `digit` reads, row-major in key order (sql/constants.ts cellOfKey over a product). */
const indexOver = (relation: HandClosed<string>, digit: (key: CodeColumn<string>) => Expr): Expr =>
	cellOfKey(
		{
			kind: "product",
			coordinates: Arr.map(relation.key, (k) => ({ field: k.column, radix: k.codes }))
		},
		Arr.map(relation.key, digit)
	)

/** A cell's index from the codes of a row's key columns, inside a table's DDL. */
const rowIndex = (relation: HandClosed<string>): Expr =>
	indexOver(relation, (k) => tableCol(k.column))

/** A row's code column under `alias`, as a statement over the members table reads it. */
export const codeAt = (alias: string, column: string): string => printExpr(col(alias, column))

/**
 * The law that the cell at `index` is present in the constant `constant`: a set's one-bit cell equal to '1'::bit(1), or
 * a function's cell above 0 (sql/constants.ts inSet, keyIn).
 */
const present = (constant: ObjectName, relation: HandClosed<string>, index: Expr): Expr =>
	relation.payload.length === 0 ? inSet(constant, index) : keyIn(constant, index, widthOf(relation))

/** The law over a row's codes, a closed law as a table CHECK reads it (U3): its cell is present in the constant. */
export const rowLaw = (constant: ObjectName, relation: HandClosed<string>): Expr =>
	present(constant, relation, rowIndex(relation))

/** A derived column's expression: the payload code at the row's cell, NULL where it is absent (sql/constants.ts applied). */
export const derivedExpr = (constant: ObjectName, relation: HandClosed<string>): Expr =>
	applied(constant, rowIndex(relation), widthOf(relation))

/**
 * The migration's statement of a relation's constant as the IMMUTABLE function `constant` (sql/constants.ts pack): its
 * hex literal, the host's encoding of its members (ir/cells.ts literalOf), under its row count and content digest. Its
 * members lie at distinct cells, so the host's encoder never refuses them.
 */
export const packSql = (constant: ObjectName, relation: HandClosed<string>): string => {
	const encoded = hostConstant(relation)
	if (!encoded.ok) {
		throw new Error(`the members of ${relation.name} lie at distinct cells`)
	}
	return printStatement(
		pack(constant, encoded.value.cells, encoded.value.width, {
			hex: literalOf(encoded.value),
			rows: encoded.value.entries.length,
			digest: constantDigestOf(encoded.value)
		})
	)
}

/** The drop of a zero-argument constant's function, RESTRICT: it fails while a domain, CHECK or column still reads it. */
export const dropConstantSql = (constant: ObjectName): string =>
	printStatement({ kind: "dropFunction", name: { ...constant, args: [] }, ifExists: false })

/** One ALTER TABLE of one action. */
const alterTable = (table: ObjectName, action: AlterTable["actions"][number]): string =>
	printStatement({ kind: "alterTable", table, actions: [action] })

/**
 * The re-point of a table's CHECK `name` at `predicate`, a closed law re-pointed on its table (U3), in three
 * statements: the check dropped, added again NOT VALID, so no stored row is read, then VALIDATEd, which reads every
 * stored row and names the table of a row the new predicate refuses.
 */
export const repointSql = (
	table: ObjectName,
	name: string,
	predicate: Expr
): readonly [drop: string, add: string, validate: string] => [
	alterTable(table, { kind: "dropConstraint", name }),
	alterTable(table, {
		kind: "addConstraint",
		constraint: { kind: "check", name, predicate },
		notValid: true
	}),
	alterTable(table, { kind: "validateConstraint", name })
]

/** The re-derivation of a table's generated `column` as `expr`: SET EXPRESSION, which rewrites the table. */
export const setExpressionSql = (table: ObjectName, name: string, expr: Expr): string =>
	alterTable(table, { kind: "setExpression", column: name, expr })

/** A table of `codes`, each a NOT NULL int2, and nothing else, written by hand: the engine's table has a primary key. */
export const tableOfCodes = (
	table: ObjectName,
	codes: Arr.NonEmptyReadonlyArray<CodeColumn<string>>
): string =>
	`CREATE TABLE ${printObjectName(table)} (${Arr.join(
		Arr.map(codes, (k) => `${quoteIdent(k.column)} ${printType(types.smallint)} NOT NULL`),
		", "
	)})`

/** A CHECK of `predicate` added to a table, the engine's: `CHECK ((predicate) IS TRUE)`, so NULL refuses too. */
export const checkConstraint = (table: ObjectName, name: string, predicate: Expr): string =>
	alterTable(table, {
		kind: "addConstraint",
		constraint: { kind: "check", name, predicate },
		notValid: false
	})

/** A STORED generated column of `type`, `expr` of the row, the engine's ALTER TABLE. */
export const generatedColumn = (
	table: ObjectName,
	name: string,
	type: TypeRef,
	expr: Expr
): string =>
	alterTable(table, {
		kind: "addColumn",
		column: { name, type, collation: undefined, generated: { kind: "stored", expr } }
	})

/** A NOT NULL column of `type` added to a table, the engine's ALTER TABLE: a value the host writes. */
export const addColumnSql = (table: ObjectName, name: string, type: TypeRef): string =>
	alterTable(table, { kind: "addColumn", column: plainColumn(name, type) })

/**
 * The engine's foreign key, immediate, from a table's codes of `relation`'s key into the members table `target`, as
 * grizzle adds every foreign key: its own ALTER TABLE, MATCH SIMPLE.
 */
export const foreignKeySql = (
	table: ObjectName,
	name: string,
	relation: HandClosed<string>,
	target: ObjectName
): string => {
	const columns = Arr.map(relation.key, (k) => ({ column: k.column, period: false }))
	return alterTable(table, {
		kind: "addConstraint",
		constraint: {
			kind: "foreignKey",
			name,
			columns,
			references: target,
			referencedColumns: columns,
			deferrable: undefined,
			onUpdate: undefined
		},
		notValid: false
	})
}

/**
 * A roster's names constant as an array literal's text, `{"h0","","h2"}`: every element double-quoted, its `"` and `\`
 * escaped, so a hole is the quoted empty name and no handle reads as NULL or splits.
 */
const nameArrayText = (names: ReadonlyArray<string>): string =>
	`{${Arr.join(
		Arr.map(names, (name) => `"${Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(name))}"`),
		","
	)}}`

/**
 * A roster's names constant, the engine's CreateConstant: a zero-argument IMMUTABLE SQL function returning name[], each
 * code's handle in code order, a hole the empty name (OPEN-2 (b)).
 */
export const namesConstantSql = (fn: ObjectName, names: ReadonlyArray<string>): string =>
	printStatement({
		kind: "createConstant",
		name: fn,
		params: [],
		returns: types.name(true),
		body: lit.text(nameArrayText(names), types.name(true))
	})

/**
 * A roster's live-code constant, the engine's CreateConstant over bit varying, its body the hex literal of `live`, a
 * set's text whole hex digits long (test/support/closed/bit-text.ts setText): position c is 1 exactly when code c is
 * live (OPEN-2 (a), measured against (b)).
 */
export const liveConstantSql = (fn: ObjectName, live: string): string =>
	printStatement({
		kind: "createConstant",
		name: fn,
		params: [],
		returns: types.varbit,
		body: lit.bits(hexOfText(live), types.varbit)
	})

/** VALUE + 1: a code's position in its names array, which counts from 1. */
const valuePosition: Expr = binary("+", { kind: "domainValue" }, lit.int(1, types.integer))

/**
 * A roster domain over smallint, the engine's CreateDomain with its one CHECK, read off `check`: under OPEN-2 (b) a
 * code is live when its name is not the hole's, `((names())[VALUE + 1] <> ''::pg_catalog.name) IS TRUE`; under (a)
 * when its bit of the live constant is set, `(substring(live(), VALUE + 1, 1)::integer = 1) IS TRUE`.
 */
export const rosterDomainSql = (
	domain: ObjectName,
	check: { readonly kind: "names" | "live"; readonly constant: ObjectName }
): string =>
	printStatement({
		kind: "createDomain",
		name: domain,
		base: types.smallint,
		collation: undefined,
		constraints: [
			{
				name: "live",
				predicate:
					check.kind === "names"
						? ne(
								{ kind: "subscript", array: constantValue(check.constant), index: valuePosition },
								lit.text("", types.name(false))
							)
						: inSet(check.constant, { kind: "domainValue" })
			}
		]
	})
