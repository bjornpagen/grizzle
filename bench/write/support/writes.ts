import {
	Array as Arr,
	Duration,
	Effect,
	Fiber,
	Option,
	Record as Rec,
	Result,
	type Scope
} from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberOps, variantOf } from "#adapter/db/handles.ts"
import { fromEngine, toResult } from "#adapter/engine.ts"
import { type ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import { boundReads, type CompiledEntry, compiledWrite } from "#adapter/served/forms.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { artifactsOver, builtLogin, loginRoles, ownLoginOver } from "#adapter/served/login.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import {
	type Answer,
	controlText,
	type WireQuery,
	type Session,
	type SessionPool
} from "#adapter/wire/session.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import { type Summary, summarize } from "#bench/cold/stats.ts"
import { explain, type MalformedPlan } from "#bench/harness/explain.ts"
import type { Attempted } from "#bench/harness/load.ts"
import {
	type Constraint,
	causeOf,
	type FailedOutcome,
	type Outcome
} from "#bench/harness/outcome.ts"
import type { TransactionPlan, TransactionStatement } from "#bench/harness/transaction.ts"
import { type Fixture, GateSetupError, installFixture } from "#bench/query/support/kit.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { isolationGuardName } from "#compiler/physical/ddl/isolation.ts"
import { snapshotGuardName } from "#compiler/physical/ddl/ledger.ts"
import { Engine, levelChain, ownBuilt, type RowDecoder } from "#compiler/plan/common.ts"
import { everySlice, planBasis, servedSnapshot } from "#compiler/plan/serve.ts"
import type { WriteStepResult } from "#compiler/runtime/write/steps.ts"
import type { Insert, SqlStatement, With } from "#compiler/sql/ast.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { AnyLogin, AnyLoginRole } from "#compiler/types/schema/world.ts"
import {
	isChangeSetValue,
	type ParsedChangeSet,
	parseChangeSet
} from "#compiler/write/changeset/value.ts"
import type { ArtifactStatement } from "#compiler/write/program/artifact.ts"
import { refusalFunctionName } from "#compiler/write/refusal.ts"
import { conservativeChange } from "#test/support/conservative.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	appliedWith,
	type CallFacts,
	member,
	openServedDb,
	type ServedDb
} from "#test/support/served-db.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import { testSql } from "#test/support/sql.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

import { ConnectionLost, type ServerError, type TransientReason } from "#adapter/errors/failures.ts"
import { paramText } from "#test/support/wire.ts"
import { fullWorld } from "#test/support/worlds.ts"

const round = (x: number): number => Math.round(x * 1000) / 1000

/**
 * The shared kit of the write, law, queue, refresh and families gates (R12, R33-R35, R40, the queue and families gates).
 *
 * "Use the same dataset, laws, result equality, and isolation in generated and handwritten baselines".
 * Every gate under bench/write and bench/queue installs a schema built by the public builders, its laws native
 * constraints (fin.md §7), and, where it has derived relations, their materialized views, through the query kit's
 * installFixture (bench/query/support/kit.ts), under a fresh schema name of the gate's own database. The schema value
 * is then rebuilt under that name, and its worlds over the rebuilt value, so a Db opened on one of its roles logs in as
 * the installed login and takes on the installed role. Two kinds of writer measure the same laws:
 *
 * - grizzle writers: a Db opened through its login's own served layer, as an application opens one, applying
 *   ChangeSets as members of a served workload. `observedChange` compiles a ChangeSet into a member of the Db's role's
 *   workload by the one compile `grizzle generate` commits, and runs each call of it through the runtime's own
 *   application of a served member (adapter/db/handles.ts memberOps: its SERIALIZABLE transaction, its flights and its
 *   classification, unchanged),
 *   one attempt per call, over the Db's session pool with every session it leases observed on the wire, so the
 *   attempt's failure is known by the statement (or COMMIT) that raised it, with its SQLSTATE and constraint. That is how a
 *   transient failure is attributed beyond its SQLSTATE (both 40001), and how a load retries and tallies a grizzle
 *   writer's attempts exactly as a hand-written writer's (bench/harness/load.ts withRetries);
 * - direct SQL writers: raw sessions in the same world, logged in as its login and taking on its role ("Direct SQL
 *   writers", at SERIALIZABLE), measured
 *   by the harness's measured transaction (bench/harness/transaction.ts), which times the deferred checks, the commit
 *   and the deferred-event memory apart (R12).
 *
 * Every session and DbLayer reaches PostgreSQL directly: no function here takes a port.
 *
 * A statement of a compiled program is named by its step (packages/engine/src/write/program/artifact.ts WriteStep), never by
 * its SQL text, and its form is read from its audited AST, both read off the program as the served compile compiles it
 * for the Db's role (adapter/served/forms.ts compiledWrite, over the role adapter/served/login.ts loginRoles gives). A
 * law is named by its declaration (S-NAMES, namesOf): nothing here re-derives a production name. The catalog readings
 * here are the observed side a gate's mechanism checks compare with the installation: the functions, triggers and
 * indexes it holds, and the table scans and row changes a transaction made so far (pg_stat_xact_user_tables, which
 * counts the scans a foreign key's RI check runs in the same backend).
 *
 * The rows of a catalog or statistics query come as the row type its SQL casts them to. The one row a query returns:
 * none or several is a defect of the gate's setup.
 */
export const oneRow = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<unknown> => {
	const [only, ...more] = rows
	if (only === undefined || more.length > 0) {
		throw new GateSetupError({ what: `${rows.length} rows where the gate reads one` })
	}
	return only
}

/** One text cell: the row of a catalog query that reads one name or definition. */
type TextRow = readonly [text: string]

/**
 * Installs `schema`, the template-named value of a gate's builder, complete, with the access paths its workload programs
 * request, under a fresh schema name, with its full world and the further `logins` the gate's own roles are in.
 */
