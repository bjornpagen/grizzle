import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The empty level program: a read of no relation over schema.empty, and the reads and commits a role that holds nothing
 * of its base's own makes of it, each a statement over App (Base's Want and Thin, an extension of no relation of its
 * own over it, below a fragment of Hour that the role Den alone holds), under the directive the type-test batch disarms
 * exactly where the rule refuses it. The rule, the oracle: the empty level is the level below every root, a query over
 * which every level's reader of queries admits beside its own (types/query/query.ts QueryOver, types/schema/schema.ts
 * EmptyLevel), and which every reader that refuses a source over no level holds a level (IsLevelOrEmptyInvariant), so a
 * read over it is a read over every level: it runs on every role, which holds it whole whatever it holds, is bound to a
 * relation parameter of a read over any level, which it raises to no level of its own, is a role's query entry over any
 * base, and is matched, bound by its parameters, by a rule over any level or role, as den's census of a root derived
 * from its key requests it over its role; a read over a level holding a relation the role does not hold, the base's or
 * an extension's of no relation of its own over it, runs on no role that does not hold it, and no rule over the role
 * matches it. Each statement is a cell of the box.
 */

/** A cell: what it states, its statement, and the rule's verdict, a refusal its types name or one they name none of. */
interface EmptyLevelCase {
	readonly what: string
	readonly statement: string
	readonly verdict:
		| { readonly kind: "admitted" }
		| { readonly kind: "refusal"; readonly refusal: Refused }
		| { readonly kind: "refused"; readonly why: string }
}

const admitted = { kind: "admitted" } as const

const boxCases: ReadonlyArray<EmptyLevelCase> = [
	{
		what: "a workload over a role holding nothing of the base of a read over the empty level",
		statement: "workload(Den, { hourOf })",
		verdict: admitted
	},
	{
		what: "a commit over that role of the rows of a read over the empty level",
		statement: "ChangeSet.empty(Den).insert(Hour, hourOf)",
		verdict: admitted
	},
	{
		what: "a workload over a role holding the base whole of a read over the empty level",
		statement: "workload(Full, { hourOf })",
		verdict: admitted
	},
	{
		what: "a relation parameter of a read over the base bound to a read over the empty level of no parameter",
		statement:
			'query(Base).rule((r) => { const p = r.relation("p", { at: int8 }); const { at } = v(p, "p"); return r.match(p, { at }).find({ at }) }).bind({ p: query(schema.empty).rule((r) => r.find({ at: 5n })) })',
		verdict: admitted
	},
	{
		what: "a role's query entry over the empty level",
		statement: 'role(App, "clock", { Tick: query(schema.empty).rule((r) => r.find({ at: 5n })) })',
		verdict: admitted
	},
	{
		what: "a census over a role holding nothing of the base, den's request of a root derived from its key: the insert of the rows a read over the empty level, bound by the request's own parameters, finds that the role holds no row of yet",
		statement:
			'ChangeSet.empty(Den).insert(Hour, query(Den).rule((r) => { const derived = hourOf.bind({ at: r.param("hourAt", int8), bell: r.param("hourBell", Name) }); const { at, bell } = v(derived, "derived"); return r.match(derived, { at, bell }).where(r.not(Hour, { at, bell })).find({ at, bell }) }))',
		verdict: admitted
	},
	{
		what: "a rule over an extension of the base matching a read over the empty level bound by the rule's own parameters",
		statement:
			'query(App).rule((r) => { const derived = hourOf.bind({ at: r.param("hourAt", int8), bell: r.param("hourBell", Name) }); const { at, bell } = v(derived, "derived"); return r.match(derived, { at, bell }).find({ at, bell }) })',
		verdict: admitted
	},
	{
		what: "a rule over a role holding nothing of the base matching a read of the base's relation",
		statement:
			'query(Den).rule((r) => { const { batch, size } = v(wantOf, "want"); return r.match(wantOf, { batch, size }).find({ batch, size }) })',
		verdict: { kind: "refusal", refusal: "the query is not over a level of this query's schema" }
	},
	{
		what: "a workload over a role holding nothing of the base of a read of the base's relation",
		statement: "workload(Den, { wantOf })",
		verdict: {
			kind: "refused",
			why: "a read over a level runs only on a role that holds every relation of it"
		}
	},
	{
		what: "a workload over a role holding nothing of the base of a read over a level of the base declaring no relation of its own",
		statement: "workload(Den, { thinWant })",
		verdict: {
			kind: "refused",
			why: "a level that declares nothing over the base is no empty level: it holds the base's relations"
		}
	}
]

/** The cells of emptyLevelBox, minted as a dictionary in its door (test/types/schema/empty-level.dictionary.ts). */
export const emptyLevelBoxItems: Arr.NonEmptyReadonlyArray<EmptyLevelCase> = [
	defined(boxCases[0], "a case of the empty level box"),
	...Arr.drop(boxCases, 1)
]

/** A cell's directive, where the rule refuses it. */
const directiveOf = (c: EmptyLevelCase): ReadonlyArray<string> => {
	switch (c.verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${c.verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${c.verdict.why}`]
	}
}

const caseBlock = (c: EmptyLevelCase, index: number): ReadonlyArray<string> => [
	`// ${c.what}`,
	...directiveOf(c),
	`export const c${index} = ${c.statement}`,
	""
]

/** The program's prelude (test/support/programs/empty-level.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/empty-level.ts"))

/**
 * App: Base's Want, Thin, an extension of no relation of its own over Base, and over it a fragment of Hour; Den, a role
 * holding Hour alone, and Full, one holding every relation; a read over the empty level of its two parameters, and reads
 * of Want over Base and over Thin.
 */
const emptyLevelHeader = `const Name = str.regex("^[a-z]{1,8}$")
export const Want = relation("Want", { batch: Name, size: int8 }, ["batch"])
export const Hour = relation("Hour", { at: int8, bell: Name }, ["at", "bell"])
export const Base = schema("Base", [Want], [])
export const Thin = schema.extend([Base], "Thin", [], [])
export const App = schema.extend([Thin], "App", [fragment([Hour], [])], [])
export const Den = role(App, "den", { Hour }, { insert: ["Hour"] })
export const Full = role(App, "full", { Want, Hour }, { insert: ["Want", "Hour"] })
export const hourOf = query(schema.empty).rule((r) => r.find({ at: r.param("at", int8), bell: r.param("bell", Name) }))
export const wantOf = query(Base).rule((r) => { const { batch, size } = v(Want, "want"); return r.match(Want, { batch, size }).find({ batch, size }) })
export const thinWant = query(Thin).rule((r) => { const { batch, size } = v(Want, "want"); return r.match(Want, { batch, size }).find({ batch, size }) })
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const emptyLevelProgram = (
	cells: Arr.NonEmptyReadonlyArray<EmptyLevelCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/empty-level.ts: a read over the empty level, and what a role makes of it.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(emptyLevelHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
