import { Array as Arr, Effect, Option, Order, Result } from "effect"
import {
	type AdmissionExpectation,
	databaseQuery,
	extensionsQuery,
	installedExtensions,
	serverMismatches,
	serverRows
} from "#adapter/admission/expectation.ts"

import {
	type AttributeDifference,
	attributeDifferences,
	attributesQuery,
	type MembershipDifference,
	memberDifferences,
	membershipDifferences,
	membershipsQuery,
	membersQuery,
	type PolicyDifference,
	type PrivilegeDifference,
	policiesQuery,
	policyDifferences,
	privilegesParams,
	privilegesQuery,
	roleDifferences,
	rowSecurityDifferences,
	rowSecurityQuery,
	type SettingDifference,
	type SettingScope,
	settingDifferences,
	settingsQuery,
	textArray
} from "#adapter/admission/roles.ts"
import { servesSchema } from "#adapter/admission/snapshots.ts"
import type { ClaimValue } from "#adapter/db/claims.ts"
import { toResult } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	AdmissionFailed,
	type AdmissionMismatch,
	AdmissionRefused,
	AdmissionTransient,
	type BatchFailure,
	CatalogRowRefused,
	Deadlock,
	SerializationFailure,
	type ServerError,
	type StaleReason
} from "#adapter/errors/failures.ts"

import {
	sentAnswer,
	type ApartAnswer,
	type BatchOutcome,
	type BatchStatement,
	fenceReason,
	runAlongside,
	type Transaction
} from "#adapter/wire/batch.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { type CatalogQuery as CatalogQueryOf, catalogRows } from "#adapter/wire/statement.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import { roleExpectation } from "#compiler/deploy/admission/roles.ts"
import { snapshotMismatch } from "#compiler/deploy/admission/target.ts"
import { type LedgerStatements, ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { RoleDesc } from "#compiler/ir/desc.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { structuralRegex } from "#compiler/physical/ddl/domains.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { type InstallNames, loginIdentity } from "#compiler/physical/ddl/names.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { OwnedLogin } from "#compiler/schema/own.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"

/** A claim PostgreSQL refused: its context and field. */
interface RefusedClaim {
	readonly context: string
	readonly field: string
}

/**
 * What admission found that the opened Db keeps: every installed extension, by name, with the schema it lives in; the
 * refined claims that are no value of their domains, in the order given; and the ledger's statements, whose fence it
 * admitted the Db behind and every transaction of the Db takes again (wire/batch.ts prologueOf).
 */
interface Admitted {
	readonly extensions: ReadonlyMap<string, string>
	readonly refusedClaims: ReadonlyArray<RefusedClaim>
	readonly ledger: LedgerStatements
}

/**
 * What admission judges: the opened role's artifacts, its login, the snapshot the application knows, as Db.open was
 * given it, and every claim of the Db's context facts, none without a token.
 */
interface AdmissionInput {
	readonly artifacts: SchemaArtifacts
	readonly login: OwnedLogin
	readonly role: RoleDesc
	readonly snapshot: DeploySnapshot
	readonly claims: ReadonlyArray<ClaimValue>
}

/** Whether a claim's text is a value of a domain, the domain given as its qualified name. */
const claimValidQuery: CatalogQueryOf<boolean> = {
	sql: "SELECT pg_catalog.pg_input_is_valid($1::text, $2::text)::text AS c0",
	what: "whether a claim is a value of its domain",
	row: ([valid]) => (valid === "true" ? true : valid === "false" ? false : undefined)
}

/**
 * The domain a claim of type `t` is validated against (see the header): its contract's, as the installation names it,
 * or its structural pattern's, as the naming door names it; none for an unrefined type.
 */
const claimDomain = (t: ScalarType, names: InstallNames): Option.Option<ObjectName> => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		return Option.some(names.contractDomain(contract.name))
	}
	const regex = structuralRegex(t)
	return regex === undefined
		? Option.none()
		: Option.some({ schema: names.schema, name: identifierOf(identity.textDomain(regex.key)) })
}

