/**
 * The isolation certifier's soundness suite's races (isolation.test.ts): each search's races and values, the
 * installations every case's seats clone, and the judgment of one case of each against the serial reference.
 */
import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { pctSchedule } from "@bjornpagen/testing/interleave"
import { type Case, type Resources } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import type { RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { type CounterShape, flawedCertificates } from "#test/pg/isolation/support/certify.ts"
import {
	callParams,
	type DrawnRace,
	drawnCertificates,
	drawnShape,
	factCertificates
} from "#test/pg/isolation/support/drawn.ts"
import {
	countShape,
	leaseShape,
	takeShape,
	unmatchedShape
} from "#test/pg/isolation/support/lease.ts"
import {
	type CallInput,
	type Certifier,
	certifiedShapeTemplate,
	generatedShapeTemplate,
	installShape,
	type IsolationRace,
	raceMoves,
	raceOn,
	type RaceCall,
	runIsolationRace,
	type SeatedShape,
	seatedCertified,
	seatedGenerated,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import {
	carrierShape,
	claimShape,
	copiesShape,
	deferredShape,
	fallbackShape,
	fencedShape,
	fkShape,
	foldShape,
	listedShape,
	partialShape,
	pointCopiesShape,
	pointShape,
	probeShape,
	publishedShape,
	readersShape,
	sittingShape,
	skewShape
} from "#test/pg/isolation/support/shapes.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { every, type Strategy } from "#test/support/schedules/interleave.ts"
import type { Explained, RaceTxn } from "#test/support/schedules/serial.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A uuid of the races' small pool: parents, docs and sittings. */
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`

/** A call of a race before its session is named: a member of a role with its input. */
interface CallSketch {
	readonly role: string
	readonly member: string
	readonly input: CallInput
}

const call = (role: string, member: string, params: ParamMap): CallSketch => ({
	role,
	member,
	input: { kind: "params", params }
})

/** A positive race: its shape, its initial facts and its calls. */
interface PositiveRace {
	readonly shape: "point" | "fold" | "sitting" | "named"
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
}

const callsOf =
	(gen: Gen<CallSketch>): Gen<Arr.NonEmptyReadonlyArray<CallSketch>> =>
	(source) => {
		const [first, ...rest] = source.draw(array(gen, { min: 2, max: 3 }))
		return [defined(first, "a race's first call"), ...rest]
	}

const someUuid =
	(count: number): Gen<string> =>
	(source) =>
		uuidOf(source.draw(int(1, count)))

const pointRace: Gen<PositiveRace> = (source) => ({
	shape: "point",
	initial: source.draw(
		element<FactSet>([
			{},
			{ Parent: [{ id: uuidOf(1), g: 0 }], Child: [{ parent: uuidOf(1), k: 0, g: 0 }] }
		])
	),
	calls: source.draw(
		callsOf(
			weighted<CallSketch>([
				[
					1,
					(s) =>
						call("learner", "start", {
							id: s.draw(someUuid(2)),
							g: s.draw(int(0, 1)),
							k: s.draw(int(0, 1))
						})
				],
				[
					1,
					(s) =>
						call("learner", "save", {
							parent: s.draw(someUuid(2)),
							k: s.draw(int(0, 1)),
							at: s.draw(int(0, 1)),
							v: s.draw(int(0, 1))
						})
				]
			])
		)
	)
})

/** An Invoice posted with its Lines, each call's facts. */
const postCall: Gen<CallSketch> = (s) => {
	const id = s.draw(someUuid(2))
	const lines = s.draw(array(element([1, 2, 3]), { min: 0, max: 2 }))
	return {
		role: "learner",
		member: "post",
		input: {
			kind: "facts",
			facts: {
				insert: {
					Invoice: [{ id, amount: s.draw(element([0, 3])) }],
					Line: Arr.map(lines, (amount, n) => ({ invoice: id, n, amount }))
				}
			},
			params: {}
		}
	}
}

const foldRace: Gen<PositiveRace> = (source) => ({
	shape: "fold",
	initial: {},
	calls: source.draw(
		callsOf(
			weighted<CallSketch>([
				[2, postCall],
				[1, (s) => call("auditor", "copy", { id: s.draw(someUuid(2)) })]
			])
		)
	)
})

/** An importer's call: a Doc with one pool or two, written whole. */
const importCall: Gen<CallSketch> = weighted<CallSketch>([
	[1, (s) => call("importer", "import1", { node: s.draw(someUuid(2)), a: s.draw(int(1, 2)) })],
	[
		1,
		(s) =>
			call("importer", "import2", {
				node: s.draw(someUuid(2)),
				a: s.draw(int(1, 2)),
				b: s.draw(int(1, 2))
			})
	]
])

const sittingCall: Gen<CallSketch> = weighted<CallSketch>([
	[1, importCall],
	[
		1,
		(s) =>
			call("learner", "start", {
				id: uuidOf(10 + s.draw(int(1, 2))),
				doc: s.draw(someUuid(2)),
				child: s.draw(int(0, 1))
			})
	]
])

const namedCall: Gen<CallSketch> = weighted<CallSketch>([
	[1, importCall],
	[
		1,
		(s) =>
			call("learner", "begin1", {
				id: uuidOf(10 + s.draw(int(1, 2))),
				doc: s.draw(someUuid(2)),
				child: s.draw(int(0, 1)),
				a: s.draw(int(1, 2))
			})
	],
	[
		1,
		(s) =>
			call("learner", "begin2", {
				id: uuidOf(10 + s.draw(int(1, 2))),
				doc: s.draw(someUuid(2)),
				child: s.draw(int(0, 1)),
				a: s.draw(int(1, 2)),
				b: s.draw(int(1, 2))
			})
	]
])

/** One Doc imported whole before the race: two pools, of sizes 1 and 2. */
const imported: FactSet = {
	Doc: [{ node: uuidOf(1), n: 2 }],
	Pool: [
		{ doc: uuidOf(1), pool: 0, size: 1 },
		{ doc: uuidOf(1), pool: 1, size: 2 }
	]
}

const sittingRace: Gen<PositiveRace> = (source) => ({
	shape: "sitting",
	initial: source.draw(element<FactSet>([{}, imported])),
	calls: source.draw(callsOf(sittingCall))
})

const namedRace: Gen<PositiveRace> = (source) => ({
	shape: "named",
	initial: source.draw(element<FactSet>([{}, imported])),
	calls: source.draw(callsOf(namedCall))
})

/** One race of each positive shape, every one of which a case runs. */
export type PositiveRaces = Readonly<Record<PositiveRace["shape"], PositiveRace>>

export const positiveRaces: Gen<PositiveRaces> = (source) => ({
	point: source.draw(pointRace),
	fold: source.draw(foldRace),
	sitting: source.draw(sittingRace),
	named: source.draw(namedRace)
})

const positiveShapes: Arr.NonEmptyReadonlyArray<PositiveRace["shape"]> = [
	"point",
	"fold",
	"sitting",
	"named"
]

/** A counterexample race: the flawed certifier's shape and the calls that catch it. */
interface CounterRace {
	readonly shape: CounterShape
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
	readonly schedule: CounterSchedule
}

/**
 * How a pinned race is run: every order, or the history its finder pinned, as a PCT schedule. `session` runs first
 * and pauses before its COMMIT or before its last statement; each of `trailing` then opens its transaction with its
 * first statement, which states its level and reads nothing, and waits; every other session runs to its end in turn;
 * then `session` finishes, and after it each of `trailing` in order. A session a refusal ends early simply stops, as
 * PCT runs whichever session can move.
 */
type CounterSchedule =
	| { readonly kind: "every" }
	| {
			readonly kind: "paused"
			readonly session: string
			readonly before: "commit" | "lastStatement"
			readonly trailing: ReadonlyArray<string>
	  }

const everyOrder: CounterSchedule = { kind: "every" }

/** NEGATION's histories: s0's statements, s1 through COMMIT, s2 through COMMIT, then s0's COMMIT. */
const pivotThenReader: CounterSchedule = {
	kind: "paused",
	session: "s0",
	before: "commit",
	trailing: []
}

/**
 * The strategy that runs `schedule` over the race's transactions. A pinned schedule's PCT priorities put `session`
 * first, then `trailing`, then the rest in order; its change points drop `session` after its moves before the pause
 * and each of `trailing` after its first move, the earlier change points dropping lower, so the dropped sessions finish
 * last, `session` before `trailing`.
 */
const counterStrategy =
	<F extends string>(schedule: CounterSchedule, c: Case<F>) =>
	(txns: ReadonlyArray<RaceTxn<never>>): Strategy => {
		if (schedule.kind === "every") {
			return every
		}
		const paused = defined(
			Option.getOrUndefined(Arr.findFirst(txns, (t) => t.session === schedule.session)),
			`the transaction of ${schedule.session}`
		)
		const statements = paused.kind === "direct" ? paused.statements.length : 1
		const pause = schedule.before === "commit" ? statements : statements - 1
		const held = new Set([schedule.session, ...schedule.trailing])
		return {
			kind: "pct",
			schedule: {
				priorities: [
					schedule.session,
					...schedule.trailing,
					...Arr.filter(
						Arr.map(txns, (t) => t.session),
						(session) => !held.has(session)
					)
				],
				changes: [...Arr.reverse(Arr.map(schedule.trailing, (_, i) => pause + 1 + i)), pause]
			},
			nature: c
		}
	}

const partialRace: Gen<CounterRace> = (source) => {
	const k = source.draw(int(0, 1))
	return {
		shape: "partial",
		schedule: everyOrder,
		initial: { Parent: [{ id: uuidOf(1), g: 0 }] },
		calls: [
			call("joiner", "join", { id: uuidOf(1), k }),
			call("joiner", "join", { id: uuidOf(1), k: k + 1 })
		]
	}
}

const copiesRace: Gen<CounterRace> = (source) => ({
	shape: "copies",
	schedule: everyOrder,
	initial: {},
	calls: [
		call("copier", "m1", { v: source.draw(int(1, 2)) }),
		call("copier", "m2", { v: source.draw(int(1, 2)) })
	]
})

const pointCopiesRace: Gen<CounterRace> = (source) => {
	const params = { x: source.draw(int(1, 2)), y: source.draw(int(1, 2)) }
	return {
		shape: "pointCopies",
		schedule: everyOrder,
		initial: {},
		calls: [call("copier", "m1", params), call("copier", "m2", params)]
	}
}

const spanningRace: Gen<CounterRace> = (source) => {
	const v = source.draw(int(1, 2))
	return {
		shape: "spanning",
		schedule: everyOrder,
		initial: {},
		calls: [
			call("writer", "m1", { v }),
			call("writer", "m3", { v }),
			call("spanning", "both", { v })
		]
	}
}

const extendedRace: Gen<CounterRace> = (source) => {
	const a = source.draw(int(1, 2))
	return {
		shape: "extended",
		schedule: everyOrder,
		initial: { Doc: [{ node: uuidOf(1), n: 1 }], Pool: [{ doc: uuidOf(1), pool: 0, size: a }] },
		calls: [
			call("learner", "start", { id: uuidOf(11), doc: uuidOf(1), child: 0 }),
			call("importer", "extend", { node: uuidOf(1), pool: 1, a: source.draw(int(1, 2)) })
		]
	}
}

/** NEGATION's first history: the pivot writer's m1, m3 committed, then the reader of m1's row at READ COMMITTED. */
const singleRace: CounterRace = {
	shape: "single",
	schedule: pivotThenReader,
	initial: {},
	calls: [
		call("writer", "m1", { v: 1 }),
		call("writer", "m3", { v: 1 }),
		call("single", "one", { v: 1 })
	]
}

/** NEGATION's second history: m1, m4 inserting B(1) and A(2), then the reader of A at the keys 1 and 2. */
const listedRace: CounterRace = {
	shape: "listed",
	schedule: pivotThenReader,
	initial: {},
	calls: [
		call("writer", "m1", { v: 1 }),
		call("writer", "m4", { v: 1, w: 2 }),
		call("listed", "many", { keys: [{ v: 1 }, { v: 2 }] })
	]
}

/** NEGATION's third history: m1, m3 committed, then C(1) from B(1), whose foreign key into A misses m1's A(1). */
const fkRace: CounterRace = {
	shape: "fk",
	schedule: pivotThenReader,
	initial: {},
	calls: [
		call("writer", "m1", { v: 1 }),
		call("writer", "m3", { v: 1 }),
		call("checker", "check", { v: 1 })
	]
}

/**
 * NEGATION's fourth history: from A(1), the copier's Held(1) checked at COMMIT, after A(2) and Holder(1) from it
 * committed between its statement and its COMMIT.
 */
const deferredRace: CounterRace = {
	shape: "deferred",
	schedule: pivotThenReader,
	initial: { A: [{ v: 1 }] },
	calls: [
		call("copier", "many", { keys: [{ v: 1 }, { v: 2 }] }),
		call("adder", "add", { v: 2 }),
		call("holder", "hold", { v: 1, w: 2 })
	]
}

/**
 * NEGATION's fifth history: `both` over the keys 1 and 2 at G(1) runs to its last statement, G(1) is inserted and
 * committed, then `both` reads G(1) again and finishes.
 */
const carrierRace: CounterRace = {
	shape: "carrier",
	schedule: { kind: "paused", session: "s0", before: "lastStatement", trailing: [] },
	initial: {},
	calls: [
		call("twice", "both", { keys: [{ k: 1 }, { k: 2 }], g: 1 }),
		call("grower", "grow", { v: 1 })
	]
}

/**
 * NEGATION's B-03c negative: the fallback reads G(1) absent and writes W(1) = 0; G(1) is inserted and committed; the
 * observer, after both in real time, sees G(1) but not the fallback's W(1); then the fallback commits.
 */
const fallbackRace: CounterRace = {
	shape: "fallback",
	schedule: pivotThenReader,
	initial: {},
	calls: [
		call("fallback", "fallback", { k: 1 }),
		call("inserter", "insertG", { k: 1, x: 5 }),
		call("observer", "observe", { k: 1 })
	]
}

/**
 * NEGATION's third B-03c negative, the race and schedule of the fallback's: the fallback's bound import yields only
 * its default arm, G(1) absent, and writes W(1) = 0; G(1) is inserted and committed; the observer sees G(1) but not
 * W(1); then the fallback commits.
 */
const boundFallbackRace: CounterRace = { ...fallbackRace, shape: "boundFallback" }

/**
 * NEGATION's fourth B-03c negative, the race and schedule of the fallback's: the fallback's bound recursive import
 * yields its base row 1, G(1) absent, and writes W(1) = 0; G(1) is inserted and committed; the observer sees G(1) but
 * not W(1); then the fallback commits.
 */
const recursiveFallbackRace: CounterRace = { ...fallbackRace, shape: "recursiveFallback" }

/** One race of each counterexample, every one of which a case runs. */
export type CounterRaces = Readonly<Record<CounterShape, CounterRace>>

export const counterRaces: Gen<CounterRaces> = (source) => ({
	partial: source.draw(partialRace),
	copies: source.draw(copiesRace),
	pointCopies: source.draw(pointCopiesRace),
	spanning: source.draw(spanningRace),
	extended: source.draw(extendedRace),
	single: singleRace,
	listed: listedRace,
	fk: fkRace,
	deferred: deferredRace,
	carrier: carrierRace,
	fallback: fallbackRace,
	boundFallback: boundFallbackRace,
	recursiveFallback: recursiveFallbackRace
})

const counterShapes: Arr.NonEmptyReadonlyArray<CounterShape> = [
	"partial",
	"copies",
	"pointCopies",
	"spanning",
	"extended",
	"single",
	"listed",
	"fk",
	"deferred",
	"carrier",
	"fallback",
	"boundFallback",
	"recursiveFallback"
]

/** The race of `sketch`: each call in a session of its own, s0, s1, ... */
const raceOf = (sketch: {
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
}): IsolationRace => {
	const [first, ...rest] = Arr.map(sketch.calls, (c, i): RaceCall => ({
		kind: "change",
		session: `s${i}`,
		...c
	}))
	return { initial: sketch.initial, calls: [defined(first, "a call"), ...rest] }
}

/** Every order where the race makes few moves; past that, a PCT schedule of depth 3 the case draws. */
const exhaustiveMoves = 6

const strategyOf =
	<F extends string>(c: Case<F>) =>
	(txns: ReadonlyArray<RaceTxn<never>>): Strategy => {
		const moves = raceMoves(txns)
		return moves <= exhaustiveMoves
			? every
			: {
					kind: "pct",
					schedule: c.draw(
						pctSchedule(
							nonEmptyList(
								Arr.map(txns, (t) => t.session),
								"a race's sessions"
							),
							3,
							moves
						)
					),
					nature: c
				}
	}

/** What one explained run reached. */
type RunFeature = "two calls overlapped" | "a statement waited"

export type PositiveFeature = PositiveRace["shape"] | RunFeature | "a READ COMMITTED role called"

const noteRunOf =
	(note: (feature: RunFeature) => void) =>
	(e: Explained<never>): void => {
		const spans = Rec.values(e.run.spans)
		if (
			Arr.some(spans, (a, i) =>
				Arr.some(spans, (b, j) => i !== j && a.start < b.end && b.start < a.end)
			)
		) {
			note("two calls overlapped")
		}
		if (Arr.some(e.run.moves, (m) => m.observed._tag === "Waited")) {
			note("a statement waited")
		}
	}

/** A drawn race as the oracle runs it: its stored rows, one per key, and each call in a session of its own. */
const drawnRaceOf = (race: DrawnRace): IsolationRace => {
	const stored = Arr.dedupeWith(race.initial, (a, b) => a.relation === b.relation && a.k === b.k)
	const initial: FactSet = Rec.fromEntries(
		Arr.map(
			[0, 1, 2, 3],
			(relation) =>
				[
					`R${relation}`,
					Arr.map(
						Arr.filter(stored, (row) => row.relation === relation),
						(row) => ({ k: row.k, v: row.v })
					)
				] as const
		)
	)
	const [first, ...rest] = Arr.map(race.calls, (c, i): RaceCall => ({
		kind: "change",
		session: `s${i}`,
		role: `r${c.role}`,
		member: `m${c.role}`,
		input: { kind: "params", params: callParams(race.installation, c.role, c.k, c.v) }
	}))
	return { initial, calls: [defined(first, "a call"), ...rest] }
}

export type DrawnFeature =
	| RunFeature
	| "another certifier differs from generate"
	| "a READ COMMITTED call"
	| "a READ COMMITTED pivot"
	| "a READ COMMITTED member of two statements"
	| "a READ COMMITTED reader of a SERIALIZABLE writer"

/** Another certifier a drawn race also runs at where its levels differ from generate's. */
interface Candidate {
	readonly label: string
	readonly roles: ReadonlyArray<RoleIsolation>
}

/** Each role's level among `roles`, by its name. */
const levelsOf = (roles: ReadonlyArray<RoleIsolation>): ReadonlyMap<string, Isolation> =>
	new Map(Arr.map(roles, (r) => [r.role, r.certificate.level] as const))

/** What one set of a drawn race's levels, every one of which the race runs at, admits at READ COMMITTED. */
const drawnFeatures = (
	race: DrawnRace,
	levels: ReadonlyMap<string, Isolation>
): ReadonlyArray<DrawnFeature> => {
	const members = race.installation.members
	const rc = (i: number) => levels.get(`r${i}`) === "readCommitted"
	const writes = (i: number) => new Set(Arr.map(defined(members[i], "member"), (st) => st.into))
	const readsOf = (i: number) =>
		Arr.flatMap(defined(members[i], "member"), (st) =>
			st.read.kind === "put" ? [] : [st.read.from]
		)
	const called: ReadonlyArray<number> = Arr.filter(
		Arr.dedupe(Arr.map(race.calls, (c) => c.role)),
		(i) => rc(i)
	)
	return Arr.flatMap(called, (i: number): ReadonlyArray<DrawnFeature> => [
		"a READ COMMITTED call",
		...(readsOf(i).length > 0 &&
		Arr.some(
			Arr.map(members, (_, j) => j),
			(j) => Arr.some(readsOf(j), (from) => writes(i).has(from))
		)
			? ["a READ COMMITTED pivot" as const]
			: []),
		...(defined(members[i], "member").length > 1
			? ["a READ COMMITTED member of two statements" as const]
			: []),
		...(Arr.some(readsOf(i), (from) =>
			Arr.some(
				Arr.map(members, (_, j) => j),
				(j) => j !== i && !rc(j) && writes(j).has(from)
			)
		)
			? ["a READ COMMITTED reader of a SERIALIZABLE writer" as const]
			: [])
	])
}

const generate: Certifier = { kind: "generate" }

/**
 * Which certificates a publication race's installation holds: generate's; the levels NEGATION expects of B-02e,
 * generate's with the learner READ COMMITTED; or those with the listed role or the publisher forced READ COMMITTED too.
 */
type PublishedCertifier =
	| "generate"
	| "B-02e's levels"
	| "listed forced READ COMMITTED"
	| "publisher forced READ COMMITTED"

/**
 * A race of NEGATION's publication layer (shapes.ts publishedShape): its certifier, whether every run must be serial
 * or one must be caught, its initial facts, its calls and its pinned history.
 */
interface PublishedRace {
	readonly label: string
	readonly certifier: PublishedCertifier
	readonly expect: "serial" | "caught"
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
	readonly schedule: CounterSchedule
}

/** Two distinct values the publication races write at, NEGATION's 1 and 2 drawn anew. */
export interface PublishedValues {
	readonly a: number
	readonly b: number
}

export const publishedValues: Gen<PublishedValues> = (source) => {
	const a = source.draw(int(1, 3))
	return { a, b: (a % 3) + 1 }
}

/** The pinned history whose s0 pauses before its COMMIT while every other session but `trailing` runs to its end. */
const pausedFirst = (trailing: ReadonlyArray<string>): CounterSchedule => ({
	kind: "paused",
	session: "s0",
	before: "commit",
	trailing
})

/**
 * NEGATION's publication races at `a` and `b`. Every one but the last two must be serial; races 7 and 8 force a role
 * READ COMMITTED against its certificate, and the oracle must catch each.
 */
const publishedRaces = ({ a, b }: PublishedValues): Arr.NonEmptyReadonlyArray<PublishedRace> => {
	const pivot = [call("writer", "m1", { v: a }), call("writer", "m3", { v: a })] as const
	const fromStore = (
		label: string,
		reader: CallSketch,
		certifier: PublishedCertifier
	): PublishedRace => ({
		label: `${label} (${certifier})`,
		certifier,
		expect: "serial",
		initial: {},
		calls: [
			...pivot,
			call("publisher", "pubB", { v: a }),
			reader,
			call("publisher", "pubA", { v: a })
		],
		schedule: pausedFirst(["s4"])
	})
	const refusal = (certifier: PublishedCertifier, expect: "serial" | "caught"): PublishedRace => ({
		label: `3. pubA against the in-flight pivot (${certifier})`,
		certifier,
		expect,
		initial: {},
		calls: [...pivot, call("publisher", "pubA", { v: a })],
		schedule: pausedFirst([])
	})
	const deferred = (certifier: PublishedCertifier, expect: "serial" | "caught"): PublishedRace => ({
		label: `8. copy checked at COMMIT (${certifier})`,
		certifier,
		expect,
		initial: { A: [{ v: a }, { v: b }], PubA: [{ v: a }] },
		calls: [
			call("listed", "copy", { keys: [{ v: a }, { v: b }] }),
			call("publisher", "pubA", { v: b }),
			call("publisher", "pubParent", { v: a, kind: 1 })
		],
		schedule: pausedFirst([])
	})
	const many = (certifier: PublishedCertifier): PublishedRace => ({
		label: `5. case 2 through the publisher (${certifier})`,
		certifier,
		expect: "serial",
		initial: {},
		calls: [
			call("writer", "m1", { v: a }),
			call("writer", "m6", { v: a, w: b }),
			call("publisher", "pubA", { v: b }),
			call("listed", "many", { keys: [{ v: a }, { v: b }] }),
			call("publisher", "pubA", { v: a })
		],
		schedule: pausedFirst(["s4"])
	})
	return [
		fromStore("1. case 1 through the publisher", call("learner", "one", { v: a }), "generate"),
		fromStore(
			"2. case 1 through the publisher, joint",
			call("learner", "joint", { v: a }),
			"generate"
		),
		refusal("generate", "serial"),
		fromStore("4. case 3 through the publisher", call("learner", "check", { v: a }), "generate"),
		{
			label: "4. case 3 through the publisher, published first",
			certifier: "generate",
			expect: "serial",
			initial: {},
			calls: [
				...pivot,
				call("publisher", "pubB", { v: a }),
				call("publisher", "pubA", { v: a }),
				call("learner", "check", { v: a })
			],
			schedule: pausedFirst(["s4"])
		},
		many("generate"),
		many("listed forced READ COMMITTED"),
		{
			label: "6. sibling triggers",
			certifier: "generate",
			expect: "serial",
			initial: {},
			calls: [
				call("writer", "m5", { v: a }),
				call("writer", "m7", { v: a }),
				call("learner", "one", { v: b })
			],
			schedule: pausedFirst([])
		},
		deferred("generate", "serial"),
		refusal("publisher forced READ COMMITTED", "caught"),
		deferred("listed forced READ COMMITTED", "caught")
	]
}

export type PublishedFeature =
	| "every publication race serial"
	| "races 7 and 8 caught"
	| "generate certifies the learner READ COMMITTED"

/** The values a fenced race writes at: two published keys, a stored s and another, and the learner's row's key. */
export interface FencedValues {
	readonly a: number
	readonly b: number
	readonly s: number
	readonly t: number
	readonly k: number
}

export const fencedValues: Gen<FencedValues> = (source) => {
	const a = source.draw(int(1, 3))
	const s = source.draw(int(0, 2))
	return {
		a,
		b: (a % 3) + 1,
		s,
		t: (s + 1 + source.draw(int(0, 1))) % 3,
		k: source.draw(int(1, 3))
	}
}

/**
 * What a fenced race holds beside the learner's call: a replace of the key it references by another fact
 * (a delete and an insert of the same key in one transaction), or by the stored one (no change); a removal of that key;
 * a replace of another key; a publish of the key that misses a gate committed before the learner began (NEGATION's case
 * 3); or a removal of the keys of PubA and PubZ, which the learner checks in the order its member states.
 */
type FencedKind =
	| "same-key replace"
	| "identical replace"
	| "removed key"
	| "kept key"
	| "in-flight publish"
	| "fenced removal, Z first"
	| "fenced removal, A first"

/** A race of the fenced shape (shapes.ts fencedShape): its kind, initial facts, calls and schedule. */
interface FencedRace {
	readonly kind: FencedKind
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
	readonly schedule: CounterSchedule
}

/**
 * The fenced shape's races at `values`: each pair of a publisher's write and a learner's call in every order; the
 * in-flight publish pinned as NEGATION's case 3, the publish paused before its COMMIT while the gate and the learner run
 * to their ends.
 */
const fencedRaces = ({ a, b, s, t, k }: FencedValues): Arr.NonEmptyReadonlyArray<FencedRace> => {
	const see = (key: number) => call("learner", "see", { k, v: key })
	const stored = { Pub: [{ v: a, s }] }
	return [
		{
			kind: "same-key replace",
			initial: stored,
			calls: [call("publisher", "replace", { v: a, s: t }), see(a)],
			schedule: everyOrder
		},
		{
			kind: "identical replace",
			initial: stored,
			calls: [call("publisher", "replace", { v: a, s }), see(a)],
			schedule: everyOrder
		},
		{
			kind: "removed key",
			initial: stored,
			calls: [call("publisher", "remove", { v: a }), see(a)],
			schedule: everyOrder
		},
		{
			kind: "kept key",
			initial: {
				Pub: [
					{ v: a, s },
					{ v: b, s }
				]
			},
			calls: [call("publisher", "replace", { v: a, s: t }), see(b)],
			schedule: everyOrder
		},
		{
			kind: "in-flight publish",
			initial: {},
			calls: [call("publisher", "publish", { v: a, s }), call("writer", "gate", { v: a }), see(a)],
			schedule: pausedFirst([])
		},
		{
			kind: "fenced removal, Z first",
			initial: { PubA: [{ v: a }], PubZ: [{ v: a }] },
			calls: [call("publisher", "removeBoth", { v: a }), call("learner", "za", { k, v: a })],
			schedule: everyOrder
		},
		{
			kind: "fenced removal, A first",
			initial: { PubA: [{ v: a }], PubZ: [{ v: a }] },
			calls: [call("publisher", "removeBoth", { v: a }), call("learner", "az", { k, v: a })],
			schedule: everyOrder
		}
	]
}

export type FencedFeature =
	| "generate certifies the learner READ COMMITTED"
	| "generate fences every publisher write of Pub"
	| "a learner's deferred check waited on a fenced write's lock"
	| "a fenced write's lock waited on a learner's check"
	| "a learner committed before a same-key replace began"
	| "a key removed beside a learner"
	| "a learner's check waited on an in-flight publish"
	| "a deadlock a fenced removal met"
	| "every fenced race serial"

/**
 * The features one run of a fenced race reaches: s0 is the publisher's session and s1 the learner's, but in the
 * in-flight publish, whose learner is s2; a wait is a move observed waiting on the other's lock; the learner's deferred
 * check is its COMMIT waiting for ROW SHARE on a relation; and the publisher's lock is its move sending one of `locks`,
 * its served writes' exclusions.
 */
const noteFencedRun =
	(kind: FencedKind, locks: ReadonlySet<string>, note: (feature: FencedFeature) => void) =>
	(e: Explained<never>): void => {
		const learner = kind === "in-flight publish" ? "s2" : "s1"
		const waited = (session: string, on: string) =>
			Arr.some(
				e.run.moves,
				(m) => m.session === session && m.observed._tag === "Waited" && m.observed.on.includes(on)
			)
		if (kind === "same-key replace") {
			if (
				Arr.some(
					e.run.moves,
					(m) =>
						m.session === learner &&
						m.label === "COMMIT" &&
						m.observed._tag === "Waited" &&
						m.observed.on.includes("s0") &&
						m.observed.lock.locktype === "relation" &&
						m.observed.lock.mode === "RowShareLock"
				)
			) {
				note("a learner's deferred check waited on a fenced write's lock")
			}
			const publisher = e.run.spans["s0"]
			const read = e.run.spans[learner]
			if (publisher !== undefined && read !== undefined && read.end < publisher.start) {
				note("a learner committed before a same-key replace began")
			}
		}
		if (kind === "removed key") {
			note("a key removed beside a learner")
		}
		if (kind === "in-flight publish" && waited(learner, "s0")) {
			note("a learner's check waited on an in-flight publish")
		}
		if (
			Arr.some(
				e.run.moves,
				(m) =>
					m.session === "s0" &&
					locks.has(m.label) &&
					m.observed._tag === "Waited" &&
					m.observed.on.includes(learner)
			)
		) {
			note("a fenced write's lock waited on a learner's check")
		}
		if (e.run.deadlocks.length > 0) {
			note("a deadlock a fenced removal met")
		}
	}

/**
 * The installations of B-03c's probe shapes and NEGATION's arbitrated read, each at generate's levels and with the roles
 * the certifier is to admit, or must refuse, forced READ COMMITTED.
 */
type ProbeInstall =
	| "probe"
	| "probe, starter and saver forced READ COMMITTED"
	| "skew"
	| "skew, skewer and starterB forced READ COMMITTED"
	| "claim gated"
	| "claim gated, claimer forced READ COMMITTED"
	| "claim twin"
	| "claim twin, claimer forced READ COMMITTED"

/** A pinned race over one of the probe installations: serial in every run, or caught. */
interface ProbeRace {
	readonly label: string
	readonly install: ProbeInstall
	readonly expect: "serial" | "caught"
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
	readonly schedule: CounterSchedule
}

/** A probe race's values: the sitting and step a save meets, two save ids, and a selection's two words. */
export interface ProbeValues {
	readonly sitting: number
	readonly save: number
	readonly words: readonly [string, string]
}

export const probeValues: Gen<ProbeValues> = (source) => ({
	sitting: source.draw(int(1, 3)),
	save: source.draw(int(100, 102)),
	words: source.draw(
		element([
			["a", "b"],
			["b", "c"],
			["c", "a"]
		] as const)
	)
})

/**
 * The races of B-03c's probe shapes (shapes.ts probeShape, skewShape) and of NEGATION's arbitrated read (claimShape),
 * each at generate's levels and at the forced ones. The saver's races are serial at either, the positive B-03c is to
 * certify; the skew and the gated claim are serial at generate's SERIALIZABLE and caught forced READ COMMITTED, the
 * boundary it must keep; the twin is serial at either, the positive B-03d is to certify.
 */
const probeRaces = ({
	sitting,
	save,
	words: [w0, w1]
}: ProbeValues): Arr.NonEmptyReadonlyArray<ProbeRace> => {
	const start = call("starter", "start", { sitting, step: 0, item: 7 })
	const saveOf = (
		id: number,
		selection: ReadonlyArray<{
			readonly response: string
			readonly at: number
			readonly value: string
		}>
	) => call("saver", "save", { sitting, step: 0, item: 7, save: id, selection })
	const one = [{ response: "r", at: 0, value: w0 }]
	const duplicate = [
		{ response: "r", at: 0, value: w0 },
		{ response: "r", at: 0, value: w1 }
	]
	const saverRaces = (install: ProbeInstall): ReadonlyArray<ProbeRace> => [
		{
			label: `1. a save that misses the Served row (${install})`,
			install,
			expect: "serial",
			initial: {},
			calls: [start, saveOf(save, one)],
			schedule: pausedFirst([])
		},
		{
			label: `1. a save beside a start, every order (${install})`,
			install,
			expect: "serial",
			initial: {},
			calls: [start, saveOf(save, one)],
			schedule: everyOrder
		},
		{
			label: `2. duplicates beside a start in flight (${install})`,
			install,
			expect: "serial",
			initial: {},
			calls: [start, saveOf(save, duplicate)],
			schedule: pausedFirst([])
		},
		{
			label: `2. duplicates against a stored Served row (${install})`,
			install,
			expect: "serial",
			initial: { Served: [{ sitting, step: 0, item: 7 }] },
			calls: [saveOf(save, duplicate), saveOf(save + 10, one)],
			schedule: everyOrder
		},
		{
			label: `3. a clash with a stored Save, its Served row in flight (${install})`,
			install,
			expect: "serial",
			initial: {
				Served: [{ sitting: sitting + 10, step: 0, item: 7 }],
				Save: [{ id: save, sitting: sitting + 10, step: 0, item: 7 }]
			},
			calls: [start, saveOf(save, one)],
			schedule: everyOrder
		},
		{
			label: `4. two savers and a starter (${install})`,
			install,
			expect: "serial",
			initial: {},
			calls: [start, saveOf(save, one), saveOf(save + 10, [{ response: "r", at: 0, value: w1 }])],
			schedule: pausedFirst([])
		}
	]
	const skew = (install: ProbeInstall, expect: "serial" | "caught"): ProbeRace => ({
		label: `5. the skewer and starterB (${install})`,
		install,
		expect,
		initial: {},
		calls: [
			call("skewer", "mark", { v: 1, sitting, step: 0 }),
			call("starterB", "startIfFree", { sitting, step: 0, item: 7, v: 1 })
		],
		schedule: everyOrder
	})
	const claim = (install: ProbeInstall, expect: "serial" | "caught"): ProbeRace => ({
		label: `6. a claim of another call's Sitting (${install})`,
		install,
		expect,
		initial: {},
		calls: [
			call("claimer", "claimStart", { child: sitting, test: 1, attempt: 0, by: 1 }),
			call("publisher", "publish", { test: 1 }),
			call("claimer", "claimStart", { child: sitting, test: 1, attempt: 0, by: 2 })
		],
		schedule: { kind: "paused", session: "s0", before: "lastStatement", trailing: [] }
	})
	const twin = (install: ProbeInstall): ProbeRace => ({
		label: `7. the twin's two starts of one Sitting (${install})`,
		install,
		expect: "serial",
		initial: {},
		calls: [
			call("claimer", "claimStart", { child: sitting, test: 1, attempt: 0, by: 1 }),
			call("claimer", "claimStart", { child: sitting, test: 1, attempt: 0, by: 2 })
		],
		schedule: everyOrder
	})
	const [first, ...rest] = [
		...saverRaces("probe"),
		...saverRaces("probe, starter and saver forced READ COMMITTED"),
		skew("skew", "serial"),
		skew("skew, skewer and starterB forced READ COMMITTED", "caught"),
		claim("claim gated", "serial"),
		claim("claim gated, claimer forced READ COMMITTED", "caught"),
		twin("claim twin"),
		twin("claim twin, claimer forced READ COMMITTED")
	]
	return [defined(first, "a probe race"), ...rest]
}

