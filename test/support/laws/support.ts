import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { array, type Gen } from "@bjornpagen/testing/gen"
import type { Content } from "@bjornpagen/testing/resources"
import { type Swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Option, Record as Rec, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { type ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { CompileError, CompileReason } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import {
	type AnyDerived,
	type AnyRelation,
	type AnyRoster,
	type AnySchema,
	login,
	role
} from "#compiler/public/schema.ts"
import type { IdentifiedLaw } from "#compiler/types/changeset/changeset.ts"
import { type ChangeSetValue, changeSetOver } from "#compiler/write/changeset/value.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { type ClosedField, closedField, namedText } from "#test/support/closed/stored.ts"
import {
	type Installed,
	installMigrated as install,
	migratedTemplate,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { reportedLawId } from "#test/support/kernel/naming.ts"
import {
	type HostFact,
	type HostRelation,
	type HostSchema,
	type HostState,
	needs,
	type HostOp,
	type OpKind,
	pinned,
	projection,
	relationOf,
	type HostSide,
	type StateRows,
	sameValue,
	selected,
	transition,
	type HostValue
} from "#test/support/laws/model.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pickFrom, pickGen, pickOf, pickSpan } from "#test/support/pick.ts"
import { applicationOf, openServedDb, type ServedOn } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate, type SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/** The host laws a refusal's law states; a law the host does not know fails the case. */

/**
 * The writers of a family schema: `app`, the grizzle writer, in the login `server`, and `direct`, the role its direct SQL
 * writers take on, in the login `psql`, each holding every relation of the schema whole and writing every ordinary
 * one. A second grizzle writer is `app` opened again through a served layer of its own (openWriter), so its session is
 * its own backend. The direct writers log in apart from the grizzle writers, so the backends of a login are the grizzle
 * writers' alone (pg_stat_activity names the login, never the role a session took on), which the histories and the
 * schedules resolve a writer's backend by.
 */
export const familyWriters = (base: AnySchema) => {
	/** Every entry a role may hold: no closed relation, which installs as constants alone. */
	const relations: Readonly<Record<string, AnyRelation | AnyRoster | AnyDerived>> = Rec.fromEntries(
		Arr.flatMap(Rec.toEntries(base.relations), ([name, r]) =>
			r.kind === "closedRelation" ? [] : [[name, r] as const]
		)
	)
	const write = Arr.filter(Rec.keys(relations), (name) => relations[name]?.kind === "relation")
	const app = role(base, "app", relations, { write })
	const direct = role(base, "direct", relations, { write })
	return { app, direct, server: login(base, "server", [app]), psql: login(base, "psql", [direct]) }
}

/**
 * An installed family schema, opened as its grizzle writer `app`: the Db's context, and the programs a step builds at
 * run time served on it as members of `app`'s workload (served-db.ts servedOn).
 */
export interface Opened<S extends AnySchema> {
	readonly installed: Installed
	readonly schema: S
	readonly ctx: ServedDbContext
	readonly served: ServedOn
}

/**
 * Installs the schema `build` makes with its laws and its writers' login under a fresh schema name. The
 * installation holds no connection: a suite installs each drawn schema once and opens its writers per case.
 */
export const installLaws = (
	build: (name: string) => AnySchema,
	ambient: AmbientSession
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> => {
	const value = build("Laws")
	const writers = familyWriters(value)
	return install(value, {
		ambient,
		extensions: [],
		logins: [writers.server, writers.psql],
		label: "real"
	})
}

/**
 * A law-bearing schema's installation as a template (substrate.ts installTemplate): what installLaws makes per test made
 * once per member, `build`'s schema migrated with its writers' logins under the template's name, each case's Installed
 * the schema in its clone. `content` tells it from the other templates its declaring module states (a family's label
 * and the schema's description), and the declaring module's import closure covers the code that builds it.
 */
export const lawsTemplate = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly content: Content
	readonly build: (name: string) => AnySchema
	readonly ambient: AmbientSession
}): SubstrateTemplate<Installed> => {
	const value = spec.build("Laws")
	const writers = familyWriters(value)
	return migratedTemplate({
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: spec.content,
		versions: [
			{ schema: value, logins: [writers.server, writers.psql], declarations: noDeclarations }
		],
		options: {
			label: "real",
			extensions: [],
			ambient: spec.ambient,
			compile: compileInstallation,
			review: noPlaceholders
		}
	})
}

/**
 * Opens `app` on an installation of `opened.schema`, through a served layer of its own over the database it was
 * installed in (served-db.ts openServedDb): each call is a writer with a pool of its own. The login serves no workload of
 * its own; a step's ChangeSet is served on the writer when it runs (servedApply).
 */
export const openWriter = <S extends AnySchema>(opened: {
	readonly installed: Installed
	readonly schema: S
}): Effect.Effect<Opened<S>, OpenError, Scope.Scope> =>
	Effect.map(
		Effect.catchIf(
			openServedDb(opened.installed, familyWriters(opened.schema).server.roles.app, {}),
			(failure) => "place" in failure,
			(refusal) => Effect.die(refusal)
		),
		(db) => ({ installed: opened.installed, schema: opened.schema, ctx: db.ctx, served: db })
	)

/** One installed family schema as the harness drives it. */
export interface LawSession {
	readonly host: HostSchema
	/** The served apply of the ChangeSet of `ops` (servedApply): its outcome, or its refusal as it compiled. */
	readonly apply: (
		ops: ReadonlyArray<HostOp>
	) => Effect.Effect<ApplyOutcome<unknown>, ApplyError | ServedRefusal>
	/** The committed state, read as the owner, in stateRows' form. */
	readonly read: Effect.Effect<StateRows, SqlError>
	/** The LawId of a law an outcome names, its own, which the installation describes as that law (reportedLawId). */
	readonly reported: (refused: IdentifiedLaw) => LawId
}

/**
 * The owner's side of an installed family schema: the committed state in stateRows' form, and the closed id each field
 * holds, whose column stores its handle's code. A case starts from its own clone's empty tables (Substrate.fresh), so
 * the view empties nothing.
 */
interface OwnerView {
	readonly table: (relation: HostRelation) => string
	readonly closed: (relation: string, field: string) => ClosedField | undefined
	/** Every table's rows as their columns' output text, a closed id's code read back as the handle it names. */
	readonly read: Effect.Effect<StateRows, SqlError>
}

const ownerView = (
	host: HostSchema,
	installed: Installed
): Effect.Effect<OwnerView, never, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const q = quoteIdent(installed.schema)
		const table = (r: HostRelation) => `${q}.${quoteIdent(r.table)}`
		const closed = (relation: string, field: string) =>
			closedField(installed.installation, relation, field)
		return {
			table,
			closed,
			read: Effect.forEach(host.relations, (r) => {
				const texts = Arr.map(r.fields, (f) => namedText(installed.installation, r.name, f.name))
				return Effect.map(
					s.admin.queryValues(
						`SELECT ${Arr.join(
							Arr.map(r.fields, (f) => `${quoteIdent(f.column)}::text`),
							", "
						)} FROM ${table(r)}`,
						[]
					),
					(rows) =>
						Arr.map(rows, (row) =>
							Arr.map(texts, (text, i) => text(String(defined(row[i], `${r.name}'s column ${i}`))))
						)
				)
			})
		}
	})

