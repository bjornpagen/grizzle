/** What the properties of round-trips.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import type { ServedLogin } from "#adapter/types/layer.ts"
import type { Anchor, KeyedList, RowKey } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyLogin,
	derived,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { deferrable, paged } from "#compiler/public/workload.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, t4, t5 } from "#test/support/fixtures/golden/work.ts"
import { type Installed, installedTemplate } from "#test/support/install-migrate.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { pickGen } from "#test/support/pick.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	frameOf,
	makeTap,
	type Tap,
	type TransactionFrame,
	type WireWindow
} from "#test/support/wire-tap.ts"
import { testVerify } from "#test/support/worlds.ts"

/** A transaction the contract fixes: SERIALIZABLE, read-only or not, DEFERRABLE or not, and how it ends. */
export const serializable = (
	access: "read only" | "read write",
	deferrable: boolean,
	end: "commit" | "rollback"
): TransactionFrame => ({ kind: "framed", isolation: "SERIALIZABLE", access, deferrable, end })

/** A read's transaction: SERIALIZABLE READ ONLY, not deferrable, committed. */
export const readFrame = serializable("read only", false, "commit")

/** A write's or a refresh's transaction: SERIALIZABLE, committed. */
export const writeFrame = serializable("read write", false, "commit")

/** The traffic of `effect`, and its value. */
export const observe = <A, E, R>(tap: Tap, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const mark = tap.mark()
		const value = yield* effect
		return { value, window: tap.since(mark) }
	})

/** `window` is one round trip, one transaction of `frame`, and leaves its session idle. */
export const assertFlight = (label: string, window: WireWindow, frame: TransactionFrame) => {
	assert.equal(window.roundTrips, 1, `${label}: round trips`)
	assert.deepEqual(frameOf(window), frame, `${label}: its transaction`)
	assert.deepEqual(window.backend.at(-1), { type: "Z", status: "I" }, `${label}: ends idle`)
}

/** A derived relation over one base relation, the role that refreshes it, and its login. */
export const derivedFixture = (name: string) => {
	const Sitting = relation("Sitting", { id: uuid, student: uuid, week: pg.integer }, ["id"])
	const Edu = schema(name, [Sitting], [])
	const StudentWeekly = derived.materialized(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week } = v(Sitting, "sitting")
			return r.match(Sitting, { id, student, week }).find({ student, week, sittings: r.count() })
		})
	)
	const Reports = schema.extend(Edu, `${name}_1`, [StudentWeekly], [])
	const refresher = role(Reports, "refresher", wholeEntriesOf(Reports), {
		refresh: ["StudentWeekly"]
	})
	return { StudentWeekly, Reports, refresher, server: login(Reports, "server", [refresher]) }
}

/**
 * The layer of `login`, served over `installed` as servedFixture serves it, its pool one session of `credentials`
 * whose every byte passes through `tap`.
 */
export const tappedLayer = <L extends AnyLogin>(
	installed: Installed,
	credentials: Credentials,
	login: ServedLogin<L>,
	tap: Tap
) =>
	sourcedDbLayer(installed, {
		...clusterConnection(installed.cluster, installed.database, credentials.password),
		transport: tap.transport,
		pool: { ...clusterPool, min: 1, max: 1 },
		login,
		verify: testVerify
	})

/** A window's anchor in its direction: the start or the end, or after or before a key an earlier window delivered. */
export const anchorOf = (key: Option.Option<RowKey>, forward: boolean): Anchor =>
	Option.match(key, {
		onNone: (): Anchor => (forward ? { kind: "start" } : { kind: "end" }),
		onSome: (at): Anchor => (forward ? { kind: "after", key: at } : { kind: "before", key: at })
	})

/** The keys of a window's rows, in order: what a later window is anchored after or before. */
export const keysOf = <Row extends object>(window: KeyedList<Row>): ReadonlyArray<RowKey> =>
	Arr.map([...window.entries()], (entry) => entry.key)

const readCallKinds = ["read", "key", "explain", "page"] as const

/**
 * What a read call met: a read of one part or of several, each one statement (lower/shapes/index.ts PartedStatement),
 * a window from the start or the end, or anchored at a key an earlier window delivered, and each call kind of a
 * deferrable member.
 */
