import { Array as Arr, Effect, Option, Predicate, Record as Rec, Result } from "effect"
import type { Pool } from "pg"
import { type DbRuntime, dbRuntime } from "#adapter/db/db.ts"
import { type ReadError } from "#adapter/errors/execution.ts"
import type { Db } from "#adapter/public/db.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import { type CompileError, type CursorError, isCompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { changeSetOver, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { artifactsAgree } from "#test/support/worlds/execute/artifacts.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"
import { headDomains } from "#test/support/worlds/execute/describe.ts"
import { carrierOf, factOfRow } from "#test/support/worlds/execute/host.ts"
import { errorStory, errorTexts, type Found } from "#test/support/worlds/execute/leak.ts"
import { applied, applyFailed, readFailed } from "#test/support/worlds/execute/observe.ts"
import { attempt, type RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import { textDomain } from "#test/support/worlds/model/text.ts"
import type {
	BaseSpec,
	DerivedSpec,
	EntryOp,
	FieldDomain,
	HostFact,
	Observation,
	ReadBack,
	ReadVia,
	RoleSpec,
	HostValue
} from "#test/support/worlds/model/types.ts"

/** What an action did, with every text of the refusal behind it, for the leak scan. */
export interface Seen {
	readonly observation: Observation
	readonly found: ReadonlyArray<Found>
	/** What a report tells of the error behind the observation (leak.ts errorStory), none for an outcome no error carried. */
	readonly told: ReadonlyArray<string>
}

export const seen = (observation: Observation): Seen => ({ observation, found: [], told: [] })

export const refusedWith = (observation: Observation, error: unknown): Seen => ({
	observation,
	found: errorTexts(error),
	told: errorStory(error)
})

/**
 * A Db's session: its login and role, the base of the version it was opened at, whose snapshot it holds, with that
 * version's described laws, which its refusals' laws are read back by, and the pool of that version's layer, which
 * serves it after a migration made another version current.
 */
export interface DbSession {
	readonly kind: "db"
	readonly login: string
	readonly role: RoleSpec
	readonly base: BaseSpec
	readonly described: ReadonlyMap<LawId, Law>
	readonly pool: Pool
	readonly value: BuiltRole
	readonly db: Db<BuiltRole, unknown>
}

const runtimeOf = (db: Db<BuiltRole, unknown>): Effect.Effect<DbRuntime> => {
	const runtime = dbRuntime(db)
	return runtime === undefined
		? Effect.die(new Error("a Db session holds no Db value"))
		: Effect.succeed(runtime)
}

/** The fields of a role relation, each with its domain: a whole entry's relation's, a query entry's head. */
export const entryFields = (
	base: BaseSpec,
	role: RoleSpec,
	relation: string
): Option.Option<ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>> =>
	Option.flatMap(Rec.get(role.entries, relation), (entry) => {
		if (entry.kind === "query") {
			const domains = headDomains(base, entry.rules)
			return Option.some(
				Arr.map(Rec.toEntries(domains), ([field, domain]) => ({
					field,
					domain: Option.getOrElse(domain, () => literalDomain)
				}))
			)
		}
		const ofRelation = Option.map(
			Option.fromUndefinedOr(relationSpecOf(base, entry.relation)),
			(spec) => Arr.map(spec.fields, (f) => ({ field: f.name, domain: f.domain }))
		)
		const ofRoster = Option.map(
			Arr.findFirst(base.closed, (c) => c.name === entry.relation),
			(roster): ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }> => [
				{ field: "id", domain: { kind: "handle", closed: roster.name, members: roster.members } }
			]
		)
		const ofDerived = Option.map(
			Arr.findFirst(base.derived, (d) => d.name === entry.relation),
			(d) => derivedFields(base, d)
		)
		return Option.orElse(ofRelation, () => Option.orElse(ofRoster, () => ofDerived))
	})

/** The domain a head literal reads as: PostgreSQL types an untyped literal as text. */
const literalDomain: FieldDomain = textDomain("^.*$", "su")

/** A derived relation's columns, each with its domain: its rules' head fields as the model types them. */
export const derivedFields = (
	base: BaseSpec,
	derived: DerivedSpec
): ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }> =>
	Arr.map(Rec.toEntries(headDomains(base, derived.rules)), ([field, domain]) => ({
		field,
		domain: Option.getOrElse(domain, () => literalDomain)
	}))