const sessionOf = (
	host: HostSchema,
	installed: Installed,
	apply: LawSession["apply"]
): Effect.Effect<LawSession, never, Substrate> =>
	Effect.map(ownerView(host, installed), (owner) => ({
		host,
		apply,
		read: owner.read,
		reported: (refused: IdentifiedLaw) => reportedLawId(installed.installation.described, refused)
	}))

/**
 * A step's host operations as a served change member: its ChangeSet, one array member per op and relation, in the
 * order the operations first name them, built at run time over `schema` and its relation values by name as a JavaScript
 * caller passes members (packages/engine/src/write/changeset/value.ts); the call's facts, each op's facts under its
 * relation's name, an operation's facts after those of every earlier one of its op and relation, so one stratum writes
 * them together as one member; and its shape, the op and relation of each member in order, which is all a member's
 * compile reads of the step.
 */
interface StepChange {
	readonly changes: ChangeSetValue
	readonly facts: StepFacts
	readonly shape: string
}

/** A call's facts: under each op of a change member's array members, the rows of each, under its relation's name. */
type StepFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/** A step's operation as its member is built: a host operation, its facts as the relation's carriers take them. */
interface StepOp {
	readonly relation: string
	readonly kind: OpKind
	readonly facts: ReadonlyArray<unknown>
}

