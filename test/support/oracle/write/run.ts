import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import {
	Array as Arr,
	Effect,
	pipe,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import { type CompiledEntry, type CompiledProgram, compiledWrite } from "#adapter/served/forms.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { isRecord } from "#compiler/core/record.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { factIdentity } from "#compiler/scalar/values/identity.ts"
import type {
	Law,
	RecordedLaw,
	BrokenLaws,
	RefusedLaw
} from "#compiler/types/changeset/changeset.ts"
import type { ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { paramsOver } from "#test/support/compile.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf, reportedLawId } from "#test/support/kernel/naming.ts"
import type { Fact, FactsByTexts } from "#test/support/oracle/addwins.ts"
import type { FactTexts } from "#test/support/oracle/delta.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { type Perturbation, perturbedContext } from "#test/support/oracle/perturb.ts"
import { batchProblems, type Flight } from "#test/support/oracle/write/batch.ts"
import { buildChangeSet, isFact, type WChangeSet } from "#test/support/oracle/write/changeset.ts"
import { typeInfo } from "#test/support/oracle/write/domain.ts"
import type { WFacts } from "#test/support/oracle/write/facts.ts"
import {
	type WBuiltSchema,
	buildWSchema,
	lawNames,
	type WGroup,
	type WRelation,
	type WriteLawNames,
	type WSchema,
	type WSchemaValue
} from "#test/support/oracle/write/schema.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openServedDb } from "#test/support/served-db.ts"
import { type RoleSetupError, runEntry, servedRoleContext } from "#test/support/served-role.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { replaceRows, tablesGroup } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A refusal's witness as plain values: the violating fact's key, or why it names none. */
export type OutcomeWitness =
	| { readonly kind: "key"; readonly relation: string; readonly values: Fact }
	| { readonly kind: "unreported" }
	| { readonly kind: "unreproduced" }

/**
 * Which laws a refusal names (BrokenLaws, changeset.ts), each read back to its LawId: every law named broken, or the
 * laws of the CHECK PostgreSQL tried first, or some of the several laws of one object, at least one of them broken.
 */
export type RefusedIds =
	| { readonly kind: "every" | "first"; readonly laws: readonly [LawId, ...Array<LawId>] }
	| { readonly kind: "some"; readonly laws: readonly [LawId, LawId, ...Array<LawId>] }
	| {
			readonly kind: "above"
			readonly own: "every" | "none" | "unjudged"
			readonly laws: readonly [LawId, ...Array<LawId>]
	  }

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

/** Whether a run's tables carry planner statistics: analyzed after each case's facts are loaded, or never analyzed. */
export type Statistics = "analyzed" | "none"

/** A run's installation, which holds no session: its schema installed, its roles and its logins (installTarget). */
export interface WriteInstallation {
	readonly schema: WSchema
	readonly built: WBuiltSchema
	readonly installed: Installed
	readonly laws: WriteLawNames
	readonly statistics: Statistics
	/** The schema value rebuilt under the installed name, over the same relation values. */
	readonly value: WSchemaValue
	/** The theory role of the writer role the Db opens as. */
	readonly writer: string
}

/** An installation with the writer's Db open on it, for the scope withTarget gives it. */
export interface WriteTarget extends WriteInstallation {
	/**
	 * The writer's served Db's context, and its role's compilation context as `grizzle generate` reads it, which every
	 * case's ChangeSet compiles through (served-role.ts): a served Db compiles nothing, so the oracle compiles the case's
	 * program as generate would and runs it on the Db (runEntry).
	 */
	readonly ctx: OracleContext
}

/** A writer's served Db's context with its role's compilation context (WriteTarget.ctx). */
export type OracleContext = ServedDbContext & RoleContext

/** How opening the writer's Db on an installation fails (withTarget). */
type TargetError = OpenError | ServedRefusal | CompileError | RoleSetupError

/**
 * The database side of the write oracle.
 *
 * One installation per write run: the run's generated schema is installed under a fresh schema name through its first
 * migration (test/support/install-migrate.ts, installTarget) and opened once as its full role `writer` through Db.open
 * and its login's DbLayer, exactly as an application opens it, in a scope nested inside the installation's (withTarget).
 * Every case of the run then
 *
 * 1. resets its group to the case's initial state as the owner, in one transaction: the installation's tables that
 *    hold a row emptied (test/support/substrate/replace.ts tablesGroup), the case's facts loaded as typed
 *    literals (oracle/install/load.ts), and, when
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
 * Installs `schema` under a fresh schema name, in the scope: its roles and logins are released when the scope closes.
 * The schema value and its world are declared again under the installed name over the very same relation values and
 * statements, so the ChangeSets built over those values are the Db's own (test/pg/reads/support.ts does the same for
 * the fixtures). Every law of a write schema is native, so the installation leaves nothing to the residual laws'
 * extension. The writer's Db is opened on it by withTarget alone, in a scope of its own.
 *
 * The installation installs the types `changes`, every ChangeSet the run applies, cast their parameters to: each built
 * over the declared schema, a program of the writer's workload whose parameter types alone are planned
 * (test/support/compile.ts paramsOver), each pattern domain and outside contract, and no index or statistics object of
 * that workload, so the catalog is the bare migration's otherwise. The writer's role compiles every case's ChangeSet
 * under what the snapshot records the installation installs (served-role.ts servedRoleContext), so none casts a
 * parameter to a type the installation lacks.
 */
export const installTarget = (
	schema: WSchema,
	statistics: Statistics,
	ambient: AmbientSession,
	changes: ReadonlyArray<{ readonly group: WGroup; readonly changes: WChangeSet }>
): Effect.Effect<
	WriteInstallation,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const built = buildWSchema(schema, "Wo")
		const declared = built.worldOf(built.value)
		const programs = Rec.fromEntries(
			Arr.map(changes, (c, i) => [
				`change${i}`,
				buildChangeSet(built.value, built.relations, c.group, c.changes).changes
			])
		)
		const done = yield* install(built.value, {
			ambient,
			label: "real",
			logins: [declared.server],
			extensions: [
				paramsOver([{ login: "server", workloads: [workload(declared.writer, programs)] }])
			]
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
		return {
			schema,
			built,
			installed: done,
			laws,
			statistics,
			value,
			writer: done.role(built.worldOf(value).writer)
		}
	})

/**
 * `body` run on the writer's served Db over `installation`, the Db opened in a scope of its own nested inside the
 * installation's: every session the Db opens ends when `body` does, however `body` exits (accepted, failed, cut,
 * interrupted mid-case or shrunk), before the installation's scope releases a role a session logs in as. So no exit of
 * a run can leave a session of its writer for the release of its roles, by nesting rather than by the order of
 * finalizers in one scope.
 */
export const withTarget = <A, E, R>(
	installation: WriteInstallation,
	body: (t: WriteTarget) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | TargetError, R> =>
	Effect.scoped(
		Effect.gen(function* () {
			const writer = installation.built.worldOf(installation.value).server.roles.writer
			const served = yield* openServedDb(installation.installed, writer, {})
			const role = yield* servedRoleContext(installation.installed, writer)
			const ctx: OracleContext = { ...served.ctx, ...role }
			return yield* body({ ...installation, ctx })
		})
	)

/**
 * The privileges the writer role holds that a closed relation forbids: UPDATE of any column or DELETE of a closed
 * relation's table, whose facts are inserted, never changed or deleted, and TRUNCATE on any table. Each is a problem.
 */
export const privilegeProblems = (
	t: WriteInstallation
): Effect.Effect<ReadonlyArray<string>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const problems: Array<string> = []
		const role = t.writer
		for (const r of Arr.flatMap(t.schema.groups, (g) => g.relations)) {
			const table = pipe(t.laws.table(r.name), Str.replaceAll("'", "''"))
			const rows = yield* s.admin.queryValues(
				`SELECT pg_catalog.has_any_column_privilege($1::name, '${table}'::regclass, 'UPDATE')::text, pg_catalog.has_table_privilege($1::name, '${table}'::regclass, 'TRUNCATE')::text, pg_catalog.has_table_privilege($1::name, '${table}'::regclass, 'DELETE')::text`,
				[role]
			)
			const [update, truncate, deletes] = rows[0] ?? []
			if (!r.mutable && update === "true") {
				problems.push(`${role} may UPDATE the closed ${r.name}`)
			}
			if (!r.mutable && deletes === "true") {
				problems.push(`${role} may DELETE the closed ${r.name}`)
			}
			if (truncate === "true") {
				problems.push(`${role} may TRUNCATE ${r.name}`)
			}
		}
		return problems
	})

/**
 * Resets the installation to `facts`, the group's (step 1 of the header): every stored relation's rows deleted in a
 * READ COMMITTED transaction of their own, then one transaction that loads the facts, which reads no version a
 * serializable transaction wrote: never an SSI pivot, whatever the cluster's load (test/support/substrate/replace.ts
 * tablesGroup). A deletion swaps no relation file, so a reset costs the rows the cases before it wrote, not every table
 * and index of the schema. The deleted versions it leaves until a vacuum change what a plan reads and never what a
 * statement answers, and the oracle's verdicts are plan-independent by construction: the run draws its statistics and
 * perturbs its plans (perturb.ts). Every other group is left empty until its own reset: a group's laws reach only its
 * own relations, and a case reads its group alone.
 */
export const resetGroup = (
	t: WriteInstallation,
	group: WGroup,
	facts: WFacts
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const loads = factStatements(t.installed.plan, facts)
		if (!loads.ok) {
			return yield* Effect.fail(loads.error)
		}
		const statements: Array<string> = [...loads.value]
		if (t.statistics === "analyzed") {
			for (const r of group.relations) {
				statements.push(`ANALYZE ${t.laws.table(r.name)}`)
			}
		}
		yield* replaceRows(
			s.admin,
			tablesGroup(namesOf(t.installed).storedTables),
			Arr.map(statements, (sql) => ({ sql, params: [] }))
		)
	})

