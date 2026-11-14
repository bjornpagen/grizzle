/**
 * The worlds generators (test/support/worlds/generate), each against the harness's own rules, which judge what a
 * generator drew without the generator's help:
 *
 * - Invalid kinds: every invalid kind of the vocabulary is offered by some witness state, and every draw of its
 *   generator there is classified as that kind (generate/classify.ts invalidKindsOf), names only sessions the state
 *   holds, keeps the serial rule (drive/index.ts serial) and is offered (generate/offered.ts). The witness states are
 *   each fixture over the empty reality and lawful realities drawn on the label's floor stream, under every session
 *   layout, the folder applied or left unfinished; the box is the vocabulary itself.
 * - Actions: under swarm weights, every drawn action keeps the same harness rules; walks reach live and invalid ones.
 * - Realities: every drawn reality of every base breaks no law, is its own repair, holds one fact per primary key, and
 *   every value in its field's domain.
 * - Installations: a lawful one breaks no write-list rule, a planted one is classified as its defect, every role sits
 *   in exactly one login, and every query entry is one grizzle builds (ruleFaults).
 * - Forced moves: under weights of zero, a state with no open session draws a forced move, and any other an offered
 *   kind; an open is live and a direct writer begins SERIALIZABLE.
 * - The small box: from every reality of the box, after drawn steps, the box's actions in a state are duplicate-free up
 *   to renaming the values the state does not hold, cover every kind the state offers, and keep the serial rule.
 *
 * Oracles: the specification, each rule above stated apart from the generator it judges. Features: every invalid
 * kind; live and invalid actions; realities with facts and empty; every installation kind, two logins and a query
 * entry; each forced move and an unforced one; the box's kinds.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): gen-invalid-unclassified.patch (the classifier finding no invalid kind)
 * turns the first property red; gen-actions-unquiet.patch (a session named past the serial rule's holder) the second;
 * gen-reality-unrepaired.patch (a reality left unrepaired) the third; gen-planted-live.patch (a planted installation
 * left lawful) the fourth; gen-forced-none.patch (no move ever forced) the fifth; gen-box-duplicate.patch (the box
 * holding an action twice) the sixth.
 */