const stepChangeOf = (
	schema: unknown,
	relations: Readonly<Record<string, unknown>>,
	ops: ReadonlyArray<StepOp>
): StepChange => {
	let changes = changeSetOver.empty(schema)
	const facts: Record<OpKind, Record<string, Array<unknown>>> = { insert: {}, put: {}, delete: {} }
	const members: Array<string> = []
	for (const o of ops) {
		const relation = relations[o.relation]
		if (relation === undefined) {
			throw new Error(`no relation value ${o.relation}`)
		}
		const held = facts[o.kind][o.relation]
		if (held === undefined) {
			changes = changes[o.kind](relation, [])
			members.push(`${o.kind} ${o.relation}`)
			facts[o.kind][o.relation] = [...o.facts]
		} else {
			appendAll(held, o.facts)
		}
	}
	return {
		changes,
		facts: Rec.filter(facts, (byRelation) => !Rec.isEmptyRecord(byRelation)),
		shape: Arr.join(members, ", ")
	}
}

/** A step's served apply: its outcome, or its ChangeSet's refusal as it compiled into a served member. */
type StepApply = (
	ops: ReadonlyArray<StepOp>
) => Effect.Effect<ApplyOutcome<unknown>, ApplyError | ServedRefusal>

/**
 * A step's served write: its ChangeSet compiled into a served member, or its refusal as it compiled, then the call that
 * applies it with the step's facts, which a writer may send again.
 */
export type StepWrite = (
	ops: ReadonlyArray<StepOp>
) => Effect.Effect<Effect.Effect<ApplyOutcome<unknown>, ApplyError>, ServedRefusal>

/**
 * The served write of each step on `opened`: the step's ChangeSet (stepChangeOf) compiled into a member of `app`'s
 * workload and loaded on the writer's Db, as generate compiles a ChangeSet an application builds, then its call with the
 * step's facts. A step compiles once per shape: the members compiled so far are kept by shape for the writer's life, an
 * explicit cache of the test's own, since a member's compile reads only its shape and every call passes its own facts.
 */
export const servedWrite = <S extends AnySchema>(
	opened: Opened<S>,
	relations: Readonly<Record<string, unknown>>
): StepWrite => {
	const compiled = new Map<string, LoadedMember>()
	const memberOf = (step: StepChange): Effect.Effect<LoadedMember, ServedRefusal> => {
		const held = compiled.get(step.shape)
		return held === undefined
			? Effect.map(
					Effect.catchIf(
						opened.served.load({ step: step.changes }),
						(failure) => failure instanceof OpenError,
						(failure) => Effect.die(failure)
					),
					(served) => {
						const member = defined(served.get("step"), "the step's served member")
						compiled.set(step.shape, member)
						return member
					}
				)
			: Effect.succeed(held)
	}
	return (ops) =>
		Effect.suspend(() => {
			const step = stepChangeOf(opened.schema, relations, ops)
			return Effect.map(memberOf(step), (member) =>
				applicationOf(opened.ctx, member)({ params: {}, facts: step.facts })
			)
		})
}

/** The served apply of each step on `opened`: its served write (servedWrite), compiled and called once. */
export const servedApply = <S extends AnySchema>(
	opened: Opened<S>,
	relations: Readonly<Record<string, unknown>>
): StepApply => {
	const write = servedWrite(opened, relations)
	return (ops) => Effect.flatten(write(ops))
}

/** A session whose steps apply their ChangeSets, built at run time, served on the opened writer (servedApply). */
export const runtimeSession = <S extends AnySchema>(
	host: HostSchema,
	opened: Opened<S>,
	relations: Readonly<Record<string, unknown>>
): Effect.Effect<LawSession, never, Substrate> =>
	sessionOf(host, opened.installed, servedApply(opened, relations))

/**
 * Field domains of the generator: each field of each relation draws from a few values, a value listed twice drawn
 * twice as often.
 */
export type Domains = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<HostValue>>>>>

/**
 * The features a case's step swarm turns on, off or weighs: each op kind, and each way a fact is drawn. A member's op is
 * one the swarm turns on, insert when it turns on none or its relation is closed; its first fact is drawn, stored or
 * linked, drawn when the swarm
 * turns on none of them, and each later fact one of those or a sibling. The member sketch states the op kind and the
 * fact modes the swarm chose by name, so resolving a step reads no swarm and a planted member names what it writes.
 */
export const stepFeatures = [
	"insert",
	"delete",
	"put",
	"drawn",
	"stored",
	"linked",
	"sibling"
] as const
export type StepFeature = (typeof stepFeatures)[number]

const opKinds = ["insert", "delete", "put"] as const
const firstModes = ["drawn", "stored", "linked"] as const
const laterModes = ["drawn", "stored", "linked", "sibling"] as const
type FirstMode = (typeof firstModes)[number]
type LaterMode = (typeof laterModes)[number]

