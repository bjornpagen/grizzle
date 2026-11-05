import { Array as Arr, Effect, Record as Rec, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { closedId, pg, span } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	type AnySchema,
	alternatives,
	capacity,
	closed,
	contained,
	duration,
	key,
	type Mutable,
	mutable,
	on,
	ref,
	relation,
	schema,
	select,
	weigh,
	within
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import {
	type HostBound,
	everyFact,
	fieldsEqual,
	fieldsIn,
	type HostFact,
	type HostLaw,
	type HostRelation,
	type HostSchema,
	type HostSelection,
	hostSpan
} from "#test/pg/laws/families/model.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"

import {
	type Domains,
	installLaws,
	openWriter,
	runtimeSession,
	type Session
} from "#test/pg/laws/families/support.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import {
	type AlternativesLaws,
	type LawNames,
	lawNamesOf,
	parsedName
} from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The law-bearing schema families of the generated suites.
 *
 * Each family is a schema shape over the public API whose law parameters, selectors and mutability range over a small
 * space, every point of which is a variant, stated twice: once to grizzle, as a schema value it installs, and once to
 * the host (model.ts), as the relations and every law's violation query read from the statement's meaning. Each law
 * is read through the naming door from the statement that declares it (kernel/naming.ts lawNamesOf, over the family's
 * schema: a law's identity does not depend on the schema's name); the suites check that the installation enforces
 * exactly these. A step's ChangeSet is built at run time over the relation values by name, as a
 * JavaScript caller passes members (support.ts changeSetOf).
 *
 * - alternatives: `alternatives(Run, "stage", Stage, { s0: key(on(Pay0, "run")), ... })` over the boundary rosters of
 *   two to five handles: every handle armed, one unarmed, a payload relation two handles share, one armed of five: the
 *   arms' tagged foreign keys and the reverse obligation, which the parent's units check over the whole roster and
 *   each payload relation's over its own arms; each roster with every relation immutable and with every one mutable,
 *   and two with a mutable arm beside an immutable parent and an immutable arm beside a mutable one;
 * - scalar-group capacity: `capacity(on([select(]Team[, (t) => t.eq(t.open, v))], "id"), { from:
 *   on([select(]Member[, (m) => m.eq(m.active, v))], "team"), [weight: weigh("weight"),] within: within(low, high) })`,
 *   drawing a count or a sum of the member's weight, literal bounds or `ref("cap")`, the team's own field, a selector
 *   on either side or both, and the declared containment of members into teams or none (a member of no team is then
 *   lawful); the shapes are drawn so the law is residual, which includes an upper bound of one over a selected target
 *   (an upper bound of one over an unselected one is a UNIQUE over its source's projection, checked row by row);
 * - two laws sharing tables, over composite tenant keys: Crew(tenant, id) and Duty(tenant, id), with a selected
 *   source's containment `contained(on(select(Duty, (d) => d.eq(d.active, sel)), "tenant", "crew"), on(Crew, "tenant",
 *   "id"))`, a native foreign key from the selected side's generated columns, and a capacity over the same selected
 *   source into the same target, a count against `ref("cap")` or a sum of hours against a literal, whose triggers fire
 *   on both tables, and every anchor is a (tenant, id) tuple;
 * - span coverage: Rota(site, during) keyed by a span key, and `contained(on([select(]Visit[, (v) => v.eq(v.billable,
 *   b))], "site", "during"), on([select(]Rota[, (r) => r.eq(r.open, o))], "site", "during"))`, at most one side
 *   selected: a PERIOD foreign key for every visit into every rota fact, a tagged PERIOD foreign key into the rota
 *   facts a selector picks (Visit's STORED tag against a generated temporal unique over the selector), a residual
 *   coverage law for a selected visit, each met by fragments of adjacent rota spans, and Visit's candidate span key
 *   `key(on(Visit, "site", "during"))` beside its id; and the same coverage into Roster(shift, crew, place) keyed by
 *   (place, shift), `on(Roster, "place", "shift")`, whose fields are named apart from the source's and declared in
 *   another heading order, so the law pairs the sides' fields by their positions in the two lists alone;
 * - a work queue: `alternatives(Work, "standing", Standing, { wanted: Wanted, leased: Leased, done: Done })`, every
 *   handle armed, a candidate key on a lease's (resource, seat), and the lease's foreign key into Seat;
 * - timekeeping, the payroll example's time side: Employment and Shift keyed by span keys, and over the shifts a
 *   selector picks, a containment into Timesheet(employee, week), a native foreign key from the selected side's
 *   generated columns, a coverage by Employment, and a capacity summing the shifts' span widths per timesheet up to its
 *   own `ceiling`;
 * - deposits, the payroll example's money side: a pay line's deposits summing exactly to its `net`, at most a drawn
 *   number of deposits per line, and a line's own `net` within [0, gross], a capacity of a relation over itself,
 *   which installs as a row check;
 * - two capacities on one relation by two keys of one arity: Badge keyed by `id` with a candidate key `code`, at most
 *   two pins per badge `id` and at most two tags per badge `code`, so the two residual laws' DETAILs name Badge by
 *   different fields and each is read only by the codec of the law that raised it.
 *
 * Mutability is a coordinate of each relation, which the host states per relation (model.ts HostRelation `mutable`):
 * a put on a mutable relation is an UPDATE in place, on an immutable one the DELETE-then-insert pair, and a direct
 * writer's UPDATE of an immutable relation is refused by privilege. Most families draw it for all of their relations
 * or for none; the alternatives family draws it per relation too, an arm's apart from its parent's. A family's box
 * splits into its populations by mode (populationsOf), each a test of its own. Every schema installs with the same
 * writers (support.ts familyWriters): `app`, the grizzle writer of the family suites and, opened twice, the histories'
 * two grizzle writers, in the login `server`, and `direct`, the role their psql writers take on, in the login `psql`,
 * each writing every ordinary relation.
 */
export interface Family<P> {
	readonly label: string
	/**
	 * Every schema of the family, each with distinct parameters, every relation's mutability among them, in a fixed
	 * order: the family's whole parameter space, which a suite draws from per case within one population.
	 */
	readonly variants: Arr.NonEmptyReadonlyArray<P>
	readonly describe: (p: P) => string
	/**
	 * The coordinates of a schema in the family's box that the suite steers by: each must meet a refusal by every kind
	 * of residual law of a schema that holds it. A family of a few fixed schemas has none.
	 */
	readonly traits: (p: P) => ReadonlyArray<string>
	readonly domains: Domains
	readonly host: (p: P) => HostSchema
	/**
	 * The schema of `p` declared under a name: installed under a fresh one (installFamily), and rebuilt under the
	 * installed one to open it.
	 */
	readonly schema: (p: P) => (name: string) => AnySchema
	/**
	 * The grizzle writer `app`'s session on that installation, through a DbLayer of its own on the substrate's database.
	 */
	readonly connect: (
		p: P,
		installed: Installed
	) => Effect.Effect<Session, OpenError, Substrate | Scope.Scope>
}

/**
 * Installs the schema of `p` with its residual laws and its writers under a fresh schema name; the installation holds
 * no connection.
 */
export const installFamily = <P>(
	family: Family<P>,
	p: P,
	ambient: AmbientSession
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> => installLaws(family.schema(p), ambient)

/**
 * A population of a family's box: its schemas no relation of which is mutable, or those with a mutable relation. A
 * population's writers meet different statements (a privilege refusal of every UPDATE, or UPDATEs in place), so each
 * is a test of its own.
 */
export type Mode = "immutable" | "mutable"

/** The population of a schema, by its relations' mutability. */
export const modeOf = (host: HostSchema): Mode =>
	Arr.some(host.relations, (r) => r.mutable) ? "mutable" : "immutable"

/** The schemas of one population of a family's box, in box order. */
export const variantsOf = <P>(family: Family<P>, mode: Mode): ReadonlyArray<P> =>
	Arr.filter(family.variants, (p) => modeOf(family.host(p)) === mode)

/** One population of a family's box: its mode and its schemas, in box order. */
export interface Population<P> {
	readonly mode: Mode
	readonly variants: Arr.NonEmptyReadonlyArray<P>
}

/** The populations of a family's box that hold a schema: its first schema's, then the other mode's when it has one. */
export const populationsOf = <P>(family: Family<P>): Arr.NonEmptyReadonlyArray<Population<P>> => {
	const [first, ...rest] = family.variants
	const mode = modeOf(family.host(first))
	const other: Mode = mode === "immutable" ? "mutable" : "immutable"
	const own: Population<P> = {
		mode,
		variants: [first, ...Arr.filter(rest, (p) => modeOf(family.host(p)) === mode)]
	}
	const [next, ...more] = Arr.filter(rest, (p) => modeOf(family.host(p)) === other)
	return next === undefined ? [own] : [own, { mode: other, variants: [next, ...more] }]
}

const label = str.regex("^[a-z]{0,8}$")
/** The traits of a family of a few fixed schemas. */
export const noTraits = (): ReadonlyArray<string> => []

/** A relation as the host sees it: its table and columns named by the naming door (core/identity.ts). */
export const hostRelation = (
	name: string,
	fields: ReadonlyArray<string>,
	keyFields: ReadonlyArray<string>,
	mutable: boolean
): HostRelation => ({
	name,
	table: identity.table(parsedName(name)).identifier,
	fields: Arr.map(fields, (field) => ({
		name: field,
		column: identity.column(parsedName(field)).identifier
	})),
	key: keyFields,
	mutable
})

export const booleans: Arr.NonEmptyReadonlyArray<boolean> = [false, true]

/**
 * Which relations of a schema are declared `mutable`, by name: the mutability of each relation a family draws, which
 * its schema states and its host reads relation by relation.
 */
export type Mutability<R extends string> = Readonly<Record<R, boolean>>

/** The uniform mutabilities of a family's relations: none of them mutable, then every one. */
const uniformly = <R extends string>(
	relations: Readonly<Record<R, unknown>>
): Arr.NonEmptyReadonlyArray<Mutability<R>> =>
	Arr.map(booleans, (declared) => Rec.map(relations, () => declared))

/** The `mutable` statements of the relations a mutability declares mutable. */
export const mutables = <R extends string, V extends AnyRelation>(
	m: Mutability<R>,
	relations: Readonly<Record<R, V>>
): ReadonlyArray<Mutable<V>> =>
	Arr.flatMap(Rec.toEntries(relations), ([name, r]) => (m[name] ? [mutable(r)] : []))

/** A mutability as a schema's description names it: every relation's, or the mutable ones'. */
export const describeMutability = (m: Readonly<Record<string, boolean>>): string => {
	const all = Rec.toEntries(m)
	const declared = Arr.filter(all, ([, x]) => x)
	return declared.length === 0
		? "immutable"
		: declared.length === all.length
			? "mutable"
			: `${Arr.join(
					Arr.map(declared, ([name]) => name),
					" and "
				)} mutable`
}

const stages = ["draft", "approved", "paid", "voided"] as const
const Stage = closed("Stage", stages)
/** A payload relation of a drawn alternatives schema: the roster positions it is the payload of, its mutability. */
export interface PayArm {
	readonly handles: Arr.NonEmptyReadonlyArray<number>
	readonly mutable: boolean
}

/**
 * A drawn alternatives schema: a roster of `roster` handles `s0`.., the mutability of its parent Run, and its payload
 * relations `Pay0`.., each the payload of its own roster positions, no position of two, each with its own mutability.
 * A payload is keyed by its own `id`, with its parent's `run` a candidate key, so a `mutable` payload's move to another
 * parent is an UPDATE of `run`, and a `mutable` run's kind switch an UPDATE of `stage`.
 */
export interface RunsParams {
	readonly roster: number
	readonly runMutable: boolean
	readonly arms: Arr.NonEmptyReadonlyArray<PayArm>
}

/** The handle of a drawn roster at a position. */
export const stageName = (i: number): string => `s${i}`

/** The values of a drawn alternatives schema: its roster, parent and payload relations, and its statements. */
const drawnRuns = (p: RunsParams) => {
	const names: readonly [string, ...Array<string>] = [
		stageName(0),
		...Arr.makeBy(p.roster - 1, (i) => stageName(i + 1))
	]
	const DrawnStage = closed("Stage", names)
	const Run = relation("Run", { id: pg.integer, stage: closedId(DrawnStage), note: label }, ["id"])
	const pays = Arr.map(p.arms, (arm, j) => {
		const value = relation(`Pay${j}`, { id: pg.integer, run: pg.integer, amount: pg.integer }, [
			"id"
		])
		return { handles: arm.handles, mutable: arm.mutable, value, runKey: key(on(value, "run")) }
	})
	const byHandle: Record<string, (typeof pays)[number]["runKey"]> = {}
	for (const pay of pays) {
		for (const h of pay.handles) {
			byHandle[stageName(h)] = pay.runKey
		}
	}
	const stage = alternatives(Run, "stage", DrawnStage, byHandle)
	const relations: Record<string, AnyRelation | typeof DrawnStage> = { Stage: DrawnStage, Run }
	for (const pay of pays) {
		relations[pay.value.name] = pay.value
	}
	return { DrawnStage, Run, pays, stage, relations }
}

/** A drawn alternatives schema under a name. */
export const runs = (p: RunsParams) => (name: string) => {
	const d = drawnRuns(p)
	return schema(name, d.relations, [
		d.stage,
		...Arr.map(d.pays, (pay) => pay.runKey),
		...(p.runMutable ? [mutable(d.Run)] : []),
		...Arr.flatMap(d.pays, (pay) => (pay.mutable ? [mutable(pay.value)] : []))
	])
}

/** The relation values of a drawn alternatives schema, by name, as a ChangeSet names them. */
export const runsRelations = (p: RunsParams): Readonly<Record<string, unknown>> =>
	drawnRuns(p).relations

/** A boundary roster: its size and the roster positions of its payload relations, in payload order. */
interface RosterShape {
	readonly roster: number
	readonly arms: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
}

/**
 * The boundary rosters, over two to five handles. A run's stage draws `s0` and `s1`, which every roster holds, so each
 * roster's arming shows at them: every handle armed (two handles); `s1` unarmed (three); `s0` and `s1` the payload of
 * one relation, beside an unarmed `s3` (four); and `s0` the one armed handle of five.
 */
const everyHandleArmed: RosterShape = { roster: 2, arms: [[0], [1]] }
const sharedPayload: RosterShape = { roster: 4, arms: [[0, 1], [2]] }
const rosterShapes: Arr.NonEmptyReadonlyArray<RosterShape> = [
	everyHandleArmed,
	{ roster: 3, arms: [[0], [2]] },
	sharedPayload,
	{ roster: 5, arms: [[0]] }
]

/** A roster shape with its run's mutability and each payload relation's, in payload order. */
const runsOf = (
	shape: RosterShape,
	runMutable: boolean,
	armMutable: (j: number) => boolean
): RunsParams => ({
	roster: shape.roster,
	runMutable,
	arms: Arr.map(shape.arms, (handles, j) => ({ handles, mutable: armMutable(j) }))
})

/**
 * The family's whole box, each a schema the suite installs: every boundary roster with every relation immutable, and
 * with every relation mutable; and two rosters whose relations differ, every handle armed with an immutable run beside
 * a mutable `Pay0` and an immutable `Pay1`, and the shared payload relation's roster with a mutable run beside an
 * immutable shared `Pay0` and a mutable `Pay1`, so a mutable arm meets an immutable parent and an immutable arm a
 * mutable one.
 */
const runsBox: Arr.NonEmptyReadonlyArray<RunsParams> = Arr.appendAll(
	Arr.flatMap(booleans, (declared) =>
		Arr.map(rosterShapes, (shape) => runsOf(shape, declared, () => declared))
	),
	[runsOf(everyHandleArmed, false, (j) => j === 0), runsOf(sharedPayload, true, (j) => j !== 0)]
)

const armedCount = (p: RunsParams): number => Arr.flatten(Arr.map(p.arms, (a) => a.handles)).length

/** The mutability of a drawn schema's relations, as its description names them. */
const runsMutability = (p: RunsParams): Readonly<Record<string, boolean>> => ({
	Run: p.runMutable,
	...Rec.fromEntries(Arr.map(p.arms, (a, j) => [`Pay${j}`, a.mutable] as const))
})

const describeRuns = (p: RunsParams): string => {
	const armed = armedCount(p)
	const roster =
		armed === p.roster
			? "every handle armed"
			: armed === 1
				? "one handle armed"
				: `${p.roster - armed} unarmed`
	const shared = Arr.some(p.arms, (a) => a.handles.length > 1) ? ", a payload relation shared" : ""
	return `${describeMutability(runsMutability(p))}, ${p.roster} handles, ${roster}${shared}`
}

/**
 * The traits of an alternatives schema whose arms' mutability is not its parent's: a mutable arm beside an immutable
 * parent, an immutable arm beside a mutable one.
 */
const armMutabilityTraits = (
	parent: boolean,
	arms: ReadonlyArray<boolean>
): ReadonlyArray<string> => [
	...(!parent && arms.includes(true) ? ["a mutable arm beside an immutable parent"] : []),
	...(parent && arms.includes(false) ? ["an immutable arm beside a mutable parent"] : [])
]

/**
 * The shape of a drawn roster its schema bears: an unarmed handle, a shared payload relation; and an arm whose
 * mutability is not its parent's.
 */
const runsTraits = (p: RunsParams): ReadonlyArray<string> => [
	...(armedCount(p) < p.roster ? ["an unarmed handle"] : []),
	...(Arr.some(p.arms, (a) => a.handles.length > 1) ? ["a shared payload relation"] : []),
	...armMutabilityTraits(
		p.runMutable,
		Arr.map(p.arms, (a) => a.mutable)
	)
]

export const alternativesFamily: Family<RunsParams> = {
	label: "alternatives",
	variants: runsBox,
	describe: describeRuns,
	traits: runsTraits,
	domains: {
		Run: { id: [1, 2, 3], stage: ["s0", "s1"], note: ["a", "b"] },
		...Rec.fromEntries(
			Arr.makeBy(2, (j) => [`Pay${j}`, { id: [1, 2, 3], run: [1, 2, 3], amount: [1, 2] }] as const)
		)
	},
	host: (p) => {
		const d = drawnRuns(p)
		const laws = lawNamesOf(runs(p)("families"))
		const stage = laws.alternativesOf(d.stage)
		return {
			relations: [
				hostRelation("Run", ["id", "stage", "note"], ["id"], p.runMutable),
				...Arr.map(d.pays, (pay) =>
					hostRelation(pay.value.name, ["id", "run", "amount"], ["id"], pay.mutable)
				)
			],
			laws: [
				{
					kind: "key",
					law: laws.primaryKeyLaw(d.Run),
					relation: "Run",
					fields: ["id"],
					selection: everyFact
				},
				...Arr.flatMap(d.pays, (pay): HostSchema["laws"] => [
					{
						kind: "key",
						law: laws.primaryKeyLaw(pay.value),
						relation: pay.value.name,
						fields: ["id"],
						selection: everyFact
					},
					{
						kind: "key",
						law: laws.lawOf(pay.runKey),
						relation: pay.value.name,
						fields: ["run"],
						selection: everyFact
					},
					{
						kind: "contained",
						law: defined(stage.arms[stageName(pay.handles[0])], `${pay.value.name}'s arm law`),
						source: { relation: pay.value.name, fields: ["run"], selection: everyFact },
						target: {
							relation: "Run",
							fields: ["id"],
							selection: fieldsIn({ stage: Arr.map(pay.handles, stageName) })
						}
					},
					...Arr.map(pay.handles, (h): HostLaw => ({
						kind: "obliged",
						law: stage.reverse,
						anchor: {
							relation: "Run",
							fields: ["id"],
							selection: fieldsEqual({ stage: stageName(h) })
						},
						dependent: { relation: pay.value.name, fields: ["run"], selection: everyFact }
					}))
				])
			]
		}
	},
	schema: runs,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: runs(p)(installed.declared) }), (o) =>
			runtimeSession(alternativesFamily.host(p), o, runsRelations(p))
		)
}

