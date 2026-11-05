import { Array as Arr, Effect, Record as Rec, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { closedId, pg, span } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	type AnySchema,
	alternatives,
	closed,
	contained,
	key,
	type Mutable,
	mutable,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import {
	everyFact,
	fieldsEqual,
	fieldsIn,
	type HostLaw,
	type HostRelation,
	type HostSchema,
	type HostSelection,
	hostSpan
} from "#test/support/laws/model.ts"

import type { Installed } from "#test/support/install-migrate.ts"
import {
	type AlternativesLaws,
	type LawNames,
	lawNamesOf,
	parsedName
} from "#test/support/kernel/naming.ts"
import {
	type Domains,
	installLaws,
	openWriter,
	runtimeSession,
	type Session
} from "#test/support/laws/support.ts"
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
 *   two to five handles: every handle armed, one unarmed, a payload relation two handles share, one armed of five. It
 *   states two containments per arm (fin.md §7): the arm relation's key in the runs its handles select, a foreign key
 *   into the parent's law column, and the runs each armed handle selects in its arm, a foreign key from the parent's
 *   law column, deferred on the cycle; each roster with every relation immutable and with every one mutable, and two
 *   with a mutable arm beside an immutable parent and an immutable arm beside a mutable one;
 * - span coverage: Rota(site, during) keyed by a span key, and `contained(on([select(]Visit[, (v) => v.eq(v.billable,
 *   b))], "site", "during"), on([select(]Rota[, (r) => r.eq(r.open, o))], "site", "during"))`, at most one side
 *   selected: a PERIOD foreign key for every visit into every rota fact, from a selected visit's range law column, or
 *   into the range law column of the rota facts a selector picks, each met by fragments of adjacent rota spans, and
 *   Visit's candidate span key `key(on(Visit, "site", "during"))` beside its id; and the same coverage into
 *   Roster(shift, crew, place) keyed by (place, shift), `on(Roster, "place", "shift")`, whose fields are named apart
 *   from the source's and declared in another heading order, so the law pairs the sides' fields by their positions in
 *   the two lists alone;
 * - a work queue: `alternatives(Work, "standing", Standing, { wanted: Wanted, leased: Leased, done: Done })`, every
 *   handle armed, a candidate key on a lease's (resource, seat), and the lease's foreign key into Seat;
 * - timekeeping, the payroll example's time side: Employment and Shift keyed by span keys, and over the shifts a
 *   selector picks, a containment into Timesheet(employee, week), a native foreign key from the selected side's law
 *   columns, and a coverage by Employment, a PERIOD foreign key from them;
 * - composite alternatives: the alternatives family's two containments per arm over a (tenant, id) key.
 *
 * Every law is native (fin.md §7, "The residual families after Fin"). The capacity families (scalar-group capacity,
 * the shared tables' capacity, the deposits and the badges) went with `capacity`: their counts and sums are counted
 * families with folds (test/support/families, test/pg/fin).
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
	 * of law from a selected side (suites/family.ts fromSelected) of a schema that holds it. A family of a few fixed
	 * schemas has none.
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
 * Installs the schema of `p` with its laws and its writers under a fresh schema name; the installation holds no
 * connection.
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

export const alternativesBox: Family<RunsParams> = {
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
						kind: "contained",
						law: defined(stage.reverse[stageName(h)], `the ${stageName(h)} handle's reverse law`),
						source: {
							relation: "Run",
							fields: ["id"],
							selection: fieldsEqual({ stage: stageName(h) })
						},
						target: { relation: pay.value.name, fields: ["run"], selection: everyFact }
					}))
				])
			]
		}
	},
	schema: runs,
	connect: (p, installed) =>
		Effect.flatMap(openWriter({ installed, schema: runs(p)(installed.declared) }), (o) =>
			runtimeSession(alternativesBox.host(p), o, runsRelations(p))
		)
}

/** A side's selector as drawn: none, or the value its boolean field must hold. */
type Selector = { readonly kind: "every" } | { readonly kind: "selected"; readonly value: boolean }
const every: Selector = { kind: "every" }
const selectors: Arr.NonEmptyReadonlyArray<Selector> = Arr.map(booleans, (value) => ({
	kind: "selected",
	value
}))

