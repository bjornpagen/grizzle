import { Array as Arr, Order, Record as Rec } from "effect"
import { factKey } from "#test/support/worlds/model/host.ts"
import type {
	ClaimsSetting,
	ConnectionState,
	ContextFacts,
	HostFact,
	HostState,
	ModelState,
	SessionState
} from "#test/support/worlds/model/types.ts"

/**
 * A model state's canonical form: one text per state, equal only when two states are one state. Every part is a
 * length-framed atom, so concatenation is injective whatever characters a value holds; sets (a relation's facts, a
 * session's context facts, the relations of a state) are sorted, sequences (sessions, connections) keep their order.
 * The installation, its names, its host schema and each catalog perturbation are interned by object identity: two equal
 * ones held as two objects only cost a state explored twice, never two states taken for one.
 */

/** A text as an atom: its length, a colon, the text. */
const atom = (text: string): string => `${text.length}:${text}`

/** A set of facts' canonical form: their identities sorted. */
const factsKey = (facts: ReadonlyArray<HostFact>): string =>
	atom(
		Arr.join(
			Arr.sort(
				Arr.map(facts, (fact) => atom(factKey(fact))),
				Order.String
			),
			""
		)
	)

const byName = Order.mapInput(
	Order.String,
	(entry: readonly [string, ReadonlyArray<HostFact>]) => entry[0]
)

/** Relations of facts by name, as sets: names sorted, each relation's facts a set. */
const relationsKey = (entries: ReadonlyArray<readonly [string, ReadonlyArray<HostFact>]>): string =>
	atom(
		Arr.join(
			Arr.map(Arr.sort(entries, byName), ([name, facts]) => `${atom(name)}${factsKey(facts)}`),
			""
		)
	)

const realityKey = (reality: HostState): string => relationsKey([...reality.entries()])

const contextFactsKey = (facts: ContextFacts): string =>
	relationsKey(Arr.map(Rec.toEntries(facts), ([name, fact]) => [name, [fact]] as const))

const claimsSettingKey = (setting: ClaimsSetting): string => {
	switch (setting.kind) {
		case "facts":
			return `f${atom(setting.scope)}${contextFactsKey(setting.facts)}`
		case "malformed":
			return `m${atom(setting.scope)}${atom(setting.text)}`
	}
}

const sessionKey = (session: SessionState): string => {
	switch (session.kind) {
		case "db":
			return Arr.join(
				[
					"d",
					atom(session.login),
					atom(session.role),
					contextFactsKey(session.facts),
					atom(String(session.connection)),
					atom(String(session.snapshot.version))
				],
				""
			)
		case "direct": {
			const current = session.current.kind === "login" ? "l" : `r${atom(session.current.role)}`
			const claims =
				session.claims.kind === "none" ? "n" : `s${claimsSettingKey(session.claims.setting)}`
			return `x${atom(session.login)}${current}${claims}${atom(session.isolation)}${atom(session.transaction)}${realityKey(session.view)}`
		}
		case "closed":
			return `c${atom(session.was)}`
	}
}

const connectionKey = (connection: ConnectionState): string => {
	const leftover = connection.leftover
	switch (leftover.kind) {
		case "clean":
			return `${atom(connection.login)}c`
		case "role":
			return `${atom(connection.login)}r${atom(leftover.role)}`
		case "claims":
			return `${atom(connection.login)}s${atom(leftover.text)}`
	}
}

const byLogin = Order.mapInput(Order.String, (entry: readonly [string, number]) => entry[0])

/** The version each login was created at, by login: names sorted. */
const loginsCreatedKey = (created: Readonly<Record<string, number>>): string =>
	atom(
		Arr.join(
			Arr.map(
				Arr.sort(Rec.toEntries(created), byLogin),
				([login, version]) => `${atom(login)}${atom(String(version))}`
			),
			""
		)
	)

/**
 * The canonical form of a model state, for one exploration: it interns the objects its states hold by identity,
 * numbering each in the order it meets them, so two states have one form only among the forms of one exploration.
 */
export const canonicalForms = (): ((state: ModelState) => string) => {
	const identities = new WeakMap<object, number>()
	let minted = 0
	const identityOf = (value: object): string => {
		const known = identities.get(value)
		if (known !== undefined) {
			return atom(String(known))
		}
		minted++
		identities.set(value, minted)
		return atom(String(minted))
	}
	return (state) =>
		Arr.join(
			[
				identityOf(state.install),
				identityOf(state.names),
				identityOf(state.host),
				atom(String(state.version)),
				loginsCreatedKey(state.loginsCreated),
				realityKey(state.reality),
				relationsKey(Rec.toEntries(state.derived)),
				atom(Arr.join(Arr.map(state.sessions, sessionKey), "")),
				atom(Arr.join(Arr.map(state.connections, connectionKey), "")),
				atom(Arr.join(Arr.map(state.tampered, identityOf), "")),
				state.migrations.kind === "applied"
					? "a"
					: `p${atom(state.migrations.ledger)}${atom(Arr.join(Arr.map(state.migrations.folders, identityOf), ""))}`
			],
			""
		)
}