export const installWrites = <S extends Parameters<typeof fullWorld>[0]>(
	schema: S,
	label: string,
	options: {
		readonly programs: Readonly<Record<string, unknown>>
		readonly logins: ReadonlyArray<AnyLogin>
	}
): Effect.Effect<
	Fixture<S>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> => installFixture(schema, options.programs, label, options.logins)

/**
 * A served Db of a role over the gate's schema rebuilt under the installed name (test/support/served-db.ts
 * ServedDb): its context, and `load` and `serve`, which compile programs into members of its role's workload; with that
 * role as the one served compile reads it (servedRoleOf), which a program's compiled form is read through.
 */
export interface OpenedDb extends ServedDb {
	readonly role: RoleContext
}

/**
 * `role` as the one compile `grizzle generate` commits reads it (adapter/served/compile.ts snapshotServedEntry): its
 * login's base owned, the snapshot `installed` reached read over the base's level as that compile reads it, the
 * installation's artifacts planned from what the snapshot records over every relation, and the login's roles compiled
 * over them (adapter/served/login.ts loginRoles), its own workload left out: a gate compiles its programs one at a time
 * (observedChange). A role of no login login(...) built, or of none the login holds, is a defect of the gate's setup.
 */
const servedRoleOf = (
	installed: Installed,
	role: AnyLoginRole
): Effect.Effect<RoleContext, CompileError | GateSetupError> =>
	Effect.gen(function* () {
		const login = builtLogin(role.login)
		if (login === undefined) {
			return yield* new GateSetupError({ what: "openDb: a role of no login login(...) built" })
		}
		const base = yield* fromEngine(ownBuilt(login.base))
		const owned = yield* fromEngine(ownLoginOver(login, base))
		const snapshot = yield* fromEngine(
			servedSnapshot(
				snapshotValue(installed.snapshot, installed.installation),
				levelChain(login.base.desc).length - 1
			)
		)
		const slice = everySlice(owned.base)
		const artifacts = yield* fromEngine(
			Engine.flatMap(
				planBasis(
					owned.base,
					snapshot.codes,
					slice,
					snapshot.derived.closed,
					snapshot.derived.textDomains,
					{ kind: "recorded", cycles: snapshot.derived.fkCycles }
				),
				artifactsOver
			)
		)
		const roles = yield* Effect.mapError(
			loginRoles(
				{ ...login, workload: [] },
				owned,
				{ slice, artifacts, over: () => Engine.ok(artifacts) },
				lawsAbove(snapshot)
			),
			(refused) => refused.error
		)
		const found = Option.getOrUndefined(Arr.findFirst(roles, (r) => r.role.name === role.role.name))
		if (found === undefined) {
			return yield* new GateSetupError({
				what: `openDb: the login holds no role ${role.role.name}`
			})
		}
		return found
	})

/** Whether a refusal of opening a served Db is the compile's of the login's own served file, a defect of the setup. */
const isServedRefusal = (error: ServedRefusal | OpenError): error is ServedRefusal =>
	!(error instanceof OpenError)

/**
 * A Db of `role`, a role over the gate's schema rebuilt under the installed name reached through the rebuilt login that
 * holds it, opened through a served layer of that login of its own, built in the scope (test/support/served-db.ts
 * openServedDb): an instance of the application, with its own session pool. The Db is typed by no particular role: a
 * gate applies through observedChange, or through members of its own the Db serves. It is opened with a token of no
 * claims, so a role reading no context opens as one reading one does: its Db holds no context fact either way. A login
 * whose own served file, or whose role, does not compile is a defect of the gate's setup.
 */
export const openDb = Effect.fn("openDb")(function* <F>(
	fixture: Fixture<F>,
	role: AnyLoginRole
): Effect.fn.Return<OpenedDb, OpenError, Scope.Scope> {
	const db = yield* Effect.catchIf(
		openServedDb(fixture.installed, role, {}),
		isServedRefusal,
		(refusal) => Effect.die(refusal)
	)
	const served = yield* Effect.orDie(servedRoleOf(fixture.installed, role))
	return { ...db, role: served }
})

/** A Db of the full world of `value`, the gate's schema rebuilt under the installed name (openDb). */
export const openFull = <F>(
	fixture: Fixture<F>,
	value: Parameters<typeof fullWorld>[0]
): Effect.Effect<OpenedDb, OpenError, Scope.Scope> =>
	openDb(fixture, fullWorld(value, {}).server.roles.app)

/**
 * The login role of the fixture's full world: what pg_stat_activity names a session of it by, the session user of every
 * grizzle writer and every direct writer of the gate.
 */
export const loginRoleOf = <S>(fixture: Fixture<S>): string =>
	fixture.installed.as(fixture.world.server).role

/** Owner statements, one at a time. */
export const owner = Effect.fn("owner")(function* (
	...sql: ReadonlyArray<string>
): Effect.fn.Return<void, SqlError, Substrate> {
	const s = yield* Substrate
	for (const statement of sql) {
		yield* s.admin.query(statement, [])
	}
})

/**
 * Runs `sql` as the owner in one transaction: a seed whose rows hold a deferred law, a native foreign key that no
 * DISABLE TRIGGER USER turns off, only together, which statements committed one by one would each break.
 */
export const ownerTransaction = Effect.fn("ownerTransaction")(function* (
	sql: ReadonlyArray<string>
): Effect.fn.Return<void, SqlError | TransactionRolledBack, Substrate> {
	const s = yield* Substrate
	yield* transaction(s.admin, sql)
})

/**
 * A fresh schema of the gate's database for a hand-written baseline, created by the owner; it is dropped with the
 * gate's database.
 */
export const baselineSchema = Effect.fn("baselineSchema")(function* (
	label: string
): Effect.fn.Return<string, SqlError, Substrate | Scope.Scope> {
	const s = yield* Substrate
	const schema = yield* s.schema({ ...freshSchema, label })
	return quoteIdent(schema)
})

