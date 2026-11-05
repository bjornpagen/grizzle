/**
 * The SQL of the installation's constants (sql/constants.ts), judged by what it computes, never by golden text but for
 * the migration DDL a person reviews.
 *
 * Two evaluators model the PostgreSQL operators the expressions use, each as varbit.c, int.c, int8.c and arrayfuncs.c
 * define them: integer and bigint arithmetic, which fails "integer out of range" past its type, bitwise and, or and
 * shifts, substring of a bit string, bit to integer, NULLIF, COALESCE, 1-based subscripts and array_in. One walks the
 * builders' AST; the other parses the printed text under PostgreSQL's grammar (gram.y's precedence: comparisons, then
 * the operators of no rule of their own, then + and -, then *, then :: and subscripts), so the printer's
 * parenthesization is judged by what PostgreSQL would compute from it. The oracles:
 *
 * - the encoder (ir/cells.ts): the index a domain computes from a packed cell is rowMajorIndex of its codes, the cell
 *   packCell generates is packCodes of its codes, and the constant the pack's DO block builds is the encoder's bitText;
 * - the naive tuple-set model: an installed row, every code under its roster's domain and the cell under the side's
 *   domain, is accepted exactly when its tuple is one of the relation's, an out-of-range code (the alias, 400 as 37 at
 *   PostgreSQL's scale) included;
 * - PostgreSQL's array_in: a names constant reads back as its handles.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { constantMaxBits } from "#compiler/core/limits.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	bitText,
	constantOf,
	type Layout,
	packCodes,
	rosterConstant,
	type RosterCodes,
	rowMajorIndex,
	type Tuple
} from "#compiler/ir/cells.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { objectName, types } from "#compiler/sql/build.ts"
import {
	applied,
	argument,
	arrayLiteral,
	bitString,
	cast,
	cellAt,
	type ConstantDomainCheck,
	type ConstantExpr,
	type ConstantStatement,
	type ConstantType,
	type CreateConstant,
	column,
	domainValue,
	dropOf,
	inSet,
	int as literal,
	keyIn,
	mixedRadix,
	nameOf,
	type Pack,
	type PackRow,
	packCell,
	pairIn,
	payloadAt,
	printConstantExpr,
	printConstantStatement,
	repoint,
	unpackCell,
	varbit
} from "#compiler/sql/constants.ts"
import { lex, type Token } from "#compiler/sql/lexer.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A value of the evaluation model: an integer of PostgreSQL's integer type or, `wide`, bigint; a bit string; a truth
 * value; a text; an array of texts; NULL; or the error PostgreSQL raises for an integer past its type.
 */
type Value =
	| { readonly kind: "int"; readonly value: bigint; readonly wide: boolean }
	| { readonly kind: "bits"; readonly value: string }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "array"; readonly value: ReadonlyArray<string> }
	| { readonly kind: "null" }
	| { readonly kind: "outOfRange" }

/** What an expression reads: VALUE, the row's columns (NULL where a join found no row), and each constant's value. */
interface Env {
	readonly value: bigint
	readonly columns: ReadonlyMap<string, bigint | null>
	readonly constants: ReadonlyMap<string, Value>
}

const nullValue: Value = { kind: "null" }
const outOfRange: Value = { kind: "outOfRange" }
const boolValue = (value: boolean): Value => ({ kind: "bool", value })

/** An integer of its type, or the error PostgreSQL raises past it. */
const intValue = (value: bigint, wide: boolean): Value => {
	const bits = wide ? 64 : 32
	return BigInt.asIntN(bits, value) === value ? { kind: "int", value, wide } : outOfRange
}

/** An integer literal's type: integer when it fits one, else bigint. */
const literalValue = (value: bigint): Value => intValue(value, BigInt.asIntN(32, value) !== value)

/** A constant's key in an environment: its schema and its name. */
const constantKey = (name: ObjectName): string => `${name.schema}\u0000${name.name}`

/** A column's key in an environment: `table.column`, or the column alone. */
const columnKey = (table: string | undefined, name: string): string =>
	table === undefined ? name : `${table}.${name}`

/** The integer a value holds, failing for any other kind. */
const intOf = (v: Value, what: string): bigint => {
	if (v.kind !== "int") {
		return assert.fail(`${what} is ${v.kind}, not an integer`)
	}
	return v.value
}

/** bittoint4 and bittoint8: the bits read big-endian, the empty string 0; more bits than the type holds is an error. */
const bitsToInt = (bits: string, wide: boolean): Value =>
	bits.length > (wide ? 64 : 32)
		? outOfRange
		: intValue(bits === "" ? 0n : BigInt(`0b${bits}`), wide)

/**
 * bitsubstring: from position s1 = max(start, 1) to e1 = min(start + length, bits + 1), exclusive, counted from 1; the
 * empty string when s1 is past the end or e1 is not after it.
 */
const substringOf = (bits: string, start: bigint, length: bigint): string => {
	const size = BigInt(bits.length)
	const s1 = start > 1n ? start : 1n
	const e = start + length
	const e1 = e < size + 1n ? e : size + 1n
	return s1 > size || e1 <= s1 ? "" : Str.slice(Number(s1 - 1n), Number(e1 - 1n))(bits)
}

/** substring(bits FROM start FOR length): NULL for a NULL operand, an error for one already out of range. */
const substringValue = (bits: Value, start: Value, length: Value): Value => {
	if (start.kind === "outOfRange" || length.kind === "outOfRange") {
		return outOfRange
	}
	if (start.kind === "null" || length.kind === "null" || bits.kind === "null") {
		return nullValue
	}
	if (bits.kind !== "bits") {
		return assert.fail("a substring of no bit string")
	}
	return {
		kind: "bits",
		value: substringOf(bits.value, intOf(start, "a start"), intOf(length, "a length"))
	}
}

/** The operators of the constants' expressions. */
const operators = ["=", ">", "&", "|", "<<", ">>", "+", "-", "*"] as const

type Operator = (typeof operators)[number]

/**
 * One operator on two values: NULL in, NULL out; = compares bit strings or integers; the others are integer
 * arithmetic in the wider operand's type, arithmetic past it an error, shifts wrapping as C's do.
 */
const operate = (op: Operator, left: Value, right: Value): Value => {
	if (left.kind === "outOfRange" || right.kind === "outOfRange") {
		return outOfRange
	}
	if (left.kind === "null" || right.kind === "null") {
		return nullValue
	}
	if (op === "=") {
		if (left.kind === "bits" && right.kind === "bits") {
			return boolValue(left.value === right.value)
		}
		return boolValue(intOf(left, "an operand of =") === intOf(right, "an operand of ="))
	}
	const a = intOf(left, `the left operand of ${op}`)
	const b = intOf(right, `the right operand of ${op}`)
	const wide = (left.kind === "int" && left.wide) || (right.kind === "int" && right.wide)
	const bits = wide ? 64 : 32
	switch (op) {
		case ">":
			return boolValue(a > b)
		case "+":
			return intValue(a + b, wide)
		case "-":
			return intValue(a - b, wide)
		case "*":
			return intValue(a * b, wide)
		case "&":
			return intValue(a & b, wide)
		case "|":
			return intValue(a | b, wide)
		case "<<":
			return { kind: "int", value: BigInt.asIntN(bits, a << b), wide }
		case ">>":
			return { kind: "int", value: a >> b, wide }
	}
}

