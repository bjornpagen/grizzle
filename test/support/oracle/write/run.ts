import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	pipe,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import { apply, compileChange, runApplication } from "#adapter/apply/index.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { openDbContext } from "#adapter/db/open.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import { type CompiledEntry, compiledWrite } from "#adapter/served/forms.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { isRecord } from "#compiler/core/record.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import { type FactIdentity, factIdentity } from "#compiler/scalar/values/identity.ts"
import type { Law, Refused, RefusedLaw } from "#compiler/types/changeset/changeset.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf, reportedLawId } from "#test/support/kernel/naming.ts"
import type { Fact, FactSet, OracleState } from "#test/support/oracle/addwins.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { type Perturbation, perturbedContext } from "#test/support/oracle/perturb.ts"
import { batchProblems, type Flight } from "#test/support/oracle/write/batch.ts"
import { type Entry, isFact } from "#test/support/oracle/write/changeset.ts"
import { typeInfo } from "#test/support/oracle/write/domain.ts"
import type { Collisions } from "#test/support/oracle/write/expect.ts"
import type { WFacts } from "#test/support/oracle/write/facts.ts"
import {
	type WBuiltSchema,
	buildWSchema,
	lawNames,
	serialColumns,
	type WGroup,
	type WRelation,
	type WriteLawNames,
	type WSchema,
	type WSchemaValue
} from "#test/support/oracle/write/schema.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { occupiedGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/** A refusal's witness as plain values: the violating fact's key, or why it names none. */
export type OutcomeWitness =
	| { readonly kind: "key"; readonly relation: string; readonly values: Fact }
	| { readonly kind: "unreported" }

/**
 * Which laws a refusal names (Refused, changeset.ts), each read back to its LawId: every law named broken, or the
 * laws of the CHECK PostgreSQL tried first, or some of the several laws of one object, at least one of them broken.
 */
export type RefusedIds =
	| { readonly kind: "every" | "first"; readonly laws: readonly [LawId, ...Array<LawId>] }
	| { readonly kind: "some"; readonly laws: readonly [LawId, LawId, ...Array<LawId>] }

/** The apply outcome as plain values. */
export type WriteOutcome =
	| {
			readonly kind: "accepted"
			readonly counts: ReadonlyArray<{
				readonly relation: string
				readonly added: bigint
				readonly deleted: bigint
				readonly put: bigint
			}>
			readonly reads: Readonly<Record<string, ReadonlyArray<Fact>>>
	  }
	| { readonly kind: "no-change"; readonly reads: Readonly<Record<string, ReadonlyArray<Fact>>> }
	| {
			readonly kind: "invariant-rejected"
			/**
			 * The laws the outcome names, read back through the installation's described laws, the witness's first, and how
			 * grizzle decided them.
			 */
			readonly refused: RefusedIds
			readonly witness: OutcomeWitness
	  }
	| { readonly kind: "outside-world"; readonly relation: string }

export type Artifact = "optimized" | "conservative"

/** Whether a run's tables carry planner statistics: analyzed after each case's facts are loaded, or never analyzed. */
export type Statistics = "analyzed" | "none"

export interface WriteTarget {
	readonly schema: WSchema
	readonly built: WBuiltSchema
	readonly installed: Installed
	readonly laws: WriteLawNames
	readonly statistics: Statistics
	/** The schema value rebuilt under the installed name, over the same relation values. */
	readonly value: WSchemaValue
	/** The theory role of the writer role the Db opened as. */
	readonly writer: string
	/** db.apply as the opened Db runs it, over a ChangeSet value of whatever members the case generated. */
	readonly db: {
		apply(
			changes: ChangeSetValue,
			params: ParamMap
		): Effect.Effect<ApplyOutcome<unknown>, ApplyError>
	}
	readonly ctx: DbContext
}

type TargetError = CompileError | SqlError | TransactionRolledBack | OpenError