/**
 * A statement of a compiled write program, named by its step (artifact.ts WriteStep) and its position in the program,
 * or the COMMIT that ends its transaction.
 */
export type StatementLabel =
	| WriteLabel
	| { readonly kind: "carrier"; readonly position: number; readonly step: "create" | "fill" }
	| { readonly kind: "analyze"; readonly position: number }
	| { readonly kind: "advance"; readonly position: number; readonly relation: string }
	| { readonly kind: "readBack"; readonly position: number; readonly name: string }
	| { readonly kind: "check"; readonly position: number; readonly entry: string }
	| {
			readonly kind: "single"
			readonly position: number
			readonly parts: ReadonlyArray<WriteLabel>
	  }
	| FamilyLabel
	| { readonly kind: "commit" }

/**
 * A family's statement of one kind (write/program/artifact.ts FamilyStep): its member's deletes, a tree's whole delete,
 * its owner's count update, its member's inserts, or its member's in-place updates, by the relation it writes.
 */
export interface FamilyLabel {
	readonly kind: "family"
	readonly position: number
	readonly relation: string
	readonly statement: "delete" | "deleteTree" | "count" | "insert" | "refill" | "update"
}

export type WriteLabel = {
	readonly kind: "write"
	readonly position: number
	readonly relation: string
	readonly result: WriteStepResult
}

const statementLabel = (statement: ArtifactStatement): StatementLabel => {
	const step = statement.step
	const position = statement.index
	switch (step.kind) {
		case "write":
			return { kind: "write", position, relation: step.relation, result: step.result }
		case "carrier":
			return { kind: "carrier", position, step: step.step }
		case "analyze":
			return { kind: "analyze", position }
		case "advance":
			return { kind: "advance", position, relation: step.relation }
		case "readBack":
			return { kind: "readBack", position, name: step.name }
		case "check":
			return { kind: "check", position, entry: step.entry }
		case "single":
			return {
				kind: "single",
				position,
				parts: Arr.map(step.parts, (p) => ({
					kind: "write",
					position,
					relation: p.step.relation,
					result: p.step.result
				}))
			}
		case "family":
			return { kind: "family", position, relation: step.relation, statement: step.statement }
		case "familyWrite":
			return {
				kind: "single",
				position,
				parts: Arr.map(step.parts, (p) => ({
					kind: "write",
					position,
					relation: p.relation,
					result: p.result
				}))
			}
	}
}

const writeText = (relation: string, result: WriteStepResult): string => {
	switch (result.kind) {
		case "insert":
			return result.of === "insert" ? `insert ${relation}` : `insert ${relation} (put)`
		case "delete":
			return result.mode === "exact" ? `delete ${relation}` : `delete ${relation} (displacing)`
		case "upsert":
		case "update":
		case "merge":
			return `${result.kind} ${relation}`
		case "spanClassify":
			return `classify ${relation}`
	}
}

/**
 * A label as text, for measures and retry tallies only: "insert Item", "delete Work (displacing)", "carrier fill",
 * "COMMIT". No check reads it.
 */
export const labelText = (label: StatementLabel): string => {
	switch (label.kind) {
		case "write":
			return writeText(label.relation, label.result)
		case "carrier":
			return `carrier ${label.step}`
		case "analyze":
			return "carrier analyze"
		case "advance":
			return `advance ${label.relation}`
		case "readBack":
			return `read ${label.name}`
		case "check":
			return `check ${label.entry}`
		case "single":
			return `single (${Arr.join(
				Arr.map(label.parts, (p) => writeText(p.relation, p.result)),
				", "
			)})`
		case "family":
			return `family ${label.statement} ${label.relation}`
		case "commit":
			return "COMMIT"
	}
}

/**
 * A statement of a compiled program as a gate reads it: its text as the runtime sends it, its label, and its audited
 * AST, which the text prints.
 */
export interface ObservedStatement {
	readonly sql: string
	/** Every text the runtime may send for it: its spec's, and its whole-relation form's when it has one. */
	readonly texts: ReadonlyArray<string>
	readonly label: StatementLabel
	readonly ast: SqlStatement
}

const observedStatement = (statement: ArtifactStatement): ObservedStatement => ({
	sql: statement.spec.sql,
	texts: [
		statement.spec.sql,
		...(statement.forms.kind === "chosen" ? [statement.forms.large.sql] : [])
	],
	label: statementLabel(statement),
	ast: statement.ast
})

/** The write labels of `relation` among `statements`, in position order. */
/** The family statements of a compiled program that write `relation`, in position order. */
export const familyWritesOf = (
	statements: ReadonlyArray<ObservedStatement>,
	relation: string
): ReadonlyArray<FamilyLabel> =>
	Arr.flatMap(statements, (s) =>
		s.label.kind === "family" && s.label.relation === relation ? [s.label] : []
	)

export const writesOf = (
	statements: ReadonlyArray<ObservedStatement>,
	relation: string
): ReadonlyArray<WriteLabel> =>
	Arr.flatMap(statements, (s) => {
		const label = s.label
		const writes = label.kind === "write" ? [label] : label.kind === "single" ? label.parts : []
		return Arr.filter(writes, (w) => w.relation === relation)
	})

/** Whether a write updates its relation in place: an UPDATE, an upsert or a MERGE. */
export const updatesInPlace = (write: WriteLabel): boolean =>
	write.result.kind === "update" || write.result.kind === "upsert" || write.result.kind === "merge"

/** A put realized as the pair: a displacing DELETE of the relation before the put's INSERT of it, by position. */
export const displacedThenInserted = (writes: ReadonlyArray<WriteLabel>): boolean =>
	Arr.some(
		writes,
		(d) =>
			d.result.kind === "delete" &&
			d.result.mode === "displacing" &&
			Arr.some(
				writes,
				(i) => i.result.kind === "insert" && i.result.of === "put" && d.position < i.position
			)
	)