/** A cast to `type`: integers and bit strings to integer or bigint, texts to text, a literal's text to a name[]. */
const castTo = (inner: Value, type: ConstantType): Value => {
	if (inner.kind === "null" || inner.kind === "outOfRange") {
		return inner
	}
	switch (type.kind) {
		case "builtin":
			if (type.name === "integer" || type.name === "bigint" || type.name === "smallint") {
				const wide = type.name === "bigint"
				if (inner.kind === "bits") {
					return bitsToInt(inner.value, wide)
				}
				return intValue(intOf(inner, "a cast's operand"), wide)
			}
			if (type.name === "text" && (inner.kind === "text" || inner.kind === "bits")) {
				return { kind: "text", value: inner.value }
			}
			return assert.fail(`a cast of a ${inner.kind} to ${type.name}`)
		case "varbit":
			return inner.kind === "bits" ? inner : assert.fail(`a cast of a ${inner.kind} to bit varying`)
		case "bit":
			if (inner.kind === "int") {
				return { kind: "bits", value: lowBits(inner.value, type.length) }
			}
			return inner.kind === "bits" ? inner : assert.fail(`a cast of a ${inner.kind} to bit(n)`)
		case "name":
			return inner.kind === "text" && type.array
				? { kind: "array", value: arrayIn(inner.value) }
				: assert.fail(`a cast of a ${inner.kind} to name`)
		case "named":
			return assert.fail("a cast to a named type")
	}
}

/** int4 to bit(n): the integer's rightmost n bits, as PostgreSQL casts it. */
const lowBits = (value: bigint, n: number): string =>
	Str.padStart(n, "0")(BigInt.asUintN(n, value).toString(2))

/** A subscript: the element at a 1-based index, NULL past either end or at a NULL index. */
const subscript = (array: Value, index: Value): Value => {
	if (index.kind === "outOfRange") {
		return outOfRange
	}
	if (array.kind !== "array") {
		return assert.fail(`a subscript of a ${array.kind}`)
	}
	if (index.kind === "null") {
		return nullValue
	}
	const at = intOf(index, "a subscript")
	const element = at < 1n ? undefined : array.value[Number(at) - 1]
	return element === undefined ? nullValue : { kind: "text", value: element }
}

/** NULLIF(a, b): NULL where a equals b, otherwise a. */
const nullIf = (value: Value, absent: Value): Value => {
	const same = operate("=", value, absent)
	return same.kind === "bool" && same.value ? nullValue : value
}

/**
 * array_in on a one-dimensional array of names: elements between braces, separated by commas, each double-quoted, a
 * backslash escaping the character after it. An unquoted element fails the parse: the printer quotes every one, so a
 * NULL or a name holding a delimiter reads back as itself.
 */
const arrayIn = (text: string): ReadonlyArray<string> => {
	assert.ok(Str.startsWith("{")(text) && Str.endsWith("}")(text), `an array literal: ${text}`)
	const inner = Str.slice(1, -1)(text)
	const elements: Array<string> = []
	let at = 0
	while (at < inner.length) {
		assert.equal(inner[at], '"', `a quoted element at ${at} of ${text}`)
		let element = ""
		at += 1
		while (inner[at] !== '"') {
			if (inner[at] === "\\") {
				at += 1
			}
			element += defined(inner[at], `an element of ${text} is closed`)
			at += 1
		}
		elements.push(element)
		at += 1
		if (at < inner.length) {
			assert.equal(inner[at], ",", `a delimiter at ${at} of ${text}`)
			at += 1
		}
	}
	return elements
}

/** The AST's value, as PostgreSQL evaluates it. */
const evaluate = (e: ConstantExpr, env: Env): Value => {
	switch (e.kind) {
		case "column": {
			const held = env.columns.get(columnKey(e.table, e.column))
			assert.ok(held !== undefined, `the column ${e.column}`)
			return held === null ? nullValue : intValue(held, false)
		}
		case "domainValue":
			return intValue(env.value, true)
		case "int":
			return literalValue(BigInt(e.value))
		case "bits":
			return {
				kind: "bits",
				value: Arr.join(
					Arr.map(e.bits, (bit) => (bit ? "1" : "0")),
					""
				)
			}
		case "array":
			return castTo({ kind: "text", value: arrayText(e.elements) }, e.type)
		case "constant":
			return defined(env.constants.get(constantKey(e.function)), printObjectName(e.function))
		case "cast":
			return castTo(evaluate(e.expr, env), e.type)
		case "binary":
			return operate(e.op, evaluate(e.left, env), evaluate(e.right, env))
		case "substring": {
			const bits = evaluate(e.bits, env)
			const start = evaluate(e.start, env)
			const length = evaluate(e.length, env)
			return substringValue(bits, start, length)
		}
		case "nullif":
			return nullIf(evaluate(e.expr, env), evaluate(e.absent, env))
		case "subscript":
			return subscript(evaluate(e.array, env), evaluate(e.index, env))
		case "argument":
			return assert.fail(`the argument ${e.name}, which no expression evaluated here takes`)
	}
}

/**
 * The array literal's text array_in reads, as PostgreSQL's own array output would spell it: every element quoted, a
 * backslash before a quote or a backslash. The AST evaluator reads an array literal through it, so a printed literal is
 * judged by array_in alone.
 */
const arrayText = (elements: ReadonlyArray<string>): string =>
	`{${Arr.join(
		Arr.map(elements, (e) => `"${Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(e))}"`),
		","
	)}}`

/** The binding power of each binary operator, after gram.y: comparisons loosest, then Op, then + and -, then *. */
const powerOf: { readonly [O in Operator]: number } = {
	"=": 1,
	">": 1,
	"&": 2,
	"|": 2,
	"<<": 2,
	">>": 2,
	"+": 3,
	"-": 3,
	"*": 4
}

const isOperator = (text: string): text is Operator => Arr.some(operators, (op) => op === text)

const lexed = (text: string): ReadonlyArray<Token> => {
	const result = lex(text)
	assert.equal(result.error, undefined, text)
	return result.tokens
}

/**
 * The value of printed text, parsed as PostgreSQL's grammar parses it: precedence climbing over gram.y's levels, every
 * binary operator left-associative but the non-associative comparisons; `::` and subscripts bind tighter than any;
 * SUBSTRING (… FROM … FOR …), NULLIF and COALESCE are SQL syntax; VALUE is a keyword. The whole text must be one
 * expression.
 */