/**
 * A step's sketch, resolved against the state before it: for each member a relation, a kind and its facts. A member's
 * first fact is drawn from the domains, a stored fact (with a fresh payload for a put), or a linked fact: drawn, but
 * referring to a fact a law of the relation refers to (a containment's or a coverage's target), stored or added by an earlier member of the step, with the law's selector values and, for a
 * coverage, the target's span. Each later fact is one of those, or a sibling of the member's previous fact: its values
 * at a key redrawn outside the fields its laws refer through, so a member adds several facts to one group, as a batch
 * of children of one parent does. A choice among options the resolver computes (a relation, a stored fact, a link, a
 * domain value) is a pick (pick.ts), which selects without modulo skew and shrinks toward the first option; the fact's
 * mode is named, as its swarm chose it.
 */
interface FactSketch<M extends StepFeature> {
	readonly mode: M
	/** A pick into each field's domain, in heading order. */
	readonly values: ReadonlyArray<number>
	/** Which stored or linked fact. */
	readonly index: number
	/** Which of the relation's links. */
	readonly link: number
}

/** A member writing drawn, stored or linked facts. */
interface WriteSketch {
	readonly arm: "write"
	readonly relation: number
	readonly kind: OpKind
	readonly first: FactSketch<FirstMode>
	readonly rest: ReadonlyArray<FactSketch<LaterMode>>
}

/**
 * A member inserting one fact that needs others, with every fact it needs, transitively, so the step holds a lawful
 * referring group (resolveSupported): which of the laws' needs it starts from, and the picks the facts are drawn from.
 */
interface SupportedSketch {
	readonly arm: "supported"
	readonly need: number
	readonly values: ReadonlyArray<number>
}

/** A member deleting one fact a fact the step starts with needs (resolveUnlink): which of them. */
interface UnlinkSketch {
	readonly arm: "unlink"
	readonly index: number
}

/**
 * A member inserting one fact that meets a fact it needs on some of the paired fields and not all (resolveNear): which
 * of the needs pairing several fields it starts from, which target it points at, which paired field it misses on and
 * which other value that field takes, and the picks its other fields are drawn from.
 */
interface NearSketch {
	readonly arm: "near"
	readonly need: number
	readonly target: number
	readonly miss: number
	readonly other: number
	readonly values: ReadonlyArray<number>
}

/**
 * A member inserting one fact a referring side's selection does not pick, with every fact it needs as another side's
 * (resolveUnselected): which of the needs whose referring side selects it starts from, which of the facts the domains
 * draw outside that selection it inserts, and the picks its supports are drawn from.
 */
interface UnselectedSketch {
	readonly arm: "unselected"
	readonly need: number
	readonly index: number
	readonly values: ReadonlyArray<number>
}
type MemberSketch = WriteSketch | SupportedSketch | UnlinkSketch | NearSketch | UnselectedSketch
export type StepSketch = ReadonlyArray<MemberSketch>
export type CaseSketch = ReadonlyArray<StepSketch>

const sixPicks: Gen<ReadonlyArray<number>> = array(pickGen, { min: 6, max: 6 })

const factSketchGen =
	<M extends StepFeature>(
		steps: Swarm<StepFeature>,
		modes: Arr.NonEmptyReadonlyArray<M>
	): Gen<FactSketch<M>> =>
	(source) => ({
		mode: source.draw(swarmChoice(steps, modes)),
		values: source.draw(sixPicks),
		index: source.draw(pickGen),
		link: source.draw(pickGen)
	})

const writeSketchGen =
	(steps: Swarm<StepFeature>): Gen<MemberSketch> =>
	(source) => ({
		arm: "write",
		relation: source.draw(pickGen),
		kind: source.draw(swarmChoice(steps, opKinds)),
		first: source.draw(factSketchGen(steps, firstModes)),
		rest: source.draw(array(factSketchGen(steps, laterModes), { min: 0, max: 2 }))
	})

const caseSketchOf = (steps: number, member: Gen<MemberSketch>): Gen<CaseSketch> =>
	array(array(member, { min: 1, max: 3 }), { min: 1, max: steps })
/** A short case under a step swarm: a history's initial state, and each of its writers' lists (test/support/history). */
export const caseSketchGen = (steps: Swarm<StepFeature>): Gen<CaseSketch> =>
	caseSketchOf(4, writeSketchGen(steps))
/** The element a pick selects from a list the family built. */
const pickIn = <A>(list: ReadonlyArray<A>, pick: number, what: string): A => {
	const [first, ...rest] = list
	if (first === undefined) {
		throw new Error(`${what} is empty`)
	}
	return pickFrom([first, ...rest], pick)
}

