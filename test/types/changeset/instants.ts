import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The instants program: every way a caller may write, state or compare an instant, each a statement over Decision,
 * whose at is a clock of child `child`, Session, whose stage is a reference to it, and Seen, whose at is a stored
 * instant (instant.stored), under the directive the type-test batch disarms exactly where the rule refuses it. The rule,
 * the oracle: an instant is the database's alone, so no value a caller holds is one but an instant a read delivered
 * (Instant), which a stored instant takes as it is, and a bigint never. A host row leaves every instant out, which an insert stamps, so the rows insertAll's
 * record types and factsDecoder decodes (InsertAllRowsOf) insert as they are, and a put or a delete of host rows names
 * none and is refused; a query's row states one from a stored instant, a variable of an instant field
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
	"an instant is the database's clock's alone: no parameter, literal, constant, cast, contract or range is of its type"

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
		what: "an insert of host rows stating the clock from a read's instant",
		statement: "ChangeSet.empty(S).insert(Decision, [{ child: 1, at: readAt, seed: 2 }])",
		verdict: { kind: "refusal", refusal: "a member fact is not a fact of the relation" }
	},
	{
		what: "an insert of the rows insertAll's record types, as factsDecoder decodes them",
		statement:
			'ChangeSet.empty(S).insert(Decision, Result.getOrThrow(decoder.decode("Decision", [])))',
		verdict: admitted
	},
	{
		what: "a served insert's facts, the rows insertAll's record types",
		statement:
			"(db: DbOf<typeof Writer, typeof adding.programs>) => db.workload.add.once({ params: {}, facts: { insert: { Decision: decided } } })",
		verdict: admitted
	},
	{
		what: "an insertAll of the record of rows it types",
		statement: "ChangeSet.empty(S).insertAll({ Decision: decided })",
		verdict: admitted
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
			'ChangeSet.empty(S).insert(Decision, query(S).rule((r) => r.find({ child: r.param("c", int4), seed: r.param("s", int4) })))',
		verdict: admitted
	},
	{
		what: "a reference stated from a stored instant",
		statement:
			'ChangeSet.empty(S).insert(Session, query(S).rule((r) => { const { child, at } = v(Decision, "d"); return r.match(Decision, { child, at }).find({ child, item: r.param("i", int4), stage: at }) }))',
		verdict: admitted
	},
	{
		what: "a reference stated from a natural parameter",
		statement:
			'ChangeSet.empty(S).insert(Session, query(S).rule((r) => r.find({ child: r.param("c", int4), item: r.param("i", int4), stage: r.param("x", natural) })))',
		verdict: { kind: "refusal", refusal: "the query's head is not a fact of the relation" }
	},
	{
		what: "a reference stated from a literal",
		statement:
			'ChangeSet.empty(S).insert(Session, query(S).rule((r) => r.find({ child: r.param("c", int4), item: r.param("i", int4), stage: 5n })))',
		verdict: { kind: "refusal", refusal: "the query's head is not a fact of the relation" }
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
			'query(S).rule((r) => { const { child, seed } = v(Decision, "d"); return r.match(Decision, { child, seed }).find({ x: Type.cast(Type.cast(seed, int8), instant) }) })',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a contract named instant",
		statement: 'contract<typeof probeKey>()("instant", int8)',
		verdict: {
			kind: "refusal",
			refusal: "a contract's name is apart from natural and instant, grizzle's own types"
		}
	},
	{
		what: "a contract over an instant",
		statement: 'contract<typeof probeKey>()("Stamp", instant)',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a range of instants",
		statement: "range(instant)",
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
		what: "an insert of host rows stating a stored instant a read delivered",
		statement:
			"(row: ResultOf<HeadOf<typeof decisions>>) => ChangeSet.empty(S).insert(Seen, [{ child: row.child, at: row.at }])",
		verdict: admitted
	},
	{
		what: "an insert of host rows stating a stored instant of a bigint",
		statement: "ChangeSet.empty(S).insert(Seen, [{ child: 1, at: 5n }])",
		verdict: { kind: "refusal", refusal: "a member fact is not a fact of the relation" }
	},
	{
		what: "an insert of host rows stating a stored instant of a read's max",
		statement:
			"(row: ResultOf<HeadOf<typeof latest>>) => ChangeSet.empty(S).insert(Seen, [{ child: row.child, at: row.m }])",
		verdict: admitted
	},
	{
		what: "an instant a read delivered is a bigint",
		statement: "(row: ResultOf<HeadOf<typeof decisions>>): bigint => row.at",
		verdict: admitted
	},
	{
		what: "a bigint is no instant",
		statement: "(x: bigint): Instant => x",
		verdict: { kind: "refused", why: "a bigint is no Instant" }
	},
	{
		what: "a put of host rows stating stored instants a read delivered",
		statement:
			"(row: ResultOf<HeadOf<typeof decisions>>) => ChangeSet.empty(S).put(Seen, [{ child: row.child, at: row.at }])",
		verdict: admitted
	},
	{
		what: "a delete of host rows stating stored instants a read delivered",
		statement:
			"(row: ResultOf<HeadOf<typeof decisions>>) => ChangeSet.empty(S).delete(Seen, [{ child: row.child, at: row.at }])",
		verdict: admitted
	},
	{
		what: "a parameter of a stored instant's type",
		statement: 'query(S).rule((r) => r.find({ x: r.param("x", instant.stored) }))',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a relation parameter's stored instant column",
		statement:
			'query(S).rule((r) => { const p = r.relation("p", { at: instant.stored }); const { at } = v(p, "p"); return r.match(p, { at }).find({ at }) })',
		verdict: { kind: "refusal", refusal: inputRefusal }
	},
	{
		what: "a stored instant compared with a clock",
		statement:
			'query(S).rule((r) => { const { child, at } = v(Decision, "d"); const s = v(Seen, "s"); return r.match(Decision, { child, at }).match(Seen, { child, at: s.at }).where(r.le(s.at, at)).find({ child }) })',
		verdict: admitted
	},
	{
		what: "a row an evaluator admits stating the clock as a bigint",
		statement:
			"(evaluator: RowEvaluator<typeof S>) => evaluator.admit(Decision, { child: 1, at: 5n, seed: 2 })",
		verdict: admitted
	},
	{
		what: "a row an evaluator admits stating a stored instant as a bigint",
		statement: "(evaluator: RowEvaluator<typeof S>) => evaluator.admit(Seen, { child: 1, at: 5n })",
		verdict: admitted
	},
	{
		what: "an admitted row's instant is no instant a read delivered",
		statement:
			"(evaluator: RowEvaluator<typeof S>) => Result.map(evaluator.admit(Seen, { child: 1, at: 5n }), (admitted): Instant => admitted.row.at)",
		verdict: { kind: "refused", why: "an evaluated row's instant is a bigint" }
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

/** Decision, its at a clock of child `child`, Session, its stage a reference to it, and Seen, its at a stored instant;
 * Decision and Seen open, mutable inside the unit of their child, so their puts and deletes meet the instants' rules. */
const instantsHeader = `export const probeKey = Symbol("Probe")
export const Decision = relation("Decision", { child: int4, at: instant, seed: int4 }, ["child", "at"])
export const Session = relation("Session", { child: int4, item: int4, stage: instant }, ["child", "item"])
export const Seen = relation("Seen", { child: int4, at: instant.stored }, ["child", "at"])
export const S = schema("S", [Decision, Session, Seen], [contained(on(Session, "child", "stage"), on(Decision, "child", "at")), unit("Child", { child: int4 }), mutable(Decision), mutable(Seen)])
export const decisions = query(S).rule((r) => { const { child, at } = v(Decision, "d"); return r.match(Decision, { child, at }).find({ child, at }) })
export const latest = query(S).rule((r) => { const { child, at } = v(Decision, "d"); return r.match(Decision, { child, at }).find({ child, m: r.max(at) }) })
export declare const decoder: FactsDecoder<typeof S>
export declare const decided: InsertAllRowsOf<typeof S>["Decision"]
export declare const readAt: Instant
export const Writer = role(S, "writer", { Decision, Session, Seen }, { write: ["Decision"] })
export const adding = workload(Writer, { add: ChangeSet.empty(S).insert(Decision, []) })
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
