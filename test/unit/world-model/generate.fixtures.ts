/** What the properties of generate.test.ts read: its spaces, models and helpers. */

import { word } from "@bjornpagen/testing/dictionary"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { floorSeed } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { Array as Arr, Option, Order, Record } from "effect"
import { assert } from "#test/support/assert.ts"
import { educationBase, educationInstall } from "#test/support/fixtures/education/index.ts"
import { valueText } from "#test/support/laws/model.ts"
import { serial } from "#test/support/worlds/drive/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { actionGen, invalidGens } from "#test/support/worlds/generate/action.ts"
import { knownNonEmpty, pool, sameDomain } from "#test/support/worlds/generate/domain.ts"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import {
	defaultScope,
	enumerateRealities,
	stateValues
} from "#test/support/worlds/generate/enumerate.ts"
import {
	type InstallKind,
	installGen,
	plantedInstallGen
} from "#test/support/worlds/generate/install.ts"
import { applicable, namesOffered } from "#test/support/worlds/generate/offered.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { weightsGen, zeroWeights } from "#test/support/worlds/generate/weights.ts"
import { liveFactsGen } from "#test/support/worlds/invalid/tokens.ts"
import {
	docsBase,
	docsInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { driftOf } from "#test/support/worlds/model/session/catalog.ts"
import { migrating, staleDb } from "#test/support/worlds/model/session/state.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	BaseSpec,
	ContextFacts,
	DirectSessionState,
	FieldDomain,
	HostState,
	HostValue,
	InstallSpec,
	InstalledNames,
	InvalidKind,
	ModelSession,
	ModelState,
	RoleSpec
} from "#test/support/worlds/model/types.ts"
import { invalidKindWords } from "#test/unit/world-model/generate.dictionary.ts"

/** A reading's units: an int4 contract of 0 to 100, so a fact or a claim can hold a value its DOMAIN refuses. */
const units: FieldDomain = { kind: "contract", name: "Units", bits: 32, min: 0, max: 100 }

/**
 * A base whose session reads integers: a clock's `now` (an int8, from the payload's top level) and a quota's `units`
 * (an int4 contract, from the claim object `q`), so tokens can carry integer claims, unsafe or not digits, and facts a
 * contract's bounds refuse. Its role `alpha` writes readings stamped with the clock's time, and ticks, two identity
 * numbers and the clock's time, through an entry whose every carried field is serial, its time filled from the clock;
 * `beta` writes ticks through an entry that carries the time and filters on `seq`, a serial field its filter reads,
 * since a role writes a relation through one entry at most.
 */
const meterBase: BaseSpec = {
	name: "Meter",
	closed: [],
	relations: [
		{
			name: "Reading",
			fields: [
				{ name: "id", domain: { kind: "uuid" } },
				{ name: "at", domain: { kind: "integer", bits: 64 } },
				{ name: "units", domain: units }
			],
			key: ["id"],
			mutability: "immutable"
		},
		{
			name: "Tick",
			fields: [
				{ name: "no", domain: { kind: "serial", bits: 64 } },
				{ name: "seq", domain: { kind: "serial", bits: 32 } },
				{ name: "at", domain: { kind: "integer", bits: 64 } }
			],
			key: ["no"],
			mutability: "immutable"
		}
	],
	laws: [],
	contexts: [
		{
			name: "Clock",
			claim: { kind: "top-level" },
			fields: [{ name: "now", domain: { kind: "integer", bits: 64 } }]
		},
		{
			name: "Quota",
			claim: { kind: "object", key: "q" },
			fields: [{ name: "units", domain: units }]
		}
	],
	derived: []
}