import { drawn, exhaust, explore, Run } from "@bjornpagen/testing/explore"
import { required, requiredInSpace } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { floorSeed, rotatingSeed } from "@bjornpagen/testing/random"
import { notesOnly } from "@bjornpagen/testing/sense"
import { sample } from "@bjornpagen/testing/source"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record } from "effect"
import { assert } from "#test/support/assert.ts"
import { educationBase, educationInstall } from "#test/support/fixtures/education/index.ts"
import { projection, valueText, violations } from "#test/support/laws/model.ts"
import { caseHang } from "#test/support/limits.ts"
import { serial } from "#test/support/worlds/drive/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { actionGen, invalidGens } from "#test/support/worlds/generate/action.ts"
import { invalidKindsOf } from "#test/support/worlds/generate/classify.ts"
import { inDomain, knownNonEmpty, pool, sameDomain } from "#test/support/worlds/generate/domain.ts"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import {
	defaultScope,
	enumerateActions,
	enumerateRealities,
	stateValues
} from "#test/support/worlds/generate/enumerate.ts"
import {
	type InstallKind,
	installGen,
	plantedInstallGen
} from "#test/support/worlds/generate/install.ts"
import { applicable, forcedMoves, namesOffered } from "#test/support/worlds/generate/offered.ts"
import { lawfulOf, realityGen } from "#test/support/worlds/generate/reality.ts"
import { actionKinds, weightsGen, zeroWeights } from "#test/support/worlds/generate/weights.ts"
import { invalidKinds } from "#test/support/worlds/invalid/kinds.ts"
import { installKinds } from "#test/support/worlds/invalid/migrations.ts"
import { liveFactsGen } from "#test/support/worlds/invalid/tokens.ts"
import {
	docsBase,
	docsInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { ruleFaults } from "#test/support/worlds/model/host.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	BaseSpec,
	ContextFacts,
	DirectSessionState,
	FieldDomain,
	HostState,
	InstallSpec,
	InstalledNames,
	InvalidKind,
	ModelState,
	RoleSpec,
	ModelSession,
	HostValue
} from "#test/support/worlds/model/types.ts"

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
const fixtures: Arr.NonEmptyReadonlyArray<{
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

/** Every invalid kind, in the vocabulary's order: the box the first property enumerates. */
const everyInvalidKind = knownNonEmpty(invalidKinds, "the invalid kinds")

/**
 * Six draws of a generator from the rotating stream of a label, so every run draws new ones: the draws of a property
 * whose case is enumerated, which a case's own draws would enumerate too.
 */
const rotatingDraws = Effect.fn("unit.world-model.rotating-draws")(function* <A>(
	label: string,
	generator: Gen<A>
) {
	const run = yield* Run
	return sample(generator, rotatingSeed(run.seed, floorSeed(label)), 6)
})

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

type Feature = `invalid:${InvalidKind}`

const installKindList: Arr.NonEmptyReadonlyArray<InstallKind> = [
	"install:unwritable-write",
	"install:two-writes-one-relation"
]

type InstallFeature = "live" | InstallKind | "two logins" | "query"

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
const canonicalAction = (state: ModelState, action: Action): string => {
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
const holdsHarnessRules = (state: ModelState, action: Action): void => {
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

describe("the worlds generators", () => {
	it.effect(
		"draw every invalid kind where a witness state offers it, each draw of its kind, naming held sessions under the serial rule",
		(ctx) => {
			const offering = Arr.map(witnesses, (state) => ({ state, invalidGen: invalidGens(state) }))
			return searched(
				ctx,
				exhaust(
					{
						box: "every invalid kind of the vocabulary, each where the first witness state offering it offers it",
						oracle: {
							kind: "specification",
							name: "the invalid-kind classifier and the harness rules, judging each draw of a kind"
						},
						suite: "unit/world-model/invalid-kinds",
						generator: element(everyInvalidKind),
						literal: Formatter.format,
						coverage: requiredInSpace<Feature>(
							Arr.map(everyInvalidKind, (k): Feature => `invalid:${k}`)
						),
						caseHang,
						concurrency: 1
					},
					(kind, c) =>
						Effect.gen(function* () {
							const offered = Arr.findFirst(offering, (w) => w.invalidGen(kind) !== undefined)
							if (Option.isNone(offered)) {
								return assert.fail(`no witness state offers ${kind}`)
							}
							const state = offered.value.state
							const gen = offered.value.invalidGen(kind)
							if (gen === undefined) {
								return assert.fail(`the witness state stopped offering ${kind}`)
							}
							for (const action of yield* rotatingDraws(
								`unit/world-model/invalid-kinds ${kind}`,
								gen
							)) {
								const found = invalidKindsOf(state, action)
								assert.ok(
									found.includes(kind),
									`drawn for ${kind}, a ${action.kind} classified ${Arr.join(found, ", ")}`
								)
								holdsHarnessRules(state, action)
							}
							c.note(`invalid:${kind}`)
						})
				)
			)
		}
	)

	it.effect(
		"draw actions under swarm weights that name only sessions the state holds, keep the serial rule, and are offered",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the harness rules: held sessions, the serial rule, what the state offers"
						},
						suite: "unit/world-model/generate-actions",
						draw: drawn((source) => {
							const state = source.draw(stateGen)
							const weights = source.draw(weightsGen)
							return {
								state,
								actions: source.draw(array(actionGen(state, weights), { min: 32, max: 32 }))
							}
						}),
						literal: Formatter.format,
						coverage: required<"live" | "invalid">(["live", "invalid"], {
							cases: 160,
							sense: notesOnly
						}),
						kept: [],
						runs: 160,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ state, actions }, c) =>
						Effect.sync(() => {
							for (const action of actions) {
								holdsHarnessRules(state, action)
								c.note(invalidKindsOf(state, action).length === 0 ? "live" : "invalid")
							}
						})
				)
			)
	)

	it.effect(
		"draw lawful realities of every base: each fact in its domain, one per primary key, repair a no-op on them",
		(ctx) => {
			const bases: Arr.NonEmptyReadonlyArray<{
				readonly base: BaseSpec
				readonly state: ModelState
			}> = knownNonEmpty(
				Arr.map(fixtures, (f) => ({ base: f.install.base, state: f.state })),
				"the bases"
			)
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the law model's violations, the repair's fixed point, keys and domains"
						},
						suite: "unit/world-model/generate-realities",
						draw: drawn((source) => {
							const { base, state } = source.draw(element(bases))
							return { base, state, reality: source.draw(realityGen(base, state.host)) }
						}),
						literal: Formatter.format,
						coverage: required<"facts" | "empty">(["facts", "empty"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ base, state, reality }, c) =>
						Effect.sync(() => {
							assert.deepEqual(
								violations(state.host, reality),
								[],
								"the drawn reality breaks a law"
							)
							assert.equal(
								lawfulOf(state.host, reality),
								reality,
								"repairing a lawful reality changed it"
							)
							const count = Arr.reduce(base.relations, 0, (n, relation) => {
								const facts = reality.get(relation.name) ?? []
								const keys = new Set(Arr.map(facts, (f) => projection(f, relation.key)))
								assert.equal(
									keys.size,
									facts.length,
									`two facts of ${relation.name} share a primary key`
								)
								const outside = Arr.flatMap(facts, (fact) =>
									Arr.filter(relation.fields, (field) => {
										const v = fact[field.name]
										return v === undefined || !inDomain(field.domain, v)
									})
								)
								assert.deepEqual(
									Arr.map(outside, (f) => f.name),
									[],
									`a fact of ${relation.name} holds a value outside its field's domain`
								)
								return n + facts.length
							})
							c.note(count > 0 ? "facts" : "empty")
						})
				)
			)
		}
	)

	it.effect(
		"draw installations whose rules the host model admits, lawful or with one write-list defect planted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the write-list classifier, the login partition and the rule-fault checker"
						},
						suite: "unit/world-model/generate-installs",
						draw: drawn((source) => {
							const base = source.draw(element([docsBase, educationBase]))
							const kind = source.draw(element(["live", ...installKindList] as const))
							return {
								kind,
								install: source.draw(
									kind === "live" ? installGen(base) : plantedInstallGen(base, kind)
								)
							}
						}),
						literal: Formatter.format,
						coverage: required<InstallFeature>(
							["live", ...installKindList, "two logins", "query"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ kind, install }, c) =>
						Effect.sync(() => {
							const found = installKinds(install)
							if (kind === "live") {
								assert.deepEqual(found, [], "a lawful installation breaks the writable rule")
							} else {
								assert.ok(
									found.includes(kind),
									`planted as ${kind}, classified ${Arr.join(found, ", ")}`
								)
							}
							c.note(kind)
							const roles = new Set(Arr.map(install.roles, (r) => r.name))
							const held = Arr.flatMap(install.logins, (l) => l.roles)
							assert.equal(held.length, roles.size, "a role in two logins, or in none")
							assert.deepEqual(new Set(held), roles, "a login holds a role the installation lacks")
							if (install.logins.length > 1) {
								c.note("two logins")
							}
							const queries = Arr.flatMap(install.roles, (role) =>
								Arr.flatMap(Record.toEntries(role.entries), ([name, entry]) =>
									entry.kind === "query" ? [{ role: role.name, name, rules: entry.rules }] : []
								)
							)
							if (queries.length > 0) {
								c.note("query")
							}
							for (const q of queries) {
								assert.deepEqual(
									ruleFaults(install.base, q.rules),
									[],
									`${q.role}.${q.name} is no query grizzle builds`
								)
							}
						})
				)
			)
	)

	it.effect(
		"draw the forced moves under weights of zero, and only live inputs under validity of zero",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the forced moves and the offered kinds of the state"
						},
						suite: "unit/world-model/generate-forced",
						draw: drawn((source) => {
							const state = source.draw(stateGen)
							return { state, action: source.draw(actionGen(state, zeroWeights)) }
						}),
						literal: Formatter.format,
						coverage: required<`forced ${ActionKind}` | "unforced">(
							["forced open-db", "forced direct-begin", "unforced"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ state, action }, c) =>
						Effect.sync(() => {
							const forced = forcedMoves(state)
							if (forced.length > 0) {
								assert.ok(
									forced.includes(action.kind),
									`with no open session, a ${action.kind} was drawn, not ${Arr.join(forced, " or ")}`
								)
								c.note(`forced ${action.kind}`)
							} else {
								assert.ok(
									applicable(state, action.kind),
									`a ${action.kind} the state does not offer`
								)
								c.note("unforced")
							}
							if (action.kind === "open-db") {
								assert.deepEqual(
									invalidKindsOf(state, action),
									[],
									"an open under validity of zero drew an invalid input"
								)
							}
							if (action.kind === "direct-begin") {
								assert.equal(
									action.isolation,
									"serializable",
									"a direct writer under validity of zero began below SERIALIZABLE"
								)
							}
						})
				)
			)
	)

	it.effect(
		"enumerate a finite box, duplicate-free up to renaming, covering every action kind the state offers",
		(ctx) => {
			const [docs] = fixtures
			const realities: Arr.NonEmptyReadonlyArray<HostState> = knownNonEmpty(
				enumerateRealities(docsBase, docs.state.host, defaultScope),
				"the box's realities"
			)
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the box's canonical form up to renaming, the offered kinds and the serial rule"
						},
						suite: "unit/world-model/generate-box",
						draw: drawn((source) => ({
							reality: source.draw(element(realities)),
							steps: source.draw(int(0, 3))
						})),
						literal: Formatter.format,
						coverage: required<`kind ${ActionKind}`>(
							Arr.map(
								["open-db", "direct-begin", "migrate", "tamper", "drift", "wild"] as const,
								(k): `kind ${ActionKind}` => `kind ${k}`
							),
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ reality, steps }, c) =>
						Effect.sync(() => {
							let state = initialState(docsInstall, docs.state.names, reality)
							for (let taken = 0; taken < steps; taken += 1) {
								const offered = enumerateActions(state, defaultScope)
								const [firstKind, ...moreKinds] = [...new Set(Arr.map(offered, (x) => x.kind))]
								if (firstKind === undefined) {
									break
								}
								const kind = c.draw(element([firstKind, ...moreKinds]))
								const ofKind = knownNonEmpty(
									Arr.filter(offered, (x) => x.kind === kind),
									"the box's actions of a kind"
								)
								state = settle(
									c.draw(element(step(state, c.draw(element(ofKind))))),
									installedNames
								).next
							}
							const actions = enumerateActions(state, defaultScope)
							const keys = Arr.map(actions, (x) => canonicalAction(state, x))
							assert.equal(
								new Set(keys).size,
								keys.length,
								"the box holds one action twice, up to renaming unheld values"
							)
							for (const kind of actionKinds) {
								if (applicable(state, kind)) {
									assert.ok(
										Arr.some(actions, (x) => x.kind === kind),
										`the state offers a ${kind} and the box holds none`
									)
								}
							}
							for (const x of actions) {
								c.note(`kind ${x.kind}`)
								assert.ok(serial(state, x), `the box holds a ${x.kind} the serial rule refuses`)
							}
						})
				)
			)
		}
	)
})