export const Team = relation(
	"Team",
	{ id: pg.integer, name: label, open: pg.boolean, cap: pg.integer },
	["id"]
)

export const Member = relation(
	"Member",
	{ id: pg.integer, team: pg.integer, active: pg.boolean, weight: pg.integer },
	["id"]
)

/** A bound as drawn: a literal, or the target's own field `cap`. */
type DrawnBound = bigint | "cap"

/** A side's selector as drawn: none, or the value its boolean field must hold. */
type Selector = { readonly kind: "every" } | { readonly kind: "selected"; readonly value: boolean }
const every: Selector = { kind: "every" }
const selectors: Arr.NonEmptyReadonlyArray<Selector> = Arr.map(booleans, (value) => ({
	kind: "selected",
	value
}))

const teamsRelations = Object.freeze({ Team, Member })

export interface TeamsParams {
	readonly mutable: Mutability<keyof typeof teamsRelations>
	/** A sum of the member's weight, or a count. */
	readonly weighted: boolean
	readonly low: DrawnBound
	readonly high: DrawnBound | "*"
	/** The selectors, `open` on the team and `active` on the member. */
	readonly team: Selector
	readonly member: Selector
	/**
	 * Whether the schema declares the containment of every member into its team. Without it a member of no team is
	 * lawful, and a team's insertion is judged on the members already in its group.
	 */
	readonly governed: boolean
}