/** A put realized in place: the relation's one write, which updates in place. */
export const writtenInPlace = (writes: ReadonlyArray<WriteLabel>): boolean => {
	const [only, ...more] = writes
	return only !== undefined && more.length === 0 && updatesInPlace(only)
}

/** The one statement of `statements` that `label` names; none or several is a defect of the gate's setup. */
export const theStatement = (
	statements: ReadonlyArray<ObservedStatement>,
	what: string,
	label: (label: StatementLabel) => boolean
): ObservedStatement => {
	const found = Arr.filter(statements, (s) => label(s.label))
	const [only, ...more] = found
	if (only === undefined || more.length > 0) {
		throw new GateSetupError({
			what: `${found.length} statements are ${what}: ${Arr.join(
				Arr.map(statements, (s) => labelText(s.label)),
				", "
			)}`
		})
	}
	return only
}

/**
 * The INSERTs a write statement runs: the statement itself when it is one, and every data-modifying WITH query of a
 * SELECT in it, read off the statement's audited AST.
 */
export const insertsOf = (ast: SqlStatement): ReadonlyArray<Insert> => {
	const found: Array<Insert> = []
	const collect = (w: With | undefined): void => {
		if (w !== undefined) {
			for (const c of w.ctes) {
				if (c.query.kind === "insert") {
					found.push(c.query)
				}
			}
		}
	}
	if (ast.kind === "insert") {
		found.push(ast)
		collect(ast.with)
	}
	transformStatement(ast, {
		...identityHooks,
		select: (s) => {
			collect(s.with)
			return s
		}
	})
	return found
}

/**
 * Where a grizzle application's one attempt failed on the wire: the program's statement, or its COMMIT, that the server
 * refused, with the SQLSTATE and the constraint it reported.
 */
export interface AttemptFailure {
	readonly statement: StatementLabel
	readonly sqlstate: string
	readonly constraint: Constraint
}

/**
 * An attempt's first wire failure: none (a TransientFailure or a rejection the runtime read from the statement's rows),
 * or the refusal of a statement or of COMMIT.
 */
export type FirstFailure =
	| { readonly kind: "none" }
	| { readonly kind: "refused"; readonly failure: AttemptFailure }

/**
 * The outcome of an observed application: the runtime's, or the reason of the TransientFailure that refused the
 * attempt. A load records a transient attempt as an outcome, and retries it, rather than ending the measurement.
 */
export type ObservedValue =
	| ApplyOutcome<ObservedReads>
	| { readonly kind: "transient"; readonly reason: TransientReason }

/**
 * An outcome's read-backs as the harness reads them: the record the ChangeSet's reads decoder assembled, each
 * read-back's rows by name.
 */
export type ObservedReads = Readonly<Record<string, ReadonlyArray<unknown>>>

const isRows = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

const observedReads = (reads: unknown): ObservedReads => {
	if (!isRecord(reads)) {
		throw new GateSetupError({ what: "the outcome's read-backs are no record" })
	}
	return Rec.fromEntries(
		Arr.map(Rec.toEntries(reads), ([name, rows]) => {
			if (!isRows(rows)) {
				throw new GateSetupError({ what: `the read-back ${name} delivered no rows` })
			}
			return [name, rows]
		})
	)
}

/** An outcome with its read-backs as the harness reads them. */
const observedOutcome = (value: ApplyOutcome<unknown>): ApplyOutcome<ObservedReads> =>
	value.kind === "invariant-rejected" || value.kind === "outside-world"
		? value
		: { ...value, reads: observedReads(value.reads) }

/** The rows of the read-back `name`; a read-back the ChangeSet does not declare is a defect of the gate's setup. */
export const readBackRows = (reads: ObservedReads, name: string): ReadonlyArray<unknown> => {
	const rows = reads[name]
	if (rows === undefined) {
		throw new GateSetupError({ what: `the outcome has no read-back ${name}` })
	}
	return rows
}

export interface ObservedApply {
	readonly value: ObservedValue
	/** The attempt as the load harness reads it. */
	readonly attempted: Attempted
	readonly failure: FirstFailure
}

export interface ObservedChange {
	/** One attempt with `params`, its call giving the facts the ChangeSet value holds (callFactsOf). */
	readonly apply: (params: ParamMap) => Effect.Effect<ObservedApply, ApplyError>
	/** One attempt with `params`, its call giving `facts` under its array members' ops and relations instead. */
	readonly applyWith: (
		facts: CallFacts,
		params: ParamMap
	) => Effect.Effect<ObservedApply, ApplyError>
	/** The program's statements, in position order. */
	readonly statements: ReadonlyArray<ObservedStatement>
}

/** How a probe's statement fails: the server refused it, or the session failed. */
export type ProbeFailure = ServerError | ConnectionLost

