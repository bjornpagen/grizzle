import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { array, constant, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { type PctSchedule, pctSchedule } from "@grizzle/testing/interleave"
import { notesOnly } from "@grizzle/testing/sense"
import { type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Layer,
	Option,
	Order,
	pipe,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import { type ApplyOutcome, Db } from "#adapter/public/db.ts"
import {
	type ApplyError,
	type OpenError,
	type ReadError,
	TransientFailure
} from "#adapter/public/errors.ts"
import type { DbOf } from "#adapter/types/db.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { type ReadonlyTupleMap, TupleMap, TupleSet } from "#compiler/core/tuple-map.ts"
import { codecOf, codeOf } from "#compiler/ir/codes.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import {
	sameIdentity,
	type ValueIdentity,
	valueIdentityOrder
} from "#test/support/kernel/identity.ts"
import {
	installationNamesOf,
	installationOf,
	type Names,
	namesOf
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import type { SqlError } from "#test/support/pg.ts"
import { loadOrder, type PlatformFacts } from "#test/support/platform/generate.ts"
import {
	type Decision,
	type DirectStatement,
	decideSet,
	decideStatements,
	type HostLaw,
	type LawFamily,
	lawsById,
	type PlatformOp,
	platformLaws,
	type RelationName,
	type PlatformRow,
	rowsIn,
	type State,
	spanValue,
	stateOf,
	keyAtoms
} from "#test/support/platform/laws.ts"
import type { SpanV } from "#test/support/platform/model.ts"
import {
	type Actors,
	type DirectActor,
	type GrizzleActor,
	grizzleActor,
	openActors
} from "#test/support/schedules/actors.ts"
import {
	allowed,
	every,
	type ExploreEnv,
	exploreInterleavings,
	type Footprint,
	type Interleaving,
	interleaveStep,
	movesOf,
	opStep,
	refusedJudgment,
	relationsFootprint,
	runawayInterleavings,
	type Strategy,
	type Txn,
	type TxnResult
} from "#test/support/schedules/interleave.ts"
import { openRig, type Rig } from "#test/support/schedules/rig.ts"
import { type PsqlProcessError, reportedOwnerOf } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

import { regex } from "arkregex"
/**
 * The platform's concurrency races: the application's writes of the usage-billing platform, raced by grizzle writers
 * and direct psql writers over one installation, every transaction SERIALIZABLE, every run of the one concurrency
 * driver judged by the host billing model (and model.ts) as its oracle.
 *
 * The installation is the platform with two full roles, each writing every stored relation: `app`, which the grizzle
 * writers open through the login `server`, and `direct`, which the psql writers take on through the login `psql`. It
 * installs once per test; each case opens its own writers, closed when it ends: three grizzle writers `g`, `h` and `i`,
 * each a Db of `app` whose one session the driver watches, and three psql writers `a`, `b` and `c`.
 *
 * A race is an initial platform state and two to six transactions, each one write of the application on its own writer:
 *
 * - a grizzle writer applies the write's program through its Db: one of the fixture's ChangeSets with its parameters
 *   (recordUsage, refund, setCap, setCaps' MERGE, changeRate, revokeKey, and the settlements payInvoice, disputeInvoice
 *   and voidInvoice, whose members share the sub-query reading the invoice's state), or, for a write the application
 *   computes from a read, the read and then the ChangeSet, two transactions. grizzle makes one attempt per call; the
 *   writer runs the call again after a TransientFailure, and only after one, as the application does;
 * - a direct writer runs the same write as plain SQL in one SERIALIZABLE transaction: a DELETE of each exact fact, then
 *   an INSERT per relation in load order, ending with COMMIT, or with SET CONSTRAINTS ALL IMMEDIATE and then COMMIT,
 *   so its laws are checked at a statement of its own rather than by COMMIT.
 *
 * Each write states its meaning on the host: the operations its program applies to a state (Op), a function of
 * the state where its program reads (a settlement applies only to an invoice in the state it reads), and a direct
 * writer's statements. The driver runs every order of a race of few moves and a PCT schedule otherwise. Each run is
 * read back as the owner and judged:
 *
 * - every abort is 40001 or 40P01: a direct transaction's failure with either, and each call a grizzle writer ran again,
 *   a TransientFailure whose server report is of class 40. Which session PostgreSQL makes the deadlock victim is the
 *   driver's branch, judged like any other;
 * - some serial order of the committed transactions, respecting real time (one that finished before another began
 *   comes first), explains each: applied by the model at its place, each decides what it decided, accepted or
 *   no-change, and the state after the last is the committed state, relation by relation as sets of facts;
 * - every refusal is explained by a serial order of its own: the committed transactions with the refusal placed, in
 *   real time, where the model refuses it by the law it named, one the model's state after it breaks. A refusal
 *   commits nothing, so no order need place two of them;
 * - every grizzle write converges: run again after each TransientFailure, it answers accepted, no-change or
 *   invariant-rejected, and one that never answers hangs its case (runGrizzle);
 * - the race's own contract holds of the explained order, stated in billing terms (each race's judge);
 * - the first accepted grizzle write the model says the committed state already reflects is applied again by two
 *   grizzle writers at once, and both are no-change and leave the state as it was: a write's keys make its retry
 *   idempotent.
 *
 * The platform with the races' worlds, under a schema name: the full role `app` the grizzle writers open, in the login
 * `server`, and the full role `direct` the psql writers take on, in the login `psql`, each writing every stored
 * relation. The Dbs, their ChangeSets and reads are the platform's own.
 */
export const racesAt = (name: string) => {
	const base = P.platformAt(name).Platform
	const app = role(base, "app", wholeEntriesOf(base), { write: writableNamesOf(base) })
	const direct = role(base, "direct", wholeEntriesOf(base), { write: writableNamesOf(base) })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app]),
		psql: login(base, "psql", [direct])
	}
}
type RacesWorlds = ReturnType<typeof racesAt>
export type RacesDb = DbOf<RacesWorlds["app"], unknown>

/** The platform's stored relations, by name. */
const platformRelations = {
	Month: P.Month,
	Day: P.Day,
	Org: P.Org,
	ParentOrg: P.ParentOrg,
	Workspace: P.Workspace,
	WorkspaceLimit: P.WorkspaceLimit,
	ApiKey: P.ApiKey,
	Revocation: P.Revocation,
	ApiKeyActive: P.ApiKeyActive,
	Provider: P.Provider,
	Model: P.Model,
	Route: P.Route,
	ProviderPrice: P.ProviderPrice,
	RateCard: P.RateCard,
	RateTier: P.RateTier,
	CreditGrant: P.CreditGrant,
	Subscription: P.Subscription,
	Segment: P.Segment,
	UsageEvent: P.UsageEvent,
	EventCharge: P.EventCharge,
	UsageCharge: P.UsageCharge,
	ProviderCost: P.ProviderCost,
	CreditDebit: P.CreditDebit,
	Invoice: P.Invoice,
	InvoiceLine: P.InvoiceLine,
	UsageLine: P.UsageLine,
	PlanLine: P.PlanLine,
	Allocation: P.Allocation,
	Payment: P.Payment,
	Voiding: P.Voiding,
	Dispute: P.Dispute,
	Refund: P.Refund
} as const satisfies Readonly<
	Record<
		RelationName,
		{
			readonly fields: Readonly<Record<string, object>>
			readonly primaryKey: ReadonlyArray<string>
		}
	>
>

/**
 * A relation's fields its caller writes, in declaration order: every field but those grizzle draws or accumulates for
 * a counted family, which carry a writing of their own. They are a fact's fields, the columns a direct writer states
 * for its facts beside the drawn ones, and those a read-back compares with the model.
 */
