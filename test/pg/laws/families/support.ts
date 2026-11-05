import type { Case } from "@grizzle/testing/explore"
import { array, type Gen, int, weighted } from "@grizzle/testing/gen"
import { agree } from "@grizzle/testing/oracle"
import { type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import {
	Array as Arr,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	Result,
	type Scope
} from "effect"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import { appendAll, indices } from "#compiler/core/array.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type AnyClosed,
	type AnyDerived,
	type AnyRelation,
	type AnySchema,
	login,
	role
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { type ChangeSetValue, changeSetOver } from "#compiler/write/changeset/value.ts"
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
	isResidual,
	isSelectedTargetCoverage,
	needs,
	type HostOp,
	type OpKind,
	overlapsUnequally,
	pinned,
	projection,
	relationOf,
	rowsDifference,
	type HostSide,
	type StateRows,
	sameValue,
	sameValues,
	selected,
	selectorValues,
	sharesWitnessRelation,
	stateRows,
	transition,
	type HostValue
} from "#test/pg/laws/families/model.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { reportedLawId } from "#test/support/kernel/naming.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pickFrom, pickGen, pickOf, pickSpan } from "#test/support/pick.ts"
import { dbRuntime } from "#test/support/runtime-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayerIn } from "#test/support/worlds.ts"

/**
 * What a family case notes: each step's op kinds and its outcome, what a refusal notes (refusalFeatures), and the
 * schema it ran on and each of its traits (families.ts).
 */
