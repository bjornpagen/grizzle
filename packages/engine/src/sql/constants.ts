import { cellDigitBits } from "#compiler/core/limits.ts"
import { BlockLines, type Lines } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { FunctionName, ObjectName, TypeRef } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import {
	printCatalogType,
	printFunctionSignature,
	printObjectName,
	printType,
	quoteIdent,
	quoteString,
	statementText
} from "#compiler/sql/print.ts"

/**
 * The SQL of the installation's constants. A closed relation, and every closed side a law or query reads, compiles to
 * one bit string, a string of cells read w bits at a time: the body of an IMMUTABLE SQL function named by its contents,
 * so a changed relation is a new function and never a function replaced in place. Cell i holds bits i * w to
 * (i + 1) * w - 1; 0 is absent, and 1 + c is present with payload code c. A tuple's cell is its row-major mixed-radix
 * index over its key's codes.
 *
 * This module holds what reads and installs those strings: the expressions of a cell read, the cell a law over several
 * fields packs its codes into, and the migration statements that pack a relation, create a constant, re-point a domain
 * at a new constant, rewrite the generated columns that read one, and drop the old constant. Its expression language is
 * its own, beside sql/ast.ts Expr: it holds the bitwise operators, substring, NULLIF and subscripts Expr has none of.
 * Every name prints by its schema and quoted, as the SQL printer prints them (sql/print.ts).
 */

/**
 * The types a constant's SQL names: sql/ast.ts TypeRef, and the three pg_catalog types only constants read. `bit(n)`
 * and `bit varying` are SQL keywords, which PostgreSQL's grammar resolves into pg_catalog under every search_path;
 * `name` is PostgreSQL's fixed 64-byte type, so a subscript of a name[] is offset arithmetic.
 */
export type ConstantType =
	| TypeRef
	| { readonly kind: "bit"; readonly length: number }
	| { readonly kind: "varbit" }
	| { readonly kind: "name"; readonly array: boolean }

/**
 * The operators of a constant expression, by PostgreSQL's precedence, loosest first: the comparisons, then the
 * operators of no grammar rule of their own (the bitwise and, or and shifts), then + and -, then *.
 */
type ConstantOperator = "=" | ">" | "&" | "|" | "<<" | ">>" | "+" | "-" | "*"

/**
 * An expression over constants: a domain's check, a generated cell, a derived column, a decode function's body.
 *
 * - column: a column of the row, or of a FROM item when `table` names one;
 * - domainValue: VALUE, the value a domain's check judges;
 * - argument: a parameter of the function whose body it is, by name: a constant's body reads no relation, so no column
 *   can shadow it;
 * - int: a nonnegative integer below 2^31, which PostgreSQL types integer;
 * - bits: a bit-string literal, B'...', one bit per element, true as 1;
 * - array: an array literal of its type, each element the text its element type's input function reads;
 * - constant: a zero-argument constant's value, F();
 * - substring: `length` bits of `bits` from bit `start`, counted from 1; a range past either end is the empty string;
 * - nullif: NULL where `expr` equals `absent`, otherwise `expr`;
 * - subscript: an array's element, counted from 1, NULL past either end.
 */
export type ConstantExpr =
	| { readonly kind: "column"; readonly table: string | undefined; readonly column: string }
	| { readonly kind: "domainValue" }
	| { readonly kind: "argument"; readonly name: string }
	| { readonly kind: "int"; readonly value: number }
	| { readonly kind: "bits"; readonly bits: ReadonlyArray<boolean> }
	| {
			readonly kind: "array"
			readonly elements: ReadonlyArray<string>
			readonly type: ConstantType
	  }
	| { readonly kind: "constant"; readonly function: ObjectName }
	| { readonly kind: "cast"; readonly expr: ConstantExpr; readonly type: ConstantType }
	| {
			readonly kind: "binary"
			readonly op: ConstantOperator
			readonly left: ConstantExpr
			readonly right: ConstantExpr
	  }
	| {
			readonly kind: "substring"
			readonly bits: ConstantExpr
			readonly start: ConstantExpr
			readonly length: ConstantExpr
	  }
	| { readonly kind: "nullif"; readonly expr: ConstantExpr; readonly absent: ConstantExpr }
	| { readonly kind: "subscript"; readonly array: ConstantExpr; readonly index: ConstantExpr }