/**
 * A reference a fact of a relation makes through one of the laws: its side, and the side it refers to, a coverage's
 * span fields paired last.
 */
interface Link {
	readonly from: HostSide
	readonly to: HostSide
}

const linksOf = (host: HostSchema, relation: string): ReadonlyArray<Link> =>
	Arr.flatMap(host.laws, (l): ReadonlyArray<Link> => {
		if (l.kind === "contained" && l.source.relation === relation) {
			return [{ from: l.source, to: l.target }]
		}
		if (l.kind === "covered" && l.source.relation === relation) {
			return [
				{
					from: { ...l.source, fields: [...l.source.fields, l.span.source] },
					to: { ...l.target, fields: [...l.target.fields, l.span.target] }
				}
			]
		}
		return []
	})
const admits = (side: HostSide, fact: HostFact): boolean => selected(fact, side.selection)

/**
 * A planted sketch, a precondition the population reaches too rarely, named and resolved as drawn ones are:
 * plantedDeletion, a write member deleting the stored fact at `index` of the `count` the relation holds.
 */
const relationPick = (host: HostSchema, relation: string): number => {
	const index = Option.getOrThrowWith(
		Arr.findFirstIndex(host.relations, (r) => r.name === relation),
		() => new Error(`no relation ${relation}`)
	)
	return pickOf(index, host.relations.length)
}

const headingOf = (host: HostSchema, relation: string): ReadonlyArray<string> =>
	Arr.map(relationOf(host, relation).fields, (f) => f.name)

export const plantedDeletion = (
	host: HostSchema,
	relation: string,
	index: number,
	count: number
): MemberSketch => ({
	arm: "write",
	relation: relationPick(host, relation),
	kind: "delete",
	first: {
		mode: "stored",
		values: [0, 0, 0, 0, 0, 0],
		index: pickOf(index, count),
		link: 0
	},
	rest: []
})

export const resolveStep = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	step: StepSketch
): ReadonlyArray<HostOp> => {
	const ops: Array<HostOp> = []
	for (const o of step) {
		if (o.arm === "supported") {
			appendAll(ops, resolveSupported(host, domains, state, ops, o))
			continue
		}
		if (o.arm === "unlink") {
			appendAll(ops, resolveUnlink(host, state, ops, o))
			continue
		}
		if (o.arm === "near") {
			appendAll(ops, resolveNear(host, domains, state, ops, o))
			continue
		}
		if (o.arm === "unselected") {
			appendAll(ops, resolveUnselected(host, domains, state, ops, o))
			continue
		}
		const relation = pickIn(host.relations, o.relation, "the relations")
		/** A closed relation's facts are inserted, never changed or deleted: a member of one inserts whatever its sketch's op. */
		const kind: OpKind = relation.mutable ? o.kind : "insert"
		const domain = domains[relation.name]
		if (domain === undefined) {
			throw new Error(`no domains for ${relation.name}`)
		}
		const valuesOf = (field: string): ReadonlyArray<HostValue> => {
			const values = domain[field]
			if (values === undefined) {
				throw new Error(`no domain for ${relation.name}.${field}`)
			}
			return values
		}
		const stored = state.get(relation.name) ?? []
		const links = linksOf(host, relation.name)
		const referring = new Set(Arr.flatMap(links, (l) => l.from.fields))
		const outside = Arr.filter(relation.key, (k) => !referring.has(k))
		/** A sibling redraws the key fields outside every reference, or the whole key when each refers. */
		const siblingKey = outside.length === 0 ? relation.key : outside
		const draw = (values: ReadonlyArray<number>): HostFact => {
			const drawn: Record<string, HostValue> = {}
			for (const [i, field] of relation.fields.entries()) {
				drawn[field.name] = pickIn(
					valuesOf(field.name),
					defined(values[i % values.length], `a pick for ${relation.name}.${field.name}`),
					`${relation.name}.${field.name}'s domain`
				)
			}
			return drawn
		}
		const linked = (sketch: FactSketch<LaterMode>): HostFact => {
			const drawn = draw(sketch.values)
			if (links.length === 0) {
				return drawn
			}
			const link = pickIn(links, sketch.link, "the links")
			const targets = Arr.filter(
				[
					...(state.get(link.to.relation) ?? []),
					...Arr.flatMap(ops, (op) =>
						op.relation === link.to.relation && op.kind !== "delete" ? op.facts : []
					)
				],
				(f) => admits(link.to, f)
			)
			if (targets.length === 0) {
				return drawn
			}
			const target = pickIn(targets, sketch.index, "the targets")
			const out: Record<string, HostValue> = { ...drawn, ...pinned(link.from.selection) }
			for (const [i, field] of link.from.fields.entries()) {
				const to = link.to.fields[i]
				const x = to === undefined ? undefined : target[to]
				if (x === undefined) {
					throw new Error(`${link.to.relation} fact without its field ${String(to)}`)
				}
				out[field] = x
			}
			return out
		}
		/** A put of a stored fact keeps its key and draws its payload; insert and delete take the stored fact. */
		const fact = (sketch: FactSketch<LaterMode>, mode: FirstMode): HostFact => {
			if (mode === "linked") {
				return linked(sketch)
			}
			const drawn = draw(sketch.values)
			if (mode === "drawn" || stored.length === 0) {
				return drawn
			}
			const base = pickIn(stored, sketch.index, "the stored facts")
			if (kind !== "put") {
				return base
			}
			const out: Record<string, HostValue> = { ...drawn }
			for (const k of relation.key) {
				const x = base[k]
				if (x !== undefined) {
					out[k] = x
				}
			}
			return out
		}
		let previous = fact(o.first, o.first.mode)
		const facts: Array<HostFact> = [previous]
		for (const sketch of o.rest) {
			const mode = sketch.mode
			if (mode === "sibling") {
				/** A fact differing from the previous one on the sibling key alone. */
				const sibling: Record<string, HostValue> = { ...previous }
				for (const [i, k] of siblingKey.entries()) {
					sibling[k] = pickIn(valuesOf(k), sketch.values[i] ?? 0, `${relation.name}.${k}'s domain`)
				}
				previous = sibling
			} else {
				previous = fact(sketch, mode)
			}
			facts.push(previous)
		}
		ops.push({ relation: relation.name, kind, facts })
	}
	return ops
}