const boundOf = (b: DrawnBound) => (b === "cap" ? ref("cap") : b)
const hostBound = (b: DrawnBound): HostBound => (b === "cap" ? { ref: "cap" } : b)

/** The teams whose `open` holds a value, and the members whose `active` does. */
const openTeams = (open: boolean) => select(Team, (t) => t.eq(t.open, open))
const activeMembers = (active: boolean) => select(Member, (m) => m.eq(m.active, active))

const teamCapacity = (p: TeamsParams) =>
	capacity(p.team.kind === "every" ? on(Team, "id") : on(openTeams(p.team.value), "id"), {
		from:
			p.member.kind === "every" ? on(Member, "team") : on(activeMembers(p.member.value), "team"),
		...(p.weighted ? { weight: weigh("weight") } : {}),
		within: within(boundOf(p.low), p.high === "*" ? "*" : boundOf(p.high))
	})
const memberTeam = contained(on(Member, "team"), on(Team, "id"))

export const teams = (p: TeamsParams) => (name: string) =>
	schema(name, teamsRelations, [
		teamCapacity(p),
		...(p.governed ? [memberTeam] : []),
		...mutables(p.mutable, teamsRelations)
	])

/** A selector's facts: every one, or those whose `field` holds its value. */
const selectionOf = (field: string, s: Selector): HostSelection =>
	s.kind === "every" ? everyFact : fieldsEqual({ [field]: s.value })

/**
 * Every schema of one uniform mutability, shape by shape, which together hold every value of each dimension: count and
 * sum, literal and `ref` bounds on either side, no selector, a selected source, a selected target and both, with and
 * without the containment of the members into their teams. Every shape keeps the law residual: no upper bound of one
 * over an unselected count.
 *
 * A count within literal bounds, nothing selected.
 *
 * A sum of weights up to the team's own cap, both sides selected.
 *
 * At most one member per selected team: residual, since a unique index would also bound unselected teams.
 *
 * A sum of selected members' weights of at least the team's cap.
 *
 * At most two selected members per team, and no containment of members into teams: a member of no team is lawful,
 * so one writer can insert a team while another inserts members into its group, each alone within the bound.
 */