/** Why admission could not run to a verdict. */
type AdmissionFailure = AdmissionFailed["failure"]

/**
 * The refusal SERIALIZABLE gives admission's transaction, from the server's report: no serial order (40001) or a
 * deadlock (40P01), or none for any other report.
 */
const serializableRefusal = (error: ServerError): Option.Option<AdmissionTransient["reason"]> =>
	error.sqlstate === sqlstates.serializationFailure
		? Option.some(SerializationFailure.make())
		: error.sqlstate === sqlstates.deadlockDetected
			? Option.some(Deadlock.make())
			: Option.none()

/**
 * Admission could not run to a verdict, as Db.open's reason: SERIALIZABLE's refusal of its transaction, exactly 40001
 * or 40P01, is retryable and changed nothing (AdmissionTransient); every other report, a session's failure, rows the
 * catalog cannot give and statements that do not compile are AdmissionFailed.
 */
export const admissionFailure = (failure: AdmissionFailure): OpenError => {
	switch (failure._tag) {
		case "ServerError":
			return OpenError.make({
				reason: Option.getOrElse(
					Option.map(serializableRefusal(failure), (reason): AdmissionFailed | AdmissionTransient =>
						AdmissionTransient.make({ reason, error: failure })
					),
					() => AdmissionFailed.make({ failure })
				)
			})
		case "ConnectionLost":
		case "CommitLost":
		case "DriverFailure":
		case "UnreadableAnswer":
		case "CatalogRowRefused":
		case "CompileError":
			return OpenError.make({ reason: AdmissionFailed.make({ failure }) })
	}
}

const fromResult = <A, E extends AdmissionFailure>(
	r: Result.Result<A, E>
): Effect.Effect<A, OpenError> =>
	Result.isSuccess(r) ? Effect.succeed(r.success) : Effect.fail(admissionFailure(r.failure))

/** A flight's failure as admission's: a refusal as the server's report, a session's failure as itself. */
const flightFailure = (failure: BatchFailure): AdmissionFailure => {
	switch (failure._tag) {
		case "BatchRefused":
		case "StaleName":
		case "CommitRefused":
			return failure.failure
		case "ConnectionLost":
		case "CommitLost":
		case "DriverFailure":
		case "UnreadableAnswer":
			return failure
	}
}

/** A refusal with every mismatch, if there is any. */
const refusedAt = (mismatches: ReadonlyArray<AdmissionMismatch>): Effect.Effect<void, OpenError> =>
	Arr.isReadonlyArrayNonEmpty(mismatches)
		? Effect.fail(OpenError.make({ reason: AdmissionRefused.make({ mismatches }) }))
		: Effect.void

/** The rows of a statement the server answered; its refusal is the admission's failure. */
const rowsOf = (
	answer: ApartAnswer
): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, OpenError> =>
	Result.isSuccess(answer)
		? Effect.succeed(answer.success.rows)
		: Effect.fail(admissionFailure(answer.failure))

/** The fence's transaction: the ledger's lock NOWAIT, then the guard's call, read-only. */
const fenceTransaction: Transaction = { access: "readOnly", end: "COMMIT" }
const fenceLockAt = 0

/**
 * The ledger stage's mismatch from the fence's transaction (see the header): none when it committed; the fence's
 * refusal (wire/batch.ts fenceReason), a migration running or stopped part-way or another latest target; and a ledger
 * that does not exist, refused at its lock with 42P01 or 3F000, which holds the schema's empty snapshot. Any other
 * failure is the admission's.
 */