const writtenFields = (relation: {
	readonly fields: Readonly<Record<string, object>>
}): ReadonlyArray<string> =>
	Arr.flatMap(Rec.toEntries(relation.fields), ([name, field]) => ("writing" in field ? [] : [name]))

export const fieldsOf: Readonly<Record<RelationName, ReadonlyArray<string>>> = Rec.map(
	platformRelations,
	writtenFields
)

/** Each stored relation's primary key: the conflict target of a direct writer's put. */
const primaryKeyOf: Readonly<Record<RelationName, ReadonlyArray<string>>> = Rec.map(
	platformRelations,
	(r) => r.primaryKey
)

/** What a grizzle call answered, as the oracle reads it. */
export type Answer =
	| { readonly kind: "accepted" | "no-change" }
	| { readonly kind: "invariant-rejected"; readonly laws: Arr.NonEmptyReadonlyArray<LawId> }
	| { readonly kind: "outside-world"; readonly relation: string }

/** The platform's installed names: an outcome's law read back to its LawId. */
const platformNames = installationNamesOf(installationOf(P.Platform, { kind: "declared" }))

export const answerOf = (outcome: ApplyOutcome<unknown>): Answer => {
	switch (outcome.kind) {
		case "invariant-rejected":
			return {
				kind: outcome.kind,
				laws: Arr.map(outcome.refused.laws, (law) => platformNames.reported(law))
			}
		case "outside-world":
			return { kind: outcome.kind, relation: outcome.relation }
		case "accepted":
		case "no-change":
			return { kind: outcome.kind }
	}
}

/** A ChangeSet applied with its parameters, and what it applies to a state. */
export interface Program {
	readonly apply: (db: RacesDb) => Effect.Effect<Answer, ApplyError>
	readonly ops: (s: State) => ReadonlyArray<PlatformOp>
}

/**
 * What a grizzle writer runs: a program, or a read and then the program the application computes from it, whose
 * operations are then known; the writer's retry after a TransientFailure reads again.
 */
type GrizzleWrite =
	| ({ readonly kind: "program" } & Program)
	| {
			readonly kind: "read"
			readonly read: (db: RacesDb) => Effect.Effect<Computed, ReadError>
	  }

interface Computed {
	readonly apply: (db: RacesDb) => Effect.Effect<Answer, ApplyError>
	readonly ops: ReadonlyArray<PlatformOp>
}

export const program = (apply: Program["apply"], ops: Program["ops"]): GrizzleWrite => ({
	kind: "program",
	apply,
	ops
})

/** A program whose operations do not depend on the state. */
export const stated = (apply: Program["apply"], ops: ReadonlyArray<PlatformOp>): GrizzleWrite =>
	program(apply, () => ops)

/** One write of the application, as a grizzle writer and as a direct writer make it. */
export interface Write {
	/** The program kind, for features and reports: "usage", "caps merge", "refund", ... */
	readonly kind: string
	readonly label: string
	readonly grizzle: GrizzleWrite
	/**
	 * Deletions first, then puts and insertions in load order. A fact changed at its key is its put: an owner keeps its
	 * families, so a direct writer never deletes and re-inserts it.
	 */
	readonly direct: ReadonlyArray<DirectStatement>
}

/** A relation's place in the load order. */
const loadRank = (relation: RelationName): number => loadOrder.indexOf(relation)

/** The direct statements of operations: deletions first, then puts and insertions in load order. */
export const statementsOf = (ops: ReadonlyArray<PlatformOp>): ReadonlyArray<DirectStatement> => {
	const of = (kinds: ReadonlyArray<PlatformOp["kind"]>) =>
		Arr.map(
			Arr.sort(
				Arr.filter(ops, (o) => kinds.includes(o.kind) && o.facts.length > 0),
				Order.mapInput(Order.Number, (o: PlatformOp) => loadRank(o.relation))
			),
			(o): DirectStatement => ({ kind: o.kind, relation: o.relation, facts: o.facts })
		)
	return [...of(["delete"]), ...of(["put", "insert"])]
}

/**
 * Who runs a transaction: a grizzle writer, or a direct writer whose laws are checked by COMMIT or by SET CONSTRAINTS
 * ALL IMMEDIATE before it.
 */
type WriterSpec =
	| { readonly kind: "grizzle" }
	| { readonly kind: "direct"; readonly checked: Checked }
export type Checked = "at COMMIT" | "before COMMIT"

interface RaceTxn {
	readonly write: Write
	readonly writer: WriterSpec
}

/**
 * What a transaction did, as the oracle judges it: committed (a grizzle write accepted, or a direct COMMIT), no-change,
 * refused by a law, or aborted by PostgreSQL with 40001 or 40P01 (a direct transaction; a grizzle writer runs again).
 */
type Observed =
	| { readonly kind: "accepted" }
	| { readonly kind: "no-change" }
	| {
			/**
			 * The laws a refusal names: one, or every law one native object discharges together, as a family's axis
			 * foreign key does the containments merged into it; at least one of them is violated.
			 */
			readonly kind: "refused"
			readonly laws: Arr.NonEmptyReadonlyArray<HostLaw>
	  }
	| { readonly kind: "aborted"; readonly sqlstate: "40001" | "40P01" }

/** One transaction of a run, as it ran. */
export interface Ran {
	readonly id: number
	readonly writer: WriterSpec["kind"]
	readonly observed: Observed
	readonly start: number
	readonly end: number
	/**
	 * What the model applies at its place: a grizzle write's operations (a computed write's as its last attempt applied
	 * them), or a direct writer's statements.
	 */
	readonly decide: (s: State) => Decision
	/** A grizzle write's operations at a state, for reports and judges; none for a direct writer. */
	readonly ops: (s: State) => ReadonlyArray<PlatformOp>
}

/**
 * A run the model explained: its transactions, the serial order of the committed ones with the state before each place
 * and after the last, and each refusal with the state its own serial order refuses it at.
 */
export interface ExplainedRun {
	readonly ran: ReadonlyArray<Ran>
	readonly order: ReadonlyArray<number>
	/** states[k] is the state before the k-th of the order; the last is the committed state. */
	readonly states: ReadonlyArray<State>
	readonly refusals: ReadonlyMap<number, State>
}

export const committedOf = (e: ExplainedRun): State =>
	defined(e.states[e.states.length - 1], "the committed state")

const stateBefore = (e: ExplainedRun, place: number): State =>
	defined(e.states[place], `the state before ${place}`)

export const ranOf = (e: ExplainedRun, id: number): Ran => defined(e.ran[id], `transaction #${id}`)

/**
 * The state a transaction that did not abort was explained at: a committed one's place in the order, a refusal's in its
 * own order.
 */
export const beforeOf = (e: ExplainedRun, id: number): State => {
	const refusedJudgment = e.refusals.get(id)
	if (refusedJudgment !== undefined) {
		return refusedJudgment
	}
	const place = e.order.indexOf(id)
	if (place < 0) {
		throw new Error(`#${id} aborted and is in no serial order`)
	}
	return stateBefore(e, place)
}

/** The transactions that did not abort, by id. */
export const explainedIds = (e: ExplainedRun): ReadonlyArray<number> =>
	Arr.map(
		Arr.filter(e.ran, (r) => r.observed.kind !== "aborted"),
		(r) => r.id
	)

/**
 * A race: the initial state, its transactions, and its contract on every explained run, which names why the run departs
 * from it (or none) and what the run reached.
 */
export interface Race {
	readonly initial: PlatformFacts
	readonly txns: ReadonlyArray<RaceTxn>
	readonly judge: (e: ExplainedRun) => {
		readonly departure: string | undefined
		readonly reached: ReadonlyArray<RaceFeature>
	}
}

/**
 * What a race case notes: the strategy; each program kind raced; each outcome by writer kind; the family of each law
 * that refused (the law family hit); each abort's SQLSTATE and each retry's reason; how a direct writer's laws were
 * checked; two transactions that overlapped in real time, a deadlock PostgreSQL broke, a lock wait; exact repeats run;
 * and what the race's own contract reached.
 */
