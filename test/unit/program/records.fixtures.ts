/**
 * What the properties of records.test.ts read: a schema of a relation holding a field of every type a column of a
 * query's heading may be stored as, the flat queries over it a property's box draws, and the program each binds.
 */
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { Array as Arr, Record as Rcd } from "effect"
import { rowOptions } from "#adapter/engine.ts"
import { readProgram } from "#adapter/reader/run.ts"
import type { BindContext, Layout } from "#compiler/core/decoder.ts"
import { codeNames } from "#compiler/ir/codes.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/compile.ts"
import {
	bits,
	bytes,
	closedId,
	contract,
	date,
	Decimal,
	Money,
	natural,
	pg,
	span,
	uuid
} from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, type QueryValue, v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import type { HeadValue } from "#compiler/types/query/terms.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"

/** The roster a closed id, a closed id of a subset and a set over it are over. */
export const Tier = closed.ordered("Tier", ["Low", "Mid", "High"])

/** A contract over a uuid, and one over a bigint: a column's brand and check are its contract's. */
const Account = contract("Account", uuid)
const Cents = contract("Cents", pg.bigint)

/**
 * A field of every type a stored column may be: each pg integer, a numeric of a scale, of scale 0 and of no typmod,
 * both floats, money, a boolean, a date, a contract over uuid and over bigint, two refined texts, a closed id of the roster
 * and of a subset of it, a set over it, a span over integer, bigint and date, a vector, bytes and natural.
 */
export const Item = relation(
	"Item",
	{
		id: pg.integer,
		small: pg.smallint,
		int: pg.integer,
		big: pg.bigint,
		dec: pg.numeric(10, 2),
		whole: pg.numeric(12, 0),
		num: pg.numeric,
		real: pg.real,
		dbl: pg["double precision"],
		cash: pg.money,
		flag: pg.boolean,
		day: date,
		account: Account,
		cents: Cents,
		word: str.regex("^[a-z]+$"),
		name: str.regex("^[a-z]*$"),
		tier: closedId(Tier),
		lowMid: closedId(Tier, { only: ["Low", "Mid"] }),
		tiers: bits(Tier),
		during: span(pg.integer),
		window: span(pg.bigint),
		days: span(date),
		vec: pg.vector(3),
		blob: bytes,
		count: natural
	},
	["id"]
)

/** The schema the box's queries are over. */
export const Rec = schema("Rec", [Tier, Item], [])

/**
 * Item's columns a query's records store: every one but `num`, a numeric of no typmod, whose column's type is a computed
 * numeric's bound (ir/scalar.ts NumericValueType), which no stored field declares until FIELDS-B's stored numeric.
 */
export const itemColumns = [
	"id",
	"small",
	"int",
	"big",
	"dec",
	"whole",
	"real",
	"dbl",
	"cash",
	"flag",
	"day",
	"account",
	"cents",
	"word",
	"name",
	"tier",
	"lowMid",
	"tiers",
	"during",
	"window",
	"days",
	"vec",
	"blob",
	"count"
] as const

export type ItemColumn = (typeof itemColumns)[number]

/** A head literal of every JavaScript type a head holds: a string, a number, a bigint, a boolean, a Decimal, a Money. */
export const literals: Arr.NonEmptyReadonlyArray<HeadValue> = [
	"found",
	7,
	7n,
	true,
	succeeded(Decimal.fromString("1.25"), "a Decimal literal"),
	Money.of(350n)
]

/**
 * One cell of the box: one rule finding columns of Item and the head literal beside them, if any; or a union of two
 * rules of one heading finding the same columns, each a literal of its own under `lit`.
 */
export type RecordsCell =
	| {
			readonly kind: "find"
			readonly columns: Arr.NonEmptyReadonlyArray<ItemColumn>
			readonly literal: HeadValue | undefined
	  }
	| {
			readonly kind: "union"
			readonly columns: Arr.NonEmptyReadonlyArray<ItemColumn>
			readonly literals: readonly [HeadValue, HeadValue]
	  }

/**
 * The literal pairs a union's rules write at one key that a field holds exactly: texts, two of them spelled with the
 * pattern grammar's syntax characters, and both booleans, each a column of exactly its literals.
 */
export const heldPairs: Arr.NonEmptyReadonlyArray<readonly [HeadValue, HeadValue]> = [
	["draft", "final"],
	["a|b", "(c)*"],
	[true, false]
]

/** Every literal pair the box's unions write: the held ones, and two numbers, which no stored field holds exactly yet. */
const literalPairs: Arr.NonEmptyReadonlyArray<readonly [HeadValue, HeadValue]> = [
	...heldPairs,
	[1, 2]
]

/** Whether a union's literal pair has a field of exactly its values: two texts, or both booleans. */
export const heldExactly = (pair: readonly [HeadValue, HeadValue]): boolean =>
	(typeof pair[0] === "string" && typeof pair[1] === "string") ||
	(typeof pair[0] === "boolean" && typeof pair[1] === "boolean")

