/**
 * The isolation certifier's soundness, against PostgreSQL 19: a role it certifies READ COMMITTED runs its change members
 * at READ COMMITTED, and every run of concurrent calls must still be one some serial order of the same calls explains.
 *
 * The oracle is the serial reference (test/support/schedules/serial.ts runSerialRace): each call is a direct
 * transaction of its served write's statements as the application sends them (race.ts callStatements), at its role's
 * certified level, interleaved at statement boundaries by the one concurrency driver; a run passes when some order of
 * the calls that respects real time, each run alone from the race's initial state, shows every statement's rows or
 * SQLSTATE the run showed and leaves its state.
 *
 * Every installation is drafted as `grizzle generate` drafts it (support/race.ts installShape): generate's draft
 * certifies each role over the statements its served writes send (cli/generate.ts draftSchema), the installation holds
 * the certificates, each table keeping its guard unless every role that writes it is READ COMMITTED, and each role's
 * served file records its level, at which its calls begin.
 *
 * - Positives (support/shapes.ts): every race over the shapes is serial at generate's levels in every run the strategy
 *   reaches: every order where a race makes few moves, PCT beyond.
 * - Counterexamples: each shape a flawed certifier passes (support/certify.ts), installed holding that certifier's
 *   certificates, must give a run no serial order explains, and generate must keep every role the flaw passes
 *   SERIALIZABLE; one the oracle does not catch, or one generate passes, is a failure.
 * - Drawn installations (support/drawn.ts): pivots and members of two statements over four relations are serial at
 *   generate's levels, and at the levels `certify` gives facts stated one to one with the drawing and the conditions
 *   restated over it give, wherever those differ from generate's.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { pctSchedule } from "@grizzle/testing/interleave"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { certify, type RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { type CounterShape, flawedCertificates } from "#test/pg/isolation/support/certify.ts"
import {
	callParams,
	type DrawnRace,
	drawnCertificates,
	drawnFacts,
	drawnRaceGen,
	drawnShape
} from "#test/pg/isolation/support/drawn.ts"
import {
	type CallInput,
	type Certifier,
	type InstalledShape,
	type IsolationRace,
	installShape,
	raceMoves,
	type RaceCall,
	runIsolationRace,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import {
	carrierShape,
	claimShape,
	fallbackShape,
	probeShape,
	publishedShape,
	skewShape,
	copiesShape,
	deferredShape,
	fkShape,
	foldShape,
	listedShape,
	partialShape,
	pointCopiesShape,
	pointShape,
	readersShape,
	sittingShape
} from "#test/pg/isolation/support/shapes.ts"
import { defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
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
type PositiveRaces = Readonly<Record<PositiveRace["shape"], PositiveRace>>

const positiveRaces: Gen<PositiveRaces> = (source) => ({
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
type CounterRaces = Readonly<Record<CounterShape, CounterRace>>

const counterRaces: Gen<CounterRaces> = (source) => ({
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
	const [first, ...rest] = Arr.map(sketch.calls, (c, i): RaceCall => ({ session: `s${i}`, ...c }))
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

type PositiveFeature = PositiveRace["shape"] | RunFeature | "a READ COMMITTED role called"

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
		session: `s${i}`,
		role: `r${c.role}`,
		member: `m${c.role}`,
		input: { kind: "params", params: callParams(race.installation, c.role, c.k, c.v) }
	}))
	return { initial, calls: [defined(first, "a call"), ...rest] }
}

type DrawnFeature =
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

/** `shape` installed holding the flawed certifier's certificates, and generate's own refusing every role it wrongly passes. */
const installedFlawed = (build: (name: string) => Shape, shape: CounterShape) =>
	Effect.gen(function* () {
		const { flaw, roles, passes } = flawedCertificates(shape)
		const s = yield* installShape(build, { kind: "flawed", flaw, roles })
		for (const passed of passes) {
			const own = s.generated.get(passed)
			if (own !== "serializable") {
				return yield* Effect.die(
					new Error(
						`${shape}: generate certifies role ${passed} ${String(own)}, which ${flaw} passes`
					)
				)
			}
		}
		return s
	})

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
interface PublishedValues {
	readonly a: number
	readonly b: number
}

