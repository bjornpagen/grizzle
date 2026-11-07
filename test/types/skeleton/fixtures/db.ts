import net from "node:net"
import { type Effect, type Layer, type Option, Redacted, type Scope } from "effect"
import pgDriver from "pg"
import type { OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { ApplyOutcome, Compiled, DbConstructor, QueryResult } from "#adapter/types/db.ts"
import type { DbLayerConstructor } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type Uuid, uuid } from "#compiler/public/fields.ts"
import type { ReadsOf, WritesOf } from "#compiler/types/changeset/changeset.ts"
import type { ParamType } from "#compiler/types/core/phantom.ts"
import type { WorkloadConstructor } from "#compiler/types/db/workload.ts"
import type { Page } from "#compiler/types/page/page.ts"
import type { EvidenceOfQuery, ParamsOf, Query } from "#compiler/types/query/query.ts"
import type { Fact } from "#compiler/types/schema/relation.ts"
import { workload, Db, DbLayer, query, v } from "#index.ts"
import {
	Account,
	AccountLabel,
	byName,
	Cents,
	Clock,
	Edu,
	EpochDay,
	Instant,
	Kind,
	type Reader as ReaderRole,
	RecentSittings,
	type Refresher as RefresherRole,
	type Reporter as ReporterRole,
	Reports,
	recentSittings,
	Server,
	StudentWeekly,
	Task,
	TaskNote,
	Ticket,
	Work,
	type Writer as WriterRole
} from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/**
 * The opened database over declare-only values: Db.open of a role, readers across levels, write and refresh lists,
 * outcomes and pages ("Writes", "Connection"). Every `@ts-expect-error -- TSnnnn`
 * names the diagnostic the harness requires on the next line.
 */
type Writer = Db<typeof WriterRole, unknown>
type Reader = Db<typeof ReaderRole, unknown>
type Refresher = Db<typeof RefresherRole, unknown>
type Reporter = Db<typeof ReporterRole, unknown>

/** Db.open takes the role reached through its login, whose layer provides it with the committed snapshot. */
declare const snapshot: { readonly fingerprint: string }
/** The caller's own connect and idle timeouts. */
declare const connectTimeoutMs: number
declare const idleTimeoutMs: number
export const opened = Db.open(Server.roles.writer, {})
export type Opened = Expect<
	Equals<typeof opened, Effect.Effect<Writer, OpenError, DbLayer<typeof WriterRole>>>
>
export const layer = DbLayer.make({
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: "localhost",
		port: 5433,
		open: () => new net.Socket(),
		ca: "PEM",
		servername: "localhost"
	},
	database: "work",
	connectTimeoutMs,
	pool: { max: 10, min: 1, idleTimeoutMs },
	login: Server,
	snapshot,
	password: Redacted.make("secret")
})

export type LayerLogin = Expect<
	Equals<
		typeof layer,
		Layer.Layer<DbLayer<typeof ReaderRole> | DbLayer<typeof WriterRole>, OpenError>
	>
>

declare const writer: Writer
declare const reader: Reader
declare const refresher: Refresher
declare const reporter: Reporter
const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"
const taskId = "0193d8f2-7c1e-7000-8000-0000000000a2"
const otherTaskId = "0193d8f2-7c1e-7000-8000-0000000000a3"
const studentId = "0193d8f2-7c1e-7000-8000-0000000000a4"

/** get: a keyed lookup by primary or candidate key, or any query proved at most one row. */
export const byId = writer.get(Task, { id: taskId })
export type ById = Expect<
	Equals<typeof byId, Effect.Effect<Option.Option<Fact<typeof Task>>, ReadError>>
>
export const byAccountName = writer.get(byName, { name: "acme" })
export type ByAccountName = Expect<
	Equals<typeof byAccountName, Effect.Effect<Option.Option<Fact<typeof Account>>, ReadError>>
>

export const taskById = query(Work).rule((r) => {
	const { account } = v(Task, "task")
	return r.match(Task, { id: r.param("id", Task.fields.id), account }).find({ account })
})
export const one = writer.get(taskById, { id: taskId })
export type One = Expect<
	Equals<typeof one, Effect.Effect<Option.Option<{ readonly account: Uuid }>, ReadError>>
>