export type ProbeFeature = "every probe race serial" | "the skew and the gated claim caught"

/** The lease installations (support/lease.ts): each shape at generate's levels, and each search for work forced. */
type LeaseInstall =
	| "lease"
	| "take"
	| "take, claimer forced READ COMMITTED"
	| "count"
	| "count, claimer forced READ COMMITTED"
	| "unmatched"
	| "unmatched, claimer forced READ COMMITTED"

/** A pinned race over one of the lease installations: serial in every run, or caught. */
interface LeaseRace {
	readonly label: string
	readonly install: LeaseInstall
	readonly expect: "serial" | "caught"
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
	readonly schedule: CounterSchedule
}

/** A lease race's values: three holders, apart, and a claim's ttl. */
export interface LeaseValues {
	readonly holders: readonly [number, number, number]
	readonly ttl: bigint
}

export const leaseValues: Gen<LeaseValues> = (source) => {
	const first = source.draw(int(1, 3))
	return { holders: [first, first + 3, first + 6], ttl: source.draw(element([2n, 3n])) }
}

/**
 * den's lease races (support/lease.ts). At generate's levels, where every role of the lease runs READ COMMITTED, every
 * run is serial: claimers of one key, a claim sent again with a later stamp, the winner's Log beside a rival's,
 * reclaims of an expired claim beside a late claim, reclaims of a live one, a stale commit beside a new one, and a
 * commit beside its claim in flight. Each search for work is serial at generate's levels, which keep it SERIALIZABLE,
 * and caught forced READ COMMITTED: a take that misses an earlier Due a spawn commits while an auditor sees it, a count
 * of claims two claimers of two steps both pass, and a winner's Log read at another step after the claim.
 */