export type FamilyFeature =
	| "accepted"
	| "accepted beside an anchor no obligation selects"
	| "no-change"
	| RefusalFeature
	| `op ${OpKind}`
	| `schema ${string}`
	| `trait ${string}`

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
export const witnessing = (
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
						if (!selected(t, to.where)) {
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
 * as several, alternatives' obligation as one per armed handle), the states before the step and after it, and the key
 * its witness names, none for a native violation.
 */
export interface Refused {
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
	readonly shows: (r: Refused, law: HostLaw, host: HostSchema) => boolean
}

const always = (): boolean => true

/** Whether a step wrote a relation: its facts after differ from its facts before. */
const wrote = (r: Refused, relation: string): boolean => {
	const before = r.before.get(relation) ?? []
	const after = r.after.get(relation) ?? []
	return (
		before.length !== after.length ||
		Arr.some(before, (f) => !Arr.some(after, (g) => sameValues(f, g)))
	)
}

/** The side of an obligation, its anchor or its dependent, a refused step wrote alone. */
const wroteAlone =
	(side: "anchor" | "dependent") =>
	(r: Refused, law: HostLaw): boolean =>
		law.kind === "obliged" &&
		(side === "anchor"
			? wrote(r, law.anchor.relation) && !wrote(r, law.dependent.relation)
			: wrote(r, law.dependent.relation) && !wrote(r, law.anchor.relation))

/** Whether an anchor fact the obligation selects after the step stood under the same key outside its selection. */
const switchedIn = (r: Refused, law: HostLaw, host: HostSchema): boolean => {
	if (law.kind !== "obliged") {
		return false
	}
	const key = relationOf(host, law.anchor.relation).key
	return Arr.some(
		r.after.get(law.anchor.relation) ?? [],
		(a) =>
			selected(a, law.anchor.where) &&
			Arr.some(
				r.before.get(law.anchor.relation) ?? [],
				(b) => projection(a, key) === projection(b, key) && !selected(b, law.anchor.where)
			)
	)
}

/** Whether a dependent fact kept its key and moved: its fields the obligation pairs changed. */
const dependentMoved = (r: Refused, law: HostLaw, host: HostSchema): boolean => {
	if (law.kind !== "obliged") {
		return false
	}
	const key = relationOf(host, law.dependent.relation).key
	return Arr.some(r.after.get(law.dependent.relation) ?? [], (a) =>
		Arr.some(
			r.before.get(law.dependent.relation) ?? [],
			(b) =>
				projection(a, key) === projection(b, key) &&
				projection(a, law.dependent.fields) !== projection(b, law.dependent.fields)
		)
	)
}

/** Whether an obligation's dependent fields are other than its relation's key, so a dependent can move. */
const movable = (law: HostLaw, host: HostSchema): boolean =>
	law.kind === "obliged" &&
	!sameFieldSet(relationOf(host, law.dependent.relation).key, law.dependent.fields)

const sameFieldSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (f) => b.includes(f))

const obliged = (law: HostLaw): boolean => law.kind === "obliged"

/** Whether an obligation selects its anchors. */
const selective = (law: HostLaw): boolean =>
	law.kind === "obliged" && Rec.keys(law.anchor.where).length > 0

/**
 * Every shape of law a refusal may show, each where grizzle's laws have broken: a coverage across renamed fields; a
 * coverage into a selected target; a candidate span key over two facts whose unequal spans overlap; and one of two
 * residual laws that name one relation's facts by two keys of one arity, whose witness only the raising law's own codec
 * reads.
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
		shows: (r: Refused, law: HostLaw) => overlapsUnequally(r.after, law)
	},
	{
		feature: "two residual laws, one relation, keys of one arity",
		declares: (law: HostLaw, host: HostSchema) => sharesWitnessRelation(host, law),
		shows: always
	},
	{
		feature: "refused by an obligation after a write of its anchors alone",
		declares: obliged,
		shows: wroteAlone("anchor")
	},
	{
		feature: "refused by an obligation after a write of its dependents alone",
		declares: obliged,
		shows: wroteAlone("dependent")
	},
	{
		feature: "refused by an obligation after an anchor switched into its selection",
		declares: selective,
		shows: switchedIn
	},
	{
		feature: "refused by an obligation after its dependent moved",
		declares: movable,
		shows: dependentMoved
	}
] as const satisfies ReadonlyArray<LawShape>

/** What a refusal notes: the one rule its case notes by and a planted case is found by (plantedRefusal). */
export const refusalFeatures = (host: HostSchema, r: Refused): ReadonlyArray<RefusalFeature> => {
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
const refusingLaws = (
	host: HostSchema,
	law: LawId
): Result.Result<Arr.NonEmptyReadonlyArray<HostLaw>, string> => {
	const [first, ...rest] = Arr.filter(host.laws, (l) => l.law === law)
	return first === undefined
		? Result.fail(`refused by ${law}, a law the host does not know`)
		: Result.succeed([first, ...rest])
}

/**
 * The writers of a family schema: `app`, the grizzle writer, in the login `server`, and `direct`, the role its direct SQL
 * writers take on, in the login `psql`, each holding every relation of the schema whole and writing every ordinary
 * one. A second grizzle writer is `app` opened again through a DbLayer of its own (openWriter), so its session is its
 * own backend. The direct writers log in apart from the grizzle writers, so the backends of a login are the grizzle
 * writers' alone (pg_stat_activity names the login, never the role a session took on), which the histories and the
 * schedules resolve a writer's backend by.
 */
export const familyWriters = (base: AnySchema) => {
	const relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>> = Rec.fromEntries(
		Arr.flatMap(Rec.toEntries(base.relations), ([name, r]) =>
			r.kind === "world" ? [] : [[name, r] as const]
		)
	)
	const write = Arr.filter(Rec.keys(relations), (name) => relations[name]?.kind === "relation")
	const app = role(base, "app", relations, { write })
	const direct = role(base, "direct", relations, { write })
	return { app, direct, server: login(base, "server", [app]), psql: login(base, "psql", [direct]) }
}
export type FamilyWriters = ReturnType<typeof familyWriters>

/** An installed family schema, opened as its grizzle writer `app`. */
export interface Opened<S extends AnySchema> {
	readonly installed: Installed
	readonly schema: S
	readonly db: Db<FamilyWriters["app"], unknown>
}

/**
 * Installs the schema `build` makes with its residual laws and its writers' login under a fresh schema name. The
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
 * Opens `app` on an installation of `opened.schema`, through a DbLayer of its own on the substrate's database: each
 * call is a writer with a pool of its own.
 */
export const openWriter = <S extends AnySchema>(opened: {
	readonly installed: Installed
	readonly schema: S
}): Effect.Effect<Opened<S>, OpenError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const writers = familyWriters(opened.schema)
		const context = yield* Layer.build(loginLayerIn(s.database, opened.installed, writers.server))
		const db = yield* Db.open(writers.server.roles.app, {}).pipe(Effect.provideContext(context))
		return { installed: opened.installed, schema: opened.schema, db }
	})