export interface GroupState {
	/** Relation to its facts, identity to fact. */
	readonly relations: ReadonlyMap<string, FactsByTexts>
}

/** A relation's stored rows as facts by identity; a row that is no admissible fact, or a repeated fact, is a defect. */
const storedFacts = (r: WRelation, rows: ReadonlyArray<ReadonlyArray<unknown>>): FactsByTexts => {
	const heading = Arr.map(r.columns, (c) => ({ name: c.name, spec: typeInfo[c.kind].spec }))
	const facts = new TupleMap<FactTexts, Fact>()
	for (const row of rows) {
		const fact = Rec.fromEntries(
			Arr.map(r.columns, (c, i) => [c.name, typeInfo[c.kind].parse(String(row[i]))] as const)
		)
		const admitted = factIdentity(heading, fact)
		if (!admitted.ok) {
			throw new Error(`${r.name}: a stored row is no admissible fact (${admitted.error.fault})`)
		}
		if (facts.has(admitted.value.texts)) {
			throw new Error(`${r.name}: a stored fact appears twice`)
		}
		facts.set(admitted.value.texts, admitted.value.fact)
	}
	return facts
}

/** The committed state of a group, read as the owner (step 3 of the header). */
export const readGroup = (
	t: WriteInstallation,
	group: WGroup
): Effect.Effect<GroupState, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const relations = new Map<string, FactsByTexts>()
		for (const r of group.relations) {
			const columns = Arr.join(
				Arr.map(r.columns, (c) => `${t.laws.column(r.name, c.name)}::text`),
				", "
			)
			const rows = yield* s.admin.queryValues(`SELECT ${columns} FROM ${t.laws.table(r.name)}`, [])
			relations.set(r.name, storedFacts(r, rows))
		}
		return { relations }
	})