const leaseRaces = ({
	holders: [h1, h2, h3],
	ttl
}: LeaseValues): Arr.NonEmptyReadonlyArray<LeaseRace> => {
	const s1 = uuidOf(1)
	const s2 = uuidOf(2)
	const s3 = uuidOf(3)
	const claim = (step: string, attempt: bigint, holder: number, at: bigint) =>
		call("claimer", "claim", { step, attempt, holder, at, ttl })
	const claimFenced = (holder: number) =>
		call("claimer", "claimFenced", { step: s1, attempt: 0n, holder, at: 1n, ttl })
	const reclaim = (holder: number, now: bigint) =>
		call("claimer", "reclaim", { step: s1, prev: 0n, attempt: 1n, holder, now, ttl })
	const commit = (attempt: bigint, holder: number) =>
		call("committer", "commit", { step: s1, attempt, holder })
	const stepped: FactSet = { Step: [{ id: s1 }, { id: s2 }] }
	const claimedAt = (at: bigint): FactSet => ({
		...stepped,
		Claim: [{ step: s1, attempt: 0n, holder: h3, at, ttl }]
	})
	const lease = (
		label: string,
		initial: FactSet,
		calls: Arr.NonEmptyReadonlyArray<CallSketch>
	): LeaseRace => ({
		label,
		install: "lease",
		expect: "serial",
		initial,
		calls,
		schedule: everyOrder
	})
	const searches = (forced: boolean): ReadonlyArray<LeaseRace> => [
		{
			label: `a take beside an earlier Due's spawn and an auditor${forced ? ", forced" : ""}`,
			install: forced ? "take, claimer forced READ COMMITTED" : "take",
			expect: forced ? "caught" : "serial",
			initial: { Step: [{ id: s2 }], Due: [{ step: s2, at: 5n }] },
			calls: [
				call("claimer", "take", { now: 9n, holder: h1, ttl }),
				call("spawner", "spawn", { step: s3, at: 1n }),
				call("auditor", "audit", {})
			],
			schedule: pausedFirst([])
		},
		{
			label: `two claims each alone by a count${forced ? ", forced" : ""}`,
			install: forced ? "count, claimer forced READ COMMITTED" : "count",
			expect: forced ? "caught" : "serial",
			initial: stepped,
			calls: [
				call("claimer", "claimAlone", { step: s1, attempt: 0n, holder: h1, at: 1n, ttl }),
				call("claimer", "claimAlone", { step: s2, attempt: 0n, holder: h2, at: 1n, ttl })
			],
			schedule: pausedFirst([])
		},
		{
			label: `a Log at another step than the claim's, an auditor beside it${forced ? ", forced" : ""}`,
			install: forced ? "unmatched, claimer forced READ COMMITTED" : "unmatched",
			expect: forced ? "caught" : "serial",
			initial: stepped,
			calls: [
				call("claimer", "claimOther", {
					step: s1,
					other: s2,
					attempt: 0n,
					holder: h1,
					at: 1n,
					ttl
				}),
				claim(s2, 0n, h2, 1n),
				call("auditor", "audit", { step: s1, other: s2, attempt: 0n })
			],
			schedule: pausedFirst([])
		}
	]
	const [first, ...rest] = [
		lease("two claimers of one key", { Step: [{ id: s1 }] }, [
			claim(s1, 0n, h1, 1n),
			claim(s1, 0n, h2, 1n)
		]),
		lease("a claim sent again with a later stamp", { Step: [{ id: s1 }] }, [
			claim(s1, 0n, h1, 1n),
			claim(s1, 0n, h1, 2n)
		]),
		lease("the winner's Log beside a rival's", { Step: [{ id: s1 }] }, [
			claimFenced(h1),
			claimFenced(h2)
		]),
		lease("two reclaims of an expired claim beside a late claim", claimedAt(0n), [
			reclaim(h1, 9n),
			reclaim(h2, 9n),
			claim(s1, 1n, h3, 9n)
		]),
		lease("two reclaims of a live claim", claimedAt(8n), [reclaim(h1, 9n), reclaim(h2, 9n)]),
		lease(
			"a stale commit beside a new one",
			{
				...stepped,
				Claim: [
					{ step: s1, attempt: 0n, holder: h1, at: 0n, ttl },
					{ step: s1, attempt: 1n, holder: h2, at: 5n, ttl }
				]
			},
			[commit(0n, h1), commit(1n, h2)]
		),
		lease("a commit beside its claim in flight", { Step: [{ id: s1 }] }, [
			claim(s1, 0n, h1, 1n),
			commit(0n, h1)
		]),
		...searches(false),
		...searches(true)
	]
	return [defined(first, "a lease race"), ...rest]
}