const evaluateTokens = (tokens: ReadonlyArray<Token>, env: Env): Value => {
	let at = 0
	const peek = (): Token | undefined => tokens[at]
	const take = (): Token => {
		const token = defined(tokens[at], `a token at ${at}`)
		at += 1
		return token
	}
	const isPunct = (t: Token | undefined, text: string): boolean =>
		t?.kind === "punct" && t.text === text
	const isWord = (t: Token | undefined, upper: string): boolean =>
		t?.kind === "word" && t.upper === upper
	const expectPunct = (text: string): void => {
		const t = take()
		assert.ok(isPunct(t, text), `${text} expected at token ${at - 1}`)
	}
	const expectWord = (upper: string): void => {
		const t = take()
		assert.ok(isWord(t, upper), `${upper} expected at token ${at - 1}`)
	}
	const quoted = (): string => {
		const t = take()
		return t.kind === "quotedIdent" ? t.text : assert.fail(`a quoted identifier at token ${at - 1}`)
	}
	const typeName = (): ConstantType => {
		const t = take()
		if (t.kind === "word") {
			switch (t.upper) {
				case "INTEGER":
					return types.integer
				case "BIGINT":
					return types.bigint
				case "SMALLINT":
					return types.smallint
				case "BIT": {
					if (isWord(peek(), "VARYING")) {
						take()
						return varbit
					}
					expectPunct("(")
					const length = Number(defined(numberText(take())))
					expectPunct(")")
					return { kind: "bit", length }
				}
				default:
					return assert.fail(`the type ${t.text}`)
			}
		}
		assert.ok(t.kind === "quotedIdent" && t.text === "pg_catalog", "a pg_catalog type")
		expectPunct(".")
		const name = quoted()
		if (name === "text") {
			return types.text
		}
		assert.equal(name, "name", "pg_catalog's name or text")
		expectPunct("[")
		expectPunct("]")
		return { kind: "name", array: true }
	}
	const numberText = (t: Token): string | undefined => (t.kind === "number" ? t.text : undefined)
	const call = (): ReadonlyArray<Value> => {
		expectPunct("(")
		const values = [expression(0)]
		while (isPunct(peek(), ",")) {
			take()
			values.push(expression(0))
		}
		expectPunct(")")
		return values
	}
	const primary = (): Value => {
		const t = take()
		switch (t.kind) {
			case "number":
				return literalValue(BigInt(t.text))
			case "string":
				return t.prefix === "B" ? { kind: "bits", value: t.text } : { kind: "text", value: t.text }
			case "quotedIdent": {
				if (!isPunct(peek(), ".")) {
					const held = env.columns.get(t.text)
					assert.ok(held !== undefined, `the column ${t.text}`)
					return held === null ? nullValue : intValue(held, false)
				}
				take()
				const name = quoted()
				if (isPunct(peek(), "(")) {
					take()
					expectPunct(")")
					return defined(
						env.constants.get(constantKey({ schema: t.text, name })),
						`${t.text}.${name}`
					)
				}
				const held = env.columns.get(`${t.text}.${name}`)
				assert.ok(held !== undefined, `the column ${t.text}.${name}`)
				return held === null ? nullValue : intValue(held, false)
			}
			case "word":
				switch (t.upper) {
					case "VALUE":
						return intValue(env.value, true)
					case "SUBSTRING": {
						expectPunct("(")
						const bits = expression(0)
						expectWord("FROM")
						const start = expression(0)
						expectWord("FOR")
						const length = expression(0)
						expectPunct(")")
						return substringValue(bits, start, length)
					}
					case "NULLIF": {
						const [value, absent] = call()
						return nullIf(defined(value), defined(absent))
					}
					case "COALESCE":
						return Option.getOrElse(
							Arr.findFirst(call(), (v) => v.kind !== "null"),
							() => nullValue
						)
					default:
						return assert.fail(`the word ${t.text}`)
				}
			case "punct": {
				assert.ok(t.text === "(", `a parenthesis at token ${at - 1}`)
				const inner = expression(0)
				expectPunct(")")
				return inner
			}
			case "dollar":
			case "param":
			case "operator":
				return assert.fail(`a ${t.kind} at token ${at - 1}`)
		}
	}
	const postfix = (operand: Value): Value => {
		let value = operand
		for (;;) {
			if (isPunct(peek(), "::")) {
				take()
				value = castTo(value, typeName())
			} else if (isPunct(peek(), "[")) {
				take()
				const index = expression(0)
				expectPunct("]")
				value = subscript(value, index)
			} else {
				return value
			}
		}
	}
	const expression = (minimum: number): Value => {
		let left = postfix(primary())
		for (;;) {
			const t = peek()
			if (t?.kind !== "operator" || !isOperator(t.text) || powerOf[t.text] <= minimum) {
				return left
			}
			take()
			const op = t.text
			left = operate(op, left, expression(powerOf[op]))
		}
	}
	const value = expression(0)
	assert.equal(at, tokens.length, "the text is one expression")
	return value
}

/** The value of an expression's printed text. */
const evaluateText = (e: ConstantExpr, env: Env): Value =>
	evaluateTokens(lexed(printConstantExpr(e)), env)

/** Whether a domain's check holds: CHECK ((predicate) IS TRUE). */
const holds = (v: Value): boolean => v.kind === "bool" && v.value

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant. */
const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
	const origin: ReadonlyArray<ReadonlyArray<number>> = [[]]
	return Arr.reduce(sizes, origin, (prefixes, size) =>
		Arr.flatMap(prefixes, (prefix) =>
			Array.from({ length: size }, (_, digit) => [...prefix, digit])
		)
	)
}

/** A point's digits as one key, for a Map of points and for a report. */
const pointKey = (digits: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(digits, (digit) => `${digit}`),
		","
	)

/** The columns c1, c2, … of a row of codes, as a law's generated cell reads them. */
const codeColumns = (count: number): NonEmptyReadonlyArray<ConstantExpr> =>
	nonEmpty(Array.from({ length: count }, (_, at) => column(undefined, `c${at + 1}`)))

/** A row of codes as the columns c1, c2, …. */
const rowColumns = (codes: ReadonlyArray<number>): ReadonlyMap<string, bigint | null> =>
	new Map(Arr.map(codes, (code, at) => [`c${at + 1}`, BigInt(code)] as const))

const noConstants: ReadonlyMap<string, Value> = new Map()

describe("the index a side's domain reads", () => {
	type Shape = "one coordinate" | "four coordinates" | "a coordinate of one code"

	/** Every key of one to four coordinates of one to three codes each, a law's cell holding at most four: 120 shapes. */
	const shapes: Gen<NonEmptyReadonlyArray<number>> = (s) =>
		nonEmpty(Array.from({ length: s.draw(int(1, 4)) }, () => s.draw(int(1, 3))))

	/**
	 * For every in-range digit tuple, the cell the generated column packs is the encoder's packCodes, and the index the
	 * domain computes from it is the encoder's rowMajorIndex, both by the AST and by its printed text. Oracle: the
	 * encoder.
	 */
	const agreesWithEncoder = (radices: NonEmptyReadonlyArray<number>, c: Case<Shape>) =>
		Effect.sync(() => {
			const index = mixedRadix(unpackCell(domainValue, radices))
			const indexTokens = lexed(printConstantExpr(index))
			const generated = packCell(codeColumns(radices.length))
			const generatedTokens = lexed(printConstantExpr(generated))
			for (const point of odometer(radices)) {
				const row: Env = { value: 0n, columns: rowColumns(point), constants: noConstants }
				const cell = packCodes(point)
				for (const packed of [evaluate(generated, row), evaluateTokens(generatedTokens, row)]) {
					assert.equal(intOf(packed, "a cell"), cell, `the cell of ${pointKey(point)}`)
				}
				const read: Env = { ...row, value: cell }
				const expected = defined(rowMajorIndex(radices, point))
				for (const computed of [evaluate(index, read), evaluateTokens(indexTokens, read)]) {
					assert.equal(intOf(computed, "an index"), expected, `the index of ${pointKey(point)}`)
				}
			}
			if (radices.length === 1) {
				c.note("one coordinate")
			}
			if (radices.length === 4) {
				c.note("four coordinates")
			}
			if (radices.includes(1)) {
				c.note("a coordinate of one code")
			}
		})

	it.effect(
		"is the encoder's row-major index of the codes the generated cell packs, for every in-range tuple",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/constant-index",
						generator: shapes,
						literal: Formatter.format,
						limit: 120,
						coverage: requiredInSpace<Shape>([
							"one coordinate",
							"four coordinates",
							"a coordinate of one code"
						]),
						caseHang
					},
					agreesWithEncoder
				)
			)
	)

	type Wide =
		| "a code past eight bits"
		| "a constant past 2^30 bits"
		| "four coordinates"
		| "a cell of width three"

	interface WideKey {
		readonly radices: NonEmptyReadonlyArray<number>
		readonly width: number
		readonly points: ReadonlyArray<NonEmptyReadonlyArray<number>>
	}

	/**
	 * Keys of roster-sized coordinates, up to 32,768 codes each, whose constant still fits PostgreSQL's longest bit string
	 * at its width (constantMaxBits): the 16-bit digits and int4's top, randomized rather than fixed small. Each case
	 * probes its last point and up to six more.
	 */
	const wideKeys: Gen<WideKey> = (s) => {
		const width = s.draw(int(1, 3))
		const cap = Math.floor(constantMaxBits.value / width)
		const radices: Array<number> = []
		let cells = 1
		const arity = s.draw(int(1, 4))
		for (let at = 0; at < arity; at += 1) {
			const most = Math.min(32_768, Math.floor(cap / cells))
			const radix = s.draw(
				weighted([
					[1, constant(most)],
					[2, int(1, Math.min(7, most))],
					[3, int(1, most)]
				])
			)
			radices.push(radix)
			cells *= radix
		}
		const key = nonEmpty(radices)
		const pointOf: Gen<NonEmptyReadonlyArray<number>> = (t) =>
			mapNonEmpty(key, (r) => t.draw(int(0, r - 1)))
		return {
			radices: key,
			width,
			points: [mapNonEmpty(key, (r) => r - 1), ...s.draw(array(pointOf, { min: 0, max: 6 }))]
		}
	}

	/**
	 * At PostgreSQL's scale too the domain's index is the encoder's, and neither it nor the cell read's start (index * w
	 * + 1) leaves int4 for any in-range tuple of a constant that fits a bit string. Oracle: the encoder, and int4's range.
	 */
	const atScale = ({ radices, width, points }: WideKey, c: Case<Wide>) =>
		Effect.sync(() => {
			const name = objectName("s", "R__wide")
			const read = cellAt(name, mixedRadix(unpackCell(domainValue, radices)), width)
			const readTokens = lexed(printConstantExpr(read))
			const index = mixedRadix(unpackCell(domainValue, radices))
			const constants = new Map<string, Value>([[constantKey(name), { kind: "bits", value: "" }]])
			for (const point of points) {
				const env: Env = { value: packCodes(point), columns: new Map(), constants }
				assert.equal(
					intOf(evaluateText(index, env), "an index"),
					defined(rowMajorIndex(radices, point))
				)
				assert.deepEqual(
					evaluateTokens(readTokens, env),
					{ kind: "bits", value: "" },
					"the start stays in int4"
				)
				if (Arr.some(point, (code) => code > 255)) {
					c.note("a code past eight bits")
				}
			}
			if (Arr.reduce(radices, 1, (cells, r) => cells * r) * width > 2 ** 30) {
				c.note("a constant past 2^30 bits")
			}
			if (radices.length === 4) {
				c.note("four coordinates")
			}
			if (width === 3) {
				c.note("a cell of width three")
			}
		})

	it.effect("is the encoder's index at a roster's whole code space, and stays inside int4", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/constant-index-wide",
					draw: drawn(wideKeys),
					literal: Formatter.format,
					coverage: required<Wide>(
						[
							"a code past eight bits",
							"a constant past 2^30 bits",
							"four coordinates",
							"a cell of width three"
						],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				atScale
			)
		)
	)
})

