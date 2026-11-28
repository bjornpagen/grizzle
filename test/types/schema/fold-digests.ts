import { Array as Arr, Effect } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The fold-digests programs: an ordered family of lines folded into its document, by concat over its pieces, its
 * before, after and end each named as its accumulated text or as that text's SHA-256 digest, a generated field
 * `Crypto.sha256(row.v)`; or by sum over its amounts, an accumulator named by a generated field. Each cell is printed
 * into one program the type batch checks.
 *
 * The oracle is the rule the engine holds a fold's accumulators to, stated here apart from the types (ir/family.ts
 * FoldCarrier, check/fold.ts foldRule): a text's running value is named by its accumulated field or by its digest, a
 * generated field, alike on a plane, where the engine admits it; no other plane's accumulator is a generated field.
 * The types see no generation's reads, so a generated field stands at a text plane's accumulator whatever it reads, and
 * the schema's compile admits only the digest of the text; this box holds the cells the two agree on.
 */

/** How a cell names its fold's running values. */
export type FoldDigestsCell =
	| { readonly monoid: "concat"; readonly named: "texts" | "digests" }
	| { readonly monoid: "sum"; readonly generated: "before" | "after" | "end" }

/** The cells of foldDigestsBox (test/types/schema/fold-digests.dictionary.ts). */
export const foldDigestsBoxItems: Arr.NonEmptyReadonlyArray<FoldDigestsCell> = [
	{ monoid: "concat", named: "texts" },
	{ monoid: "concat", named: "digests" },
	{ monoid: "sum", generated: "before" },
	{ monoid: "sum", generated: "after" },
	{ monoid: "sum", generated: "end" }
]

const stepRefusal: Refused =
	"a fold's step is its family's member: its group, its value, then an accumulated pair per plane"

const endRefusal: Refused = "a fold's end names one accumulated field of the owner per plane"

/** A directive for a line `refusal` refuses, none for one it admits. */
const directive = (refusal: Refused | undefined): ReadonlyArray<string> =>
	refusal === undefined ? [] : [`// @ts-expect-error -- refusal: ${refusal}`]

/** A concat cell's lines: Doc and Line with each running text and its digest, and the fold naming one or the other. */
const concatLines = (named: "texts" | "digests", at: number): ReadonlyArray<string> => {
	const name = (v: string): string => (named === "texts" ? v : `${v}Digest`)
	return [
		`// a concat fold naming its ${named}`,
		`export const Doc${at} = relation.generated("Doc${at}", { id: pg.integer, n: drawn(natural), text: accumulated(Text, "") }, ["id"], (row) => ({ textDigest: generated(Digest, Crypto.sha256(row.text)) }))`,
		`export const Line${at} = relation.generated("Line${at}", { doc: pg.integer, at: drawn(natural), piece: Text, before: accumulated(Text, ""), after: accumulated(Text, "") }, ["doc", "at"], (row) => ({ beforeDigest: generated(Digest, Crypto.sha256(row.before)), afterDigest: generated(Digest, Crypto.sha256(row.after)) }))`,
		`export const lines${at} = ordered(on(Line${at}, "doc", "at"), fin(Doc${at}, "n"))`,
		`export const S${at} = schema("S${at}", [Doc${at}, Line${at}], [`,
		`\tlines${at},`,
		`\tfold(lines${at}, Monoid.concat, on(Line${at}, "doc", "piece", "${name("before")}", "${name("after")}"), on(Doc${at}, "id", "${name("text")}"))`,
		"])",
		""
	]
}

/** A sum cell's lines: Account and Entry with each running total and a generated copy of one, the fold naming the copy. */
const sumLines = (generated: "before" | "after" | "end", at: number): ReadonlyArray<string> => {
	const name = (v: "before" | "after" | "end", field: string): string =>
		v === generated ? `${field}Copy` : field
	return [
		`// a sum fold naming a generated ${generated}`,
		`export const Account${at} = relation.generated("Account${at}", { id: pg.integer, n: drawn(natural), total: accumulated(pg.bigint, 0n) }, ["id"], (row) => ({ totalCopy: generated(pg.bigint, row.total) }))`,
		`export const Entry${at} = relation.generated("Entry${at}", { account: pg.integer, at: drawn(natural), amount: pg.bigint, before: accumulated(pg.bigint, 0n), after: accumulated(pg.bigint, 0n) }, ["account", "at"], (row) => ({ beforeCopy: generated(pg.bigint, row.before), afterCopy: generated(pg.bigint, row.after) }))`,
		`export const entries${at} = ordered(on(Entry${at}, "account", "at"), fin(Account${at}, "n"))`,
		`export const S${at} = schema("S${at}", [Account${at}, Entry${at}], [`,
		`\tentries${at},`,
		...directive(generated === "end" ? endRefusal : stepRefusal),
		`\tfold(entries${at}, Monoid.sum, on(Entry${at}, "account", "amount", "${name("before", "before")}", "${name("after", "after")}"), on(Account${at}, "id", "${name("end", "total")}"))`,
		"])",
		""
	]
}

const cellLines = (c: FoldDigestsCell, at: number): ReadonlyArray<string> =>
	c.monoid === "concat" ? concatLines(c.named, at) : sumLines(c.generated, at)

/** The types every cell reads: a text of no bound, and Crypto.sha256's value, the 32-byte digest carrier. */
const foldDigestsHeader = (): ReadonlyArray<string> => [
	'export const Text = str.regex("^.*$", "su")',
	"export const Digest = sha256",
	""
]

/** The program's prelude (test/support/programs/fold-digests.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/fold-digests.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const foldDigestsProgram = (
	cells: Arr.NonEmptyReadonlyArray<FoldDigestsCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/fold-digests.ts: concat folds naming their running texts or their digests, and sum folds naming a generated accumulator.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: foldDigestsHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
