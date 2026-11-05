import { Array as Arr, Effect, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { HistoryEnv } from "#test/support/history/run.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import {
	alternativesBox,
	Done,
	Employment,
	type Family,
	installFamily,
	Leased,
	type QueueParams,
	queue,
	queueFamily,
	Roster,
	Rota,
	type RunsParams,
	rosterVisits,
	runs,
	runsRelations,
	Seat,
	Shift,
	spanCoverage,
	type TimekeepingParams,
	Timesheet,
	timekeeping,
	timekeepingFamily,
	Visit,
	type VisitsParams,
	visits,
	Wanted,
	Work
} from "#test/support/laws/boxes.ts"
import type { HostSchema } from "#test/support/laws/model.ts"
import { type Domains, familyWriters, openWriter } from "#test/support/laws/support.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type DbRuntime, dbRuntime } from "#test/support/runtime-db.ts"
import { type GrizzleActor, grizzleActor } from "#test/support/schedules/actors.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/** The grizzle writers: each a Db of `app` with a pool of its own, so its one session is its own backend. */
const grizzleWriters = ["g", "h"] as const
export type GrizzleWriter = (typeof grizzleWriters)[number]

/** One installed family schema as the history writers drive it. */
export interface HistoryRig {
	readonly installed: Installed
	/** The schema value under its installed name, which ChangeSets are built over. */
	readonly schema: AnySchema
	/** The relation values by name. */
	readonly relations: Readonly<Record<string, unknown>>
	/**
	 * Per grizzle writer, the runtime its opened Db dispatches to, which takes a ChangeSet built at run time
	 *, and its actor, the one session its Db's pool holds.
	 */
	readonly runtimes: Readonly<Record<GrizzleWriter, DbRuntime>>
	readonly actors: Readonly<Record<GrizzleWriter, GrizzleActor>>
	/** The role `direct`, as the psql writers take it on. */
	readonly direct: SubstrateWorld
}

/** An installed family schema, holding no connection: the test's resource. */
export interface HistoryInstall<P> {
	/** The parameters it was drawn as, from which a connection rebuilds the schema value under the installed name. */
	readonly params: P
	readonly host: HostSchema
	readonly domains: Domains
	readonly installed: Installed
	/** The installation's names, through the naming door. */
	readonly names: Names
}

/**
 * The law-family schemas the generated histories run over.
 *
 * Each history family is one of the law-bearing generated families: its drawn parameters, its schema, its host model
 * and its field domains are that family's, imported as they are. Every family schema's writers (familyWriters) are the
 * full role `app`, which two grizzle writers `g` and `h` open, each through a DbLayer of its own, so each holds one
 * session of its own, and the full role `direct` the psql writers take on, as any direct SQL writer takes on a role
 * through its login. What a history adds is the grizzle side it drives with several writers at once: the installation
 * opened twice as `app`, each writer's actor resolved as it opens, and the relation values by name, over which a writer
 * builds the ChangeSet of a list of host operations at run time. The host model states each law and how it is enforced,
 * independently of the compiler; the suites check, before they run, that the installation agrees (enforcementProblem):
 * each law of the host is reported by an installed constraint, since every law is native (fin.md §7).
 *
 * A family installs and connects in two steps, because the two have different lifetimes: an installation holds no
 * connection and is costly to make, so a test installs each drawn schema once; its writers' connections are cheap to
 * reopen, so each case opens them and closes them when it ends, and a test holds at most one case's connections
 * whatever the number of schemas it draws.
 *
 * Each relation's mutability is the host's (model.ts HostRelation `mutable`), which every writer's model reads per
 * relation.
 */
export interface HistoryFamily<P> {
	readonly family: Family<P>
	readonly install: (
		p: P
	) => Effect.Effect<
		HistoryInstall<P>,
		CompileError | SqlError | TransactionRolledBack,
		Substrate | Scope.Scope
	>
	/** Opens the grizzle writers on an installation: the case's resources. */
	readonly connect: (
		install: HistoryInstall<P>
	) => Effect.Effect<HistoryEnv, OpenError | SqlError, Substrate | Scope.Scope>
}

/**
 * Why the installation does not enforce the host's laws as the host states them, or undefined. Both directions: a law of
 * the host no installed constraint reports, which the host would expect a refusal of that never comes; and a law an
 * installed table constraint reports that the host does not state, whose refusal the host could not predict.
 */