const fenceMismatch = (
	schema: string,
	snapshot: DeploySnapshot,
	fenced: Result.Result<ReadonlyArray<BatchOutcome>, BatchFailure>
): Result.Result<Option.Option<AdmissionMismatch>, AdmissionFailure> => {
	if (Result.isSuccess(fenced)) {
		return Result.succeed(Option.none())
	}
	const failure = fenced.failure
	if (failure._tag !== "BatchRefused") {
		return Result.fail(flightFailure(failure))
	}
	const step = failure.index === fenceLockAt ? "lock" : "guard"
	const target = (observed: string): AdmissionMismatch => ({
		stage: "ledger",
		check: `ledger ${schema}.${ledgerTableName} latest complete target`,
		expected: snapshot.fingerprint,
		observed
	})
	const state = failure.failure.sqlstate
	if (
		step === "lock" &&
		(state === sqlstates.undefinedTable || state === sqlstates.invalidSchemaName)
	) {
		return Result.succeed(Option.some(target(emptyFingerprint(schema))))
	}
	/** The ledger's mismatch the fence's refusal names. */
	const mismatchOf = (reason: StaleReason): AdmissionMismatch => {
		switch (reason._tag) {
			case "Migrating":
				return {
					stage: "ledger",
					check: `ledger ${schema}.${ledgerTableName} migration`,
					expected: "none running or stopped part-way",
					observed: "running or stopped part-way"
				}
			case "Migrated":
				return target("another target")
		}
	}
	return Option.getOrElse(
		Option.map(fenceReason(step, failure.failure), (reason) =>
			Result.succeed(Option.some(mismatchOf(reason)))
		),
		() => Result.fail(failure.failure)
	)
}

const scopeText = (scope: SettingScope, role: string): string => {
	switch (scope) {
		case "database":
			return "database default"
		case "role":
			return `role ${role} default`
		case "roleInDatabase":
			return `role ${role} default in this database`
	}
}

const settingMismatch = (d: SettingDifference, role: string): AdmissionMismatch => {
	const check = `${scopeText(d.scope, role)} ${d.parameter}`
	switch (d.kind) {
		case "missing":
			return { stage: "settings", check, expected: d.value, observed: "<not set>" }
		case "unexpected":
			return { stage: "settings", check, expected: "<not set>", observed: d.value }
		case "differs":
			return { stage: "settings", check, expected: d.expected, observed: d.observed }
	}
}

const privilegeMismatch = (d: PrivilegeDifference, role: string): AdmissionMismatch => ({
	stage: "privileges",
	check: `role ${role} privilege ${d.privilege} on ${d.family} ${d.object}`,
	expected: d.kind === "missing" ? "held" : "not held",
	observed: d.kind === "missing" ? "not held" : "held"
})

const membershipMismatch = (d: MembershipDifference, role: string): AdmissionMismatch => ({
	stage: "privileges",
	check: `role ${role} membership in ${d.role}`,
	expected:
		d.kind === "unexpected"
			? "not granted, or granted WITH SET FALSE and no ADMIN"
			: "granted WITH INHERIT FALSE, SET TRUE and no ADMIN",
	observed:
		d.kind === "missing"
			? "not granted"
			: d.kind === "options"
				? "granted with other options"
				: "granted"
})

const memberMismatch = (d: MembershipDifference, role: string): AdmissionMismatch => ({
	stage: "privileges",
	check: `role ${role} member ${d.role}`,
	expected:
		d.kind === "unexpected"
			? "not a member, or a member WITH INHERIT FALSE, SET FALSE and no ADMIN"
			: "a member WITH INHERIT FALSE, SET TRUE and no ADMIN",
	observed:
		d.kind === "missing"
			? "not a member"
			: d.kind === "options"
				? "a member with other options"
				: "a member"
})

const attributeMismatch = (d: AttributeDifference, role: string): AdmissionMismatch => ({
	stage: "privileges",
	check: `role ${role} attribute ${d.attribute}`,
	expected: d.expected,
	observed: d.observed
})

const rowSecurityMismatch = (d: {
	readonly table: string
	readonly observed: string
}): AdmissionMismatch => ({
	stage: "privileges",
	check: `row security of ${d.table}`,
	expected: "enabled, not forced",
	observed: d.observed
})

