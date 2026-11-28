import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Record as Rec, String as Str } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { Card } from "#compiler/ir/rel.ts"
import { analyzeLogical, everyNode, queryEvidence } from "#compiler/logical/annotate.ts"
import { queryInput } from "#compiler/program/input.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	CallKeys,
	type CallSpec,
	type Cell,
	calls,
	cellQuery,
	fieldsOf,
	placeUses
} from "#test/support/call-sources.ts"
import { checkedIn, checkOptions } from "#test/support/policy.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The call-key program: every cell of a row's calls (test/support/call-sources.ts), each call matched at the row's
 * fields, its id pinned by a parameter or not and a numbered call's place delivered, fixed to a literal or dropped,
 * exhausted and printed as one program the type batch checks. The types key a call's rows as the engine does, at the
 * arguments of one evaluation (ir/rel.ts callNumberings): an arm's, a rest's, a path's, a target's and a split at the
 * last separator's are one row or none, so the row's id pinned pins them, metis's kept feedback among them; a split's
 * and a series' are keyed by their place, so the id pinned and the place fixed pin them; a declared function's are a
 * set, which nothing pins but its whole heading.
 *
 * The oracle is the engine: each cell's query is checked against the program's schema and analyzed (cardOf), and the
 * program states its card as the card the types give it.
 */

/** The cells of callKeysBox, minted as a dictionary in its door (test/types/evidence/call-keys.dictionary.ts). */
export const callKeysBoxItems: Arr.NonEmptyReadonlyArray<Cell> = nonEmpty(
	Arr.flatMap(Rec.keys(calls), (call) =>
		Arr.flatMap([false, true], (pinned) =>
			Arr.map(placeUses(calls[call]), (place): Cell => ({ call, pinned, place }))
		)
	),
	"a call matched at a row"
)

/** The program's schema, checked as a compile checks it. */
const checked = succeeded(checkedIn(CallKeys), "the call-key program's schema checks")

/**
 * The engine's card of a cell's query, its built Description checked against the schema and analyzed as a compile
 * checks and analyzes it (program/compile.ts compileQuery, logical/annotate.ts): the card its lowering reads. The query
 * is not lowered: a decoded path and a target within a base call library functions an installation installs for a
 * workload that calls them, which the schema alone holds none of.
 */
const cardOf = (cell: Cell): Card => {
	const analysis = Result.flatMap(
		Result.flatMap(
			catchCompileError(() => cellQuery(cell)),
			queryInput
		),
		(input) =>
			Result.flatMap(checkQuery(checked, input.desc, checkOptions("a call key")), (query) =>
				analyzeLogical(query.dag, queryEvidence, everyNode)
			)
	)
	if (!analysis.ok) {
		throw new Error(
			`the engine refuses ${cell.call}, pinned ${String(cell.pinned)}, its place ${String(cell.place)}: ${analysis.error.reason._tag}`
		)
	}
	return analysis.value.dag.roots[0].meta.card
}

/** A cell's lines: its query, its row's id pinned by a parameter where the cell pins it, and its card the engine's. */
const cellLines = (cell: Cell, index: number): ReadonlyArray<string> => {
	const spec: CallSpec = calls[cell.call]
	const fields = fieldsOf(cell)
	const record = (entries: ReadonlyArray<string>) => `{ ${Arr.join(entries, ", ")} }`
	const rowBound = record(Arr.map(["id", ...spec.reads], (k) => `${k}: f.${k}`))
	const callBound = record(
		Arr.map(fields, ({ field, bound }) =>
			bound.kind === "literal" ? `${field}: ${bound.literal.spelled}` : `${field}: c.${field}`
		)
	)
	const head = record([
		"id: f.id",
		...Arr.flatMap(fields, ({ field, delivered }) => (delivered ? [`${field}: c.${field}`] : []))
	])
	const pin = cell.pinned ? '.where(r.eq(f.id, r.param("id", int4)))' : ""
	return [
		`// ${cell.call}, the row's id ${cell.pinned ? "pinned" : "unpinned"}${cell.place === undefined ? "" : `, its place ${cell.place}`}`,
		`export const q${index} = query(CallKeys).rule((r) => {`,
		'\tconst f = v(Row, "row")',
		`\tconst s = ${spec.spelled}`,
		'\tconst c = v(s, "call")',
		`\treturn r.match(Row, ${rowBound}).match(s, ${callBound})${pin}.find(${head})`,
		"})",
		`export type c${index} = Expect<Equals<EvidenceOfQuery<typeof q${index}>["card"], ${jsonText(cardOf(cell))}>>`,
		""
	]
}

/** The program's prelude (test/support/programs/call-keys.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/call-keys.ts"))

/** The schema every cell reads, the batch's own. */
const callKeysHeader = `export const Text = str.bytes(512, str.regex("^.*$", "su"))
export const Name = str.bytes(40, str.regex("^.*$", "su"))
export const Kind = closed.unordered("Kind", ["flag", "name"])
export const Value = variant("Value", Kind, { flag: { value: bool }, name: { text: Name } })
export const Row = relation(
	"Row",
	{ id: int4, cell: Value, list: Text, base: Text, lo: int4, hi: int4 },
	["id"]
)
export const pieces = fn("pieces", {
	calls: [],
	args: { t: Text },
	returns: rows({ at: int4, piece: Name }),
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body\`SELECT o::integer, left(p, 10) FROM unnest(string_to_array(t, ' ')) WITH ORDINALITY AS u(p, o)\`
})
export const parted = fn("parted", {
	calls: [],
	args: { t: Text },
	returns: row(rows({ parts: rows({ at: int4, piece: Name }) })),
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body\`SELECT NULL\`
})
export const CallKeys = schema("CallKeys", [Kind, Row, pieces, parted], [])
export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const callKeysProgram = (cells: Arr.NonEmptyReadonlyArray<Cell>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/evidence/call-keys.ts: a row's calls, matched at its fields, its id pinned or not.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(callKeysHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
