/**
 * Reads through Db: workload members over the worked example's Work, served through its login's served file and run
 * through Db.open and a DbLayer, exactly as an application reads. get over keys and queries, attachments stitched
 * by parent key and the encoding refusal are the public-boundary differential's (test/pg/oracle/public), over generated
 * programs. Here, as properties:
 *
 * - a relation parameter is a set of facts, as an array or as a Stream: a repeated fact is one, an absent key matches
 *   nothing, and an input of 250,000 distinct facts, past any bound of rows, is read like a small one;
 * - a heterogeneous union over drawn facts is delivered merged on its completed order, its take the first k;
 * - a union's heading groups and an attachment's statements read one snapshot: with a commit landing between two of
 *   their statements at a drawn interleaving point (the table whose lock the read waits on), the read answers as the
 *   database stood before the commit or after it, never a mix.
 *
 * Plants: ~/.cache/grizzle-release/BR08/plants/reads-relation-input-first-fact-dropped.patch, a relation input
 * normalized without its first fact, must turn the first property red;
 * ~/.cache/grizzle-release/BR08/plants/reads-union-merge-reversed.patch, the heading groups merged on their order
 * reversed, the second; ~/.cache/grizzle-release/BR08/plants/reads-read-only-at-read-committed.patch, every read begun
 * READ COMMITTED, the third.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Fiber,
	Formatter,
	Layer,
	Option,
	Order,
	pipe,
	Record as Rec,
	Stream,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { indices } from "#compiler/core/array.ts"
import { isRecord } from "#compiler/core/record.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { readOnce, rowsOf } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { isList } from "#test/support/list.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A delivered value with its carriers kept and Options spelled out, comparable by deepStrictEqual. */
const plain = (value: unknown): unknown => {
	if (Option.isOption(value)) {
		return Option.isSome(value) ? { some: plain(value.value) } : "none"
	}
	if (isList(value)) {
		return Arr.map(value, plain)
	}
	if (typeof value === "object" && value !== null && !(Symbol.iterator in value)) {
		const out: Record<string, unknown> = {}
		for (const [k, v2] of Rec.toEntries(value)) {
			out[k] = plain(v2)
		}
		return out
	}
	return value
}