export const tasksForAccount = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
})
// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
export const many = writer.get(tasksForAccount, { account: accountId })
/** A partial binding of a composite key, and a union of keyed lookups, can each return several rows. */
export const labelsOf = query(Work).rule((r) => {
	const { label } = v(AccountLabel, "accountLabel")
	return r
		.match(AccountLabel, { account: r.param("account", AccountLabel.fields.account), label })
		.find({ label })
})
// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
export const partialKey = writer.get(labelsOf, { account: accountId })
export const labelLookup = query(Work).rule((r) => {
	const { label } = v(AccountLabel, "accountLabel")
	return r
		.match(AccountLabel, { account: r.param("account", AccountLabel.fields.account), label })
		.where(r.eq(label, r.param("label", AccountLabel.fields.label)))
		.find({ label })
})
export const fullKey = writer.get(labelLookup, { account: accountId, label: "l" })
export const eitherTask = taskById.rule((r) => {
	const { account } = v(Task, "task")
	return r.match(Task, { id: r.param("other", Task.fields.id), account }).find({ account })
})
// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
export const unionGet = writer.get(eitherTask, { id: taskId, other: otherTaskId })
// @ts-expect-error -- TS2322: the parameters are the ones the query's uses inferred
export const wrongParams = writer.execute(tasksForAccount, { account: 1 })
export const executed = writer.execute(tasksForAccount, { account: accountId })
export type Executed = Expect<
	Equals<typeof executed, Effect.Effect<QueryResult<{ readonly id: Uuid }>, ReadError>>
>

/**
 * A query over a base is a query over any extension: a reader opened over Reports runs a query over
 * Edu, and a query over another schema is refused.
 */
export const lowerLevel = reporter.execute(recentSittings, {})
export const ownLevel = reporter.execute(
	query(Reports).rule((r) => {
		const { student, sittings } = v(StudentWeekly, "studentWeekly")
		return r.match(StudentWeekly, { student, sittings }).find({ student, sittings })
	}),
	{}
)
// @ts-expect-error -- TS2345: a query over Work is not a query over Reports
export const otherSchema = reporter.execute(tasksForAccount, { account: accountId })

/**
 * The opened database's members: its workload's handles, and its operations, each one call: the three reads, compile,
 * apply, refresh and explain.
 */
export type Operations = Expect<
	Equals<
		keyof Writer,
		"workload" | "get" | "execute" | "page" | "compile" | "apply" | "refresh" | "explain"
	>
>
/** compile keeps the query's heading and parameters; a ChangeSet compiles to a handle that applies. */
export const compiled = writer.compile(tasksForAccount)
export type CompiledType = Expect<
	Equals<
		typeof compiled,
		Effect.Effect<
			Compiled<typeof WriterRole, typeof tasksForAccount, { readonly id: Uuid }>,
			CompileError,
			Scope.Scope
		>
	>
>
declare const compiledTasks: Effect.Success<typeof compiled>
export const compiledRun = compiledTasks.execute({ account: accountId })
export type CompiledRun = Expect<
	Equals<Effect.Success<typeof compiledRun>, QueryResult<{ readonly id: Uuid }>>
>
// @ts-expect-error -- TS2322: a compiled query takes the parameters its uses inferred
export const compiledWrongParams = compiledTasks.execute({ account: 1 })
// @ts-expect-error -- TS2345 refusal: page needs an ordered query
export const compiledPageUnordered = compiledTasks.page({ account: accountId }, { first: 10 })
// @ts-expect-error -- TS2345 refusal: a compiled ChangeSet applies, and a compiled query reads
export const compiledQueryApplies = compiledTasks.apply({ account: accountId })

/** Pages over ordered queries. */
export const ordered = tasksForAccount.orderBy(["id", "asc"])
export const page = writer.page(ordered, { account: accountId }, { first: 10 })
export type PageNode = Expect<
	Equals<Effect.Success<typeof page>, Page<{ readonly id: Uuid }, typeof ordered>>
>
// @ts-expect-error -- TS2345 refusal: page needs an ordered query
export const unorderedPage = writer.page(tasksForAccount, { account: accountId }, { first: 10 })

/** The apply reader: only ChangeSets within the role's write list typecheck. */
export const addTask = ChangeSet.empty(Work).insert(Task, [
	{ id: taskId, account: accountId, kind: "Manual" }
])
export const applied = writer.apply(addTask, {})
export type Applied = Expect<Equals<Effect.Success<typeof applied>, ApplyOutcome<unknown>>>
// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only relations its role's write list names
export const readerApply = reader.apply(addTask, {})
export const accountApply = writer.apply(
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only relations its role's write list names
	ChangeSet.empty(Work).put(Account, [{ id: accountId, name: "acme" }]),
	{}
)
/** Generated additions omit every serial field, or none. */
export const generated = ChangeSet.empty(Work).insert(Ticket, [
	{ account: accountId, amount: Cents(5n) }
])
export const explicit = ChangeSet.empty(Work).insert(Ticket, [
	{ id: 7n, account: accountId, amount: Cents(5n) }
])
// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
export const missing = ChangeSet.empty(Work).insert(Ticket, [{ id: 7n, account: accountId }])
export const generatedDelete = ChangeSet.empty(Work).delete(
	Ticket,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ account: accountId, amount: Cents(5n) }]
)