const meterInstall: InstallSpec = {
	base: meterBase,
	roles: [
		{
			name: "alpha",
			entries: {
				Reading: {
					kind: "query",
					rules: [
						{
							matches: [
								{
									source: { kind: "ordinary", name: "Reading" },
									fields: {
										id: { kind: "var", name: "id" },
										at: { kind: "context", context: "Clock", field: "now" },
										units: { kind: "var", name: "units" }
									}
								},
								{
									source: { kind: "context", name: "Quota" },
									fields: { units: { kind: "var", name: "units" } }
								}
							],
							negations: [],
							comparisons: [],
							head: { id: { kind: "var", name: "id" }, units: { kind: "var", name: "units" } }
						}
					]
				},
				Tick: {
					kind: "query",
					rules: [
						{
							matches: [
								{
									source: { kind: "ordinary", name: "Tick" },
									fields: {
										no: { kind: "var", name: "no" },
										seq: { kind: "var", name: "seq" },
										at: { kind: "context", context: "Clock", field: "now" }
									}
								}
							],
							negations: [],
							comparisons: [],
							head: { no: { kind: "var", name: "no" }, seq: { kind: "var", name: "seq" } }
						}
					]
				}
			},
			write: ["Reading", "Tick"],
			refresh: []
		},
		{
			name: "beta",
			entries: {
				LateTick: {
					kind: "query",
					rules: [
						{
							matches: [
								{
									source: { kind: "ordinary", name: "Tick" },
									fields: {
										no: { kind: "var", name: "no" },
										seq: { kind: "var", name: "seq" },
										at: { kind: "var", name: "at" }
									}
								}
							],
							negations: [],
							comparisons: [
								{
									left: { kind: "var", name: "seq" },
									op: ">=",
									right: { kind: "literal", value: 1 }
								}
							],
							head: {
								no: { kind: "var", name: "no" },
								seq: { kind: "var", name: "seq" },
								at: { kind: "var", name: "at" }
							}
						}
					]
				}
			},
			write: ["LateTick"],
			refresh: []
		}
	],
	logins: [{ name: "web", roles: ["alpha", "beta"] }]
}

/**
 * The names the compiler gives a base's relations and laws: those of an installation of the base whose one role holds
 * its first relation whole, all the host law model reads of a model state's names.
 */
const baseNames = (base: BaseSpec): InstalledNames => {
	const [first] = base.relations
	return installedNames({
		base,
		roles: [
			{
				name: "alpha",
				entries: { [first.name]: { kind: "whole", relation: first.name } },
				write: [],
				refresh: []
			}
		],
		logins: [{ name: "web", roles: ["alpha"] }]
	})
}

/** The installations the generators are tried over, with the names their base's compilation gives them. */
export const fixtures: Arr.NonEmptyReadonlyArray<{
	readonly install: InstallSpec
	readonly state: ModelState
}> = knownNonEmpty(
	Arr.map([docsInstall, docsOneShareInstall, educationInstall, meterInstall], (install) => ({
		install,
		state: initialState(install, baseNames(install.base), new Map())
	})),
	"the fixtures"
)

/**
 * The sessions a model state may hold beside its reality, drawn so every kind of handle is there to name: a Db opened
 * at the state's version, or before it, its snapshot moved past, its guard holding the ledger to its snapshot or to one
 * no migration lands, its claims admitted or refused by PostgreSQL.
 */
const sessionsGen = (state: ModelState): Gen<ReadonlyArray<ModelSession>> => {
	const install = state.install
	const db: Gen<ModelSession> = (source) => {
		const role = source.draw(element(install.roles))
		return {
			kind: "db",
			login: Option.getOrThrowWith(
				Arr.findFirst(install.logins, (l) => l.roles.includes(role.name)),
				() => new Error(`no login holds ${role.name}`)
			).name,
			role: role.name,
			facts: source.draw(liveFactsGen(state, contextsRead(install.base, role))),
			claims: source.draw(element(["admitted", "refused"] as const)),
			connection: 0,
			snapshot: {
				version: source.draw(int(0, state.version)),
				install,
				names: state.names,
				host: state.host
			},
			guard: source.draw(element(["held", "never"] as const))
		}
	}
	const direct: Gen<ModelSession> = (source) => {
		const login = source.draw(element(install.logins))
		const role = source.draw(boolean)
		const aborted = source.draw(boolean)
		return {
			kind: "direct",
			login: login.name,
			current: role ? { kind: "role", role: login.roles[0] } : { kind: "login" },
			claims: { kind: "none" },
			isolation: "serializable",
			transaction: aborted ? "aborted" : "open",
			view: state.reality,
			prepared: {},
			sent: []
		}
	}
	const closed: Gen<ModelSession> = map(
		element(["db", "direct"] as const),
		(was): ModelSession => ({ kind: "closed", was })
	)
	return (source) => [
		...source.draw(array(oneOf([db, closed]), { min: 0, max: 3 })),
		...source.draw(array(direct, { min: 0, max: 1 }))
	]
}