const uuidAt = (group: number, n: number): Uuid =>
	`00000000-0000-4000-${(0x9000 + group).toString(16)}-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The id of a delivered row, every row here being a record with one. */
const idOf = (row: unknown): string => {
	if (!isRecord(row) || typeof row["id"] !== "string") {
		return assert.fail("a row with an id")
	}
	return row["id"]
}

/** The Work tables in delete order: what hangs on a task first, accounts last. */
const workTables = [W.TaskNote, W.AutomaticTask, W.ManualTask, W.Task, W.Account] as const

/**
 * Facts of Work a case draws: up to four accounts, tasks over them, each automatic with a budget or manual with an
 * operator, some with a note.
 */
interface TaskSketch {
	readonly account: number
	readonly automatic: boolean
	readonly budget: number
	readonly operator: number
	readonly note: boolean
}

const taskSketchGen: Gen<TaskSketch> = (source) => ({
	account: source.draw(pickGen),
	automatic: source.draw(boolean),
	budget: source.draw(int(0, 3)),
	operator: source.draw(int(0, 2)),
	note: source.draw(boolean)
})

const operators = ["Ruth", "Sam", "Uma"] as const

type WorkFacts = {
	readonly Account: ReadonlyArray<{ readonly id: string; readonly name: string }>
	readonly Task: ReadonlyArray<{
		readonly id: string
		readonly account: string
		readonly kind: "Automatic" | "Manual"
	}>
	readonly AutomaticTask: ReadonlyArray<{ readonly task: string; readonly budget: bigint }>
	readonly ManualTask: ReadonlyArray<{ readonly task: string; readonly operator: string }>
	readonly TaskNote: ReadonlyArray<{ readonly task: string; readonly note: string }>
}

/** The facts of `accounts` accounts and the sketched tasks, their ids under `group` so two cases never share one. */
const workFactsOf = (
	group: number,
	accounts: number,
	tasks: ReadonlyArray<TaskSketch>
): WorkFacts => {
	const accountIds = Arr.map(indices(accounts), (n) => uuidAt(group, n))
	const placed = Arr.map(tasks, (x, n) => ({
		...x,
		id: uuidAt(group, 0x100 + n),
		account: defined(accountIds[pickIndex(x.account, accountIds.length)])
	}))
	return {
		Account: Arr.map(accountIds, (id, n) => ({ id, name: `account ${n}` })),
		Task: Arr.map(placed, (x) => ({
			id: x.id,
			account: x.account,
			kind: x.automatic ? "Automatic" : "Manual"
		})),
		AutomaticTask: Arr.flatMap(placed, (x) =>
			x.automatic ? [{ task: x.id, budget: BigInt(500 * x.budget) }] : []
		),
		ManualTask: Arr.flatMap(placed, (x) =>
			x.automatic ? [] : [{ task: x.id, operator: defined(operators[x.operator]) }]
		),
		TaskNote: Arr.flatMap(placed, (x) =>
			x.note ? [{ task: x.id, note: `note of ${Str.slice(-4)(x.id)}` }] : []
		)
	}
}

/** The union's rows over facts, as the host reads its definition: each task with its account, kind and payload. */
const payloadRows = (f: WorkFacts): ReadonlyArray<Readonly<Record<string, unknown>>> =>
	Arr.flatMap(f.Task, (x): ReadonlyArray<Readonly<Record<string, unknown>>> => {
		if (x.kind === "Automatic") {
			return Option.toArray(
				Option.map(
					Arr.findFirst(f.AutomaticTask, (p) => p.task === x.id),
					(a) => ({
						id: x.id,
						account: x.account,
						kind: x.kind,
						budget: a.budget
					})
				)
			)
		}
		return Option.toArray(
			Option.map(
				Arr.findFirst(f.ManualTask, (p) => p.task === x.id),
				(m) => ({
					id: x.id,
					account: x.account,
					kind: x.kind,
					operator: m.operator
				})
			)
		)
	})

/**
 * Each account with its tasks attached in id order, and each task with its note attached: an attachment with an
 * attachment of its own stays pipelined, so the tasks statement reads the delivered account keys and the notes are
 * stitched onto the tasks.
 */
const accountTaskNotes = query(W.Work)
	.rule((r) => {
		const { id, name } = v(W.Account, "account")
		return r.match(W.Account, { id, name }).find({ id, name })
	})
	.attach(
		"tasks",
		(a) =>
			query(W.Work)
				.rule((r) => {
					const { id, kind } = v(W.Task, "task")
					return r.match(W.Task, { id, account: a.id, kind }).find({ id, kind })
				})
				.attach(
					"note",
					(t) =>
						query(W.Work).rule((r) => {
							const { note } = v(W.TaskNote, "taskNote")
							return r.match(W.TaskNote, { task: t.id, note }).find({ note })
						}),
					"option"
				)
				.orderBy(["id", "asc"]),
		"array"
	)

type RelationFeature =
	| "an array"
	| "a Stream"
	| "a repeated fact"
	| "an absent key"
	| "no fact"
	| "a large input"

/** A large input's distinct facts: past the 100,000 rows a relation input once was bounded by. */
const largeInput = 250_000

interface RelationCase {
	/** The distinct facts: a large input's, or a small number. */
	readonly size: { readonly kind: "large" } | { readonly kind: "small"; readonly n: number }
	/** How many of the distinct facts are stored tasks' keys, by pick, and the repeats added. */
	readonly present: number
	readonly repeats: number
	readonly stream: boolean
}

/** A large input is a read of largeInput facts, so it is drawn one case in six. */
const relationCaseGen: Gen<RelationCase> = (source) => ({
	size: source.draw(
		weighted<RelationCase["size"]>([
			[1, constant({ kind: "large" })],
			[5, map(int(0, 6), (n) => ({ kind: "small", n }))]
		])
	),
	present: source.draw(pickGen),
	repeats: source.draw(int(0, 3)),
	stream: source.draw(boolean)
})

type UnionFeature =
	| "ascending"
	| "descending"
	| "a take"
	| "no take"
	| "an empty group"
	| "a take past the union"

type SnapshotRead = "union" | "attachment"

type SnapshotFeature =
	| `${SnapshotRead} waiting on ${string}`
	| "read the state before the commit"
	| "read the state after the commit"

/** The tables a read's statements read, each of which a holder may lock. */
const lockable = {
	union: [W.Task, W.AutomaticTask, W.ManualTask],
	attachment: [W.Account, W.Task, W.TaskNote]
} as const

/** A read waiting on a holder's lock of one of the tables its statements read. */
interface Wait {
	readonly read: SnapshotRead
	readonly table: (typeof lockable)[SnapshotRead][number]
}

/** Every read waiting on every table it reads. */
const waits: Arr.NonEmptyReadonlyArray<Wait> = Arr.flatMap(
	["union", "attachment"] as const,
	(read) => Arr.map(lockable[read], (table): Wait => ({ read, table }))
)

/** What a wait reaches. */
const waitingOn = (wait: Wait): SnapshotFeature => `${wait.read} waiting on ${wait.table.name}`

/**
 * The waits a case draws its own from: where the case steers, those whose feature the run had not reached when the
 * case's window began, so the floor stream draws each wait while it is pending rather than leaving it to its share of
 * chance; every wait once none is pending, and where the case may not steer, so the rotating stream's waits are plain
 * draws.
 */
const waitsFor = (steering: Case<SnapshotFeature>["steering"]): Arr.NonEmptyReadonlyArray<Wait> =>
	Option.match(steering, {
		onNone: () => waits,
		onSome: (pending) =>
			Arr.match(
				Arr.filter(waits, (wait) => pending.has(waitingOn(wait))),
				{ onEmpty: () => waits, onNonEmpty: (open) => open }
			)
	})

/** A snapshot case: whether the commit deletes. Its wait is the case's own draw (waitsFor). */
interface SnapshotCase {
	readonly deletes: boolean
}

/**
 * The commit: a new account with an automatic and a manual task, one noted, and a stored task of each kind deleted,
 * so each statement's answer changes.
 */
const snapshotCaseGen: Gen<SnapshotCase> = (source) => ({
	deletes: source.draw(boolean)
})

/** A union's case: its facts, its order and its take. */
interface UnionCase {
	readonly accounts: number
	readonly tasks: ReadonlyArray<TaskSketch>
	readonly descending: boolean
	readonly take: { readonly kind: "none" } | { readonly kind: "take"; readonly k: number }
}

/** The largest take a union case draws. */
const takeMax = 14

/** The member a union case reads: the union ordered by id in its direction, with its take or none. */
const unionMember = (c: Pick<UnionCase, "descending" | "take">): string =>
	`${c.descending ? "desc" : "asc"}${c.take.kind === "none" ? "" : String(c.take.k)}`

/**
 * Every member a union case reads, served at once: the union ordered by id ascending and descending, each with no take
 * and with every take a case draws.
 */
const unionMembers: Readonly<Record<string, unknown>> = Rec.fromEntries(
	Arr.flatMap([false, true], (descending) => {
		const ordered = W.taskPayloads.orderBy(["id", descending ? "desc" : "asc"])
		return [
			[unionMember({ descending, take: { kind: "none" } }), ordered] as const,
			...Arr.map(
				indices(takeMax),
				(n) =>
					[
						unionMember({ descending, take: { kind: "take", k: n + 1 } }),
						ordered.take(n + 1)
					] as const
			)
		]
	})
)

const unionCaseGen: Gen<UnionCase> = (source) => ({
	accounts: source.draw(int(1, 4)),
	tasks: source.draw(array(taskSketchGen, { min: 0, max: 12 })),
	descending: source.draw(boolean),
	take: source.draw(
		oneOf<UnionCase["take"]>([
			constant({ kind: "none" }),
			map(int(1, takeMax), (k) => ({ kind: "take", k }))
		])
	)
})

/** Each search's budget beside its suite, draw and features. */
const budget = {
	literal: Formatter.format,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/** Payload rows by their id's text. */
const byIdText: Order.Order<Readonly<Record<string, unknown>>> = Order.mapInput(
	Order.String,
	(r: Readonly<Record<string, unknown>>) => String(r["id"])
)

/** Rows by their id. */
const byId: Order.Order<unknown> = Order.mapInput(Order.String, idOf)

layer(Substrate.layer)("reads through Db", (it) => {
	it.effect(
		"a relation parameter is a set of facts as an array or a Stream, of any number of facts",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(W.Work, workFacts, {
						label: "real",
						extensions: [],
						programs: { tasksById: W.tasksById }
					})
					const sessions = yield* Layer.build(opened.served.layer)
					const db = yield* Db.open(opened.served.login.roles.app, {}).pipe(
						Effect.provideContext(sessions)
					)
					const stored = workFacts.Task
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "a relation parameter as a set: the stored tasks its distinct keys name, whatever repeats or absent keys it holds"
							},
							...budget,
							suite: "reads/relation parameters",
							draw: drawn(relationCaseGen),
							kept: [],
							runs: 60,
							coverage: required<RelationFeature>(
								[
									"an array",
									"a Stream",
									"a repeated fact",
									"an absent key",
									"no fact",
									"a large input"
								],
								{ cases: 60, sense: notesOnly }
							)
						},
						(c, notes) =>
							Effect.gen(function* () {
								const distinct = c.size.kind === "small" ? c.size.n : largeInput
								/**
								 * The distinct keys: some of the stored tasks', the rest absent; then repeats of the first.
								 */
								const present = Math.min(distinct, pickIndex(c.present, stored.length + 1))
								const keys = Arr.map(indices(distinct), (n) =>
									n < present ? defined(stored[n]).id : uuidAt(0xff, n)
								)
								const facts = Arr.map(
									[
										...keys,
										...Array.from({ length: keys.length === 0 ? 0 : c.repeats }, () =>
											defined(keys[0])
										)
									],
									(id) => ({ id })
								)
								const outcome = yield* Effect.result(
									rowsOf(
										db.workload.tasksById.once({
											params: {
												ids: c.stream ? Stream.fromIterable(facts) : facts
											},
											facts: {}
										})
									)
								)
								unorderedEqual(
									Arr.map(succeeded(outcome, `${distinct} facts read`), plain),
									Arr.map(
										Arr.filter(stored, (x) => keys.includes(x.id)),
										(x) => ({ id: x.id, kind: x.kind })
									)
								)
								if (distinct === largeInput) {
									notes.note("a large input")
								}
								notes.note(c.stream ? "a Stream" : "an array")
								if (facts.length > distinct) {
									notes.note("a repeated fact")
								}
								if (distinct > present) {
									notes.note("an absent key")
								}
								if (distinct === 0) {
									notes.note("no fact")
								}
							})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"a heterogeneous union over drawn facts is delivered merged on its completed order, its take the first k",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(
						W.Work,
						{},
						{ label: "real", extensions: [], programs: {} }
					)
					return yield* withServedDb(opened.installed, opened.server.roles.app, {}, ({ serve }) =>
						Effect.gen(function* () {
							const unions = yield* serve(unionMembers)
							let group = 0
							return yield* explore(
								{
									oracle: {
										kind: "specification",
										name: "the union's rows sorted on its completed order, the first k of them under a take"
									},
									...budget,
									/** The case's facts replace the last case's whole (substrate/replace.ts). */
									suite: "reads/union",
									draw: drawn(unionCaseGen),
									kept: [],
									runs: 60,
									coverage: required<UnionFeature>(
										[
											"ascending",
											"descending",
											"a take",
											"no take",
											"an empty group",
											"a take past the union"
										],
										{ cases: 60, sense: notesOnly }
									)
								},
								(c, notes) =>
									Effect.gen(function* () {
										const facts = workFactsOf(group++, c.accounts, c.tasks)
										yield* replace(opened.installed, facts)
										const rows = payloadRows(facts)
										const sorted = Arr.sort(rows, c.descending ? Order.flip(byIdText) : byIdText)
										const got = yield* readOnce(member(unions, unionMember(c)))({
											params: {},
											facts: {}
										})
										if (c.take.kind === "none") {
											assert.deepEqual(Arr.map(got, plain), sorted)
										} else {
											assert.deepEqual(Arr.map(got, plain), sorted.slice(0, c.take.k))
											if (c.take.k > rows.length) {
												notes.note("a take past the union")
											}
										}
										notes.note(c.descending ? "descending" : "ascending")
										notes.note(c.take.kind === "none" ? "no take" : "a take")
										if (facts.AutomaticTask.length === 0 || facts.ManualTask.length === 0) {
											notes.note("an empty group")
										}
									})
							)
						})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"a union's heading groups and an attachment's statements read one snapshot wherever a commit lands between them",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const opened = yield* installed(W.Work, workFacts, {
						label: "real",
						extensions: [],
						programs: { taskPayloads: W.taskPayloads, accountTaskNotes }
					})
					const names = namesOf(opened.installed)
					/** Kind's codes: a closed id is stored as its handle's code. */
					const kinds = defined(
						opened.installed.names.codes.rosters.get(parsedName("Kind")),
						"the codes of Kind"
					)
					/**
					 * The Db's sessions log in as the login's role, which pg_stat_activity reports whatever role a
					 * transaction enters.
					 */
					const role = opened.installed.as(opened.server).role
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(opened.served.login.roles.app, {})
						const reads = {
							union: rowsOf(db.workload.taskPayloads.once({ params: {}, facts: {} })),
							attachment: rowsOf(db.workload.accountTaskNotes.once({ params: {}, facts: {} }))
						}
						/** A read's answer, its rows in id order where the query leaves the order open. */
						const answer = (rows: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
							Arr.map(Arr.sort(rows, byId), plain)
						let group = 0
						return yield* explore(
							{
								oracle: {
									kind: "specification",
									name: "the read's answer is the database before the commit or after it, each read alone, never a mix"
								},
								...budget,
								/**
								 * The read's backend waits on the holder's lock (the substrate's lock-wait barrier).
								 */
								suite: "reads/snapshot",
								draw: drawn(snapshotCaseGen),
								kept: [],
								runs: 24,
								/**
								 * One case a window, so each floor case steers by what the floor cases before it reached: the
								 * floor's six cases (a quarter of the runs) draw the six waits one each, on every seed.
								 */
								steerEvery: 1,
								coverage: required<SnapshotFeature>(
									[...Arr.map(waits, waitingOn), "read the state before the commit"],
									{ cases: 24, sense: notesOnly }
								)
							},
							(c, notes) =>
								Effect.gen(function* () {
									const wait = notes.steering.pipe(waitsFor, element, notes.draw)
									const preRead = yield* reads[wait.read]
									const pre = answer(preRead)
									const g = group++
									const account = uuidAt(0x40 + g, 0)
									const automatic = uuidAt(0x40 + g, 1)
									const manual = uuidAt(0x40 + g, 2)
									const holder = yield* s.session({ ...ownerSession(), label: "holder" })
									yield* holder.begin
									yield* holder.query(
										`LOCK TABLE ${names.table(wait.table)} IN ACCESS EXCLUSIVE MODE`,
										[]
									)
									const reading = yield* Effect.forkChild(reads[wait.read], {
										startImmediately: true
									})
									const pid = holder.pid
									yield* s.awaitBlockedBy(pid, role)
									/**
									 * The newest tasks of the previous case, if any, leave with what hangs on them.
									 */
									const n = (relation: (typeof workTables)[number]) => names.table(relation)
									yield* holder.query(
										`INSERT INTO ${n(W.Account)} (${names.column(W.Account, "id")}, ${names.column(W.Account, "name")}) VALUES ($1::uuid, $2::text)`,
										[account, `committed ${g}`]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ($1::uuid, $3::uuid, $4::smallint), ($2::uuid, $3::uuid, $5::smallint)`,
										[
											automatic,
											manual,
											account,
											String(codeOf(kinds, "Automatic")),
											String(codeOf(kinds, "Manual"))
										]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.AutomaticTask)} (${names.column(W.AutomaticTask, "task")}, ${names.column(W.AutomaticTask, "budget")}) VALUES ($1::uuid, 100)`,
										[automatic]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.ManualTask)} (${names.column(W.ManualTask, "task")}, ${names.column(W.ManualTask, "operator")}) VALUES ($1::uuid, 'Uma')`,
										[manual]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.TaskNote)} (${names.column(W.TaskNote, "task")}, ${names.column(W.TaskNote, "note")}) VALUES ($1::uuid, 'committed')`,
										[manual]
									)
									if (c.deletes) {
										/** The previous case's automatic and manual task, each with what hangs on it. */
										const gone = [uuidAt(0x40 + g - 1, 1), uuidAt(0x40 + g - 1, 2)]
										const deleteGone = (
											table: typeof W.TaskNote | typeof W.AutomaticTask | typeof W.ManualTask
										) =>
											holder.query(
												`DELETE FROM ${names.table(table)} WHERE ${names.column(table, "task")} IN ($1::uuid, $2::uuid)`,
												gone
											)
										yield* deleteGone(W.TaskNote)
										yield* deleteGone(W.AutomaticTask)
										yield* deleteGone(W.ManualTask)
										yield* holder.query(
											`DELETE FROM ${names.table(W.Task)} WHERE ${names.column(W.Task, "id")} IN ($1::uuid, $2::uuid)`,
											gone
										)
									}
									yield* holder.commit
									const joined = yield* Fiber.join(reading)
									const got = answer(joined)
									const postRead = yield* reads[wait.read]
									const post = answer(postRead)
									assert.notDeepEqual(pre, post, "the commit changes the answer")
									const state = Option.isNone(exactValue(got, pre))
										? "read the state before the commit"
										: Option.isNone(exactValue(got, post))
											? "read the state after the commit"
											: "a mix"
									if (state === "a mix") {
										return assert.fail(
											`${waitingOn(wait)} read neither the state before the commit nor the one after it`
										)
									}
									notes.note(waitingOn(wait))
									notes.note(state)
								}).pipe(Effect.scoped)
						)
					}).pipe(Effect.scoped, withLayer(opened.served.layer))
				}).pipe(Effect.scoped)
			)
	)
})