/** A selector's facts: every one, or those whose `field` holds its value. */
const selectionOf = (field: string, s: Selector): HostSelection =>
	s.kind === "every" ? everyFact : fieldsEqual({ [field]: s.value })

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
export const ShiftRoster = relation(
	"Roster",
	{ shift: span(pg.integer), crew: pg.integer, place: pg.integer, open: pg.boolean },
	["place", "shift"]
)

export interface VisitsParams {
	/** The mutability of the coverage's sides: Visit, its source, and the rota or the roster, its target. */
	readonly mutable: Mutability<"source" | "target">
	/**
	 * Every visit covered, or the visits whose `billable` holds the value: a PERIOD foreign key either way, from the
	 * selected side's range law column when it is selected (fin.md §7).
	 */
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
const openRoster = (open: boolean) => select(ShiftRoster, (r) => r.eq(r.open, open))

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
			? on(ShiftRoster, "place", "shift")
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
	schema(name, { Roster: ShiftRoster, Visit }, [
		visitSpanKey,
		rosterCoverage(p),
		...mutables(p.mutable, { source: Visit, target: ShiftRoster })
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
						span: { source: "during", target: "during" }
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
						law: laws.primaryKeyLaw(ShiftRoster),
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
						span: { source: "during", target: "shift" }
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
					(o) => runtimeSession(coverageHost(p), o, { Roster: ShiftRoster, Visit })
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

/**
 * Each armed handle's arm in the work item standing at it, and the work items standing at it in their arm: both
 * containments alternatives states (fin.md §7).
 */
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
		kind: "contained",
		law: defined(standing.reverse[h], `the ${h} handle's reverse law`),
		source: { relation: "Work", fields: ["item"], selection: fieldsEqual({ standing: h }) },
		target: { relation: arm, fields: ["item"], selection: everyFact }
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
	{ employee: pg.integer, week: pg.integer, note: label },
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
	/** The `approved` value of the shifts the two laws judge. */
	readonly selector: boolean
}

/** The shifts the selector picks, which both laws read. */
const approvedShifts = (p: TimekeepingParams) => select(Shift, (s) => s.eq(s.approved, p.selector))

const shiftTimesheet = (p: TimekeepingParams) =>
	contained(on(approvedShifts(p), "employee", "week"), on(Timesheet, "employee", "week"))

const shiftEmployment = (p: TimekeepingParams) =>
	contained(on(approvedShifts(p), "employee", "during"), on(Employment, "employee", "during"))

export const timekeeping = (p: TimekeepingParams) => (name: string) =>
	schema(name, timekeepingRelations, [
		shiftTimesheet(p),
		shiftEmployment(p),
		...mutables(p.mutable, timekeepingRelations)
	])

export const timekeepingFamily: Family<TimekeepingParams> = {
	label: "timekeeping",
	variants: Arr.flatMap(uniformly(timekeepingRelations), (mutable) =>
		Arr.map(booleans, (selector): TimekeepingParams => ({ mutable, selector }))
	),
	describe: (p) =>
		`${describeMutability(p.mutable)}, shifts with approved = ${p.selector} in their timesheet and covered by employment`,
	traits: noTraits,
	/** Employment spans meet at 8, so a shift across 8 is covered only by two of them. */
	domains: {
		Employment: {
			employee: [1, 2],
			during: [hostSpan(0, 8), hostSpan(8, 16), hostSpan(0, 16), hostSpan(4, 12)],
			basis: ["a", "b"]
		},
		Timesheet: { employee: [1, 2], week: [1, 2], note: ["a", "b"] },
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
					["employee", "week", "note"],
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
					span: { source: "during", target: "during" }
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
 * Each armed handle's foreign key from its arm's (tenant, run) into the run at (tenant, id) standing at it, and the
 * runs standing at it in their arm: both containments alternatives states (fin.md §7).
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
		kind: "contained",
		law: defined(stage.reverse[h], `the ${h} handle's reverse law`),
		source: {
			relation: "TenantRun",
			fields: ["tenant", "id"],
			selection: fieldsEqual({ stage: h })
		},
		target: { relation: arm, fields: ["tenant", "run"], selection: everyFact }
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
