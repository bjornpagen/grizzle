import type { Case } from "@bjornpagen/testing/explore"
import { array, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { agree } from "@bjornpagen/testing/oracle"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { type ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import { appendAll, indices } from "#compiler/core/array.ts"
import type { CompileError, CompileReason } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type AnyDerived,
	type AnyRelation,
	type AnyRoster,
	type AnySchema,
	login,
	role
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { IdentifiedLaw } from "#compiler/types/changeset/changeset.ts"
import { type ChangeSetValue, changeSetOver } from "#compiler/write/changeset/value.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { type ClosedField, closedField, namedText } from "#test/support/closed/stored.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { reportedLawId } from "#test/support/kernel/naming.ts"
import {
	type Expected,
	emptyState,
	expect,
	type HostFact,
	type HostLaw,
	type HostRelation,
	type HostSchema,
	type HostState,
	isCandidateSpanKey,
	isRenamedCoverage,
	type HostContainment,
	isSelectedContainment,
	isSelectedTargetCoverage,
	needs,
	type HostOp,
	type OpKind,
	overlapsUnequally,
	pinned,
	type Precedes,
	projection,
	relationOf,
	rowsDifference,
	type HostSide,
	type StateRows,
	sameValue,
	sameValues,
	selected,
	stateRows,
	transition,
	type HostValue,
	violations
} from "#test/support/laws/model.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pickFrom, pickGen, pickOf, pickSpan } from "#test/support/pick.ts"
import { applicationOf, openServedDb, type ServedOn } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * What a family case notes: each step's op kinds and its outcome, what a refusal notes (refusalFeatures), the schema it
 * ran on and each of its traits (boxes.ts), and a member that states one fact twice or two facts at one key, which the
 * add-wins model takes as one fact, and, in an insert or a put, as the key's refusal; in a delete, two facts at one key
 * are no refusal, since a deletion names its fact exactly (model.ts relationAfter and expect).
 */
export type FamilyFeature =
	| "accepted"
	| "accepted beside a source fact no selected containment selects"
	| "no-change"
	| RefusalFeature
	| `op ${OpKind}`
	| `schema ${string}`
	| `trait ${string}`
	| "a fact stated twice in one member"
	| "two facts at one key in one member"
	| "a stratum no order keeps refused"

/** What one member's facts state more than once: a whole fact, or a primary key with another fact at it. */
const memberRepeats = (host: HostSchema, op: HostOp): ReadonlyArray<FamilyFeature> => {
	const relation = relationOf(host, op.relation)
	const heading = Arr.map(relation.fields, (x) => x.name)
	const distinct = new Map(Arr.map(op.facts, (f) => [projection(f, heading), f] as const))
	const keys = new Set(Arr.map([...distinct.values()], (f) => projection(f, relation.key)))
	return [
		...(distinct.size < op.facts.length ? (["a fact stated twice in one member"] as const) : []),
		...(relation.key.length > 0 && keys.size < distinct.size
			? (["two facts at one key in one member"] as const)
			: [])
	]
}

/**
 * What a refusal notes: the kind of law that refused it and the law itself, whether the fact a witness names was
 * stored as it is before the step (its counterpart went, or moved away) or is new (it came without one), whether a fact
 * of the side its law needs meets it in part, and each shape of law it shows (lawShapes).
 */
export type RefusalFeature =
	| `refused by a ${HostLaw["kind"]}`
	| `refused by a ${HostLaw["kind"]} of ${Witnessing}`
	| `refused by a ${HostLaw["kind"]} beside a partial match`
	| ShapeFeature
	| `law ${string}`

/** The feature of a shape of law a refusal shows (lawShapes). */
export type ShapeFeature = (typeof lawShapes)[number]["feature"]

/** Whether a witness names a fact stored as it was before the change, or one the change added. */
export type Witnessing = "a stored fact" | "a new fact"

/** A key a witness names a fact by: its relation and the values of the key's fields. */
interface WitnessKey {
	readonly relation: string
	readonly values: Readonly<Record<string, unknown>>
}

/**
 * What a witness's key names, judged on the state before a change and after it: a stored fact when every fact it names
 * is in both, as it is; a new fact otherwise.
 */
const witnessing = (
	host: HostSchema,
	before: HostState,
	after: HostState,
	key: WitnessKey
): Witnessing => {
	const named = (state: HostState) =>
		Arr.filter(state.get(key.relation) ?? [], (f) =>
			sameValues(Rec.fromEntries(Arr.map(Rec.keys(key.values), (k) => [k, f[k]])), key.values)
		)
	const full = (f: HostFact) =>
		projection(
			f,
			Arr.map(relationOf(host, key.relation).fields, (x) => x.name)
		)
	const was = Arr.map(named(before), full)
	const is = Arr.map(named(after), full)
	return is.length > 0 && Arr.every(is, (f) => was.includes(f)) ? "a stored fact" : "a new fact"
}

/**
 * Whether a fact a witness names meets a fact of the side it needs on some of the paired fields and not all: a refusal a
 * law that compared fewer fields, or paired them out of order, would have let pass. Only a law that pairs several
 * fields can be met in part.
 */
const partlyMet = (state: HostState, law: HostLaw, key: WitnessKey): boolean =>
	Arr.some(
		needs(law),
		({ from, to }) =>
			from.fields.length > 1 &&
			Arr.some(
				Arr.filter(
					defined(state.get(from.relation), `the state's ${from.relation} facts`),
					(f) =>
						key.relation === from.relation &&
						sameValues(Rec.fromEntries(Arr.map(Rec.keys(key.values), (x) => [x, f[x]])), key.values)
				),
				(f) =>
					Arr.some(defined(state.get(to.relation), `the state's ${to.relation} facts`), (t) => {
						if (!selected(t, to.selection)) {
							return false
						}
						const equal = Arr.map(from.fields, (field, i) =>
							sameValue(f[field], t[defined(to.fields[i], `the field ${field} pairs with`)])
						)
						return Arr.some(equal, (x) => x) && Arr.some(equal, (x) => !x)
					})
			)
	)

/**
 * A refusal, as a case met it or as the host model predicts it: the host laws its law states (one law may be stated
 * as several, a restated containment), the states before the step and after it, and the key its witness names, a key's
 * alone: every other law is a native constraint whose violation names no fact.
 */
export interface HostRefusal {
	readonly laws: Arr.NonEmptyReadonlyArray<HostLaw>
	readonly before: HostState
	readonly after: HostState
	readonly witness: WitnessKey | undefined
}

/**
 * A shape of law a refusal may show beside its kind: the feature it notes, whether a law of a schema has the shape,
 * and whether a refusal by such a law shows it, by the states before and after the refused step.
 */
export interface LawShape {
	readonly feature: string
	readonly declares: (law: HostLaw, host: HostSchema) => boolean
	readonly shows: (r: HostRefusal, law: HostLaw, host: HostSchema) => boolean
}

const always = (): boolean => true

/** Whether a step wrote a relation: its facts after differ from its facts before. */
const wrote = (r: HostRefusal, relation: string): boolean => {
	const before = r.before.get(relation) ?? []
	const after = r.after.get(relation) ?? []
	return (
		before.length !== after.length ||
		Arr.some(before, (f) => !Arr.some(after, (g) => sameValues(f, g)))
	)
}

/** The side of a containment from a selected source, its source or its target, a refused step wrote alone. */
const wroteAlone =
	(side: "source" | "target") =>
	(r: HostRefusal, law: HostLaw): boolean =>
		isSelectedContainment(law) &&
		(side === "source"
			? wrote(r, law.source.relation) && !wrote(r, law.target.relation)
			: wrote(r, law.target.relation) && !wrote(r, law.source.relation))

/**
 * Whether a source fact the containment selects after the step stood under the same key outside its selection: its law
 * column went from NULL to its value.
 */
const switchedIn = (r: HostRefusal, law: HostLaw, host: HostSchema): boolean => {
	if (!isSelectedContainment(law)) {
		return false
	}
	const key = relationOf(host, law.source.relation).key
	return Arr.some(
		r.after.get(law.source.relation) ?? [],
		(a) =>
			selected(a, law.source.selection) &&
			Arr.some(
				r.before.get(law.source.relation) ?? [],
				(b) => projection(a, key) === projection(b, key) && !selected(b, law.source.selection)
			)
	)
}

/** Whether a target fact kept its key and moved: its fields the containment pairs changed. */
const targetMoved = (r: HostRefusal, law: HostLaw, host: HostSchema): boolean => {
	if (!isSelectedContainment(law)) {
		return false
	}
	const key = relationOf(host, law.target.relation).key
	return Arr.some(r.after.get(law.target.relation) ?? [], (a) =>
		Arr.some(
			r.before.get(law.target.relation) ?? [],
			(b) =>
				projection(a, key) === projection(b, key) &&
				projection(a, law.target.fields) !== projection(b, law.target.fields)
		)
	)
}

/** Whether a containment's target fields are other than its relation's key, so a target can move. */
const movable = (law: HostLaw, host: HostSchema): boolean =>
	isSelectedContainment(law) &&
	!sameFieldSet(relationOf(host, law.target.relation).key, law.target.fields)

const sameFieldSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (f) => b.includes(f))

/**
 * Every shape of law a refusal may show, each where grizzle's laws have broken: a coverage across renamed fields; a
 * coverage into a selected target; a candidate span key over two facts whose unequal spans overlap; and a containment
 * from a selected source, the reverse direction of alternatives among them, refused after a write of one side alone,
 * after a source fact switched into its selection, and after its target moved.
 */
export const lawShapes = [
	{
		feature: "covered across renamed fields",
		declares: isRenamedCoverage,
		shows: always
	},
	{
		feature: "covered into a selected target",
		declares: isSelectedTargetCoverage,
		shows: always
	},
	{
		feature: "refused by a candidate span key over unequal spans",
		declares: (law: HostLaw, host: HostSchema) => isCandidateSpanKey(host, law),
		shows: (r: HostRefusal, law: HostLaw) => overlapsUnequally(r.after, law)
	},
	{
		feature: "refused by a selected containment after a write of its sources alone",
		declares: isSelectedContainment,
		shows: wroteAlone("source")
	},
	{
		feature: "refused by a selected containment after a write of its targets alone",
		declares: isSelectedContainment,
		shows: wroteAlone("target")
	},
	{
		feature: "refused by a selected containment after a source switched into its selection",
		declares: isSelectedContainment,
		shows: switchedIn
	},
	{
		feature: "refused by a selected containment after its target moved",
		declares: movable,
		shows: targetMoved
	}
] as const satisfies ReadonlyArray<LawShape>

/** What a refusal notes: the one rule its case notes by and a planted case is found by (plantedRefusal). */
export const refusalFeatures = (
	host: HostSchema,
	r: HostRefusal
): ReadonlyArray<RefusalFeature> => {
	const [law] = r.laws
	const kind: RefusalFeature = `refused by a ${law.kind}`
	const shown = Arr.map(
		Arr.filter(lawShapes, (shape) =>
			Arr.some(r.laws, (l) => shape.declares(l, host) && shape.shows(r, l, host))
		),
		(shape) => shape.feature
	)
	const witness = r.witness
	if (witness === undefined) {
		return [kind, `law ${law.law}`, ...shown]
	}
	const named: RefusalFeature = `refused by a ${law.kind} of ${witnessing(host, r.before, r.after, witness)}`
	const partial: ReadonlyArray<RefusalFeature> = Arr.some(r.laws, (l) =>
		partlyMet(r.after, l, witness)
	)
		? [`refused by a ${law.kind} beside a partial match`]
		: []
	return [kind, `law ${law.law}`, ...shown, named, ...partial]
}

/** The host laws a refusal's law states; a law the host does not know fails the case. */
/**
 * The host laws a refusal's laws state, those its final state violates first: one constraint may report several laws,
 * the containments merged into one foreign key (fin.md §15 rule 3), and a law the host does not know fails the case.
 */
const refusingLaws = (
	host: HostSchema,
	laws: Arr.NonEmptyReadonlyArray<LawId>,
	violated: ReadonlyArray<LawId>
): Result.Result<Arr.NonEmptyReadonlyArray<HostLaw>, string> => {
	const unknown = Arr.filter(laws, (law) => !Arr.some(host.laws, (l) => l.law === law))
	if (unknown.length > 0) {
		return Result.fail(`refused by ${Arr.join(unknown, ", ")}, a law the host does not know`)
	}
	const named = Arr.filter(host.laws, (l) => laws.includes(l.law))
	const [first, ...rest] = [
		...Arr.filter(named, (l) => violated.includes(l.law)),
		...Arr.filter(named, (l) => !violated.includes(l.law))
	]
	return first === undefined
		? Result.fail(`refused by ${Arr.join(laws, ", ")}, which the host states no law of`)
		: Result.succeed([first, ...rest])
}

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
export interface Session {
	readonly host: HostSchema
	/** Empties every table, as the owner. */
	readonly reset: Effect.Effect<void, SqlError>
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
 * The owner's side of an installed family schema: emptying every table, the committed state in stateRows' form, and
 * the closed id each field holds, whose column stores its handle's code.
 */
export interface OwnerView {
	readonly table: (relation: HostRelation) => string
	readonly closed: (relation: string, field: string) => ClosedField | undefined
	readonly reset: Effect.Effect<void, SqlError>
	/** Every table's rows as their columns' output text, a closed id's code read back as the handle it names. */
	readonly read: Effect.Effect<StateRows, SqlError>
}

export const ownerView = (
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
			reset: s.admin.query(`TRUNCATE ${Arr.join(Arr.map(host.relations, table), ", ")}`, []),
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
	apply: Session["apply"]
): Effect.Effect<Session, never, Substrate> =>
	Effect.map(ownerView(host, installed), (owner) => ({
		host,
		reset: owner.reset,
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
): Effect.Effect<Session, never, Substrate> =>
	sessionOf(host, opened.installed, servedApply(opened, relations))

/**
 * Field domains of the generator: each field of each relation draws from a few values, a value listed twice drawn
 * twice as often.
 */
export type Domains = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<HostValue>>>>>

/**
 * The features a case's step swarm turns on, off or weighs: each op kind, and each way a fact is drawn. A member's op is
 * one the swarm turns on, insert when it turns on none; its first fact is drawn, stored or linked, drawn when the swarm
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

/** A case's step swarm, drawn before its steps, which draw their op kinds and fact modes under it. */
export const stepSwarmGen: Gen<Swarm<StepFeature>> = swarm(stepFeatures)

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

const supportedSketchGen: Gen<MemberSketch> = (source) => ({
	arm: "supported",
	need: source.draw(pickGen),
	values: source.draw(sixPicks)
})

const unselectedSketchGen: Gen<MemberSketch> = (source) => ({
	arm: "unselected",
	need: source.draw(pickGen),
	index: source.draw(pickGen),
	values: source.draw(sixPicks)
})

const unlinkSketchGen: Gen<MemberSketch> = (source) => ({
	arm: "unlink",
	index: source.draw(pickGen)
})

const nearSketchGen: Gen<MemberSketch> = (source) => ({
	arm: "near",
	need: source.draw(pickGen),
	target: source.draw(pickGen),
	miss: source.draw(pickGen),
	other: source.draw(pickGen),
	values: source.draw(sixPicks)
})

const caseSketchOf = (steps: number, member: Gen<MemberSketch>): Gen<CaseSketch> =>
	array(array(member, { min: 1, max: 3 }), { min: 1, max: steps })
/** A short case under a step swarm: a history's initial state, and each of its writers' lists (test/support/history). */
export const caseSketchGen = (steps: Swarm<StepFeature>): Gen<CaseSketch> =>
	caseSketchOf(4, writeSketchGen(steps))
/**
 * A family case runs up to eight steps. Three members in ten are planted: one stores a lawful referring group (a
 * selected source and its target); one deletes a fact a stored fact needs, so a law refuses a fact stored before the
 * step as often as a new one; one inserts a fact meeting the fact it needs on all of a law's paired fields but one, so
 * a foreign key that pairs several fields meets a partial match, which drawn facts meet only where the domains happen
 * to line up.
 */
const familyMemberGen = (steps: Swarm<StepFeature>): Gen<MemberSketch> =>
	weighted([
		[7, writeSketchGen(steps)],
		[1, supportedSketchGen],
		[1, unlinkSketchGen],
		[1, nearSketchGen]
	])
/** One step of a family case's members, under a step swarm. */
export const familyStepSketchGen = (steps: Swarm<StepFeature>): Gen<StepSketch> =>
	array(familyMemberGen(steps), { min: 1, max: 3 })

/**
 * The steps of a lawful state under a step swarm: half their members store a referring group, a quarter store a fact a
 * referring side's selection does not pick, which an UPDATE may then move into the selection, and a quarter draw their
 * facts.
 */
export const lawfulStateSketchGen = (steps: Swarm<StepFeature>): Gen<CaseSketch> =>
	caseSketchOf(
		4,
		weighted([
			[1, writeSketchGen(steps)],
			[2, supportedSketchGen],
			[1, unselectedSketchGen]
		])
	)

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
 * Planted sketches: a precondition the population reaches too rarely, named and resolved as drawn ones are.
 *
 * - valuePicks: the picks that draw `fact`'s values from its relation's domains, one per field in `fields`' order.
 * - plantedInsert, plantedDeletion: a write member inserting `fact` as drawn, or deleting the stored fact at `index` of
 *   the `count` the relation holds.
 * - plantedGroup: a supported member from a law's need, its referring fact the one `from` names: that fact and every
 *   fact it needs, transitively.
 */
const relationPick = (host: HostSchema, relation: string): number => {
	const index = Option.getOrThrowWith(
		Arr.findFirstIndex(host.relations, (r) => r.name === relation),
		() => new Error(`no relation ${relation}`)
	)
	return pickOf(index, host.relations.length)
}

/** Six picks, the length every sketch's value picks have, each field's at its place in `fields`. */
export const valuePicks = (
	domains: Domains,
	relation: string,
	fields: ReadonlyArray<string>,
	fact: Readonly<Record<string, HostValue>>
): ReadonlyArray<number> => {
	if (fields.length > 6) {
		throw new Error(`${relation} has more fields than a sketch has picks`)
	}
	return Arr.map(indices(6), (i) => {
		const field = fields[i]
		if (field === undefined) {
			return 0
		}
		const domain = defined(domains[relation]?.[field], `the domain of ${relation}.${field}`)
		const index = Option.getOrThrowWith(
			Arr.findFirstIndex(domain, (x) => sameValue(x, fact[field])),
			() => new Error(`${relation}.${field}'s domain holds no ${Formatter.format(fact[field])}`)
		)
		return pickOf(index, domain.length)
	})
}

const headingOf = (host: HostSchema, relation: string): ReadonlyArray<string> =>
	Arr.map(relationOf(host, relation).fields, (f) => f.name)

/** A write of `fact` drawn whole: an insertion, or a put, which a mutable relation takes as its key's new payload. */
const plantedWrite = (
	host: HostSchema,
	domains: Domains,
	relation: string,
	fact: Readonly<Record<string, HostValue>>,
	kind: "insert" | "put"
): MemberSketch => ({
	arm: "write",
	relation: relationPick(host, relation),
	kind,
	first: {
		mode: "drawn",
		values: valuePicks(domains, relation, headingOf(host, relation), fact),
		index: 0,
		link: 0
	},
	rest: []
})

export const plantedInsert = (
	host: HostSchema,
	domains: Domains,
	relation: string,
	fact: Readonly<Record<string, HostValue>>
): MemberSketch => plantedWrite(host, domains, relation, fact, "insert")

/** A put of `fact` at its key: on a mutable relation the stored fact there takes its payload, else an insertion. */
const plantedPut = (
	host: HostSchema,
	domains: Domains,
	relation: string,
	fact: Readonly<Record<string, HostValue>>
): MemberSketch => plantedWrite(host, domains, relation, fact, "put")

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

export const plantedGroup = (
	host: HostSchema,
	domains: Domains,
	law: HostLaw,
	from: Readonly<Record<string, HostValue>>
): MemberSketch => {
	const [need] = needs(law)
	if (need === undefined) {
		throw new Error(`${law.law} needs nothing`)
	}
	const offset = Arr.flatMap(host.laws.slice(0, host.laws.indexOf(law)), needs).length
	return {
		arm: "supported",
		need: pickOf(offset, Arr.flatMap(host.laws, needs).length),
		values: valuePicks(domains, need.from.relation, headingOf(host, need.from.relation), from)
	}
}

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
		const kind: OpKind = o.kind
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
export interface WrittenFact {
	readonly relation: string
	readonly fact: HostFact
}

/**
 * `written` with every fact a containment or a coverage requires of the facts it writes, transitively, that
 * neither `before` nor `written` holds: each drawn by `values` (a fact's place among the written as its pick) and
 * pointed at the fact that requires it.
 */
export const withSupports = (
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
 * An unlink member, resolved against the state the step's earlier members `ops` leave: the deletion of one fact that a
 * fact there needs, or nothing when no fact needs another.
 */
const resolveUnlink = (
	host: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	sketch: UnlinkSketch
): ReadonlyArray<HostOp> => {
	const before = transition(host, state, ops)
	const facts = (relation: string) => defined(before.get(relation), `the state's ${relation} facts`)
	const references = Arr.flatMap(host.laws, needs)
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
export const redrawStride = 40_503
/** The most facts a member's supports close over: a closure past it is a defect of a family's laws. */
const supportBound = 32

/** Every fact of `relation` its domains draw, the last field's values varying fastest. */
export const domainFacts = function* (
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

/** A planted refusal's steps: those the host accepts, and the step it then refuses. */
interface PlantedSteps {
	readonly lawful: CaseSketch
	readonly refused: StepSketch
}

/**
 * A planted refusal's case: its steps, and the refusal as the host predicts it, once for each violator its witness may
 * name (once naming none, for a native violation).
 */
export interface PlantedCase extends PlantedSteps {
	readonly refusals: Arr.NonEmptyReadonlyArray<HostRefusal>
}

/** Every ordered pair of the facts a law's source side may hold. */
const pairsOf = function* (host: HostSchema, domains: Domains, law: HostLaw) {
	for (const first of domainFacts(host, domains, fromOf(law))) {
		for (const second of domainFacts(host, domains, fromOf(law))) {
			yield [first, second] as const
		}
	}
}

const fromOf = (law: HostLaw): string => defined(needs(law)[0], `${law.law}'s need`).from.relation

/**
 * The first case, in a fixed order, each of whose lawful steps the host accepts and whose refused step it refuses by
 * one law alone, a refusal `reaches` admits whichever violator its witness names; none when no candidate is. The
 * candidates:
 * - one fact inserted alone, over every fact its relation's domains draw;
 * - a lawful referring group from a law's need (plantedGroup), over every referring fact the domains draw, then a fact
 *   of the state deleted;
 * - a lawful fact, then a second fact of its relation inserted beside it, over every pair the domains draw, so the
 *   second may collide with the first under a key or a span key;
 * - two lawful groups of one need, then a fact deleted, so a fact the deletion leaves may meet the violator in part;
 * - each stored source fact switched into a selected containment's selection, and each of its stored targets moved;
 * - a lawful fact, then a fact of another relation inserted beside it;
 * - a source fact switched into its selection beside a lawful fact of another relation.
 */
export const plantedRefusal = (
	host: HostSchema,
	domains: Domains,
	reaches: (r: HostRefusal) => boolean
): PlantedCase | undefined => {
	const accepted = (steps: CaseSketch): HostState | undefined => {
		let state = emptyState(host)
		for (const step of steps) {
			const e = expect(host, state, resolveStep(host, domains, state, step))
			if (e.kind !== "accepted") {
				return undefined
			}
			state = e.state
		}
		return state
	}
	const refusals = (
		before: HostState,
		step: StepSketch
	): Arr.NonEmptyReadonlyArray<HostRefusal> | undefined => {
		const ops = resolveStep(host, domains, before, step)
		const e = expect(host, before, ops)
		if (e.kind !== "invariant-rejected") {
			return undefined
		}
		const [only, ...others] = e.violations
		if (only === undefined || others.length > 0) {
			return undefined
		}
		const laws = refusingLaws(host, [only.law], [only.law])
		if (Result.isFailure(laws)) {
			return undefined
		}
		const after = transition(host, before, ops)
		const refusal = (witness: WitnessKey | undefined): HostRefusal => ({
			laws: laws.success,
			before,
			after,
			witness
		})
		const [named, ...rest] = only.violators
		const each: Arr.NonEmptyReadonlyArray<HostRefusal> =
			named === undefined ? [refusal(undefined)] : [refusal(named), ...Arr.map(rest, refusal)]
		return Arr.every(each, reaches) ? each : undefined
	}
	const deletions = function* (lawful: CaseSketch): Generator<PlantedSteps> {
		const state = accepted(lawful)
		if (state === undefined) {
			return
		}
		for (const r of host.relations) {
			const facts = state.get(r.name) ?? []
			for (const [i] of facts.entries()) {
				yield { lawful, refused: [plantedDeletion(host, r.name, i, facts.length)] }
			}
		}
	}
	const besides = function* (
		relation: string,
		fact: Readonly<Record<string, HostValue>>
	): Generator<PlantedSteps> {
		const lawful: CaseSketch = [[plantedInsert(host, domains, relation, fact)]]
		if (accepted(lawful) === undefined) {
			return
		}
		for (const second of domainFacts(host, domains, relation)) {
			yield { lawful, refused: [plantedInsert(host, domains, relation, second)] }
		}
	}
	/**
	 * A lawful fact, then a fact of another relation inserted beside it, over every pair the domains draw: a source
	 * written alone into a state that holds what its other laws ask of it, a coverage's target beside a containment's.
	 */
	/**
	 * A lawful fact, then a lawful fact of another relation beside it, over every pair the domains draw: a state that
	 * holds what a source's other laws ask of it, a coverage's target, beside the source a switch rewrites.
	 */
	const acrossStates = function* (): Generator<CaseSketch> {
		for (const r of host.relations) {
			for (const fact of domainFacts(host, domains, r.name)) {
				for (const other of host.relations) {
					if (other.name === r.name) {
						continue
					}
					for (const second of domainFacts(host, domains, other.name)) {
						yield [
							[plantedInsert(host, domains, r.name, fact)],
							[plantedInsert(host, domains, other.name, second)]
						]
					}
				}
			}
		}
	}
	const across = function* (): Generator<PlantedSteps> {
		for (const r of host.relations) {
			for (const fact of domainFacts(host, domains, r.name)) {
				const lawful: CaseSketch = [[plantedInsert(host, domains, r.name, fact)]]
				if (accepted(lawful) === undefined) {
					continue
				}
				for (const other of host.relations) {
					if (other.name === r.name) {
						continue
					}
					for (const second of domainFacts(host, domains, other.name)) {
						yield { lawful, refused: [plantedInsert(host, domains, other.name, second)] }
					}
				}
			}
		}
	}
	const grouped = Arr.filter(host.laws, (l) => needs(l).length > 0)
	/** The lawful states a rewrite starts from: one fact alone, one referring group, two referring groups. */
	const startingStates = function* (): Generator<CaseSketch> {
		for (const r of host.relations) {
			for (const fact of domainFacts(host, domains, r.name)) {
				yield [[plantedInsert(host, domains, r.name, fact)]]
			}
		}
		for (const law of grouped) {
			for (const from of domainFacts(host, domains, fromOf(law))) {
				yield [[plantedGroup(host, domains, law, from)]]
			}
		}
		for (const law of grouped) {
			for (const [first, second] of pairsOf(host, domains, law)) {
				yield [
					[plantedGroup(host, domains, law, first)],
					[plantedGroup(host, domains, law, second)]
				]
			}
		}
	}
	/**
	 * The stored fact `at` of `relation` rewritten at its key into `next`: by a put, which a mutable relation takes as
	 * the fact's new payload, or by its deletion and next's insertion in one step, which replaces it on any relation;
	 * each also with one other stored fact deleted, a fact the old one's laws asked for or one the new one collides with.
	 */
	const rewrites = function* (
		state: HostState,
		relation: string,
		at: number,
		next: Readonly<Record<string, HostValue>>
	): Generator<StepSketch> {
		const stored = state.get(relation) ?? []
		const forms: ReadonlyArray<StepSketch> = [
			[plantedPut(host, domains, relation, next)],
			[
				plantedDeletion(host, relation, at, stored.length),
				plantedInsert(host, domains, relation, next)
			]
		]
		for (const form of forms) {
			yield form
			for (const r of host.relations) {
				const facts = state.get(r.name) ?? []
				for (const [i] of facts.entries()) {
					if (r.name !== relation || i !== at) {
						yield [...form, plantedDeletion(host, r.name, i, facts.length)]
					}
				}
			}
		}
	}
	/** Whether every value of `values` lies in its field's domain, so a planted member can pick it. */
	const inDomain = (relation: string, values: Readonly<Record<string, HostValue>>): boolean =>
		Arr.every(Rec.toEntries(values), ([field, value]) =>
			Arr.some(domains[relation]?.[field] ?? [], (x) => sameValue(x, value))
		)
	/**
	 * Each stored source fact outside a selected containment's selection switched into it at its key, its target not
	 * added.
	 */
	const switches = function* (states: Iterable<CaseSketch>): Generator<PlantedSteps> {
		for (const lawful of states) {
			const state = accepted(lawful)
			if (state === undefined) {
				continue
			}
			for (const law of host.laws) {
				if (
					!isSelectedContainment(law) ||
					!inDomain(law.source.relation, pinned(law.source.selection))
				) {
					continue
				}
				for (const [i, a] of (state.get(law.source.relation) ?? []).entries()) {
					if (selected(a, law.source.selection)) {
						continue
					}
					for (const refused of rewrites(state, law.source.relation, i, {
						...a,
						...pinned(law.source.selection)
					})) {
						yield { lawful, refused }
					}
				}
			}
		}
	}
	/** Each stored target of a selected containment moved at its key, its paired fields to other values. */
	const moves = function* (): Generator<PlantedSteps> {
		for (const lawful of startingStates()) {
			const state = accepted(lawful)
			if (state === undefined) {
				continue
			}
			for (const law of host.laws) {
				if (!isSelectedContainment(law)) {
					continue
				}
				const target = law.target.relation
				const key = relationOf(host, target).key
				for (const [i, d] of (state.get(target) ?? []).entries()) {
					for (const moved of domainFacts(host, domains, target)) {
						if (
							projection(moved, key) === projection(d, key) &&
							projection(moved, law.target.fields) !== projection(d, law.target.fields)
						) {
							for (const refused of rewrites(state, target, i, moved)) {
								yield { lawful, refused }
							}
						}
					}
				}
			}
		}
	}
	const candidates = function* (): Generator<PlantedSteps> {
		for (const r of host.relations) {
			for (const fact of domainFacts(host, domains, r.name)) {
				yield { lawful: [], refused: [plantedInsert(host, domains, r.name, fact)] }
			}
		}
		for (const law of grouped) {
			for (const from of domainFacts(host, domains, fromOf(law))) {
				yield* deletions([[plantedGroup(host, domains, law, from)]])
			}
		}
		for (const r of host.relations) {
			for (const fact of domainFacts(host, domains, r.name)) {
				yield* besides(r.name, fact)
			}
		}
		for (const law of grouped) {
			for (const [first, second] of pairsOf(host, domains, law)) {
				yield* deletions([
					[plantedGroup(host, domains, law, first)],
					[plantedGroup(host, domains, law, second)]
				])
			}
		}
		yield* switches(startingStates())
		yield* moves()
		yield* across()
		yield* switches(acrossStates())
	}
	for (const c of candidates()) {
		const before = accepted(c.lawful)
		const found = before === undefined ? undefined : refusals(before, c.refused)
		if (found !== undefined) {
			return { ...c, refusals: found }
		}
	}
	return undefined
}

const showOps = (ops: ReadonlyArray<HostOp>): string =>
	Arr.join(
		Arr.map(ops, (o) => `${o.kind} ${o.relation} ${Formatter.format(o.facts)}`),
		"; "
	)

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

/**
 * What a step's ChangeSet does: the outcome its apply answers, or, refused when it compiles, the cycle of its stratum's
 * writes UnorderableStratum names.
 */
type StepOutcome =
	| ApplyOutcome<unknown>
	| { readonly kind: "unorderable"; readonly cycle: Arr.NonEmptyReadonlyArray<CycleWrite> }

/** A step's apply as its outcome: an UnorderableStratum is the step's, any other failure a defect of the run. */
const stepOutcome = (
	applied: Effect.Effect<ApplyOutcome<unknown>, ApplyError | ServedRefusal>
): Effect.Effect<StepOutcome> =>
	Effect.catch(applied, (failure): Effect.Effect<StepOutcome> => {
		const cycle = unorderableCycle(failure)
		return cycle === undefined
			? Effect.die(failure)
			: Effect.succeed({ kind: "unorderable", cycle })
	})

/**
 * The first order of a cycle, each write before the next and the last before the first, that the stratum's writes do
 * not require (`order`), if any.
 */
const unrequiredStep = (
	order: ReadonlyArray<Precedes>,
	cycle: Arr.NonEmptyReadonlyArray<CycleWrite>
): readonly [CycleWrite, CycleWrite] | undefined =>
	Arr.findFirst(
		Arr.zip(cycle, Arr.append(Arr.tailNonEmpty(cycle), Arr.headNonEmpty(cycle))),
		([a, b]) =>
			!Arr.some(
				order,
				(p) =>
					p.before.relation === a.relation &&
					p.before.op === a.op &&
					p.after.relation === b.relation &&
					p.after.op === b.op
			)
	).pipe(Option.getOrUndefined)

const showWrites = (writes: ReadonlyArray<CycleWrite>): string =>
	Arr.join(
		Arr.map(writes, (w) => `${w.op} ${w.relation}`),
		", then "
	)

/** The first way an outcome departs from the host's expectation, if any. */
const mismatch = (
	session: Session,
	expected: Expected,
	outcome: StepOutcome
): string | undefined => {
	if (expected.kind === "unorderable") {
		if (outcome.kind !== "unorderable") {
			return `expected UnorderableStratum, the stratum's writes ordered in a cycle by ${Formatter.format(expected.order)}, got ${Formatter.format(outcome)}`
		}
		const step = unrequiredStep(expected.order, outcome.cycle)
		return step === undefined
			? undefined
			: `refused with UnorderableStratum, whose order ${showWrites(step)} the stratum's writes do not require; the cycle: ${showWrites(outcome.cycle)}`
	}
	if (outcome.kind === "unorderable") {
		return `refused with UnorderableStratum (${showWrites(outcome.cycle)}), where some order of the stratum's writes keeps every immediate key; expected ${expected.kind}`
	}
	if (expected.kind !== "invariant-rejected") {
		return outcome.kind === expected.kind
			? undefined
			: `expected ${expected.kind}, got ${Formatter.format(outcome)}`
	}
	if (outcome.kind !== "invariant-rejected") {
		return `expected a refusal by one of ${Formatter.format(Arr.map(expected.violations, (v) => v.law))}, got ${Formatter.format(outcome)}`
	}
	const laws = Arr.map(outcome.refused.laws, session.reported)
	const violation = Arr.findFirst(expected.violations, (v) => laws.includes(v.law))
	if (Option.isNone(violation)) {
		return `refused by ${Arr.join(laws, ", ")}, none of which the final state violates; violated: ${Formatter.format(expected.violations)}`
	}
	const witness = outcome.witness
	if (violation.value.violators.length === 0) {
		return witness.kind === "unreported"
			? undefined
			: `a native violation's witness is ${Formatter.format(witness)}, where PostgreSQL leaves its key unreported`
	}
	if (witness.kind !== "key") {
		return undefined
	}
	return Arr.some(
		violation.value.violators,
		(v) => v.relation === witness.relation && sameValues(v.values, witness.values)
	)
		? undefined
		: `the witness key ${Formatter.format(witness)} names no violating fact of ${Formatter.format(violation.value.violators)}`
}

/**
 * A family case: which of the family's schemas it runs on, by its index among them, and its steps, each member's op
 * kind and fact modes as the case's step swarm chose them.
 */
export interface FamilyCase {
	readonly variant: number
	readonly steps: CaseSketch
}

/**
 * Family cases over `variants` schemas: the schema drawn evenly, so every schema of a family meets its share of the
 * cases, then the case's step swarm, then its steps under it.
 */
export const familyCaseGen =
	(variants: number): Gen<FamilyCase> =>
	(source) => {
		const variant = source.draw(int(0, variants - 1))
		const steps = source.draw(stepSwarmGen)
		return { variant, steps: source.draw(caseSketchOf(8, familyMemberGen(steps))) }
	}

/**
 * The features of an outcome: a refusal's, by the laws it names, an accepted or unchanged outcome's kind, or a stratum
 * refused when it compiles.
 */
const outcomeFeatures = (
	session: Session,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	outcome: StepOutcome
): Result.Result<ReadonlyArray<FamilyFeature>, string> => {
	const host = session.host
	switch (outcome.kind) {
		case "unorderable":
			return Result.succeed(["a stratum no order keeps refused"])
		case "invariant-rejected": {
			const after = transition(host, state, ops)
			const violated = Arr.map(violations(host, after), (v) => v.law)
			return Result.map(
				refusingLaws(host, Arr.map(outcome.refused.laws, session.reported), violated),
				(laws) =>
					refusalFeatures(host, {
						laws,
						before: state,
						after,
						witness: outcome.witness.kind === "key" ? outcome.witness : undefined
					})
			)
		}
		case "outside-world":
			return Result.succeed([])
		case "accepted":
			return Result.succeed([
				"accepted",
				...(exemptAnchors(host, transition(host, state, ops))
					? (["accepted beside a source fact no selected containment selects"] as const)
					: [])
			])
		case "no-change":
			return Result.succeed([outcome.kind])
	}
}

/**
 * Whether a state holds a fact of a selected containment's source relation that no selected containment of that
 * relation selects: a parent at a handle no arm carries, a line its selector leaves unflagged.
 */
const exemptAnchors = (host: HostSchema, state: HostState): boolean => {
	const sources = new Set(
		Arr.flatMap(host.laws, (l) => (isSelectedContainment(l) ? [l.source.relation] : []))
	)
	return Arr.some([...sources], (relation) =>
		Arr.some(
			state.get(relation) ?? [],
			(fact) =>
				!Arr.some(
					host.laws,
					(l) =>
						isSelectedContainment(l) &&
						l.source.relation === relation &&
						selected(fact, l.source.selection)
				)
		)
	)
}

/**
 * Whether a family's schema can reach a source fact no selected containment selects: a selected containment's source
 * relation, some value of whose selector fields' domains no selected containment of that relation selects.
 */
export const exemptReachable = (host: HostSchema, domains: Domains): boolean =>
	Arr.some(host.laws, (l) => {
		if (!isSelectedContainment(l)) {
			return false
		}
		const relation = l.source.relation
		const peers = Arr.filter(
			host.laws,
			(m): m is HostContainment => isSelectedContainment(m) && m.source.relation === relation
		)
		const at = pinned(l.source.selection)
		return Arr.some(Rec.keys(at), (field) =>
			Arr.some(domains[relation]?.[field] ?? [], (value) => {
				const fact = { ...at, [field]: value }
				return Arr.every(peers, (m) => !selected(fact, m.source.selection))
			})
		)
	})

/**
 * The harness of the law-bearing generated suites: over law-bearing generated schemas, an outcome is accepted iff the
 * brute-force evaluation of every violation query on the final state is empty.
 *
 * A family (boxes.ts) states a schema shape whose laws, bounds, selectors and mutability are drawn from a fixed
 * space, the same schema as the host sees it (model.ts), and the typed ChangeSet of a list of enumerated members. Each
 * drawn schema installs once per test, with its laws, under a fresh schema name, and each case opens a grizzle
 * writer on it through Db.open and a DbLayer of its own on the substrate's database. A case is a sequence
 * of up to eight ChangeSets applied from the empty state, each resolved against the state the host expects before it,
 * so later steps delete, replace and move the facts earlier steps stored, and add facts referring to them. Each step's
 * outcome must be the host's:
 *
 * - UnorderableStratum when the ChangeSet compiles, exactly when the order its stratum's writes require runs in a cycle
 *   (model.ts stratumOrder), naming a cycle each of whose orders they require, and the state left as it was;
 * - `accepted` or `no-change` exactly when the brute-force evaluation of every law's violation query on the final
 *   state is empty, and then the committed state is the host's final state;
 * - otherwise `invariant-rejected` with one of the violated laws (a key law when one is violated, since keys are
 *   immediate), a witness of that law whose keys name violating facts (none for a native violation), and the state
 *   left as it was.
 *
 * A case draws which of the family's schemas it runs on and its steps; it explores through the library's explore: the
 * floor stream its suite's label derives and the run's rotating stream, and a failing case shrinks to a minimal one.
 * What a case reached is noted through its own Case (FamilyFeature).
 *
 * Runs one case's steps against a session from the empty state; the first mismatch fails the case with its steps. Each step notes its members' op kinds and its outcome: `accepted`, `no-change`, or what its
 * refusal notes (refusalFeatures).
 *
 * A full role's write is never outside its world: no host outcome is, and mismatch reports it.
 */
export const runSteps = (
	session: Session,
	domains: Domains,
	sketch: CaseSketch,
	note: Case<FamilyFeature>["note"]
): Effect.Effect<void, CaseFailed> =>
	Effect.gen(function* () {
		yield* Effect.orDie(session.reset)
		let state = emptyState(session.host)
		const log: Array<string> = []
		for (const step of sketch) {
			const ops = resolveStep(session.host, domains, state, step)
			for (const o of ops) {
				note(`op ${o.kind}`)
				for (const f of memberRepeats(session.host, o)) {
					note(f)
				}
			}
			const expected = expect(session.host, state, ops)
			const outcome = yield* stepOutcome(session.apply(ops))
			log.push(`${showOps(ops)}\n    expected ${expected.kind}, got ${Formatter.format(outcome)}`)
			const features = outcomeFeatures(session, state, ops, outcome)
			if (Result.isFailure(features)) {
				return yield* new CaseFailed({
					report: `${Arr.join(log, "\n  ")}\n  ${features.failure}`
				})
			}
			for (const f of features.success) {
				note(f)
			}
			const problem = mismatch(session, expected, outcome)
			if (problem !== undefined) {
				return yield* new CaseFailed({ report: `${Arr.join(log, "\n  ")}\n  ${problem}` })
			}
			if (expected.kind === "accepted" || expected.kind === "no-change") {
				state = expected.state
			}
			const stored = yield* Effect.orDie(session.read)
			const hosted = stateRows(session.host, state)
			yield* Effect.mapError(
				agree(
					[
						["postgresql", stored],
						["host", hosted]
					],
					rowsDifference
				),
				(disagreement) =>
					new CaseFailed({
						report: `${Arr.join(log, "\n  ")}\n  ${disagreement.message}\n  postgresql: ${Formatter.format(stored)}\n  host: ${Formatter.format(hosted)}`
					})
			)
		}
	})