export const column = (table: string | undefined, name: string): ConstantExpr => ({
	kind: "column",
	table,
	column: name
})

export const domainValue: ConstantExpr = { kind: "domainValue" }

export const argument = (name: string): ConstantExpr => ({ kind: "argument", name })

export const int = (value: number): ConstantExpr => ({ kind: "int", value })

export const bitString = (bits: ReadonlyArray<boolean>): ConstantExpr => ({ kind: "bits", bits })

/** An array literal: `type` is the array's type, each element the text its element type's input function reads. */
export const arrayLiteral = (
	elements: ReadonlyArray<string>,
	type: ConstantType
): ConstantExpr => ({
	kind: "array",
	elements,
	type
})

export const cast = (expr: ConstantExpr, type: ConstantType): ConstantExpr => ({
	kind: "cast",
	expr,
	type
})

/** bit varying, the type of every constant's value. */
export const varbit: ConstantType = { kind: "varbit" }

const constantRead = (fn: ObjectName): ConstantExpr => ({ kind: "constant", function: fn })

const binary = (op: ConstantOperator, left: ConstantExpr, right: ConstantExpr): ConstantExpr => ({
	kind: "binary",
	op,
	left,
	right
})

const plus = (left: ConstantExpr, right: ConstantExpr): ConstantExpr => binary("+", left, right)

/** `e` times `factor`: `e` itself for a factor of one. */
const times = (e: ConstantExpr, factor: number): ConstantExpr =>
	factor === 1 ? e : binary("*", e, int(factor))

/** `e` shifted by `bits` toward the high end (`<<`) or the low end (`>>`): `e` itself for no bits. */
const shifted = (op: "<<" | ">>", e: ConstantExpr, bits: number): ConstantExpr =>
	bits === 0 ? e : binary(op, e, int(bits))

/** One coordinate of a tuple: its code, and the size of its code space, holes included. */
export interface Coordinate {
	readonly digit: ConstantExpr
	readonly radix: number
}

/**
 * The row-major mixed-radix index of a tuple, ((k1 * r2 + k2) * r3 + k3) ...: Horner's rule over its coordinates in key
 * order. The first coordinate's radix bounds the index and multiplies nothing. Every digit is below its radix, which
 * its field's type proves, so no digit carries into its neighbour and the index is in range.
 */
export const mixedRadix = (coordinates: NonEmptyReadonlyArray<Coordinate>): ConstantExpr =>
	coordinates
		.slice(1)
		.reduce<ConstantExpr>(
			(index, next) => plus(times(index, next.radix), next.digit),
			coordinates[0].digit
		)

/** The mask of one digit's bits (cellDigitBits): a code is a nonnegative int2, so it fits its digit. */
const digitMask = 2 ** cellDigitBits.value - 1

/** How far a cell of `count` digits shifts its digit `i`: the last digit lowest, unshifted. */
const digitShift = (count: number, i: number): number => cellDigitBits.value * (count - 1 - i)

/**
 * The cell a law over several fields stores, as a STORED generated column's expression: each digit as bigint, the
 * first highest, 16 bits each, (d1 << 32) | (d2 << 16) | d3. The expression is shifts only, so no constant stands
 * behind a generation expression, which PostgreSQL re-prepares every statement. A cell holds at most four digits,
 * bigint's 64 bits over 16; the law model refuses a fifth before it builds one. A code is below 2^15, so the first digit
 * never reaches the sign bit.
 */
export const packCell = (digits: NonEmptyReadonlyArray<ConstantExpr>): ConstantExpr => {
	const placed = mapNonEmpty(digits, (digit, i) =>
		shifted("<<", cast(digit, types.bigint), digitShift(digits.length, i))
	)
	return placed.slice(1).reduce<ConstantExpr>((cell, digit) => binary("|", cell, digit), placed[0])
}

/**
 * The coordinates of a cell packCell packed, one per radix in packing order: digit i is ((cell >> s) & 65535) at its
 * shift s, read as an integer, so every index computed from it is an integer, the type substring's positions take. A
 * digit is below 2^16, and an index below the length of the constant it reads, so neither cast can overflow.
 */
