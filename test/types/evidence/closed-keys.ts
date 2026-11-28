import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { Card } from "#compiler/ir/rel.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplateOver, testArtifacts, testCompile } from "#test/support/compile.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The closed-key program: a closed relation whose one key is its declared key of two closed ids, neither of whose
 * columns is distinct alone, nor any other set of its columns, matched with each set of its columns pinned by a
 * parameter, its whole heading in the head, exhausted and printed as one program the type batch checks. Its key is a
 * fact of its rows the types read from its declaration and the engine from its rows (logical/props.ts Closed): a
 * match pinned on a set that holds a key is at most one row to both, and on any other many to both.
 *
 * The oracle is the engine: each cell's query is compiled against the program's schema, and the program states its
 * card as the card the types give it.
 */

/** Allowed's columns: its key's two closed ids and a weight. */
const columns = ["kind", "flag", "w"] as const

type Column = (typeof columns)[number]

/** Every set of Allowed's columns, the empty one first: the columns a cell pins. */
const pinnings: ReadonlyArray<ReadonlyArray<Column>> = Arr.reduce(
	columns,
	[[]],
	(sets: ReadonlyArray<ReadonlyArray<Column>>, c): ReadonlyArray<ReadonlyArray<Column>> => [
		...sets,
		...Arr.map(sets, (set) => [...set, c])
	]
)

/** The cells of closedKeysBox, minted as a dictionary in its door (test/types/evidence/closed-keys.dictionary.ts). */
export const closedKeysBoxItems: Arr.NonEmptyReadonlyArray<ReadonlyArray<Column>> = nonEmpty(
	pinnings,
	"a set of Allowed's columns"
)

/**
 * Allowed's rows: no two share a kind and a flag, and every other set of its columns repeats a tuple: kind and flag
 * each repeat, the weight repeats, and so do (kind, w) and (flag, w).
 */
const rowsText = `[
	{ kind: "x", flag: "p", w: 1 },
	{ kind: "x", flag: "q", w: 1 },
	{ kind: "y", flag: "p", w: 2 },
	{ kind: "y", flag: "q", w: 1 }
]`

const Kind = closed.ordered("Kind", ["x", "y"])
const Flag = closed.ordered("Flag", ["p", "q"])
const Allowed = closed.relation(
	"Allowed",
	{ kind: closedId(Kind), flag: closedId(Flag), w: int4 },
	["kind", "flag"],
	[
		{ kind: "x", flag: "p", w: 1 },
		{ kind: "x", flag: "q", w: 1 },
		{ kind: "y", flag: "p", w: 2 },
		{ kind: "y", flag: "q", w: 1 }
	]
)
const Keys = schema("Keys", [Kind, Flag, Allowed], [])
const artifacts = succeeded(testArtifacts(Keys, testCompile), "the closed-key program's artifacts")

/** The query pinning `pinned`, through the builder's JavaScript view, as the engine compiles it. */
const pinnedQuery = (pinned: ReadonlyArray<Column>): unknown =>
	queryOver(Keys).rule((r: RuleValue) => {
		const vars = varsOver(Allowed, "allowed")
		const row = Rec.fromEntries(Arr.map(columns, (c) => [c, vars[c]] as const))
		return Arr.reduce(pinned, r.match(Allowed, row), (matched, c) =>
			matched.where(r.eq(vars[c], r.param(c, Allowed.fields[c])))
		).find(row)
	})

/** The engine's card of a cell's query, compiled against the schema. */
const cardOf = (pinned: ReadonlyArray<Column>): Card => {
	const template = Result.flatMap(
		catchCompileError(() => pinnedQuery(pinned)),
		(q) => compileTemplateOver(q, Keys, artifacts, testCompile)
	)
	if (!template.ok) {
		throw new Error(`the engine refuses Allowed pinned on ${jsonText(pinned)}`)
	}
	return template.value.analyzed.roots[0].meta.card
}

/** A cell's lines: its query, pinned by its parameters, and its card the engine's. */
const cellLines = (pinned: ReadonlyArray<Column>, index: number): ReadonlyArray<string> => [
	`// Allowed pinned on ${jsonText(pinned)}`,
	`export const q${index} = query(Keys).rule((r) => {`,
	'\tconst a = v(Allowed, "allowed")',
	`\treturn r.match(Allowed, { kind: a.kind, flag: a.flag, w: a.w })${Arr.join(
		Arr.map(pinned, (c) => `.where(r.eq(a.${c}, r.param("${c}", Allowed.fields.${c})))`),
		""
	)}.find({ kind: a.kind, flag: a.flag, w: a.w })`,
	"})",
	`export type c${index} = Expect<Equals<EvidenceOfQuery<typeof q${index}>["card"], ${jsonText(cardOf(pinned))}>>`,
	""
]

/** The program's prelude (test/support/programs/closed-keys.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/closed-keys.ts"))

/** The rosters, the closed relation and the schema every cell reads, the batch's own. */
const closedKeysHeader = `export const Kind = closed.ordered("Kind", ["x", "y"])
export const Flag = closed.ordered("Flag", ["p", "q"])
export const Allowed = closed.relation(
	"Allowed",
	{ kind: closedId(Kind), flag: closedId(Flag), w: int4 },
	["kind", "flag"],
	${rowsText}
)
export const Keys = schema("Keys", [Kind, Flag, Allowed], [])
export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const closedKeysProgram = (
	cells: Arr.NonEmptyReadonlyArray<ReadonlyArray<Column>>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/evidence/closed-keys.ts: a closed relation of a composite key, pinned on each set of its columns.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(closedKeysHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