const capacityVariants = (
	mutable: Mutability<keyof typeof teamsRelations>
): Arr.NonEmptyReadonlyArray<TeamsParams> =>
	Arr.appendAll(
		[
			...Arr.flatMap([0n, 1n, 2n], (low) =>
				Arr.flatMap([2n, 3n], (high): ReadonlyArray<TeamsParams> =>
					low <= high
						? [
								{
									mutable,
									weighted: false,
									low,
									high,
									team: every,
									member: every,
									governed: true
								}
							]
						: []
				)
			),
			...Arr.flatMap([0n, 1n], (low) =>
				Arr.flatMap(selectors, (team) =>
					Arr.map(selectors, (member): TeamsParams => ({
						mutable,
						weighted: true,
						low,
						high: "cap",
						team,
						member,
						governed: true
					}))
				)
			),
			...Arr.map(selectors, (team): TeamsParams => ({
				mutable,
				weighted: false,
				low: 0n,
				high: 1n,
				team,
				member: every,
				governed: true
			})),
			...Arr.map(selectors, (member): TeamsParams => ({
				mutable,
				weighted: true,
				low: "cap",
				high: "*",
				team: every,
				member,
				governed: true
			}))
		],
		Arr.map(selectors, (member): TeamsParams => ({
			mutable,
			weighted: false,
			low: 0n,
			high: 2n,
			team: every,
			member,
			governed: false
		}))
	)

const describeSelector = (field: string, s: Selector): string =>
	s.kind === "every" ? "" : ` ${field} = ${s.value}`

const describeTeams = (p: TeamsParams): string =>
	Arr.join(
		[
			describeMutability(p.mutable),
			`${p.weighted ? "member weight" : "members"} per${describeSelector("open", p.team)} team within [${p.low}, ${p.high}]`,
			...(p.member.kind === "every"
				? []
				: [`members selected by${describeSelector("active", p.member)}`]),
			...(p.governed ? [] : ["no containment of members into teams"])
		],
		", "
	)

export const capacityFamily: Family<TeamsParams> = {
	label: "scalar-group capacity",
	variants: Arr.flatMap(uniformly(teamsRelations), capacityVariants),
	describe: describeTeams,
	traits: noTraits,
	domains: {
		Team: { id: [1, 2, 3], name: ["a", "b"], open: [true, false], cap: [0, 1, 2, 4] },
		Member: {
			id: [1, 2, 3, 4, 5, 6],
			team: [1, 2, 1, 2, 3],
			active: [true, false],
			weight: [1, 2, 3]
		}
	},
	host: (p) => {
		const laws = lawNamesOf(teams(p)("families"))
		return {
			relations: [
				hostRelation("Team", ["id", "name", "open", "cap"], ["id"], p.mutable.Team),
				hostRelation("Member", ["id", "team", "active", "weight"], ["id"], p.mutable.Member)
			],
			laws: [
				{
					kind: "key",
					law: laws.primaryKeyLaw(Team),
					relation: "Team",
					fields: ["id"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(Member),
					relation: "Member",
					fields: ["id"],
					selection: everyFact
				},
				...(p.governed
					? [
							{
								kind: "contained",
								law: laws.lawOf(memberTeam),
								source: { relation: "Member", fields: ["team"], selection: everyFact },
								target: { relation: "Team", fields: ["id"], selection: everyFact }
							} satisfies HostLaw
						]
					: []),
				{
					kind: "capacity",
					law: laws.lawOf(teamCapacity(p)),
					target: { relation: "Team", fields: ["id"], selection: selectionOf("open", p.team) },
					source: {
						relation: "Member",
						fields: ["team"],
						selection: selectionOf("active", p.member)
					},
					weight: p.weighted ? { kind: "field", field: "weight" } : { kind: "count" },
					low: hostBound(p.low),
					high: p.high === "*" ? "*" : hostBound(p.high)
				}
			]
		}
	},
	schema: teams,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: teams(p)(installed.declared) }), (o) =>
			runtimeSession(capacityFamily.host(p), o, teamsRelations)
		)
}

export const Crew = relation(
	"Crew",
	{ tenant: pg.integer, id: pg.integer, cap: pg.integer, name: label },
	["tenant", "id"]
)

export const Duty = relation(
	"Duty",
	{ tenant: pg.integer, id: pg.integer, crew: pg.integer, active: pg.boolean, hours: pg.integer },
	["tenant", "id"]
)

const crewsRelations = Object.freeze({ Crew, Duty })

export interface CrewsParams {
	readonly mutable: Mutability<keyof typeof crewsRelations>
	readonly selector: boolean
	/** A sum of hours against a literal upper bound, or a count against the crew's cap. */
	readonly weighted: boolean
	readonly low: bigint
	readonly high: DrawnBound
}

/** The duties the selector picks, by tenant and crew: the side both laws read. */
const activeDuties = (p: CrewsParams) =>
	on(
		select(Duty, (d) => d.eq(d.active, p.selector)),
		"tenant",
		"crew"
	)

const crewDuties = (p: CrewsParams) => contained(activeDuties(p), on(Crew, "tenant", "id"))

const crewCapacity = (p: CrewsParams) =>
	capacity(on(Crew, "tenant", "id"), {
		from: activeDuties(p),
		...(p.weighted ? { weight: weigh("hours") } : {}),
		within: within(p.low, boundOf(p.high))
	})

export const crews = (p: CrewsParams) => (name: string) =>
	schema(name, crewsRelations, [
		crewDuties(p),
		crewCapacity(p),
		...mutables(p.mutable, crewsRelations)
	])

const lowBounds: Arr.NonEmptyReadonlyArray<bigint> = [0n, 1n]

/**
 * Every schema of one uniform mutability: a count against the crew's cap, or a sum of hours against a literal, each
 * selector value and each lower bound.
 */
const crewVariants = (
	mutable: Mutability<keyof typeof crewsRelations>
): Arr.NonEmptyReadonlyArray<CrewsParams> =>
	Arr.flatMap(booleans, (selector) =>
		Arr.flatMap(lowBounds, (low): Arr.NonEmptyReadonlyArray<CrewsParams> => [
			{ mutable, selector, weighted: false, low, high: "cap" },
			...Arr.map([2n, 3n], (high): CrewsParams => ({
				mutable,
				selector,
				weighted: true,
				low,
				high
			}))
		])
	)

export const sharedTablesFamily: Family<CrewsParams> = {
	label: "selected-source containment and capacity sharing tables, tenant keys",
	variants: Arr.flatMap(uniformly(crewsRelations), crewVariants),
	describe: (p) =>
		`${describeMutability(p.mutable)}, Duty selected by active = ${p.selector}, ${p.weighted ? "hours" : "duties"} per crew within [${p.low}, ${p.high}]`,
	traits: noTraits,
	/** A tenant holds up to six duties, so a crew of the largest cap, three, can be overfilled by duties of its own. */
	domains: {
		Crew: { tenant: [1, 2], id: [1, 2], cap: [1, 2, 3], name: ["a", "b"] },
		Duty: {
			tenant: [1, 2],
			id: [1, 2, 3, 4, 5, 6],
			crew: [1, 2, 3],
			active: [true, false],
			hours: [1, 2]
		}
	},
	host: (p) => {
		const laws = lawNamesOf(crews(p)("families"))
		return {
			relations: [
				hostRelation("Crew", ["tenant", "id", "cap", "name"], ["tenant", "id"], p.mutable.Crew),
				hostRelation(
					"Duty",
					["tenant", "id", "crew", "active", "hours"],
					["tenant", "id"],
					p.mutable.Duty
				)
			],
			laws: [
				{
					kind: "key",
					law: laws.primaryKeyLaw(Crew),
					relation: "Crew",
					fields: ["tenant", "id"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(Duty),
					relation: "Duty",
					fields: ["tenant", "id"],
					selection: everyFact
				},
				{
					kind: "contained",
					law: laws.lawOf(crewDuties(p)),
					source: {
						relation: "Duty",
						fields: ["tenant", "crew"],
						selection: fieldsEqual({ active: p.selector })
					},
					target: { relation: "Crew", fields: ["tenant", "id"], selection: everyFact }
				},
				{
					kind: "capacity",
					law: laws.lawOf(crewCapacity(p)),
					target: { relation: "Crew", fields: ["tenant", "id"], selection: everyFact },
					source: {
						relation: "Duty",
						fields: ["tenant", "crew"],
						selection: fieldsEqual({ active: p.selector })
					},
					weight: p.weighted ? { kind: "field", field: "hours" } : { kind: "count" },
					low: p.low,
					high: hostBound(p.high)
				}
			]
		}
	},
	schema: crews,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: crews(p)(installed.declared) }), (o) =>
			runtimeSession(sharedTablesFamily.host(p), o, crewsRelations)
		)
}