/** A fact of `relation` drawn from its fields' domains by `values`, a pick per field in heading order. */
const drawnFact = (
	host: HostSchema,
	domains: Domains,
	relation: string,
	values: ReadonlyArray<number>
): Record<string, HostValue> => {
	const out: Record<string, HostValue> = {}
	for (const [i, field] of relationOf(host, relation).fields.entries()) {
		const domain = domains[relation]?.[field.name]
		if (domain === undefined) {
			throw new Error(`no domain for ${relation}.${field.name}`)
		}
		out[field.name] = pickIn(
			domain,
			defined(values[i % values.length], `a pick for ${relation}.${field.name}`),
			`${relation}.${field.name}'s domain`
		)
	}
	return out
}

/**
 * `fact` pointed at `at` through `side`: its selector's values, and its side's fields at `at`'s values in pair order.
 */
const pointedAt = (side: HostSide, fact: HostFact, at: ReadonlyArray<HostValue>): HostFact => {
	const out: Record<string, HostValue> = { ...fact, ...pinned(side.selection) }
	for (const [i, field] of side.fields.entries()) {
		const x = at[i]
		if (x === undefined) {
			throw new Error(`no value for ${side.relation}.${field}`)
		}
		out[field] = x
	}
	return out
}

/** A fact of a relation, as a member writes it. */
interface WrittenFact {
	readonly relation: string
	readonly fact: HostFact
}

/**
 * `written` with every fact a containment or a coverage requires of the facts it writes, transitively, that
 * neither `before` nor `written` holds: each drawn by `values` (a fact's place among the written as its pick) and
 * pointed at the fact that requires it.
 */
const withSupports = (
	host: HostSchema,
	domains: Domains,
	before: HostState,
	first: ReadonlyArray<WrittenFact>,
	values: (k: number) => ReadonlyArray<number>
): ReadonlyArray<WrittenFact> => {
	const required = Arr.flatMap(host.laws, needs)
	const stored = Arr.flatMap([...before], ([relation, facts]) =>
		Arr.map(facts, (fact) => ({ relation, fact }))
	)
	const written: Array<WrittenFact> = [...first]
	for (const { relation, fact } of written) {
		if (written.length > supportBound) {
			throw new Error(`a group of more than ${supportBound} facts: the family's needs cycle`)
		}
		for (const { from, to } of required) {
			if (from.relation !== relation || !selected(fact, from.selection)) {
				continue
			}
			const at = Arr.map(from.fields, (f) => {
				const x = fact[f]
				if (x === undefined) {
					throw new Error(`${relation} fact without its field ${f}`)
				}
				return x
			})
			const meets = (f: HostFact) =>
				selected(f, to.selection) && Arr.every(to.fields, (field, j) => sameValue(f[field], at[j]))
			/** One stored or written already meets the need. */
			const met =
				Arr.some(stored, (x) => x.relation === to.relation && meets(x.fact)) ||
				Arr.some(written, (x) => x.relation === to.relation && meets(x.fact))
			if (met) {
				continue
			}
			written.push({
				relation: to.relation,
				fact: pointedAt(to, drawnFact(host, domains, to.relation, values(written.length)), at)
			})
		}
	}
	return written
}