/** The attempt's transaction as a probe sees it: one statement at a time, inside it. */
export interface ProbeSession {
	readonly rows: (
		sql: string,
		params: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, ProbeFailure>
}

/**
 * What runs in an observed attempt's transaction just before its COMMIT: nothing, or a probe of the state the attempt
 * holds (the queue gate reads its predicate locks there). A probe runs only when every statement of the flight that
 * carries COMMIT succeeded, holding COMMIT back meanwhile, and its own failure fails the attempt at its COMMIT, rolled
 * back.
 */
export type BeforeCommit =
	| { readonly kind: "none" }
	| {
			readonly kind: "probe"
			readonly run: (session: ProbeSession) => Effect.Effect<void, ProbeFailure>
	  }

/**
 * One statement inside the session's open transaction, as a probe sends it: a pipeline of that one unnamed statement,
 * written straight to the session.
 */
const probeSession = (session: Session): ProbeSession => ({
	rows: (sql, params) =>
		Effect.callback<ReadonlyArray<ReadonlyArray<unknown>>, ProbeFailure>((resume) => {
			let answer: Answer | undefined
			session.send(
				[{ _tag: "statement", sql: testSql(sql), params: Arr.map(params, paramText) }],
				(...[, answered]) => {
					answer = answered
				},
				() => {
					if (answer?._tag === "result") {
						resume(Effect.succeed(answer.outcome.rows))
					} else if (answer?._tag === "refused") {
						resume(Effect.fail(answer.error))
					} else {
						resume(
							Effect.fail(new ConnectionLost({ operation: "query", ended: { by: "transport" } }))
						)
					}
				},
				() => undefined
			)
		})
})

/**
 * A refused query as the observed session reads it: a statement of the program or its COMMIT, found by its text, or a
 * text the program does not hold, which is a defect of the observation.
 */
type Attributed =
	| { readonly kind: "label"; readonly label: StatementLabel }
	| { readonly kind: "unattributed" }

/** What the observed session noted of an attempt's first refused query. */
type Noted =
	| { readonly kind: "refused"; readonly failure: AttemptFailure }
	| { readonly kind: "unattributed"; readonly sql: string }

/**
 * Attributes a sent query to the program's statement one of whose texts is identical to it, or to COMMIT: a lookup of
 * the program's own texts by identity, never a pattern.
 */
const attributor = (
	statements: ReadonlyArray<ObservedStatement>
): ((query: WireQuery) => Attributed) => {
	const bySql = new Map<string, ReadonlyArray<ObservedStatement>>()
	for (const s of statements) {
		for (const text of s.texts) {
			const prior = bySql.get(text)
			bySql.set(text, prior === undefined ? [s] : [...prior, s])
		}
	}
	return (query) => {
		if (query._tag === "control") {
			return query.control.kind === "end" && query.control.end === "COMMIT"
				? { kind: "label", label: { kind: "commit" } }
				: { kind: "unattributed" }
		}
		const found = bySql.get(query.sql)
		if (found === undefined) {
			return { kind: "unattributed" }
		}
		const [only, ...more] = found
		return only === undefined || more.length > 0
			? { kind: "unattributed" }
			: { kind: "label", label: only.label }
	}
}

const constraintOf = (name: string | undefined): Constraint =>
	name === undefined ? { kind: "none" } : { kind: "named", name }

/**
 * A session whose flights note their first refused query into `log`, by the program statement it was, and, with a
 * probe, run it in front of COMMIT: the flight is sent without its COMMIT, the probe runs, and COMMIT follows in a
 * flight of its own whose answer is the held-back query's.
 */
const observedSession = (
	session: Session,
	attribute: (query: WireQuery) => Attributed,
	log: Array<Noted>,
	beforeCommit: BeforeCommit
): Session => {
	const note = (query: WireQuery | undefined, answer: Answer): void => {
		if (log.length > 0 || answer._tag !== "refused" || query === undefined) {
			return
		}
		const attributed = attribute(query)
		log.push(
			attributed.kind === "label"
				? {
						kind: "refused",
						failure: {
							statement: attributed.label,
							sqlstate: answer.error.sqlstate,
							constraint: constraintOf(answer.error.constraint)
						}
					}
				: {
						kind: "unattributed",
						sql: query._tag === "control" ? controlText(session.controls, query.control) : query.sql
					}
		)
	}
	const send: Session["send"] = (pipeline, onAnswer, onEnd, onCut) => {
		const commitAt = pipeline.length - 1
		const last = pipeline[commitAt]
		if (
			beforeCommit.kind === "none" ||
			last?._tag !== "control" ||
			last.control.kind !== "end" ||
			last.control.end !== "COMMIT"
		) {
			return session.send(
				pipeline,
				(index, answer) => {
					note(pipeline[index], answer)
					onAnswer(index, answer)
				},
				onEnd,
				onCut
			)
		}
		const probe = beforeCommit.run
		let clean = true
		session.send(
			pipeline.slice(0, commitAt),
			(index, answer) => {
				if (answer._tag !== "result") {
					clean = false
				}
				note(pipeline[index], answer)
				onAnswer(index, answer)
			},
			() => {
				const ending = (end: "COMMIT" | "ROLLBACK", failure: ServerError | undefined) =>
					session.send(
						[{ _tag: "control", control: { kind: "end", end } }],
						(...[, answer]) => {
							const reported: Answer =
								failure === undefined ? answer : { _tag: "refused", error: failure }
							note(last, reported)
							onAnswer(commitAt, reported)
						},
						onEnd,
						onCut
					)
				if (!clean) {
					return ending("COMMIT", undefined)
				}
				Effect.runFork(
					Effect.match(probe(probeSession(session)), {
						onSuccess: () => ending("COMMIT", undefined),
						onFailure: (failure) => {
							if (failure._tag === "ServerError") {
								return ending("ROLLBACK", failure)
							}
							onAnswer(commitAt, { _tag: "failed" })
							onEnd()
						}
					})
				)
			},
			onCut
		)
	}
	return { ...session, send }
}

/** The pool `pool` with every session the attempt leases observed into `log`. */
const observedPool = (
	pool: SessionPool,
	attribute: (query: WireQuery) => Attributed,
	log: Array<Noted>,
	beforeCommit: BeforeCommit
): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session) => observedSession(session, attribute, log, beforeCommit))
})

const failedOf = (f: AttemptFailure): FailedOutcome =>
	f.statement.kind === "commit"
		? {
				kind: "failed",
				at: "commit",
				sqlstate: f.sqlstate,
				cause: causeOf(f.sqlstate),
				constraint: f.constraint
			}
		: {
				kind: "failed",
				at: "statement",
				statement: labelText(f.statement),
				sqlstate: f.sqlstate,
				cause: causeOf(f.sqlstate),
				constraint: f.constraint
			}

/**
 * The retry label of a grizzle attempt's failure for a gate that does not classify its retries: where it failed, and
 * its SQLSTATE.
 */