export const Rota = relation(
	"Rota",
	{ site: pg.integer, during: span(pg.integer), crew: pg.integer, open: pg.boolean },
	["site", "during"]
)

export const Visit = relation(
	"Visit",
	{ id: pg.integer, site: pg.integer, during: span(pg.integer), billable: pg.boolean },
	["id"]
)

/** The coverage's target with its fields named apart from Visit's `site` and `during`, in another heading order. */
export const Roster = relation(
	"Roster",
	{ shift: span(pg.integer), crew: pg.integer, place: pg.integer, open: pg.boolean },
	["place", "shift"]
)

export interface VisitsParams {
	/** The mutability of the coverage's sides: Visit, its source, and the rota or the roster, its target. */
	readonly mutable: Mutability<"source" | "target">
	/** Every visit covered, a PERIOD foreign key, or the visits whose `billable` holds the value, a residual law. */
	readonly visits: Selector
	/**
	 * The target the visits are covered by: the rota, whose fields are named as the visit's, or the roster, whose
	 * fields are named apart and declared in another order.
	 */
	readonly target: "rota" | "roster"
	/** The target facts that cover: every one, or those whose `open` holds the value, a tagged PERIOD foreign key. */
	readonly cover: Selector
}

/** The visits a `billable` value selects, and the rota and roster facts an `open` value selects. */
const billableVisits = (billable: boolean) => select(Visit, (v) => v.eq(v.billable, billable))
const openRota = (open: boolean) => select(Rota, (r) => r.eq(r.open, open))
const openRoster = (open: boolean) => select(Roster, (r) => r.eq(r.open, open))

/** The source side of the coverage: every visit, or the visits a selector picks. */
const visitSide = (p: VisitsParams) =>
	p.visits.kind === "every"
		? on(Visit, "site", "during")
		: on(billableVisits(p.visits.value), "site", "during")

const rotaCoverage = (p: VisitsParams) =>
	contained(
		visitSide(p),
		p.cover.kind === "every"
			? on(Rota, "site", "during")
			: on(openRota(p.cover.value), "site", "during")
	)

const rosterCoverage = (p: VisitsParams) =>
	contained(
		visitSide(p),
		p.cover.kind === "every"
			? on(Roster, "place", "shift")
			: on(openRoster(p.cover.value), "place", "shift")
	)

/**
 * Visit's candidate span key: no two visits of one site overlap, the UNIQUE ... WITHOUT OVERLAPS form beside its id.
 */
const visitSpanKey = key(on(Visit, "site", "during"))

export const visits = (p: VisitsParams) => (name: string) =>
	schema(name, { Rota, Visit }, [
		visitSpanKey,
		rotaCoverage(p),
		...mutables(p.mutable, { source: Visit, target: Rota })
	])

export const rosterVisits = (p: VisitsParams) => (name: string) =>
	schema(name, { Roster, Visit }, [
		visitSpanKey,
		rosterCoverage(p),
		...mutables(p.mutable, { source: Visit, target: Roster })
	])

const visitRelation = (p: VisitsParams): HostRelation =>
	hostRelation("Visit", ["id", "site", "during", "billable"], ["id"], p.mutable.source)
const visitKey = (laws: LawNames): HostLaw => ({
	kind: "key",
	law: laws.primaryKeyLaw(Visit),
	relation: "Visit",
	fields: ["id"],
	selection: everyFact
})

const visitSpanKeyLaw = (laws: LawNames): HostLaw => ({
	kind: "spanKey",
	law: laws.lawOf(visitSpanKey),
	relation: "Visit",
	scalars: ["site"],
	span: "during"
})

const coverageHost = (p: VisitsParams): HostSchema => {
	const source = {
		relation: "Visit",
		fields: ["site"],
		selection: selectionOf("billable", p.visits)
	}
	const residual = p.visits.kind === "selected"
	switch (p.target) {
		case "rota": {
			const laws = lawNamesOf(visits(p)("families"))
			return {
				relations: [
					hostRelation(
						"Rota",
						["site", "during", "crew", "open"],
						["site", "during"],
						p.mutable.target
					),
					visitRelation(p)
				],
				laws: [
					{
						kind: "spanKey",
						law: laws.primaryKeyLaw(Rota),
						relation: "Rota",
						scalars: ["site"],
						span: "during"
					},
					visitKey(laws),
					visitSpanKeyLaw(laws),
					{
						kind: "covered",
						law: laws.lawOf(rotaCoverage(p)),
						source,
						target: { relation: "Rota", fields: ["site"], selection: selectionOf("open", p.cover) },
						span: { source: "during", target: "during" },
						residual
					}
				]
			}
		}
		case "roster": {
			const laws = lawNamesOf(rosterVisits(p)("families"))
			return {
				relations: [
					hostRelation(
						"Roster",
						["shift", "crew", "place", "open"],
						["place", "shift"],
						p.mutable.target
					),
					visitRelation(p)
				],
				laws: [
					{
						kind: "spanKey",
						law: laws.primaryKeyLaw(Roster),
						relation: "Roster",
						scalars: ["place"],
						span: "shift"
					},
					visitKey(laws),
					visitSpanKeyLaw(laws),
					{
						kind: "covered",
						law: laws.lawOf(rosterCoverage(p)),
						source,
						target: {
							relation: "Roster",
							fields: ["place"],
							selection: selectionOf("open", p.cover)
						},
						span: { source: "during", target: "shift" },
						residual
					}
				]
			}
		}
	}
}

/**
 * The selected sides a containment admits, at most one: a selected visit into every target fact, or every visit into
 * the target facts a selector picks.
 */
const coverageSides: Arr.NonEmptyReadonlyArray<Pick<VisitsParams, "visits" | "cover">> =
	Arr.appendAll(
		Arr.map(Arr.prepend(selectors, every), (seen) => ({ visits: seen, cover: every })),
		Arr.map(selectors, (cover) => ({ visits: every, cover }))
	)

export const spanCoverage: Family<VisitsParams> = {
	label: "span coverage",
	/** Every side in coverageSides, covered by the rota or by the roster, each uniform mutability. */
	variants: Arr.flatMap(uniformly({ source: Visit, target: Rota }), (mutable) =>
		Arr.flatMap(coverageSides, (sides) =>
			Arr.map(["rota", "roster"] as const, (target): VisitsParams => ({
				mutable,
				target,
				...sides
			}))
		)
	),
	describe: (p) =>
		`${describeMutability(p.mutable)}, ${p.visits.kind === "every" ? "every visit" : `visits selected by billable = ${p.visits.value}`}${p.target === "rota" ? " covered by the rota" : " covered by the roster, across renamed fields"}${p.cover.kind === "every" ? "" : ` facts selected by open = ${p.cover.value}`}`,
	traits: noTraits,
	/**
	 * Adjacent rota spans cover a visit across their boundary only together; [3, 7) needs both [0, 5) and [5, 10). The
	 * roster draws the rota's values under its own names.
	 */
	domains: {
		Rota: {
			site: [1, 2],
			during: [hostSpan(0, 5), hostSpan(5, 10), hostSpan(0, 10), hostSpan(3, 7)],
			crew: [1, 2],
			open: [true, false]
		},
		Roster: {
			place: [1, 2],
			shift: [hostSpan(0, 5), hostSpan(5, 10), hostSpan(0, 10), hostSpan(3, 7)],
			crew: [1, 2],
			open: [true, false]
		},
		Visit: {
			id: [1, 2, 3],
			site: [1, 2],
			during: [hostSpan(3, 7), hostSpan(0, 5), hostSpan(6, 10), hostSpan(2, 4)],
			billable: [true, false]
		}
	},
	host: coverageHost,
	schema: (p) => {
		switch (p.target) {
			case "rota":
				return visits(p)
			case "roster":
				return rosterVisits(p)
		}
	},
	connect: (p, installed) => {
		switch (p.target) {
			case "rota":
				return Effect.flatMap(
					openWriter({ installed, schema: visits(p)(installed.declared) }),
					(o) => runtimeSession(coverageHost(p), o, { Rota, Visit })
				)
			case "roster":
				return Effect.flatMap(
					openWriter({ installed, schema: rosterVisits(p)(installed.declared) }),
					(o) => runtimeSession(coverageHost(p), o, { Roster, Visit })
				)
		}
	}
}