describe("an installed closed side", () => {
	type Installed =
		| "a set of one code"
		| "a set of two codes"
		| "a function"
		| "a code at a hole"
		| "a code past its roster that aliases a tuple"
		| "a negative code"
		| "int2's greatest code"
		| "an accepted row"

	/** A roster of `codes` codes, a hole wherever `live`, a bit mask, holds 0. */
	interface Roster {
		readonly codes: number
		readonly live: number
	}

	type SideShape = "set of one" | "set of two" | "function"

	interface Side {
		readonly shape: SideShape
		readonly rosters: NonEmptyReadonlyArray<Roster>
		readonly tuples: ReadonlyArray<ReadonlyArray<number>>
	}

	const rosterGen: Gen<Roster> = (s) => {
		const codes = s.draw(int(1, 3))
		return { codes, live: s.draw(int(1, 2 ** codes - 1)) }
	}

	const liveCodes = (roster: Roster): ReadonlyArray<number> =>
		Arr.filter(
			Array.from({ length: roster.codes }, (_, code) => code),
			(code) => ((roster.live >> code) & 1) === 1
		)

	/**
	 * Every closed side over rosters of one to three codes under every hole pattern: every set over one roster, every set
	 * over two, and every function from one roster to another, each tuple of live codes: 2,368 sides.
	 */
	const sides: Gen<Side> = (s) => {
		const shape = s.draw(element<SideShape>(["set of one", "set of two", "function"]))
		const first = s.draw(rosterGen)
		if (shape === "function") {
			const payload = s.draw(rosterGen)
			const payloads = liveCodes(payload)
			const tuples = Arr.flatMap(liveCodes(first), (key): ReadonlyArray<ReadonlyArray<number>> => {
				const chosen = s.draw(int(0, payloads.length))
				return chosen === 0 ? [] : [[key, defined(payloads[chosen - 1])]]
			})
			return { shape, rosters: [first, payload], tuples }
		}
		const rosters: NonEmptyReadonlyArray<Roster> =
			shape === "set of one" ? [first] : [first, s.draw(rosterGen)]
		const tuples = Arr.filter(odometer(Arr.map(rosters, (r) => r.codes)), (point) =>
			Arr.every(point, (code, at) => liveCodes(defined(rosters[at])).includes(code))
		)
		return { shape, rosters, tuples: Arr.filter(tuples, () => s.draw(boolean)) }
	}

	/** The codes each probed column takes: a negative code, every code of its roster, two past it, and int2's greatest. */
	const probes = (roster: Roster): ReadonlyArray<number> => [
		-1,
		...Array.from({ length: roster.codes + 2 }, (_, code) => code),
		32_767
	]

	/**
	 * A row is installed under the side's law as the migration types it: each code column under its roster's domain,
	 * and the generated cell under the side's domain. It is accepted exactly when each code is a live code of its roster
	 * and the tuple is the relation's; a code past its roster whose unchecked index lands on a tuple of the relation (the
	 * alias) is refused by its roster's domain, never accepted as the tuple it aliases. Oracle: the naive tuple-set model.
	 */
	const installed = ({ shape, rosters, tuples }: Side, c: Case<Installed>) =>
		Effect.sync(() => {
			const rosterCodesOf = (roster: Roster): RosterCodes =>
				Array.from({ length: roster.codes }, (_, code) =>
					((roster.live >> code) & 1) === 1
						? { kind: "live", handle: `h${code}` }
						: { kind: "hole" }
				)
			const rosterNames = Arr.map(rosters, (_, at) => objectName("s", `Roster${at}__live`))
			const sideName = objectName("s", "Side__cells")
			const isFunction = shape === "function"
			const keyRadices = isFunction ? [defined(rosters[0]).codes] : Arr.map(rosters, (r) => r.codes)
			const layout: Layout = {
				key: nonEmpty(keyRadices),
				payload: isFunction ? [defined(rosters[1]).codes] : []
			}
			const sideTuples = Arr.map(tuples, (t): Tuple =>
				isFunction ? { key: [defined(t[0])], payload: [defined(t[1])] } : { key: t, payload: [] }
			)
			const encoded = succeeded(constantOf(layout, sideTuples))
			const constants = new Map<string, Value>([
				[constantKey(sideName), { kind: "bits", value: succeeded(bitText(encoded, 1_000_000)) }],
				...Arr.map(rosters, (roster, at): readonly [string, Value] => [
					constantKey(defined(rosterNames[at])),
					{
						kind: "bits",
						value: succeeded(bitText(rosterConstant(rosterCodesOf(roster)), roster.codes))
					}
				])
			])
			const coordinates = unpackCell(domainValue, nonEmpty(Arr.map(rosters, (r) => r.codes)))
			const sideCheck = isFunction
				? pairIn(
						sideName,
						mixedRadix([coordinates[0]]),
						encoded.width,
						defined(coordinates[1]).digit
					)
				: inSet(sideName, mixedRadix(coordinates))
			const sideTokens = lexed(printConstantExpr(sideCheck))
			const rosterTokens = Arr.map(rosterNames, (name) =>
				lexed(printConstantExpr(inSet(name, domainValue)))
			)
			const cellTokens = lexed(printConstantExpr(packCell(codeColumns(rosters.length))))
			const member = new Set(Arr.map(tuples, pointKey))
			for (const row of odometer(Arr.map(rosters, (r) => probes(r).length))) {
				const codes = Arr.map(row, (at, j) => defined(probes(defined(rosters[j]))[at]))
				const columns = rowColumns(codes)
				const rostersHold = Arr.every(codes, (code, j) =>
					holds(
						evaluateTokens(defined(rosterTokens[j]), { value: BigInt(code), columns, constants })
					)
				)
				const cell = evaluateTokens(cellTokens, { value: 0n, columns, constants })
				const sideHolds = holds(
					evaluateTokens(sideTokens, { value: intOf(cell, "a cell"), columns, constants })
				)
				const expected =
					member.has(pointKey(codes)) &&
					Arr.every(codes, (code, j) => liveCodes(defined(rosters[j])).includes(code))
				assert.equal(rostersHold && sideHolds, expected, `the row ${pointKey(codes)}`)
				if (expected) {
					c.note("an accepted row")
				}
				if (sideHolds && !expected) {
					c.note("a code past its roster that aliases a tuple")
				}
				if (
					Arr.some(
						codes,
						(code, j) =>
							code >= 0 &&
							code < defined(rosters[j]).codes &&
							!liveCodes(defined(rosters[j])).includes(code)
					)
				) {
					c.note("a code at a hole")
				}
				if (codes.includes(-1)) {
					c.note("a negative code")
				}
				if (codes.includes(32_767)) {
					c.note("int2's greatest code")
				}
			}
			c.note(
				shape === "set of one"
					? "a set of one code"
					: shape === "set of two"
						? "a set of two codes"
						: "a function"
			)
		})

	it.effect(
		"accepts exactly the rows of the relation, every code under its roster's domain, and aliases none",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/constant-installed",
						generator: sides,
						literal: Formatter.format,
						limit: 2368,
						coverage: requiredInSpace<Installed>([
							"a set of one code",
							"a set of two codes",
							"a function",
							"a code at a hole",
							"a code past its roster that aliases a tuple",
							"a negative code",
							"int2's greatest code",
							"an accepted row"
						]),
						caseHang
					},
					installed
				)
			)
	)
})