/**
 * The database side of the write oracle.
 *
 * One installation per write run: the run's generated schema is installed under a fresh schema name through its first
 * migration (test/support/install-migrate.ts) and opened once as its full role `writer` through Db.open and its login's
 * DbLayer, exactly as an application opens it. Every case of the run then
 *
 * 1. resets its group to the case's initial state as the owner, in one transaction: the installation's tables that
 *    hold a block truncated (test/support/substrate/replace.ts occupiedGroup), the case's facts loaded as typed
 *    literals (oracle/install/load.ts), every identity sequence set where the case's expectation starts it, and, when
 *    the run keeps planner statistics, every relation of the group analyzed. A statement's plan follows the planner statistics, and a MERGE runs its actions
 *    in its plan's row order, so a realization can be right under one plan and wrong under another; a run draws
 *    whether its tables are analyzed at all, so the plans of tables never analyzed are reached too. The tables are
 *    installed with autovacuum off, so their statistics are always the run's choice and a case's plans do not depend
 *    on whether autovacuum happened to visit the table before it;
 * 2. applies the ChangeSet with one of two artifacts of one compiled program (packages/grizzle/src/adapter/apply runApplication): the
 *    optimized one, which db.apply runs, or db.compile's handle when the case draws it, or the conservative
 *    realization, every put its definition,
 *    the DELETE-then-insert pair, and every delta a comparison of states, in the same transaction machinery and outcome
 *    mapping;
 * 3. reads the group's committed state back as the owner, each value as its output-function text parsed to its host
 *    form (domain.ts), so the three sides compare by native equality.
 *
 * Every attempt of step 2 is also held to the single-flight property (batchProblems): the client never decides
 * between COMMIT and ROLLBACK from rows, and sends every statement and its COMMIT without waiting for any result. The
 * session the attempt runs on logs each flight it sends and what the server answered; a refusal, an abort or a law's
 * violation must come from a statement or the COMMIT that PostgreSQL failed, nothing but ROLLBACK may follow a failed
 * flight, and an applied outcome is every statement succeeding, then a COMMIT that committed.
 *
 * Installs `schema` under a fresh schema name and opens it as its writer role, in the scope. The schema value and its
 * world are declared again under the installed name over the very same relation values and statements, so the
 * ChangeSets built over those values are the Db's own (test/pg/reads/support.ts does the same for the fixtures). Every
 * law of a write schema is native, so the installation leaves nothing to the residual laws' extension.
 */
export const openTarget = (
	schema: WSchema,
	statistics: Statistics,
	ambient: AmbientSession
): Effect.Effect<WriteTarget, TargetError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const built = buildWSchema(schema, "Wo")
		const done = yield* install(built.value, {
			ambient,
			label: "real",
			logins: [built.worldOf(built.value).server],
			extensions: []
		})
		/** Planner statistics are the run's (step 1 of the header), never autovacuum's. */
		const laws = lawNames(done.plan)
		yield* transaction(
			s.admin,
			Arr.flatMap(schema.groups, (g) =>
				Arr.map(
					g.relations,
					(r) => `ALTER TABLE ${laws.table(r.name)} SET (autovacuum_enabled = false)`
				)
			)
		)
		const value = built.rename(done.schema)
		const world = built.worldOf(value)
		const context = yield* Layer.build(loginLayer(done, world.server))
		const { ctx } = yield* openDbContext(world.server.roles.writer, {}).pipe(
			Effect.provideContext(context)
		)
		return {
			schema,
			built,
			installed: done,
			laws,
			statistics,
			value,
			writer: done.role(world.writer),
			/** What db.apply runs (packages/grizzle/src/adapter/db/db.ts). */
			db: {
				apply: (changes, params) => Effect.suspend(() => apply(ctx, changes, changes.reads, params))
			},
			ctx
		}
	})

/**
 * The privileges the writer role holds that an immutable relation forbids: UPDATE of any column of an immutable
 * relation's table, and TRUNCATE on any, which would change facts other than by adding and deleting them. Each is a
 * problem.
 */
export const privilegeProblems = (
	t: WriteTarget
): Effect.Effect<ReadonlyArray<string>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const problems: Array<string> = []
		const role = t.writer
		for (const r of Arr.flatMap(t.schema.groups, (g) => g.relations)) {
			const table = pipe(t.laws.table(r.name), Str.replaceAll("'", "''"))
			const rows = yield* s.admin.queryValues(
				`SELECT pg_catalog.has_any_column_privilege($1::name, '${table}'::regclass, 'UPDATE')::text, pg_catalog.has_table_privilege($1::name, '${table}'::regclass, 'TRUNCATE')::text`,
				[role]
			)
			const [update, truncate] = rows[0] ?? []
			if (!r.mutable && String(update) === "true") {
				problems.push(`${role} may UPDATE the immutable ${r.name}`)
			}
			if (String(truncate) === "true") {
				problems.push(`${role} may TRUNCATE ${r.name}`)
			}
		}
		return problems
	})

