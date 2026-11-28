import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { Card } from "#compiler/ir/rel.ts"
import { Crypto, Num, Text } from "#compiler/public/compute.ts"
import { generated, pg, sha256 } from "#compiler/public/fields.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplateOver, testArtifacts, testCompile } from "#test/support/compile.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The generated-key program: a relation of two unbounded texts and a float, with three generated fields, the digest of
 * the first text, the digest of both texts and the negated float, keyed by the two digests and by the negated float;
 * matched binding every column, with each set of its texts, its float and its generated fields pinned by a parameter, or
 * binding its written columns alone, the generated ones bound by none, with each set of its texts and its float pinned,
 * what it binds in the head, exhausted and printed as one program the type batch checks. A generated field is determined by what its
 * generation reads (ir/keys.ts GeneratedRead, types/evidence/evidence.ts GenerationsOf), but for one reading a float:
 * the texts pinned are the digests pinned, at most one row to both the engine and the types, and the float pinned is
 * many rows to both, its -0 and +0 one key value its negation tells apart.
 *
 * The oracle is the engine: each cell's query is compiled against the program's schema, and the program states its
 * card as the card the types give it.
 */

/** The written columns a cell may pin: the texts and the float. */
const writtenPinnable = ["a", "b", "x"] as const
/** The generated columns a cell binding every column may pin. */
const generatedPinnable = ["ad", "abd", "xd"] as const

type Column = (typeof writtenPinnable)[number] | (typeof generatedPinnable)[number]

/** What a cell's match binds, and its head finds: every column of Ref, or its written columns alone. */
const bound = {
	"every column": ["id", ...writtenPinnable, ...generatedPinnable],
	"written columns": ["id", ...writtenPinnable]
} as const

/** A cell: what its match binds, and the columns of them it pins. */
export interface Cell {
	readonly binds: keyof typeof bound
	readonly pinned: ReadonlyArray<Column>
}

/** Every set of `columns`, the empty one first. */
const setsOf = (columns: ReadonlyArray<Column>): ReadonlyArray<ReadonlyArray<Column>> =>
	Arr.reduce(
		columns,
		[[]],
		(sets: ReadonlyArray<ReadonlyArray<Column>>, c): ReadonlyArray<ReadonlyArray<Column>> => [
			...sets,
			...Arr.map(sets, (set) => [...set, c])
		]
	)

/** The cells of generatedKeysBox, minted as a dictionary in its door (test/types/evidence/generated-keys.dictionary.ts). */
export const generatedKeysBoxItems: Arr.NonEmptyReadonlyArray<Cell> = nonEmpty(
	[
		...Arr.map(setsOf([...writtenPinnable, ...generatedPinnable]), (pinned): Cell => ({
			binds: "every column",
			pinned
		})),
		...Arr.map(setsOf(writtenPinnable), (pinned): Cell => ({ binds: "written columns", pinned }))
	],
	"a pinning of Ref's columns"
)

const anyText = str.regex("^.*$", "su")
const Ref = relation.generated(
	"Ref",
	{ id: pg.integer, a: anyText, b: anyText, x: pg["double precision"] },
	["id"],
	(row) => ({
		ad: generated(sha256, Crypto.sha256(row.a)),
		abd: generated(sha256, Crypto.sha256(Text.concat(row.a, row.b))),
		xd: generated(pg["double precision"], Num.neg(row.x))
	})
)
const Refs = schema("Refs", [Ref], [key(on(Ref, "ad", "abd")), key(on(Ref, "xd"))])

/**
 * The type a parameter pinning each column is of: a written column's own descriptor, and a generated one's declared
 * type, which a parameter takes, a generated field being no descriptor; as the JavaScript view's value and as the
 * program spells it.
 */
const paramTypes: Readonly<Record<Column, { readonly value: unknown; readonly spelled: string }>> =
	{
		a: { value: Ref.fields.a, spelled: "Ref.fields.a" },
		b: { value: Ref.fields.b, spelled: "Ref.fields.b" },
		x: { value: Ref.fields.x, spelled: "Ref.fields.x" },
		ad: { value: sha256, spelled: "sha256" },
		abd: { value: sha256, spelled: "sha256" },
		xd: { value: pg["double precision"], spelled: 'pg["double precision"]' }
	}
const artifacts = succeeded(
	testArtifacts(Refs, testCompile),
	"the generated-key program's artifacts"
)

/** A cell's query, through the builder's JavaScript view, as the engine compiles it. */
const cellQuery = (cell: Cell): unknown =>
	queryOver(Refs).rule((r: RuleValue) => {
		const vars = varsOver(Ref, "ref")
		const row = Rec.fromEntries(Arr.map(bound[cell.binds], (c) => [c, vars[c]] as const))
		return Arr.reduce(cell.pinned, r.match(Ref, row), (matched, c) =>
			matched.where(r.eq(vars[c], r.param(c, paramTypes[c].value)))
		).find(row)
	})

/** The engine's card of a cell's query, compiled against the schema. */
const cardOf = (cell: Cell): Card => {
	const template = Result.flatMap(
		catchCompileError(() => cellQuery(cell)),
		(q) => compileTemplateOver(q, Refs, artifacts, testCompile)
	)
	if (!template.ok) {
		throw new Error(
			`the engine refuses Ref binding ${cell.binds} pinned on ${jsonText(cell.pinned)}`
		)
	}
	return template.value.analyzed.roots[0].meta.card
}

/** A cell's lines: its query, pinned by its parameters, and its card the engine's. */
const cellLines = (cell: Cell, index: number): ReadonlyArray<string> => {
	const row = `{ ${Arr.join(
		Arr.map(bound[cell.binds], (c) => `${c}: f.${c}`),
		", "
	)} }`
	return [
		`// Ref binding ${cell.binds}, pinned on ${jsonText(cell.pinned)}`,
		`export const q${index} = query(Refs).rule((r) => {`,
		'\tconst f = v(Ref, "ref")',
		`\treturn r.match(Ref, ${row})${Arr.join(
			Arr.map(
				cell.pinned,
				(c) => `.where(r.eq(f.${c}, r.param("${c}", ${paramTypes[c].spelled})))`
			),
			""
		)}.find(${row})`,
		"})",
		`export type c${index} = Expect<Equals<EvidenceOfQuery<typeof q${index}>["card"], ${jsonText(cardOf(cell))}>>`,
		""
	]
}

/** The program's prelude (test/support/programs/generated-keys.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/generated-keys.ts"))

/** The relation and the schema every cell reads, the batch's own. */
const generatedKeysHeader = `export const anyText = str.regex("^.*$", "su")
export const Ref = relation.generated(
	"Ref",
	{ id: pg.integer, a: anyText, b: anyText, x: pg["double precision"] },
	["id"],
	(row) => ({
		ad: generated(sha256, Crypto.sha256(row.a)),
		abd: generated(sha256, Crypto.sha256(Text.concat(row.a, row.b))),
		xd: generated(pg["double precision"], Num.neg(row.x))
	})
)
export const Refs = schema("Refs", [Ref], [key(on(Ref, "ad", "abd")), key(on(Ref, "xd"))])
export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const generatedKeysProgram = (
	cells: Arr.NonEmptyReadonlyArray<Cell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/evidence/generated-keys.ts: a relation keyed by generated digests, pinned on each set of its texts, its float and its generated fields.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(generatedKeysHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