describe("a constant's reads", () => {
	type Read =
		| "a set"
		| "a function"
		| "four coordinates"
		| "a present key"
		| "an absent key"
		| "a read past either end"

	interface Relation {
		readonly layout: Layout
		readonly tuples: ReadonlyArray<Tuple>
		readonly probes: ReadonlyArray<ReadonlyArray<number>>
	}

	/**
	 * A relation over a key of one to four coordinates of one to seven codes and a payload of none or one coordinate of
	 * up to seven (w up to 3), its tuples drawn at random, and up to four probed keys beside its own.
	 */
	const relations: Gen<Relation> = (s) => {
		const key = nonEmpty(Array.from({ length: s.draw(int(1, 4)) }, () => s.draw(int(1, 7))))
		const payload = s.draw(element<ReadonlyArray<number>>([[], [1], [3], [7]]))
		const payloads = odometer(payload)
		const pointOf: Gen<ReadonlyArray<number>> = (t) => Arr.map(key, (r) => t.draw(int(0, r - 1)))
		const keys = s.draw(array(pointOf, { min: 0, max: 8 }))
		const drawnTuples: ReadonlyArray<Tuple> = Arr.map(keys, (k) => ({
			key: k,
			payload: defined(payloads[s.draw(int(0, payloads.length - 1))])
		}))
		const tuples = Arr.dedupeWith(drawnTuples, (a, b) => pointKey(a.key) === pointKey(b.key))
		return { layout: { key, payload }, tuples, probes: s.draw(array(pointOf, { min: 0, max: 4 })) }
	}

	/**
	 * Over the encoder's constant, a present key's cell is its 1 + payload code, keyIn holds, applied is its payload code,
	 * pairIn holds for its payload, and the dictionary gives its payload's value; an absent key, or an index past either
	 * end, reads absent: keyIn false, applied NULL, the dictionary NULL; a set's inSet is membership. By the AST and by
	 * its printed text. Oracle: the naive tuple-set model.
	 */
	const reads = ({ layout, tuples, probes }: Relation, c: Case<Read>) =>
		Effect.sync(() => {
			const name = objectName("s", "R__3f9c0a")
			const dictionary = objectName("s", "R__payload__77d2e1")
			const constantValue = succeeded(constantOf(layout, tuples))
			const width = constantValue.width
			const text = succeeded(bitText(constantValue, 10_000_000))
			const payloadValues = Arr.map(odometer(layout.payload), (p) => `v${pointKey(p)}`)
			const constants = new Map<string, Value>([
				[constantKey(name), { kind: "bits", value: text }],
				[constantKey(dictionary), { kind: "array", value: payloadValues }]
			])
			const held = new Map(Arr.map(tuples, (t) => [pointKey(t.key), t] as const))
			const payloadCode = (t: Tuple): number =>
				Number(defined(rowMajorIndex(layout.payload, t.payload)))
			const both = (e: ConstantExpr, env: Env): Value => {
				const byAst = evaluate(e, env)
				assert.deepEqual(evaluateText(e, env), byAst, `the printed text of ${printConstantExpr(e)}`)
				return byAst
			}
			const index = column(undefined, "i")
			for (const key of [...Arr.map(tuples, (t) => t.key), ...probes]) {
				const at = defined(rowMajorIndex(layout.key, key))
				const tuple = held.get(pointKey(key))
				c.note(tuple === undefined ? "an absent key" : "a present key")
				const env: Env = { value: 0n, columns: new Map([["i", at]]), constants }
				const code = tuple === undefined ? undefined : payloadCode(tuple)
				assert.deepEqual(both(keyIn(name, index, width), env), boolValue(tuple !== undefined))
				assert.deepEqual(
					both(applied(name, index, width), env),
					code === undefined ? nullValue : intValue(BigInt(code), false),
					"an absent key applies to NULL"
				)
				assert.deepEqual(
					both(pairIn(name, index, width, literal(code ?? 0)), env),
					boolValue(code !== undefined)
				)
				assert.deepEqual(
					both(payloadAt(dictionary, name, index, width), env),
					code === undefined ? nullValue : { kind: "text", value: defined(payloadValues[code]) },
					"cell 1 + c is the dictionary's value for code c"
				)
				if (layout.payload.length === 0) {
					assert.deepEqual(both(inSet(name, index), env), boolValue(tuple !== undefined))
				}
			}
			const cells = BigInt(odometer(layout.key).length)
			for (const outside of [-1n, cells]) {
				c.note("a read past either end")
				const env: Env = { value: 0n, columns: new Map([["i", outside]]), constants }
				assert.deepEqual(both(keyIn(name, index, width), env), boolValue(false))
				assert.deepEqual(both(applied(name, index, width), env), nullValue)
			}
			c.note(layout.payload.length === 0 ? "a set" : "a function")
			if (layout.key.length === 4) {
				c.note("four coordinates")
			}
		})

	it.effect(
		"read every key of the encoder's constant as the relation holds it, and nothing past either end",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/constant-reads",
						draw: drawn(relations),
						literal: Formatter.format,
						coverage: required<Read>(
							[
								"a set",
								"a function",
								"four coordinates",
								"a present key",
								"an absent key",
								"a read past either end"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					reads
				)
			)
	)
})

