import type { WildKind } from "@grizzle/testing/lsw"
import { Array as Arr, Option } from "effect"
import { admissionOf } from "#test/support/worlds/model/session/catalog.ts"
import {
	payloadFacts,
	type TokenVerdict,
	tokenVerdict
} from "#test/support/worlds/model/session/claims.ts"

import {
	loginHolding,
	loginVerifies,
	migrating,
	roleOf
} from "#test/support/worlds/model/session/state.ts"

import type {
	Branch,
	InstallSpec,
	ModelState,
	ModelOpenStage,
	RoleRef,
	RoleSpec,
	SnapshotRef,
	Token
} from "#test/support/worlds/model/types.ts"

/**
 * The role a Db.open names in a version, with the login whose layer holds it, or undefined for any reference that is no
 * such role.
 */
const openedRole = (
	install: InstallSpec,
	ref: RoleRef
): { readonly role: RoleSpec; readonly login: string } | undefined => {
	if (ref.kind !== "own") {
		return undefined
	}
	const role = roleOf(install, ref.role)
	const login = loginHolding(install, ref.role)
	return role === undefined || login === undefined ? undefined : { role, login: login.name }
}

/**
 * The version whose role values and login layer an open given `snapshot` runs on: the drafted snapshot of folders a run
 * left pending is the new application version's, deployed before its migration finished, which holds the last pending
 * folder's roles and logins (main's ruling, execute/index.ts draftedTarget); every other snapshot is handed to the
 * current version's.
 */
const openedVersion = (state: ModelState, snapshot: SnapshotRef): InstallSpec =>
	snapshot === "drafted" && state.migrations.kind === "pending"
		? Arr.lastNonEmpty(state.migrations.folders)
		: state.install

/** How often the layer's verify ran: once when a token reached it, never before the token stage or without one. */
type VerifyCalls = 0 | 1

const refusedAt = (state: ModelState, stage: ModelOpenStage, verifyCalls: VerifyCalls): Branch => ({
	observation: { kind: "open-refused", stage, verifyCalls },
	next: state
})

/**
 * Whether the ledger admits a parsed snapshot: no folder unfinished, and its latest complete migration reached the
 * snapshot's fingerprint: the current installation's, never an older version's or another schema's; the drafted
 * snapshot of folders a run left pending not until they land, and with nothing pending the directory's snapshot.json
 * is the current installation's.
 */
const ledgerReached = (state: ModelState, snapshot: SnapshotRef): boolean => {
	if (migrating(state)) {
		return false
	}
	switch (snapshot) {
		case "current":
			return true
		case "stale":
		case "foreign":
			return false
		case "drafted":
			return state.migrations.kind === "applied"
	}
}

/**
 * The rest of Db.open once the role resolved on a layer its snapshot built, in packages/grizzle/src/adapter/db/open.ts's
 * order: the token, decoded on the host; then admission, whose ledger check refuses while a folder is unfinished and a
 * snapshot the ledger's latest complete migration did not reach (an older version's, another schema's, or pending
 * folders' drafted one) before its settings and privileges checks judge the catalog as tampered with; then
 * PostgreSQL's verdict on each refined claim. A Db opened allocates a session, judged by the snapshot its layer was
 * given, and a connection of its login's pool, reused when the pool already has one: every transaction takes on the role
 * and claims for itself alone. Admission's transaction may also be refused by SERIALIZABLE, which may refuse any
 * transaction once it summarizes old committed ones under load (README "Transactions and concurrency"): a retryable failure that opens
 * nothing (AdmissionTransient).
 */
const admitted = (
	state: ModelState,
	opened: { readonly role: RoleSpec; readonly login: string },
	verdict: TokenVerdict,
	verifyCalls: VerifyCalls,
	snapshot: SnapshotRef
): Arr.NonEmptyReadonlyArray<Branch> => {
	if (verdict.kind === "refused") {
		return [refusedAt(state, `token:${verdict.by}`, verifyCalls)]
	}
	if (!ledgerReached(state, snapshot)) {
		return [refusedAt(state, "ledger", verifyCalls), serializationRefused(state)]
	}
	const admission = admissionOf(state.install, state.tampered, opened.role, opened.login)
	return [
		admission === "admitted"
			? openedAs(state, opened, verdict, verifyCalls)
			: refusedAt(state, admission, verifyCalls),
		serializationRefused(state)
	]
}

/** Admission's transaction refused by SERIALIZABLE: nothing opened. */
const serializationRefused = (state: ModelState): Branch => ({
	observation: { kind: "transient", reason: "SerializationFailure" },
	next: state
})