/** Every row of a paged read: the first page, then each page after the last one's end cursor, while there is a next. */
const allPages = (
	reader: ReaderValue,
	program: unknown,
	size: number
): Effect.Effect<ReadonlyArray<unknown>, ReadError | CursorError> =>
	Effect.gen(function* () {
		const rows: Array<unknown> = []
		let page = yield* reader.page(program, {}, { first: size })
		rows.push(...Arr.map(page.edges, (e) => e.node))
		while (page.pageInfo.hasNextPage && Option.isSome(page.pageInfo.endCursor)) {
			page = yield* reader.page(program, {}, { first: size, after: page.pageInfo.endCursor.value })
			rows.push(...Arr.map(page.edges, (e) => e.node))
		}
		return rows
	})

/**
 * A program over a session's role reading a source of one of its relations' heading, `of` the relation's value (the
 * relation itself, or a delta of it inside a read-back), at `key`: each key field equal to its value, a literal of the
 * field's type, and the whole heading in the head. It is built as an application writes one with query(S).rule(...),
 * so its rows decode through the builder's own decoder, which a query rebuilt from its Description alone never has.
 * Read whole, the key is empty; `db.get` takes it as any query proved to return at most one row, and compiles it only
 * when the relation proves the key's fields a key. The builder throws its refusal.
 */
const relationRead = (
	session: DbSession,
	relation: string,
	of: (relation: unknown) => unknown,
	key: Readonly<Record<string, unknown>>
): QueryValue => {
	const value = relationValue(session, relation)
	return queryOver(session.value).rule((r: RuleValue): FinishedValue => {
		const vars = varsOver(value)
		return Arr.reduce(Rec.toEntries(key), r.match(of(value), vars), (matched, [field, literal]) =>
			matched.where(r.eq(vars[field], literal))
		).find(vars)
	})
}

const itself = (value: unknown): unknown => value

/** The program reading a role relation whole, or the builder's refusal of it. */
const readProgramOf = (
	session: DbSession,
	relation: string
): Effect.Effect<QueryValue, RealizeRefused> =>
	attempt(`the read of ${relation}`, () => relationRead(session, relation, itself, {}))

/**
 * The rows of a read of a role relation through `reader`, by the path `via` names: the program reading it whole,
 * executed or prepared; ordered by every field of its heading, a complete order, and read page by page; or a keyed
 * query by get.
 */
const rowsVia = (
	reader: ReaderValue,
	session: DbSession,
	relation: string,
	program: QueryValue,
	fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>,
	via: ReadVia
): Effect.Effect<ReadonlyArray<unknown>, ReadError | CursorError | CompileError> => {
	switch (via.kind) {
		case "execute":
			return Effect.flatMap(reader.execute(program, {}), (result) => result.collect)
		case "get":
			return Effect.flatMap(
				Effect.mapError(
					attempt(`the get of ${relation}`, () =>
						relationRead(session, relation, itself, carriersOf(fields, via.key))
					),
					(refused) => refused.refusal
				),
				(query) =>
					Effect.map(reader.get(query, {}), (row) =>
						Option.match(row, { onNone: () => [], onSome: (r) => [r] })
					)
			)
		case "page":
			return Effect.flatMap(
				Effect.mapError(
					attempt(`the page of ${relation}`, () =>
						program.orderBy(...Arr.map(fields, (f) => [f.field, "asc"] as const))
					),
					(refused) => refused.refusal
				),
				(ordered) => allPages(reader, ordered, via.size)
			)
		case "compile":
			return Effect.scoped(
				Effect.flatMap(reader.compile(program), (compiled) =>
					Effect.flatMap(compiled.execute({}), (result) => result.collect)
				)
			)
	}
}