describe("the printer", () => {
	type Printed =
		| "a cell packed"
		| "a cell unpacked"
		| "a function applied"
		| "a dictionary read"
		| "a name read"
		| "an integer past int4"

	/** The constants an expression reads, by name. */
	const bitsName = objectName("s", 'B"its')
	const dictionaryName = objectName("s", "D__1")
	const namesName = objectName("s", "N__2")

	const leaf: Gen<ConstantExpr> = oneOf([
		(t) => literal(t.draw(oneOf([int(0, 70_000), constant(2 ** 31 - 1)]))),
		constant(column(undefined, "x")),
		constant(column("t", "y")),
		constant(domainValue)
	])

	/**
	 * An integer expression the builders make, nested up to `depth` deep: integers (some at int4's top), the row's
	 * columns, VALUE, a cell packed from up to four of them, an index unpacked from a bigint cell, a function applied, and
	 * casts to integer and bigint. A cell is unpacked only from a bigint, as every domain unpacks its int8 VALUE.
	 */
	const integer = (depth: number): Gen<ConstantExpr> => {
		if (depth === 0) {
			return leaf
		}
		const inner = integer(depth - 1)
		const wide: Gen<ConstantExpr> = oneOf([
			constant(domainValue),
			(t) => packCell(nonEmpty(Array.from({ length: t.draw(int(1, 4)) }, () => t.draw(inner)))),
			(t) => cast(t.draw(inner), types.bigint)
		])
		return oneOf<ConstantExpr>([
			leaf,
			(t) => packCell(nonEmpty(Array.from({ length: t.draw(int(1, 4)) }, () => t.draw(inner)))),
			(t) =>
				mixedRadix(
					unpackCell(
						t.draw(wide),
						nonEmpty(Array.from({ length: t.draw(int(1, 4)) }, () => t.draw(int(1, 400))))
					)
				),
			(t) => applied(bitsName, t.draw(inner), t.draw(int(1, 4))),
			(t) => cast(t.draw(inner), t.draw(element([types.integer, types.bigint])))
		])
	}

	/** An expression of any type the builders make, over integer expressions up to three deep: every read of a constant. */
	const expression: Gen<ConstantExpr> = (s) => {
		const index = integer(3)
		const width = s.draw(int(1, 4))
		return s.draw(
			oneOf<ConstantExpr>([
				index,
				(t) => cellAt(bitsName, t.draw(index), width),
				(t) => keyIn(bitsName, t.draw(index), width),
				(t) => inSet(bitsName, t.draw(index)),
				(t) => pairIn(bitsName, t.draw(index), width, t.draw(index)),
				(t) => payloadAt(dictionaryName, bitsName, t.draw(index), width),
				(t) => nameOf(namesName, t.draw(index))
			])
		)
	}

	interface Printing {
		readonly expr: ConstantExpr
		readonly env: Env
	}

	const printings: Gen<Printing> = (s) => {
		const bits = Arr.join(
			Array.from({ length: s.draw(int(0, 40)) }, () => (s.draw(boolean) ? "1" : "0")),
			""
		)
		return {
			expr: s.draw(expression),
			env: {
				value: BigInt(s.draw(int(0, 2 ** 31))) * BigInt(s.draw(int(0, 2 ** 31))),
				columns: new Map([
					["x", BigInt(s.draw(int(0, 40)))],
					["t.y", BigInt(s.draw(int(0, 40)))]
				]),
				constants: new Map<string, Value>([
					[constantKey(bitsName), { kind: "bits", value: bits }],
					[constantKey(dictionaryName), { kind: "array", value: ["p", "q", "r"] }],
					[constantKey(namesName), { kind: "array", value: ["text", "", "ws"] }]
				])
			}
		}
	}

	/**
	 * What the printed text means under PostgreSQL's grammar is what the AST means, errors included: no parenthesis the
	 * printer leaves out regroups an operator, and none it puts in is needed for that. Oracle: the AST evaluator, the
	 * second implementation of the same expression.
	 */
	const meaning = ({ expr, env }: Printing, c: Case<Printed>) =>
		Effect.sync(() => {
			const text = printConstantExpr(expr)
			const byAst = evaluate(expr, env)
			assert.deepEqual(evaluateTokens(lexed(text), env), byAst, text)
			if (Str.includes("<<")(text)) {
				c.note("a cell packed")
			}
			if (Str.includes("65535")(text)) {
				c.note("a cell unpacked")
			}
			if (Str.includes("NULLIF")(text)) {
				c.note("a function applied")
			}
			if (Str.includes('"D__1"')(text)) {
				c.note("a dictionary read")
			}
			if (Str.includes('"N__2"')(text)) {
				c.note("a name read")
			}
			if (byAst.kind === "outOfRange") {
				c.note("an integer past int4")
			}
		})

	it.effect("prints text whose meaning under PostgreSQL's precedence is the AST's", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/constant-printer",
					draw: drawn(printings),
					literal: Formatter.format,
					coverage: required<Printed>(
						[
							"a cell packed",
							"a cell unpacked",
							"a function applied",
							"a dictionary read",
							"a name read",
							"an integer past int4"
						],
						{ cases: 500, sense: notesOnly }
					),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				meaning
			)
		)
	)
})

/** Names a printer must quote and escape: quotes, dollar quotes, percent signs, a comment opener, a non-ASCII letter. */
const identifiers = ["s", "R__3f9c0a", 'a"b', "50%", "%L", "$$", "$gz$", "x'y", "--", "ü"] as const

/** The marker a handle holds after a line break: it must never lex as a word of the pack's body. */
const leak = "LEAKED"

/** Handles a constant names: line breaks of both kinds, quotes, dollar quotes, comment closers, percent signs, delimiters. */
const handleGen: Gen<string> = element([
	"ws",
	`a\n${leak}`,
	`b\r${leak}`,
	`c\r\n${leak}`,
	"$$",
	"$gz$",
	"'",
	'"',
	"\\",
	"*/",
	"/*",
	"%L",
	"",
	"NULL",
	"a,b",
	"{x}",
	" ",
	"ü"
] as const)

describe("a roster's names", () => {
	type Named = "a hole" | "a quote" | "a backslash" | "a delimiter" | "the word NULL"

	/** A roster's handles, a hole the empty name: one to five drawn from the handles a printer must escape. */
	const handleLists: Gen<NonEmptyReadonlyArray<string>> = (s) =>
		nonEmpty(Array.from({ length: s.draw(int(1, 5)) }, () => s.draw(handleGen)))

	/**
	 * The names constant's printed literal reads back through array_in as exactly the roster's handles, and the decode
	 * reads code c as handle c, a hole as the empty name, and NULL past either end. Oracle: PostgreSQL's array_in.
	 */
	const decodes = (handles: NonEmptyReadonlyArray<string>, c: Case<Named>) =>
		Effect.sync(() => {
			const names = objectName("s", "node_kind__names__77d2e1")
			const literalExpr = arrayLiteral(handles, { kind: "name", array: true })
			const read = evaluateText(literalExpr, {
				value: 0n,
				columns: new Map(),
				constants: noConstants
			})
			assert.deepEqual(read, { kind: "array", value: handles })
			const constants = new Map([[constantKey(names), read]])
			const decode = nameOf(names, column(undefined, "code"))
			for (let code = -1; code <= handles.length; code += 1) {
				const handle = handles[code]
				assert.deepEqual(
					evaluateText(decode, {
						value: 0n,
						columns: new Map([["code", BigInt(code)]]),
						constants
					}),
					handle === undefined ? nullValue : { kind: "text", value: handle },
					`code ${code}`
				)
			}
			if (handles.includes("")) {
				c.note("a hole")
			}
			if (Arr.some(handles, (h) => Str.includes('"')(h) || Str.includes("'")(h))) {
				c.note("a quote")
			}
			if (Arr.some(handles, (h) => Str.includes("\\")(h))) {
				c.note("a backslash")
			}
			if (Arr.some(handles, (h) => Str.includes(",")(h) || Str.includes("{")(h))) {
				c.note("a delimiter")
			}
			if (handles.includes("NULL")) {
				c.note("the word NULL")
			}
		})

	it.effect("read back through array_in as the handles, each code decoding to its handle", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/constant-names",
					draw: drawn(handleLists),
					literal: Formatter.format,
					coverage: required<Named>(
						["a hole", "a quote", "a backslash", "a delimiter", "the word NULL"],
						{
							cases: 300,
							sense: notesOnly
						}
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				decodes
			)
		)
	)
})

/** format's reading of the template the pack executes: %% is one %, %L the literal, and any other % a conversion. */
const formatted = (template: string, literalText: string): string => {
	let out = ""
	let i = 0
	while (i < template.length) {
		const ch = Str.slice(i, i + 1)(template)
		const next = Str.slice(i + 1, i + 2)(template)
		if (ch !== "%") {
			out += ch
			i += 1
		} else if (next === "%") {
			out += "%"
			i += 2
		} else if (next === "L") {
			out += literalText
			i += 2
		} else {
			return assert.fail(`format reads %${next} as a conversion`)
		}
	}
	return out
}