/** Db.open past admission: refused at token for a refined claim PostgreSQL refuses, opened otherwise. */
const openedAs = (
	state: ModelState,
	opened: { readonly role: RoleSpec; readonly login: string },
	verdict: Extract<TokenVerdict, { readonly kind: "decoded" }>,
	verifyCalls: VerifyCalls
): Branch => {
	if (verdict.refinedRefused) {
		return refusedAt(state, "token:claims", verifyCalls)
	}
	const reused = Arr.findFirstIndex(state.connections, (c) => c.login === opened.login)
	const connection = Option.getOrElse(reused, () => state.connections.length)
	return {
		observation: { kind: "opened", session: state.sessions.length, verifyCalls },
		next: {
			...state,
			sessions: [
				...state.sessions,
				{
					kind: "db",
					login: opened.login,
					role: opened.role.name,
					facts: verdict.facts,
					connection,
					snapshot: {
						version: state.version,
						install: state.install,
						names: state.names,
						host: state.host
					}
				}
			],
			connections: Option.isSome(reused)
				? state.connections
				: [...state.connections, { login: opened.login, leftover: { kind: "clean" } }]
		}
	}
}

const noFactsVerdict: TokenVerdict = { kind: "decoded", facts: {}, refinedRefused: false }

/**
 * Db.open(Web.roles.member, { token }) on the layer of the role's login, given `snapshot` (README "Deploying",
 * "Permissions", "Security model"): a reference that is no installed role of a login meets no layer of its login, refused at
 * `role` whatever the snapshot; the layer refuses a snapshot whose fingerprint is not its content's at `schema`, and
 * may refuse an older version's or another schema's there too, when it is not of the login's base (the model keeps no
 * record of the base each was drafted for); a layer it builds leaves the token, admission and the refined claims, as
 * `admitted` orders them. The role, its login's verify and the contexts the token decodes through are the version's
 * the snapshot is handed to (openedVersion).
 */
export const openBranches = (
	state: ModelState,
	ref: RoleRef,
	token: Token,
	snapshot: SnapshotRef
): Arr.NonEmptyReadonlyArray<Branch> => {
	const version = openedVersion(state, snapshot)
	const opened = openedRole(version, ref)
	if (opened === undefined) {
		return [refusedAt(state, "role", 0)]
	}
	const verifies = loginVerifies(version, opened.login)
	const verifyCalls: VerifyCalls = verifies && token.kind !== "none" ? 1 : 0
	const opening = admitted(
		state,
		opened,
		tokenVerdict(version.base, opened.role, token, verifies),
		verifyCalls,
		snapshot
	)
	return snapshot === "stale" || snapshot === "foreign"
		? [refusedAt(state, "schema", 0), ...opening]
		: opening
}

/**
 * Db.open handed a JavaScript value its types refuse. As the role: no role(...) built it, refused at `schema`. As the
 * token, with the current snapshot: `undefined` is no token; a string reaches verify, whose JSON decode refuses a text
 * holding a NUL, and one holding a lone surrogate unless it is a JSON string, a payload that is no object; any other value
 * is no string, refused at `schema`; and an arbitrary value may be any of these.
 */
export const wildOpenBranches = (
	state: ModelState,
	at: { readonly kind: "open-role" } | { readonly kind: "open-token"; readonly role: string },
	wild: WildKind
): Arr.NonEmptyReadonlyArray<Branch> => {
	if (at.kind === "open-role") {
		return [refusedAt(state, "schema", 0)]
	}
	const opened = openedRole(state.install, { kind: "own", role: at.role })
	if (opened === undefined) {
		return [refusedAt(state, "role", 0)]
	}
	const verifies = loginVerifies(state.install, opened.login)
	const noToken = admitted(state, opened, noFactsVerdict, 0, "current")
	const asText = (payloads: ReadonlyArray<TokenVerdict>): Arr.NonEmptyReadonlyArray<Branch> =>
		verifies
			? [
					refusedAt(state, "token:verify", 1),
					...Arr.flatMap(payloads, (v) => admitted(state, opened, v, 1, "current"))
				]
			: noToken
	/** A string that is JSON of no object: a payload no claim object can be read from. */
	const notAnObject = payloadFacts(state.install.base, opened.role, null)
	switch (wild) {
		case "undefined":
			return noToken
		case "nul-character":
			return asText([])
		case "lone-surrogate":
			return asText([notAnObject])
		case "anything":
			return [refusedAt(state, "schema", 0), ...noToken, ...asText([notAnObject])]
		case "null":
		case "negative-zero":
		case "nan":
		case "infinity":
		case "bigint-for-number":
		case "number-for-bigint":
		case "symbol":
		case "function":
		case "proxy":
		case "throwing-getter":
			return [refusedAt(state, "schema", 0)]
	}
}