/** The compiled program of a ChangeSet value, as the target's Db compiles it for the contexts its claims hold: its
 * runtime's entry, and its compiled write whole. */
export const programOf = (
	t: WriteTarget,
	changes: unknown
): Result.Result<CompiledProgram, CompileError> => compiledWrite(t.ctx, changes, t.ctx.claims)

/** A session that logs every flight it sends, and what the server answered, into `log`. */
const loggedSession = (session: Session, log: Array<Flight>): Session => ({
	...session,
	send: (pipeline, onAnswer, onEnd, onCut) => {
		const last = pipeline[pipeline.length - 1]
		const ends = last?._tag === "control" && last.control.kind === "end" ? last.control.end : "kept"
		const statements = Arr.filter(pipeline, (q) => q._tag !== "control").length
		let refused = false
		let commitRefused = false
		let committed = false
		session.send(
			pipeline,
			(index, answer) => {
				const atCommit = index === pipeline.length - 1 && ends === "COMMIT"
				if (answer._tag !== "result") {
					refused = true
					commitRefused = atCommit
				} else if (atCommit) {
					committed = answer.outcome.command === "COMMIT"
				}
				onAnswer(index, answer)
			},
			() => {
				log.push({ statements, ends, refused, commitRefused, committed })
				onEnd()
			},
			onCut
		)
	}
})