export type RaceFeature =
	| "every interleaving"
	| "pct"
	| `write: ${string}`
	| `${WriterSpec["kind"]} ${Observed["kind"]}`
	| `law family hit: ${LawFamily}`
	| `aborted with ${"40001" | "40P01"}`
	| `retried after ${string}`
	| `direct checked ${Checked}`
	| "overlapping"
	| "deadlock"
	| "blocked"
	| "exact repeats"
	| `planted: ${string}`

const writerFeatures = ["grizzle", "direct", "at COMMIT", "before COMMIT"] as const
type WriterFeature = (typeof writerFeatures)[number]
const writerKinds = ["grizzle", "direct"] as const
const checks = ["at COMMIT", "before COMMIT"] as const

/**
 * A transaction's writer as the race's writer swarm chose it: the kind it wants, and how its laws are checked when it
 * runs direct. Both are drawn whatever the kind, since raceTxns may settle another when no writer of the kind is free.
 */
export interface WriterChoice {
	readonly kind: WriterSpec["kind"]
	readonly checked: Checked
}

const grizzleSessions = ["g", "h", "i"] as const
const directSessions = ["a", "b", "c"] as const
type GrizzleSession = (typeof grizzleSessions)[number]
type DirectSession = (typeof directSessions)[number]

/**
 * The writers of `writes`, each as its choice wants: a grizzle writer while one is free and a direct writer otherwise
 * (three of each).
 */
export const raceTxns = (
	writers: ReadonlyArray<WriterChoice>,
	writes: ReadonlyArray<Write>
): ReadonlyArray<RaceTxn> => {
	let grizzles = 0
	let directs = 0
	return Arr.map(writes, (write, i): RaceTxn => {
		const w = defined(writers[i], `the writer of transaction ${i}`)
		if (
			(w.kind === "grizzle" && grizzles < grizzleSessions.length) ||
			directs >= directSessions.length
		) {
			grizzles++
			return { write, writer: { kind: "grizzle" } }
		}
		directs++
		return { write, writer: { kind: "direct", checked: w.checked } }
	})
}

/** The most transactions a race runs: one per writer session, so raceTxns always finds a free writer. */
const maxTxns = grizzleSessions.length + directSessions.length

const writerChoiceGen =
	(writers: Swarm<WriterFeature>): Gen<WriterChoice> =>
	(source) => ({
		kind: source.draw(swarmChoice(writers, writerKinds)),
		checked: source.draw(swarmChoice(writers, checks))
	})

/** A race's writers: its writer swarm, then a writer choice under it for each transaction a race may run. */
export const writersGen: Gen<ReadonlyArray<WriterChoice>> = (source) => {
	const writers = source.draw(swarm(writerFeatures))
	return source.draw(array(writerChoiceGen(writers), { min: maxTxns, max: maxTxns }))
}

/**
 * How a race's transactions are ordered when it makes too many moves to explore every order: its PCT schedule over
 * the race's sessions, with up to two change points among its moves, and, one race in two that has a direct
 * transaction, the first direct transaction run first and dropped below every other after one of its statements, so it
 * holds its transaction open while the other writers run. PCT places its change points over every move, so its
 * schedules alone hold a direct transaction open across another writer's write too rarely to count on; one race in two
 * draws the preemption itself. It is drawn in the case once the race's transactions and moves are known.
 */
const raceSchedule = (txns: ReadonlyArray<Txn>, moves: number): Gen<PctSchedule<string>> => {
	const pct = pctSchedule(
		nonEmpty(
			Arr.map(txns, (t) => t.session),
			"a race's transactions"
		),
		3,
		moves
	)
	const direct = Arr.findFirst(txns, (t) => t.kind === "direct")
	return (source) => {
		const drawn = source.draw(pct)
		if (Option.isNone(direct)) {
			return drawn
		}
		const first = direct.value
		const preempt = source.draw(
			oneOf<Option.Option<number>>([
				constant(Option.none()),
				map(int(1, first.steps.length), Option.some)
			])
		)
		return Option.match(preempt, {
			onNone: () => drawn,
			onSome: (after) => ({
				priorities: [first.session, ...Arr.filter(drawn.priorities, (x) => x !== first.session)],
				changes: [after, ...drawn.changes]
			})
		})
	}
}

interface RaceInstall {
	readonly rig: Rig<RacesWorlds>
	readonly names: Names
	readonly laws: ReadonlyMap<LawId, HostLaw>
}

const installRaces = Effect.map(openRig("Platform", racesAt), (rig): RaceInstall => {
	const names = namesOf(rig.installed)
	return { rig, names, laws: lawsById(names) }
})

interface Connected {
	readonly dbs: Readonly<Record<GrizzleSession, RacesDb>>
	readonly actors: Actors<DirectSession, GrizzleSession>
}

/**
 * A Db of `app` opened through its own DbLayer of the login `server`, as an application opens it, and its actor: the
 * one session of the login that is none of `beside`.
 */
const openApp = (
	i: RaceInstall,
	name: GrizzleSession,
	beside: ReadonlyArray<number>
): Effect.Effect<
	{ readonly db: RacesDb; readonly actor: GrizzleActor },
	OpenError,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const server = i.rig.worlds.server
		const context = yield* Layer.build(loginLayer(i.rig.installed, server))
		const db = yield* Db.open(server.roles.app, {}).pipe(Effect.provideContext(context))
		return { db, actor: yield* grizzleActor(name, i.rig.installed.as(server).role, beside) }
	})

const connect = (
	i: RaceInstall
): Effect.Effect<Connected, OpenError | SqlError | PsqlProcessError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const g = yield* openApp(i, "g", [])
		const h = yield* openApp(i, "h", [g.actor.pid])
		const k = yield* openApp(i, "i", [g.actor.pid, h.actor.pid])
		const direct = i.rig.direct
		return {
			dbs: { g: g.db, h: h.db, i: k.db },
			actors: {
				direct: yield* openActors(s, {
					a: { kind: "psql", as: direct },
					b: { kind: "psql", as: direct },
					c: { kind: "psql", as: direct }
				}),
				grizzle: { g: g.actor, h: h.actor, i: k.actor }
			}
		}
	})

/** A host value as the text PostgreSQL's input and output functions spell it: a span as its half-open range. */
const valueText = (v: unknown): string => {
	if (typeof v === "string") {
		return v
	}
	if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") {
		return String(v)
	}
	const s = spanValue(v)
	return `[${s.start},${s.end})`
}

/**
 * A host value of a relation's field as its column spells it: a closed id as its handle's code under the
 * installation's codebook, the smallint the column stores under its roster's domain; any other value as valueText
 * spells it.
 */
const fieldText = (names: Names, relation: RelationName, field: string, v: unknown): string => {
	const type = Option.map(
		Arr.findFirst(names.model.theory.relations[relation]?.fields ?? [], (f) => f.name === field),
		(f) => f.type
	)
	return Option.isSome(type) && type.value.carrier === "code" && typeof v === "string"
		? String(codeOf(codecOf(names.installation.names.codes, type.value.roster), v))
		: valueText(v)
}

/** A field's literal of unknown type, which PostgreSQL resolves to the column's type. */
export const literal = (names: Names, relation: RelationName, field: string, v: unknown): string =>
	`'${pipe(fieldText(names, relation, field, v), Str.replaceAll("'", "''"))}'`

export const tableOf = (names: Names, relation: RelationName): string =>
	`${quoteIdent(names.schema)}.${quoteIdent(names.tableIdent({ name: relation }))}`

export const columnOf = (names: Names, relation: RelationName, field: string): string =>
	quoteIdent(names.columnIdent({ name: relation }, field))