const standings = ["wanted", "leased", "done"] as const
const Standing = closed("Standing", standings)
export const Work = relation(
	"Work",
	{ item: pg.integer, standing: closedId(Standing), epoch: pg.integer },
	["item"]
)
export const Wanted = relation("Wanted", { item: pg.integer, attempts: pg.integer }, ["item"])
export const Leased = relation(
	"Leased",
	{ item: pg.integer, resource: pg.integer, seat: pg.integer },
	["item"]
)
export const Done = relation("Done", { item: pg.integer, outcome: label }, ["item"])
export const Seat = relation("Seat", { resource: pg.integer, seat: pg.integer, label }, [
	"resource",
	"seat"
])

const queueRelations = Object.freeze({ Work, Wanted, Leased, Done, Seat })

export interface QueueParams {
	readonly mutable: Mutability<keyof typeof queueRelations>
}

const workStanding = alternatives(Work, "standing", Standing, {
	wanted: Wanted,
	leased: Leased,
	done: Done
})
const leaseSeatKey = key(on(Leased, "resource", "seat"))
const leaseSeat = contained(on(Leased, "resource", "seat"), on(Seat, "resource", "seat"))

export const queue = (p: QueueParams) => (name: string) =>
	schema(name, { Standing, Work, Wanted, Leased, Done, Seat }, [
		workStanding,
		leaseSeatKey,
		leaseSeat,
		...mutables(p.mutable, queueRelations)
	])

/** Each armed handle's foreign key into the work item standing at it, and its obligation. */
const armLaws = (
	standing: AlternativesLaws,
	arm: string,
	h: (typeof standings)[number]
): HostSchema["laws"] => [
	{
		kind: "contained",
		law: defined(standing.arms[h], `the ${h} arm's law`),
		source: { relation: arm, fields: ["item"], selection: everyFact },
		target: { relation: "Work", fields: ["item"], selection: fieldsEqual({ standing: h }) }
	},
	{
		kind: "obliged",
		law: standing.reverse,
		anchor: { relation: "Work", fields: ["item"], selection: fieldsEqual({ standing: h }) },
		dependent: { relation: arm, fields: ["item"], selection: everyFact }
	}
]

export const queueFamily: Family<QueueParams> = {
	label: "work queue",
	variants: Arr.map(uniformly(queueRelations), (mutable): QueueParams => ({ mutable })),
	describe: (p) =>
		`${describeMutability(p.mutable)}, every standing armed, a lease's seat a candidate key`,
	traits: noTraits,
	/** Two resources of two seats each: two leases meet at a seat as often as they miss it. */
	domains: {
		Work: { item: [1, 2, 3], standing: standings, epoch: [1, 2] },
		Wanted: { item: [1, 2, 3], attempts: [0, 1] },
		Leased: { item: [1, 2, 3], resource: [1, 2], seat: [1, 2] },
		Done: { item: [1, 2, 3], outcome: ["ok", "no"] },
		Seat: { resource: [1, 2], seat: [1, 2], label: ["a", "b"] }
	},
	host: (p) => {
		const laws = lawNamesOf(queue(p)("families"))
		const standing = laws.alternativesOf(workStanding)
		return {
			relations: [
				hostRelation("Work", ["item", "standing", "epoch"], ["item"], p.mutable.Work),
				hostRelation("Wanted", ["item", "attempts"], ["item"], p.mutable.Wanted),
				hostRelation("Leased", ["item", "resource", "seat"], ["item"], p.mutable.Leased),
				hostRelation("Done", ["item", "outcome"], ["item"], p.mutable.Done),
				hostRelation("Seat", ["resource", "seat", "label"], ["resource", "seat"], p.mutable.Seat)
			],
			laws: [
				...Arr.map([Work, Wanted, Leased, Done, Seat], (r): HostLaw => ({
					kind: "key",
					law: laws.primaryKeyLaw(r),
					relation: r.name,
					fields: r === Seat ? ["resource", "seat"] : ["item"],
					selection: everyFact
				})),
				{
					kind: "key",
					law: laws.lawOf(leaseSeatKey),
					relation: "Leased",
					fields: ["resource", "seat"],
					selection: everyFact
				},
				{
					kind: "contained",
					law: laws.lawOf(leaseSeat),
					source: { relation: "Leased", fields: ["resource", "seat"], selection: everyFact },
					target: { relation: "Seat", fields: ["resource", "seat"], selection: everyFact }
				},
				...armLaws(standing, "Wanted", "wanted"),
				...armLaws(standing, "Leased", "leased"),
				...armLaws(standing, "Done", "done")
			]
		}
	},
	schema: queue,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: queue(p)(installed.declared) }), (o) =>
			runtimeSession(queueFamily.host(p), o, queueRelations)
		)
}

export const Employment = relation(
	"Employment",
	{ employee: pg.integer, during: span(pg.integer), basis: label },
	["employee", "during"]
)

export const Timesheet = relation(
	"Timesheet",
	{ employee: pg.integer, week: pg.integer, ceiling: pg.integer },
	["employee", "week"]
)

export const Shift = relation(
	"Shift",
	{ employee: pg.integer, during: span(pg.integer), week: pg.integer, approved: pg.boolean },
	["employee", "during"]
)

const timekeepingRelations = Object.freeze({ Employment, Timesheet, Shift })

export interface TimekeepingParams {
	readonly mutable: Mutability<keyof typeof timekeepingRelations>
	/** The `approved` value of the shifts the three laws judge. */
	readonly selector: boolean
}

/** The shifts the selector picks, which all three laws read. */
const approvedShifts = (p: TimekeepingParams) => select(Shift, (s) => s.eq(s.approved, p.selector))

const shiftTimesheet = (p: TimekeepingParams) =>
	contained(on(approvedShifts(p), "employee", "week"), on(Timesheet, "employee", "week"))

const shiftEmployment = (p: TimekeepingParams) =>
	contained(on(approvedShifts(p), "employee", "during"), on(Employment, "employee", "during"))

const timesheetHours = (p: TimekeepingParams) =>
	capacity(on(Timesheet, "employee", "week"), {
		from: on(approvedShifts(p), "employee", "week"),
		weight: weigh(duration("during")),
		within: within(0n, ref("ceiling"))
	})

export const timekeeping = (p: TimekeepingParams) => (name: string) =>
	schema(name, timekeepingRelations, [
		shiftTimesheet(p),
		shiftEmployment(p),
		timesheetHours(p),
		...mutables(p.mutable, timekeepingRelations)
	])