/** One installed family schema as the harness drives it. */
export interface Session {
	readonly host: HostSchema
	/** Empties every table, as the owner. */
	readonly reset: Effect.Effect<void, SqlError>
	/** db.apply of the typed ChangeSet of `ops`. */
	readonly apply: (ops: ReadonlyArray<HostOp>) => Effect.Effect<ApplyOutcome<unknown>, ApplyError>
	/** The committed state, read as the owner, in stateRows' form. */
	readonly read: Effect.Effect<StateRows, SqlError>
	/** The LawId of the law an outcome names, read back through the installation's described laws. */
	readonly reported: (law: Law) => LawId
}

/** The owner's side of an installed family schema: emptying every table, and the committed state in stateRows' form. */
export interface OwnerView {
	readonly table: (relation: HostRelation) => string
	readonly reset: Effect.Effect<void, SqlError>
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
		return {
			table,
			reset: s.admin.query(`TRUNCATE ${Arr.join(Arr.map(host.relations, table), ", ")}`, []),
			read: Effect.forEach(host.relations, (r) =>
				Effect.map(
					s.admin.queryValues(
						`SELECT ${Arr.join(
							Arr.map(r.fields, (f) => `${quoteIdent(f.column)}::text`),
							", "
						)} FROM ${table(r)}`,
						[]
					),
					(rows) => Arr.map(rows, (row) => Arr.map(row, (x) => String(x)))
				)
			)
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
		reported: (law: Law) => reportedLawId(installed.installation.described, law)
	}))

/**
 * The ChangeSet of a step's host operations, built at run time over `schema` and its relation values by name as a
 * JavaScript caller passes members (packages/engine/src/write/changeset/value.ts): host facts are the members' facts, a span
 * field's value its endpoints.
 */
export const changeSetOf = (
	schema: unknown,
	relations: Readonly<Record<string, unknown>>,
	ops: ReadonlyArray<HostOp>
): ChangeSetValue => {
	let c = changeSetOver.empty(schema)
	for (const o of ops) {
		const relation = relations[o.relation]
		if (relation === undefined) {
			throw new Error(`no relation value ${o.relation}`)
		}
		c = c[o.kind](relation, o.facts)
	}
	return c
}