/** A query member contributes its parameters; read-backs arrive under their names. */
export const noteAll = ChangeSet.empty(Work)
	.insert(
		TaskNote,
		query(Work).rule((r) => {
			const { id } = v(Task, "task")
			const note: string = "todo"
			return r
				.match(Task, { id, account: r.param("account", Task.fields.account) })
				.find({ task: id, note: note })
		})
	)
	.read("added", (delta) =>
		query(Work).rule((r) => {
			const { task } = v(delta.added(TaskNote), "addedTaskNote")
			return r.match(delta.added(TaskNote), { task }).find({ task })
		})
	)
export type NoteAllParams = Expect<
	Equals<ParamsOf<typeof noteAll>, { readonly account: ParamType<Uuid, "uuid"> }>
>
export type NoteAllReads = Expect<
	Equals<ReadsOf<typeof noteAll>, { readonly added: ReadonlyArray<{ readonly task: Uuid }> }>
>
export const appliedNotes = writer.apply(noteAll, { account: accountId })
// @ts-expect-error -- TS2345: the ChangeSet's parameters are required
export const missingParams = writer.apply(noteAll, {})
export const compiledNotes = writer.compile(noteAll)
export type CompiledNotes = Expect<
	Equals<
		Effect.Success<typeof compiledNotes>,
		Compiled<
			typeof WriterRole,
			typeof noteAll,
			{ readonly added: ReadonlyArray<{ readonly task: Uuid }> }
		>
	>
>
declare const compiledNoting: Effect.Success<typeof compiledNotes>
export const compiledApply = compiledNoting.apply({ account: accountId })
// @ts-expect-error -- TS2345 refusal: a compiled ChangeSet applies, and a compiled query reads
export const compiledChangeReads = compiledNoting.execute({ account: accountId })
/** A closed relation is a roster, not a ChangeSet member. */
// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
export const writesRoster = ChangeSet.empty(Work).insert(Kind, [{ id: "Manual" }])
export const sequenced = ChangeSet.sequence(addTask, noteAll)
export type SequencedWrites = Expect<Equals<WritesOf<typeof sequenced>, "Task" | "TaskNote">>

/**
 * A ChangeSet over a base applies to a database opened on a full role over an extension; refresh takes only the refresh
 * list.
 */
export const clockTick = ChangeSet.empty(Edu).put(Clock, [{ id: "current", at: Instant(1n) }])
export const ticked = refresher.apply(clockTick, {})
/** ChangeSets over two levels combine into one over the higher, which applies like either. */
export const tickedTwice = refresher.apply(ChangeSet.union(clockTick, ChangeSet.empty(Reports)), {})
// @ts-expect-error -- TS2345 refusal: the ChangeSets' schemas are not levels of one another
export const tickedWork = refresher.apply(ChangeSet.union(clockTick, ChangeSet.empty(Work)), {})
export const refreshed = refresher.refresh(StudentWeekly, RecentSittings)
/**
 * A derived relation's inherited keys type get: a lookup by StudentWeekly's (student, week) is at most
 * one row.
 */
export const weeklyLookup = query(Reports).rule((r) => {
	const { passes } = v(StudentWeekly, "studentWeekly")
	return r
		.match(StudentWeekly, {
			student: r.param("student", uuid),
			week: r.param("week", EpochDay),
			passes
		})
		.find({ passes })
})
export const weekly = reporter.get(weeklyLookup, { student: studentId, week: EpochDay(3n) })
export type Weekly = Expect<
	Equals<typeof weekly, Effect.Effect<Option.Option<{ readonly passes: bigint }>, ReadError>>
>

/**
 * A ChangeSet or query that still needs parameters is not a bound one: a bound ChangeSet applies with no parameters,
 * and a parameterized query never passes for a parameterless one.
 */
// @ts-expect-error -- TS2345: noteAll still needs account
export const unboundApply = writer.apply(noteAll, {})
export const boundApply = writer.apply(noteAll.bind({ account: accountId }), {})
// @ts-expect-error -- TS2322: a query needing account is not a query needing nothing
export const upcast: Query<
	typeof Work,
	{ readonly id: Uuid },
	EvidenceOfQuery<typeof tasksForAccount>,
	{}
> = tasksForAccount
export const explained = writer.explain(noteAll, { account: accountId })

/** The workload names programs over the schema or any level below it. */
export const programs = workload(Reports, { recentSittings, clockTick })

/** The shipped values have the public signatures themselves: no declare-only twin stands in for them. */
export type DbIsTheConstructor = Expect<Equals<typeof Db, DbConstructor>>
export type DbLayerIsTheConstructor = Expect<Equals<typeof DbLayer, DbLayerConstructor>>
export type WorkloadIsTheConstructor = Expect<Equals<typeof workload, WorkloadConstructor>>