export const unpackCell = (
	cell: ConstantExpr,
	radices: NonEmptyReadonlyArray<number>
): NonEmptyReadonlyArray<Coordinate> =>
	mapNonEmpty(radices, (radix, i) => ({
		digit: cast(
			binary("&", shifted(">>", cell, digitShift(radices.length, i)), int(digitMask)),
			types.integer
		),
		radix
	}))

/**
 * Cell `index` of the constant F, `width` bits: substring(F() FROM index * width + 1 FOR width), positions counted from
 * 1. `index` is an integer: substring takes no bigint position. A range past either end is the empty string, which
 * equals no B'1' and reads as the integer 0, so an index out of range reads as absent and no range check is needed.
 * With `width` the size of a prefix's completions, the same read is that prefix's set of completions.
 */
export const cellAt = (constant: ObjectName, index: ConstantExpr, width: number): ConstantExpr => ({
	kind: "substring",
	bits: constantRead(constant),
	start: plus(times(index, width), int(1)),
	length: int(width)
})

/** A cell's value as an integer: 0 absent, 1 + c present with payload code c. */
const cellCode = (constant: ObjectName, index: ConstantExpr, width: number): ConstantExpr =>
	cast(cellAt(constant, index, width), types.integer)

/** A set's member, a cell of one bit equal to B'1': a code is live, or a tuple is in a set. */
export const inSet = (constant: ObjectName, index: ConstantExpr): ConstantExpr =>
	binary("=", cellAt(constant, index, 1), bitString([true]))

/** A key is present: its cell is not 0. */
export const keyIn = (constant: ObjectName, index: ConstantExpr, width: number): ConstantExpr =>
	binary(">", cellCode(constant, index, width), int(0))

/** A key and its payload code are in the relation: the key's cell is 1 + the payload's code. */
export const pairIn = (
	constant: ObjectName,
	index: ConstantExpr,
	width: number,
	payload: ConstantExpr
): ConstantExpr => binary("=", cellCode(constant, index, width), plus(int(1), payload))

/**
 * A function's application to a key, its payload code: NULLIF(cell, 0) - 1. An absent key is NULL, never -1, so a
 * lookup fed by it reads NULL instead of carrying into a neighbour's cell, and the IS TRUE of a check refuses it.
 */
export const applied = (constant: ObjectName, index: ConstantExpr, width: number): ConstantExpr =>
	binary("-", { kind: "nullif", expr: cellCode(constant, index, width), absent: int(0) }, int(1))

/**
 * An open-typed payload, read through the dictionary D of its values in code order: (D())[cell]. Arrays count from 1, so
 * cell 1 + c is D's value for code c, and cell 0, absent, is NULL.
 */
export const payloadAt = (
	dictionary: ObjectName,
	constant: ObjectName,
	index: ConstantExpr,
	width: number
): ConstantExpr => ({
	kind: "subscript",
	array: constantRead(dictionary),
	index: cellCode(constant, index, width)
})

/** A code's name, read from its roster's names constant: (names())[code + 1]::text, a hole the empty name. */
export const nameOf = (names: ObjectName, code: ConstantExpr): ConstantExpr =>
	cast({ kind: "subscript", array: constantRead(names), index: plus(code, int(1)) }, types.text)

/**
 * generate_series(0, count - 1) AS alias(column): every cell index of a constant of `count` cells, in order. Filtered
 * by its cell, it enumerates the relation.
 */
interface Series {
	readonly kind: "series"
	readonly count: ConstantExpr
	readonly alias: string
	readonly column: string
}

/** One tuple of a packed relation: its key's codes in key order, its payload's code, and the names they stand for. */
export interface PackRow {
	readonly key: NonEmptyReadonlyArray<number>
	readonly payload: number
	readonly names: NonEmptyReadonlyArray<string>
}