export const attemptLabel = (f: AttemptFailure): string =>
	`${labelText(f.statement)}: ${f.sqlstate}`

/**
 * The load harness's view of an observed attempt. Its outcome is `committed` for an accepted or no-change outcome, the
 * attempt's wire failure for an invariant-rejected or transient one that a server error decided, and `rolledBack` for
 * one the runtime read from the rows (a DO SELECT conflict witness, a same-key row) or refused before any SQL. A
 * transient attempt is the one the harness discards to retry, with its reason, its wire failure when it had one, and
 * the gate's label for that failure.
 */
const attemptedOf = (
	value: ObservedValue,
	failure: FirstFailure,
	labelOf: (f: AttemptFailure) => string
): Attempted => {
	const outcome: Outcome =
		value.kind === "invariant-rejected" || value.kind === "transient"
			? failure.kind === "none"
				? { kind: "rolledBack" }
				: failedOf(failure.failure)
			: { kind: "committed" }
	return {
		outcome,
		transient:
			value.kind === "transient"
				? {
						reason: value.reason._tag,
						failed: failure.kind === "none" ? undefined : failedOf(failure.failure),
						label: failure.kind === "none" ? undefined : labelOf(failure.failure)
					}
				: undefined
	}
}

/**
 * The facts a call of the served member of `change` gives: under each of its array members' op and relation, the facts
 * the value holds for that member, as the application that built it gives them. Its array members' facts are each
 * call's (adapter/served/load.ts ChangeCall), so a call that gives these runs the ChangeSet the value states.
 */
const callFactsOf = (change: ParsedChangeSet): CallFacts => {
	const facts: Record<string, Record<string, ReadonlyArray<unknown>>> = {}
	for (const stratum of change.desc.strata) {
		for (const m of stratum.members) {
			if (m.member.kind !== "array") {
				continue
			}
			const input = change.inputs.get(m.member.slot)
			if (input?.kind !== "array") {
				throw new GateSetupError({
					what: `observedChange: the array member ${m.member.slot} holds no facts`
				})
			}
			const byRelation = facts[m.op] ?? {}
			byRelation[m.relation] = input.facts
			facts[m.op] = byRelation
		}
	}
	return facts
}

/**
 * How an observed ChangeSet is applied: as the role's served workload serves it, or by the conservative realization of
 * its program the write oracle builds (conservativeChange), every stratum's statements in sequence.
 */
type Realization = "served" | "conservative"

/**
 * A ChangeSet value compiled into a member of the Db `opened`'s role's workload for observed application (see the head
 * of this file). `labelOf` turns an attempt's failure into the gate's retry label, and `beforeCommit` probes the
 * attempt's transaction just before its COMMIT, or not. Its statements are read off its program as the served compile
 * compiles it for the role, read-backs included; a refused query whose text is no statement of the program is a defect
 * of the observation, as is a ChangeSet that does not compile.
 */
export const observedChange = (
	opened: OpenedDb,
	changes: unknown,
	labelOf: (f: AttemptFailure) => string,
	beforeCommit: BeforeCommit
): Effect.Effect<ObservedChange> =>
	observedArtifact(opened, changes, labelOf, beforeCommit, "served")

/**
 * The same, applying the program's conservative realization, every stratum's statements in sequence, which the write
 * oracle compares the optimized artifact against.
 */
export const observedConservative = (
	opened: OpenedDb,
	changes: unknown,
	labelOf: (f: AttemptFailure) => string
): Effect.Effect<ObservedChange> =>
	observedArtifact(opened, changes, labelOf, { kind: "none" }, "conservative")

/**
 * The served member `loaded` with its program replaced by `entry`, the conservative realization of the program it
 * serves, its read-backs bound by the ChangeSet's own reads decoder `decoder`, each call read as the served member
 * reads it (adapter/served/load.ts ChangeCall), for the claims of the Db `ctx`.
 */
const realized = (
	ctx: ServedDbContext,
	loaded: Extract<LoadedMember, { readonly kind: "change" }>,
	entry: CompiledEntry,
	decoder: RowDecoder<unknown>
): Result.Result<LoadedMember, CompileError> =>
	Result.map(boundReads(entry, decoder), (reads) => ({
		name: loaded.name,
		kind: "change",
		variants: {
			kind: "change",
			change: { entry, reads, call: variantOf(ctx, loaded.variants).call }
		}
	}))

const observedArtifact = (
	opened: OpenedDb,
	changes: unknown,
	labelOf: (f: AttemptFailure) => string,
	beforeCommit: BeforeCommit,
	realization: Realization
): Effect.Effect<ObservedChange> =>
	Effect.orDie(
		Effect.gen(function* () {
			const parsed = parseChangeSet(changes)
			if (!isChangeSetValue(changes) || parsed === undefined) {
				return yield* new GateSetupError({ what: "observedChange: not a ChangeSet value" })
			}
			const compiled = yield* Effect.fromResult(
				compiledWrite(opened.role, changes, opened.ctx.claims)
			)
			const entry =
				realization === "served"
					? compiled
					: yield* Effect.fromResult(toResult(conservativeChange(compiled, opened.role)))
			const members = yield* opened.load({ change: changes })
			const loaded = member(members, "change")
			if (loaded.kind !== "change") {
				return yield* new GateSetupError({
					what: "observedChange: a ChangeSet served as no change"
				})
			}
			const running =
				realization === "served"
					? loaded
					: yield* Effect.fromResult(realized(opened.ctx, loaded, entry, changes.reads))
			const statements = Arr.map(entry.compiled.artifact.statements, observedStatement)
			const attribute = attributor(statements)
			const applyWith = (facts: CallFacts, params: ParamMap) =>
				Effect.suspend(() => {
					const log: Array<Noted> = []
					const observed: ServedDbContext = {
						...opened.ctx,
						pool: observedPool(opened.ctx.pool, attribute, log, beforeCommit)
					}
					const finish = (value: ObservedValue): Effect.Effect<ObservedApply> => {
						const first = log[0]
						if (first?.kind === "unattributed") {
							return Effect.die(
								new GateSetupError({
									what: `observedChange: the server refused a query the program does not hold: ${first.sql}`
								})
							)
						}
						const failure: FirstFailure =
							first === undefined ? { kind: "none" } : { kind: "refused", failure: first.failure }
						return Effect.succeed({
							value,
							failure,
							attempted: attemptedOf(value, failure, labelOf)
						})
					}
					return appliedWith(memberOps(observed, running), facts, params).pipe(
						Effect.map((value): ObservedValue => observedOutcome(value)),
						Effect.catchTag("TransientFailure", (error) =>
							Effect.succeed<ObservedValue>({ kind: "transient", reason: error.reason })
						),
						Effect.flatMap(finish)
					)
				})
			const own = callFactsOf(parsed)
			const observedChange: ObservedChange = {
				statements,
				apply: (params) => applyWith(own, params),
				applyWith
			}
			return observedChange
		})
	)