export const enforcementProblem = (host: HostSchema, names: Names): string | undefined => {
	const reported = new Set<LawId>(
		Arr.flatMap(names.model.constraints, (c) => Arr.map(c.laws, (l) => l.law))
	)
	const stated = new Set<LawId>(Arr.map(host.laws, (l) => l.law))
	const unstated = new Set<LawId>(
		Arr.flatMap(names.model.constraints, (c) =>
			c.kind === "constraint"
				? Arr.filter(
						Arr.map(c.laws, (l) => l.law),
						(law) => !stated.has(law)
					)
				: []
		)
	)
	const problems = [
		...Arr.map(
			Arr.filter(host.laws, (l) => !reported.has(l.law)),
			(l) => `the host's law ${l.law} is reported by no installed constraint`
		),
		...Arr.map(
			[...unstated],
			(law) => `the installed law ${law} is reported by a table constraint the host does not state`
		)
	]
	return problems.length === 0 ? undefined : Arr.join(problems, "; ")
}

/** The installation of the family schema drawn as `p`, with its names. */
const historyInstall = <P>(
	family: Family<P>,
	p: P
): Effect.Effect<
	HistoryInstall<P>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.map(installFamily(family, p, ordinarySession), (installed) => ({
		params: p,
		host: family.host(p),
		domains: family.domains,
		installed,
		names: namesOf(installed)
	}))

/**
 * The history environment of an installation of `schema`: `app` opened as `g` and then as `h`, each writer's actor
 * resolved right after its Db opens, as the one session of the login beside the writers opened before it.
 */
const historyEnv = <P>(
	i: HistoryInstall<P>,
	schema: AnySchema,
	relations: Readonly<Record<string, unknown>>
): Effect.Effect<HistoryEnv, OpenError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const writers = familyWriters(schema)
		const login = i.installed.as(writers.server).role
		const first = yield* openWriter({ installed: i.installed, schema })
		const g = yield* grizzleActor("g", login, [])
		const second = yield* openWriter({ installed: i.installed, schema })
		const h = yield* grizzleActor("h", login, [g.pid])
		const runtimes = { g: dbRuntime(first.db), h: dbRuntime(second.db) }
		if (runtimes.g === undefined || runtimes.h === undefined) {
			return yield* Effect.die(new Error("Db.open registered no runtime"))
		}
		return {
			host: i.host,
			domains: i.domains,
			rig: {
				installed: i.installed,
				schema,
				relations,
				runtimes: { g: runtimes.g, h: runtimes.h },
				actors: { g, h },
				direct: i.installed.world(writers.direct)
			},
			names: i.names
		}
	})

export const alternativesHistory: HistoryFamily<RunsParams> = {
	family: alternativesBox,
	install: (p) => historyInstall(alternativesBox, p),
	connect: (i) => {
		const schema = runs(i.params)(i.installed.declared)
		return historyEnv(i, schema, runsRelations(i.params))
	}
}

export const spanCoverageHistory: HistoryFamily<VisitsParams> = {
	family: spanCoverage,
	install: (p) => historyInstall(spanCoverage, p),
	connect: (i) => {
		switch (i.params.target) {
			case "rota": {
				const schema = visits(i.params)(i.installed.declared)
				return historyEnv(i, schema, { Rota, Visit })
			}
			case "roster": {
				const schema = rosterVisits(i.params)(i.installed.declared)
				return historyEnv(i, schema, { Roster, Visit })
			}
		}
	}
}

export const queueHistory: HistoryFamily<QueueParams> = {
	family: queueFamily,
	install: (p) => historyInstall(queueFamily, p),
	connect: (i) => {
		const schema = queue(i.params)(i.installed.declared)
		return historyEnv(i, schema, { Work, Wanted, Leased, Done, Seat })
	}
}

export const timekeepingHistory: HistoryFamily<TimekeepingParams> = {
	family: timekeepingFamily,
	install: (p) => historyInstall(timekeepingFamily, p),
	connect: (i) => {
		const schema = timekeeping(i.params)(i.installed.declared)
		return historyEnv(i, schema, { Employment, Timesheet, Shift })
	}
}
