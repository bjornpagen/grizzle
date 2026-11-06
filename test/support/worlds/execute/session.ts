import { Array as Arr, Effect, Option, Predicate, Record as Rec, Result } from "effect"
import { type ReadError } from "#adapter/errors/execution.ts"
import type { Db } from "#adapter/public/db.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type CompileError, type CursorError, isCompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { regexField } from "#compiler/text/field.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { changeSetOver, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { argumentsOf } from "#test/support/list.ts"
import { type DbRuntime, dbRuntime } from "#test/support/runtime-db.ts"
import { artifactsAgree } from "#test/support/worlds/execute/artifacts.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"
import { headDomains } from "#test/support/worlds/execute/describe.ts"
import { carrierOf, factOfRow } from "#test/support/worlds/execute/host.ts"
import { errorStory, errorTexts, type Found } from "#test/support/worlds/execute/leak.ts"
import { applied, applyFailed, readFailed } from "#test/support/worlds/execute/observe.ts"
import { attempt, type RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { attachedField, flattened, reachFields } from "#test/support/worlds/model/reads.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import { textDomain } from "#test/support/worlds/model/text.ts"
import type {
	BaseSpec,
	DerivedSpec,
	EntryOp,
	FieldDomain,
	HostFact,
	Observation,
	PageFrom,
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
 * version's described laws, which its refusals' laws are read back by, and the Db, which holds the pool of that
 * version's layer (test/support/runtime-db.ts contextOf), the pool that serves it after a migration made another
 * version current.
 */
export interface DbSession {
	readonly kind: "db"
	readonly login: string
	readonly role: RoleSpec
	readonly base: BaseSpec
	readonly described: ReadonlyMap<LawId, Law>
	readonly value: BuiltRole
	readonly db: Db<BuiltRole, unknown>
}

/** The role a write or a read is built through: its spec, and its value as the builders made it. */
export type WritingRole = Pick<DbSession, "role" | "value">

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

/**
 * Every row of a paged read, in the order its pages deliver them: from the first page, each page after the last one's
 * end cursor while there is a next; from the last, each page before the first one's start cursor while there is a
 * previous, its rows before those of the pages read after it. A backward page delivers its rows in the presentation
 * order too.
 */
const allPages = (
	reader: ReaderValue,
	program: unknown,
	size: number,
	from: PageFrom
): Effect.Effect<ReadonlyArray<unknown>, ReadError | CursorError> =>
	Effect.gen(function* () {
		const nodes = (page: { readonly edges: ReadonlyArray<{ readonly node: unknown }> }) =>
			Arr.map(page.edges, (e) => e.node)
		if (from === "first") {
			const rows: Array<unknown> = []
			let page = yield* reader.page(program, {}, { first: size })
			appendAll(rows, nodes(page))
			while (page.pageInfo.hasNextPage && Option.isSome(page.pageInfo.endCursor)) {
				page = yield* reader.page(
					program,
					{},
					{ first: size, after: page.pageInfo.endCursor.value }
				)
				appendAll(rows, nodes(page))
			}
			return rows
		}
		let page = yield* reader.page(program, {}, { last: size })
		const backward: Array<ReadonlyArray<unknown>> = [nodes(page)]
		while (page.pageInfo.hasPreviousPage && Option.isSome(page.pageInfo.startCursor)) {
			page = yield* reader.page(
				program,
				{},
				{ last: size, before: page.pageInfo.startCursor.value }
			)
			backward.push(nodes(page))
		}
		return Arr.flatten(Arr.reverse(backward))
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
	session: WritingRole,
	relation: string,
	of: (relation: unknown) => unknown,
	key: Readonly<Record<string, unknown>>
): QueryValue => {
	const value = relationValue(session, relation)
	return queryOver(session.value).rule((r: RuleValue): FinishedValue => {
		const vars = varsOver(value, "value")
		return Arr.reduce(Rec.toEntries(key), r.match(of(value), vars), (matched, [field, literal]) =>
			matched.where(r.eq(vars[field], literal))
		).find(vars)
	})
}

const itself = (value: unknown): unknown => value

/** The program reading a role relation whole, or the builder's refusal of it. */
const readProgramOf = (
	session: WritingRole,
	relation: string
): Effect.Effect<QueryValue, RealizeRefused> =>
	attempt(`the read of ${relation}`, () => relationRead(session, relation, itself, {}))

/**
 * A role relation read whole with another attached to each row as an array (README "Queries": nest): the child's rows
 * whose field `child` equals the parent row's field `parent`, delivered without that field. The builder throws its
 * refusal.
 */
const attachedRead = (
	session: WritingRole,
	relation: string,
	via: Extract<ReadVia, { readonly kind: "attach" }>,
	attached: string
): QueryValue => {
	const value = relationValue(session, relation)
	const child = relationValue(session, via.relation)
	return queryOver(session.value)
		.rule((r: RuleValue): FinishedValue => {
			const vars = varsOver(value, "value")
			return r.match(value, vars).find(vars)
		})
		.attach(
			attached,
			(parent: Readonly<Record<string, unknown>>) =>
				queryOver(session.value).rule((r: RuleValue): FinishedValue => {
					const vars = varsOver(child, "child")
					return r
						.match(child, { ...vars, [via.child]: parent[via.parent] })
						.find(Rec.remove(vars, via.child))
				}),
			"array"
		)
}

/**
 * The field a recursive read's row states for a domain it chains (generate/reads.ts reachable): a uuid, a text of its
 * pattern, or the integer type of an integer or a serial; none for another, which no recursive read is drawn over.
 */
const rowField = (domain: FieldDomain): Option.Option<unknown> => {
	const integer = (bits: 16 | 32 | 64): unknown =>
		bits === 16 ? pg.smallint : bits === 32 ? pg.integer : pg.bigint
	switch (domain.kind) {
		case "uuid":
			return Option.some(uuid)
		case "text":
			return Option.some(regexField(domain.pattern, [domain.flags]))
		case "integer":
		case "serial":
			return Option.some(integer(domain.bits))
		case "boolean":
		case "handle":
		case "span":
		case "contract":
			return Option.none()
	}
}

/**
 * Every pair a role relation's rows chain from field `from` to field `to`, read by a recursive query over the role
 * (README "Queries": recursion): its base each row's pair, its step a pair's origin with the value a row starting at
 * its reached value reaches. `field` is the row's type of both. The builder throws its refusal.
 */
const reachRead = (
	session: WritingRole,
	relation: string,
	via: Extract<ReadVia, { readonly kind: "reach" }>,
	field: unknown
): QueryValue => {
	const value = relationValue(session, relation)
	const reach = queryOver(session.value).recursive("Reach", {
		row: { [reachFields.origin]: field, [reachFields.reached]: field },
		base: [
			(r: RuleValue): FinishedValue => {
				const edge = varsOver(value, "edge")
				return r
					.match(value, edge)
					.find({ [reachFields.origin]: edge[via.from], [reachFields.reached]: edge[via.to] })
			}
		],
		rec: [
			(r: RuleValue, self: unknown): FinishedValue => {
				const at = varsOver(self, "at")
				const edge = varsOver(value, "edge")
				return r
					.match(self, at)
					.match(value, { ...edge, [via.from]: at[reachFields.reached] })
					.find({
						[reachFields.origin]: at[reachFields.origin],
						[reachFields.reached]: edge[via.to]
					})
			}
		]
	})
	return queryOver(session.value).rule((r: RuleValue): FinishedValue => {
		const vars = varsOver(reach, "reach")
		return r.match(reach, vars).find(vars)
	})
}

/** A program the builder built, or its refusal as the read's CompileError. */
const built = (what: string, build: () => QueryValue): Effect.Effect<QueryValue, CompileError> =>
	Effect.mapError(attempt(what, build), (refused) => refused.refusal)

/** Every row a read of a program delivers, executed. */
const executed = (
	reader: ReaderValue,
	program: QueryValue
): Effect.Effect<ReadonlyArray<unknown>, ReadError | CompileError> =>
	Effect.flatMap(reader.execute(program, {}), (result) => result.collect)

/** Rows a read delivered, each read as a fact of exactly `fields`. */
const factsOfRows = (
	rows: ReadonlyArray<unknown>,
	fields: ReadonlyArray<string>,
	what: string
): Effect.Effect<ReadonlyArray<HostFact>> =>
	Effect.forEach(rows, (row, i) => factOfRow(row, fields, `${what} row ${i}`))

/**
 * The facts of a read of a role relation through `reader`, by the path `via` names: the program reading it whole,
 * executed or prepared; ordered by the drawn order, which grizzle completes with a key of the relation, and read page
 * by page from the first page or the last; a keyed query by get; the relation with another attached, each row
 * flattened with its children (model/reads.ts flattened); or the pairs a recursive query chains.
 */
const factsVia = (
	reader: ReaderValue,
	session: DbSession,
	relation: string,
	program: QueryValue,
	fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>,
	via: ReadVia
): Effect.Effect<ReadonlyArray<HostFact>, ReadError | CursorError | CompileError> => {
	const names = Arr.map(fields, (f) => f.field)
	const asFacts = (rows: ReadonlyArray<unknown>) => factsOfRows(rows, names, relation)
	switch (via.kind) {
		case "execute":
			return Effect.flatMap(executed(reader, program), asFacts)
		case "get":
			return Effect.flatMap(
				built(`the get of ${relation}`, () =>
					relationRead(session, relation, itself, carriersOf(fields, via.key))
				),
				(query) =>
					Effect.flatMap(reader.get(query, {}), (row) =>
						asFacts(Option.match(row, { onNone: () => [], onSome: (r) => [r] }))
					)
			)
		case "page":
			return Effect.flatMap(
				Effect.mapError(
					attempt(`the page of ${relation}`, () =>
						program.orderBy(
							...argumentsOf(Arr.map(via.order, (k) => [k.field, k.direction] as const))
						)
					),
					(refused) => refused.refusal
				),
				(ordered) => Effect.flatMap(allPages(reader, ordered, via.size, via.from), asFacts)
			)
		case "compile":
			return Effect.scoped(
				Effect.flatMap(reader.compile(program), (compiled) =>
					Effect.flatMap(
						Effect.flatMap(compiled.execute({}), (result) => result.collect),
						asFacts
					)
				)
			)
		case "attach": {
			const attached = attachedField(names)
			const childFields = Arr.filter(
				Arr.map(
					Option.getOrElse(entryFields(session.base, session.role, via.relation), () => []),
					(f) => f.field
				),
				(f) => f !== via.child
			)
			return Effect.flatMap(
				built(`the attachment of ${via.relation} to ${relation}`, () =>
					attachedRead(session, relation, via, attached)
				),
				(query) =>
					Effect.flatMap(executed(reader, query), (rows) =>
						Effect.map(
							Effect.forEach(rows, (row, i) =>
								Effect.gen(function* () {
									const what = `${relation} row ${i}`
									const parent = yield* factOfRow(row, names, what)
									const nested: unknown = Predicate.hasProperty(row, attached)
										? row[attached]
										: undefined
									const children = Arr.isArray(nested)
										? yield* factsOfRows(nested, childFields, `${what}.${attached}`)
										: yield* Effect.die(new Error(`${what} delivers no array under ${attached}`))
									return flattened(parent, children, attached)
								})
							),
							Arr.flatten
						)
					)
			)
		}
		case "reach": {
			const domain = Arr.findFirst(fields, (f) => f.field === via.from)
			const field = Option.flatMap(domain, (f) => rowField(f.domain))
			return Option.isNone(field)
				? Effect.die(
						new Error(`a recursive read of ${relation} over ${via.from}, which it chains no way`)
					)
				: Effect.flatMap(
						built(`the recursive read of ${relation}`, () =>
							reachRead(session, relation, via, field.value)
						),
						(query) =>
							Effect.flatMap(executed(reader, query), (rows) =>
								factsOfRows(rows, [reachFields.origin, reachFields.reached], relation)
							)
					)
		}
	}
}

/** A read of a role relation, through a program over the role, by the path `via` names. */
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
		const read = (reader: ReaderValue) =>
			factsVia(reader, session, relation, program.success, fields, via)
		const facts = yield* Effect.result(read(runtime.reader))
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
				case "StaleSnapshot": {
					const failed = yield* readFailed(error)
					return refusedWith(failed, error)
				}
			}
		}
		const agree = yield* artifactsAgree(session.db, read)
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
	session: WritingRole,
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
	session: WritingRole,
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

/** A ChangeSet the builder refuses is the write's refusal when it compiles; any other throw is a defect of the run. */
const builderRefused = (cause: unknown): Effect.Effect<Result.Result<never, CompileError>> =>
	isCompileError(cause) ? Effect.succeed(Result.fail(cause)) : Effect.die(cause)

/** A write as the executor hands it to db.apply: its ChangeSet with its read-backs, and how each read-back is read. */
export interface PlannedWrite {
	readonly changes: ChangeSetValue
	readonly planned: ReadonlyArray<ReadBackPlan>
}

/**
 * The ChangeSet of a write through a role's relations, built on the builder's runtime path as an application builds
 * one: each read-back's program reading its relation whole, the strata in ChangeSet.sequence order, then each
 * read-back's rows and, where its delta is read, its added and removed facts. A builder's CompileError is the write's
 * refusal when it compiles.
 */
export const plannedWrite = (
	base: BaseSpec,
	writer: WritingRole,
	strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>,
	reads: ReadonlyArray<string>
): Effect.Effect<Result.Result<PlannedWrite, CompileError>> =>
	Effect.gen(function* () {
		const planned: Array<ReadBackPlan> = []
		for (const [i, relation] of reads.entries()) {
			const fields = Option.getOrElse(entryFields(base, writer.role, relation), () => [])
			const program = yield* Effect.result(readProgramOf(writer, relation))
			if (Result.isFailure(program)) {
				return Result.fail(program.failure.refusal)
			}
			planned.push({
				index: i,
				relation,
				fields,
				program: program.success,
				delta: deltaOf(base, writer.role, relation)
			})
		}
		const changes = yield* changesOf(base, writer, strata)
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
									relationRead(writer, p.relation, delta.added, {})
								)
								.read(`removed${String(p.index)}`, (delta: DeltaValue) =>
									relationRead(writer, p.relation, delta.removed, {})
								)
				}),
			catch: (cause) => cause
		})
		if (Result.isFailure(withReads)) {
			return yield* builderRefused(withReads.failure)
		}
		return Result.succeed({ changes: withReads.success, planned })
	})