/**
 * The functions every installation has whatever it declares: the refusal function a write statement raises through
 * (packages/engine/src/write/refusal.ts), the guard every table's statement trigger calls (physical/ddl/isolation.ts)
 * and the snapshot guard every Db transaction calls behind the ledger's fence (physical/ddl/ledger.ts).
 */
const installationFunctions: ReadonlyArray<string> = [
	refusalFunctionName,
	isolationGuardName,
	snapshotGuardName
]

interface LawObjects {
	/** The functions of the fixture's schema but those every installation has: none, since every law is native. */
	readonly functions: ReadonlyArray<string>
	/** Its non-internal triggers, as `<table>.<trigger>`; PostgreSQL's internal foreign-key triggers are not listed. */
	readonly triggers: ReadonlyArray<string>
	/** Its indexes, by name. */
	readonly indexes: ReadonlyArray<string>
}

export const lawObjects = Effect.fn("lawObjects")(function* <S>(
	fixture: Fixture<S>
): Effect.fn.Return<LawObjects, SqlError, Substrate> {
	const s = yield* Substrate
	const schema = fixture.installed.schema
	/** Every function of the schema but those every installation has. */
	const functionRows = yield* s.admin.queryValues(
		"SELECT p.proname::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.proname <> ALL ($2::text[]) ORDER BY 1",
		[schema, installationFunctions]
	)
	const functions = Arr.map(trusted<ReadonlyArray<TextRow>>(functionRows), ([name]) => name)
	const triggerRows = yield* s.admin.queryValues(
		"SELECT c.relname::text || '.' || t.tgname::text FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1::text AND NOT t.tgisinternal ORDER BY 1",
		[schema]
	)
	const triggers = Arr.map(trusted<ReadonlyArray<TextRow>>(triggerRows), ([trigger]) => trigger)
	const indexRows = yield* s.admin.queryValues(
		"SELECT c.relname::text FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1::text ORDER BY 1",
		[schema]
	)
	const indexes = Arr.map(trusted<ReadonlyArray<TextRow>>(indexRows), ([index]) => index)
	return { functions, triggers, indexes }
})

export interface TableScans {
	readonly seq: number
	readonly idx: number
	readonly inserted: number
	readonly updated: number
	readonly deleted: number
}

type ScanRow = readonly [
	table: string,
	seq: string,
	idx: string,
	inserted: string,
	updated: string,
	deleted: string
]

/**
 * The scans and row changes this session's backend has counted and not yet reported on each table of `schema`, by table
 * name: pg_stat_xact_user_tables, which counts the work of an RI check the transaction's deferred events ran in this
 * backend as well as its own statements'. Since PostgreSQL 15 the counters are the backend's pending statistics, which
 * may still hold earlier transactions' counts until the backend reports them when idle, so a measurement reads them
 * twice inside one transaction and takes the difference (`scanDelta`); nothing is reported within a transaction. The
 * view lists every table of the schema, touched or not.
 */
const transactionScans = (
	session: RawSession,
	schema: string
): Effect.Effect<Readonly<Record<string, TableScans>>, SqlError> =>
	Effect.map(
		session.values(
			"SELECT relname::text, seq_scan::text, COALESCE(idx_scan, 0)::text, n_tup_ins::text, n_tup_upd::text, n_tup_del::text FROM pg_catalog.pg_stat_xact_user_tables WHERE schemaname = $1::text",
			[schema]
		),
		(rows) =>
			Rec.fromEntries(
				Arr.map(
					trusted<ReadonlyArray<ScanRow>>(rows),
					([table, seq, idx, inserted, updated, deleted]) => [
						table,
						{
							seq: Number(seq),
							idx: Number(idx),
							inserted: Number(inserted),
							updated: Number(updated),
							deleted: Number(deleted)
						}
					]
				)
			)
	)

/** One table's reading in `scans`; a table the reading does not list is a defect of the gate's setup. */
export const tableScans = (
	scans: Readonly<Record<string, TableScans>>,
	table: string
): TableScans => {
	const reading = scans[table]
	if (reading === undefined) {
		throw new GateSetupError({ what: `the statistics reading lists no table ${table}` })
	}
	return reading
}

/** The difference of two readings of `transactionScans`, by table. */
const scanDelta = (
	before: Readonly<Record<string, TableScans>>,
	after: Readonly<Record<string, TableScans>>
): Readonly<Record<string, TableScans>> =>
	Rec.fromEntries(
		Arr.map(Rec.toEntries(after), ([table, a]) => {
			const b = tableScans(before, table)
			return [
				table,
				{
					seq: a.seq - b.seq,
					idx: a.idx - b.idx,
					inserted: a.inserted - b.inserted,
					updated: a.updated - b.updated,
					deleted: a.deleted - b.deleted
				}
			]
		})
	)