export type LeaseFeature =
	| "every lease race serial"
	| "each search for work caught forced"
	| "the lease's claimer certified READ COMMITTED"

/** A certifier of a shape's template: any but generate, whose template is a generated one (generatedShapeTemplate). */
type StatedCertifier = Exclude<Certifier, { readonly kind: "generate" }>

/** Each positive shape's build, every one installed at generate's levels. */
const positiveBuilds: Readonly<Record<PositiveRace["shape"], (name: string) => Shape>> = {
	point: pointShape,
	fold: foldShape,
	sitting: (name) => sittingShape(name, "start", false),
	named: (name) => sittingShape(name, "named", false)
}

/**
 * The positive races' seats: each shape installed once per member as generate certifies it (race.ts
 * generatedShapeTemplate), where the search installed the four before its cases.
 */
export const positiveNeeds = Rec.map(positiveBuilds, (build, shape) =>
	Substrate.seat(generatedShapeTemplate(import.meta, `isolation positive ${shape}`, build))
)

/** One race of each positive shape on its seat, serial at generate's levels in every run the strategy reaches. */
export const positiveCase = (
	needs: Resources<typeof positiveNeeds>,
	races: PositiveRaces,
	c: Case<PositiveFeature>
) =>
	Effect.forEach(
		positiveShapes,
		(shape) =>
			Effect.gen(function* () {
				const seated = yield* Effect.flatMap(needs[shape], seatedGenerated(positiveBuilds[shape]))
				const race = races[shape]
				c.note(shape)
				if (
					Arr.some(race.calls, (call) => seated.shape.levels.get(call.role) === "readCommitted")
				) {
					c.note("a READ COMMITTED role called")
				}
				yield* raceOn(
					seated,
					raceOf(race),
					strategyOf(c),
					noteRunOf((feature) => c.note(feature))
				)
			}),
		{ discard: true }
	)