/**
 * The migration's pack of a relation into its constant, a DO block:
 *
 *   DO $$
 *   DECLARE
 *     "cells" text;
 *   BEGIN
 *     SELECT string_agg(COALESCE(1 + "r"."c", 0)::bit(w)::text, '' ORDER BY "g"."i")
 *     INTO "cells"
 *     FROM generate_series(0, r1 * r2 * ... - 1) AS "g"("i")
 *     LEFT JOIN (VALUES
 *       (k1, k2, ..., c), -- names
 *       ...
 *     ) AS "r"("k1", "k2", ..., "c")
 *     ON <the mixed-radix index of k1, k2, ...> = "g"."i";
 *     EXECUTE format('CREATE FUNCTION <function>() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE
 *       RETURN %L::bit varying', "cells");
 *   END
 *   $$
 *
 * PostgreSQL builds the string from the rows of codes in one hash join over the key space, and the function's body is
 * the string itself. `radices` are the key fields' code spaces, whose product is the count of cells; `width` is w. Each
 * row's codes are below their radices and its payload code below 2^w - 1, and no two rows share a key: the migration
 * checks the relation's key before it packs. PostgreSQL has no empty VALUES list, so a packed relation has a row.
 */
export interface Pack {
	readonly kind: "pack"
	readonly function: ObjectName
	readonly radices: NonEmptyReadonlyArray<number>
	readonly width: number
	readonly rows: NonEmptyReadonlyArray<PackRow>
}

/** A parameter of a constant's function: the decode function's code. */
interface ConstantParam {
	readonly name: string
	readonly type: TypeRef
}

/**
 * CREATE FUNCTION <name>(<params>) RETURNS <type> LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN <body>: a constant, of no
 * parameter, or a function of constants, such as a roster's decode function. Never CREATE OR REPLACE: a domain's
 * planned check keeps the constant it folded, so a function changed under it would go unseen. A new constant is a new
 * name. It sets no search_path: its body is parsed when it is created and names every type and function by its schema,
 * and a function with a SET clause is never inlined.
 */
export interface CreateConstant {
	readonly kind: "createConstant"
	readonly name: ObjectName
	readonly params: ReadonlyArray<ConstantParam>
	readonly returns: ConstantType
	readonly body: ConstantExpr
}

/**
 * DROP FUNCTION <signature> RESTRICT: an old constant, or a decode function before it is created again. PostgreSQL
 * records every domain check, CHECK and function body that reads a function, so the drop fails, naming the dependent,
 * when a migration missed one.
 */
interface DropConstant {
	readonly kind: "dropConstant"
	readonly name: FunctionName
}

/** A domain's check over constants; it prints as CHECK ((<predicate>) IS TRUE). */
export interface ConstantDomainCheck {
	readonly name: string
	readonly predicate: ConstantExpr
}

/** The shape of sql/ast.ts AlterDomainAction, its check over constants. */
type ConstantDomainAction =
	| {
			readonly kind: "addConstraint"
			readonly constraint: ConstantDomainCheck
			readonly notValid: boolean
	  }
	| { readonly kind: "validateConstraint"; readonly name: string }
	| { readonly kind: "dropConstraint"; readonly name: string }

/** ALTER DOMAIN, in the shape of sql/ast.ts AlterDomain, its check over constants. */
interface AlterConstantDomain {
	readonly kind: "alterDomain"
	readonly name: ObjectName
	readonly action: ConstantDomainAction
}

/** ALTER COLUMN <column> SET EXPRESSION AS (<expr>): a derived column's generation re-pointed at a new constant. */
interface SetExpression {
	readonly kind: "setExpression"
	readonly column: string
	readonly expr: ConstantExpr
}

/**
 * ALTER TABLE, in the shape of sql/ast.ts AlterTable, of SET EXPRESSION actions: PostgreSQL rewrites the table once for
 * every column the statement re-points.
 */
interface AlterGeneratedColumns {
	readonly kind: "alterTable"
	readonly table: ObjectName
	readonly actions: NonEmptyReadonlyArray<SetExpression>
}

/** Every statement of the constants' SQL. */
export type ConstantStatement =
	| Pack
	| CreateConstant
	| DropConstant
	| AlterConstantDomain
	| AlterGeneratedColumns

/** The drop of a created constant, by the signature it was created with. */
export const dropOf = (created: CreateConstant): DropConstant => ({
	kind: "dropConstant",
	name: { ...created.name, args: created.params.map((p) => p.type) }
})