/**
 * Resets the installation to `facts`, the group's, its identity sequences to `state`'s (step 1 of the header), in one
 * transaction that first truncates every stored relation's table that holds a block, with the tables referencing it,
 * and so reads no version another transaction wrote: never an SSI pivot, whatever the cluster's load
 * (test/support/substrate/replace.ts occupiedGroup). A case writes one group of a schema of several, so a reset
 * truncates the tables the cases before it wrote, not every table of the schema. Every other group is left empty
 * until its own reset: a group's laws reach only its own relations, and a case reads its group alone.
 */
export const resetGroup = (
	t: WriteTarget,
	group: WGroup,
	facts: WFacts,
	state: OracleState
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const loads = factStatements(t.installed.plan, facts)
		if (!loads.ok) {
			return yield* Effect.fail(loads.error)
		}
		const statements: Array<string> = [...loads.value]
		for (const r of group.relations) {
			for (const serial of serialColumns(r)) {
				const seq = Option.getOrThrowWith(
					Option.fromUndefinedOr(state.sequences.get(`${r.name}.${serial.name}`)),
					() => new Error(`no sequence state for ${r.name}.${serial.name}`)
				)
				const name = pipe(t.laws.sequence(r.name, serial.name), Str.replaceAll("'", "''"))
				statements.push(
					`SELECT pg_catalog.setval('${name}'::regclass, ${seq.lastValue}::bigint, ${seq.isCalled})`
				)
			}
		}
		if (t.statistics === "analyzed") {
			for (const r of group.relations) {
				statements.push(`ANALYZE ${t.laws.table(r.name)}`)
			}
		}
		yield* replaceRows(
			s.admin,
			occupiedGroup(namesOf(t.installed)),
			Arr.map(statements, (sql) => ({ sql, params: [] }))
		)
	})

export interface GroupState {
	/** Relation to its facts, identity to fact. */
	readonly relations: ReadonlyMap<string, FactSet>
	/** `<relation>.<field>` to the identity sequence's last_value and is_called. */
	readonly sequences: ReadonlyMap<
		string,
		{ readonly lastValue: bigint; readonly isCalled: boolean }
	>
}

/** A relation's stored rows as facts by identity; a row that is no admissible fact, or a repeated fact, is a defect. */
const storedFacts = (r: WRelation, rows: ReadonlyArray<ReadonlyArray<unknown>>): FactSet => {
	const heading = Arr.map(r.columns, (c) => ({ name: c.name, spec: typeInfo[c.kind].spec }))
	const facts = new TupleMap<FactIdentity, Fact>()
	for (const row of rows) {
		const fact = Rec.fromEntries(
			Arr.map(r.columns, (c, i) => [c.name, typeInfo[c.kind].parse(String(row[i]))] as const)
		)
		const admitted = factIdentity(heading, fact)
		if (!admitted.ok) {
			throw new Error(`${r.name}: a stored row is no admissible fact (${admitted.error.fault})`)
		}
		if (facts.has(admitted.value.identity)) {
			throw new Error(`${r.name}: a stored fact appears twice`)
		}
		facts.set(admitted.value.identity, admitted.value.fact)
	}
	return facts
}

/** The committed state of a group, read as the owner (step 3 of the header). */
export const readGroup = (
	t: WriteTarget,
	group: WGroup
): Effect.Effect<GroupState, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const relations = new Map<string, FactSet>()
		const sequences = new Map<string, { readonly lastValue: bigint; readonly isCalled: boolean }>()
		for (const r of group.relations) {
			const columns = Arr.join(
				Arr.map(r.columns, (c) => `${t.laws.column(r.name, c.name)}::text`),
				", "
			)
			const rows = yield* s.admin.queryValues(`SELECT ${columns} FROM ${t.laws.table(r.name)}`, [])
			relations.set(r.name, storedFacts(r, rows))
			for (const serial of serialColumns(r)) {
				const seq = yield* s.admin.queryValues(
					`SELECT last_value::text, is_called::text FROM ${t.laws.sequence(r.name, serial.name)}`,
					[]
				)
				sequences.set(`${r.name}.${serial.name}`, {
					lastValue: BigInt(String(seq[0]?.[0])),
					isCalled: String(seq[0]?.[1]) === "true"
				})
			}
		}
		return { relations, sequences }
	})