/** Each counterexample's build, every one installed holding its flawed certifier's certificates. */
const counterBuilds: Readonly<Record<CounterShape, (name: string) => Shape>> = {
	partial: partialShape,
	copies: copiesShape,
	pointCopies: pointCopiesShape,
	spanning: readersShape,
	extended: (name) => sittingShape(name, "start", true),
	single: readersShape,
	listed: listedShape,
	fk: fkShape,
	deferred: deferredShape,
	carrier: carrierShape,
	fallback: (name) => fallbackShape(name, "rules"),
	boundFallback: (name) => fallbackShape(name, "bound"),
	recursiveFallback: (name) => fallbackShape(name, "recursive")
}

/**
 * The counterexamples' seats: each shape installed once per member holding its flawed certifier's certificates (race.ts
 * certifiedShapeTemplate), where the search installed the thirteen before its cases.
 */
export const counterNeeds = Rec.map(counterBuilds, (build, shape) => {
	const { flaw, roles } = flawedCertificates(shape)
	return Substrate.seat(
		certifiedShapeTemplate(import.meta, `isolation counter ${shape}`, build, {
			kind: "flawed",
			flaw,
			roles
		})
	)
})

/**
 * A race that must be caught by a run no serial order explains: any other failure is the case's, and a race every run of
 * which is serial a defect, `serial` saying what the oracle then cannot catch.
 */