const isWordToken = (t: Token | undefined, upper: string): boolean =>
	t?.kind === "word" && t.upper === upper

const isPunctToken = (t: Token | undefined, text: string): boolean =>
	t?.kind === "punct" && t.text === text

describe("a pack", () => {
	type PackFeature =
		| "a dollar quote other than $$"
		| "a percent sign in a name"
		| "a line break in a handle"
		| "a function"
		| "four coordinates"

	interface Packing {
		readonly schema: string
		readonly function: string
		readonly radices: NonEmptyReadonlyArray<number>
		readonly width: number
		readonly rows: NonEmptyReadonlyArray<PackRow>
	}

	/**
	 * A relation to pack: one to four key coordinates of one to five codes, cells of one to three bits, one to five rows
	 * of distinct keys, each named by handles a comment must hold, under a schema and function name the printer must
	 * quote.
	 */
	const packings: Gen<Packing> = (s) => {
		const radices = nonEmpty(Array.from({ length: s.draw(int(1, 4)) }, () => s.draw(int(1, 5))))
		const width = s.draw(int(1, 3))
		const rowOf: Gen<PackRow> = (t) => ({
			key: mapNonEmpty(radices, (r) => t.draw(int(0, r - 1))),
			payload: t.draw(int(0, 2 ** width - 2)),
			names: nonEmpty(Array.from({ length: t.draw(int(1, 3)) }, () => t.draw(handleGen)))
		})
		const rows = Arr.dedupeWith(
			[s.draw(rowOf), ...s.draw(array(rowOf, { min: 0, max: 4 }))],
			(a, b) => pointKey(a.key) === pointKey(b.key)
		)
		return {
			schema: s.draw(element(identifiers)),
			function: s.draw(element(identifiers)),
			radices,
			width,
			rows: nonEmpty(rows)
		}
	}

	/** The tokens from `from` up to the first `,` or `)` at depth 0, and where that delimiter is. */
	const until = (
		tokens: ReadonlyArray<Token>,
		from: number,
		stops: ReadonlyArray<string>
	): number => {
		let depth = 0
		for (let at = from; at < tokens.length; at += 1) {
			const t = defined(tokens[at])
			if (t.kind === "punct" && (t.text === "(" || t.text === "[")) {
				depth += 1
			} else if (t.kind === "punct" && depth === 0 && stops.includes(t.text)) {
				return at
			} else if (t.kind === "punct" && (t.text === ")" || t.text === "]")) {
				depth -= 1
			}
		}
		return assert.fail(`no ${Arr.join(stops, " or ")} after token ${from}`)
	}

	/** The position of the first word `upper` from `from`. */
	const wordAt = (tokens: ReadonlyArray<Token>, from: number, upper: string): number =>
		Option.getOrElse(
			Arr.findFirstIndex(tokens, (t, at) => at >= from && isWordToken(t, upper)),
			() => assert.fail(`no ${upper} after token ${from}`)
		)

	/**
	 * The printed DO block is one statement whose body lexes whole, its rows' names held in comments; PostgreSQL, running
	 * it, would build exactly the encoder's bit text: its series counts the key space, each VALUES row is a row of codes,
	 * its join puts each row at the encoder's index, each cell is 1 + c in w bits, and the format template creates the
	 * named function returning the text. Oracle: the encoder (constantOf, bitText, rowMajorIndex), the lexer, and format's
	 * reading of %.
	 */
	const builds = (p: Packing, c: Case<PackFeature>) =>
		Effect.sync(() => {
			const fn = objectName(p.schema, p.function)
			const pack: Pack = {
				kind: "pack",
				function: fn,
				radices: p.radices,
				width: p.width,
				rows: p.rows
			}
			const text = printConstantStatement(pack)
			const tokens = lexed(text)
			assert.equal(tokens.length, 2, text)
			assert.ok(isWordToken(tokens[0], "DO"), text)
			const body = defined(tokens[1], text)
			assert.ok(body.kind === "dollar", text)
			const inner = lexed(body.body)
			assert.ok(!Arr.some(inner, (t) => isWordToken(t, leak)), body.body)
			const keyColumns = Arr.map(p.radices, (_, at) => `k${at + 1}`)
			const seriesAt = Option.getOrElse(
				Arr.findFirstIndex(inner, (t) => t.kind === "quotedIdent" && t.text === "generate_series"),
				() => assert.fail("a generate_series")
			)
			const last = inner.slice(seriesAt + 4, until(inner, seriesAt + 4, [")"]))
			const cells = odometer(p.radices).length
			assert.equal(
				intOf(
					evaluateTokens(last, { value: 0n, columns: new Map(), constants: noConstants }),
					"the series' end"
				),
				BigInt(cells - 1)
			)
			const valuesAt = wordAt(inner, 0, "VALUES")
			const stated: Array<ReadonlyArray<bigint>> = []
			let at = valuesAt + 1
			while (isPunctToken(inner[at], "(")) {
				const end = until(inner, at + 1, [")"])
				stated.push(
					Arr.flatMap(inner.slice(at + 1, end), (t) =>
						t.kind === "number" ? [BigInt(t.text)] : []
					)
				)
				at = end + 1
				if (isPunctToken(inner[at], ",")) {
					at += 1
				}
			}
			assert.deepEqual(
				stated,
				Arr.map(p.rows, (row) => Arr.map([...row.key, row.payload], (code) => BigInt(code)))
			)
			const onAt = wordAt(inner, at, "ON")
			const on = inner.slice(onAt + 1, until(inner, onAt + 1, [";"]))
			const equalsAt = on.length - 4
			assert.ok(defined(on[equalsAt]).kind === "operator", "the join's condition is index = g.i")
			const indexTokens = on.slice(0, equalsAt)
			const selectAt = Option.getOrElse(
				Arr.findFirstIndex(inner, (t) => t.kind === "quotedIdent" && t.text === "string_agg"),
				() => assert.fail("a string_agg")
			)
			const cellTokens = inner.slice(selectAt + 2, until(inner, selectAt + 2, [","]))
			const byIndex = new Map<bigint, PackRow>()
			for (const row of p.rows) {
				const columns = new Map<string, bigint | null>([
					...Arr.map(row.key, (code, j) => [`r.${defined(keyColumns[j])}`, BigInt(code)] as const),
					["r.c", BigInt(row.payload)]
				])
				const index = intOf(
					evaluateTokens(indexTokens, { value: 0n, columns, constants: noConstants }),
					"a row's index"
				)
				assert.equal(
					index,
					defined(rowMajorIndex(p.radices, row.key)),
					`the row ${pointKey(row.key)}`
				)
				for (const g of [index - 1n, index, index + 1n]) {
					const joined = evaluateTokens(on, {
						value: 0n,
						columns: new Map([...columns, ["g.i", g]]),
						constants: noConstants
					})
					assert.equal(holds(joined), g === index, `the join at ${g}`)
				}
				byIndex.set(index, row)
			}
			const cellText = (i: number): string => {
				const row = byIndex.get(BigInt(i))
				const value = evaluateTokens(cellTokens, {
					value: 0n,
					columns: new Map([
						["r.c", row === undefined ? null : BigInt(row.payload)],
						["g.i", BigInt(i)]
					]),
					constants: noConstants
				})
				return value.kind === "text" ? value.value : assert.fail("a cell's text")
			}
			const built = Arr.join(
				Array.from({ length: cells }, (_, i) => cellText(i)),
				""
			)
			const constantValue = succeeded(
				constantOf(
					{ key: p.radices, payload: [2 ** p.width - 1] },
					Arr.map(p.rows, (row): Tuple => ({ key: row.key, payload: [row.payload] }))
				)
			)
			assert.equal(constantValue.width, p.width)
			assert.equal(built, succeeded(bitText(constantValue, 10_000_000)))
			const formatAt = Option.getOrElse(
				Arr.findFirstIndex(
					inner,
					(t, i) =>
						t.kind === "quotedIdent" && t.text === "format" && inner[i + 1]?.kind === "punct"
				),
				() => assert.fail("a format")
			)
			const template = inner[formatAt + 2]
			assert.ok(template?.kind === "string", body.body)
			assert.equal(
				formatted(template.text, "'01'"),
				`CREATE FUNCTION ${printObjectName(fn)}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN '01'::bit varying`
			)
			lexed(printConstantStatement({ kind: "dropConstant", name: { ...fn, args: [] } }))
			if (body.tag !== "$$") {
				c.note("a dollar quote other than $$")
			}
			if (Str.includes("%")(`${p.schema}${p.function}`)) {
				c.note("a percent sign in a name")
			}
			if (Arr.some(p.rows, (row) => Arr.some(row.names, (h) => Str.includes(leak)(h)))) {
				c.note("a line break in a handle")
			}
			if (p.width > 1) {
				c.note("a function")
			}
			if (p.radices.length === 4) {
				c.note("four coordinates")
			}
		})

	it.effect(
		"prints a DO block that builds the encoder's constant and creates the function named for it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/constant-pack",
						draw: drawn(packings),
						literal: Formatter.format,
						coverage: required<PackFeature>(
							[
								"a dollar quote other than $$",
								"a percent sign in a name",
								"a line break in a handle",
								"a function",
								"four coordinates"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					builds
				)
			)
	)
})

