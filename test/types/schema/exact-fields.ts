import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The exact fields program: every way a caller declares, writes, reads and compares an exact field, each a statement
 * over Ledger, whose `count` is an exactInteger and `total` an exactMoney beside a plain bigint `n` and amount `m`,
 * under the directive the type-test batch disarms exactly where the rule refuses it. The rule, the oracle: an exact
 * field holds its carrier's exact values as they are, integer and money arithmetic's, its host value a bigint or a Money
 * of any size; a plain field holds one only through Type.cast; a parameter and a literal of its family meet it; and no
 * contract is over one. Each statement is a cell of the box.
 */

/** A cell: what it states, its statement, and the rule's verdict, a refusal its types name or one they name none of. */
interface ExactCase {
	readonly what: string
	readonly statement: string
	readonly verdict:
		| { readonly kind: "admitted" }
		| { readonly kind: "refusal"; readonly refusal: Refused }
		| { readonly kind: "refused"; readonly why: string }
}

const admitted = { kind: "admitted" } as const

const contractRefusal: Refused =
	"no contract is over an exact value of any size: declare it over int8, numeric(p, s) or money"

const boxCases: ReadonlyArray<ExactCase> = [
	{
		what: "the exact integer's descriptor type",
		statement: 'exactInteger satisfies Field<bigint, "exact integer">',
		verdict: admitted
	},
	{
		what: "the exact money's descriptor type",
		statement: 'exactMoney satisfies Field<Money, "exact money">',
		verdict: admitted
	},
	{
		what: "the exact integer's descriptor as a number field",
		statement: 'exactInteger satisfies Field<number, "exact integer">',
		verdict: { kind: "refused", why: "its host value is a bigint" }
	},
	{
		what: "an insert of host rows past a signed 64-bit count",
		statement:
			"ChangeSet.empty(S).insert(Ledger, [{ id: 1, count: 10n ** 30n, total: Money.exact(10n ** 30n), n: 1n, m: Money.of(1n) }])",
		verdict: admitted
	},
	{
		what: "an insert of a number into the exact integer",
		statement:
			"ChangeSet.empty(S).insert(Ledger, [{ id: 1, count: 5, total: Money.exact(1n), n: 1n, m: Money.of(1n) }])",
		verdict: { kind: "refusal", refusal: "a member fact is not a fact of the relation" }
	},
	{
		what: "an insert of a Numeric into the exact money",
		statement:
			'ChangeSet.empty(S).insert(Ledger, [{ id: 1, count: 5n, total: Numeric.of("1.50"), n: 1n, m: Money.of(1n) }])',
		verdict: { kind: "refusal", refusal: "a member fact is not a fact of the relation" }
	},
	{
		what: "a query member's exact sums into the exact fields",
		statement:
			'ChangeSet.empty(S).insert(Ledger, query(S).rule((r) => { const { id, n, m } = v(Ledger, "l"); return r.match(Ledger, { id, n, m }).find({ id, count: Num.add(n, n), total: Num.add(m, m), n, m }) }))',
		verdict: admitted
	},
	{
		what: "a query member's exact sum into a plain bigint field",
		statement:
			'ChangeSet.empty(S).insert(Ledger, query(S).rule((r) => { const { id, n, m } = v(Ledger, "l"); return r.match(Ledger, { id, n, m }).find({ id, count: Num.add(n, n), total: Num.add(m, m), n: Num.add(n, n), m }) }))',
		verdict: {
			kind: "refusal",
			refusal:
				"a member's head writes each field at its type: an exact value re-enters a plain field only by Type.cast"
		}
	},
	{
		what: "the exact fields' own arithmetic written back into them",
		statement:
			'ChangeSet.empty(S).insert(Ledger, query(S).rule((r) => { const { id, count, total, n, m } = v(Ledger, "l"); return r.match(Ledger, { id, count, total, n, m }).find({ id, count: Num.mul(count, count), total: Num.sub(total, m), n, m }) }))',
		verdict: admitted
	},
	{
		what: "a parameter of the exact integer compared with it",
		statement:
			'query(S).rule((r) => { const { id, count } = v(Ledger, "l"); return r.match(Ledger, { id, count }).where(r.eq(count, r.param("c", exactInteger))).find({ id }) })',
		verdict: admitted
	},
	{
		what: "a bigint literal compared with the exact integer",
		statement:
			'query(S).rule((r) => { const { id, count } = v(Ledger, "l"); return r.match(Ledger, { id, count }).where(r.gt(count, 5n)).find({ id }) })',
		verdict: admitted
	},
	{
		what: "a generated exact integer of two bigints",
		statement:
			'relation.generated("Summed", { id: int4, a: int8, b: int8 }, ["id"], (row) => ({ s: generated(exactInteger, Num.add(row.a, row.b)) }))',
		verdict: admitted
	},
	{
		what: "a contract over the exact integer",
		statement: 'contract<typeof probeKey>()("Huge", exactInteger)',
		verdict: { kind: "refusal", refusal: contractRefusal }
	},
	{
		what: "a contract over the exact money",
		statement: 'contract<typeof probeKey>()("Total", exactMoney)',
		verdict: { kind: "refusal", refusal: contractRefusal }
	}
]

/** The cells of exactFieldsBox, minted as a dictionary in its door (test/types/schema/exact-fields.dictionary.ts). */
export const exactFieldsBoxItems: Arr.NonEmptyReadonlyArray<ExactCase> = [
	defined(boxCases[0], "a case of the exact fields box"),
	...Arr.drop(boxCases, 1)
]

/** A cell's directive, where the rule refuses it. */
const directiveOf = (c: ExactCase): ReadonlyArray<string> => {
	switch (c.verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${c.verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${c.verdict.why}`]
	}
}

const caseBlock = (c: ExactCase, index: number): ReadonlyArray<string> => [
	`// ${c.what}`,
	...directiveOf(c),
	`export const c${index} = ${c.statement}`,
	""
]

/** The program's prelude (test/support/programs/exact-fields.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/exact-fields.ts"))

/** Ledger, its count an exactInteger and its total an exactMoney beside a plain bigint and amount. */
const exactHeader = `export const probeKey = Symbol("Probe")
export const Ledger = relation("Ledger", { id: int4, count: exactInteger, total: exactMoney, n: int8, m: money }, ["id"])
export const S = schema("S", [Ledger], [])
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const exactFieldsProgram = (
	cells: Arr.NonEmptyReadonlyArray<ExactCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/exact-fields.ts: every way a caller declares, writes, reads and compares an exact field.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(exactHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