/** A stored relation by its name in the installation's law model. */
const relationNamed = (name: string): RelationName => {
	const found = Arr.findFirst(loadOrder, (r) => r === name)
	if (Option.isNone(found)) {
		throw new Error(`the platform stores no relation ${name}`)
	}
	return found.value
}

/**
 * A counted family as a direct writer fills it, read off the installation's law model: its member and owner, each
 * group field of the member with the owner's key field it names, the member's slot ‹i› and copy ‹n›, the owner's
 * count, and each sum plane's step field, the member's before and after, the owner's end and the identity. Every
 * column is quoted.
 */
interface DirectFamily {
	readonly label: string
	readonly member: RelationName
	readonly owner: RelationName
	readonly group: ReadonlyArray<{ readonly member: string; readonly owner: string }>
	readonly index: string
	readonly copy: string
	readonly count: string
	readonly planes: ReadonlyArray<{
		readonly step: string
		readonly before: string
		readonly after: string
		readonly end: string
		readonly identity: bigint
	}>
}

const directFamilies = (names: Names): ReadonlyArray<DirectFamily> =>
	Arr.map(names.model.families, (f: Family): DirectFamily => {
		const label = `fin(${f.id.owner}, ${f.id.count})`
		const member = relationNamed(f.member.name)
		const owner = relationNamed(f.owner.name)
		const field = (relation: RelationName, name: string): string =>
			quoteIdent(names.columnIdent({ name: relation }, name))
		const lawColumn = (c: NativeColumn, what: string): string => {
			if (c.kind !== "law") {
				throw new Error(
					`${label}'s ${what} is a field: a direct writer fills a counted family's law columns`
				)
			}
			return quoteIdent(c.column)
		}
		return {
			label,
			member,
			owner,
			group: Arr.map(f.group, (g) => ({ member: g.member.name, owner: g.owner.name })),
			index: lawColumn(f.index, "index"),
			copy: quoteIdent(f.copy),
			count: field(owner, f.count.name),
			planes: Arr.flatMap(f.folds, (fold) => {
				const step = fold.step
				if (fold.monoid !== "sum" || step.kind !== "value" || fold.where.length > 0) {
					throw new Error(
						`${label} has a ${fold.monoid} fold: a direct writer fills sum folds over every member`
					)
				}
				return Arr.map(fold.planes, (plane) => {
					if (plane.identity.kind !== "int") {
						throw new Error(`${label}'s sum starts at a ${plane.identity.kind}, not an integer`)
					}
					return {
						step: step.field.name,
						before: lawColumn(plane.before, "before"),
						after: lawColumn(plane.after, "after"),
						end: field(owner, plane.end.name),
						identity: plane.identity.value
					}
				})
			})
		}
	})

/** An integer a family draws, as SQL. */
const drawnText = (n: bigint): string => `${n}::bigint`

/** An integer field of a fact: the step value a sum folds. */
const stepOf = (row: PlatformRow, field: string): bigint => {
	const v = row[field]
	if (typeof v === "bigint") {
		return v
	}
	if (typeof v === "number" && Number.isSafeInteger(v)) {
		return BigInt(v)
	}
	throw new Error(`${field} is no integer: ${String(v)}`)
}

/**
 * A direct transaction's statements as the SQL its writer runs, one statement each. A direct writer writes what
 * grizzle's filler writes for its facts (rows-first.md §2): an owner it inserts states its count and its ends, and a
 * member its slot ‹i›, its owner's count ‹n› and each sum's before and after. Where the transaction inserts the owner
 * too, the group's members are the transaction's own, slotted in their keys' order; where the owner is stored, the
 * member's statement appends to it, advancing the owner's count and ends in place (its checks judge them there) and
 * slotting the members after the stored ones by what that update returns, so concurrent appenders serialize on the
 * owner's row. An owner that is not stored leaves the update nothing to return, and the members then name a count no
 * owner holds, which its owner axis refuses. An owner put takes its written fields in place and keeps its families. A
 * member is never deleted or put: that edits its family, which only the planner does.
 */