const publishedValues: Gen<PublishedValues> = (source) => {
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

type PublishedFeature =
	| "every publication race serial"
	| "races 7 and 8 caught"
	| "generate certifies the learner READ COMMITTED"

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
interface ProbeValues {
	readonly sitting: number
	readonly save: number
	readonly words: readonly [string, string]
}

const probeValues: Gen<ProbeValues> = (source) => ({
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

type ProbeFeature = "every probe race serial" | "the skew and the gated claim caught"

/** How many cases the rotating stream runs; its floor runs a quarter of them. */
const runs = 8

layer(Substrate.layer, { excludeTestServices: true })(
	"the isolation certifier's soundness",
	(it) => {
		it.effect("every race over a shape is serial at the levels generate certifies", (ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const shapes: Readonly<Record<PositiveRace["shape"], InstalledShape>> = {
							point: yield* installShape(pointShape, generate),
							fold: yield* installShape(foldShape, generate),
							sitting: yield* installShape((name) => sittingShape(name, "start", false), generate),
							named: yield* installShape((name) => sittingShape(name, "named", false), generate)
						}
						return yield* explore(
							{
								oracle: { kind: "specification", name: "a serial order of the same calls" },
								suite: "pg/isolation/positive",
								draw: drawn(positiveRaces),
								literal: Formatter.format,
								coverage: required<PositiveFeature>(
									[
										"point",
										"fold",
										"sitting",
										"two calls overlapped",
										"a READ COMMITTED role called"
									],
									{ cases: runs, sense: notesOnly }
								),
								kept: [],
								runs,
								shrink: { kind: "bounded", candidates: 40 },
								concurrency: 1,
								steerEvery: runs,
								caseHang
							},
							(races, c) =>
								Effect.forEach(
									positiveShapes,
									(shape) => {
										const race = races[shape]
										c.note(shape)
										if (
											Arr.some(
												race.calls,
												(call) => shapes[shape].levels.get(call.role) === "readCommitted"
											)
										) {
											c.note("a READ COMMITTED role called")
										}
										return Effect.scoped(
											runIsolationRace(
												shapes[shape],
												raceOf(race),
												strategyOf(c),
												noteRunOf((feature) => c.note(feature))
											)
										)
									},
									{ discard: true }
								)
						)
					})
				)
			)
		)

		it.effect(
			"a flawed certifier's READ COMMITTED is caught by a run no serial order explains",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const shapes: Readonly<Record<CounterShape, InstalledShape>> = {
								partial: yield* installedFlawed(partialShape, "partial"),
								copies: yield* installedFlawed(copiesShape, "copies"),
								pointCopies: yield* installedFlawed(pointCopiesShape, "pointCopies"),
								spanning: yield* installedFlawed(readersShape, "spanning"),
								extended: yield* installedFlawed(
									(name) => sittingShape(name, "start", true),
									"extended"
								),
								single: yield* installedFlawed(readersShape, "single"),
								listed: yield* installedFlawed(listedShape, "listed"),
								fk: yield* installedFlawed(fkShape, "fk"),
								deferred: yield* installedFlawed(deferredShape, "deferred"),
								carrier: yield* installedFlawed(carrierShape, "carrier"),
								fallback: yield* installedFlawed(
									(name) => fallbackShape(name, "rules"),
									"fallback"
								),
								boundFallback: yield* installedFlawed(
									(name) => fallbackShape(name, "bound"),
									"boundFallback"
								),
								recursiveFallback: yield* installedFlawed(
									(name) => fallbackShape(name, "recursive"),
									"recursiveFallback"
								)
							}
							return yield* explore(
								{
									oracle: { kind: "specification", name: "a serial order of the same calls" },
									suite: "pg/isolation/counterexamples",
									draw: drawn(counterRaces),
									literal: Formatter.format,
									coverage: required<`${CounterShape} caught`>(
										[
											"partial caught",
											"copies caught",
											"pointCopies caught",
											"spanning caught",
											"extended caught",
											"single caught",
											"listed caught",
											"fk caught",
											"deferred caught",
											"carrier caught",
											"fallback caught",
											"boundFallback caught",
											"recursiveFallback caught"
										],
										{ cases: runs, sense: notesOnly }
									),
									kept: [
										{
											note: "the owner's two counterexamples among the thirteen, and NEGATION's four histories and three B-03c negatives pinned. (a): m1 inserts A(1) and copies every B into P, m2 inserts B(2) and copies every A into Q; at READ COMMITTED both copies miss the other's insert and P and Q stay empty. (b), the read-only anomaly: m1 reads B(1) absent and inserts A(1), m3 inserts B(1) and commits first, and the READ COMMITTED reader between the commits sees B(1) without A(1)",
											sketch: {
												partial: {
													shape: "partial",
													schedule: everyOrder,
													initial: { Parent: [{ id: uuidOf(1), g: 0 }] },
													calls: [
														call("joiner", "join", { id: uuidOf(1), k: 0 }),
														call("joiner", "join", { id: uuidOf(1), k: 1 })
													]
												},
												copies: {
													shape: "copies",
													schedule: everyOrder,
													initial: {},
													calls: [call("copier", "m1", { v: 1 }), call("copier", "m2", { v: 2 })]
												},
												pointCopies: {
													shape: "pointCopies",
													schedule: everyOrder,
													initial: {},
													calls: [
														call("copier", "m1", { x: 1, y: 2 }),
														call("copier", "m2", { x: 1, y: 2 })
													]
												},
												spanning: {
													shape: "spanning",
													schedule: everyOrder,
													initial: {},
													calls: [
														call("writer", "m1", { v: 1 }),
														call("writer", "m3", { v: 1 }),
														call("spanning", "both", { v: 1 })
													]
												},
												extended: {
													shape: "extended",
													schedule: everyOrder,
													initial: {
														Doc: [{ node: uuidOf(1), n: 1 }],
														Pool: [{ doc: uuidOf(1), pool: 0, size: 1 }]
													},
													calls: [
														call("learner", "start", { id: uuidOf(11), doc: uuidOf(1), child: 0 }),
														call("importer", "extend", { node: uuidOf(1), pool: 1, a: 2 })
													]
												},
												single: singleRace,
												listed: listedRace,
												fk: fkRace,
												deferred: deferredRace,
												carrier: carrierRace,
												fallback: fallbackRace,
												boundFallback: boundFallbackRace,
												recursiveFallback: recursiveFallbackRace
											},
											draws: "",
											reaches: [
												"partial caught",
												"copies caught",
												"pointCopies caught",
												"spanning caught",
												"extended caught",
												"single caught",
												"listed caught",
												"fk caught",
												"deferred caught",
												"carrier caught",
												"fallback caught",
												"boundFallback caught",
												"recursiveFallback caught"
											]
										}
									],
									runs,
									shrink: { kind: "bounded", candidates: 40 },
									concurrency: 1,
									steerEvery: runs,
									caseHang
								},
								(races, c) =>
									Effect.forEach(
										counterShapes,
										(shape) => {
											const race = races[shape]
											const { flaw } = flawedCertificates(shape)
											return Effect.scoped(
												Effect.flatMap(
													Effect.result(
														runIsolationRace(
															shapes[shape],
															raceOf(race),
															counterStrategy(race.schedule, c),
															() => undefined
														)
													),
													(result) => {
														if (
															result._tag === "Failure" &&
															result.failure._tag === "NoSerialOrder"
														) {
															c.note(`${shape} caught`)
															return Effect.void
														}
														return result._tag === "Failure"
															? Effect.fail(result.failure)
															: Effect.die(
																	new Error(
																		`${flaw}: every run of ${Formatter.format(race)} is serial, so the oracle cannot catch the flaw`
																	)
																)
													}
												)
											)
										},
										{ discard: true }
									)
							)
						})
					)
				)
		)

		it.effect(
			"NEGATION's publication layer: every race is serial at generate's levels, and each forced level is caught",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const certified: Readonly<Record<PublishedCertifier, InstalledShape>> = {
								generate: yield* installShape(publishedShape, generate),
								"B-02e's levels": yield* installShape(publishedShape, {
									kind: "forced",
									flaw: "none: NEGATION's expected levels, the learner READ COMMITTED",
									roles: ["learner"]
								}),
								"listed forced READ COMMITTED": yield* installShape(publishedShape, {
									kind: "forced",
									flaw: "the listed role's keys-bound reads taken as sealed",
									roles: ["learner", "listed"]
								}),
								"publisher forced READ COMMITTED": yield* installShape(publishedShape, {
									kind: "forced",
									flaw: "the publisher's foreign key checks of a pivot writer's rows taken as no read",
									roles: ["learner", "publisher"]
								})
							}
							const levels = certified.generate.levels
							return yield* explore(
								{
									oracle: {
										kind: "specification",
										name: "a strict serial order of the same calls"
									},
									suite: "pg/isolation/published",
									draw: drawn(publishedValues),
									literal: Formatter.format,
									coverage: required<PublishedFeature>(
										["every publication race serial", "races 7 and 8 caught"],
										{ cases: runs, sense: notesOnly }
									),
									kept: [
										{
											note: "NEGATION's races at its own values, 1 and 2",
											sketch: { a: 1, b: 2 },
											draws: "",
											reaches: ["every publication race serial", "races 7 and 8 caught"]
										}
									],
									runs,
									shrink: { kind: "bounded", candidates: 40 },
									concurrency: 1,
									steerEvery: runs,
									caseHang
								},
								(values, c) =>
									Effect.gen(function* () {
										if (levels.get("learner") === "readCommitted") {
											c.note("generate certifies the learner READ COMMITTED")
										}
										const races = publishedRaces(values)
										yield* Effect.forEach(
											races,
											(race) =>
												Effect.scoped(
													Effect.flatMap(
														Effect.result(
															runIsolationRace(
																certified[race.certifier],
																raceOf(race),
																counterStrategy(race.schedule, c),
																() => undefined
															)
														),
														(result) => {
															const caught =
																result._tag === "Failure" && result.failure._tag === "NoSerialOrder"
															if (race.expect === "caught") {
																return caught
																	? Effect.void
																	: result._tag === "Failure"
																		? Effect.fail(result.failure)
																		: Effect.die(
																				new Error(
																					`${race.label}: every run is serial, so the forced level cannot be caught`
																				)
																			)
															}
															return result._tag === "Failure"
																? Effect.fail(result.failure)
																: Effect.void
														}
													)
												),
											{ discard: true }
										)
										c.note("every publication race serial")
										c.note("races 7 and 8 caught")
									})
							)
						})
					)
				)
		)

		it.effect(
			"B-03c's probes and the arbitrated read: the savers and the twin serial, the skew and the gated claim caught forced",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const installs: Readonly<Record<ProbeInstall, InstalledShape>> = {
								probe: yield* installShape(probeShape, generate),
								"probe, starter and saver forced READ COMMITTED": yield* installShape(probeShape, {
									kind: "forced",
									flaw: "none: the positive B-03c is to certify",
									roles: ["starter", "saver"]
								}),
								skew: yield* installShape(skewShape, generate),
								"skew, skewer and starterB forced READ COMMITTED": yield* installShape(skewShape, {
									kind: "forced",
									flaw: "a NOT EXISTS on a sealed point that no positive read gates, taken as neutral",
									roles: ["skewer", "starterB"]
								}),
								"claim gated": yield* installShape((name) => claimShape(name, true), generate),
								"claim gated, claimer forced READ COMMITTED": yield* installShape(
									(name) => claimShape(name, true),
									{
										kind: "forced",
										flaw: "an arbitrated read of another call's row taken as the call's own",
										roles: ["claimer"]
									}
								),
								"claim twin": yield* installShape((name) => claimShape(name, false), generate),
								"claim twin, claimer forced READ COMMITTED": yield* installShape(
									(name) => claimShape(name, false),
									{
										kind: "forced",
										flaw: "none: the positive B-03d is to certify",
										roles: ["claimer"]
									}
								)
							}
							return yield* explore(
								{
									oracle: {
										kind: "specification",
										name: "a strict serial order of the same calls"
									},
									suite: "pg/isolation/probes",
									draw: drawn(probeValues),
									literal: Formatter.format,
									coverage: required<ProbeFeature>(
										["every probe race serial", "the skew and the gated claim caught"],
										{ cases: runs, sense: notesOnly }
									),
									kept: [
										{
											note: "NEGATION's races at its own values: sitting 1, save 100, the words a and b",
											sketch: { sitting: 1, save: 100, words: ["a", "b"] },
											draws: "",
											reaches: ["every probe race serial", "the skew and the gated claim caught"]
										}
									],
									runs,
									shrink: { kind: "bounded", candidates: 40 },
									concurrency: 1,
									steerEvery: runs,
									caseHang
								},
								(values, c) =>
									Effect.gen(function* () {
										yield* Effect.forEach(
											probeRaces(values),
											(race) =>
												Effect.scoped(
													Effect.flatMap(
														Effect.result(
															runIsolationRace(
																installs[race.install],
																raceOf(race),
																counterStrategy(race.schedule, c),
																() => undefined
															)
														),
														(result) => {
															const caught =
																result._tag === "Failure" && result.failure._tag === "NoSerialOrder"
															if (race.expect === "caught") {
																return caught
																	? Effect.void
																	: result._tag === "Failure"
																		? Effect.fail(result.failure)
																		: Effect.die(
																				new Error(
																					`${race.label}: every run is serial, so the forced level cannot be caught`
																				)
																			)
															}
															return result._tag === "Failure"
																? Effect.fail(result.failure)
																: Effect.void
														}
													)
												),
											{ discard: true }
										)
										c.note("every probe race serial")
										c.note("the skew and the gated claim caught")
									})
							)
						})
					)
				)
		)

		it.effect(
			"every race over a drawn installation is serial at generate's levels, and at 1:1 facts' and the restated conditions' where they differ",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: { kind: "specification", name: "a serial order of the same calls" },
							suite: "pg/isolation/drawn",
							draw: drawn(drawnRaceGen),
							literal: Formatter.format,
							coverage: required<DrawnFeature>(
								[
									"a READ COMMITTED call",
									"a READ COMMITTED pivot",
									"a READ COMMITTED member of two statements",
									"two calls overlapped"
								],
								{ cases: runs, sense: notesOnly }
							),
							kept: [],
							runs,
							shrink: { kind: "bounded", candidates: 40 },
							concurrency: 1,
							steerEvery: runs,
							caseHang
						},
						(race, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const s = yield* installShape(drawnShape(race.installation), generate)
									const levels = (byRole: ReadonlyMap<string, Isolation>) =>
										Arr.join(
											Arr.map([...byRole], ([role, level]) => `${role}:${level}`),
											" "
										)
									const candidates: ReadonlyArray<Candidate> = [
										{
											label: "certify over 1:1 facts",
											roles: certify(drawnFacts(race.installation))
										},
										{
											label: "the restated conditions",
											roles: drawnCertificates(race.installation)
										}
									]
									const others = Arr.dedupeWith(
										Arr.filter(
											candidates,
											(o) => levels(levelsOf(o.roles)) !== levels(s.generated)
										),
										(x: Candidate, y: Candidate) =>
											levels(levelsOf(x.roles)) === levels(levelsOf(y.roles))
									)
									for (const byRole of [
										s.generated,
										...Arr.map(others, (o) => levelsOf(o.roles))
									]) {
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
					)
				)
		)
	}
)