/** A session whose steps apply their ChangeSets (changeSetOf) through the opened Db's runtime. */
export const runtimeSession = <S extends AnySchema>(
	host: HostSchema,
	opened: Opened<S>,
	relations: Readonly<Record<string, unknown>>
): Effect.Effect<Session, never, Substrate> => {
	const runtime = dbRuntime(opened.db)
	if (runtime === undefined) {
		return Effect.die(new Error("Db.open registered no runtime"))
	}
	return sessionOf(host, opened.installed, (ops) =>
		runtime.methods.apply(changeSetOf(opened.schema, relations, ops), {})
	)
}

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
 * referring to a fact a law of the relation refers to (a containment's, a coverage's or a capacity's target, an
 * obligation's anchor), stored or added by an earlier member of the step, with the law's selector values and, for a
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
 * A member filling one target fact's group of a capacity past its bound (resolveFill): which capacity, which target,
 * how many sources to try first (1 to maxFill), and the picks the sources' and their supports' other fields are drawn
 * from.
 */
interface FillSketch {
	readonly arm: "fill"
	readonly law: number
	readonly target: number
	readonly count: number
	readonly values: ReadonlyArray<number>
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
type MemberSketch = WriteSketch | FillSketch | SupportedSketch | UnlinkSketch | NearSketch
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

const fillSketchGen: Gen<MemberSketch> = (source) => ({
	arm: "fill",
	law: source.draw(pickGen),
	target: source.draw(pickGen),
	count: source.draw(int(1, maxFill)),
	values: source.draw(sixPicks)
})

const supportedSketchGen: Gen<MemberSketch> = (source) => ({
	arm: "supported",
	need: source.draw(pickGen),
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
 * A family case runs up to eight steps, so a group fills past an upper bound over several of them. Four members in
 * eleven are planted: one fills a capacity's group past its bound in one step, since a refusal by a capacity alone
 * needs every other law of the group's facts to hold, which members drawn independently assemble too rarely to reach
 * in every run; one stores a lawful referring group (a selected source and its target, an anchor and its dependent);
 * one deletes a fact a stored fact needs, so a law refuses a fact stored before the step as often as a new one; one
 * inserts a fact meeting the fact it needs on all of a law's paired fields but one, so a law that pairs several fields
 * refuses beside a partial match, which drawn facts meet only where the domains happen to line up.
 */
const familyMemberGen = (steps: Swarm<StepFeature>): Gen<MemberSketch> =>
	weighted([
		[7, writeSketchGen(steps)],
		[1, fillSketchGen],
		[1, supportedSketchGen],
		[1, unlinkSketchGen],
		[1, nearSketchGen]
	])
/** One step of a family case's members, under a step swarm. */
export const familyStepSketchGen = (steps: Swarm<StepFeature>): Gen<StepSketch> =>
	array(familyMemberGen(steps), { min: 1, max: 3 })

/** The steps of a lawful state under a step swarm, most of them storing referring groups. */
export const lawfulStateSketchGen = (steps: Swarm<StepFeature>): Gen<CaseSketch> =>
	caseSketchOf(
		4,
		weighted([
			[1, writeSketchGen(steps)],
			[2, supportedSketchGen]
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
		if ((l.kind === "contained" || l.kind === "capacity") && l.source.relation === relation) {
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
		if (l.kind === "obliged" && l.dependent.relation === relation) {
			return [{ from: l.dependent, to: l.anchor }]
		}
		return []
	})
const admits = (side: HostSide, fact: HostFact): boolean => selected(fact, side.where)

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
		if (o.arm === "fill") {
			appendAll(ops, resolveFill(host, domains, state, ops, o))
			continue
		}
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
			const out: Record<string, HostValue> = { ...drawn, ...pinned(link.from.where) }
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
	const out: Record<string, HostValue> = { ...fact, ...pinned(side.where) }
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
export interface Written {
	readonly relation: string
	readonly fact: HostFact
}

/**
 * `written` with every fact a containment, coverage or obligation requires of the facts it writes, transitively, that
 * neither `before` nor `written` holds: each drawn by `values` (a fact's place among the written as its pick) and
 * pointed at the fact that requires it.
 */
export const withSupports = (
	host: HostSchema,
	domains: Domains,
	before: HostState,
	first: ReadonlyArray<Written>,
	values: (k: number) => ReadonlyArray<number>
): ReadonlyArray<Written> => {
	const required = Arr.flatMap(host.laws, needs)
	const stored = Arr.flatMap([...before], ([relation, facts]) =>
		Arr.map(facts, (fact) => ({ relation, fact }))
	)
	const written: Array<Written> = [...first]
	for (const { relation, fact } of written) {
		if (written.length > supportBound) {
			throw new Error(`a group of more than ${supportBound} facts: the family's needs cycle`)
		}
		for (const { from, to } of required) {
			if (from.relation !== relation || !selected(fact, from.where)) {
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
				selected(f, to.where) && Arr.every(to.fields, (field, j) => sameValue(f[field], at[j]))
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
const insertsOf = (written: ReadonlyArray<Written>): ReadonlyArray<HostOp> =>
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
		Arr.map(sketch.values, (p, i) => (p + k * (i + 1) * fillStride) % pickSpan)
	const fact = {
		...drawnFact(host, domains, need.from.relation, values(0)),
		...pinned(need.from.where)
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
					selected(t, to.where) &&
					Arr.some(
						facts(from.relation),
						(f) =>
							selected(f, from.where) &&
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
		Arr.map(sketch.values, (p, i) => (p + k * (i + 1) * fillStride) % pickSpan)
	const [stored, ...more] = Arr.filter(
		defined(before.get(to.relation), `the state's ${to.relation} facts`),
		(t) => selected(t, to.where)
	)
	/** The target, and what the member writes for it: nothing for a stored one, a drawn one with its supports. */
	const aimed = (): { readonly target: HostFact; readonly writes: ReadonlyArray<Written> } => {
		if (stored !== undefined) {
			return { target: pickFrom([stored, ...more], sketch.target), writes: [] }
		}
		const target = { ...drawnFact(host, domains, to.relation, values(1)), ...pinned(to.where) }
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
 * The most sources a fill writes into one group: past every family's upper bound from an empty group, whose widest is
 * three sources of a count or three shifts' widths past a ceiling of 8, with one to spare.
 */
const maxFill = 4
/**
 * The draws a fill searches per source count: the drawn picks, then each pick strided by its place, so the sources'
 * keys and payloads move apart through their domains; sixteen reach every combination of a family's two- to six-value
 * domains that the drawn ones miss often enough for a run's fills to reach the bound.
 */
const fillDraws = 16
export const fillStride = 40_503
/** The most facts a fill's supports close over: a closure past it is a defect of a family's laws. */
const supportBound = 32

/**
 * A fill member, resolved against the state the step's earlier members `ops` leave: the first set of facts the host
 * model refuses by capacities alone, among `count`, then every other number of sources up to maxFill, each over the
 * drawn picks and their strided redraws. Each set is sources of the capacity's source side in one target fact's group
 * (a target the state holds, or a drawn one inserted with them), with every fact a containment, coverage or
 * obligation requires of the facts it writes, transitively, drawn and pointed at them. When no set isolates a
 * capacity, the member writes the first set. A schema with no capacity has no group to fill, and its fill writes
 * nothing.
 */
const resolveFill = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	sketch: FillSketch
): ReadonlyArray<HostOp> => {
	const capacities = Arr.flatMap(host.laws, (l) => (l.kind === "capacity" ? [l] : []))
	const [firstCapacity, ...otherCapacities] = capacities
	if (firstCapacity === undefined) {
		return []
	}
	const law = pickFrom([firstCapacity, ...otherCapacities], sketch.law)
	const before = transition(host, state, ops)
	const targets = Arr.filter(
		defined(before.get(law.target.relation), `the state's ${law.target.relation} facts`),
		(f) => selected(f, law.target.where)
	)
	const candidate = (count: number, draw: number): ReadonlyArray<HostOp> => {
		const values = (k: number) =>
			Arr.map(
				sketch.values,
				(p, i) => (p + (draw * (maxFill + 1) + k) * (i + 1) * fillStride) % pickSpan
			)
		const written: Array<Written> = []
		const target =
			targets.length > 0
				? pickIn(targets, sketch.target, "the capacity's targets")
				: {
						...drawnFact(host, domains, law.target.relation, values(maxFill)),
						...pinned(law.target.where)
					}
		if (targets.length === 0) {
			written.push({ relation: law.target.relation, fact: target })
		}
		const group = Arr.map(law.target.fields, (f) => {
			const x = target[f]
			if (x === undefined) {
				throw new Error(`${law.target.relation} fact without its field ${f}`)
			}
			return x
		})
		for (let k = 0; k < count; k++) {
			written.push({
				relation: law.source.relation,
				fact: pointedAt(law.source, drawnFact(host, domains, law.source.relation, values(k)), group)
			})
		}
		return insertsOf(withSupports(host, domains, before, written, values))
	}
	const drawnCount = sketch.count
	const counts = [
		drawnCount,
		...Arr.filter(
			Arr.map(indices(maxFill), (i) => i + 1),
			(n) => n !== drawnCount
		)
	]
	const isCapacity = new Set(Arr.map(capacities, (c) => c.law))
	for (const count of counts) {
		for (let draw = 0; draw < fillDraws; draw++) {
			const written = candidate(count, draw)
			const e = expect(host, state, [...ops, ...written])
			if (
				e.kind === "invariant-rejected" &&
				Arr.every(e.violations, (v) => isCapacity.has(v.law))
			) {
				return written
			}
		}
	}
	return candidate(drawnCount, 0)
}

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
	readonly refusals: Arr.NonEmptyReadonlyArray<Refused>
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
 * - a capacity's group filled past its bound (resolveFill) by one source up to maxFill;
 * - a lawful referring group from a law's need (plantedGroup), over every referring fact the domains draw, then a fact
 *   of the state deleted;
 * - a lawful fact, then a second fact of its relation inserted beside it, over every pair the domains draw, so the
 *   second may collide with the first under a key or a span key;
 * - two lawful groups of one need, then a fact deleted, so a fact the deletion leaves may meet the violator in part.
 */
export const plantedRefusal = (
	host: HostSchema,
	domains: Domains,
	reaches: (r: Refused) => boolean
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
	): Arr.NonEmptyReadonlyArray<Refused> | undefined => {
		const ops = resolveStep(host, domains, before, step)
		const e = expect(host, before, ops)
		if (e.kind !== "invariant-rejected") {
			return undefined
		}
		const [only, ...others] = e.violations
		if (only === undefined || others.length > 0) {
			return undefined
		}
		const laws = refusingLaws(host, only.law)
		if (Result.isFailure(laws)) {
			return undefined
		}
		const after = transition(host, before, ops)
		const refusal = (witness: WitnessKey | undefined): Refused => ({
			laws: laws.success,
			before,
			after,
			witness
		})
		const [named, ...rest] = only.violators
		const each: Arr.NonEmptyReadonlyArray<Refused> =
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
	/** Each stored anchor outside an obligation's selection switched into it at its key, its dependent not added. */
	const switches = function* (): Generator<PlantedSteps> {
		for (const lawful of startingStates()) {
			const state = accepted(lawful)
			if (state === undefined) {
				continue
			}
			for (const law of host.laws) {
				if (
					law.kind !== "obliged" ||
					Rec.keys(law.anchor.where).length === 0 ||
					!inDomain(law.anchor.relation, pinned(law.anchor.where))
				) {
					continue
				}
				for (const [i, a] of (state.get(law.anchor.relation) ?? []).entries()) {
					if (selected(a, law.anchor.where)) {
						continue
					}
					for (const refused of rewrites(state, law.anchor.relation, i, {
						...a,
						...pinned(law.anchor.where)
					})) {
						yield { lawful, refused }
					}
				}
			}
		}
	}
	/** Each stored dependent of an obligation moved at its key, its paired fields to other values. */
	const moves = function* (): Generator<PlantedSteps> {
		for (const lawful of startingStates()) {
			const state = accepted(lawful)
			if (state === undefined) {
				continue
			}
			for (const law of host.laws) {
				if (law.kind !== "obliged") {
					continue
				}
				const dependent = law.dependent.relation
				const key = relationOf(host, dependent).key
				for (const [i, d] of (state.get(dependent) ?? []).entries()) {
					for (const moved of domainFacts(host, domains, dependent)) {
						if (
							projection(moved, key) === projection(d, key) &&
							projection(moved, law.dependent.fields) !== projection(d, law.dependent.fields)
						) {
							for (const refused of rewrites(state, dependent, i, moved)) {
								yield { lawful, refused }
							}
						}
					}
				}
			}
		}
	}
	const capacities = Arr.filter(host.laws, (l) => l.kind === "capacity")
	const candidates = function* (): Generator<PlantedSteps> {
		for (const r of host.relations) {
			for (const fact of domainFacts(host, domains, r.name)) {
				yield { lawful: [], refused: [plantedInsert(host, domains, r.name, fact)] }
			}
		}
		for (const [i] of capacities.entries()) {
			for (let count = 0; count < maxFill; count++) {
				yield {
					lawful: [],
					refused: [
						{
							arm: "fill",
							law: pickOf(i, capacities.length),
							target: 0,
							count: count + 1,
							values: [0, 0, 0, 0, 0, 0]
						}
					]
				}
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
		yield* switches()
		yield* moves()
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

/** The first way an outcome departs from the host's expectation, if any. */
const mismatch = (
	session: Session,
	expected: Expected,
	outcome: ApplyOutcome<unknown>
): string | undefined => {
	if (expected.kind !== "invariant-rejected") {
		return outcome.kind === expected.kind
			? undefined
			: `expected ${expected.kind}, got ${Formatter.format(outcome)}`
	}
	if (outcome.kind !== "invariant-rejected") {
		return `expected a refusal by one of ${Formatter.format(Arr.map(expected.violations, (v) => v.law))}, got ${Formatter.format(outcome)}`
	}
	const law = session.reported(outcome.law)
	const violation = Arr.findFirst(expected.violations, (v) => v.law === law)
	if (Option.isNone(violation)) {
		return `refused by ${law}, which the final state does not violate; violated: ${Formatter.format(expected.violations)}`
	}
	const witness = outcome.witness
	if (violation.value.violators.length === 0) {
		return witness.kind === "unreported"
			? undefined
			: `a native violation's witness is ${Formatter.format(witness)}, where PostgreSQL leaves its key unreported`
	}
	if (witness.kind !== "key") {
		return Arr.some(session.host.laws, (l) => l.law === law && isResidual(l))
			? `a residual law's witness is ${witness.kind}; violators ${Formatter.format(violation.value.violators)}`
			: undefined
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

/** The features of an outcome: a refusal's, by the laws it names, or an accepted or unchanged outcome's kind. */
const outcomeFeatures = (
	session: Session,
	state: HostState,
	ops: ReadonlyArray<HostOp>,
	outcome: ApplyOutcome<unknown>
): Result.Result<ReadonlyArray<FamilyFeature>, string> => {
	const host = session.host
	switch (outcome.kind) {
		case "invariant-rejected":
			return Result.map(refusingLaws(host, session.reported(outcome.law)), (laws) =>
				refusalFeatures(host, {
					laws,
					before: state,
					after: transition(host, state, ops),
					witness: outcome.witness.kind === "key" ? outcome.witness : undefined
				})
			)
		case "outside-world":
			return Result.succeed([])
		case "accepted":
			return Result.succeed([
				"accepted",
				...(exemptAnchors(host, transition(host, state, ops))
					? (["accepted beside an anchor no obligation selects"] as const)
					: [])
			])
		case "no-change":
			return Result.succeed([outcome.kind])
	}
}

/**
 * Whether a state holds a fact of an obligation's anchor relation that no obligation of that relation selects: a parent
 * at a handle no arm carries, a line its selector leaves unflagged.
 */
const exemptAnchors = (host: HostSchema, state: HostState): boolean => {
	const anchors = new Set(
		Arr.flatMap(host.laws, (l) => (l.kind === "obliged" && selective(l) ? [l.anchor.relation] : []))
	)
	return Arr.some([...anchors], (relation) =>
		Arr.some(
			state.get(relation) ?? [],
			(fact) =>
				!Arr.some(
					host.laws,
					(l) =>
						l.kind === "obliged" && l.anchor.relation === relation && selected(fact, l.anchor.where)
				)
		)
	)
}

/**
 * Whether a family's schema can reach an anchor no obligation selects: a selective obligation's anchor relation, some
 * value of whose selector fields' domains no obligation of that relation selects.
 */
export const exemptReachable = (host: HostSchema, domains: Domains): boolean =>
	Arr.some(host.laws, (l) => {
		if (l.kind !== "obliged" || !selective(l)) {
			return false
		}
		const relation = l.anchor.relation
		const peers = Arr.filter(
			host.laws,
			(m): m is Extract<HostLaw, { readonly kind: "obliged" }> =>
				m.kind === "obliged" && m.anchor.relation === relation
		)
		return Arr.some(Rec.keys(l.anchor.where), (field) =>
			Arr.some(domains[relation]?.[field] ?? [], (value) =>
				Arr.every(peers, (m) => {
					const wanted = m.anchor.where[field]
					return wanted !== undefined && !Arr.some(selectorValues(wanted), (x) => x === value)
				})
			)
		)
	})

/**
 * The harness of the law-bearing generated suites: over law-bearing generated schemas, an outcome is accepted iff the
 * brute-force evaluation of every violation query on the final state is empty.
 *
 * A family (families.ts) states a schema shape whose laws, bounds, selectors and mutability are drawn from a fixed
 * space, the same schema as the host sees it (model.ts), and the typed ChangeSet of a list of enumerated members. Each
 * drawn schema installs once per test, with its residual laws, under a fresh schema name, and each case opens a grizzle
 * writer on it through Db.open and a DbLayer of its own on the substrate's database. A case is a sequence
 * of up to eight ChangeSets applied from the empty state, each resolved against the state the host expects before it,
 * so later steps delete, replace and move the facts earlier steps stored, and add facts referring to them, enough to
 * fill a group past its bound. Each step's outcome must be the host's:
 *
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
			}
			const expected = expect(session.host, state, ops)
			const outcome = yield* Effect.orDie(session.apply(ops))
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
			if (expected.kind !== "invariant-rejected") {
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