const policyMismatch = (d: PolicyDifference, role: string): AdmissionMismatch => ({
	stage: "privileges",
	check: `policy ${d.policy.name} on ${d.policy.table} naming role ${role}`,
	expected: d.kind === "missing" ? "present" : "absent",
	observed: d.kind === "missing" ? "absent" : "present"
})

const byCheck: Order.Order<AdmissionMismatch> = Order.mapInput(
	Order.String,
	(m: AdmissionMismatch) => m.check
)

/** The flight's statements apart, in order. */
const databaseAt = 0
const extensionsAt = 1
const loginSettingsAt = 2
const loginPrivilegesAt = 3
const membershipsAt = 4
const roleSettingsAt = 5
const rolePrivilegesAt = 6
const policiesAt = 7
const loginAttributesAt = 8
const loginMembersAt = 9
const roleAttributesAt = 10
const roleMembershipsAt = 11
const roleMembersAt = 12
const rowSecurityAt = 13
/** The claims' statements follow, one per refined claim. */
const claimsAt = 14

/**
 * Admission at Db.open.
 *
 * Db.open admits the database on a session of the login's pool before it yields, in one flight (../wire/batch.ts
 * runAlongside): catalog reads apart, each answering whatever the others meet, then the fence's read-only transaction,
 * so every acquisition failure is OpenError. Opening never installs or changes anything, and never waits on a lock. It
 * requires, in the order a refusal reports its stage:
 *
 * 1. version, locale and capability (expectation.ts): PostgreSQL 19, the database's encoding and builtin C.UTF-8
 *    locale, and the extensions the schema needs;
 * 2. ledger: the snapshot is the application's (of the opened schema, up to its declared name, or of a schema the
 *    opened one is a lower level of, as the test installer's registration records: snapshots.ts servesSchema), and
 *    the fence passes, the very fence every transaction of the Db takes (physical/ddl/ledger.ts snapshotGuardDdl): the
 *    ledger's lock NOWAIT, which a migration holding or awaiting it refuses at once, then the guard of the snapshot's
 *    fingerprint, which refuses while a folder is unfinished, a run stopped part-way included, and when the latest
 *    complete folder's target is another. So no snapshot opens while a migration runs, and only the new one after it.
 *    A schema without its ledger holds its empty snapshot;
 * 3. settings and privileges (compiler/deploy/admission/roles.ts), judged against that snapshot: the login's defaults
 *    exactly as it installs them and the role's none, none for either in this database alone, the database's defaults
 *    the installation sets among the owner's others; what the login and the role can do to the schema's and the role
 *    schemas' objects exactly what it grants, through their own grants and every role they inherit from; their
 *    attributes (the login LOGIN NOINHERIT, the role NOLOGIN, neither SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or
 *    BYPASSRLS); their memberships over every grant of a pair (the login's exactly its roles', each WITH INHERIT FALSE,
 *    SET TRUE and no ADMIN, the role's none, any other only WITH SET FALSE and no ADMIN); their members (the role's
 *    exactly its login, the login's none, any other only inert); the policies naming the role exactly the snapshot's;
 *    and row security enabled, not forced, on every table the role writes through a query entry. The policies'
 *    predicates and the views' definitions are the drift check's.
 * 4. claims: each claim of the Db's context facts (../db/claims.ts) whose field's type is refined is a value of the
 *    domain the installation planned for it (compiler/physical/ddl/domains.ts): a contract's domain, named by the
 *    contract's name, or a structural pattern's, as the snapshot names it. PostgreSQL judges each, one
 *    `pg_input_is_valid` per claim in the same flight, since the host encoder checks a claim's base type alone: a claim
 *    outside its refinement would otherwise reach every view and write that reads it. An unrefined claim was validated
 *    whole by its encoder.
 *
 * A refusal is OpenError whose reason, AdmissionRefused, holds every mismatch, at the stage of the first in admission's
 * order. A database that fails
 * at the ledger stage is not judged further: its settings and privileges would be compared with a snapshot it does not
 * hold, and its claims with domains it may not hold. A statement the server or transport refuses is
 * OpenError{stage: "admission"} whose reason, AdmissionFailed, carries the failure.
 *
 * An admitted database yields the installed extensions and their schemas, against which a query's own capability
 * requirements are checked when it compiles (reader/reader.ts), and the claims PostgreSQL refused, which Db.open
 * refuses as ClaimRefused (../db/open.ts).
 *
 * Admits the database for `expectation`, the login and the role against the snapshot (see the header).
 */