export const directSql = (
	names: Names,
	statements: ReadonlyArray<DirectStatement>
): ReadonlyArray<string> => {
	const families = directFamilies(names)
	const groupOf = (f: DirectFamily, member: PlatformRow): ValueIdentity =>
		keyAtoms(
			member,
			Arr.map(f.group, (g) => g.member)
		)
	const ownerKeyOf = (f: DirectFamily, owner: PlatformRow): ValueIdentity =>
		keyAtoms(
			owner,
			Arr.map(f.group, (g) => g.owner)
		)
	const inserted = (relation: RelationName): ReadonlyArray<PlatformRow> =>
		Arr.flatMap(statements, (s) => (s.kind === "insert" && s.relation === relation ? s.facts : []))
	/** Each family's members the transaction inserts into an owner it inserts, by group, in member-key order. */
	const own = new Map(
		Arr.map(
			families,
			(f): readonly [DirectFamily, ReadonlyTupleMap<ValueIdentity, ReadonlyArray<PlatformRow>>] => {
				const owners = new TupleSet<ValueIdentity>()
				for (const o of inserted(f.owner)) {
					owners.add(ownerKeyOf(f, o))
				}
				const groups = new TupleMap<ValueIdentity, Array<PlatformRow>>()
				for (const m of inserted(f.member)) {
					const g = groupOf(f, m)
					if (!owners.has(g)) {
						continue
					}
					const members = groups.get(g) ?? []
					groups.set(g, members)
					members.push(m)
				}
				const byKey = Order.mapInput(valueIdentityOrder, (m: PlatformRow) =>
					keyAtoms(m, primaryKeyOf[f.member])
				)
				const sorted = new TupleMap<ValueIdentity, ReadonlyArray<PlatformRow>>()
				for (const [g, ms] of groups) {
					sorted.set(g, Arr.sort(ms, byKey))
				}
				return [f, sorted]
			}
		)
	)
	const ownGroup = (f: DirectFamily, g: ValueIdentity): ReadonlyArray<PlatformRow> | undefined =>
		own.get(f)?.get(g)
	const table = (relation: RelationName): string => tableOf(names, relation)
	const column = (relation: RelationName, field: string): string => columnOf(names, relation, field)
	const sumOf = (rows: ReadonlyArray<PlatformRow>, field: string): bigint =>
		Arr.reduce(rows, 0n, (sum, r) => sum + stepOf(r, field))
	const ownedBy = (relation: RelationName): ReadonlyArray<DirectFamily> =>
		Arr.filter(families, (f) => f.owner === relation)
	/** An owner's drawn columns: its count and its ends, per family it owns. */
	const ownerColumns = (relation: RelationName): ReadonlyArray<string> =>
		Arr.flatMap(ownedBy(relation), (f) => [f.count, ...Arr.map(f.planes, (p) => p.end)])
	/**
	 * An owner's count and ends as an insert states them: over the transaction's own members of it, or, `fresh`, over
	 * none, as a put that inserts it starts its families empty.
	 */
	const ownerValues = (
		relation: RelationName,
		row: PlatformRow,
		fresh: boolean
	): ReadonlyArray<string> =>
		Arr.flatMap(ownedBy(relation), (f) => {
			const members = fresh ? [] : (ownGroup(f, ownerKeyOf(f, row)) ?? [])
			return [
				drawnText(BigInt(members.length)),
				...Arr.map(f.planes, (p) => drawnText(p.identity + sumOf(members, p.step)))
			]
		})
	const memberFamilies = (relation: RelationName): ReadonlyArray<DirectFamily> =>
		Arr.filter(families, (f) => f.member === relation)
	const memberColumns = (relation: RelationName) =>
		Arr.flatMap(memberFamilies(relation), (f) => [
			f.index,
			f.copy,
			...Arr.flatMap(f.planes, (p) => [p.before, p.after])
		])
	const insertSql = (relation: RelationName, facts: ReadonlyArray<PlatformRow>): string => {
		/** One update per stored owner the statement appends to, by family and group. */
		const appends: Array<{
			readonly f: DirectFamily
			readonly group: ValueIdentity
			readonly alias: string
		}> = []
		const appendTo = (f: DirectFamily, group: ValueIdentity): string => {
			const found = Arr.findFirst(appends, (a) => a.f === f && sameIdentity(a.group, group))
			if (Option.isSome(found)) {
				return found.value.alias
			}
			const alias = quoteIdent(`append_${appends.length}`)
			appends.push({ f, group, alias })
			return alias
		}
		const appended = (f: DirectFamily, group: ValueIdentity): ReadonlyArray<PlatformRow> =>
			Arr.filter(facts, (m) => sameIdentity(groupOf(f, m), group))
		const memberValues = (row: PlatformRow): ReadonlyArray<string> =>
			Arr.flatMap(memberFamilies(relation), (f) => {
				const group = groupOf(f, row)
				const mine = ownGroup(f, group)
				const members = mine ?? appended(f, group)
				const slot = members.indexOf(row)
				const k = BigInt(members.length)
				const before = (p: DirectFamily["planes"][number]) => sumOf(members.slice(0, slot), p.step)
				if (mine !== undefined) {
					return [
						drawnText(BigInt(slot)),
						drawnText(k),
						...Arr.flatMap(f.planes, (p) => [
							drawnText(p.identity + before(p)),
							drawnText(p.identity + before(p) + stepOf(row, p.step))
						])
					]
				}
				const alias = appendTo(f, group)
				const count = `COALESCE((SELECT n FROM ${alias}), ${drawnText(k)})`
				return [
					`${count} - ${drawnText(k - BigInt(slot))}`,
					count,
					...Arr.flatMap(f.planes, (p, plane) => {
						const total = sumOf(members, p.step)
						const end = `COALESCE((SELECT e${plane} FROM ${alias}), ${drawnText(p.identity + total)})`
						const at = total - before(p)
						return [`${end} - ${drawnText(at)}`, `${end} - ${drawnText(at - stepOf(row, p.step))}`]
					})
				]
			})
		const rows = Arr.map(
			facts,
			(fact) =>
				`(${Arr.join(
					[
						...Arr.map(fieldsOf[relation], (f) => literal(names, relation, f, fact[f])),
						...ownerValues(relation, fact, false),
						...memberValues(fact)
					],
					", "
				)})`
		)
		const columns = [
			...Arr.map(fieldsOf[relation], (f) => column(relation, f)),
			...ownerColumns(relation),
			...memberColumns(relation)
		]
		const insert = `INSERT INTO ${table(relation)} (${Arr.join(columns, ", ")}) VALUES ${Arr.join(rows, ", ")}`
		if (!Arr.isArrayNonEmpty(appends)) {
			return insert
		}
		const updates = Arr.map(appends, ({ f, group, alias }) => {
			const members = appended(f, group)
			const representative = defined(members[0], `a member appended to ${f.label}`)
			const where = Arr.join(
				Arr.map(
					f.group,
					(g) =>
						`${column(f.owner, g.owner)} = ${literal(names, f.owner, g.owner, representative[g.member])}`
				),
				" AND "
			)
			const sets = [
				`${f.count} = ${f.count} + ${drawnText(BigInt(members.length))}`,
				...Arr.map(f.planes, (p) => `${p.end} = ${p.end} + ${drawnText(sumOf(members, p.step))}`)
			]
			const returning = [
				`${f.count} AS n`,
				...Arr.map(f.planes, (p, plane) => `${p.end} AS e${plane}`)
			]
			return `${alias} AS (UPDATE ${table(f.owner)} SET ${Arr.join(sets, ", ")} WHERE ${where} RETURNING ${Arr.join(returning, ", ")})`
		})
		return `WITH ${Arr.join(updates, ", ")} ${insert}`
	}
	const unedited = (s: DirectStatement): void => {
		if (Arr.isReadonlyArrayNonEmpty(memberFamilies(s.relation))) {
			throw new Error(
				`a direct ${s.kind} of ${s.relation}, a member of ${Arr.join(
					Arr.map(memberFamilies(s.relation), (f) => f.label),
					" and "
				)}: that edits its family, which only the planner does`
			)
		}
	}
	const deleteSql = (relation: RelationName, facts: ReadonlyArray<PlatformRow>): string =>
		`DELETE FROM ${table(relation)} WHERE ${Arr.join(
			Arr.map(
				facts,
				(fact) =>
					`(${Arr.join(
						Arr.map(
							fieldsOf[relation],
							(f) => `${column(relation, f)} = ${literal(names, relation, f, fact[f])}`
						),
						" AND "
					)})`
			),
			" OR "
		)}`
	/**
	 * A put: the written fields at each key in place, and a fact no row holds the key of inserted with its families
	 * empty, each fact an UPDATE and an INSERT of one statement, which both read its starting state. Only a fact at no
	 * stored key is proposed to the INSERT: a stored owner's proposed row would carry its families empty, and PostgreSQL
	 * judges a proposed row by every CHECK before ON CONFLICT meets its key (19rc1 nodeModifyTable.c ExecInsert), so a
	 * check over an end, an invoice's lines summing to its amount, would refuse it. Each literal takes its column's type
	 * where it is assigned or compared, an INSERT's SELECT list included.
	 */
	const putSql = (relation: RelationName, facts: ReadonlyArray<PlatformRow>): string => {
		const key = primaryKeyOf[relation]
		const payload = Arr.filter(fieldsOf[relation], (f) => !key.includes(f))
		const columns = [
			...Arr.map(fieldsOf[relation], (f) => column(relation, f)),
			...ownerColumns(relation)
		]
		const parts = Arr.flatMap(facts, (fact, i) => {
			const value = (f: string): string => literal(names, relation, f, fact[f])
			const at = Arr.join(
				Arr.map(key, (f) => `${column(relation, f)} = ${value(f)}`),
				" AND "
			)
			const update = Arr.isArrayNonEmpty(payload)
				? [
						`${quoteIdent(`put_update_${i}`)} AS (UPDATE ${table(relation)} SET ${Arr.join(
							Arr.map(payload, (f) => `${column(relation, f)} = ${value(f)}`),
							", "
						)} WHERE ${at})`
					]
				: []
			const values = [...Arr.map(fieldsOf[relation], value), ...ownerValues(relation, fact, true)]
			return [
				...update,
				`${quoteIdent(`put_insert_${i}`)} AS (INSERT INTO ${table(relation)} (${Arr.join(columns, ", ")}) SELECT ${Arr.join(
					values,
					", "
				)} WHERE NOT EXISTS (SELECT 1 FROM ${table(relation)} WHERE ${at}))`
			]
		})
		return `WITH ${Arr.join(parts, ", ")} SELECT 1`
	}
	return Arr.map(statements, (s) => {
		switch (s.kind) {
			case "insert":
				return insertSql(s.relation, s.facts)
			case "delete":
				unedited(s)
				return deleteSql(s.relation, s.facts)
			case "put":
				unedited(s)
				return putSql(s.relation, s.facts)
		}
	})
}

/** Empties every table and loads the facts, as the owner, in one transaction, as a direct writer writes them. */
const loadSql = (names: Names, facts: State): ReadonlyArray<string> => [
	`TRUNCATE ${Arr.join(
		Arr.map(loadOrder, (r) => tableOf(names, r)),
		", "
	)}`,
	...directSql(
		names,
		Arr.flatMap(loadOrder, (r): ReadonlyArray<DirectStatement> => {
			const rows = rowsIn(facts, r)
			return rows.length === 0 ? [] : [{ kind: "insert", relation: r, facts: rows }]
		})
	)
]

