import type { WildKind } from "@bjornpagen/testing/lsw"
import { regex } from "arkregex"
import { Array as Arr, Option } from "effect"
import {
	payloadFacts,
	type TokenVerdict,
	tokenVerdict
} from "#test/support/worlds/model/session/claims.ts"

import { loginHolding, loginVerifies, roleOf } from "#test/support/worlds/model/session/state.ts"

import type {
	Branch,
	InstallSpec,
	ModelState,
	ModelOpenStage,
	RoleRef,
	RoleSpec,
	SnapshotGuard,
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

/** How often the layer's verify ran: once when a token reached it, never before the token stage or without one. */
type VerifyCalls = 0 | 1

const refusedAt = (state: ModelState, stage: ModelOpenStage, verifyCalls: VerifyCalls): Branch => ({
	observation: { kind: "open-refused", stage, verifyCalls },
	next: state
})

/**
 * The rest of Db.open once the role resolved on a layer, in packages/grizzle/src/adapter/db/open.ts's order: the token,
 * decoded on the host, and nothing more, since Db.open contacts nothing. A Db opened allocates a session, judged on the
 * host by the current version, whose snapshot it was opened with, and a connection of its login's pool, reused when
 * the pool already has one: every transaction takes on the role and claims for itself alone. Its guard holds the ledger
 * to that version when the layer was given the current snapshot, and to a snapshot no migration lands otherwise
 * (SnapshotGuard). A refined claim PostgreSQL refuses opens the Db all the same (ClaimsJudged).
 */
const openedOrRefused = (
	state: ModelState,
	opened: { readonly role: RoleSpec; readonly login: string },
	verdict: TokenVerdict,
	verifyCalls: VerifyCalls,
	guard: SnapshotGuard
): Branch => {
	if (verdict.kind === "refused") {
		return refusedAt(state, `token:${verdict.by}`, verifyCalls)
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
					claims: verdict.refinedRefused ? "refused" : "admitted",
					connection,
					snapshot: {
						version: state.version,
						install: state.install,
						names: state.names,
						host: state.host
					},
					guard
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
 * Whether a name keeps the declared-name rule a role's name is served by (README "Names come from your code"): ASCII
 * letters, digits and underscores, a letter first, at most 63 bytes, PostgreSQL's identifier bound. Every name the model
 * draws is ASCII, so its length in characters is its length in bytes.
 */
const declaredNamePattern = regex("^[A-Za-z][A-Za-z0-9_]*$")

const declaredName = (name: string): boolean => declaredNamePattern.test(name) && name.length <= 63

/**
 * Db.open(Web.roles.member, { token }) on the layer of the role's login, given `snapshot` (README "Deploying",
 * "Permissions", "Security model"): a reference that is no installed role of a login meets no layer of its login, refused at
 * `role` whatever the snapshot, but for one whose name breaks the declared-name rule (declaredName), which no served
 * file can hold: the served compile of its login refuses it, so no application holds a role token of it to hand Db.open,
 * and the open is compile-refused; the layer compares nothing with the snapshot it is given, but may refuse an older
 * version's or another schema's at `schema`, as the roles and programs compile under its codes (the model keeps no
 * record of the codes each was drafted with); a layer it builds leaves the token, as openedOrRefused orders it. The
 * role, its login's verify and the contexts the token decodes through are the current version's.
 */
export const openBranches = (
	state: ModelState,
	ref: RoleRef,
	token: Token,
	snapshot: SnapshotRef
): Arr.NonEmptyReadonlyArray<Branch> => {
	const opened = openedRole(state.install, ref)
	if (opened === undefined) {
		return ref.kind === "nonexistent" && !declaredName(ref.name)
			? [{ observation: { kind: "compile-refused" }, next: state }]
			: [refusedAt(state, "role", 0)]
	}
	const verifies = loginVerifies(state.install, opened.login)
	const verifyCalls: VerifyCalls = verifies && token.kind !== "none" ? 1 : 0
	const opening = openedOrRefused(
		state,
		opened,
		tokenVerdict(state.install.base, opened.role, token, verifies),
		verifyCalls,
		snapshot === "current" ? "held" : "never"
	)
	return snapshot === "current" ? [opening] : [refusedAt(state, "schema", 0), opening]
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
	const noToken: Arr.NonEmptyReadonlyArray<Branch> = [
		openedOrRefused(state, opened, noFactsVerdict, 0, "held")
	]
	const asText = (payloads: ReadonlyArray<TokenVerdict>): Arr.NonEmptyReadonlyArray<Branch> =>
		verifies
			? [
					refusedAt(state, "token:verify", 1),
					...Arr.map(payloads, (v) => openedOrRefused(state, opened, v, 1, "held"))
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