/**
 * The moves a state forces when the weights give nothing to draw, restated from the model's state apart from the
 * generator's offering: none while a session is live (a direct writer's transaction, or a Db whose guard holds the
 * ledger, whose claims PostgreSQL admits and whose snapshot is the installation's current version); otherwise opening a
 * Db, and beginning a direct transaction too unless a folder is unfinished or the catalog has left its contract (the
 * model's drift finds a perturbation).
 */
export const forcedOf = (state: ModelState): ReadonlyArray<ActionKind> => {
	const live = Arr.some(
		state.sessions,
		(s) =>
			s.kind === "direct" ||
			(s.kind === "db" && s.guard === "held" && s.claims === "admitted" && !staleDb(state, s))
	)
	if (live) {
		return []
	}
	return migrating(state) || driftOf(state.install, state.tampered).length > 0
		? ["open-db"]
		: ["open-db", "direct-begin"]
}

/**
 * A model state over a fixture: a lawful reality of its base, at the first version or after a migration, and sessions
 * of every kind.
 */
const stateGen: Gen<ModelState> = (source) => {
	const { install, state } = source.draw(element(fixtures))
	const reality = source.draw(realityGen(install.base, state.host))
	const loaded = { ...initialState(install, state.names, reality), version: source.draw(int(0, 1)) }
	return { ...loaded, sessions: source.draw(sessionsGen(loaded)) }
}

/**
 * Each context a role reads, its fact at the `n`th value of each field's domain the reality holds (the domain's first
 * pool value when it holds none): claims that meet the reality's facts, so a witness's worlds hold rows.
 */
const factsMeeting = (state: ModelState, role: RoleSpec, n: number): ContextFacts => {
	const base = state.install.base
	const held = (domain: FieldDomain): ReadonlyArray<HostValue> => [
		...new Set(
			Arr.flatMap(base.relations, (r) =>
				Arr.flatMap(r.fields, (f) =>
					sameDomain(f.domain, domain)
						? Arr.flatMap(state.reality.get(r.name) ?? [], (fact) => {
								const v = fact[f.name]
								return v === undefined ? [] : [v]
							})
						: []
				)
			)
		)
	]
	const valueOf = (domain: FieldDomain): HostValue => {
		const values = held(domain)
		return values[n % Math.max(1, values.length)] ?? pool(domain)[0]
	}
	return Record.fromEntries(
		Arr.map(
			contextsRead(base, role),
			(c) =>
				[
					c.name,
					Record.fromEntries(Arr.map(c.fields, (f) => [f.name, valueOf(f.domain)] as const))
				] as const
		)
	)
}

/**
 * The sessions of a witness state: three open Dbs for each role, their claims meeting the reality's values, a closed Db
 * and a closed direct writer, and then nothing more, or a direct writer's open transaction as its login's first role or
 * as the login, or one a refusal aborted.
 */
const witnessLayouts = (state: ModelState): ReadonlyArray<ReadonlyArray<ModelSession>> => {
	const install = state.install
	const [login] = install.logins
	const dbs = Arr.flatMap(install.roles, (role) =>
		Arr.map([0, 1, 2], (n): ModelSession => ({
			kind: "db",
			login: Option.getOrThrowWith(
				Arr.findFirst(install.logins, (l) => l.roles.includes(role.name)),
				() => new Error(`no login holds ${role.name}`)
			).name,
			role: role.name,
			facts: factsMeeting(state, role, n),
			claims: "admitted",
			connection: 0,
			snapshot: { version: state.version, install, names: state.names, host: state.host },
			guard: "held"
		}))
	)
	const shared: ReadonlyArray<ModelSession> = [
		...dbs,
		{ kind: "closed", was: "db" },
		{ kind: "closed", was: "direct" }
	]
	const direct = (
		current: DirectSessionState["current"],
		transaction: "open" | "aborted"
	): ModelSession => ({
		kind: "direct",
		login: login.name,
		current,
		claims: { kind: "none" },
		isolation: "serializable",
		transaction,
		view: state.reality,
		prepared: {},
		sent: []
	})
	const asRole = { kind: "role" as const, role: login.roles[0] }
	return [
		shared,
		[...shared, direct(asRole, "open")],
		[...shared, direct({ kind: "login" }, "open")],
		[...shared, direct(asRole, "aborted")]
	]
}