/**
 * A relation's rows as text tuples, the written fields in declaration order, a closed id as its code: the form a
 * read-back and the model compare in.
 */
const textRows = (
	names: Names,
	relation: RelationName,
	rows: ReadonlyArray<PlatformRow>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (row) =>
			Arr.join(
				Arr.map(fieldsOf[relation], (f) => fieldText(names, relation, f, row[f])),
				"|"
			)
		),
		Order.String
	)

/**
 * Where the committed state, read back as the owner, differs from the model's state: the relations a race writes,
 * compared as text tuples, or undefined when they agree.
 */
const committedDifference = (
	i: RaceInstall,
	env: ExploreEnv,
	written: ReadonlySet<RelationName>,
	model: State
): Effect.Effect<string | undefined, SqlError> =>
	Effect.gen(function* () {
		for (const relation of loadOrder) {
			if (!written.has(relation)) {
				continue
			}
			const fields = fieldsOf[relation]
			const read = yield* env.observer.queryValues(
				`SELECT ${Arr.join(
					Arr.map(fields, (f) => `${columnOf(i.names, relation, f)}::text`),
					", "
				)} FROM ${tableOf(i.names, relation)}`,
				[]
			)
			const got = Arr.sort(
				Arr.map(read, (row) =>
					Arr.join(
						Arr.map(row, (v) => String(v)),
						"|"
					)
				),
				Order.String
			)
			const want = textRows(i.names, relation, rowsIn(model, relation))
			const missing = Arr.filter(want, (x) => !got.includes(x))
			const extra = Arr.filter(got, (x) => !want.includes(x))
			if (missing.length > 0 || extra.length > 0 || got.length !== want.length) {
				return `${relation} committed differs from the model: missing [${Arr.join(missing, " / ")}], unexpected [${Arr.join(extra, " / ")}]`
			}
		}
		return undefined
	})

/** The relations a set of relations reaches through the laws: closed under every law whose relations it meets. */
const reach = (relations: Iterable<RelationName>): ReadonlySet<RelationName> => {
	const out = new Set(relations)
	for (let grew = true; grew;) {
		const joining = Arr.filter(
			platformLaws,
			(law) =>
				Arr.some(law.relations, (r) => out.has(r)) && Arr.some(law.relations, (r) => !out.has(r))
		)
		for (const r of Arr.flatMap(joining, (law) => law.relations)) {
			out.add(r)
		}
		grew = joining.length > 0
	}
	return out
}

const footprintOf = (relations: Iterable<RelationName>): Footprint =>
	relationsFootprint(reach(relations))

/**
 * The call a grizzle writer makes, and the operations it applies at a state: a program's, read at the state, or a
 * computed write's, known.
 */
interface Call {
	readonly call: (db: RacesDb) => Effect.Effect<Answer, ApplyError>
	readonly ops: (s: State) => ReadonlyArray<PlatformOp>
}

/**
 * What a grizzle writer's write did: each call refused by a TransientFailure (its reason and its server report's
 * SQLSTATE), and how the last call ended: answered by the call it made, or failed with an error that is no
 * TransientFailure.
 */
interface GrizzleRan {
	readonly transients: ReadonlyArray<{ readonly reason: string; readonly sqlstate: string }>
	readonly last:
		| ({ readonly kind: "answered"; readonly answer: Answer } & Call)
		| { readonly kind: "failed"; readonly error: string }
}

/**
 * A grizzle write run as the application runs it: read when it reads, then applied, and the whole again after each
 * TransientFailure, until a call answers. A count of attempts bounds nothing PostgreSQL bounds: an attempt that reads
 * what a transaction SSI has already prepared to commit is refused ("conflict out to pivot", during read) until that
 * commit is visible to a new snapshot, and every attempt run meanwhile is refused alike, however many, for as long as
 * the commit's WAL flush takes under load. Each refusal is a concurrent transaction's, and there are finitely many, so a
 * write that never answers is a hang, which the case's own bound (CaseHung) reports.
 */
const runGrizzle = (form: GrizzleWrite, db: RacesDb): Effect.Effect<GrizzleRan> =>
	Effect.gen(function* () {
		const transients: Array<{ readonly reason: string; readonly sqlstate: string }> = []
		/** Whether the writer runs the write again after `error`, a TransientFailure, which it records. */
		const again = (error: ReadError | ApplyError): boolean => {
			if (!(error instanceof TransientFailure)) {
				return false
			}
			transients.push({ reason: error.reason._tag, sqlstate: error.error.sqlstate })
			return true
		}
		const failed = (error: ReadError | ApplyError): GrizzleRan => ({
			transients,
			last: { kind: "failed", error: messageOf(error) }
		})
		for (;;) {
			const made: Result.Result<Call, ReadError> =
				form.kind === "program"
					? Result.succeed({ call: form.apply, ops: form.ops })
					: yield* Effect.result(
							Effect.map(form.read(db), (c): Call => ({
								call: c.apply,
								ops: () => c.ops
							}))
						)
			/** The call made and its answer, or the read's or the call's failure. */
			const ran: Result.Result<
				{ readonly made: Call; readonly answer: Answer },
				ReadError | ApplyError
			> = Result.isFailure(made)
				? Result.fail(made.failure)
				: yield* Effect.result(
						Effect.map(made.success.call(db), (answer) => ({
							made: made.success,
							answer
						}))
					)
			if (Result.isSuccess(ran)) {
				return {
					transients,
					last: { kind: "answered", answer: ran.success.answer, ...ran.success.made }
				}
			}
			if (!again(ran.failure)) {
				return failed(ran.failure)
			}
		}
	})

/** A race's transactions on their sessions: grizzle writers on g, h and i, direct writers on a, b and c, in order. */
type Placed =
	| {
			readonly id: number
			readonly write: Write
			readonly kind: "grizzle"
			readonly session: GrizzleSession
	  }
	| {
			readonly id: number
			readonly write: Write
			readonly kind: "direct"
			readonly session: DirectSession
			readonly checked: Checked
	  }

const placedTxns = (race: Race): ReadonlyArray<Placed> => {
	let grizzles = 0
	let directs = 0
	return Arr.map(race.txns, (txn, id): Placed =>
		txn.writer.kind === "grizzle"
			? {
					id,
					write: txn.write,
					kind: "grizzle",
					session: defined(grizzleSessions[grizzles++], "a free grizzle writer")
				}
			: {
					id,
					write: txn.write,
					kind: "direct",
					session: defined(directSessions[directs++], "a free direct writer"),
					checked: txn.writer.checked
				}
	)
}

const relationsOf = (w: Write): ReadonlyArray<RelationName> => Arr.map(w.direct, (s) => s.relation)

const txnsOf = (
	i: RaceInstall,
	c: Connected,
	placed: ReadonlyArray<Placed>,
	seen: Map<number, GrizzleRan>
): ReadonlyArray<Txn> =>
	Arr.map(placed, (p): Txn => {
		const footprint = footprintOf(relationsOf(p.write))
		if (p.kind === "grizzle") {
			return {
				kind: "grizzle",
				session: p.session,
				steps: [
					opStep(
						`grizzle ${p.write.label}`,
						Effect.flatMap(runGrizzle(p.write.grizzle, c.dbs[p.session]), (r) =>
							Effect.sync(() => {
								seen.set(p.id, r)
							})
						),
						footprint
					)
				],
				after: undefined
			}
		}
		return {
			kind: "direct",
			session: p.session,
			steps: [
				...Arr.map(Arr.zip(p.write.direct, directSql(i.names, p.write.direct)), ([s, text]) =>
					interleaveStep(text, footprintOf([s.relation]))
				),
				...(p.checked === "before COMMIT"
					? [interleaveStep("SET CONSTRAINTS ALL IMMEDIATE", footprint)]
					: [])
			],
			end: "commit",
			after: undefined
		}
	})

