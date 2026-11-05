import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option,
	weighted,
	type Weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Record as Rec } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { notedOf, runStep } from "#test/support/worlds/drive/index.ts"
import {
	aimsAt,
	docsAtCapacityRealities,
	docsInstalls,
	drawAction,
	inductiveLeads,
	type Led,
	leadOf,
	stage,
	steeredOnce,
	unnoted
} from "#test/support/worlds/drive/suite.ts"
import { realize, realizeRace } from "#test/support/worlds/execute/index.ts"
import { requiredWorldFeatures } from "#test/support/worlds/features.ts"
import { pool } from "#test/support/worlds/generate/domain.ts"
import { defaultScope, enumerateInstalls } from "#test/support/worlds/generate/enumerate.ts"
import { type Weights, weightsGen } from "#test/support/worlds/generate/weights.ts"
import { malformedTexts } from "#test/support/worlds/invalid/claims.ts"
import {
	docsEditorInstall,
	docsOneShareEditorInstall,
	docsVisitsInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { roleContexts, rolesOfLogin, samePlain } from "#test/support/worlds/model/session/state.ts"
import type {
	Action,
	ContextFacts,
	ContextSpec,
	DirectSessionState,
	FieldSpec,
	HostFact,
	InstallSpec,
	MigrationHow,
	ModelState,
	SettingScope,
	Token,
	HostValue,
	WorldFeature
} from "#test/support/worlds/model/types.ts"

/**
 * The worlds invariants, checked inductively: rather than reaching states by walks of actions, a case draws a state
 * directly (an installation, the documents base's own, one with an editor beside or one writing Visit through its
 * serial shapes (installsGen), a lawful reality the owner loads,
 * half the time with a document at its capacity, Db sessions of any roles of any logins with any claims their tokens
 * carry, those Dbs' reads spread over the logins' pooled connections, a pool of one connection per login half the
 * time, so its Dbs of every role share it, and then a direct writer with any current role of its login and any claims,
 * malformed ones among them, set for the transaction or the session; or a migration past the Dbs' snapshot, completed
 * or stopped half-applied, which leaves them stale and its drafted snapshot one an open may name; or a lead's moves,
 * which build a state one action before what it reaches: a transaction begun, a transaction one statement in, a
 * derived relation a Db left stale, or a Db opened (drive/suite.ts inductiveLeads)), brings the real system to it, and
 * then performs ONE action drawn there, valid or invalid, aimed at a required feature no case reached yet that the
 * state offers: every time while one is pending, half the time once all are reached or where the case may not steer
 * (drive/suite.ts aimsAt, steeredOnce).
 * The observation must be one the worlds model allows, and the state the model enters must keep every invariant and be
 * the real system's: its stored relations and every open session's probe. An action from any such state that breaks an
 * invariant is a counterexample no reachable-states search needs to find a path to.
 *
 * The setup's actions are driven and checked like any other, but they note nothing: what a case reached is its one
 * action. A tamper changes database settings, so the file runs in a database of its own.
 */
const cases = 64

/**
 * What the population must reach: the whole worlds feature map. A case performs one action, so most of the map is
 * reached by the steered phase, which aims each case's one action at what no case has reached yet, for up to ten times
 * the cases; a led case's lead first builds a state from which a feature the planned states rarely offer is that one
 * action away.
 */
const situations = requiredWorldFeatures

/** The leads a led case draws from (drive/suite.ts inductiveLeads). */
const leads = inductiveLeads(situations)

/** How many cases the steered phase may run, as a multiple of the cases. */
const steeredFactor = 10

const name = "every invariant holds after one action from any generated state"

/**
 * A Db session of the drawn state: its role, the token it opens with, the role relations it reads, and whether it is
 * closed after them, so the one action may name a closed handle.
 */
interface DbPlan {
	readonly role: string
	readonly token: Token
	readonly reads: ReadonlyArray<string>
	readonly closed: boolean
}

/**
 * A direct writer of the drawn state: its login, who it acts as (the login, or a role of the login it took on), its
 * claims (none, facts it set for the transaction or the session, or a malformed setting), as the model tracks a direct
 * session, and where its transaction stands: open; aborted by a refused SET ROLE to the owner, so the one action may
 * follow a refusal; or ended by its COMMIT, so the one action may name a closed handle.
 */
interface DirectPlan {
	readonly login: string
	readonly current: DirectSessionState["current"]
	readonly claims: DirectSessionState["claims"]
	readonly transaction: "open" | "aborted" | "ended"
}

/**
 * What follows a drawn state's Db sessions: nothing; a direct writer, opened last; a migration to another
 * installation, completed or stopped half-applied, which leaves every Db stale (and, half-applied, its folders
 * pending, so an open may name their drafted snapshot); or a lead, whose moves the case draws once its Db sessions are
 * in place (leadOf). A migration runs while no direct transaction is open, so a state holds a direct writer, a
 * migration or a lead, one at most.
 */
type After =
	| { readonly kind: "none" }
	| { readonly kind: "direct"; readonly direct: DirectPlan }
	| {
			readonly kind: "migration"
			readonly to: InstallSpec
			readonly how: Extract<MigrationHow, "complete" | "half-applied">
	  }
	| { readonly kind: "led" }

/** The sessions of a drawn state: Db sessions first, then what follows them. */
interface StatePlan {
	readonly dbs: ReadonlyArray<DbPlan>
	readonly after: After
}

/**
 * The pool each login's DbLayer gets: the executor's default, over which the Dbs' reads spread, or one connection, which
 * every Db of a login shares, whatever its role.
 */
type Pool = "default" | "one connection"

/**
 * An inductive case: the installation, its pool, the state's plan and the weights of its one action. The property draws
 * the reality and the action from the case's own tape, once the installation's names exist and the setup has reached
 * the planned state.
 */
interface InductiveCase {
	readonly install: InstallSpec
	readonly pool: Pool
	readonly plan: StatePlan
	readonly weights: Weights
}

const valueGen = (field: FieldSpec): Gen<HostValue> => element(pool(field.domain))

const factGen =
	(context: ContextSpec): Gen<HostFact> =>
	(source) =>
		Rec.fromEntries(Arr.map(context.fields, (f) => [f.name, source.draw(valueGen(f))] as const))

/** How a token carries the contexts a role reads from a claim object: each drawn or not, or every one left out. */
type ObjectClaims = "drawn" | "left out"

/**
 * A live token for a role: a payload holding a fact for every context the role reads, each where its claim names it.
 * A context read from the top level always has its fields there; one read from a claim object has it or not, as
 * `objects` says, and an absent claim object is no fact. A role that reads no context opens with no token.
 */
const tokenGen = (install: InstallSpec, role: string, objects: ObjectClaims): Gen<Token> => {
	const read = Option.match(
		Arr.findFirst(install.roles, (r) => r.name === role),
		{ onNone: () => new Set<string>(), onSome: roleContexts }
	)
	const contexts = Arr.filter(install.base.contexts, (c) => read.has(c.name))
	if (!Arr.isReadonlyArrayNonEmpty(contexts)) {
		return constant({ kind: "none" })
	}
	const claimObject = (context: ContextSpec): Gen<Option.Option<HostFact>> =>
		objects === "drawn" ? option(factGen(context)) : constant(Option.none())
	return (source) => {
		const claimed = Arr.map(contexts, (context) => ({
			context,
			fact:
				context.claim.kind === "top-level"
					? Option.some(source.draw(factGen(context)))
					: source.draw(claimObject(context))
		}))
		return {
			kind: "live",
			payload: Arr.reduce(
				claimed,
				{},
				(payload: Readonly<Record<string, unknown>>, { context, fact }) =>
					Option.match(fact, {
						onNone: () => payload,
						onSome: (f) =>
							context.claim.kind === "top-level"
								? { ...payload, ...f }
								: { ...payload, [context.claim.key]: f }
					})
			)
		}
	}
}

/** A Db of one of `roles`, its token's claim objects as `objects` says, its reads drawn, and closed as `closed` draws. */
const dbOfGen =
	(
		install: InstallSpec,
		roles: Arr.NonEmptyReadonlyArray<string>,
		objects: ObjectClaims,
		closed: Gen<boolean>
	): Gen<DbPlan> =>
	(source) => {
		const role = source.draw(element(roles))
		const relations = Option.match(
			Arr.findFirst(install.roles, (r) => r.name === role),
			{ onNone: (): ReadonlyArray<string> => [], onSome: (spec) => Rec.keys(spec.entries) }
		)
		return {
			role,
			token: source.draw(tokenGen(install, role, objects)),
			reads: Arr.isReadonlyArrayNonEmpty(relations)
				? source.draw(array(element(relations), { min: 0, max: 2 }))
				: [],
			closed: source.draw(closed)
		}
	}

/**
 * A Db of the drawn state: of any role, with any token its claims admit, closed half the time; or, half the time where
 * a role writes, an open Db of a role that writes whose token leaves out every claim object, so each entry of it that
 * reads one holds nothing and its writes meet the facts outside its world under no claims.
 */
const dbPlanGen = (install: InstallSpec): Gen<DbPlan> => {
	const any = dbOfGen(
		install,
		Arr.map(install.roles, (r) => r.name),
		"drawn",
		boolean
	)
	return Arr.match(
		Arr.filter(install.roles, (r) => Arr.isReadonlyArrayNonEmpty(r.write)),
		{
			onEmpty: () => any,
			onNonEmpty: (writers) =>
				oneOf([
					any,
					dbOfGen(
						install,
						Arr.map(writers, (r) => r.name),
						"left out",
						constant(false)
					)
				])
		}
	)
}

/** Claims a direct writer sets by hand: any facts of any of the base's contexts, valid by their fields' domains. */
const handClaimsGen =
	(install: InstallSpec): Gen<ContextFacts> =>
	(source) =>
		Rec.fromEntries(
			Arr.flatMap(install.base.contexts, (context): ReadonlyArray<readonly [string, HostFact]> =>
				Option.match(source.draw(option(factGen(context))), {
					onNone: () => [],
					onSome: (fact) => [[context.name, fact]]
				})
			)
		)

const directPlanGen =
	(install: InstallSpec): Gen<DirectPlan> =>
	(source) => {
		const login = source.draw(element(Arr.map(install.logins, (l) => l.name)))
		const roles = Arr.map(rolesOfLogin(install, login), (r) => r.name)
		const asLogin: Gen<DirectSessionState["current"]> = constant({ kind: "login" })
		return {
			login,
			current: source.draw(
				Arr.isReadonlyArrayNonEmpty(roles)
					? oneOf([
							asLogin,
							map(element(roles), (role): DirectSessionState["current"] => ({ kind: "role", role }))
						])
					: asLogin
			),
			claims: source.draw(
				oneOf<DirectSessionState["claims"]>([
					constant({ kind: "none" }),
					(inner) => ({
						kind: "set",
						setting: {
							kind: "facts",
							facts: inner.draw(handClaimsGen(install)),
							scope: inner.draw(element<SettingScope>(["transaction", "session"]))
						}
					}),
					(inner) => ({
						kind: "set",
						setting: {
							kind: "malformed",
							text: inner.draw(element(malformedTexts(install.base.contexts))),
							scope: inner.draw(element<SettingScope>(["transaction", "session"]))
						}
					})
				])
			),
			transaction: source.draw(element(["open", "aborted", "ended"] as const))
		}
	}

/** A migration after the Db sessions: to the box's first installation other than the case's, when the box holds one. */
const migrationGen = (install: InstallSpec): ReadonlyArray<Gen<After>> =>
	Option.match(
		Arr.findFirst(enumerateInstalls(install.base, defaultScope), (to) => !samePlain(to, install)),
		{
			onNone: () => [],
			onSome: (to) => [
				map(element(["complete", "half-applied"] as const), (how): After => ({
					kind: "migration",
					to,
					how
				}))
			]
		}
	)

const afterGen = (install: InstallSpec): Gen<After> =>
	weighted<After>([
		[3, map(directPlanGen(install), (direct): After => ({ kind: "direct", direct }))],
		[1, constant({ kind: "none" })],
		...Arr.map(migrationGen(install), (gen): Weighted<After> => [2, gen]),
		[3, constant({ kind: "led" })]
	])

const planGen =
	(install: InstallSpec): Gen<StatePlan> =>
	(source) => ({
		dbs: source.draw(array(dbPlanGen(install), { min: 0, max: 3 })),
		after: source.draw(afterGen(install))
	})

/**
 * The installations a case draws: the documents base's (docsInstalls) one time in two; one of its worlds with an editor
 * beside (docsEditorInstall, docsOneShareEditorInstall) one time in four, whose every fact outside an entry it writes
 * lies outside its world one way only: visible through a relation it holds whole, or hidden, which a Db or a direct
 * writer of the editor's meets each way under no claims, and a generated installation's roles rarely offer; and
 * otherwise its worlds with Visit written through a unit entry and through one filtering on a serial field
 * (docsVisitsInstall), the serial shapes a generated installation's roles rarely offer.
 */
const installsGen: Gen<InstallSpec> = weighted([
	[2, docsInstalls],
	[1, element([docsEditorInstall, docsOneShareEditorInstall])],
	[1, constant(docsVisitsInstall)]
])

const caseGen: Gen<InductiveCase> = (source) => {
	const install = source.draw(installsGen)
	return {
		install,
		pool: source.draw(element<Pool>(["default", "one connection"])),
		plan: source.draw(planGen(install)),
		weights: source.draw(weightsGen)
	}
}

/**
 * The actions that bring a staged world to a plan's state: each Db opened with its token, its reads performed (its
 * session the next id the model mints) and closed when its plan says; then what follows them: the direct writer's
 * transaction begun at SERIALIZABLE, its role taken on and its claims set, and then aborted by a SET ROLE to the owner
 * or committed when its plan says; or the migration, which leaves every Db opened before it stale; a lead's moves are
 * drawn once these are performed (leadOf). Every one of them a serial driver can perform: the direct transaction opens
 * last, and no migration runs beside it.
 */
const setupOf = (plan: StatePlan): ReadonlyArray<Action> => [
	...Arr.flatMap(plan.dbs, (db, id): ReadonlyArray<Action> => [
		{ kind: "open-db", role: { kind: "own", role: db.role }, token: db.token, snapshot: "current" },
		...Arr.map(db.reads, (relation): Action => ({
			kind: "read",
			session: id,
			relation,
			via: { kind: "execute" }
		})),
		...(db.closed ? [{ kind: "close", session: id } satisfies Action] : [])
	]),
	...afterActions(plan.dbs.length, plan.after)
]

/** The actions of what follows the Db sessions, the direct writer's session the next id. */
const afterActions = (session: number, after: After): ReadonlyArray<Action> => {
	switch (after.kind) {
		case "none":
		case "led":
			return []
		case "migration":
			return [{ kind: "migrate", to: after.to, how: after.how }]
		case "direct": {
			const direct = after.direct
			return [
				{
					kind: "direct-begin",
					login: direct.login,
					isolation: "serializable",
					start: { current: { kind: "login" }, claims: { kind: "none" } }
				},
				...(direct.current.kind === "role"
					? [
							{
								kind: "direct",
								session,
								statement: { kind: "set-role", role: { kind: "own", role: direct.current.role } }
							} satisfies Action
						]
					: []),
				...(direct.claims.kind === "set"
					? [
							{
								kind: "direct",
								session,
								statement: { kind: "set-claims", setting: direct.claims.setting }
							} satisfies Action
						]
					: []),
				...transactionEnd(session, direct.transaction)
			]
		}
	}
}

/** The actions that leave a direct writer's transaction where its plan has it: none for an open one. */
const transactionEnd = (
	session: number,
	transaction: DirectPlan["transaction"]
): ReadonlyArray<Action> => {
	switch (transaction) {
		case "open":
			return []
		case "aborted":
			return [{ kind: "direct", session, statement: { kind: "set-role", role: { kind: "owner" } } }]
		case "ended":
			return [{ kind: "direct-end", session, end: "commit" }]
	}
}

/**
 * Holds the state the setup reached to its plan: every planned Db open of its role or closed, and the direct writer
 * acting and claiming as planned with its transaction open or aborted, or closed once ended.
 */
const reachedPlan = (state: ModelState, plan: StatePlan): void => {
	assert.equal(
		state.sessions.length,
		plan.dbs.length + (plan.after.kind === "direct" ? 1 : 0),
		"the setup opens every planned session"
	)
	for (const [id, db] of plan.dbs.entries()) {
		const held = state.sessions[id]
		assert.ok(
			db.closed ? held?.kind === "closed" : held?.kind === "db" && held.role === db.role,
			`the setup leaves session ${id} ${db.closed ? "closed" : `a Db of ${db.role}`}`
		)
	}
	if (plan.after.kind !== "direct") {
		return
	}
	const held = state.sessions[plan.dbs.length]
	const planned = plan.after.direct
	if (planned.transaction === "ended") {
		assert.ok(held?.kind === "closed", "the setup ends the direct writer's transaction")
		return
	}
	assert.ok(
		held?.kind === "direct" && held.transaction === planned.transaction,
		`the setup leaves the direct writer's transaction ${planned.transaction}`
	)
	assert.deepEqual(
		{ login: held.login, current: held.current, claims: held.claims },
		{ login: planned.login, current: planned.current, claims: planned.claims },
		"the direct writer acts and claims as planned"
	)
}

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"the worlds model: inductive",
	(it) => {
		it.effect(
			name,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/world-model/inductive",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<WorldFeature>(situations, {
								cases: steeredFactor * cases,
								sense: notesOnly
							}),
							kept: [],
							runs: cases,
							shrink: { kind: "bounded", candidates: 200 },
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(ic, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const world =
										ic.pool === "default"
											? yield* realize(ic.install, ordinarySession)
											: yield* realizeRace(ic.install, ordinarySession, 1)
									const staged = yield* stage(world, ic.install, c.draw, docsAtCapacityRealities)
									const setup = setupOf(ic.plan)
									const planned = yield* Effect.reduce(
										setup,
										(): ModelState => staged.start,
										(state, action, index) =>
											Effect.map(
												runStep(world, state, action, index, unnoted),
												(stepped) => stepped.next
											)
									)
									reachedPlan(planned, ic.plan)
									const led: Led =
										ic.plan.after.kind === "led"
											? leadOf(leads, situations, ic.weights, c)
											: { moves: [], aims: situations }
									const reached = yield* Effect.reduce(
										led.moves,
										(): ModelState => planned,
										(state, weights, index) =>
											Effect.map(
												runStep(
													world,
													state,
													drawAction(c.draw, state, weights),
													setup.length + index,
													unnoted
												),
												(stepped) => stepped.next
											)
									)
									const action = drawAction(
										c.draw,
										reached,
										steeredOnce({ ...ic.weights, aims: aimsAt(led.aims, notedOf) }, c)
									)
									yield* runStep(world, reached, action, setup.length + led.moves.length, c)
								})
							)
					)
				),
			3_600_000
		)
	}
)