/** The compiled program of a ChangeSet value, as the target's Db compiles it for the contexts its claims hold. */
export const programOf = (
	t: WriteTarget,
	changes: unknown
): Result.Result<CompiledEntry, CompileError> => compiledWrite(t.ctx, changes, t.ctx.claims)

/** A session that logs every flight it sends, and what the server answered, into `log`. */
const loggedSession = (session: Session, log: Array<Flight>): Session => ({
	...session,
	send: (pipeline, onAnswer, onEnd, onCut) => {
		const last = pipeline[pipeline.length - 1]
		const ends = last?._tag === "control" && last.control.kind === "end" ? last.control.end : "kept"
		const statements = Arr.filter(pipeline, (q) => q._tag !== "control").length
		let refused = false
		let committed = false
		session.send(
			pipeline,
			(index, answer) => {
				if (answer._tag !== "result") {
					refused = true
				} else if (index === pipeline.length - 1 && ends === "COMMIT") {
					committed = answer.outcome.command === "COMMIT"
				}
				onAnswer(index, answer)
			},
			() => {
				log.push({ statements, ends, refused, committed })
				onEnd()
			},
			onCut
		)
	}
})

/** A context whose sessions log their flights into `log`. */
const loggedContext = (ctx: DbContext, log: Array<Flight>): DbContext => ({
	...ctx,
	pool: { ...ctx.pool, lease: Effect.map(ctx.pool.lease, (session) => loggedSession(session, log)) }
})

/**
 * One application: its outcome, or its operational failure as a value, how many attempts the model's collisions
 * failed before it, each called again (see applyWith), and the identity sequences its last attempt drew from: the
 * case's own, or as the attempts before it left them, since every value an aborted attempt drew stays drawn (nextval
 * is never rolled back), in every relation it drew into before its collision, not only the colliding one.
 */
export interface Applied {
	readonly outcome: Result.Result<WriteOutcome, ApplyError>
	readonly collided: number
	/** The flights the attempts sent, which the single-flight property judged. */
	readonly flights: number
	readonly start: GroupState["sequences"]
}

/**
 * One application with `artifact`. Under a perturbation's planner settings (../perturb.ts) the optimized side is
 * db.apply's own path, apply over the Db's context, or db.compile's when `entry` says so, its handle compiled on
 * the attempt's own context and applied once, on a context whose every transaction sets them first; so is the
 * conservative realization.
 *
 * grizzle makes one attempt per call. The oracle calls again after a TransientFailure, as an application does, only
 * where the case's model allows one (expect.ts Collisions): a generated addition that drew a serial value a stored fact
 * holds, at most once per such value. Any other TransientFailure has no concurrent transaction to explain it, a stale
 * statement or a serialization failure of a lone writer among them, and is returned as the case's outcome, which the
 * judge refuses. The first attempt draws from `positions`, where the case set the sequences; before calling again it
 * reads `group`'s sequences, where the next attempt draws from (Applied's start).
 */