/** How a direct transaction ended, as the oracle reads it, or why it cannot be read. */
const directObserved = (i: RaceInstall, result: TxnResult): Observed | string => {
	switch (result._tag) {
		case "Committed":
			return { kind: "accepted" }
		case "RolledBack":
			return "a direct transaction ending with COMMIT rolled back"
		case "Failed": {
			const failure = result.failure
			if (failure._tag !== "PgError") {
				return `a direct transaction failed without a PostgreSQL error: ${failure._tag}`
			}
			const code = failure.fields.code
			if (code === "40001" || code === "40P01") {
				return { kind: "aborted", sqlstate: code }
			}
			const constraint = failure.fields.constraint
			if (constraint === undefined) {
				return `a direct transaction failed with ${code} on no law: ${failure.fields.message}`
			}
			/** Every law is native: a violation names its constraint under the owner PostgreSQL reports. */
			const owner = reportedOwnerOf(failure.fields)
			if (owner === undefined) {
				return `a direct transaction was refused by ${constraint}, which PostgreSQL reported on no owner`
			}
			const law = i.laws.get(i.names.lawOfConstraint(owner, constraint))
			if (law === undefined) {
				return `a direct transaction was refused by ${constraint}, a law the model does not hold`
			}
			return { kind: "refused", laws: [law] }
		}
	}
}

/** How a grizzle write ended, as the oracle reads it, or why its outcome breaks the contract. */
const grizzleObserved = (i: RaceInstall, r: GrizzleRan): Observed | string => {
	for (const t of r.transients) {
		if (!Str.startsWith("40")(t.sqlstate)) {
			return `a call was refused by TransientFailure ${t.reason} with ${t.sqlstate}, no transaction rollback`
		}
	}
	if (r.last.kind === "failed") {
		return `the write failed: ${r.last.error}`
	}
	const answer = r.last.answer
	if (answer.kind === "outside-world") {
		return `the write was outside its world at ${answer.relation}, which a full role never is`
	}
	if (answer.kind !== "invariant-rejected") {
		return { kind: answer.kind }
	}
	const unheld = Arr.filter(answer.laws, (id) => !i.laws.has(id))
	if (Arr.isReadonlyArrayNonEmpty(unheld)) {
		return `the write was refused by ${Arr.join(unheld, ", ")}, laws the model does not hold`
	}
	return {
		kind: "refused",
		laws: Arr.map(answer.laws, (id) => defined(i.laws.get(id), `the model's law ${id}`))
	}
}

const matches = (observed: Observed, decision: Decision): boolean => {
	switch (observed.kind) {
		case "accepted":
			return decision.kind === "accepted"
		case "no-change":
			return decision.kind === "no-change"
		case "refused":
			return (
				decision.kind === "refused" && Arr.some(observed.laws, (law) => decision.laws.includes(law))
			)
		case "aborted":
			return false
	}
}

const describeDecision = (d: Decision): string =>
	d.kind === "refused"
		? `refused by one of [${Arr.join(
				Arr.map(d.laws, (l) => l.name),
				", "
			)}]`
		: d.kind

const describeObserved = (o: Observed): string =>
	o.kind === "refused"
		? `refused by ${Arr.join(
				Arr.map(o.laws, (l) => l.name),
				" and "
			)}`
		: o.kind === "aborted"
			? `aborted with ${o.sqlstate}`
			: o.kind

/**
 * The serial orders that explain a run: one of the transactions that committed (accepted or no-change), respecting real
 * time, in which the model decides each as observed, with the states it passes; and for each refusal, a serial order of
 * the committed transactions with the refusal placed where the model refuses it by a law it named, and the state
 * there. A refusal commits nothing, so each is explained by an order of its own. Undefined order: why none exists, with
 * each order's first mismatch.
 */
const explain = (
	initial: State,
	ran: ReadonlyArray<Ran>
):
	| {
			readonly order: ReadonlyArray<number>
			readonly states: ReadonlyArray<State>
			readonly refusals: ReadonlyMap<number, State>
	  }
	| string => {
	const misses = new Set<string>()
	/** An order of all of `placed` in which the model decides each as observed. */
	const orderOf = (
		placed: ReadonlyArray<Ran>
	): { readonly order: ReadonlyArray<Ran>; readonly states: ReadonlyArray<State> } | undefined => {
		const search = (
			order: ReadonlyArray<Ran>,
			states: ReadonlyArray<State>
		):
			| { readonly order: ReadonlyArray<Ran>; readonly states: ReadonlyArray<State> }
			| undefined => {
			const at = defined(states[states.length - 1], "the state at the end of the order")
			if (order.length === placed.length) {
				return { order, states }
			}
			for (const next of placed) {
				if (order.includes(next)) {
					continue
				}
				if (Arr.some(placed, (q) => q !== next && !order.includes(q) && q.end < next.start)) {
					continue
				}
				const decision = next.decide(at)
				if (!matches(next.observed, decision)) {
					misses.add(
						`#${next.id} after [${Arr.join(
							Arr.map(order, (r) => `#${r.id}`),
							", "
						)}] was ${describeObserved(next.observed)}, the model ${describeDecision(decision)}`
					)
					continue
				}
				const found = search(
					[...order, next],
					[...states, decision.kind === "accepted" ? decision.after : at]
				)
				if (found !== undefined) {
					return found
				}
			}
			return undefined
		}
		return search([], [initial])
	}
	const committed = Arr.filter(
		ran,
		(r) => r.observed.kind === "accepted" || r.observed.kind === "no-change"
	)
	const explained = orderOf(committed)
	if (explained === undefined) {
		return `no serial order explains the committed transactions:\n  ${Arr.join([...misses], "\n  ")}`
	}
	const refusals = new Map<number, State>()
	for (const r of Arr.filter(ran, (x) => x.observed.kind === "refused")) {
		const found = orderOf([...committed, r])
		if (found === undefined) {
			return `no serial order explains the refusal of #${r.id}:\n  ${Arr.join([...misses], "\n  ")}`
		}
		refusals.set(r.id, defined(found.states[found.order.indexOf(r)], `the state before #${r.id}`))
	}
	return { order: Arr.map(explained.order, (r) => r.id), states: explained.states, refusals }
}

const noteRun = (e: ExplainedRun, run: Interleaving, note: (f: RaceFeature) => void): void => {
	if (run.waits.length > 0) {
		note("blocked")
	}
	if (run.deadlocks.length > 0) {
		note("deadlock")
	}
	for (const r of e.ran) {
		note(`${r.writer} ${r.observed.kind}`)
		if (r.observed.kind === "refused") {
			for (const law of r.observed.laws) {
				note(`law family hit: ${law.family}`)
			}
		}
		if (r.observed.kind === "aborted") {
			note(`aborted with ${r.observed.sqlstate}`)
		}
		if (Arr.some(e.ran, (q) => q !== r && q.start < r.end && r.start < q.end)) {
			note("overlapping")
		}
	}
}

/**
 * The first accepted grizzle write the committed state already reflects, applied again by two grizzle writers at once,
 * one call on each writer's Db: both must be no-change and leave the state as it was.
 */
const exactRepeats = (
	i: RaceInstall,
	c: Connected,
	e: ExplainedRun,
	callOf: (id: number) => Call | undefined,
	written: ReadonlySet<RelationName>
): Effect.Effect<string | undefined, SqlError> =>
	Effect.gen(function* () {
		const committed = committedOf(e)
		const repeat = Arr.findFirst(
			e.ran,
			(r) =>
				r.writer === "grizzle" &&
				r.observed.kind === "accepted" &&
				r.decide(committed).kind === "no-change"
		)
		if (Option.isNone(repeat)) {
			return undefined
		}
		const made = callOf(repeat.value.id)
		if (made === undefined) {
			return undefined
		}
		const again = yield* Effect.forEach([c.dbs.g, c.dbs.h], (db) => Effect.result(made.call(db)), {
			concurrency: "unbounded"
		})
		for (const a of again) {
			if (Result.isFailure(a)) {
				return `the exact repeat of #${repeat.value.id} failed: ${messageOf(a.failure)}`
			}
			if (a.success.kind !== "no-change") {
				return `the exact repeat of #${repeat.value.id} was ${a.success.kind}, not no-change`
			}
		}
		const changed = yield* committedDifference(i, i.rig.env, written, committed)
		return changed === undefined ? undefined : `exact repeats changed the state: ${changed}`
	})