const caughtOn = (
	seated: SeatedShape,
	race: IsolationRace,
	strategy: (txns: ReadonlyArray<RaceTxn<never>>) => Strategy,
	serial: string
) =>
	Effect.flatMap(Effect.result(raceOn(seated, race, strategy, () => undefined)), (result) =>
		result._tag === "Failure" && result.failure._tag === "NoSerialOrder"
			? Effect.void
			: result._tag === "Failure"
				? Effect.fail(result.failure)
				: Effect.die(new Error(serial))
	)

/**
 * One race of each counterexample on its seat, caught by a run no serial order explains, its installation's generate
 * levels keeping every role the flaw passes SERIALIZABLE.
 */
export const counterCase = (
	needs: Resources<typeof counterNeeds>,
	races: CounterRaces,
	c: Case<`${CounterShape} caught`>
) =>
	Effect.forEach(
		counterShapes,
		(shape) =>
			Effect.gen(function* () {
				const seated = yield* Effect.map(needs[shape], seatedCertified)
				const { flaw, passes } = flawedCertificates(shape)
				for (const passed of passes) {
					const own = seated.shape.generated.get(passed)
					if (own !== "serializable") {
						return yield* Effect.die(
							new Error(
								`${shape}: generate certifies role ${passed} ${String(own)}, which ${flaw} passes`
							)
						)
					}
				}
				const race = races[shape]
				yield* caughtOn(
					seated,
					raceOf(race),
					counterStrategy(race.schedule, c),
					`${flaw}: every run of ${Formatter.format(race)} is serial, so the oracle cannot catch the flaw`
				)
				c.note(`${shape} caught`)
			}),
		{ discard: true }
	)