export const applyWith = (
	t: WriteTarget,
	group: WGroup,
	positions: GroupState["sequences"],
	entry: CompiledEntry,
	changes: ChangeSetValue,
	params: ParamMap,
	artifact: Artifact,
	collisions: ReadonlyMap<string, Collisions>,
	perturbation: Perturbation,
	entryPoint: Entry
): Effect.Effect<Applied, SqlError, Substrate> => {
	const perturbed = perturbedContext(t.ctx, perturbation)
	let flights = 0
	let start = positions
	/** Each attempt logs its own flights and is held to the single-flight property (see the header). */
	const once = Effect.suspend(() => {
		const log: Array<Flight> = []
		const ctx = loggedContext(perturbed, log)
		const attempt =
			artifact === "conservative"
				? runApplication(ctx, entry, params, changes.reads)
				: entryPoint === "apply"
					? apply(ctx, changes, changes.reads, params)
					: Effect.scoped(
							Effect.flatMap(Effect.orDie(compileChange(ctx, changes, changes.reads)), (handle) =>
								handle.apply(params)
							)
						)
		return Effect.result(attempt).pipe(
			Effect.flatMap((result) => {
				flights += log.length
				const problems = batchProblems(log, result)
				if (problems.length > 0) {
					return Effect.die(new Error(`the single-flight property: ${Arr.join(problems, "; ")}`))
				}
				return Effect.fromResult(result)
			})
		)
	})
	/**
	 * Calls again after an allowed TransientFailure, `spent` counting the attempts each relation's collisions failed.
	 */
	const attempt = (
		spent: ReadonlyMap<string, number>
	): Effect.Effect<
		{ readonly value: ApplyOutcome<unknown>; readonly collided: number },
		ApplyError | SqlError,
		Substrate
	> =>
		Effect.catch(
			Effect.map(once, (value) => ({
				value,
				collided: Arr.reduce([...spent.values()], 0, (a, b) => a + b)
			})),
			(error) => {
				if (error._tag !== "TransientFailure" || error.reason._tag !== "GeneratedSerialUnique") {
					return Effect.fail(error)
				}
				const { relation, constraint } = error.reason
				const allowed = collisions.get(relation)
				const used = spent.get(relation) ?? 0
				if (
					allowed === undefined ||
					!allowed.constraints.has(constraint) ||
					used >= allowed.values
				) {
					return Effect.fail(error)
				}
				return Effect.flatMap(readGroup(t, group), (left) => {
					start = left.sequences
					return attempt(new Map([...spent, [relation, used + 1]]))
				})
			}
		)
	return Effect.flatMap(
		Effect.result(attempt(new Map())),
		(result): Effect.Effect<Applied, SqlError> => {
			if (Result.isSuccess(result)) {
				return Effect.map(
					Effect.orDie(
						fromEngine(t.ctx.programArtifacts({ kind: "changeSet", changeSet: entry.change.desc }))
					),
					({ artifacts }): Applied => ({
						outcome: Result.succeed(outcomeOf(artifacts.described, result.success.value)),
						collided: result.success.collided,
						flights,
						start
					})
				)
			}
			const failure = result.failure
			return failure._tag === "SqlError"
				? Effect.fail(failure)
				: Effect.succeed({ outcome: Result.fail(failure), collided: 0, flights, start })
		}
	)
}

const isRows = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

/**
 * The read-backs of an outcome, the record of the ChangeSet's reads decoder, as plain values: each read-back's rows
 * checked as records.
 */
const readsOf = (reads: unknown): Readonly<Record<string, ReadonlyArray<Fact>>> => {
	if (!isRecord(reads)) {
		throw new Error("the outcome's read-backs are no record")
	}
	return Rec.fromEntries(
		Arr.map(Rec.toEntries(reads), ([name, rows]) => {
			if (!isRows(rows)) {
				throw new Error(`the read-back ${name} delivered no rows`)
			}
			return [
				name,
				Arr.map(rows, (row) => {
					if (!isFact(row)) {
						throw new Error(`the read-back ${name} delivered a row that is no record`)
					}
					return row
				})
			]
		})
	)
}

/**
 * A refusal's laws read by their LawIds, each the installation's law of that identity (reportedLawId), how grizzle
 * decided them kept.
 */
const refusedIdsOf = (described: ReadonlyMap<LawId, Law>, refused: Refused): RefusedIds => {
	const id = (r: RefusedLaw): LawId => reportedLawId(described, r)
	switch (refused.kind) {
		case "every":
		case "first":
			return { kind: refused.kind, laws: Arr.map(refused.laws, id) }
		case "some": {
			const [first, second, ...rest] = refused.laws
			return { kind: "some", laws: [id(first), id(second), ...Arr.map(rest, id)] }
		}
	}
}

/**
 * The apply outcome as plain values: the runtime's, its laws read back to its LawId through the installation's
 * described laws, its read-back rows checked as records.
 */
const outcomeOf = (described: ReadonlyMap<LawId, Law>, o: ApplyOutcome<unknown>): WriteOutcome => {
	switch (o.kind) {
		case "invariant-rejected":
			return {
				kind: o.kind,
				refused: refusedIdsOf(described, o.refused),
				witness: o.witness
			}
		case "outside-world":
			return o
		case "accepted":
		case "no-change":
			return { ...o, reads: readsOf(o.reads) }
	}
}
