import { indices } from "@bjornpagen/grizzle-text/base/array"
import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import { type EqualSteps, equalSteps } from "#test/support/types/batch/measured.ts"

/**
 * The programs of a union's arms and of a ChangeSet's members read through one (unions.test.ts), each checked at three
 * sizes an equal step apart, each step a whole number of its generator's period:
 *
 * - a negated union: one query of `rules` rules over a level of eight sidecars, rule i matching a sent state, the
 *   current state and sidecar i (round the sidecars), negating the sidecar at the current state and delivering the
 *   result, the instant and its field's handle, a closed roster's i-th; a further rule negates the union by the result
 *   and the instant, as metis's reconciliation confirms a write no mismatch names (oneroster-sync reconciled.ts
 *   resultMismatches, 24 rules, TS5115 at ConstantsAt);
 * - members over a bound union: a ChangeSet of `members` inserts, member m into sidecar m (round the sidecars), each a
 *   query matching `fresh` bound to two parameters and three relation parameters, and a relation parameter of its own,
 *   `fresh` matching `chosen`, a union of six rules over the relation parameters and a take over the pool, as metis's
 *   assign does (assignment assign.ts, 25 inserts over a six-rule union, TS2590).
 */
type UnionShape = {
	readonly rules: number
	readonly members: number
}

/** One dimension: its name, its sizes, and the shape at a size along it. */
interface UnionDimension {
	readonly name: string
	readonly steps: EqualSteps
	readonly shape: (size: number) => UnionShape
}

/** The sidecars every program declares, which rules and members go round: the period of both dimensions. */
const sidecars = 8

/** The arms of `chosen`, metis's: a named test or a grade's pool, each with the gate bypassed or not. */
const chosenArms = 6

/** A union's arms, six periods of the sidecars a step: 48, 96 and 144 rules, past metis's 24 twice over. */
const armsDimension: UnionDimension = {
	name: "the rules of a union a further rule negates",
	steps: equalSteps(6 * sidecars),
	shape: (rules) => ({ rules, members: 0 })
}

/** A ChangeSet's members, four periods of the sidecars a step: 32, 64 and 96 inserts, beyond metis's 25. */
const membersDimension: UnionDimension = {
	name: "ChangeSet inserts over a bound union with relation parameters",
	steps: equalSteps(4 * sidecars),
	shape: (members) => ({ rules: 0, members })
}

/** The level every program is over: states, sidecars and the pool, and the roster a mismatch names its field by. */
const level = (fields: number): string => `const resultIdKey = Symbol("ResultId")
const ResultId = domain<typeof resultIdKey>()("ResultId", uuid)
const stateIdKey = Symbol("StateId")
const StateId = domain<typeof stateIdKey>()("StateId", uuid)
const testIdKey = Symbol("TestId")
const TestId = domain<typeof testIdKey>()("TestId", uuid)
const Subject = str.regex("^[a-z]{1,16}$")
export const Title = str.regex("^.*$", "su")
export const Field = closed.unordered("Field", [${Arr.join(
	Arr.map(indices(Math.max(fields, 1)), (i) => `"f${i}"`),
	", "
)}])
export const Sent = relation("Sent", { result: ResultId, at: natural, state: StateId }, ["result", "at"])
export const Current = relation("Current", { result: ResultId, state: StateId }, ["result"])
${Arr.join(
	Arr.map(
		indices(sidecars),
		(j) =>
			`export const V${j} = relation("V${j}", { result: ResultId, state: StateId, value: natural }, ["result", "state"])\nexport const W${j} = relation("W${j}", { number: natural, test: TestId, note: natural }, ["number"])`
	),
	"\n"
)}
export const Test = relation("Test", { test: TestId, place: natural }, ["test"])
export const Result = relation("Result", { user: natural, test: TestId }, ["user", "test"])
export const Pool = relation("Pool", { subject: Subject, grade: natural, test: TestId, place: natural }, ["test"])
export const S = schema("S", [Field, Sent, Current, Test, Result, Pool, ${Arr.join(
	Arr.map(indices(sidecars), (j) => `V${j}, W${j}`),
	", "
)}], [])
`

/** Rule i of the negated union: sidecar i's value sent and not current, named by the roster's i-th handle. */
const mismatchRule = (i: number): string => `	.rule((r) => {
		const { result, at, state: sent } = v(Sent, "sent")
		const { state: current } = v(Current, "current")
		const { value } = v(V${i % sidecars}, "was")
		return r
			.match(Sent, { result, at, state: sent })
			.match(Current, { result, state: current })
			.match(V${i % sidecars}, { result, state: sent, value })
			.where(r.not(V${i % sidecars}, { result, state: current, value }))
			.find({ result, at, field: Field.handle("f${i}") })
	})`

