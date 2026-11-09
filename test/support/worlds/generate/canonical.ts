import { Array as Arr, Order, Record as Rec } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { type Atom, type ValueIdentity, valueIdentityOrder } from "#test/support/kernel/identity.ts"
import { factKey } from "#test/support/worlds/model/host.ts"
import type {
	ClaimsSetting,
	ConnectionState,
	ContextFacts,
	HostFact,
	HostState,
	ModelState,
	ModelSession
} from "#test/support/worlds/model/types.ts"

/**
 * A model state's canonical form: one identity per state (kernel/identity.ts), equal atom for atom only when two states
 * are one state. Every variable-length part is its length followed by its items, so the atoms of the parts in sequence
 * are self-delimiting whatever a value holds; sets (a relation's facts, a session's context facts, the relations of a
 * state) are sorted, sequences (sessions, connections) keep their order. The installation, its names, its host schema
 * and each catalog perturbation are interned by object identity: two equal ones held as two objects only cost a state
 * explored twice, never two states taken for one.
 */
type Writer = Array<Atom>

/** `items` as a list: its length, then each item as `write` writes it. */
const list = <A>(
	out: Writer,
	items: ReadonlyArray<A>,
	write: (out: Writer, item: A) => void
): void => {
	out.push(items.length)
	for (const item of items) {
		write(out, item)
	}
}

/** An identity as a list of its atoms. */
const identity = (out: Writer, atoms: ValueIdentity): void => {
	out.push(atoms.length)
	appendAll(out, atoms)
}

/** A set of facts' canonical form: their identities sorted. */
const facts = (out: Writer, set: ReadonlyArray<HostFact>): void =>
	list(out, Arr.sort(Arr.map(set, factKey), valueIdentityOrder), identity)

const byName = Order.mapInput(
	Order.String,
	(entry: readonly [string, ReadonlyArray<HostFact>]) => entry[0]
)

/** Relations of facts by name, as sets: names sorted, each relation's facts a set. */
const relations = (
	out: Writer,
	entries: ReadonlyArray<readonly [string, ReadonlyArray<HostFact>]>
): void =>
	list(out, Arr.sort(entries, byName), (o, [name, set]) => {
		o.push(name)
		facts(o, set)
	})

const reality = (out: Writer, state: HostState): void => relations(out, [...state.entries()])

const contextFacts = (out: Writer, set: ContextFacts): void =>
	relations(
		out,
		Arr.map(Rec.toEntries(set), ([name, fact]) => [name, [fact]] as const)
	)

const claimsSetting = (out: Writer, setting: ClaimsSetting): void => {
	switch (setting.kind) {
		case "facts":
			out.push("f", setting.scope)
			contextFacts(out, setting.facts)
			return
		case "malformed":
			out.push("m", setting.scope, setting.text)
			return
	}
}

const session = (out: Writer, s: ModelSession): void => {
	switch (s.kind) {
		case "db":
			out.push("d", s.login, s.role)
			contextFacts(out, s.facts)
			out.push(s.claims, s.connection, s.snapshot.version, s.guard)
			return
		case "direct":
			out.push("x", s.login)
			if (s.current.kind === "login") {
				out.push("l")
			} else {
				out.push("r", s.current.role)
			}
			if (s.claims.kind === "none") {
				out.push("n")
			} else {
				out.push("s")
				claimsSetting(out, s.claims.setting)
			}
			out.push(s.isolation, s.transaction)
			reality(out, s.view)
			return
		case "closed":
			out.push("c", s.was)
			return
	}
}

const connection = (out: Writer, c: ConnectionState): void => {
	const leftover = c.leftover
	switch (leftover.kind) {
		case "clean":
			out.push(c.login, "c")
			return
		case "role":
			out.push(c.login, "r", leftover.role)
			return
		case "claims":
			out.push(c.login, "s", leftover.text)
			return
	}
}

const byLogin = Order.mapInput(Order.String, (entry: readonly [string, number]) => entry[0])

/** The version each login was created at, by login: names sorted. */
const loginsCreated = (out: Writer, created: Readonly<Record<string, number>>): void =>
	list(out, Arr.sort(Rec.toEntries(created), byLogin), (o, [login, version]) => {
		o.push(login, version)
	})

/**
 * The canonical form of a model state, for one exploration: it interns the objects its states hold by identity,
 * numbering each in the order it meets them, so two states have one form only among the forms of one exploration.
 */
export const canonicalForms = (): ((state: ModelState) => ValueIdentity) => {
	const identities = new WeakMap<object, number>()
	let minted = 0
	const identityOf = (out: Writer, value: object): void => {
		const known = identities.get(value)
		if (known !== undefined) {
			out.push(known)
			return
		}
		minted++
		identities.set(value, minted)
		out.push(minted)
	}
	return (state) => {
		const out: Writer = []
		identityOf(out, state.install)
		identityOf(out, state.names)
		identityOf(out, state.host)
		out.push(state.version)
		loginsCreated(out, state.loginsCreated)
		reality(out, state.reality)
		relations(out, Rec.toEntries(state.derived))
		list(out, state.sessions, session)
		list(out, state.connections, connection)
		list(out, state.tampered, identityOf)
		if (state.migrations.kind === "applied") {
			out.push("a")
		} else {
			out.push("p", state.migrations.ledger)
			list(out, state.migrations.folders, identityOf)
		}
		return out
	}
}