/** A write through role relations. */
export const applySession = (
	session: DbSession,
	strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>,
	reads: ReadonlyArray<string>
): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const write = yield* plannedWrite(session.base, session, strata, reads)
		if (Result.isFailure(write)) {
			return refusedWith({ kind: "compile-refused" }, write.failure)
		}
		const { changes, planned } = write.success
		const runtime = yield* runtimeOf(session.db)
		const outcome = yield* Effect.result(runtime.methods.apply(changes, {}))
		if (Result.isFailure(outcome)) {
			const failed = yield* applyFailed(outcome.failure)
			return refusedWith(failed, outcome.failure)
		}
		const answer = outcome.success
		if (answer.kind !== "accepted" && answer.kind !== "no-change") {
			const appliedAnswer = yield* applied(answer, session.described)
			return seen(appliedAnswer)
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
export interface ReadBackPlan {
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
			const failed = yield* applyFailed(outcome.failure)
			return refusedWith(failed, outcome.failure)
		}
		const appliedSuccess = yield* applied(outcome.success, session.described)
		return seen(appliedSuccess)
	})

/** A value handed to db.execute, whatever it is: its rows are not compared, only whether grizzle refuses it. */
export const executeValue = (session: DbSession, program: unknown): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const runtime = yield* runtimeOf(session.db)
		const rows = yield* Effect.result(
			Effect.flatMap(runtime.reader.execute(program, {}), (r) => r.collect)
		)
		if (Result.isFailure(rows)) {
			const failed = yield* readFailed(rows.failure)
			return refusedWith(failed, rows.failure)
		}
		return seen({ kind: "rows", rows: [] })
	})

/** A refresh of a derived relation the role holds whole, by the value handed to db.refresh. */
export const refreshValue = (session: DbSession, relation: unknown): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const runtime = yield* runtimeOf(session.db)
		const done = yield* Effect.result(runtime.methods.refresh([relation]))
		if (Result.isFailure(done)) {
			const failed = yield* applyFailed(done.failure)
			return refusedWith(failed, done.failure)
		}
		return seen({ kind: "ok" })
	})

/** The value of a role relation by its name, or undefined, as a JavaScript caller naming one would pass it. */
export const relationValue = (session: WritingRole, relation: string): unknown =>
	Predicate.hasProperty(session.value.relations, relation)
		? session.value.relations[relation]
		: undefined