export const admit = Effect.fn("admit")(function* (
	pool: SessionPool,
	expectation: AdmissionExpectation,
	input: AdmissionInput
): Effect.fn.Return<Admitted, OpenError> {
	const { artifacts, snapshot } = input
	const schema = artifacts.names.schema
	if (artifacts.world.kind !== "role") {
		return yield* fromResult(
			Result.fail(
				malformedDescription(SourceLoc("Db.open", []), "the artifacts of the opened role")
			)
		)
	}
	const role = artifacts.world.names.role
	const login = yield* fromResult(
		toResult(
			catchCompileError(() =>
				identifierOf(loginIdentity(artifacts.names.installation, input.login.name, input.login.loc))
			)
		)
	)
	const ledger = yield* fromResult(toResult(ledgerStatements(schema)))
	const statements = yield* fromResult(toResult(manifestStatements(snapshot)))
	const loginExpected = roleExpectation(statements, schema, login)
	const roleExpected = roleExpectation(statements, schema, role)
	/** The refined claims, each with its domain. */
	const judged: Array<{ readonly claim: ClaimValue; readonly domain: ObjectName }> = []
	for (const claim of input.claims) {
		const domain = claimDomain(claim.type, artifacts.names)
		if (Option.isSome(domain)) {
			judged.push({ claim, domain: domain.value })
		}
	}
	const flight: ReadonlyArray<BatchStatement> = [
		{ sql: databaseQuery.sql, params: [] },
		{ sql: extensionsQuery.sql, params: [] },
		{ sql: settingsQuery.sql, params: [login] },
		{ sql: privilegesQuery.sql, params: privilegesParams(loginExpected) },
		{ sql: membershipsQuery.sql, params: [login] },
		{ sql: settingsQuery.sql, params: [role] },
		{ sql: privilegesQuery.sql, params: privilegesParams(roleExpected) },
		{ sql: policiesQuery.sql, params: [role, schema] },
		{ sql: attributesQuery.sql, params: [login] },
		{ sql: membersQuery.sql, params: [login, schema] },
		{ sql: attributesQuery.sql, params: [role] },
		{ sql: membershipsQuery.sql, params: [role] },
		{ sql: membersQuery.sql, params: [role, schema] },
		{ sql: rowSecurityQuery.sql, params: [schema, textArray(roleExpected.secured)] },
		...Arr.map(judged, (j): BatchStatement => ({
			sql: claimValidQuery.sql,
			params: [j.claim.text, printObjectName(j.domain)]
		}))
	]
	const fence: ReadonlyArray<BatchStatement> = [
		{ sql: ledger.fence.text, params: [] },
		{ sql: ledger.guard.text, params: [snapshot.fingerprint] }
	]
	const flown = yield* Effect.scoped(
		Effect.flatMap(
			Effect.mapError(pool.lease, (reason) => OpenError.make({ reason })),
			(session) =>
				Effect.mapError(runAlongside(session, flight, fence, fenceTransaction), admissionFailure)
		)
	)
	const answers = flown.alone
	const server = yield* fromResult(
		serverRows({
			database: yield* rowsOf(sentAnswer(answers, databaseAt)),
			extensions: yield* rowsOf(sentAnswer(answers, extensionsAt))
		})
	)
	const fenced = yield* fromResult(fenceMismatch(schema, snapshot, flown.framed))
	const before: Array<AdmissionMismatch> = [...serverMismatches(server, expectation)]
	/** A snapshot of another schema, or a ledger the fence refuses: the database does not hold this snapshot. */
	const wrong = snapshotMismatch(snapshot, {
		fingerprint: servesSchema(snapshot, artifacts.owned)
			? snapshot.theory.schema
			: artifacts.fingerprint,
		schema
	})
	if (wrong !== undefined) {
		before.push({
			stage: "ledger",
			check: "the application's snapshot",
			expected: wrong,
			observed: "a snapshot of another schema"
		})
	} else if (Option.isSome(fenced)) {
		before.push(fenced.value)
	}
	yield* refusedAt(before)
	const rowsAt = <Row>(query: CatalogQueryOf<Row>, at: number) =>
		Effect.flatMap(rowsOf(sentAnswer(answers, at)), (rows) => fromResult(catalogRows(query, rows)))
	const loginSettings = yield* rowsAt(settingsQuery, loginSettingsAt)
	const loginPrivileges = yield* rowsAt(privilegesQuery, loginPrivilegesAt)
	const memberships = yield* rowsAt(membershipsQuery, membershipsAt)
	const roleSettings = yield* rowsAt(settingsQuery, roleSettingsAt)
	const rolePrivileges = yield* rowsAt(privilegesQuery, rolePrivilegesAt)
	const policies = yield* rowsAt(policiesQuery, policiesAt)
	const loginAttributes = yield* rowsAt(attributesQuery, loginAttributesAt)
	const loginMembers = yield* rowsAt(membersQuery, loginMembersAt)
	const roleAttributes = yield* rowsAt(attributesQuery, roleAttributesAt)
	const roleMemberships = yield* rowsAt(membershipsQuery, roleMembershipsAt)
	const roleMembers = yield* rowsAt(membersQuery, roleMembersAt)
	const rowSecurity = yield* rowsAt(rowSecurityQuery, rowSecurityAt)
	yield* refusedAt(
		Arr.sort(
			[
				...Arr.map(settingDifferences(loginSettings, loginExpected), (d) =>
					settingMismatch(d, login)
				),
				...Arr.map(roleDifferences(roleSettings, roleExpected), (d) => settingMismatch(d, role)),
				...Arr.map(loginPrivileges, (d) => privilegeMismatch(d, login)),
				...Arr.map(rolePrivileges, (d) => privilegeMismatch(d, role)),
				...Arr.map(attributeDifferences(loginAttributes, loginExpected), (d) =>
					attributeMismatch(d, login)
				),
				...Arr.map(attributeDifferences(roleAttributes, roleExpected), (d) =>
					attributeMismatch(d, role)
				),
				...Arr.map(membershipDifferences(memberships, loginExpected), (d) =>
					membershipMismatch(d, login)
				),
				...Arr.map(membershipDifferences(roleMemberships, roleExpected), (d) =>
					membershipMismatch(d, role)
				),
				...Arr.map(memberDifferences(loginMembers, loginExpected), (d) => memberMismatch(d, login)),
				...Arr.map(memberDifferences(roleMembers, roleExpected), (d) => memberMismatch(d, role)),
				...Arr.map(policyDifferences(policies, roleExpected), (d) => policyMismatch(d, role)),
				...Arr.map(rowSecurityDifferences(rowSecurity, roleExpected), rowSecurityMismatch)
			],
			byCheck
		)
	)
	const refusedClaims: Array<RefusedClaim> = []
	for (const [i, j] of judged.entries()) {
		const [valid, ...more] = yield* rowsAt(claimValidQuery, claimsAt + i)
		if (valid === undefined || more.length > 0) {
			return yield* fromResult(Result.fail(CatalogRowRefused.make({ what: claimValidQuery.what })))
		}
		if (!valid) {
			refusedClaims.push({ context: j.claim.context, field: j.claim.field })
		}
	}
	return { extensions: installedExtensions(server.extensions), refusedClaims, ledger }
})
