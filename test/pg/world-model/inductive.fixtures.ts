import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option,
	type Steered,
	steered,
	weighted,
	type Weighted
} from "@bjornpagen/testing/gen"
import type { NeedFailed, Resources } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, type Scope, String as Str } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	aimsAt,
	docsAtBoundRealities,
	everyAction,
	featuresOfSituation,
	type Focus,
	generatedDocsInstalls,
	type PendingFeatures,
	pendingOf,
	type Realities,
	steeredOnce
} from "#test/support/worlds/drive/suite.ts"
import { type RacingWorld, realizeRace } from "#test/support/worlds/execute/index.ts"
import type { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { templateWorld, worldTemplate } from "#test/support/worlds/execute/template.ts"
import { featuresOf, requiredWorldFeatures } from "#test/support/worlds/features.ts"
import { knownNonEmpty, pool, uuidToken } from "#test/support/worlds/generate/domain.ts"
import { defaultScope, enumerateInstalls } from "#test/support/worlds/generate/enumerate.ts"
import { everyRole, type Weights, weightsGen } from "#test/support/worlds/generate/weights.ts"
import { malformedTexts } from "#test/support/worlds/invalid/claims.ts"
import {
	docsEditorInstall,
	docsHeldRosterInstall,
	docsInstall,
	docsLevelInstall,
	docsOneShareEditorInstall,
	docsOneShareInstall,
	docsVisitsInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { roleContexts, rolesOfLogin, samePlain } from "#test/support/worlds/model/session/state.ts"
import type {
	Action,
	ContextFacts,
	ContextSpec,
	ClaimsStart,
	DirectSessionState,
	DirectStatement,
	FieldSpec,
	HostFact,
	HostState,
	InstallSpec,
	MigrationHow,
	ModelState,
	SettingScope,
	Token,
	HostValue,
	WorldFeature
} from "#test/support/worlds/model/types.ts"

/**
 * What the population must reach: the whole worlds feature map. A case performs one action, so most of the map is
 * reached by the steered phase, which aims each case's one action at a required situation no case has reached yet; a
 * led case's lead first builds a state the planned states rarely hold (a transaction begun or one statement in, a Db
 * one apply in or just opened), from which its one action aims at what it offers.
 */
export const situations = requiredWorldFeatures

/**
 * The fixed installations a case may draw, by key: the documents base's own, its one-share and level worlds, its worlds
 * with an editor beside (one share or many), its worlds writing Visit through serial shapes, and its held-roster
 * worlds. Each is a template a case within its database clones (inductiveTemplates).
 */
const fixedInstalls = {
	docs: docsInstall,
	docsOneShare: docsOneShareInstall,
	docsLevel: docsLevelInstall,
	docsEditor: docsEditorInstall,
	docsOneShareEditor: docsOneShareEditorInstall,
	docsVisits: docsVisitsInstall,
	docsHeldRoster: docsHeldRosterInstall
} as const satisfies Readonly<Record<string, InstallSpec>>

type FixedInstall = keyof typeof fixedInstalls

/**
 * A case's installation as drawn, before anything is realized: a fixed installation by its key, whose template its
 * case may clone, or a generated one, which its case installs itself.
 */
type DrawnInstall =
	| { readonly kind: "fixed"; readonly key: FixedInstall }
	| { readonly kind: "generated"; readonly spec: InstallSpec }

const fixed = (key: FixedInstall): DrawnInstall => ({ kind: "fixed", key })

/** The installation a drawn one is. */
const specOf = (install: DrawnInstall): InstallSpec =>
	install.kind === "fixed" ? fixedInstalls[install.key] : install.spec

/**
 * How far a case's actions reach, drawn before anything is realized: within its own database, or past it. A
 * migration makes and drops roles, and a catalog change may alter a role, its memberships or its settings, and roles
 * are the cluster's, shared by every clone of a template; so a case within its database draws neither (kindsWithin),
 * and only such a case of a fixed installation clones its template (inductiveWorld), while one past it installs its
 * own, as every case did before templates.
 */
type Reach = "database" | "cluster"

/** The action kinds within a case's database: every kind but a migration and a catalog change. */
const databaseKinds: Focus = knownNonEmpty(
	Arr.filter(everyAction, (kind) => kind !== "migrate" && kind !== "tamper"),
	"the action kinds within a case's database"
)

/** The action kinds a case of `reach` draws: those within its database (databaseKinds), or every kind. */
const kindsWithin = (reach: Reach): Focus => (reach === "database" ? databaseKinds : everyAction)

/** Each fixed installation's world as a template (execute/template.ts worldTemplate), under the cluster's own ambient. */
const inductiveTemplates = Rec.map(fixedInstalls, (install, key) =>
	worldTemplate({
		declaredIn: import.meta,
		name: `inductive ${key}`,
		install,
		ambient: ordinarySession
	})
)

/**
 * The needs of the inductive property: each fixed installation's clone (Substrate.freshOf over its template), by its
 * key, and a substrate of its own (Substrate.fresh) for a case that installs its world itself.
 */
export const inductiveNeeds = {
	...Substrate.oneOf(inductiveTemplates, Substrate.freshOf),
	own: Substrate.fresh
} as const

/**
 * The world a case realizes, every login's pool `poolSize` connections at most: a clone of its fixed installation's
 * template where it is drawn within its database (Reach), or its own install in a substrate of its own.
 */
export const inductiveWorld = (
	resources: Resources<typeof inductiveNeeds>,
	ic: InductiveCase,
	poolSize: number
): Effect.Effect<RacingWorld, RealizeRefused | SqlError | NeedFailed, Scope.Scope> =>
	ic.install.kind === "fixed" && ic.reach === "database"
		? Effect.flatMap(resources[ic.install.key], (taken) =>
				templateWorld(taken, Option.some(poolSize))
			)
		: Effect.flatMap(resources.own, (substrate) =>
				Effect.provideService(
					realizeRace(specOf(ic.install), ordinarySession, poolSize),
					Substrate,
					substrate
				)
			)

/** The installation a case's world is (specOf). */
export const installOf = (ic: InductiveCase): InstallSpec => specOf(ic.install)

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
	readonly claims: ClaimsStart
	/** What its transaction sends past its role and claims, before its end: nothing in a drawn plan, the statement a
	 * constructed one is past (constructedPlan). */
	readonly sent: ReadonlyArray<DirectStatement>
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
 * The pool each login's DbLayer gets: one connection for each Db the state opens, over which the Dbs' reads spread, or
 * one connection, which every Db of a login shares, whatever its role.
 */
type Pool = "a connection per Db" | "one connection"

/**
 * An inductive case: the installation as drawn (DrawnInstall), how far its actions reach (Reach), its pool, the state's
 * plan and the weights of its one action. The property draws the reality and the action from the case's own tape, once
 * the installation's names exist and the setup has reached the planned state.
 */
export interface InductiveCase {
	readonly install: DrawnInstall
	readonly reach: Reach
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
				oneOf<ClaimsStart>([
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
			sent: [],
			transaction: source.draw(element(["open", "aborted", "ended"] as const))
		}
	}

/**
 * A migration after the Db sessions: to the box's first installation other than the case's, when the box holds one and
 * the case reaches past its database (Reach), since a migration makes and drops the cluster's roles.
 */
const migrationGen = (install: InstallSpec, reach: Reach): ReadonlyArray<Gen<After>> =>
	reach === "database"
		? []
		: Option.match(
				Arr.findFirst(
					enumerateInstalls(install.base, defaultScope),
					(to) => !samePlain(to, install)
				),
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

const afterGen = (install: InstallSpec, reach: Reach): Gen<After> =>
	weighted<After>([
		[3, map(directPlanGen(install), (direct): After => ({ kind: "direct", direct }))],
		[1, constant({ kind: "none" })],
		...Arr.map(migrationGen(install, reach), (gen): Weighted<After> => [2, gen]),
		[3, constant({ kind: "led" })]
	])

const planGen =
	(install: InstallSpec, reach: Reach): Gen<StatePlan> =>
	(source) => ({
		dbs: source.draw(array(dbPlanGen(install), { min: 0, max: 3 })),
		after: source.draw(afterGen(install, reach))
	})

/**
 * The installations a case draws, each a fixed installation by its key (fixedInstalls) or a generated one: the documents
 * base's (drive/suite.ts docsInstalls, its five fixed installations or a generated one) two times in five; one of its worlds with an
 * editor beside (docsEditorInstall, docsOneShareEditorInstall) one time in five, whose every fact outside an entry it
 * writes lies outside its world one way only: visible through a relation it holds whole, or hidden, which a Db or a
 * direct writer of the editor's meets each way under no claims, and a generated installation's roles rarely offer; its
 * worlds with Visit written through a unit entry, one filtering on a serial field and one fixing one
 * (docsVisitsInstall), the serial shapes a generated installation's roles rarely offer, one time in five; and
 * otherwise the held-roster worlds (docsHeldRosterInstall), where a stored visit holds a handle of Tier, which no other
 * documents base's field holds (migration:roster-removal-held), and a role of two writes Visit through a filter on a
 * serial field (fact:filtered-serial-omitted).
 */
const installsGen: Gen<DrawnInstall> = weighted([
	[
		2,
		oneOf([
			map(
				element<FixedInstall>([
					"docs",
					"docsOneShare",
					"docsLevel",
					"docsEditor",
					"docsOneShareEditor"
				]),
				fixed
			),
			map(generatedDocsInstalls, (spec): DrawnInstall => ({ kind: "generated", spec }))
		])
	],
	[1, map(element<FixedInstall>(["docsEditor", "docsOneShareEditor"]), fixed)],
	[1, constant(fixed("docsVisits"))],
	[1, constant(fixed("docsHeldRoster"))]
])

const poolGen: Gen<Pool> = element<Pool>(["a connection per Db", "one connection"])

/**
 * A case of `reach`: its installation (installsGen), its pool, its state's plan, and its weights, whose kinds are those
 * of its reach (kindsWithin).
 */
const caseGen =
	(reach: Reach): Gen<InductiveCase> =>
	(source) => {
		const install = source.draw(installsGen)
		const weights = source.draw(weightsGen)
		return {
			install,
			reach,
			pool: source.draw(poolGen),
			plan: source.draw(planGen(specOf(install), reach)),
			weights: { ...weights, kinds: kindsWithin(reach) }
		}
	}

/** The connections each login's pool of a case holds at most (Pool): one per Db its state opens, or one. */
export const poolSizeOf = (ic: InductiveCase): number =>
	ic.pool === "one connection" ? 1 : Math.max(1, ic.plan.dbs.length)

/**
 * The required features a drawn state rarely offers a way to, each reached one action past a state the generator builds
 * where a case's turn aims at it (Pending `aimed`, inductiveSketches): the editor's worlds (docsEditorInstall) over
 * constructedReality, whose one organization, on the free plan, lies outside PlanOrg, the entry the editor writes, yet
 * visible through Org whole beside it, and whose one document lies outside TenantDoc under no claims, visible through
 * Doc whole.
 * - `readback:beside`: a Db of the editor under its tenant's claims, whose apply through TenantDoc reads Doc back, a
 *   whole entry beside the entry that writes its relation (model/session/apply.ts deltaOf);
 * - `op:direct:outside-visible:absent:direct-role:rows` and `...:law-refused`: the editor as a direct writer under no
 *   claims, a read of Org or Doc showing the organization or the document, and an insert at the organization's key
 *   that Org's key refuses;
 * - `op:direct:outside-visible:matching:direct-role:law-refused`: the same writer under the tenant's claims;
 * - `op:direct-end:inside:absent:direct-role:law-refused` and `...:matching:...`: the editor as a direct writer under
 *   no claims or the tenant's, its transaction one insert in, a note of its own into a document no one holds
 *   (strayNote), which only its COMMIT refuses.
 * A drawn state offers them only where the editor's installation, a reality holding a free organization and the
 * editor's transaction or Db meet, so a search whose other draws move (a feature added, the box offering a fact once)
 * can lose them on every label-fixed stream.
 */
type Constructed =
	| "readback:beside"
	| "op:direct:outside-visible:absent:direct-role:rows"
	| "op:direct:outside-visible:absent:direct-role:law-refused"
	| "op:direct:outside-visible:matching:direct-role:law-refused"
	| "op:direct-end:inside:absent:direct-role:law-refused"
	| "op:direct-end:inside:matching:direct-role:law-refused"

const constructedFeatures: Arr.NonEmptyReadonlyArray<Constructed> = [
	"readback:beside",
	"op:direct:outside-visible:absent:direct-role:rows",
	"op:direct:outside-visible:absent:direct-role:law-refused",
	"op:direct:outside-visible:matching:direct-role:law-refused",
	"op:direct-end:inside:absent:direct-role:law-refused",
	"op:direct-end:inside:matching:direct-role:law-refused"
]

/** The organization and the document of constructedReality: the uuid pool's first two tokens. */
const constructedOrg = uuidToken(1)
const constructedDoc = uuidToken(2)

/** A lawful documents reality of one organization on the free plan and one document of it, and nothing else. */
const constructedReality: HostState = new Map([
	["Org", [{ id: constructedOrg, plan: 0 }]],
	["Doc", [{ id: constructedDoc, org: constructedOrg, owner: "u_bg", words: 0 }]],
	["Share", []],
	["Note", []],
	["Visit", []]
])

const constructedRealities: Realities = () => constant(constructedReality)

/** The Tenant claim object of constructedReality's organization, and the claims holding it, set for the transaction. */
const tenantClaim: HostFact = { org: constructedOrg, seats: 0 }
const tenantFacts: ContextFacts = { Tenant: tenantClaim }
const tenantClaims: ClaimsStart = {
	kind: "set",
	setting: { kind: "facts", facts: tenantFacts, scope: "transaction" }
}

/** The editor as a direct writer of the login `ops`, its transaction open under `claims`, `sent` sent in it. */
const editorWriter = (claims: ClaimsStart, sent: ReadonlyArray<DirectStatement>): StatePlan => ({
	dbs: [],
	after: {
		kind: "direct",
		direct: {
			login: "ops",
			current: { kind: "role", role: "editor" },
			claims,
			sent,
			transaction: "open"
		}
	}
})

/**
 * An insert of a note of the editor's own (EdNote's author) into a document constructedReality does not hold, the pool's
 * third token: row security admits it, and Note's containment into Doc, deferred since Doc has fields beyond its id,
 * refuses it at COMMIT alone.
 */
const strayNote: DirectStatement = {
	kind: "insert",
	relation: "Note",
	fact: { no: 1, doc: uuidToken(3), author: "u_ed" }
}

/** The planned state a constructed feature is one action past (Constructed). */
const constructedPlan = (feature: Constructed): StatePlan => {
	switch (feature) {
		case "readback:beside":
			return {
				dbs: [
					{
						role: "editor",
						token: { kind: "live", payload: { t: tenantClaim } },
						reads: [],
						closed: false
					}
				],
				after: { kind: "none" }
			}
		case "op:direct:outside-visible:absent:direct-role:rows":
		case "op:direct:outside-visible:absent:direct-role:law-refused":
			return editorWriter({ kind: "none" }, [])
		case "op:direct:outside-visible:matching:direct-role:law-refused":
			return editorWriter(tenantClaims, [])
		case "op:direct-end:inside:absent:direct-role:law-refused":
			return editorWriter({ kind: "none" }, [strayNote])
		case "op:direct-end:inside:matching:direct-role:law-refused":
			return editorWriter(tenantClaims, [strayNote])
	}
}

/**
 * Where a case starts, as drawn: a drawn case; or, where its turn aims at a constructed feature, that feature, with the
 * drawn case's pool and weights, within its database (the editor's worlds are a fixed installation, and no constructed
 * feature is a migration's or a catalog change's).
 */
type StartSketch =
	| { readonly kind: "drawn"; readonly drawn: InductiveCase }
	| {
			readonly kind: "constructed"
			readonly feature: Constructed
			readonly pool: Pool
			readonly weights: Weights
	  }

/**
 * An inductive case as drawn: where it starts, and the features its turn aimed it at (PendingFeatures): none for a case
 * of the rotating stream, and the features of the required situation a steered case aims at, so a kept or replayed
 * case aims as the drawn one did.
 */
export interface InductiveSketch {
	readonly start: StartSketch
	readonly pending: PendingFeatures
}

/**
 * Whether a case aimed at `feature` reaches past its database: a catalog change's or a migration's invalid kinds
 * (invalid/kinds.ts, the catalog and migration boundaries), a migrate's or a tamper's op features, and what only a
 * migration past an open Db leaves, a stale snapshot. A case aimed at one draws its actions of every kind (Reach).
 */
const pastTheDatabase = (feature: string): boolean =>
	Arr.some(pastTheDatabasePrefixes, (prefix) => Str.startsWith(prefix)(feature)) ||
	Arr.contains(pastTheDatabaseFeatures, feature)

/** The prefixes of the features a migration or a catalog change reaches (pastTheDatabase). */
const pastTheDatabasePrefixes = [
	"invalid:catalog:",
	"invalid:migration:",
	"op:migrate:",
	"op:tamper:"
] as const

/** The features only a migration past an open Db reaches, the stale snapshot it leaves (pastTheDatabase). */
const pastTheDatabaseFeatures: ReadonlyArray<string> = [
	"invalid:handle:stale-snapshot",
	"connection:after-stale-snapshot"
]

/**
 * The reach of a case of the rotating stream: within its database three times in four, so most cases clone their
 * installation's template, and past it otherwise, where its one action may be a migration or a catalog change.
 */
const reachGen: Gen<Reach> = weighted<Reach>([
	[3, constant("database")],
	[1, constant("cluster")]
])

/**
 * The reach of a case a steered turn aims at a required situation: past its database exactly where the situation is
 * (pastTheDatabase), so a case aimed at a migration's or a catalog change's feature may draw them, and every other
 * aimed case clones its template.
 */
const aimedReach = (situation: Reached<WorldFeature>): Reach =>
	Arr.some(featuresOfSituation(situation), pastTheDatabase) ? "cluster" : "database"

/**
 * The cases a witness draws: a drawn case (caseGen) of a drawn reach (reachGen) for a case of the rotating stream,
 * aimed at nothing; and, under a steered turn, a case of its aim's reach (aimedReach), or that feature's constructed
 * start where its turn aims at a constructed feature (Constructed), with the drawn case's pool and weights, its one
 * action aimed at every feature the steering left pending (pendingOf), as the old suite's steered generator aimed it.
 */
export const inductiveSpace: Steered<InductiveSketch, WorldFeature> = steered((steering) => {
	const pending = pendingOf(steering, situations)
	const aim = Option.flatMap(steering, (p) => Arr.findFirst(situations, (s) => p.aimed(s)))
	const constructed = Option.flatMap(steering, (p) =>
		Arr.findFirst(constructedFeatures, (f) => p.aimed(f))
	)
	return (source) => {
		const reach = Option.match(aim, {
			onNone: () => source.draw(reachGen),
			onSome: aimedReach
		})
		const drawn = source.draw(caseGen(reach))
		return {
			start: Option.match(constructed, {
				onNone: (): StartSketch => ({ kind: "drawn", drawn }),
				onSome: (feature): StartSketch => ({
					kind: "constructed",
					feature,
					pool: drawn.pool,
					weights: drawn.weights
				})
			}),
			pending
		}
	}
})

/**
 * Where a case starts and what its one action aims at: the drawn case over docsAtBoundRealities, its one action aimed
 * at every required feature still pending (steeredOnce); or, at a constructed feature, the editor's worlds in its
 * constructed state over constructedReality, its pool as drawn, and its one action of every kind as any role, aimed at
 * that feature alone; and what its steering left pending, which a led case's moves read (leadOf).
 */
interface Start {
	readonly ic: InductiveCase
	readonly realities: Realities
	readonly action: Weights
	readonly pending: PendingFeatures
}

/** The start a sketch states, resolved without its steering: every choice that read it is in the sketch. */
export const startOf = ({ start, pending }: InductiveSketch): Start => {
	switch (start.kind) {
		case "drawn":
			return {
				ic: start.drawn,
				realities: docsAtBoundRealities,
				action: steeredOnce(
					{ ...start.drawn.weights, aims: aimsAt(situations, featuresOf) },
					pending
				),
				pending
			}
		case "constructed": {
			const weights: Weights = {
				...start.weights,
				kinds: kindsWithin("database"),
				roles: everyRole,
				aims: aimsAt([start.feature], featuresOf)
			}
			return {
				ic: {
					install: fixed("docsEditor"),
					reach: "database",
					pool: start.pool,
					plan: constructedPlan(start.feature),
					weights
				},
				realities: constructedRealities,
				action: steeredOnce(weights, pending),
				pending
			}
		}
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
export const setupOf = (plan: StatePlan): ReadonlyArray<Action> => [
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
				...Arr.map(direct.sent, (statement): Action => ({ kind: "direct", session, statement })),
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
export const reachedPlan = (state: ModelState, plan: StatePlan): void => {
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
	const claims: ClaimsStart =
		held.claims.kind === "none" ? held.claims : { kind: "set", setting: held.claims.setting }
	assert.deepEqual(
		{ login: held.login, current: held.current, claims },
		{ login: planned.login, current: planned.current, claims: planned.claims },
		"the direct writer acts and claims as planned"
	)
}