/** A read of a role relation whole, through a program over the role, by the path `via` names. */
export const readSession = (
	session: DbSession,
	relation: string,
	via: ReadVia
): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const base = session.base
		const fields = Option.getOrElse(entryFields(base, session.role, relation), () => [])
		const program = yield* Effect.result(readProgramOf(session, relation))
		if (Result.isFailure(program)) {
			return refusedWith({ kind: "compile-refused" }, program.failure.refusal)
		}
		const runtime = yield* runtimeOf(session.db)
		const factsVia = (reader: ReaderValue) =>
			Effect.flatMap(rowsVia(reader, session, relation, program.success, fields, via), (rows) =>
				Effect.forEach(rows, (row, i) =>
					factOfRow(
						row,
						Arr.map(fields, (f) => f.field),
						`${relation} row ${i}`
					)
				)
			)
		const facts = yield* Effect.result(factsVia(runtime.reader))
		if (Result.isFailure(facts)) {
			const error = facts.failure
			switch (error._tag) {
				case "CompileError":
					return refusedWith({ kind: "compile-refused" }, error)
				case "CursorError":
					return yield* Effect.die(
						new Error("a page of a fresh read refused its own cursor", { cause: error })
					)
				case "ReadFailure":
				case "TransientFailure":
				case "StaleSnapshot":
					return refusedWith(yield* readFailed(error), error)
			}
		}
		const agree = yield* artifactsAgree(session.db, factsVia)
		return agree
			? seen({ kind: "rows", rows: facts.success })
			: seen({ kind: "artifacts-disagree" })
	})

/** A host fact as grizzle's carriers of a role relation's fields. */
const carriersOf = (
	fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>,
	fact: HostFact
): Readonly<Record<string, unknown>> =>
	Rec.map(fact, (value: HostValue, field) => {
		const domain = Arr.findFirst(fields, (f) => f.field === field)
		return Option.isSome(domain) ? carrierOf(domain.value.domain, value) : value
	})

/** One stratum: the union of its writes, each through a role relation. */
const stratumOf = (
	base: BaseSpec,
	session: DbSession,
	ops: ReadonlyArray<EntryOp>
): ChangeSetValue =>
	Arr.reduce(ops, changeSetOver.empty(session.value), (changes: ChangeSetValue, op) => {
		const fields = Option.getOrElse(entryFields(base, session.role, op.relation), () => [])
		return changes[op.kind](
			relationValue(session, op.relation),
			Arr.map(op.facts, (f) => carriersOf(fields, f))
		)
	})

/** The ChangeSet of a write: its strata in ChangeSet.sequence order, built on the builder's runtime path. */
const changesOf = (
	base: BaseSpec,
	session: DbSession,
	strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>
): Effect.Effect<Result.Result<ChangeSetValue, unknown>> =>
	Effect.sync(() =>
		Result.try({
			try: () => {
				const [first, ...rest] = strata
				return Arr.reduce(
					rest,
					stratumOf(base, session, first),
					(changes: ChangeSetValue, stratum) =>
						changeSetOver.sequence(changes, stratumOf(base, session, stratum))
				)
			},
			catch: (cause) => cause
		})
	)

/** A ChangeSet the builder refuses is compile-refused; any other throw is a defect of the run. */
const builderRefused = (cause: unknown): Effect.Effect<Seen> =>
	isCompileError(cause)
		? Effect.succeed(refusedWith({ kind: "compile-refused" }, cause))
		: Effect.die(cause)

/** A write through role relations. */
export const applySession = (
	session: DbSession,
	strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>,
	reads: ReadonlyArray<string>
): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const base = session.base
		const planned: Array<ReadBackPlan> = []
		for (const [i, relation] of reads.entries()) {
			const fields = Option.getOrElse(entryFields(base, session.role, relation), () => [])
			const program = yield* Effect.result(readProgramOf(session, relation))
			if (Result.isFailure(program)) {
				return refusedWith({ kind: "compile-refused" }, program.failure.refusal)
			}
			planned.push({
				index: i,
				relation,
				fields,
				program: program.success,
				delta: deltaOf(base, session.role, relation)
			})
		}
		const changes = yield* changesOf(base, session, strata)
		if (Result.isFailure(changes)) {
			return yield* builderRefused(changes.failure)
		}
		const withReads = Result.try({
			try: () =>
				Arr.reduce(planned, changes.success, (acc: ChangeSetValue, p) => {
					const rows = acc.read(`rows${String(p.index)}`, () => p.program)
					return p.delta === "unchanged"
						? rows
						: rows
								.read(`added${String(p.index)}`, (delta: DeltaValue) =>
									relationRead(session, p.relation, delta.added, {})
								)
								.read(`removed${String(p.index)}`, (delta: DeltaValue) =>
									relationRead(session, p.relation, delta.removed, {})
								)
				}),
			catch: (cause) => cause
		})
		if (Result.isFailure(withReads)) {
			return yield* builderRefused(withReads.failure)
		}
		const runtime = yield* runtimeOf(session.db)
		const outcome = yield* Effect.result(runtime.methods.apply(withReads.success, {}))
		if (Result.isFailure(outcome)) {
			return refusedWith(yield* applyFailed(outcome.failure), outcome.failure)
		}
		const answer = outcome.success
		if (answer.kind !== "accepted" && answer.kind !== "no-change") {
			return seen(yield* applied(answer, session.described))
		}
		const readBacks = yield* Effect.forEach(planned, (p) => readBackOf(p, answer.reads))
		return seen({ kind: "applied", outcome: answer.kind, reads: readBacks })
	})