/** A context whose sessions log their flights into `log`. */
const loggedContext = (ctx: OracleContext, log: Array<Flight>): OracleContext => ({
	...ctx,
	pool: { ...ctx.pool, lease: Effect.map(ctx.pool.lease, (session) => loggedSession(session, log)) }
})

/** One application: its outcome, or its operational failure as a value. */
export interface Applied {
	readonly outcome: Result.Result<WriteOutcome, ApplyError>
	/** The flights the attempt sent, which the single-flight property judged. */
	readonly flights: number
}

/**
 * One application of `entry`, the compiled program of `artifact`: the optimized one `grizzle generate` serves, or the
 * conservative realization (conservative.ts conservativeChange), each run as a served change member runs its loaded
 * entry (served-role.ts runEntry), under a perturbation's planner settings (../perturb.ts) on a context whose every
 * transaction sets them first.
 *
 * grizzle makes one attempt per call, and so does the oracle: a TransientFailure has no concurrent transaction to
 * explain it, a stale statement or a serialization failure of a lone writer among them, and is returned as the case's
 * outcome, which the judge refuses.
 */
export const applyWith = (
	t: WriteTarget,
	entry: CompiledEntry,
	changes: ChangeSetValue,
	params: unknown,
	perturbation: Perturbation
): Effect.Effect<Applied, SqlError, Substrate> => {
	const perturbed = perturbedContext(t.ctx, perturbation)
	const log: Array<Flight> = []
	/** The attempt logs its own flights and is held to the single-flight property (see the header). */
	const once = Effect.suspend(() =>
		Effect.result(runEntry(loggedContext(perturbed, log), entry, params, changes.reads)).pipe(
			Effect.flatMap((result) => {
				const problems = batchProblems(log, result)
				if (problems.length > 0) {
					return Effect.die(new Error(`the single-flight property: ${Arr.join(problems, "; ")}`))
				}
				return Effect.fromResult(result)
			})
		)
	)
	return Effect.flatMap(Effect.result(once), (result): Effect.Effect<Applied, SqlError> => {
		if (Result.isSuccess(result)) {
			return Effect.map(
				Effect.orDie(
					fromEngine(t.ctx.programArtifacts({ kind: "changeSet", changeSet: entry.change.desc }))
				),
				({ artifacts }): Applied => ({
					outcome: Result.succeed(outcomeOf(artifacts.described, result.success)),
					flights: log.length
				})
			)
		}
		return Effect.succeed({ outcome: Result.fail(result.failure), flights: log.length })
	})
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
const refusedIdsOf = (
	described: ReadonlyMap<LawId, RecordedLaw>,
	refused: BrokenLaws
): RefusedIds => {
	const id = (r: RefusedLaw<Law>): LawId => reportedLawId(described, r)
	switch (refused.kind) {
		case "every":
		case "first":
			return { kind: refused.kind, laws: Arr.map(refused.laws, id) }
		case "some": {
			const [first, second, ...rest] = refused.laws
			return { kind: "some", laws: [id(first), id(second), ...Arr.map(rest, id)] }
		}
		case "above":
			return {
				kind: "above",
				own: refused.own,
				laws: Arr.map(
					refused.own === "every" ? Arr.appendAll(refused.above, refused.laws) : refused.above,
					id
				)
			}
	}
}

/**
 * The apply outcome as plain values: the runtime's, its laws read back to its LawId through the installation's
 * described laws, its read-back rows checked as records.
 */
const outcomeOf = (
	described: ReadonlyMap<LawId, RecordedLaw>,
	o: ApplyOutcome<unknown>
): WriteOutcome => {
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