/** The races whose interleavings are all explored: those of at most this many moves. */
const exhaustiveMoves = 5

/** One race case on the installation: it opens the case's writers, explores the race, and notes what it reached. */
const runRace = (i: RaceInstall, race: Race, c: Case<RaceFeature>) =>
	Effect.gen(function* () {
		const connected = yield* connect(i)
		const placed = placedTxns(race)
		const initial = stateOf(race.initial)
		const written = new Set(Arr.flatMap(placed, (p) => relationsOf(p.write)))
		for (const t of race.txns) {
			c.note(`write: ${t.write.kind}`)
			if (t.writer.kind === "direct") {
				c.note(`direct checked ${t.writer.checked}`)
			}
		}
		const seen = new Map<number, GrizzleRan>()
		const txns = txnsOf(i, connected, placed, seen)
		const moves = movesOf(txns)
		const strategy: Strategy =
			moves <= exhaustiveMoves
				? every
				: { kind: "pct", schedule: c.draw(raceSchedule(txns, moves)), nature: c }
		c.note(strategy.kind === "every" ? "every interleaving" : "pct")
		const reached: Array<RaceFeature> = []
		const direct: Partial<Record<DirectSession, DirectActor>> = {}
		const grizzle: Partial<Record<GrizzleSession, GrizzleActor>> = {}
		for (const p of placed) {
			if (p.kind === "grizzle") {
				grizzle[p.session] = connected.actors.grizzle[p.session]
			} else {
				direct[p.session] = connected.actors.direct[p.session]
			}
		}
		const callOf = (id: number): Call | undefined => {
			const r = seen.get(id)
			return r?.last.kind === "answered" ? r.last : undefined
		}
		const ranOfRun = (run: Interleaving): ReadonlyArray<Ran> | string => {
			const out: Array<Ran> = []
			for (const p of placed) {
				const result = run.results[p.session]
				const span = run.spans[p.session]
				if (result === undefined || span === undefined) {
					return `${p.session} never ran`
				}
				if (p.kind === "direct") {
					const observed = directObserved(i, result)
					if (typeof observed === "string") {
						return `#${p.id} on ${p.session}: ${observed}`
					}
					const statements = p.write.direct
					out.push({
						id: p.id,
						writer: "direct",
						observed,
						start: span.start,
						end: span.end,
						decide: (s) => decideStatements(s, statements),
						ops: () => []
					})
					continue
				}
				const r = seen.get(p.id)
				if (r === undefined) {
					return `#${p.id} on ${p.session} recorded no outcome`
				}
				const observed = grizzleObserved(i, r)
				if (typeof observed === "string") {
					return `#${p.id} on ${p.session}: ${observed}`
				}
				for (const t of r.transients) {
					reached.push(`retried after ${t.reason}`)
				}
				if (r.last.kind !== "answered") {
					return `#${p.id} on ${p.session} failed: ${r.last.error}`
				}
				const ops = r.last.ops
				out.push({
					id: p.id,
					writer: "grizzle",
					observed,
					start: span.start,
					end: span.end,
					decide: (s) => decideSet(s, ops(s)),
					ops
				})
			}
			return out
		}
		yield* exploreInterleavings(
			i.rig.env,
			{ direct, grizzle },
			{
				name: `a platform race of ${Arr.join(
					Arr.map(race.txns, (t) => t.write.label),
					", "
				)}`,
				txns,
				reset: Effect.andThen(
					Effect.sync(() => {
						seen.clear()
					}),
					i.rig.owner(loadSql(i.names, initial))
				),
				state: { _tag: "Unread" },
				model: (run) =>
					Effect.gen(function* () {
						const ran = ranOfRun(run)
						if (typeof ran === "string") {
							return refusedJudgment(ran)
						}
						const explained = explain(initial, ran)
						if (typeof explained === "string") {
							return refusedJudgment(explained)
						}
						const e: ExplainedRun = { ran, ...explained }
						const differs = yield* committedDifference(i, i.rig.env, written, committedOf(e))
						if (differs !== undefined) {
							return refusedJudgment(
								`${differs}\n  serial order ${Arr.join(
									Arr.map(e.order, (x) => `#${x}`),
									", "
								)}`
							)
						}
						const judged = race.judge(e)
						if (judged.departure !== undefined) {
							return refusedJudgment(
								`${judged.departure}\n  serial order ${Arr.join(
									Arr.map(e.order, (x) => `#${x}`),
									", "
								)}`
							)
						}
						const repeated = yield* exactRepeats(i, connected, e, callOf, written)
						if (repeated !== undefined) {
							return refusedJudgment(repeated)
						}
						noteRun(e, run, (f) => {
							reached.push(f)
						})
						if (Arr.some(e.ran, (r) => r.writer === "grizzle" && r.observed.kind === "accepted")) {
							reached.push("exact repeats")
						}
						appendAll(reached, judged.reached)
						return allowed
					}),
				maxInterleavings: runawayInterleavings
			},
			strategy
		)
		c.noteAll(reached)
	})

/** Races per test. */
const runsPerTest = 40

/**
 * A race suite: its races drawn as sketches `S`, each resolved in the case to its race (a resolution draws what the
 * sketch's swarms thin), the kept sketches replayed first, and the features its population must reach.
 */
interface RaceSuite<S> {
	readonly label: string
	readonly sketch: Gen<S>
	readonly resolve: (sketch: S) => Gen<Race>
	readonly kept: ReadonlyArray<Kept<S, RaceFeature>>
	readonly required: Situations<RaceFeature>
}

export const raceSuite = <S>(suite: RaceSuite<S>): void => {
	layer(Substrate.layer, { excludeTestServices: true })(`platform races: ${suite.label}`, (it) => {
		it.effect("every race is explained by the billing model and converges", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const installed = yield* installRaces
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: `platform-races/${Str.replaceAll(regex("[^a-z0-9]+", "g"), "-")(suite.label)}`,
							draw: drawn(suite.sketch),
							literal: Formatter.format,
							coverage: required<RaceFeature>(suite.required, {
								cases: runsPerTest,
								sense: notesOnly
							}),
							kept: suite.kept,
							runs: runsPerTest,
							shrink: { kind: "bounded", candidates: 200 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const race = c.draw(suite.resolve(sketch))
								yield* Effect.scoped(runRace(installed, race, c))
							})
					)
				})
			)
		)
	})
}

/** The features every platform race suite reaches. */
export const commonRequired: Arr.NonEmptyReadonlyArray<RaceFeature> = [
	"overlapping",
	"grizzle accepted",
	"grizzle refused",
	"direct accepted",
	"exact repeats"
]

export const amountOf = (row: PlatformRow, field: string): bigint => {
	const v = row[field]
	if (typeof v === "bigint") {
		return v
	}
	if (typeof v === "number") {
		return BigInt(v)
	}
	throw new Error(`${field} is no amount: ${String(v)}`)
}

export const textOf = (row: PlatformRow, field: string): string => {
	const v = row[field]
	if (typeof v !== "string") {
		throw new Error(`${field} is no text: ${String(v)}`)
	}
	return v
}

export const spanOf = (row: PlatformRow, field: string): SpanV => spanValue(row[field])