/** The union of `rules` rules, its definition, and a query that confirms what no rule of it names. */
const negatedUnion = (rules: number): string => `const mismatches = query(S)
${Arr.join(Arr.map(indices(rules), mismatchRule), "\n")}
export const Diverged = derived("Diverged", mismatches)
export const confirmed = query(S).rule((r) => {
	const { result, at, state } = v(Sent, "sent")
	return r.match(Sent, { result, at, state }).where(r.not(mismatches, { result, at })).find({ result, at })
})
`

/** Arm a of `chosen`: a named test, or the first of a grade's pool beside the caller's titles, the gate bypassed or not. */
const chosenArm = (a: number): string =>
	a % 2 === 0
		? `	.rule((r) => {
		const { test } = v(r.relation("test", namedTest), "named")
		return r
			.match(r.relation("test", namedTest), { test })
			.where(r.eq(r.param("bypass", bool), ${a % 4 === 0 ? "true" : "false"}), r.not(Result, { user: r.param("user", natural), test }))
			.find({ test, arm: ${a}n })
	})`
		: `	.rule((r) => {
		const { subject, grade } = v(r.relation("grade", namedGrade), "grade")
		const first = firstOfPool.bind({ subject, grade })
		const { test } = v(first, "first")
		const { title } = v(r.relation("titles", { title: Title }), "title")
		return r
			.match(r.relation("grade", namedGrade), { subject, grade })
			.match(r.relation("titles", { title: Title }), { title })
			.match(first, { test })
			.where(r.eq(r.param("bypass", bool), ${a % 4 === 1 ? "true" : "false"}))
			.find({ test, arm: ${a}n })
	})`

/** Member m: sidecar m's insert of what `fresh` makes, beside a relation parameter of the member's own. */
const memberCall = (m: number): string => `	.insert(
		W${m % sidecars},
		query(S).rule((r) => {
			const made = fresh.bind({
				user: r.param("user", natural),
				bypass: r.param("bypass", bool),
				test: r.relation("test", namedTest),
				grade: r.relation("grade", namedGrade),
				titles: r.relation("titles", { title: Title })
			})
			const { number, test } = v(made, "fresh")
			const { note } = v(r.relation("note${m}", { note: natural }), "n")
			return r.match(made, { number, test }).match(r.relation("note${m}", { note: natural }), { note }).find({ number, test, note })
		})
	)`

/** The ChangeSet of `members` members over `fresh`, the bound six-rule union. */
const boundMembers = (members: number): string => `const namedTest = { test: TestId } as const
const namedGrade = { subject: Subject, grade: natural } as const
const firstOfPool = query(S)
	.rule((r) => {
		const { test, place } = v(Pool, "pool")
		return r.match(Pool, { subject: r.param("subject", Subject), grade: r.param("grade", natural), test, place }).find({ test, place })
	})
	.orderBy(["place", "asc"], ["test", "asc"])
	.take(1)
const chosen = query(S)
${Arr.join(Arr.map(indices(chosenArms), chosenArm), "\n")}
const fresh = query(S).rule((r) => {
	const pick = chosen.bind({
		user: r.param("user", natural),
		bypass: r.param("bypass", bool),
		test: r.relation("test", namedTest),
		grade: r.relation("grade", namedGrade),
		titles: r.relation("titles", { title: Title })
	})
	const { test } = v(pick, "pick")
	const { place } = v(Test, "t")
	return r.match(pick, { test }).match(Test, { test, place }).find({ number: place, test })
})
export const assign = ChangeSet.empty(S)
${Arr.join(Arr.map(indices(members), memberCall), "\n")}
`

/** A complete program at `shape`, its imports read through the gates' prelude as `entries` reaches it. */
const unionSource = (shape: UnionShape, entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/query/budget/unions.ts at ${jsonText(shape)}.`,
		entries,
		`${level(shape.rules)}${shape.rules > 0 ? negatedUnion(shape.rules) : ""}${
			shape.members > 0 ? boundMembers(shape.members) : ""
		}`
	)

/** A dimension as a gate's cell: its name, its steps, and its program at a size. */
const cellOf = (dimension: UnionDimension) => ({
	name: dimension.name,
	steps: dimension.steps,
	source: (size: number, entries: PreludeAt) => unionSource(dimension.shape(size), entries)
})

/** The cells of unionArms, minted as a dictionary in its door (test/types/query/budget/unions.dictionary.ts). */
export const unionArmsItems: Arr.NonEmptyReadonlyArray<ReturnType<typeof cellOf>> = [
	cellOf(armsDimension)
]

/** The cells of boundMembers, minted as a dictionary in its door (test/types/query/budget/unions.dictionary.ts). */
export const boundMembersItems: Arr.NonEmptyReadonlyArray<ReturnType<typeof cellOf>> = [
	cellOf(membersDimension)
]