export const timekeepingFamily: Family<TimekeepingParams> = {
	label: "timekeeping",
	variants: Arr.flatMap(uniformly(timekeepingRelations), (mutable) =>
		Arr.map(booleans, (selector): TimekeepingParams => ({ mutable, selector }))
	),
	describe: (p) =>
		`${describeMutability(p.mutable)}, shifts with approved = ${p.selector} within their timesheet's ceiling and covered by employment`,
	traits: noTraits,
	/** Shift spans of widths 2 and 4 fill a ceiling of 2, 4 or 8 exactly, or past it; employment spans meet at 8. */
	domains: {
		Employment: {
			employee: [1, 2],
			during: [hostSpan(0, 8), hostSpan(8, 16), hostSpan(0, 16), hostSpan(4, 12)],
			basis: ["a", "b"]
		},
		Timesheet: { employee: [1, 2], week: [1, 2], ceiling: [2, 4, 8] },
		Shift: {
			employee: [1, 2],
			during: [hostSpan(0, 2), hostSpan(2, 4), hostSpan(1, 3), hostSpan(6, 10), hostSpan(12, 16)],
			week: [1, 2],
			approved: [true, false]
		}
	},
	host: (p) => {
		const laws = lawNamesOf(timekeeping(p)("families"))
		const approved = fieldsEqual({ approved: p.selector })
		return {
			relations: [
				hostRelation(
					"Employment",
					["employee", "during", "basis"],
					["employee", "during"],
					p.mutable.Employment
				),
				hostRelation(
					"Timesheet",
					["employee", "week", "ceiling"],
					["employee", "week"],
					p.mutable.Timesheet
				),
				hostRelation(
					"Shift",
					["employee", "during", "week", "approved"],
					["employee", "during"],
					p.mutable.Shift
				)
			],
			laws: [
				{
					kind: "spanKey",
					law: laws.primaryKeyLaw(Employment),
					relation: "Employment",
					scalars: ["employee"],
					span: "during"
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(Timesheet),
					relation: "Timesheet",
					fields: ["employee", "week"],
					selection: everyFact
				},
				{
					kind: "spanKey",
					law: laws.primaryKeyLaw(Shift),
					relation: "Shift",
					scalars: ["employee"],
					span: "during"
				},
				{
					kind: "contained",
					law: laws.lawOf(shiftTimesheet(p)),
					source: { relation: "Shift", fields: ["employee", "week"], selection: approved },
					target: { relation: "Timesheet", fields: ["employee", "week"], selection: everyFact }
				},
				{
					kind: "covered",
					law: laws.lawOf(shiftEmployment(p)),
					source: { relation: "Shift", fields: ["employee"], selection: approved },
					target: { relation: "Employment", fields: ["employee"], selection: everyFact },
					span: { source: "during", target: "during" },
					residual: true
				},
				{
					kind: "capacity",
					law: laws.lawOf(timesheetHours(p)),
					target: { relation: "Timesheet", fields: ["employee", "week"], selection: everyFact },
					source: { relation: "Shift", fields: ["employee", "week"], selection: approved },
					weight: { kind: "duration", field: "during" },
					low: 0n,
					high: { ref: "ceiling" }
				}
			]
		}
	},
	schema: timekeeping,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: timekeeping(p)(installed.declared) }), (o) =>
			runtimeSession(timekeepingFamily.host(p), o, timekeepingRelations)
		)
}

export const PayLine = relation("PayLine", { id: pg.integer, gross: pg.integer, net: pg.integer }, [
	"id"
])

export const Deposit = relation(
	"Deposit",
	{ line: pg.integer, account: pg.integer, amount: pg.integer },
	["line", "account"]
)

const depositsRelations = Object.freeze({ PayLine, Deposit })

export interface DepositsParams {
	readonly mutable: Mutability<keyof typeof depositsRelations>
	/** The most deposits a line may have. */
	readonly most: bigint
}

const depositAmount = capacity(on(PayLine, "id"), {
	from: on(Deposit, "line"),
	weight: weigh("amount"),
	within: within(ref("net"), ref("net"))
})

const depositCount = (p: DepositsParams) =>
	capacity(on(PayLine, "id"), { from: on(Deposit, "line"), within: within(0n, p.most) })

const netWithin = capacity(on(PayLine, "id"), {
	from: on(PayLine, "id"),
	weight: weigh("net"),
	within: within(0n, ref("gross"))
})
const depositLine = contained(on(Deposit, "line"), on(PayLine, "id"))

export const deposits = (p: DepositsParams) => (name: string) =>
	schema(name, depositsRelations, [
		depositAmount,
		depositCount(p),
		netWithin,
		depositLine,
		...mutables(p.mutable, depositsRelations)
	])

/** The most deposits per line a schema draws. */
const mostDeposits: Arr.NonEmptyReadonlyArray<bigint> = [2n, 3n]

/** A line's own net within [0, gross], as its row check reads it. */
const netWithinGross = (f: HostFact): boolean =>
	typeof f["net"] === "number" &&
	typeof f["gross"] === "number" &&
	f["net"] >= 0 &&
	f["net"] <= f["gross"]

export const depositsFamily: Family<DepositsParams> = {
	label: "deposits",
	variants: Arr.flatMap(uniformly(depositsRelations), (mutable) =>
		Arr.map(mostDeposits, (most): DepositsParams => ({ mutable, most }))
	),
	describe: (p) =>
		`${describeMutability(p.mutable)}, deposits summing to the line's net, at most ${p.most} per line`,
	traits: noTraits,
	/** Deposits of 1 and 2 sum to a net of 0, 2 or 3 in one or two deposits, and a net of 3 exceeds a gross of 2. */
	domains: {
		PayLine: { id: [1, 2], gross: [2, 3, 4], net: [0, 2, 3] },
		Deposit: { line: [1, 2], account: [1, 2, 3], amount: [1, 2] }
	},
	host: (p) => {
		const laws = lawNamesOf(deposits(p)("families"))
		return {
			relations: [
				hostRelation("PayLine", ["id", "gross", "net"], ["id"], p.mutable.PayLine),
				hostRelation(
					"Deposit",
					["line", "account", "amount"],
					["line", "account"],
					p.mutable.Deposit
				)
			],
			laws: [
				{
					kind: "key",
					law: laws.primaryKeyLaw(PayLine),
					relation: "PayLine",
					fields: ["id"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(Deposit),
					relation: "Deposit",
					fields: ["line", "account"],
					selection: everyFact
				},
				{ kind: "check", law: laws.lawOf(netWithin), relation: "PayLine", holds: netWithinGross },
				{
					kind: "contained",
					law: laws.lawOf(depositLine),
					source: { relation: "Deposit", fields: ["line"], selection: everyFact },
					target: { relation: "PayLine", fields: ["id"], selection: everyFact }
				},
				{
					kind: "capacity",
					law: laws.lawOf(depositAmount),
					target: { relation: "PayLine", fields: ["id"], selection: everyFact },
					source: { relation: "Deposit", fields: ["line"], selection: everyFact },
					weight: { kind: "field", field: "amount" },
					low: { ref: "net" },
					high: { ref: "net" }
				},
				{
					kind: "capacity",
					law: laws.lawOf(depositCount(p)),
					target: { relation: "PayLine", fields: ["id"], selection: everyFact },
					source: { relation: "Deposit", fields: ["line"], selection: everyFact },
					weight: { kind: "count" },
					low: 0n,
					high: p.most
				}
			]
		}
	},
	schema: deposits,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: deposits(p)(installed.declared) }), (o) =>
			runtimeSession(depositsFamily.host(p), o, depositsRelations)
		)
}

const Badge = relation("Badge", { id: pg.integer, code: label }, ["id"])
const Pin = relation("Pin", { id: pg.integer, badge: pg.integer }, ["id"])
const Tag = relation("Tag", { id: pg.integer, code: label }, ["id"])

const badgesRelations = Object.freeze({ Badge, Pin, Tag })

export interface BadgesParams {
	readonly mutable: Mutability<keyof typeof badgesRelations>
}

const badgeCode = key(on(Badge, "code"))
const pinBadge = contained(on(Pin, "badge"), on(Badge, "id"))
const tagBadge = contained(on(Tag, "code"), on(Badge, "code"))
const pinsPerBadge = capacity(on(Badge, "id"), { from: on(Pin, "badge"), within: within(0n, 2n) })
const tagsPerBadge = capacity(on(Badge, "code"), { from: on(Tag, "code"), within: within(0n, 2n) })