/**
 * Whether a declaration's values are exactly a literal pair: a text of one pattern its two texts match, as grizzle's own
 * automaton reads it (grizzle-text regex/match.ts Matcher, a second reader beside PostgreSQL's), and none of their
 * concatenation, a text beside them, or an empty text; or a boolean, both its values.
 */
export const holdsExactly = (desc: FieldDesc, pair: readonly [HeadValue, HeadValue]): boolean => {
	if (desc.kind === "pg") {
		return desc.type === "boolean" && typeof pair[0] === "boolean"
	}
	if (desc.kind !== "text" || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
		return false
	}
	const [only, ...more] = desc.patterns
	const parsed = parsePattern(only.source, only.flags)
	if (more.length > 0 || !parsed.ok) {
		return false
	}
	const pattern = Matcher.of(buildNfa(parsed.value))
	return (
		pattern.matches(pair[0]) &&
		pattern.matches(pair[1]) &&
		!pattern.matches(`${pair[0]}${pair[1]}`) &&
		!pattern.matches(`${pair[0]}x`) &&
		!pattern.matches("")
	)
}

/**
 * The columns the box's queries find, compiled under the test compile's lowering audit: every one but `blob`, whose
 * chunked delivery's statement nests the public column names, which the audit's naming rule refuses
 * (test/support/oracle/verify/sql.ts target, "nested column alias is not a generated c<n>"), a query of any bytes
 * column, reported to main; the round trip on PostgreSQL (test/pg/records) reads it through the served compile.
 */
const auditedColumns: Arr.NonEmptyReadonlyArray<Exclude<ItemColumn, "blob">> = [
	"id",
	...Arr.filter(
		itemColumns,
		(c): c is Exclude<ItemColumn, "blob" | "id"> => c !== "blob" && c !== "id"
	)
]

/** The box: each column alone, every column, and every column beside a head literal of each type. */
export const recordsBox: Arr.NonEmptyReadonlyArray<RecordsCell> = [
	...Arr.map(auditedColumns, (column): RecordsCell => ({
		kind: "find",
		columns: [column],
		literal: undefined
	})),
	{ kind: "find", columns: auditedColumns, literal: undefined },
	...Arr.map(literals, (literal): RecordsCell => ({
		kind: "find",
		columns: auditedColumns,
		literal
	})),
	...Arr.map(literalPairs, (pair): RecordsCell => ({
		kind: "union",
		columns: auditedColumns,
		literals: pair
	}))
]

/** The key the head literal is found under. */
export const literalKey = "lit"

/** One rule over Item, its variables `mint`'s, finding `columns` and `literal` under `lit`, if any. */
const ruleOf =
	(
		columns: ReadonlyArray<ItemColumn>,
		literal: HeadValue | undefined,
		mint: () => Readonly<Record<string, unknown>>
	) =>
	(r: RuleValue) => {
		const item = mint()
		const head = Rcd.fromEntries([
			...Arr.map(columns, (c) => [c, item[c]] as const),
			...(literal === undefined ? [] : [[literalKey, literal] as const])
		])
		return r.match(Item, item).find(head)
	}

/**
 * A cell's query over `level`, a level listing Item: its one rule, or its union of two rules of one heading, each
 * finding its literal under `lit`.
 */
export const cellQueryOver = (level: AnySchema, cell: RecordsCell): QueryValue => {
	switch (cell.kind) {
		case "find":
			return queryOver(level).rule(ruleOf(cell.columns, cell.literal, () => v(Item, "item")))
		case "union":
			return queryOver(level)
				.rule(ruleOf(cell.columns, cell.literals[0], () => v(Item, "first")))
				.rule(ruleOf(cell.columns, cell.literals[1], () => v(Item, "second")))
	}
}

/** A cell's query over Rec (cellQueryOver). */
export const cellQuery = (cell: RecordsCell): QueryValue => cellQueryOver(Rec, cell)

/** A query compiled over `level` as the runtime compiles it, its programs' layouts and the context a decoder binds under. */
export interface BoundProgram {
	readonly bind: BindContext
	readonly layouts: ReadonlyArray<Arr.NonEmptyReadonlyArray<Layout>>
}

/** `query` compiled over `level` (a fresh installation's codes), each artifact's program's layouts. */
export const programOf = (query: unknown, level: AnySchema): BoundProgram => {
	const template = succeeded(compileTemplate(query, level, testCompile), "the query compiles")
	const spine = servedSpine(succeeded(queryInput(query), "the builder admits the query").desc)
	const codes = succeeded(codebookFor(schemaInputOf(level), firstCodes), "the level's codes")
	return {
		bind: { options: rowOptions, names: codeNames(codes) },
		layouts: Arr.map(
			["optimized", "conservative"] as const,
			(artifact) => readProgram(servedSource(template.runs[artifact]), spine, codes).layouts
		)
	}
}