/** Written facts as one insertion per relation, in the order the relations first appear. */
const insertsOf = (written: ReadonlyArray<WrittenFact>): ReadonlyArray<HostOp> =>
	Arr.map([...new Set(Arr.map(written, (w) => w.relation))], (relation) => ({
		relation,
		kind: "insert",
		facts: Arr.flatMap(written, (w) => (w.relation === relation ? [w.fact] : []))
	}))

/**
 * A supported member, resolved against the state the step's earlier members `ops` leave: a fact of the referring side
 * of the need it picks, at that side's selector values, drawn by its picks, with its supports (withSupports). A schema
 * whose laws need nothing has no referring fact, and its member writes nothing.
 */
const resolveSupported = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	sketch: SupportedSketch
): ReadonlyArray<HostOp> => {
	const [first, ...rest] = Arr.flatMap(host.laws, needs)
	if (first === undefined) {
		return []
	}
	const need = pickFrom([first, ...rest], sketch.need)
	const values = (k: number) =>
		Arr.map(sketch.values, (p, i) => (p + k * (i + 1) * redrawStride) % pickSpan)
	const fact = {
		...drawnFact(host, domains, need.from.relation, values(0)),
		...pinned(need.from.selection)
	}
	return insertsOf(
		withSupports(
			host,
			domains,
			transition(host, state, ops),
			[{ relation: need.from.relation, fact }],
			values
		)
	)
}

/**
 * An unselected member, resolved against the state the step's earlier members `ops` leave: a fact of the referring side
 * of the need it picks, among the needs whose referring side selects, that the side's selection does not pick, at a key
 * no fact of its relation holds there, with its supports (withSupports). A schema none of whose needs selects its
 * referring side, or whose domains draw no such fact, has none, and its member writes nothing.
 */
const resolveUnselected = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	sketch: UnselectedSketch
): ReadonlyArray<HostOp> => {
	const [first, ...rest] = Arr.filter(
		Arr.flatMap(host.laws, needs),
		({ from }) => from.selection.kind !== "every"
	)
	if (first === undefined) {
		return []
	}
	const { from } = pickFrom([first, ...rest], sketch.need)
	const before = transition(host, state, ops)
	const key = relationOf(host, from.relation).key
	const held = new Set(
		Arr.map(defined(before.get(from.relation), `the state's ${from.relation} facts`), (f) =>
			projection(f, key)
		)
	)
	const [fact, ...others] = Arr.filter(
		Arr.fromIterable(domainFacts(host, domains, from.relation)),
		(f) => !selected(f, from.selection) && !held.has(projection(f, key))
	)
	if (fact === undefined) {
		return []
	}
	const values = (k: number) =>
		Arr.map(sketch.values, (p, i) => (p + k * (i + 1) * redrawStride) % pickSpan)
	return insertsOf(
		withSupports(
			host,
			domains,
			before,
			[{ relation: from.relation, fact: pickFrom([fact, ...others], sketch.index) }],
			values
		)
	)
}

/**
 * An unlink member, resolved against the state the step's earlier members `ops` leave: the deletion of one fact of an
 * open relation that a fact there needs, or nothing when no such fact is needed, a closed relation's facts never being
 * deleted.
 */
const resolveUnlink = (
	host: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	sketch: UnlinkSketch
): ReadonlyArray<HostOp> => {
	const before = transition(host, state, ops)
	const facts = (relation: string) => defined(before.get(relation), `the state's ${relation} facts`)
	const references = Arr.filter(
		Arr.flatMap(host.laws, needs),
		({ to }) => relationOf(host, to.relation).mutable
	)
	const needed = Arr.flatMap(references, ({ from, to }) =>
		Arr.map(
			Arr.filter(
				facts(to.relation),
				(t) =>
					selected(t, to.selection) &&
					Arr.some(
						facts(from.relation),
						(f) =>
							selected(f, from.selection) &&
							Arr.every(from.fields, (field, j) =>
								sameValue(f[field], t[defined(to.fields[j], `the field ${field} pairs with`)])
							)
					)
			),
			(fact) => ({ relation: to.relation, fact })
		)
	)
	const [first, ...rest] = needed
	if (first === undefined) {
		return []
	}
	const chosen = pickFrom([first, ...rest], sketch.index)
	return [{ relation: chosen.relation, kind: "delete", facts: [chosen.fact] }]
}