const badges = (p: BadgesParams) => (name: string) =>
	schema(name, badgesRelations, [
		badgeCode,
		pinBadge,
		tagBadge,
		pinsPerBadge,
		tagsPerBadge,
		...mutables(p.mutable, badgesRelations)
	])

export const badgesFamily: Family<BadgesParams> = {
	label: "two capacities on one relation by keys of one arity",
	variants: Arr.map(uniformly(badgesRelations), (mutable): BadgesParams => ({ mutable })),
	describe: (p) =>
		`${describeMutability(p.mutable)}, at most two pins per badge id and two tags per badge code`,
	traits: noTraits,
	/** Six pins or tags over three badges: three of one badge's id or code overfill it. */
	domains: {
		Badge: { id: [1, 2, 3], code: ["a", "b", "c"] },
		Pin: { id: [1, 2, 3, 4, 5, 6], badge: [1, 2, 3] },
		Tag: { id: [1, 2, 3, 4, 5, 6], code: ["a", "b", "c"] }
	},
	host: (p) => {
		const laws = lawNamesOf(badges(p)("families"))
		return {
			relations: [
				hostRelation("Badge", ["id", "code"], ["id"], p.mutable.Badge),
				hostRelation("Pin", ["id", "badge"], ["id"], p.mutable.Pin),
				hostRelation("Tag", ["id", "code"], ["id"], p.mutable.Tag)
			],
			laws: [
				{
					kind: "key",
					law: laws.primaryKeyLaw(Badge),
					relation: "Badge",
					fields: ["id"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.lawOf(badgeCode),
					relation: "Badge",
					fields: ["code"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(Pin),
					relation: "Pin",
					fields: ["id"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(Tag),
					relation: "Tag",
					fields: ["id"],
					selection: everyFact
				},
				{
					kind: "contained",
					law: laws.lawOf(pinBadge),
					source: { relation: "Pin", fields: ["badge"], selection: everyFact },
					target: { relation: "Badge", fields: ["id"], selection: everyFact }
				},
				{
					kind: "contained",
					law: laws.lawOf(tagBadge),
					source: { relation: "Tag", fields: ["code"], selection: everyFact },
					target: { relation: "Badge", fields: ["code"], selection: everyFact }
				},
				{
					kind: "capacity",
					law: laws.lawOf(pinsPerBadge),
					target: { relation: "Badge", fields: ["id"], selection: everyFact },
					source: { relation: "Pin", fields: ["badge"], selection: everyFact },
					weight: { kind: "count" },
					low: 0n,
					high: 2n
				},
				{
					kind: "capacity",
					law: laws.lawOf(tagsPerBadge),
					target: { relation: "Badge", fields: ["code"], selection: everyFact },
					source: { relation: "Tag", fields: ["code"], selection: everyFact },
					weight: { kind: "count" },
					low: 0n,
					high: 2n
				}
			]
		}
	},
	schema: badges,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: badges(p)(installed.declared) }), (o) =>
			runtimeSession(badgesFamily.host(p), o, badgesRelations)
		)
}

const TenantRun = relation(
	"TenantRun",
	{ tenant: pg.integer, id: pg.integer, stage: closedId(Stage), note: label },
	["tenant", "id"]
)

const TenantPayment = relation(
	"TenantPayment",
	{ tenant: pg.integer, run: pg.integer, amount: pg.integer },
	["tenant", "run"]
)

const TenantVoiding = relation(
	"TenantVoiding",
	{ tenant: pg.integer, run: pg.integer, reason: label },
	["tenant", "run"]
)

const tenantRunStages = alternatives(TenantRun, "stage", Stage, {
	paid: TenantPayment,
	voided: TenantVoiding
})

const tenantRunsRelations = Object.freeze({ TenantRun, TenantPayment, TenantVoiding })

/** The composite-key alternatives schema's parameters: each of its relations' mutability. */
export interface TenantRunsParams {
	readonly mutable: Mutability<keyof typeof tenantRunsRelations>
}

const tenantRuns = (p: TenantRunsParams) => (name: string) =>
	schema(name, { Stage, ...tenantRunsRelations }, [
		tenantRunStages,
		...mutables(p.mutable, tenantRunsRelations)
	])

/**
 * Each armed handle's tagged foreign key from its arm's (tenant, run) into the run at (tenant, id) standing at it, and
 * its obligation.
 */
const tenantArmLaws = (
	stage: AlternativesLaws,
	arm: string,
	h: "paid" | "voided"
): HostSchema["laws"] => [
	{
		kind: "contained",
		law: defined(stage.arms[h], `the ${h} arm's law`),
		source: { relation: arm, fields: ["tenant", "run"], selection: everyFact },
		target: {
			relation: "TenantRun",
			fields: ["tenant", "id"],
			selection: fieldsEqual({ stage: h })
		}
	},
	{
		kind: "obliged",
		law: stage.reverse,
		anchor: {
			relation: "TenantRun",
			fields: ["tenant", "id"],
			selection: fieldsEqual({ stage: h })
		},
		dependent: { relation: arm, fields: ["tenant", "run"], selection: everyFact }
	}
]

export const compositeAlternatives: Family<TenantRunsParams> = {
	label: "alternatives over a composite key",
	/** Every relation immutable, every one mutable, and each arm's mutability apart from the run's. */
	variants: Arr.appendAll(
		Arr.map(uniformly(tenantRunsRelations), (mutable): TenantRunsParams => ({ mutable })),
		[
			{ mutable: { TenantRun: false, TenantPayment: true, TenantVoiding: false } },
			{ mutable: { TenantRun: true, TenantPayment: false, TenantVoiding: true } }
		]
	),
	describe: (p) =>
		`${describeMutability(p.mutable)}, runs keyed (tenant, id), arms paid and voided`,
	traits: (p) =>
		armMutabilityTraits(p.mutable.TenantRun, [p.mutable.TenantPayment, p.mutable.TenantVoiding]),
	/** Two tenants share both ids, so an arm meets a run of its id under the other tenant as often as its own. */
	domains: {
		TenantRun: { tenant: [1, 2], id: [1, 2], stage: stages, note: ["a", "b"] },
		TenantPayment: { tenant: [1, 2], run: [1, 2], amount: [1, 2] },
		TenantVoiding: { tenant: [1, 2], run: [1, 2], reason: ["x", "y"] }
	},
	host: (p) => {
		const laws = lawNamesOf(tenantRuns(p)("families"))
		const stage = laws.alternativesOf(tenantRunStages)
		return {
			relations: [
				hostRelation(
					"TenantRun",
					["tenant", "id", "stage", "note"],
					["tenant", "id"],
					p.mutable.TenantRun
				),
				hostRelation(
					"TenantPayment",
					["tenant", "run", "amount"],
					["tenant", "run"],
					p.mutable.TenantPayment
				),
				hostRelation(
					"TenantVoiding",
					["tenant", "run", "reason"],
					["tenant", "run"],
					p.mutable.TenantVoiding
				)
			],
			laws: [
				{
					kind: "key",
					law: laws.primaryKeyLaw(TenantRun),
					relation: "TenantRun",
					fields: ["tenant", "id"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(TenantPayment),
					relation: "TenantPayment",
					fields: ["tenant", "run"],
					selection: everyFact
				},
				{
					kind: "key",
					law: laws.primaryKeyLaw(TenantVoiding),
					relation: "TenantVoiding",
					fields: ["tenant", "run"],
					selection: everyFact
				},
				...tenantArmLaws(stage, "TenantPayment", "paid"),
				...tenantArmLaws(stage, "TenantVoiding", "voided")
			]
		}
	},
	schema: tenantRuns,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: tenantRuns(p)(installed.declared) }), (o) =>
			runtimeSession(compositeAlternatives.host(p), o, tenantRunsRelations)
		)
}
