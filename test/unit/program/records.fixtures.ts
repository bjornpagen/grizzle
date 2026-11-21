/**
 * What the properties of records.test.ts read: a schema of a relation holding a field of every type a column of a
 * query's heading may be stored as, the flat queries over it a property's box draws, and the program each binds.
 */
import { Array as Arr, Record as Rcd } from "effect"
import { rowOptions } from "#adapter/engine.ts"
import { readProgram } from "#adapter/reader/run.ts"
import type { BindContext, Layout } from "#compiler/core/decoder.ts"
import { codeNames } from "#compiler/ir/codes.ts"
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
export const Account = contract("Account", uuid)
export const Cents = contract("Cents", pg.bigint)

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
export const literals: ReadonlyArray<HeadValue> = [
	"found",
	7,
	7n,
	true,
	succeeded(Decimal.fromString("1.25"), "a Decimal literal"),
	Money.of(350n)
]

/** One cell of the box: the columns its query finds of Item, and the head literal it finds beside them, if any. */
export interface RecordsCell {
	readonly columns: Arr.NonEmptyReadonlyArray<ItemColumn>
	readonly literal: HeadValue | undefined
}

/**
 * The columns the box's queries find, compiled under the test compile's lowering audit: every one but `blob`, whose
 * chunked delivery's statement nests the public column names, which the audit's naming rule refuses
 * (test/support/oracle/verify/sql.ts target, "nested column alias is not a generated c<n>"), a query of any bytes
 * column, reported to main; the round trip on PostgreSQL (test/pg/records) reads it through the served compile.
 */
export const auditedColumns: Arr.NonEmptyReadonlyArray<Exclude<ItemColumn, "blob">> = [
	"id",
	...Arr.filter(
		itemColumns,
		(c): c is Exclude<ItemColumn, "blob" | "id"> => c !== "blob" && c !== "id"
	)
]

/** The box: each column alone, every column, and every column beside a head literal of each type. */
export const recordsBox: Arr.NonEmptyReadonlyArray<RecordsCell> = [
	...Arr.map(auditedColumns, (column): RecordsCell => ({ columns: [column], literal: undefined })),
	{ columns: auditedColumns, literal: undefined },
	...Arr.map(literals, (literal): RecordsCell => ({ columns: auditedColumns, literal }))
]

/** The key the head literal is found under. */
export const literalKey = "lit"

/** A cell's query over `level`, a level listing Item: one rule over Item finding its columns, and its literal under `lit`. */
export const cellQueryOver = (level: AnySchema, cell: RecordsCell): QueryValue =>
	queryOver(level).rule((r: RuleValue) => {
		const item: Readonly<Record<string, unknown>> = v(Item, "item")
		const head = Rcd.fromEntries([
			...Arr.map(cell.columns, (c) => [c, item[c]] as const),
			...(cell.literal === undefined ? [] : [[literalKey, cell.literal] as const])
		])
		return r.match(Item, item).find(head)
	})

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