/**
 * A domain re-pointed at a new constant, its check keeping its name: the old check dropped, the new one added NOT VALID,
 * then validated. VALIDATE reads every column of the domain's type, which PostgreSQL finds itself, and names the table
 * and column of a value the new constant refuses.
 */
export const repoint = (
	domain: ObjectName,
	check: ConstantDomainCheck
): readonly [AlterConstantDomain, AlterConstantDomain, AlterConstantDomain] => [
	{ kind: "alterDomain", name: domain, action: { kind: "dropConstraint", name: check.name } },
	{
		kind: "alterDomain",
		name: domain,
		action: { kind: "addConstraint", constraint: check, notValid: true }
	},
	{ kind: "alterDomain", name: domain, action: { kind: "validateConstraint", name: check.name } }
]

/** The printer's indentation unit. */
const unit = "  "

/** A function of pg_catalog's, qualified by it. */
const catalogFunction = (name: string): string => printObjectName({ schema: "pg_catalog", name })

const printConstantType = (type: ConstantType): string => {
	switch (type.kind) {
		case "bit":
			return `bit(${type.length})`
		case "varbit":
			return "bit varying"
		case "name":
			return `${printCatalogType("name")}${type.array ? "[]" : ""}`
		case "builtin":
		case "named":
			return printType(type)
	}
}

/**
 * The printer's precedence levels, loosest first, after PostgreSQL's operator table: comparisons, the operators of no
 * rule of their own, + and -, *, ::, atoms.
 */
const levels = ["compare", "other", "add", "mul", "cast", "atom"] as const

type Level = (typeof levels)[number]

const operatorLevel: { readonly [O in ConstantOperator]: Level } = {
	"=": "compare",
	">": "compare",
	"&": "other",
	"|": "other",
	"<<": "other",
	">>": "other",
	"+": "add",
	"-": "add",
	"*": "mul"
}

interface Printed {
	readonly text: string
	readonly level: Level
}

const tighter = (a: Level, b: Level): boolean => levels.indexOf(a) > levels.indexOf(b)

/** `operandText`, an atom's or a cast's text, cast to `type`: the one place this printer spells a cast. */
const castText = (operandText: string, type: ConstantType): string =>
	`${operandText}::${printConstantType(type)}`

/**
 * An operand of a binary operator, parenthesized unless it binds more tightly, or is the left operand of the same
 * operator, which every operator but a comparison associates to the left: `a + b + c`, `a | b | c`, but `(a >> 1) & 3`.
 */
const operand = (child: ConstantExpr, op: ConstantOperator, side: "left" | "right"): string => {
	const printed = expr(child)
	const chained =
		side === "left" && child.kind === "binary" && child.op === op && operatorLevel[op] !== "compare"
	return tighter(printed.level, operatorLevel[op]) || chained ? printed.text : `(${printed.text})`
}

/** The text of an array literal, each element double-quoted, so an empty element and one holding a comma read back. */
const arrayText = (elements: ReadonlyArray<string>): string =>
	`{${elements.map((e) => `"${e.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`

/**
 * An expression's text and how tightly it binds. SUBSTRING (... FROM ... FOR ...) and NULLIF are SQL syntax, which
 * PostgreSQL's grammar resolves into pg_catalog under every search_path, and VALUE is a keyword.
 */