/**
 * How a read-back's delta is had: read through the change's delta of the relation; or `unchanged`, a whole entry over a
 * closed relation, whose facts are its declaration's, or over a derived relation, which keeps its facts until a refresh.
 * No ChangeSet changes either, so its delta is empty, and a delta of it is refused as malformed when the ChangeSet is
 * built: a delta is of an ordinary relation.
 */
type ReadBackDelta = "read" | "unchanged"

const deltaOf = (base: BaseSpec, role: RoleSpec, relation: string): ReadBackDelta =>
	Option.exists(
		Rec.get(role.entries, relation),
		(entry) => entry.kind === "whole" && relationSpecOf(base, entry.relation) === undefined
	)
		? "unchanged"
		: "read"

/** A read-back requested of a write: its role relation, its fields, the program reading it whole and how its delta is had. */
interface ReadBackPlan {
	readonly index: number
	readonly relation: string
	readonly fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>
	readonly program: unknown
	readonly delta: ReadBackDelta
}

/** The rows a read-back delivered under one name, each a fact of the relation's fields. */
const readRows = (
	reads: unknown,
	name: string,
	plan: ReadBackPlan
): Effect.Effect<ReadonlyArray<HostFact>> => {
	const rows: unknown = Predicate.hasProperty(reads, name) ? reads[name] : undefined
	return Arr.isArray(rows)
		? Effect.forEach(rows, (row, i) =>
				factOfRow(
					row,
					Arr.map(plan.fields, (f) => f.field),
					`${plan.relation} read-back ${name} row ${String(i)}`
				)
			)
		: Effect.die(new Error(`the outcome holds no read-back ${name}`))
}

const readBackOf = (plan: ReadBackPlan, reads: unknown): Effect.Effect<ReadBack> =>
	Effect.gen(function* () {
		const i = String(plan.index)
		return {
			relation: plan.relation,
			rows: yield* readRows(reads, `rows${i}`, plan),
			delta:
				plan.delta === "unchanged"
					? { inserted: [], deleted: [] }
					: {
							inserted: yield* readRows(reads, `added${i}`, plan),
							deleted: yield* readRows(reads, `removed${i}`, plan)
						}
		}
	})

/** A value handed to db.apply, whatever it is. */
export const applyValue = (session: DbSession, changes: unknown): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const runtime = yield* runtimeOf(session.db)
		const outcome = yield* Effect.result(runtime.methods.apply(changes, {}))
		if (Result.isFailure(outcome)) {
			return refusedWith(yield* applyFailed(outcome.failure), outcome.failure)
		}
		return seen(yield* applied(outcome.success, session.described))
	})

/** A value handed to db.execute, whatever it is: its rows are not compared, only whether grizzle refuses it. */
export const executeValue = (session: DbSession, program: unknown): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const runtime = yield* runtimeOf(session.db)
		const rows = yield* Effect.result(
			Effect.flatMap(runtime.reader.execute(program, {}), (r) => r.collect)
		)
		if (Result.isFailure(rows)) {
			return refusedWith(yield* readFailed(rows.failure), rows.failure)
		}
		return seen({ kind: "rows", rows: [] })
	})

/** A refresh of a derived relation the role holds whole, by the value handed to db.refresh. */
export const refreshValue = (session: DbSession, relation: unknown): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const runtime = yield* runtimeOf(session.db)
		const done = yield* Effect.result(runtime.methods.refresh(relation))
		if (Result.isFailure(done)) {
			return refusedWith(yield* applyFailed(done.failure), done.failure)
		}
		return seen({ kind: "ok" })
	})

/** The value of a role relation by its name, or undefined, as a JavaScript caller naming one would pass it. */
export const relationValue = (session: DbSession, relation: string): unknown =>
	Predicate.hasProperty(session.value.relations, relation)
		? session.value.relations[relation]
		: undefined