/** The type of a roster's names constant. */
const nameArray: ConstantType = { kind: "name", array: true }

describe("the migration's text, as a person reviews it", () => {
	it("packs a relation of codes in one DO block, its rows named in comments", () => {
		const pack: Pack = {
			kind: "pack",
			function: objectName("qti", "Admission__3f9c0a"),
			radices: [2, 363, 363],
			width: 1,
			rows: [
				{ key: [0, 12, 40], payload: 0, names: ["3.0.0", "qti-assessment-item", "ws"] },
				{ key: [0, 12, 41], payload: 0, names: ["3.0.0", "qti-assessment-item", "comment"] }
			]
		}
		assert.equal(
			printConstantStatement(pack),
			Arr.join(
				[
					"DO $$",
					"DECLARE",
					'  "cells" "pg_catalog"."text";',
					"BEGIN",
					'  SELECT "pg_catalog"."string_agg"(COALESCE(1 + "r"."c", 0)::bit(1)::"pg_catalog"."text", \'\'::"pg_catalog"."text" ORDER BY "g"."i")',
					'  INTO "cells"',
					'  FROM "pg_catalog"."generate_series"(0, 2 * 363 * 363 - 1) AS "g"("i")',
					"  LEFT JOIN (VALUES",
					'    (0, 12, 40, 0), -- "3.0.0", "qti-assessment-item", "ws"',
					'    (0, 12, 41, 0) -- "3.0.0", "qti-assessment-item", "comment"',
					'  ) AS "r"("k1", "k2", "k3", "c")',
					'  ON ("r"."k1" * 363 + "r"."k2") * 363 + "r"."k3" = "g"."i";',
					'  EXECUTE "pg_catalog"."format"(\'CREATE FUNCTION "qti"."Admission__3f9c0a"() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN %L::bit varying\'::"pg_catalog"."text", "cells");',
					"END",
					"$$"
				],
				"\n"
			)
		)
	})

	it("types a roster's codes by a domain over its live codes, re-pointed and dropped as the migration does it", () => {
		const roster = objectName("qti", "NodeKind")
		const created: CreateConstant = {
			kind: "createConstant",
			name: objectName("qti", "NodeKind__3f9c0a"),
			params: [],
			returns: varbit,
			body: cast(bitString([true, true, false, true]), varbit)
		}
		const live: ConstantDomainCheck = {
			name: "NodeKind__live",
			predicate: inSet(created.name, domainValue)
		}
		const statements: ReadonlyArray<ConstantStatement> = [
			created,
			...repoint(roster, live),
			dropOf({ ...created, name: objectName("qti", "NodeKind__91be04") })
		]
		assert.deepEqual(Arr.map(statements, printConstantStatement), [
			Arr.join(
				[
					'CREATE FUNCTION "qti"."NodeKind__3f9c0a"() RETURNS bit varying',
					"LANGUAGE sql IMMUTABLE PARALLEL SAFE",
					"RETURN B'1101'::bit varying"
				],
				"\n"
			),
			'ALTER DOMAIN "qti"."NodeKind" DROP CONSTRAINT "NodeKind__live"',
			'ALTER DOMAIN "qti"."NodeKind" ADD CONSTRAINT "NodeKind__live" CHECK ((substring("qti"."NodeKind__3f9c0a"() FROM VALUE + 1 FOR 1) = B\'1\') IS TRUE) NOT VALID',
			'ALTER DOMAIN "qti"."NodeKind" VALIDATE CONSTRAINT "NodeKind__live"',
			'DROP FUNCTION "qti"."NodeKind__91be04"() RESTRICT'
		])
	})

	it("decodes a code through its roster's names constant, the decode function dropped by its signature", () => {
		const names: CreateConstant = {
			kind: "createConstant",
			name: objectName("qti", "node_kind__names__77d2e1"),
			params: [],
			returns: nameArray,
			body: arrayLiteral(["text", "ws", "", 'a"b\\c'], nameArray)
		}
		const decode: CreateConstant = {
			kind: "createConstant",
			name: objectName("qti", "node_kind_name"),
			params: [{ name: "code", type: types.smallint }],
			returns: types.text,
			body: nameOf(names.name, argument("code"))
		}
		assert.deepEqual(Arr.map([names, decode, dropOf(decode)], printConstantStatement), [
			Arr.join(
				[
					'CREATE FUNCTION "qti"."node_kind__names__77d2e1"() RETURNS "pg_catalog"."name"[]',
					"LANGUAGE sql IMMUTABLE PARALLEL SAFE",
					'RETURN \'{"text","ws","","a\\"b\\\\c"}\'::"pg_catalog"."name"[]'
				],
				"\n"
			),
			Arr.join(
				[
					'CREATE FUNCTION "qti"."node_kind_name"("code" smallint) RETURNS "pg_catalog"."text"',
					"LANGUAGE sql IMMUTABLE PARALLEL SAFE",
					'RETURN ("qti"."node_kind__names__77d2e1"())["code" + 1]::"pg_catalog"."text"'
				],
				"\n"
			),
			'DROP FUNCTION "qti"."node_kind_name"(smallint) RESTRICT'
		])
	})

	it("re-points a table's derived columns in one rewrite", () => {
		const order = objectName("qti", "Order__5d1e2a")
		const kind = column(undefined, "kind")
		assert.equal(
			printConstantStatement({
				kind: "alterTable",
				table: objectName("qti", "node"),
				actions: [
					{ kind: "setExpression", column: "rank", expr: applied(order, kind, 4) },
					{
						kind: "setExpression",
						column: "max",
						expr: payloadAt(objectName("qti", "Order__max__0c3b9f"), order, kind, 4)
					}
				]
			}),
			Arr.join(
				[
					'ALTER TABLE "qti"."node"',
					'  ALTER COLUMN "rank" SET EXPRESSION AS (NULLIF(substring("qti"."Order__5d1e2a"() FROM "kind" * 4 + 1 FOR 4)::integer, 0) - 1),',
					'  ALTER COLUMN "max" SET EXPRESSION AS (("qti"."Order__max__0c3b9f"())[substring("qti"."Order__5d1e2a"() FROM "kind" * 4 + 1 FOR 4)::integer])'
				],
				"\n"
			)
		)
	})
})