const expr = (e: ConstantExpr): Printed => {
	switch (e.kind) {
		case "column":
			return {
				text:
					e.table === undefined
						? quoteIdent(e.column)
						: `${quoteIdent(e.table)}.${quoteIdent(e.column)}`,
				level: "atom"
			}
		case "domainValue":
			return { text: "VALUE", level: "atom" }
		case "argument":
			return { text: quoteIdent(e.name), level: "atom" }
		case "int":
			return { text: String(e.value), level: "atom" }
		case "bits":
			return { text: `B'${e.bits.map((bit) => (bit ? "1" : "0")).join("")}'`, level: "atom" }
		case "array":
			return {
				text: castText(quoteString(arrayText(e.elements)), e.type),
				level: "cast"
			}
		case "constant":
			return { text: `${printObjectName(e.function)}()`, level: "atom" }
		case "cast": {
			const inner = expr(e.expr)
			return {
				text: castText(tighter(inner.level, "mul") ? inner.text : `(${inner.text})`, e.type),
				level: "cast"
			}
		}
		case "binary":
			return {
				text: `${operand(e.left, e.op, "left")} ${e.op} ${operand(e.right, e.op, "right")}`,
				level: operatorLevel[e.op]
			}
		case "substring":
			return {
				text: `substring(${printConstantExpr(e.bits)} FROM ${printConstantExpr(e.start)} FOR ${printConstantExpr(e.length)})`,
				level: "atom"
			}
		case "nullif":
			return {
				text: `NULLIF(${printConstantExpr(e.expr)}, ${printConstantExpr(e.absent)})`,
				level: "atom"
			}
		case "subscript":
			return {
				text: `(${printConstantExpr(e.array)})[${printConstantExpr(e.index)}]`,
				level: "atom"
			}
	}
}

export const printConstantExpr = (e: ConstantExpr): string => expr(e).text

const printSeries = (series: Series): string =>
	`${catalogFunction("generate_series")}(0, ${printConstantExpr(binary("-", series.count, int(1)))}) AS ${quoteIdent(series.alias)}(${quoteIdent(series.column)})`

const printCheck = (predicate: ConstantExpr): string =>
	`CHECK ((${printConstantExpr(predicate)}) IS TRUE)`

/** A constant's head, CREATE FUNCTION <name>(<params>) RETURNS <type>. */
const constantHead = (
	name: ObjectName,
	params: ReadonlyArray<ConstantParam>,
	returns: ConstantType
): string =>
	`CREATE FUNCTION ${printObjectName(name)}(${params.map((p) => `${quoteIdent(p.name)} ${printType(p.type)}`).join(", ")}) RETURNS ${printConstantType(returns)}`

/** What every constant is: an SQL function PostgreSQL evaluates once and may run in parallel. */
const constantClauses = "LANGUAGE sql IMMUTABLE PARALLEL SAFE"

/**
 * The dollar-quote tag for a body's lines: `$$` unless a line holds it, then `$gz$`, `$gz1$`, .... No tag holds a
 * newline, so an occurrence in the joined body lies inside one line.
 */
const dollarQuoteTag = (body: ReadonlyArray<string>): string => {
	const free = (tag: string): boolean => !body.some((line) => line.includes(tag))
	if (free("$$")) {
		return "$$"
	}
	if (free("$gz$")) {
		return "$gz$"
	}
	for (let n = 1; ; n++) {
		const tag = `$gz${n}$`
		if (free(tag)) {
			return tag
		}
	}
}

/** The pack's variable, which holds the cells' text. */
const cellsVariable = "cells"

/** The pack's series alias and its column, the cell index. */
const cellIndex = { alias: "g", column: "i" } as const

/** The pack's rows alias, and its payload code column; the key's codes are k1, k2, .... */
const rowsAlias = "r"
const payloadColumn = "c"
const keyColumn = (i: number): string => `k${i + 1}`

/**
 * A row's names as an SQL line comment, each a JSON string: a line break or quote in a name is escaped, so nothing a
 * name holds ends the comment.
 */
const namesComment = (names: NonEmptyReadonlyArray<string>): string =>
	`-- ${names.map((name) => JSON.stringify(name)).join(", ")}`

/**
 * The text format() turns into the constant's CREATE FUNCTION, its value the literal %L quotes: every other % is
 * doubled, so a name holding one is read as itself.
 */
const packedFunction = (fn: ObjectName): string =>
	`${constantHead(fn, [], varbit).replaceAll("%", "%%")} ${constantClauses} RETURN ${castText("%L", varbit)}`

