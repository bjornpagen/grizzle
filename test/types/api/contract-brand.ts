import { Array as Arr, Effect } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The contract-brand program: a contract's values are of one type with Effect Schema's brand of the contract's name over
 * the same carrier. A contract's host type is its base's host type and Effect's `Brand.Brand<name>` (types/fields/field.ts
 * Contract), which the engine imports as a type alone, so it loads no Effect at run time; `Schema.brand(name)` over a
 * schema of a type T types its values as T and that same `Brand.Brand<name>`. So a value an Effect Schema decodes is a
 * value of the contract's field, a value grizzle reads from the field or the contract mints is a value of the schema's
 * type, and no cast stands between them, whichever module declares the schema.
 *
 * The box is every kind of base a contract is over, each its own carrier (a base the engine refuses, a set over a
 * roster or bytes, is none): each pg type, numeric at scale 0 and at another, uuid, natural, date, sha256, a pattern of
 * infinite language, of finite language and of a fixed prefix, a pattern held to its bytes, two patterns intersected, a
 * closed id of an ordered roster, of an unordered one and of a subset, a span, a vector, another contract, and a contract
 * that checks its values and proves a fact of them. Each cell's lines declare the contract over its base and the type
 * of `Schema.brand(name)` over a schema of the base's own host type, `Schema.brand<Schema.Schema<Infer<typeof base>>,
 * name>`, the interface Schema.brand returns (the program reads a schema's type alone, as grizzle's code reads Effect
 * Schema), then state that the two value types are one, that each is written where the other stands, and that the
 * contract's mint returns the schema's type.
 *
 * The oracle: Effect Schema's brand, a second implementation of the branded type.
 */

/** Each base of the box: the base, and what follows it in the contract's call (its check and its facts), or nothing. */
const bases = {
	"pg.smallint": ["pg.smallint", ""],
	"pg.integer": ["pg.integer", ""],
	"pg.bigint": ["pg.bigint", ""],
	"pg.numeric at scale 0": ["pg.numeric(9, 0)", ""],
	"pg.numeric at scale 2": ["pg.numeric(9, 2)", ""],
	"pg.real": ["pg.real", ""],
	'pg["double precision"]': ['pg["double precision"]', ""],
	"pg.money": ["pg.money", ""],
	"pg.boolean": ["pg.boolean", ""],
	uuid: ["uuid", ""],
	natural: ["natural", ""],
	date: ["date", ""],
	sha256: ["sha256", ""],
	"a pattern of infinite language": ['str.regex("^[a-z]{1,8}$")', ""],
	"a pattern of finite language": ['str.regex("^(yes|no)$")', ""],
	"a pattern of a fixed prefix": ['str.regex("^user_[0-9a-z]{1,8}$")', ""],
	"a pattern held to its bytes": ['str.bytes(8, str.regex("^[a-z]{1,8}$"))', ""],
	"two patterns intersected": ['str.and(str.regex("^[a-z]{1,8}$"), str.regex("^a"))', ""],
	"a closed id of an ordered roster": ["closedId(Ordered)", ""],
	"a closed id of an unordered roster": ["closedId(Unordered)", ""],
	"a closed id of a subset": ['closedId(Ordered, { only: ["low"] })', ""],
	"a span": ["span(pg.integer)", ""],
	"a vector": ["pg.vector(3)", ""],
	"another contract": ["Cents", ""],
	"a contract that checks and proves": [
		"pg.bigint",
		', (v) => Compute.ne(v, 0n), { proves: ["nonzero"] }'
	]
} as const

type Base = keyof typeof bases

/** The cells of contractBrandBox, minted as a dictionary in its door (test/types/api/contract-brand.dictionary.ts). */
export const contractBrandBoxItems: Arr.NonEmptyReadonlyArray<Base> = [
	"pg.smallint",
	"pg.integer",
	"pg.bigint",
	"pg.numeric at scale 0",
	"pg.numeric at scale 2",
	"pg.real",
	'pg["double precision"]',
	"pg.money",
	"pg.boolean",
	"uuid",
	"natural",
	"date",
	"sha256",
	"a pattern of infinite language",
	"a pattern of finite language",
	"a pattern of a fixed prefix",
	"a pattern held to its bytes",
	"two patterns intersected",
	"a closed id of an ordered roster",
	"a closed id of an unordered roster",
	"a closed id of a subset",
	"a span",
	"a vector",
	"another contract",
	"a contract that checks and proves"
]

/** The program's prelude (test/support/programs/contract-brand.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/contract-brand.ts"))

/**
 * What every cell reads: the type equality the cells state, the two rosters the closed ids are of, and the contract
 * another contract is over.
 */
const contractBrandHeader: ReadonlyArray<string> = [
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	'export const Ordered = closed.ordered("Ordered", ["low", "high"])',
	'export const Unordered = closed.unordered("Unordered", ["a", "b"])',
	'export const Cents = contract("Cents", pg.bigint)',
	""
]

/** A cell's lines: its contract and its schema, of one value type that flows both ways and that the mint returns. */
const cellLines = (base: Base, at: number): ReadonlyArray<string> => {
	const [field, rest] = bases[base]
	return [
		`// ${base}`,
		`export const base${at} = ${field}`,
		`export const C${at} = contract("C${at}", base${at}${rest})`,
		`export type S${at} = Schema.brand<Schema.Schema<Infer<typeof base${at}>>, "C${at}">`,
		`export type same${at} = Expect<Equals<Infer<typeof C${at}>, S${at}["Type"]>>`,
		`export const read${at} = (value: Infer<typeof C${at}>): S${at}["Type"] => value`,
		`export const decoded${at} = (value: S${at}["Type"]): Infer<typeof C${at}> => value`,
		`export const minted${at} = (value: Infer<typeof base${at}>): S${at}["Type"] => C${at}(value)`
	]
}

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const contractBrandProgram = (
	cells: Arr.NonEmptyReadonlyArray<Base>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/contract-brand.ts: a contract's values are Effect Schema's brand of its name.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: contractBrandHeader },
			...Arr.map(cells, (base, at) => ({ owner: caseOwned(at), lines: cellLines(base, at) }))
		]
	)
]