/** The reality holding no fact. */
const empty: HostState = new Map()

/**
 * The witness states every invalid kind is sought in: each fixture over the empty reality and eight lawful realities, each
 * under every witness layout, every folder applied or the installation's own folder a run left unfinished. The realities
 * are drawn from the label's floor stream on purpose: they are witnesses of a reachability proof, which must not move
 * with TEST_SEED, not samples of a distribution.
 */
const witnesses: ReadonlyArray<ModelState> = Arr.flatMap(fixtures, ({ install, state }) =>
	Arr.flatMap(
		[
			empty,
			...sample(realityGen(install.base, state.host), floorSeed("unit/world-model witnesses"), 8)
		],
		(reality) => {
			const loaded = initialState(install, state.names, reality)
			return Arr.flatMap(witnessLayouts(loaded), (sessions): ReadonlyArray<ModelState> => [
				{ ...loaded, sessions },
				{
					...loaded,
					sessions,
					migrations: { kind: "pending", folders: [install], ledger: "unfinished" }
				}
			])
		}
	)
)

/** Every session an action names. */
const namedSessions = (action: Action): ReadonlyArray<number> => {
	switch (action.kind) {
		case "read":
		case "apply":
		case "refresh":
		case "close":
		case "direct":
		case "direct-end":
		case "interrupt":
			return [action.session]
		case "wild":
			return action.at.kind === "session" ? [action.at.session] : []
		case "open-db":
		case "direct-begin":
		case "migrate":
		case "tamper":
		case "drift":
			return []
	}
}

/** The defects an installation may have planted. */
const installKindList: Arr.NonEmptyReadonlyArray<InstallKind> = [
	"install:unwritable-write",
	"install:two-writes-one-relation"
]

/** Every uuid and text value of the pools: the values a renaming may move. */
const symmetricValues = (base: BaseSpec): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(
			[
				...Arr.flatMap(base.relations, (r) => r.fields),
				...Arr.flatMap(base.contexts, (x) => x.fields)
			],
			(f) =>
				f.domain.kind === "uuid" || f.domain.kind === "text"
					? Arr.map(pool(f.domain), valueText)
					: []
		)
	)

/** Every value a state holds, as text: what the box's symmetry keeps apart (enumerate.ts stateValues). */
const heldValues = (state: ModelState): ReadonlySet<string> =>
	new Set(Arr.map(stateValues(state), valueText))

/** A text as an atom: its length, a colon, the text. */
const atom = (text: string): string => `${text.length}:${text}`

const byKey = Order.mapInput(Order.String, (entry: readonly [string, unknown]) => entry[0])

/**
 * An action's canonical form with every uuid or text value the state does not hold renamed to one placeholder: equal
 * forms are one action up to renaming. Every value is a tag and a length-framed atom, a record's fields sorted by name
 * and an array's members kept in order, so the form is injective over an action's plain data, bigints included (a
 * migration's capacity bound).
 */
export const canonicalAction = (state: ModelState, action: Action): string => {
	const movable = symmetricValues(state.install.base)
	const held = heldValues(state)
	const form = (v: unknown): string => {
		switch (typeof v) {
			case "string":
				return movable.has(v) && !held.has(v) ? "u" : `s${atom(v)}`
			case "number":
				return `n${atom(String(v))}`
			case "bigint":
				return `i${atom(String(v))}`
			case "boolean":
				return v ? "t" : "f"
			case "undefined":
				return "z"
			case "object":
				if (v === null) {
					return "0"
				}
				return Arr.isArray(v)
					? `a${atom(Arr.join(Arr.map(v, form), ""))}`
					: `o${atom(
							Arr.join(
								Arr.map(Arr.sort(Record.toEntries(v), byKey), ([k, x]) => `${atom(k)}${form(x)}`),
								""
							)
						)}`
			case "symbol":
			case "function":
				throw new Error(`an action holds a ${typeof v}, which is no plain data`)
		}
	}
	return form(action)
}