/**
 * A near member, resolved against the state the step's earlier members `ops` leave: the need it picks among those
 * pairing several fields, a target fact on that need's side (one there selected, else a drawn one inserted with its
 * supports), and a fact of the referring side at its selector values, drawn by its picks and pointed at the target on
 * every paired field but the one it misses on, which holds a value of its domain the target's field does not. A schema
 * with no need pairing several fields, or a missed field whose domain holds no other value, writes nothing.
 */
const resolveNear = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	sketch: NearSketch
): ReadonlyArray<HostOp> => {
	const [first, ...rest] = Arr.filter(
		Arr.flatMap(host.laws, needs),
		({ from }) => from.fields.length > 1
	)
	if (first === undefined) {
		return []
	}
	const { from, to } = pickFrom([first, ...rest], sketch.need)
	const before = transition(host, state, ops)
	const values = (k: number) =>
		Arr.map(sketch.values, (p, i) => (p + k * (i + 1) * redrawStride) % pickSpan)
	const [stored, ...more] = Arr.filter(
		defined(before.get(to.relation), `the state's ${to.relation} facts`),
		(t) => selected(t, to.selection)
	)
	/** The target, and what the member writes for it: nothing for a stored one, a drawn one with its supports. */
	const aimed = (): { readonly target: HostFact; readonly writes: ReadonlyArray<WrittenFact> } => {
		if (stored !== undefined) {
			return { target: pickFrom([stored, ...more], sketch.target), writes: [] }
		}
		const target = { ...drawnFact(host, domains, to.relation, values(1)), ...pinned(to.selection) }
		return {
			target,
			writes: withSupports(host, domains, before, [{ relation: to.relation, fact: target }], (k) =>
				values(k + 1)
			)
		}
	}
	const { target, writes } = aimed()
	const at = Arr.map(to.fields, (field) => defined(target[field], `${to.relation}.${field}`))
	const missed = pickIn(from.fields, sketch.miss, `${from.relation}'s paired fields`)
	const [other, ...others] = Arr.filter(
		defined(domains[from.relation]?.[missed], `the domain of ${from.relation}.${missed}`),
		(x) => !sameValue(x, at[from.fields.indexOf(missed)])
	)
	if (other === undefined) {
		return []
	}
	const near: HostFact = {
		...pointedAt(from, drawnFact(host, domains, from.relation, values(0)), at),
		[missed]: pickFrom([other, ...others], sketch.other)
	}
	return insertsOf([...writes, { relation: from.relation, fact: near }])
}

/**
 * The stride a supported or near member redraws its picks by: each pick strided by its place, so a redrawn fact's keys
 * and payloads move apart through their domains.
 */
const redrawStride = 40_503
/** The most facts a member's supports close over: a closure past it is a defect of a family's laws. */
const supportBound = 32

/** Every fact of `relation` its domains draw, the last field's values varying fastest. */
const domainFacts = function* (
	host: HostSchema,
	domains: Domains,
	relation: string
): Generator<Readonly<Record<string, HostValue>>> {
	const fields = headingOf(host, relation)
	const values = Arr.map(fields, (f) =>
		defined(domains[relation]?.[f], `the domain of ${relation}.${f}`)
	)
	const count = Arr.reduce(values, 1, (n, v) => n * v.length)
	for (let n = 0; n < count; n++) {
		const fact: Record<string, HostValue> = {}
		let rest = n
		for (let i = fields.length - 1; i >= 0; i--) {
			const domain = defined(values[i], "a field's domain")
			fact[defined(fields[i], "a field")] = defined(domain[rest % domain.length], "a domain value")
			rest = Math.floor(rest / domain.length)
		}
		yield fact
	}
}

/** A write of a stratum as an UnorderableStratum's cycle names it. */
type CycleWrite = Extract<CompileReason, { readonly _tag: "UnorderableStratum" }>["cycle"][number]

/**
 * The cycle of a stratum's writes an apply's failure names, where the ChangeSet was refused as it compiled because no
 * order of its stratum's writes keeps every immediate key (UnorderableStratum); none for any other failure.
 */
export const unorderableCycle = (
	failure: ApplyError | ServedRefusal
): Arr.NonEmptyReadonlyArray<CycleWrite> | undefined => {
	if ("_tag" in failure || failure.error._tag !== "CompileError") {
		return undefined
	}
	const reason = failure.error.reason
	return reason._tag === "UnorderableStratum" ? reason.cycle : undefined
}