export type ReadCallFeature =
	| `${"read" | "explain"} ${"one part" | "several parts"}`
	| "key one part"
	| `page ${"from an end" | "from a key"}`
	| `deferrable ${(typeof readCallKinds)[number]}`

/**
 * A drawn read call: its kind, whether its member is deferrable(...), the query it reads (a page's ordered query), a
 * present or absent key, a window's direction, size and anchor among the keys earlier windows delivered.
 */
export const readCallsGen = array(
	(source) => ({
		kind: source.draw(element(readCallKinds)),
		deferrable: source.draw(boolean),
		query: source.draw(
			element([
				"one relation",
				"heading groups",
				"fused attachments",
				"a pipelined attachment"
			] as const)
		),
		page: source.draw(element(["budgets", "noted"] as const)),
		present: source.draw(boolean),
		forward: source.draw(boolean),
		size: source.draw(int(1, 4)),
		anchor: source.draw(pickGen)
	}),
	{ min: 1, max: 6 }
)

export const firstCallKinds = ["key", "read", "write"] as const

export type FirstCallFeature = (typeof firstCallKinds)[number] | "several Dbs opened"

/** Dbs opened in one request and the first call one of them makes. */
interface FirstCall {
	readonly opens: number
	readonly caller: number
	readonly call: (typeof firstCallKinds)[number]
	readonly present: boolean
}

/**
 * One to three Dbs opened in one request, and the first call one of them makes: a key's once of a present or absent
 * key, a read's once, or a write's once with nothing to write, which sends its transaction all the same.
 */
export const firstCallsGen: Gen<FirstCall> = (source) => ({
	opens: source.draw(int(1, 3)),
	caller: source.draw(pickGen),
	call: source.draw(element(firstCallKinds)),
	present: source.draw(boolean)
})

/** Up to three notes, each at a task none of the others is at, of a drawn text. */
const notesGen: Gen<ReadonlyArray<{ readonly task: number; readonly text: number }>> = (source) =>
	Arr.map(source.draw(shuffled([0, 1, 2], { min: 0, max: 3 })), (task) => ({
		task,
		text: source.draw(int(0, 2))
	}))

export type WriteCallFeature = "once" | "explain" | "a read-back that attaches" | "nothing to write"

/**
 * A drawn write call: notes inserted, put or deleted, none among them (a call with nothing to write, which still sends
 * its transaction), with or without a read-back, written once or explained.
 */
export const writeCallsGen = array(
	(source) => ({
		kind: source.draw(element(["once", "explain"] as const)),
		op: source.draw(element(["insert", "put", "delete"] as const)),
		notes: source.draw(notesGen),
		readBack: source.draw(boolean)
	}),
	{ min: 1, max: 4 }
)

export type RefreshFeature = "a refresh of an unpopulated view" | "a refresh of a populated view"

/**
 * A drawn program of refreshes, each run on the view as the last left it, populated by the migration that created it
 * or by the last refresh, or emptied first, `WITH NO DATA`, the unpopulated state a view created before migrations
 * populated what they create holds until its first refresh.
 */
export const refreshesGen = array(boolean, { min: 1, max: 4 })

/**
 * The reads the first suite calls, over `s`: a plain read, a heterogeneous union, fused and pipelined attachments, a
 * relation's key, and two ordered pages, one with an attachment, each also as its deferrable(...) member: the full
 * world's served workload.
 */