/**
 * The harness rules every drawn action keeps: it names only sessions the state holds, the serial rule admits it, and the
 * state offers its kind and the session it names.
 */
export const holdsHarnessRules = (state: ModelState, action: Action): void => {
	const absent = Arr.filter(
		namedSessions(action),
		(session) => !(Number.isInteger(session) && session >= 0 && session < state.sessions.length)
	)
	assert.deepEqual(absent, [], `a ${action.kind} names a session the state does not hold`)
	assert.ok(serial(state, action), `a ${action.kind} the serial rule refuses was drawn`)
	assert.ok(applicable(state, action.kind), `a ${action.kind} drawn where the state offers none`)
	assert.ok(
		namesOffered(state, action),
		`a ${action.kind} drawn naming a session its kind may not name`
	)
}

/** An invalid kind a case's draw is classified as. */
export type Feature = `invalid:${InvalidKind}`

/** What a drawn installation reaches: lawful or its planted defect, two logins, a query entry. */
export type InstallFeature = "live" | InstallKind | "two logins" | "query"

/** Each witness state, with the generator of each invalid kind it offers. */
export const offering = Arr.map(witnesses, (state) => ({ state, invalidGen: invalidGens(state) }))

/**
 * An invalid kind of the vocabulary; and where a witness's turn aims at a kind no witness reached yet, that kind: every
 * kind is reached by construction, as the vocabulary's exhaustion reached it.
 */
export const invalidKindSpace: Aimed<InvalidKind, Feature> = aimed(
	word(invalidKindWords),
	Arr.map(invalidKindWords, (kind): readonly [Feature, Gen<InvalidKind>] => [
		`invalid:${kind}`,
		constant(kind)
	])
)

/** A model state, swarm weights, and 32 actions drawn in the state under them. */
export const actionsGen: Gen<{
	readonly state: ModelState
	readonly actions: ReadonlyArray<Action>
}> = (source) => {
	const state = source.draw(stateGen)
	const weights = source.draw(weightsGen)
	return {
		state,
		actions: source.draw(array(actionGen(state, weights), { min: 32, max: 32 }))
	}
}

const bases: Arr.NonEmptyReadonlyArray<{
	readonly base: BaseSpec
	readonly state: ModelState
}> = knownNonEmpty(
	Arr.map(fixtures, (f) => ({ base: f.install.base, state: f.state })),
	"the bases"
)

/** A fixture's base, its model state, and a lawful reality drawn of it. */
export const realitiesGen: Gen<{
	readonly base: BaseSpec
	readonly state: ModelState
	readonly reality: HostState
}> = (source) => {
	const { base, state } = source.draw(element(bases))
	return { base, state, reality: source.draw(realityGen(base, state.host)) }
}

/** An installation of the documents or the education base, lawful or with one write-list defect planted. */
export const installsGen: Gen<{
	readonly kind: "live" | InstallKind
	readonly install: InstallSpec
}> = (source) => {
	const base = source.draw(element([docsBase, educationBase]))
	const kind = source.draw(element(["live", ...installKindList] as const))
	return {
		kind,
		install: source.draw(kind === "live" ? installGen(base) : plantedInstallGen(base, kind))
	}
}

/** A model state, and an action drawn in it under weights of zero. */
export const forcedGen: Gen<{ readonly state: ModelState; readonly action: Action }> = (source) => {
	const state = source.draw(stateGen)
	return { state, action: source.draw(actionGen(state, zeroWeights)) }
}

export const docs = Arr.headNonEmpty(fixtures)

const realities: Arr.NonEmptyReadonlyArray<HostState> = knownNonEmpty(
	enumerateRealities(docsBase, docs.state.host, defaultScope),
	"the box's realities"
)

/** A reality of the box, and how many steps to take from it. */
export const boxGen: Gen<{ readonly reality: HostState; readonly steps: number }> = (source) => ({
	reality: source.draw(element(realities)),
	steps: source.draw(int(0, 3))
})