const writePack = (out: Lines, pack: Pack): void => {
	const body: Array<string> = []
	const lines = new BlockLines(body, unit, "")
	const cells = quoteIdent(cellsVariable)
	const series = column(cellIndex.alias, cellIndex.column)
	const payload = printConstantExpr(column(rowsAlias, payloadColumn))
	const count = pack.radices
		.slice(1)
		.reduce<ConstantExpr>(
			(product, radix) => binary("*", product, int(radix)),
			int(pack.radices[0])
		)
	const keys = mapNonEmpty(pack.radices, (radix, i) => ({ name: keyColumn(i), radix }))
	const index = mixedRadix(
		mapNonEmpty(keys, (key) => ({ digit: column(rowsAlias, key.name), radix: key.radix }))
	)
	const columns = [...keys.map((key) => key.name), payloadColumn]
	lines.line("DECLARE")
	lines.nested().line(`${cells} ${printType(types.text)};`)
	lines.line("BEGIN")
	const block = lines.nested()
	block.line(
		`SELECT ${catalogFunction("string_agg")}(${castText(castText(`COALESCE(1 + ${payload}, 0)`, { kind: "bit", length: pack.width }), types.text)}, ${castText(quoteString(""), types.text)} ORDER BY ${printConstantExpr(series)})`
	)
	block.line(`INTO ${cells}`)
	block.line(`FROM ${printSeries({ kind: "series", count, ...cellIndex })}`)
	block.line("LEFT JOIN (VALUES")
	const rows = block.nested()
	for (const [i, row] of pack.rows.entries()) {
		const comma = i === pack.rows.length - 1 ? "" : ","
		rows.line(`(${[...row.key, row.payload].join(", ")})${comma} ${namesComment(row.names)}`)
	}
	block.line(`) AS ${quoteIdent(rowsAlias)}(${columns.map(quoteIdent).join(", ")})`)
	block.line(`ON ${printConstantExpr(binary("=", index, series))};`)
	block.line(
		`EXECUTE ${catalogFunction("format")}(${castText(quoteString(packedFunction(pack.function)), types.text)}, ${cells});`
	)
	lines.line("END")
	const tag = dollarQuoteTag(body)
	out.line(`DO ${tag}`)
	for (const line of body) {
		out.line(line)
	}
	out.line(tag)
}

const printDomainAction = (action: ConstantDomainAction): string => {
	switch (action.kind) {
		case "addConstraint":
			return `ADD CONSTRAINT ${quoteIdent(action.constraint.name)} ${printCheck(action.constraint.predicate)}${action.notValid ? " NOT VALID" : ""}`
		case "validateConstraint":
			return `VALIDATE CONSTRAINT ${quoteIdent(action.name)}`
		case "dropConstraint":
			return `DROP CONSTRAINT ${quoteIdent(action.name)}`
	}
}

const printSetExpression = (action: SetExpression): string =>
	`ALTER COLUMN ${quoteIdent(action.column)} SET EXPRESSION AS (${printConstantExpr(action.expr)})`

/** A statement's lines, written into `out`, laid out as the SQL printer lays out its statements. */
const writeConstantStatement = (out: Lines, statement: ConstantStatement): void => {
	switch (statement.kind) {
		case "pack":
			return writePack(out, statement)
		case "createConstant":
			out.line(constantHead(statement.name, statement.params, statement.returns))
			out.line(constantClauses)
			return out.line(`RETURN ${printConstantExpr(statement.body)}`)
		case "dropConstant":
			return out.line(`DROP FUNCTION ${printFunctionSignature(statement.name)} RESTRICT`)
		case "alterDomain":
			return out.line(
				`ALTER DOMAIN ${printObjectName(statement.name)} ${printDomainAction(statement.action)}`
			)
		case "alterTable": {
			const head = `ALTER TABLE ${printObjectName(statement.table)}`
			if (statement.actions.length === 1) {
				return out.line(`${head} ${printSetExpression(statement.actions[0])}`)
			}
			out.line(head)
			const actions = out.nested()
			for (const [i, action] of statement.actions.entries()) {
				const comma = i === statement.actions.length - 1 ? "" : ","
				actions.line(`${printSetExpression(action)}${comma}`)
			}
			return
		}
	}
}

const constantTextLoc = SourceLoc("SQL statement text", [])

/**
 * One statement's text, without a terminator, refused as ResourceBound past PostgreSQL's longest message, as every
 * statement grizzle prints is (sql/print.ts statementText).
 */
export const printConstantStatement = (statement: ConstantStatement): string =>
	statementText(constantTextLoc, (out) => writeConstantStatement(out, statement))