const roundTripReads = (s: W.WorkNamed<string>) => {
	const reads = W.workReads(s)
	const payloads = query(s)
		.rule((r) => {
			const { id, account } = v(W.Task, "task")
			const { budget } = v(W.AutomaticTask, "automaticTask")
			return r
				.match(W.Task, { id, account, kind: "Automatic" })
				.match(W.AutomaticTask, { task: id, budget })
				.find({ id, account, kind: W.Kind.handle("Automatic"), budget })
		})
		.rule((r) => {
			const { id, account } = v(W.Task, "task")
			const { operator } = v(W.ManualTask, "manualTask")
			return r
				.match(W.Task, { id, account, kind: "Manual" })
				.match(W.ManualTask, { task: id, operator })
				.find({ id, account, kind: W.Kind.handle("Manual"), operator })
		})
	/** An attachment whose child has an attachment of its own stays pipelined. */
	const accountTaskNotes = query(s)
		.rule((r) => {
			const { id, name } = v(W.Account, "account")
			return r.match(W.Account, { id, name }).find({ id, name })
		})
		.attach(
			"tasks",
			(a) =>
				query(s)
					.rule((r) => {
						const { id, kind } = v(W.Task, "task")
						return r.match(W.Task, { id, account: a.id, kind }).find({ id, kind })
					})
					.attach(
						"note",
						(t) =>
							query(s).rule((r) => {
								const { note } = v(W.TaskNote, "taskNote")
								return r.match(W.TaskNote, { task: t.id, note }).find({ note })
							}),
						"option"
					),
			"array"
		)
	/** Ordered pages: one of one part, and one whose attachment is a part over the page it holds. */
	const budgets = query(s)
		.rule((r) => {
			const { id } = v(W.Task, "task")
			const { budget } = v(W.AutomaticTask, "automaticTask")
			return r
				.match(W.Task, {
					id,
					account: r.param("account", W.Task.fields.account),
					kind: "Automatic"
				})
				.match(W.AutomaticTask, { task: id, budget })
				.find({ id, budget })
		})
		.orderBy(["budget", "desc"], ["id", "asc"])
	const noted = query(s)
		.rule((r) => {
			const { id } = v(W.Task, "task")
			return r
				.match(W.Task, { id, account: r.param("account", W.Task.fields.account) })
				.find({ id })
		})
		.attach(
			"notes",
			(t) =>
				query(s).rule((r) => {
					const { note } = v(W.TaskNote, "taskNote")
					return r.match(W.TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
		.orderBy(["id", "asc"])
	return {
		oneRelation: reads.automaticTasksFor,
		headingGroups: payloads,
		fusedAttachments: reads.taskCards,
		pipelinedAttachment: accountTaskNotes,
		task: W.Task,
		budgets: paged(budgets),
		noted: paged(noted),
		deferredOneRelation: deferrable(reads.automaticTasksFor),
		deferredHeadingGroups: deferrable(payloads),
		deferredFusedAttachments: deferrable(reads.taskCards),
		deferredPipelinedAttachment: deferrable(accountTaskNotes),
		deferredTask: deferrable(W.Task),
		deferredBudgets: deferrable(paged(budgets)),
		deferredNoted: deferrable(paged(noted))
	}
}

/**
 * A tapped pool of one session for `credentials`, warmed, which a served Db's members run on.
 *
 * The session's startup, outside every window.
 */
export const tappedPool = (credentials: Credentials) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const tap = makeTap(substrate.cluster)
		const pool = yield* poolFor(credentials, {
			...defaultPool,
			transport: { kind: "given", transport: tap.transport },
			pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: 1 }
		})
		yield* Effect.scoped(
			Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
		)
		return { pool, tap }
	})

export const tasks = [t1, t4, t5] as const

/** What the read property installs: Work, its workload holding the round trips' reads. */
export const readsInstall = { label: "real", programs: roundTripReads(W.Work) } as const

/** Work with the round trips' reads installed once per member (reads/support.ts fixtureTemplate). */
export const readsTemplate = fixtureTemplate(import.meta, W.Work, readsInstall)

/** What the fresh-Db property installs: Work, its workload holding a key read, a read and an empty ChangeSet. */
export const freshDbInstall = {
	label: "real",
	programs: {
		task: W.Task,
		tasksFor: W.workReads(W.Work).automaticTasksFor,
		nothing: ChangeSet.empty(W.Work)
	}
} as const

/** Work with the fresh-Db property's members installed once per member (reads/support.ts fixtureTemplate). */
export const freshDbTemplate = fixtureTemplate(import.meta, W.Work, freshDbInstall)

/**
 * The derived fixture's Reports installed once per member with its server login (install-migrate.ts
 * installedTemplate), each refresh case on a fresh clone of it, since it refreshes the view and reads whether it is
 * populated.
 */
export const tripsTemplate = installedTemplate({
	declaredIn: import.meta,
	name: "trips",
	schema: derivedFixture("Edu").Reports,
	options: {
		ambient: ordinarySession,
		extensions: [],
		label: "trips",
		logins: [derivedFixture("Edu").server]
	}
})
