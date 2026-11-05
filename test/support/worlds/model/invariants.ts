import { Array as Arr, Record } from "effect"
import { sameValues, violations } from "#test/pg/laws/families/model.ts"
import { entryRows } from "#test/support/worlds/model/host.ts"
import { factsIn, loginOf, roleOf, staleDb } from "#test/support/worlds/model/session/state.ts"
import type {
	InvariantViolation,
	ModelState,
	ModelSession
} from "#test/support/worlds/model/types.ts"

/**
 * The role a session holds, with its login: a Db's role, a direct writer's role once it took one on, else none. A Db
 * whose snapshot a migration moved past holds its role at no version of the installation (staleDb).
 */
const heldRole = (
	state: ModelState,
	s: ModelSession
): { readonly login: string; readonly role: string } | undefined => {
	switch (s.kind) {
		case "db":
			return staleDb(state, s) ? undefined : { login: s.login, role: s.role }
		case "direct":
			return s.current.kind === "role" ? { login: s.login, role: s.current.role } : undefined
		case "closed":
			return undefined
	}
}

/**
 * The invariants a state keeps, restating README "Permissions", "Security model", "Deploying" and "Rules":
 *
 * - laws-hold: reality breaks no law, whoever wrote it;
 * - claims-end-with-transaction and role-ends-with-transaction: a pooled connection carries neither claims nor a role
 *   past the transaction that set them, so no request's world reaches the next one on that connection;
 * - login-isolation: no session holds a role of another login, the login being the trust boundary;
 * - deleted-means-gone: a whole entry over an ordinary relation shows exactly reality's facts, so a deleted fact is gone
 *   from every world at once; only a derived relation keeps one, until its refresh.
 * A Db whose snapshot a migration moved past is judged by neither: it holds no role of this version (staleDb).
 *
 * No hidden value and least privilege are judged on what the real system shows, not on the model's state.
 */
export const invariantsOf = (state: ModelState): ReadonlyArray<InvariantViolation> => {
	const laws = Arr.map(violations(state.host, state.reality), (v): InvariantViolation => ({
		invariant: "laws-hold",
		detail: `reality breaks law ${v.law}`
	}))
	const leftovers = Arr.flatMap(state.connections, (c, i): ReadonlyArray<InvariantViolation> => {
		switch (c.leftover.kind) {
			case "clean":
				return []
			case "role":
				return [
					{
						invariant: "role-ends-with-transaction",
						detail: `connection ${i} of ${c.login} is still ${c.leftover.role}`
					}
				]
			case "claims":
				return [
					{
						invariant: "claims-end-with-transaction",
						detail: `connection ${i} of ${c.login} still holds claims`
					}
				]
		}
	})
	const isolation = Arr.flatMap(state.sessions, (s, i): ReadonlyArray<InvariantViolation> => {
		const held = heldRole(state, s)
		if (
			held === undefined ||
			loginOf(state.install, held.login)?.roles.includes(held.role) === true
		) {
			return []
		}
		return [
			{ invariant: "login-isolation", detail: `session ${i} of ${held.login} holds ${held.role}` }
		]
	})
	const gone = Arr.flatMap(state.sessions, (s, i): ReadonlyArray<InvariantViolation> => {
		const role = s.kind === "db" && !staleDb(state, s) ? roleOf(state.install, s.role) : undefined
		if (s.kind !== "db" || role === undefined) {
			return []
		}
		return Arr.flatMap(
			Record.toEntries(role.entries),
			([name, entry]): ReadonlyArray<InvariantViolation> => {
				if (
					entry.kind !== "whole" ||
					!Arr.some(state.install.base.relations, (r) => r.name === entry.relation)
				) {
					return []
				}
				const stored = factsIn(state.reality, entry.relation)
				const shown = entryRows(state, role.name, name, s.facts)
				const same =
					Arr.every(shown, (f) => Arr.some(stored, (g) => sameValues(f, g))) &&
					Arr.every(stored, (g) => Arr.some(shown, (f) => sameValues(f, g)))
				return same
					? []
					: [
							{
								invariant: "deleted-means-gone",
								detail: `session ${i} sees ${name} apart from reality's ${entry.relation}`
							}
						]
			}
		)
	})
	return [...laws, ...leftovers, ...isolation, ...gone]
}