/** A pinned race over one of a search's installations, run as it expects: serial in every run, or caught. */
const expectedOn = <F extends string>(
	seated: SeatedShape,
	race: {
		readonly label: string
		readonly expect: "serial" | "caught"
		readonly initial: FactSet
		readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
		readonly schedule: CounterSchedule
	},
	c: Case<F>
) =>
	race.expect === "caught"
		? caughtOn(
				seated,
				raceOf(race),
				counterStrategy(race.schedule, c),
				`${race.label}: every run is serial, so the forced level cannot be caught`
			)
		: raceOn(seated, raceOf(race), counterStrategy(race.schedule, c), () => undefined)

/** The publication layer's installations past generate's: NEGATION's expected levels, and two roles forced too. */
const publishedForced: Readonly<Record<Exclude<PublishedCertifier, "generate">, StatedCertifier>> =
	{
		"B-02e's levels": {
			kind: "forced",
			flaw: "none: NEGATION's expected levels, the learner READ COMMITTED",
			roles: ["learner"]
		},
		"listed forced READ COMMITTED": {
			kind: "forced",
			flaw: "the listed role's keys-bound reads taken as sealed",
			roles: ["learner", "listed"]
		},
		"publisher forced READ COMMITTED": {
			kind: "forced",
			flaw: "the publisher's foreign key checks of a pivot writer's rows taken as no read",
			roles: ["learner", "publisher"]
		}
	}

/**
 * The publication races' seats: the published shape installed once per member at generate's levels and at each of
 * publishedForced's (race.ts generatedShapeTemplate, certifiedShapeTemplate), where the search installed the four
 * before its cases.
 */
export const publishedNeeds = {
	generate: Substrate.seat(
		generatedShapeTemplate(import.meta, "isolation published", publishedShape)
	),
	...Rec.map(publishedForced, (certifier, label) =>
		Substrate.seat(
			certifiedShapeTemplate(
				import.meta,
				`isolation published, ${label}`,
				publishedShape,
				certifier
			)
		)
	)
} as const

/** NEGATION's publication races at the case's values, each on its certifier's seat, serial or caught as it expects. */
export const publishedCase = (
	needs: Resources<typeof publishedNeeds>,
	values: PublishedValues,
	c: Case<PublishedFeature>
) =>
	Effect.gen(function* () {
		const certified: Readonly<Record<PublishedCertifier, SeatedShape>> = {
			generate: yield* Effect.flatMap(needs.generate, seatedGenerated(publishedShape)),
			...(yield* Effect.all(
				Rec.map(publishedForced, (_, label) => Effect.map(needs[label], seatedCertified))
			))
		}
		if (certified.generate.shape.levels.get("learner") === "readCommitted") {
			c.note("generate certifies the learner READ COMMITTED")
		}
		yield* Effect.forEach(
			publishedRaces(values),
			(race) => expectedOn(certified[race.certifier], race, c),
			{ discard: true }
		)
		c.note("every publication race serial")
		c.note("races 7 and 8 caught")
	})

/** The fenced race's seat: G3's fenced shape installed once per member at generate's levels. */
export const fencedNeeds = {
	fenced: Substrate.seat(generatedShapeTemplate(import.meta, "isolation fenced", fencedShape))
} as const

/**
 * The fenced shape's races at the case's values on its seat, every one serial, noting what each run of them reached
 * and whether generate fences every publisher write of Pub.
 */
export const fencedCase = (
	needs: Resources<typeof fencedNeeds>,
	values: FencedValues,
	c: Case<FencedFeature>
) =>
	Effect.gen(function* () {
		const seated = yield* Effect.flatMap(needs.fenced, seatedGenerated(fencedShape))
		const exclusionOf = (member: string) =>
			seated.shape.changes.get("publisher")?.get(member)?.entry.program.exclusion
		const locks = new Set(
			Arr.flatMap(["replace", "remove", "publish", "removeBoth"], (member) => {
				const exclusion = exclusionOf(member)
				return exclusion?.kind === "lock" ? [exclusion.text.sql] : []
			})
		)
		if (seated.shape.levels.get("learner") === "readCommitted") {
			c.note("generate certifies the learner READ COMMITTED")
		}
		if (
			Arr.every(["replace", "remove", "publish"], (member) => exclusionOf(member)?.kind === "lock")
		) {
			c.note("generate fences every publisher write of Pub")
		}
		yield* Effect.forEach(
			fencedRaces(values),
			(race) =>
				raceOn(
					seated,
					raceOf(race),
					counterStrategy(race.schedule, c),
					noteFencedRun(race.kind, locks, (feature) => c.note(feature))
				),
			{ discard: true }
		)
		c.note("every fenced race serial")
	})

/** The probe installations at generate's levels, by install. */
const probeGenerated: Readonly<
	Record<"probe" | "skew" | "claim gated" | "claim twin", (name: string) => Shape>
> = {
	probe: probeShape,
	skew: skewShape,
	"claim gated": (name) => claimShape(name, true),
	"claim twin": (name) => claimShape(name, false)
}

