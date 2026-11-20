import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The instants program: every way a caller may write, state or compare an instant, each a statement over Decision,
 * whose at is a clock of child `child`, and Session, whose stage is a reference to it, under the directive the type-test
 * batch disarms exactly where the rule refuses it. The rule, the oracle: an instant is the database's alone, so no
 * value a caller holds is one. A host row leaves every instant out, which an insert stamps, so a put or a delete of
 * host rows names none and is refused; a query's row states one from a stored instant, a variable of an instant field
 * or an aggregate over one; and no parameter, relation parameter's column, literal, typed constant, cast, contract or
 * span is of its type, nor is a literal compared with one. Each statement is a cell of the box.
 */

/** A cell: what it writes, its statement, and the rule's verdict, a refusal its types name or one they name none of. */
interface InstantsCase {
	readonly what: string
	readonly statement: string
	readonly verdict:
		| { readonly kind: "admitted" }
		| { readonly kind: "refusal"; readonly refusal: Refused }
		| { readonly kind: "refused"; readonly why: string }
}

const admitted = { kind: "admitted" } as const

const inputRefusal: Refused =
	"an instant is the database's clock's alone: no parameter, literal, constant, cast, contract or span is of its type"

const boxCases: ReadonlyArray<InstantsCase> = [
	{
		what: "an insert of host rows leaving the clock out",
		statement: "ChangeSet.empty(S).insert(Decision, [{ child: 1, seed: 2 }])",
		verdict: admitted
	},
	{
		what: "an insert of host rows stating the clock",
		statement: "ChangeSet.empty(S).insert(Decision, [{ child: 1, at: 5n, seed: 2 }])",
		verdict: { kind: "refusal", refusal: "a member fact is not a fact of the relation" }
	},
	{
		what: "a delete of host rows",
		statement: "ChangeSet.empty(S).delete(Decision, [{ child: 1, seed: 2 }])",
		verdict: {
			kind: "refusal",
			refusal:
				"a put or a delete states every instant of its rows from a stored instant: write it from a query"
		}
	},
	{
		what: "an insert of a query's rows leaving the clock out",
		statement:
			'ChangeSet.empty(S).insert(Decision, query(S).rule((r) => r.find({ child: r.param("c", pg.integer), seed: r.param("s", pg.integer) })))',
		verdict: admitted
	},
	{
		what: "a reference stated from a stored instant",
		statement:
			'ChangeSet.empty(S).insert(Session, query(S).rule((r) => { const { child, at } = v(Decision, "d"); return r.match(Decision, { child, at }).find({ child, item: r.param("i", pg.integer), stage: at }) }))',
		verdict: admitted
	},
	{
		what: "a reference stated from a natural parameter",
		statement:
			'ChangeSet.empty(S).insert(Session, query(S).rule((r) => r.find({ child: r.param("c", pg.integer), item: r.param("i", pg.integer), stage: r.param("x", natural) })))',
		verdict: {
			kind: "refusal",
			refusal:
				"a member's head writes each field at its type: an exact value re-enters a plain field only by Type.cast"
		}
	},
	{
		what: "a reference stated from a literal",
		statement:
			'ChangeSet.empty(S).insert(Session, query(S).rule((r) => r.find({ child: r.param("c", pg.integer), item: r.param("i", pg.integer), stage: 5n })))',
		verdict: {
			kind: "refusal",
			refusal:
				"a member's head writes each field at its type: an exact value re-enters a plain field only by Type.cast"
		}
	},
	{
		what: "a parameter of instant's type",
		statement: 'query(S).rule((r) => r.find({ x: r.param("x", instant) }))',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a relation parameter's instant column",
		statement:
			'query(S).rule((r) => { const p = r.relation("p", { at: instant }); const { at } = v(p, "p"); return r.match(p, { at }).find({ at }) })',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a typed constant of instant's type",
		statement: "query(S).rule((r) => r.find({ x: Type.literal(instant, 5n) }))",
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a cast into an instant",
		statement:
			'query(S).rule((r) => { const { child, seed } = v(Decision, "d"); return r.match(Decision, { child, seed }).find({ x: Type.cast(Type.cast(seed, pg.bigint), instant) }) })',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a contract named instant",
		statement: 'contract("instant", pg.bigint)',
		verdict: {
			kind: "refusal",
			refusal: "a contract's name is apart from instant, the database's clock's own type"
		}
	},
	{
		what: "a contract over an instant",
		statement: 'contract("Stamp", instant)',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a span of instants",
		statement: "span(instant)",
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a literal compared with an instant",
		statement:
			'query(S).rule((r) => { const { child, at } = v(Decision, "d"); return r.match(Decision, { child, at }).where(r.eq(at, 5n)).find({ child }) })',
		verdict: { kind: "refused", why: "a literal meets no instant" }
	},
	{
		what: "an instant compared with an instant",
		statement:
			'query(S).rule((r) => { const { child, at } = v(Decision, "d"); const s = v(Session, "s"); return r.match(Decision, { child, at }).match(Session, { child, item: s.item, stage: s.stage }).where(r.le(s.stage, at)).find({ child }) })',
		verdict: admitted
	},
	{
		what: "an instant's base and its max",
		statement:
			'query(S).rule((r) => { const { child, at } = v(Decision, "d"); return r.match(Decision, { child, at }).find({ child, b: Type.base(at), m: r.max(at) }) })',
		verdict: admitted
	}
]

/** The cells of instantsBox, minted as a dictionary in its door (test/types/changeset/instants.dictionary.ts). */
export const instantsBoxItems: Arr.NonEmptyReadonlyArray<InstantsCase> = [
	defined(boxCases[0], "a case of the instants box"),
	...Arr.drop(boxCases, 1)
]

/** A cell's directive, where the rule refuses it. */
const directiveOf = (c: InstantsCase): ReadonlyArray<string> => {
	switch (c.verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${c.verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${c.verdict.why}`]
	}
}

const caseBlock = (c: InstantsCase, index: number): ReadonlyArray<string> => [
	`// ${c.what}`,
	...directiveOf(c),
	`export const c${index} = ${c.statement}`,
	""
]

/** The program's prelude (test/support/programs/instants.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/instants.ts"))

/** Decision, its at a clock of child `child`, and Session, its stage a reference to it. */
const instantsHeader = `export const Decision = relation("Decision", { child: pg.integer, at: instant, seed: pg.integer }, ["child", "at"])
export const Session = relation("Session", { child: pg.integer, item: pg.integer, stage: instant }, ["child", "item"])
export const S = schema("S", [Decision, Session], [contained(on(Session, "child", "stage"), on(Decision, "child", "at"))])
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const instantsProgram = (
	cells: Arr.NonEmptyReadonlyArray<InstantsCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/changeset/instants.ts: every way a caller may write, state or compare an instant.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(instantsHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
