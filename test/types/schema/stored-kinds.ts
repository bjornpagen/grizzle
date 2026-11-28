import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The stored kinds program: every way a caller writes or states a stored search document (pg.tsvector) or a stored
 * computed numeric (pg.numeric.within), each a statement over Lesson, whose search is a generated document of its title
 * under english, Note, whose body's is under simple, Kept, which stores an english document, Line, of amounts, and
 * Total, which stores a computed numeric, under the directive the type-test batch disarms exactly where the rule refuses
 * it. The rule, the oracle: a stored document is a SearchDocument, which only a read delivers, and no string, parameter
 * or contract is of it; a stored computed numeric is a Decimal,
 * a read's sum among them, and never a bigint. Each statement is a cell of the box.
 */

/** A cell: what it writes, its statement, and the rule's verdict, a refusal its types name or one they name none of. */
interface StoredKindsCase {
	readonly what: string
	readonly statement: string
	readonly verdict:
		| { readonly kind: "admitted" }
		| { readonly kind: "refusal"; readonly refusal: Refused }
		| { readonly kind: "refused"; readonly why: string }
}

const admitted = { kind: "admitted" } as const

const notAFact: Refused = "a member fact is not a fact of the relation"

const searchRefusal: Refused =
	"a search document is PostgreSQL's parse of texts, which a field holds as a read delivered it: no parameter or contract is of its type"

const boxCases: ReadonlyArray<StoredKindsCase> = [
	{
		what: "a stored document stated from a read's document",
		statement:
			"(row: ResultOf<HeadOf<typeof lessons>>) => ChangeSet.empty(S).insert(Kept, [{ id: row.id, doc: row.search }])",
		verdict: admitted
	},
	{
		what: "a stored document stated from a string",
		statement: "ChangeSet.empty(S).insert(Kept, [{ id: 1, doc: \"'a':1\" }])",
		verdict: { kind: "refusal", refusal: notAFact }
	},
	{
		what: "a document a read delivered is a string",
		statement: "(row: ResultOf<HeadOf<typeof lessons>>): string => row.search",
		verdict: admitted
	},
	{
		what: "a parameter of a search document",
		statement: 'query(S).rule((r) => r.find({ x: r.param("x", pg.tsvector("english")) }))',
		verdict: { kind: "refusal", refusal: searchRefusal }
	},
	{
		what: "a relation parameter's search document column",
		statement:
			'query(S).rule((r) => { const p = r.relation("p", { doc: pg.tsvector("english") }); const { doc } = v(p, "p"); return r.match(p, { doc }).find({ doc }) })',
		verdict: { kind: "refusal", refusal: searchRefusal }
	},
	{
		what: "a contract over a search document",
		statement: 'contract<typeof probeKey>()("Doc", pg.tsvector("english"))',
		verdict: { kind: "refusal", refusal: searchRefusal }
	},
	{
		what: "a stored computed numeric stated from a Decimal",
		statement: 'ChangeSet.empty(S).insert(Total, [{ id: 1, total: Decimal.of("1.5") }])',
		verdict: admitted
	},
	{
		what: "a stored computed numeric stated from a read's sum",
		statement:
			"(row: ResultOf<HeadOf<typeof sums>>) => ChangeSet.empty(S).insert(Total, [{ id: row.id, total: row.total }])",
		verdict: admitted
	},
	{
		what: "a stored computed numeric stated from a bigint",
		statement: "ChangeSet.empty(S).insert(Total, [{ id: 1, total: 15n }])",
		verdict: { kind: "refusal", refusal: notAFact }
	},
	{
		what: "a stored computed numeric compared with a numeric",
		statement:
			'query(S).rule((r) => { const { id, total } = v(Total, "t"); return r.match(Total, { id, total }).where(r.lt(total, Decimal.of("2"))).find({ id, total }) })',
		verdict: admitted
	}
]

/** The cells of storedKindsBox, minted as a dictionary in its door (test/types/schema/stored-kinds.dictionary.ts). */
export const storedKindsBoxItems: Arr.NonEmptyReadonlyArray<StoredKindsCase> = [
	defined(boxCases[0], "a case of the stored kinds box"),
	...Arr.drop(boxCases, 1)
]

/** A cell's directive, where the rule refuses it. */
const directiveOf = (c: StoredKindsCase): ReadonlyArray<string> => {
	switch (c.verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${c.verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${c.verdict.why}`]
	}
}

const caseBlock = (c: StoredKindsCase, index: number): ReadonlyArray<string> => [
	`// ${c.what}`,
	...directiveOf(c),
	`export const c${index} = ${c.statement}`,
	""
]

/** The program's prelude (test/support/programs/stored-kinds.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/stored-kinds.ts"))

/** Lesson and Note, each with a generated document, Kept and Total, which store one and a computed numeric. */
const storedKindsHeader = `export const probeKey = Symbol("Probe")
const Title = str.bytes(200, str.regex("^.*$", "su"))
export const Lesson = relation.generated("Lesson", { id: pg.integer, title: Title }, ["id"], (r) => ({ search: searchDocument("english", ["A", r.title]) }))
export const Note = relation.generated("Note", { id: pg.integer, body: Title }, ["id"], (r) => ({ search: searchDocument("simple", ["B", r.body]) }))
export const Kept = relation("Kept", { id: pg.integer, doc: pg.tsvector("english") }, ["id"])
export const Line = relation("Line", { id: pg.integer, n: pg.integer, amount: pg.numeric(6, 2) }, ["id", "n"])
export const Total = relation("Total", { id: pg.integer, total: pg.numeric.within(9, 2) }, ["id"])
export const S = schema("S", [Lesson, Note, Kept, Line, Total], [])
export const lessons = query(S).rule((r) => { const { id, search } = v(Lesson, "l"); return r.match(Lesson, { id, search }).find({ id, search }) })
export const notes = query(S).rule((r) => { const { id, search } = v(Note, "n"); return r.match(Note, { id, search }).find({ id, search }) })
export const sums = query(S).rule((r) => { const { id, n, amount } = v(Line, "l"); return r.match(Line, { id, n, amount }).find({ id, total: r.sum(amount) }) })
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const storedKindsProgram = (
	cells: Arr.NonEmptyReadonlyArray<StoredKindsCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/stored-kinds.ts: every way a caller writes or states a stored document or a stored computed numeric.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(storedKindsHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