/** The probe installations with roles forced READ COMMITTED, by install: each shape's build and its certifier. */
const probeForced: Readonly<
	Record<
		Exclude<ProbeInstall, keyof typeof probeGenerated>,
		{ readonly build: (name: string) => Shape; readonly certifier: StatedCertifier }
	>
> = {
	"probe, starter and saver forced READ COMMITTED": {
		build: probeShape,
		certifier: {
			kind: "forced",
			flaw: "none: the positive B-03c is to certify",
			roles: ["starter", "saver"]
		}
	},
	"skew, skewer and starterB forced READ COMMITTED": {
		build: skewShape,
		certifier: {
			kind: "forced",
			flaw: "a NOT EXISTS on a sealed point that no positive read gates, taken as neutral",
			roles: ["skewer", "starterB"]
		}
	},
	"claim gated, claimer forced READ COMMITTED": {
		build: (name) => claimShape(name, true),
		certifier: {
			kind: "forced",
			flaw: "an arbitrated read of another call's row taken as the call's own",
			roles: ["claimer"]
		}
	},
	"claim twin, claimer forced READ COMMITTED": {
		build: (name) => claimShape(name, false),
		certifier: {
			kind: "forced",
			flaw: "none: the positive B-03d is to certify",
			roles: ["claimer"]
		}
	}
}

/**
 * The probe races' seats: each probe installation installed once per member at generate's levels or its forced ones
 * (race.ts generatedShapeTemplate, certifiedShapeTemplate), where the search installed the eight before its cases.
 */
export const probeNeeds = {
	...Rec.map(probeGenerated, (build, install) =>
		Substrate.seat(generatedShapeTemplate(import.meta, `isolation ${install}`, build))
	),
	...Rec.map(probeForced, ({ build, certifier }, install) =>
		Substrate.seat(certifiedShapeTemplate(import.meta, `isolation ${install}`, build, certifier))
	)
} as const

/** The probe races at the case's values, each on its installation's seat, serial or caught as it expects. */
export const probeCase = (
	needs: Resources<typeof probeNeeds>,
	values: ProbeValues,
	c: Case<ProbeFeature>
) =>
	Effect.gen(function* () {
		const installs: Readonly<Record<ProbeInstall, SeatedShape>> = {
			...(yield* Effect.all(
				Rec.map(probeGenerated, (build, install) =>
					Effect.flatMap(needs[install], seatedGenerated(build))
				)
			)),
			...(yield* Effect.all(
				Rec.map(probeForced, (_, install) => Effect.map(needs[install], seatedCertified))
			))
		}
		yield* Effect.forEach(
			probeRaces(values),
			(race) => expectedOn(installs[race.install], race, c),
			{ discard: true }
		)
		c.note("every probe race serial")
		c.note("the skew and the gated claim caught")
	})

/** The lease installations at generate's levels, by install. */
const leaseGenerated: Readonly<
	Record<"lease" | "take" | "count" | "unmatched", (name: string) => Shape>
> = {
	lease: leaseShape,
	take: takeShape,
	count: countShape,
	unmatched: unmatchedShape
}

/** A search for work's claimer forced READ COMMITTED, with the flaw it stands for. */
const claimerForced = (flaw: string): StatedCertifier => ({
	kind: "forced",
	flaw,
	roles: ["claimer"]
})

/** The lease installations with the claimer forced READ COMMITTED, by install: each shape's build and its certifier. */
const leaseForced: Readonly<
	Record<
		Exclude<LeaseInstall, keyof typeof leaseGenerated>,
		{ readonly build: (name: string) => Shape; readonly certifier: StatedCertifier }
	>
> = {
	"take, claimer forced READ COMMITTED": {
		build: takeShape,
		certifier: claimerForced("a take of the next due item, rows of no one group, taken as sealed")
	},
	"count, claimer forced READ COMMITTED": {
		build: countShape,
		certifier: claimerForced("a count of what the claimer writes taken as no absence")
	},
	"unmatched, claimer forced READ COMMITTED": {
		build: unmatchedShape,
		certifier: claimerForced(
			"a read at another key than the claim raced taken as the row the race fixed"
		)
	}
}

/**
 * The lease races' seats: each lease installation installed once per member at generate's levels or with its claimer
 * forced (race.ts generatedShapeTemplate, certifiedShapeTemplate), where the search installed the seven before its
 * cases.
 */
export const leaseNeeds = {
	...Rec.map(leaseGenerated, (build, install) =>
		Substrate.seat(generatedShapeTemplate(import.meta, `isolation ${install}`, build))
	),
	...Rec.map(leaseForced, ({ build, certifier }, install) =>
		Substrate.seat(certifiedShapeTemplate(import.meta, `isolation ${install}`, build, certifier))
	)
} as const

/**
 * den's lease races at the case's values, each on its installation's seat, serial or caught as it expects, generate
 * running every role of the lease READ COMMITTED.
 */
export const leaseCase = (
	needs: Resources<typeof leaseNeeds>,
	values: LeaseValues,
	c: Case<LeaseFeature>
) =>
	Effect.gen(function* () {
		const installs: Readonly<Record<LeaseInstall, SeatedShape>> = {
			...(yield* Effect.all(
				Rec.map(leaseGenerated, (build, install) =>
					Effect.flatMap(needs[install], seatedGenerated(build))
				)
			)),
			...(yield* Effect.all(
				Rec.map(leaseForced, (_, install) => Effect.map(needs[install], seatedCertified))
			))
		}
		for (const [r, level] of installs.lease.shape.generated) {
			if (level !== "readCommitted") {
				return yield* Effect.die(new Error(`generate certifies the lease's ${r} ${level}`))
			}
		}
		c.note("the lease's claimer certified READ COMMITTED")
		yield* Effect.forEach(
			leaseRaces(values),
			(race) => expectedOn(installs[race.install], race, c),
			{ discard: true }
		)
		c.note("every lease race serial")
		c.note("each search for work caught forced")
	})

/**
 * A drawn installation's race on the case's own substrate (Substrate.installing), the installation drawn with it:
 * serial at generate's levels, and at each other certifier's levels where they differ from generate's, each installed
 * for the case.
 */
export const drawnCase = (race: DrawnRace, c: Case<DrawnFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const s = yield* installShape(drawnShape(race.installation), generate)
			const levels = (byRole: ReadonlyMap<string, Isolation>) =>
				Arr.join(
					Arr.map([...byRole], ([role, level]) => `${role}:${level}`),
					" "
				)
			const candidates: ReadonlyArray<Candidate> = [
				{ label: "certify over 1:1 facts", roles: factCertificates(race.installation) },
				{ label: "the restated conditions", roles: drawnCertificates(race.installation) }
			]
			const others = Arr.dedupeWith(
				Arr.filter(candidates, (o) => levels(levelsOf(o.roles)) !== levels(s.generated)),
				(x: Candidate, y: Candidate) => levels(levelsOf(x.roles)) === levels(levelsOf(y.roles))
			)
			for (const byRole of [s.generated, ...Arr.map(others, (o) => levelsOf(o.roles))]) {
				c.noteAll(drawnFeatures(race, byRole))
			}
			if (others.length > 0) {
				c.note("another certifier differs from generate")
			}
			yield* Effect.scoped(
				runIsolationRace(
					s,
					drawnRaceOf(race),
					strategyOf(c),
					noteRunOf((feature) => c.note(feature))
				)
			)
			yield* Effect.forEach(
				others,
				(other) =>
					Effect.scoped(
						Effect.flatMap(
							installShape(drawnShape(race.installation), {
								kind: "flawed",
								flaw: other.label,
								roles: other.roles
							}),
							(t) =>
								runIsolationRace(
									t,
									drawnRaceOf(race),
									strategyOf(c),
									noteRunOf((feature) => c.note(feature))
								)
						)
					),
				{ discard: true }
			)
		})
	)