/**
 * Runs `statements` on `session` in one SERIALIZABLE transaction with every constraint IMMEDIATE, each under EXPLAIN
 * ANALYZE, and rolls it back: the scans and row changes the statements and the native constraint checks they fired at
 * their ends made, by table. A foreign key's check is PostgreSQL's own, a query its RI trigger runs in this backend, so
 * the scans it makes are counted beside the statement's.
 */
export const probeScans = Effect.fn("probeScans")(function* <S>(
	session: RawSession,
	fixture: Fixture<S>,
	statements: ReadonlyArray<string>
): Effect.fn.Return<Readonly<Record<string, TableScans>>, SqlError | MalformedPlan> {
	yield* session.begin
	return yield* Effect.gen(function* () {
		yield* session.values("SET CONSTRAINTS ALL IMMEDIATE", [])
		const before = yield* transactionScans(session, fixture.installed.schema)
		for (const sql of statements) {
			yield* explain(session, sql, [], { wal: false, serialize: { kind: "off" } })
		}
		const after = yield* transactionScans(session, fixture.installed.schema)
		return scanDelta(before, after)
	}).pipe(Effect.ensuring(Effect.orDie(session.values("ROLLBACK", []))))
})

/**
 * What the backends of one role did while an effect ran, sampled from pg_stat_activity on an observer session: how many
 * server backends the role held, how many were running a statement, and how many waited on a lock. Like the harness's
 * lock-wait sampler (bench/harness/load.ts) it is an estimate within the sampling interval, and it needs no backend
 * pids.
 */
export interface RoleSamples {
	readonly samples: number
	readonly intervalMs: number
	readonly backends: Summary
	readonly active: Summary
	readonly lockWaiting: Summary
	readonly lockWaitSessionMs: number
}

type RoleRow = readonly [held: string, running: string, locked: string]

export const sampleRole = Effect.fn("sampleRole")(function* <A, E, R>(
	observer: RawSession,
	role: string,
	intervalMs: number,
	effect: Effect.Effect<A, E, R>
): Effect.fn.Return<{ readonly value: A; readonly role: RoleSamples }, E | SqlError, R> {
	const backends: Array<number> = []
	const active: Array<number> = []
	const waiting: Array<number> = []
	const sample = Effect.map(
		observer.values(
			"SELECT pg_catalog.count(*)::text, (pg_catalog.count(*) FILTER (WHERE state = 'active'::text))::text, (pg_catalog.count(*) FILTER (WHERE wait_event_type = 'Lock'::text))::text FROM pg_catalog.pg_stat_activity WHERE usename = $1::name AND datname = pg_catalog.current_database()",
			[role]
		),
		(rows) => {
			const [held, running, locked] = trusted<RoleRow>(oneRow(rows))
			backends.push(Number(held))
			active.push(Number(running))
			waiting.push(Number(locked))
		}
	)
	const fiber = yield* Effect.forkChild(
		Effect.forever(Effect.andThen(sample, Effect.sleep(Duration.millis(intervalMs))))
	)
	const value = yield* effect
	yield* Fiber.interrupt(fiber)
	if (backends.length === 0) {
		yield* sample
	}
	return {
		value,
		role: {
			samples: backends.length,
			intervalMs,
			backends: summarize(backends),
			active: summarize(active),
			lockWaiting: summarize(waiting),
			lockWaitSessionMs: Arr.reduce(waiting, 0, (a, b) => a + b) * intervalMs
		}
	}
})

export const timed = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<{ readonly ms: number; readonly value: A }, E, R> =>
	Effect.suspend(() => {
		const start = performance.now()
		return Effect.map(effect, (value) => ({ ms: round(performance.now() - start), value }))
	})

/**
 * Runs `effect` `n` times in order and summarizes the milliseconds each took, after `warmup` untimed runs. Fewer than
 * one sample is a defect of the gate.
 */
export const timedSamples = Effect.fn("timedSamples")(function* <A, E, R>(
	n: number,
	effect: (i: number) => Effect.Effect<A, E, R>,
	warmup: number
): Effect.fn.Return<{ readonly ms: Summary; readonly values: ReadonlyArray<A> }, E, R> {
	if (n < 1) {
		return yield* Effect.die(new RangeError(`timedSamples: ${n} samples`))
	}
	for (let i = 0; i < warmup; i++) {
		yield* effect(-1 - i)
	}
	const ms: Array<number> = []
	const values: Array<A> = []
	for (let i = 0; i < n; i++) {
		const t = yield* timed(effect(i))
		ms.push(t.ms)
		values.push(t.value)
	}
	return { ms: summarize(ms), values }
})

/** One statement of a measured transaction, run plainly, with its text parameters. */
export const plainStatement = (
	label: string,
	sql: string,
	params: ReadonlyArray<string>
): TransactionStatement => ({
	label,
	sql,
	params,
	explain: false
})

/**
 * A read-write measured SERIALIZABLE transaction of `statements`, ending `end`, with no deferred-event memory or WAL
 * reading.
 */
export const transactionOf = (
	statements: ReadonlyArray<TransactionStatement>,
	end: TransactionPlan["end"]
): TransactionPlan => ({
	readOnly: false,
	statements,
	end,
	deferredEvents: false,
	wal: false
})

/** The schema state of a gate that installs its fixture and loads its facts by the owner. */
export const loadedByOwner =
	"fresh install with its laws and workload access paths; facts loaded by the owner, then VACUUM (ANALYZE) of every table"

/** The cache state of a measured operation run once before its timed samples. */
export const warmedOnce = "warm: each measured operation runs once before its timed samples"

/**
 * The phase names the write gates time: a measured transaction's (bench/harness/transaction.ts), a whole operation as
 * the application sees it, and a load's.
 */
export const writePhases = [
	"beginMs",
	"executeMs",
	"deferredChecksMs",
	"commitMs",
	"rollbackMs",
	"operationMs"
] as const
