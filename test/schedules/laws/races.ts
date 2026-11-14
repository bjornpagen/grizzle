/**
 * The generated law races of a family (raceSuite), on PostgreSQL 19rc1: every interleaving of a drawn race over a
 * schema of the family's box, from a drawn lawful state, is a history the history oracle passes
 * (test/support/history/interleave.ts lawExploration). No law is broken in the committed state, every planted writer
 * below SERIALIZABLE meets its refusal and commits nothing, every abort has a concurrent cause, and some serial order
 * respecting real time explains every outcome, refusals with their laws and witnesses included.
 *
 * Oracle: the specification, the host model of the family's laws (test/support/laws/model.ts) as a serial reference.
 * Timing is a drawn input: a race of few moves runs every order, a longer one a PCT schedule drawn on the case's tape.
 * Features: each population's required situations (its threats, writers, put forms, planted writers below
 * SERIALIZABLE, its write skew), each paired with its mode. Plant: ~/.cache/grizzle-release/BR09/plants/
 * races-alternatives-no-forward.patch, an alternatives statement expanded to its reverse containments alone, commits
 * an arm row whose parent is of another handle.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { array, type Gen, int, weighted } from "@grizzle/testing/gen"
import { pctSchedule } from "@grizzle/testing/interleave"
import { notesOnly } from "@grizzle/testing/sense"
import { fullSwarm, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Formatter, Option, String as Str } from "effect"
import { Cause, Effect, Record, type Scope } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defined } from "#test/support/assert.ts"
import { type DirectAbort, type GrizzleSettled, type Outcome } from "#test/support/history/check.ts"
import {
	enforcementProblem,
	type HistoryFamily,
	type HistoryInstall
} from "#test/support/history/families.ts"
import { type LawTxn, lawActors, lawExploration } from "#test/support/history/interleave.ts"
import {
	directOps,
	expectDirect,
	expectFor,
	type Immediacy,
	type Replacement,
	type WriterKind
} from "#test/support/history/model.ts"
import { type Mode, modeOf, type Population, populationsOf } from "#test/support/laws/boxes.ts"
import {
	emptyState,
	expect,
	type HostFact,
	type HostLaw,
	type HostState,
	needs,
	type HostOp,
	pinned,
	projection,
	relationOf,
	type HostSide,
	sameValue,
	selected,
	type HostValue
} from "#test/support/laws/model.ts"
import {
	type CaseSketch,
	caseSketchGen,
	plantedDeletion,
	resolveStep,
	stepFeatures
} from "#test/support/laws/support.ts"

import {
	type Below,
	type BelowFeature,
	belowFeaturesOf,
	belowForms
} from "#test/support/history/refused.ts"
import {
	type BelowChoice,
	belowChoiceGen,
	type HistoryEnv,
	immediacyGen
} from "#test/support/history/run.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { elementAt, nonEmptyList } from "#test/support/oracle/pick.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { pickFrom, pickGen, pickOf, pickSpan } from "#test/support/pick.ts"
import {
	every,
	exploreEnv,
	exploreInterleavings,
	type Interleaving,
	movesOf,
	type Strategy
} from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import { upTo } from "#test/support/up-to.ts"
/**
 * The threats a transaction draws, and the writers' features: each writer kind, immediate constraints, each form of a
 * direct writer's put at a fact's key (the SQL put its relation admits, or a replacement), and each choice of a planted
 * writer below SERIALIZABLE. Each list has a swarm of its own.
 */
const threatKinds = [
	"replace anchor",
	"delete anchor",
	"insert anchor",
	"insert source",
	"delete source",
	"replace source",
	"reinsert source",
	"move source",
	"retire anchor"
] as const
type ThreatKind = (typeof threatKinds)[number]

const writerFeatures = [
	"grizzle",
	"direct",
	"below",
	"immediate",
	"put",
	"replacement",
	...belowForms,
	"read only",
	"read first"
] as const
type WriterFeature = (typeof writerFeatures)[number]

/** A transaction's writer as its swarm chose it, before the race's free actors settle it (raceOf). */
type WriterChoice = "grizzle" | "direct" | "below"

const writerChoices = ["grizzle", "direct", "below"] as const

/** How a direct writer writes a fact it rewrites at its key, as its swarm chose: the SQL put, or a replacement. */
type PutForm = "put" | "replacement"

/**
 * One threat as its sketch states it: which stored source fact, or other anchor, it takes, and picks into each field's
 * domain for a fact it draws, both among what the resolver computes, and a direct writer's form for the fact it
 * rewrites at its key. Its kind is chosen among the threats that apply to the initial state, which only the resolver
 * knows, so the property draws it (resolveRaceGen).
 */
interface ThreatSketch {
	readonly pick: number
	readonly form: PutForm
	readonly values: ReadonlyArray<number>
}

/**
 * A transaction as its sketch states it: its writer, what it makes immediate when it runs direct, its threats, and its
 * level and statement when it runs below SERIALIZABLE, all as the writer swarm chose them, and the swarm the property
 * draws its threats' kinds under. Every field is drawn whatever the writer, since the race's free actors may settle
 * another.
 */
interface TxnSketch {
	readonly writer: WriterChoice
	readonly immediacy: Immediacy
	readonly threats: ReadonlyArray<ThreatSketch>
	readonly below: BelowChoice
	readonly threatSwarm: Swarm<ThreatKind>
}

interface RaceSketch {
	readonly law: number
	/** Picks into each field's domain for the anchor the initial state is seeded with. */
	readonly anchor: ReadonlyArray<number>
	/**
	 * Picks into each field's domain for the two sources the initial state is seeded with; the first also draws the
	 * facts the seed requires of them.
	 */
	readonly seed: readonly [ReadonlyArray<number>, ReadonlyArray<number>]
	readonly initial: CaseSketch
	readonly txns: ReadonlyArray<TxnSketch>
}

const sixPicks: Gen<ReadonlyArray<number>> = array(pickGen, { min: 6, max: 6 })

const threatSketchGen =
	(writers: Swarm<WriterFeature>): Gen<ThreatSketch> =>
	(source) => ({
		pick: source.draw(pickGen),
		form: source.draw(swarmChoice(writers, ["put", "replacement"])),
		values: source.draw(sixPicks)
	})

const txnSketchGen =
	(writers: Swarm<WriterFeature>): Gen<Omit<TxnSketch, "threatSwarm">> =>
	(source) => ({
		writer: source.draw(swarmChoice(writers, writerChoices)),
		immediacy: source.draw(immediacyGen(writers)),
		threats: source.draw(array(threatSketchGen(writers), { min: 1, max: 2 })),
		below: source.draw(belowChoiceGen(writers))
	})

/**
 * The full step swarm the initial state's drawn steps are drawn under: every op kind and fact mode on, since the race's
 * swarms thin its own threats and writers, never its precondition.
 */
const fullSteps = fullSwarm(stepFeatures)

/**
 * A race: its writer swarm first, which its transactions are drawn under, then its law, seed, steps and transactions,
 * and last the one threat swarm every transaction draws its threats' kinds under.
 */
const raceSketchGen: Gen<RaceSketch> = (source) => {
	const writers = source.draw(swarm(writerFeatures))
	const law = source.draw(pickGen)
	const anchor = source.draw(sixPicks)
	const seed: RaceSketch["seed"] = [source.draw(sixPicks), source.draw(sixPicks)]
	const initial = source.draw(caseSketchGen(fullSteps))
	const txns = source.draw(array(txnSketchGen(writers), { min: 2, max: 3 }))
	const threatSwarm = source.draw(swarm(threatKinds))
	return { law, anchor, seed, initial, txns: Arr.map(txns, (x) => ({ ...x, threatSwarm })) }
}

/**
 * A race case: the family's schema it runs on, by its index among them, and its race. A race of more moves than every
 * interleaving can cover draws its PCT schedule in the property, once its transactions are known.
 */
interface RaceCase {
	readonly variant: number
	readonly race: RaceSketch
}

/** A law's two sides: the anchor the race threatens, and the facts that refer to it. */
interface Threatened {
	readonly law: LawId
	readonly anchor: HostSide
	readonly source: HostSide
}

/** The sides a race threatens of a law: none of a key or a row check, which no fact refers to. */
const threatened = (law: HostLaw): ReadonlyArray<Threatened> => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
			return []
		case "contained":
			return [{ law: law.law, anchor: law.target, source: law.source }]
		case "covered":
			return [
				{
					law: law.law,
					anchor: { ...law.target, fields: [...law.target.fields, law.span.target] },
					source: { ...law.source, fields: [...law.source.fields, law.span.source] }
				}
			]
	}
}

/**
 * What a race's resolve reads of its installation: the host model, each relation's mutability among it, and the drawn
 * domains; never a connection.
 */
type RaceModel = Pick<HistoryEnv, "host" | "domains">

/** The most facts a seed closes over: a closure past it is a defect of a family's laws. */
const seedBound = 32

/** A fact of a seed, by its relation. */
interface Placed {
	readonly relation: string
	readonly fact: HostFact
}

/**
 * `facts` with every fact the schema's needs require of them, transitively: for each need no fact present meets, a fact
 * of the referred side pointed at the referring fact, its other fields drawn from `values`.
 */
const supported = (
	env: RaceModel,
	facts: ReadonlyArray<Placed>,
	values: ReadonlyArray<number>
): ReadonlyArray<Placed> => {
	const all = [...facts]
	for (const { relation, fact } of all) {
		if (all.length > seedBound) {
			throw new Error(`a seed of more than ${seedBound} facts: the family's needs cycle`)
		}
		for (const { from, to } of Arr.flatMap(env.host.laws, needs)) {
			if (from.relation !== relation || !selected(fact, from.selection)) {
				continue
			}
			const at = Arr.map(from.fields, (f) => defined(fact[f], `the seed fact's ${f}`))
			const met = Arr.some(
				all,
				(p) =>
					p.relation === to.relation &&
					selected(p.fact, to.selection) &&
					Arr.every(to.fields, (f, j) => sameValue(p.fact[f], at[j]))
			)
			if (!met) {
				all.push({
					relation: to.relation,
					fact: pointedAt(to, drawnFact(env, to.relation, values), at)
				})
			}
		}
	}
	return all
}

/**
 * The stored facts the anchor's retirement takes with it, the anchor first: every stored fact one of whose needs
 * only facts already going meet, transitively (the reverse of `supported`, over the same needs).
 */
const retired = (env: RaceModel, state: HostState, anchor: Placed): ReadonlyArray<Placed> => {
	const stored = Arr.flatMap([...state], ([relation, facts]) =>
		Arr.map(facts, (fact): Placed => ({ relation, fact }))
	)
	const going: Array<Placed> = [anchor]
	const isGoing = (p: Placed) =>
		Arr.some(going, (g) => g.relation === p.relation && sameKey(env, p.relation, g.fact, p.fact))
	const orphaned = (p: Placed): boolean =>
		Arr.some(Arr.flatMap(env.host.laws, needs), ({ from, to }) => {
			if (from.relation !== p.relation || !selected(p.fact, from.selection)) {
				return false
			}
			const at = Arr.map(from.fields, (f) => defined(p.fact[f], `the stored fact's ${f}`))
			const meeting = Arr.filter(
				stored,
				(q) =>
					q.relation === to.relation &&
					selected(q.fact, to.selection) &&
					Arr.every(to.fields, (f, j) => sameValue(q.fact[f], at[j]))
			)
			return meeting.length > 0 && Arr.every(meeting, isGoing)
		})
	for (let grew = true; grew;) {
		grew = false
		for (const p of stored) {
			if (!isGoing(p) && orphaned(p)) {
				going.push(p)
				grew = true
			}
		}
	}
	return going
}

/**
 * The k-th redraw of picks: the drawn ones at k = 0, then each pick strided by a multiple of its own place, so the
 * fields of one fact move apart through their domains.
 */
const seedRedraws = 64
const seedStride = 40_503
const strided = (picks: ReadonlyArray<number>, k: number): ReadonlyArray<number> =>
	Arr.map(picks, (p, i) => (p + k * (i + 1) * seedStride) % pickSpan)

const sameKey = (env: RaceModel, relation: string, a: HostFact, b: HostFact): boolean =>
	Arr.every(relationOf(env.host, relation).key, (k) => sameValue(a[k], b[k]))

/** A fact of `relation` drawn from its fields' domains. */
const drawnFact = (
	env: RaceModel,
	relation: string,
	values: ReadonlyArray<number>
): Record<string, HostValue> =>
	Record.fromEntries(
		Arr.map(relationOf(env.host, relation).fields, (f, i) => {
			const [first, ...rest] = defined(
				env.domains[relation]?.[f.name],
				`the domain of ${relation}.${f.name}`
			)
			if (first === undefined) {
				throw new Error(`an empty domain for ${relation}.${f.name}`)
			}
			return [
				f.name,
				pickFrom(
					[first, ...rest],
					defined(values[i % values.length], `a pick for ${relation}.${f.name}`)
				)
			]
		})
	)

/**
 * A fact of the side's relation drawn from `values` at another key than `first`: its first key field the side leaves
 * free (neither pointed at the anchor nor fixed by the side's selector) is drawn from that field's domain without
 * `first`'s value. A side that fixes its relation's whole key holds one fact per anchor: its fact is drawn as is.
 */
const apart = (
	env: RaceModel,
	side: HostSide,
	first: HostFact,
	values: ReadonlyArray<number>
): HostFact => {
	const fact = drawnFact(env, side.relation, values)
	const relation = relationOf(env.host, side.relation)
	const fixed = (field: string) => side.fields.includes(field) || field in pinned(side.selection)
	const free = Arr.findFirstWithIndex(
		relation.fields,
		(f) => relation.key.includes(f.name) && !fixed(f.name)
	)
	if (Option.isNone(free)) {
		return fact
	}
	const [field, i] = free.value
	const domain = defined(
		env.domains[side.relation]?.[field.name],
		`the domain of ${side.relation}.${field.name}`
	)
	const [other, ...others] = Arr.filter(domain, (v) => !sameValue(v, first[field.name]))
	if (other === undefined) {
		throw new Error(
			`${side.relation}.${field.name}'s domain holds one value: no second source at another key`
		)
	}
	fact[field.name] = pickFrom(
		[other, ...others],
		defined(values[i % values.length], `a pick for ${side.relation}.${field.name}`)
	)
	return fact
}

/** `fact` with its fields outside the key redrawn. */
const redrawn = (
	env: RaceModel,
	relation: string,
	fact: HostFact,
	values: ReadonlyArray<number>
): HostFact => {
	const fresh = drawnFact(env, relation, values)
	for (const k of relationOf(env.host, relation).key) {
		const x = fact[k]
		if (x !== undefined) {
			fresh[k] = x
		}
	}
	return fresh
}

/** `fact` pointed at the anchor values `at`: its side's fields set to them, and its side's selector applied. */
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

/**
 * What one threat writes: host operations, or a stored fact rewritten at its own key, which each writer applies in its
 * form (writtenBy).
 */
type Written =
	| { readonly kind: "ops"; readonly ops: ReadonlyArray<HostOp> }
	| {
			readonly kind: "rewrite"
			readonly relation: string
			readonly old: HostFact
			readonly next: HostFact
	  }

const written = (ops: ReadonlyArray<HostOp>): Written => ({ kind: "ops", ops })

/**
 * A fact replaced: at its own key, a rewrite; moved to another key, a put on a `mutable` relation, and on an immutable
 * one its deletion and the insertion there (see the header).
 */
const replace = (env: RaceModel, relation: string, old: HostFact, next: HostFact): Written =>
	sameKey(env, relation, old, next)
		? { kind: "rewrite", relation, old, next }
		: written(
				relationOf(env.host, relation).mutable
					? [{ relation, kind: "put", facts: [next] }]
					: [
							{ relation, kind: "delete", facts: [old] },
							{ relation, kind: "insert", facts: [next] }
						]
			)

const sameFact = (env: RaceModel, relation: string, a: HostFact, b: HostFact): boolean =>
	Arr.every(relationOf(env.host, relation).fields, (f) => sameValue(a[f.name], b[f.name]))

/**
 * What a writer runs for a threat's writing: its operations, a rewrite as a put, and for a direct writer the facts it
 * replaces. A grizzle writer puts a rewrite through its put protocol whatever the relation's mutability; a direct
 * writer puts it as an upsert or, on an immutable relation, an insertion at the key (directOps), or, in the form its
 * swarm chose when the payload changes, replaces it: the old fact's deletion, then the new one's insertion.
 */
interface Writing {
	readonly ops: ReadonlyArray<HostOp>
	readonly replacements: ReadonlyArray<Replacement>
}

const writtenBy = (env: RaceModel, writer: WriterKind, w: Written, form: PutForm): Writing => {
	if (w.kind === "ops") {
		return { ops: w.ops, replacements: [] }
	}
	const put: Writing = {
		ops: [{ relation: w.relation, kind: "put", facts: [w.next] }],
		replacements: []
	}
	if (writer === "grizzle" || sameFact(env, w.relation, w.old, w.next)) {
		return put
	}
	return form === "replacement"
		? { ops: [], replacements: [{ relation: w.relation, old: w.old, next: w.next }] }
		: put
}

/**
 * What the initial state holds around the anchor: the anchor's values at its law's fields, the fact stored at the
 * anchor's key or none, and the sources at the anchor and at other anchors.
 */
interface Standing {
	/** The initial state the standing is read from. */
	readonly state: HostState
	readonly anchor: HostFact
	readonly at: ReadonlyArray<HostValue>
	readonly held: { readonly kind: "stored"; readonly fact: HostFact } | { readonly kind: "absent" }
	readonly linked: ReadonlyArray<HostFact>
	readonly elsewhere: ReadonlyArray<HostFact>
}

const heldAt = (fact: Option.Option<HostFact>): Standing["held"] =>
	Option.match(fact, {
		onNone: () => ({ kind: "absent" }),
		onSome: (stored) => ({ kind: "stored", fact: stored })
	})

const standingOf = (
	env: RaceModel,
	t: Threatened,
	state: HostState,
	anchor: HostFact,
	at: ReadonlyArray<HostValue>
): Standing => {
	/** A host state holds every relation of its schema. */
	const anchors = defined(state.get(t.anchor.relation), `the state's ${t.anchor.relation} facts`)
	const sources = defined(state.get(t.source.relation), `the state's ${t.source.relation} facts`)
	const isLinked = (f: HostFact) =>
		Arr.every(t.source.fields, (field, i) => sameValue(f[field], at[i]))
	return {
		state,
		anchor,
		at,
		held: heldAt(Arr.findFirst(anchors, (f) => sameKey(env, t.anchor.relation, f, anchor))),
		linked: Arr.filter(sources, isLinked),
		elsewhere: Arr.filter(sources, (f) => !isLinked(f))
	}
}

/**
 * The threats that take effect from the initial state: inserting a source or the anchor always does, and the others
 * need the stored fact they replace, delete, insert again or move. "insert source" is the floor.
 */
const applicableThreats = (standing: Standing): Arr.NonEmptyReadonlyArray<ThreatKind> => [
	"insert source",
	"insert anchor",
	...(standing.held.kind === "absent"
		? []
		: (["replace anchor", "delete anchor", "retire anchor"] as const)),
	...(standing.linked.length > 0
		? (["delete source", "replace source", "reinsert source"] as const)
		: []),
	...(standing.linked.length + standing.elsewhere.length > 0 ? (["move source"] as const) : [])
]

/** What one threat to the anchor writes from the initial state; an applicable threat writes at least one fact. */
const threatOps = (
	env: RaceModel,
	t: Threatened,
	standing: Standing,
	kind: ThreatKind,
	sketch: ThreatSketch
): Written => {
	const anchorRelation = t.anchor.relation
	const sourceRelation = t.source.relation
	const { anchor, at, held, linked, elsewhere } = standing
	const one = (facts: ReadonlyArray<HostFact>): HostFact | undefined => {
		const [first, ...rest] = facts
		return first === undefined ? undefined : pickFrom([first, ...rest], sketch.pick)
	}
	switch (kind) {
		case "replace anchor":
			return held.kind === "absent"
				? written([])
				: replace(
						env,
						anchorRelation,
						held.fact,
						redrawn(env, anchorRelation, held.fact, sketch.values)
					)
		case "delete anchor":
			return written(
				held.kind === "absent"
					? []
					: [{ relation: anchorRelation, kind: "delete", facts: [held.fact] }]
			)
		case "insert anchor":
			return written([
				{
					relation: anchorRelation,
					kind: "insert",
					facts: [held.kind === "stored" ? held.fact : anchor]
				}
			])
		case "insert source":
			return written([
				{
					relation: sourceRelation,
					kind: "insert",
					facts: [pointedAt(t.source, drawnFact(env, sourceRelation, sketch.values), at)]
				}
			])
		case "delete source": {
			const f = one(linked)
			return written(
				f === undefined ? [] : [{ relation: sourceRelation, kind: "delete", facts: [f] }]
			)
		}
		case "reinsert source": {
			/**
			 * The stored source the same pick deletes, inserted again exactly: beside its deletion, a deletion and a
			 * concurrent insertion at one key.
			 */
			const f = one(linked)
			return written(
				f === undefined ? [] : [{ relation: sourceRelation, kind: "insert", facts: [f] }]
			)
		}
		case "replace source": {
			const f = one(linked)
			return f === undefined
				? written([])
				: replace(
						env,
						sourceRelation,
						f,
						pointedAt(t.source, redrawn(env, sourceRelation, f, sketch.values), at)
					)
		}
		case "move source": {
			/** From another anchor to this one, or, when every source fact is here, away to another key. */
			const from = one(elsewhere)
			if (from !== undefined) {
				return replace(env, sourceRelation, from, pointedAt(t.source, from, at))
			}
			const away = one(linked)
			if (away === undefined) {
				return written([])
			}
			const other = drawnFact(env, sourceRelation, sketch.values)
			return replace(
				env,
				sourceRelation,
				away,
				pointedAt(
					t.source,
					away,
					Arr.map(t.source.fields, (f) => defined(other[f], `the other source's ${f}`))
				)
			)
		}
		case "retire anchor":
			return written(
				held.kind === "absent"
					? []
					: Arr.map(
							Arr.reverse(
								retired(env, standing.state, { relation: anchorRelation, fact: held.fact })
							),
							(p): HostOp => ({ relation: p.relation, kind: "delete", facts: [p.fact] })
						)
			)
	}
}

/** The writers a race's transactions run as, the grizzle ones first; a planted writer plays a direct actor. */
const grizzleActors = ["g", "h"] as const
const directActors = ["a", "b", "c"] as const

/**
 * What a race's threats make of its anchor's facts by construction, read from the host model: a source moved out of
 * the anchor's group, a fact taken out of its law's selection, one transaction's deletion beside another's insertion
 * at one key of the anchor's relation or the source's, and the first two transactions each lawful alone from the
 * initial state and refused after the other in either order, a write skew SSI must break.
 */
type RaceShape =
	| "moved out of the anchor's group"
	| "moved out of a selection"
	| "a deletion beside an insertion at the anchor's key"
	| "a deletion beside an insertion at a source's key"
	| "write skew"

interface Resolved {
	readonly law: LawId
	readonly initial: HostState
	readonly txns: ReadonlyArray<LawTxn>
	/** The threats each transaction applies; a planted writer's applies none. */
	readonly threats: ReadonlyArray<ReadonlyArray<ThreatKind>>
	/** The threats that apply to the initial state, in the order the threat swarm chooses among them. */
	readonly applicable: Arr.NonEmptyReadonlyArray<ThreatKind>
	/** The sessions of the direct transactions that replace a fact. */
	readonly replacing: ReadonlySet<string>
	readonly shapes: ReadonlySet<RaceShape>
}

/**
 * What a race threatens: its law's sides, the initial state around the seeded anchor, and the threats that apply to it.
 */
interface Seeded {
	readonly t: Threatened
	readonly standing: Standing
	readonly applicable: Arr.NonEmptyReadonlyArray<ThreatKind>
}

/**
 * The law a sketch picks on the model `env` and its initial state, folding the initial state's drawn steps on the seed.
 */
const seededRace = (
	env: RaceModel,
	sketch: Pick<RaceSketch, "law" | "anchor" | "seed" | "initial">
): Seeded => {
	const laws = Arr.flatMap(env.host.laws, threatened)
	const [firstLaw, ...otherLaws] = laws
	if (firstLaw === undefined) {
		throw new Error("the family's schema has no law a race can threaten")
	}
	const t = pickFrom([firstLaw, ...otherLaws], sketch.law)
	/** The precondition, seeded by construction (see the header): the first lawful seed, most sources first. */
	const [firstSeed, secondSeed] = sketch.seed
	const seedAt = (n: 0 | 1 | 2, k: number) => {
		/** The anchor points at nothing: its side's selector applied to its drawn fact. */
		const anchor: HostFact = {
			...drawnFact(env, t.anchor.relation, strided(sketch.anchor, k)),
			...pinned(t.anchor.selection)
		}
		const at = Arr.map(t.anchor.fields, (f) => defined(anchor[f], `the seeded anchor's ${f}`))
		const source = (fact: HostFact): Placed => ({
			relation: t.source.relation,
			fact: pointedAt(t.source, fact, at)
		})
		const first = source(drawnFact(env, t.source.relation, strided(firstSeed, k)))
		const sources =
			n === 0
				? []
				: n === 1
					? [first]
					: [first, source(apart(env, t.source, first.fact, strided(secondSeed, k)))]
		const ops = Arr.map(
			supported(
				env,
				[{ relation: t.anchor.relation, fact: anchor }, ...sources],
				strided(firstSeed, k + 1)
			),
			(p): HostOp => ({ relation: p.relation, kind: "insert", facts: [p.fact] })
		)
		return { anchor, at, expected: expect(env.host, emptyState(env.host), ops) }
	}
	const seed = () => {
		const attempts = Arr.flatMap([2, 1, 0] as const, (n) =>
			Arr.makeBy(seedRedraws, (k) => ({ n, k }))
		)
		for (const { n, k } of attempts) {
			const s = seedAt(n, k)
			if (s.expected.kind === "accepted" || s.expected.kind === "no-change") {
				return { anchor: s.anchor, at: s.at, state: s.expected.state }
			}
		}
		throw new Error(
			`no seed of ${t.law} (its anchor with 2, 1 or 0 sources and the facts they need) is lawful: a defect of the race generator`
		)
	}
	const { anchor, at, state } = seed()
	let initial = state
	for (const step of sketch.initial) {
		const e = expect(env.host, initial, resolveStep(env.host, env.domains, initial, step))
		if (e.kind === "accepted" || e.kind === "no-change") {
			initial = e.state
		}
	}
	const standing = standingOf(env, t, initial, anchor, at)
	return { t, standing, applicable: applicableThreats(standing) }
}

/** The fact a planted writer's statement names: the first fact its first threat writes, or the anchor. */
const belowTarget = (
	t: Threatened,
	standing: Standing,
	w: Written | undefined
): { readonly relation: string; readonly fact: HostFact } => {
	if (w?.kind === "rewrite") {
		return { relation: w.relation, fact: w.next }
	}
	const [op] = w?.ops ?? []
	const [fact] = op?.facts ?? []
	return op === undefined || fact === undefined
		? { relation: t.anchor.relation, fact: standing.anchor }
		: { relation: op.relation, fact }
}

/**
 * The shapes one applied threat gives (RaceShape): a source moved away when no source stands elsewhere, and a rewrite
 * whose fact its side selected and its new payload does not.
 */
const threatShapes = (
	t: Threatened,
	standing: Standing,
	kind: ThreatKind,
	w: Written
): ReadonlyArray<RaceShape> => {
	if (kind === "move source" && standing.elsewhere.length === 0) {
		return ["moved out of the anchor's group"]
	}
	if (w.kind !== "rewrite") {
		return []
	}
	const side = kind === "replace anchor" ? t.anchor : t.source
	return selected(w.old, side.selection) && !selected(w.next, side.selection)
		? ["moved out of a selection"]
		: []
}

/** Whether two transactions are a write skew from `initial`: each lawful alone, each refused after the other. */
const writeSkew = (
	env: RaceModel,
	initial: HostState,
	one: LawTxn | undefined,
	two: LawTxn | undefined
): boolean => {
	if (one === undefined || two === undefined || one.kind === "below" || two.kind === "below") {
		return false
	}
	const first = expectFor(one.kind, env.host, initial, one.ops)
	const second = expectFor(two.kind, env.host, initial, two.ops)
	return (
		(first.kind === "accepted" || first.kind === "no-change") &&
		(second.kind === "accepted" || second.kind === "no-change") &&
		expectFor(two.kind, env.host, first.state, two.ops).kind === "invariant-rejected" &&
		expectFor(one.kind, env.host, second.state, one.ops).kind === "invariant-rejected"
	)
}

/** The relations and keys a transaction deletes at, or inserts or puts at; a planted writer's none. */
const keysAt = (env: RaceModel, x: LawTxn, deletes: boolean): ReadonlyArray<string> => {
	if (x.kind === "below") {
		return []
	}
	const ops = Arr.filter(x.ops, (o) => (o.kind === "delete") === deletes)
	return Arr.flatMap(ops, (o) =>
		Arr.map(o.facts, (f) => `${o.relation} ${projection(f, relationOf(env.host, o.relation).key)}`)
	)
}

/** The shapes of one transaction's deletion beside another's insertion at one key (RaceShape). */
const meetingShapes = (
	env: RaceModel,
	t: Threatened,
	txns: ReadonlyArray<LawTxn>
): ReadonlyArray<RaceShape> =>
	Arr.flatMap(txns, (x) =>
		Arr.flatMap(txns, (y): ReadonlyArray<RaceShape> => {
			if (x === y) {
				return []
			}
			const inserted = new Set(keysAt(env, y, false))
			const met = Arr.filter(keysAt(env, x, true), (k) => inserted.has(k))
			return Arr.flatMap(met, (k): ReadonlyArray<RaceShape> =>
				Str.startsWith(`${t.anchor.relation} `)(k)
					? ["a deletion beside an insertion at the anchor's key"]
					: Str.startsWith(`${t.source.relation} `)(k)
						? ["a deletion beside an insertion at a source's key"]
						: []
			)
		})
	)

/**
 * The race a sketch makes on the model `env`, from its seeded law and initial state, each transaction applying the
 * threats `kinds` names for it, in order, one kind for each of its threat sketches.
 */
const raceOf = (
	env: RaceModel,
	sketch: RaceSketch,
	seeded: Seeded,
	kinds: ReadonlyArray<ReadonlyArray<ThreatKind>>
): Resolved => {
	const { t, standing, applicable } = seeded
	let grizzles = 0
	let directs = 0
	const threats: Array<ReadonlyArray<ThreatKind>> = []
	const replacing = new Set<string>()
	const shapes = new Set<RaceShape>()
	const txns = Arr.map(sketch.txns, (x, i): LawTxn => {
		const chosen = Arr.map(
			Arr.zip(x.threats, defined(kinds[i], `the threats of transaction ${i}`)),
			([th, kind]) => ({ kind, sketch: th })
		)
		const writings = Arr.map(chosen, (c) => ({
			kind: c.kind,
			written: threatOps(env, t, standing, c.kind, c.sketch),
			form: c.sketch.form
		}))
		const applied = () => {
			threats.push(Arr.map(chosen, (c) => c.kind))
			for (const w of writings) {
				for (const s of threatShapes(t, standing, w.kind, w.written)) {
					shapes.add(s)
				}
			}
		}
		const kind = x.writer
		const grizzle = grizzleActors[grizzles]
		const direct = directActors[directs]
		if (grizzle !== undefined && (kind === "grizzle" || direct === undefined)) {
			grizzles++
			applied()
			const ops = Arr.flatMap(writings, (w) => writtenBy(env, "grizzle", w.written, w.form).ops)
			return { kind: "grizzle", session: grizzle, writer: grizzle, ops, after: undefined }
		}
		if (direct === undefined) {
			throw new Error("a race has at most three transactions")
		}
		directs++
		if (kind === "below") {
			threats.push([])
			const target = belowTarget(t, standing, writings[0]?.written)
			const choice = x.below
			const below: Below =
				choice.kind === "read only"
					? { kind: "read only", level: choice.level, relation: target.relation }
					: { kind: "write", level: choice.level, form: choice.form, ...target, read: choice.read }
			return { kind: "below", session: direct, writer: direct, below, after: undefined }
		}
		applied()
		const done = Arr.map(writings, (w) => writtenBy(env, "direct", w.written, w.form))
		const replacements = Arr.flatMap(done, (w) => w.replacements)
		if (replacements.length > 0) {
			replacing.add(direct)
		}
		return {
			kind: "direct",
			immediate: x.immediacy,
			session: direct,
			writer: direct,
			ops: directOps(
				env.host,
				Arr.flatMap(done, (w) => w.ops),
				replacements
			),
			after: undefined
		}
	})
	for (const shape of meetingShapes(env, t, txns)) {
		shapes.add(shape)
	}
	const [one, two] = txns
	if (writeSkew(env, standing.state, one, two)) {
		shapes.add("write skew")
	}
	return { law: t.law, initial: standing.state, txns, threats, applicable, replacing, shapes }
}

/**
 * The race a sketch draws on the model `env`: each threat's kind drawn on the case's tape among the threats that apply
 * to its initial state, as its transaction's threat swarm weighs them, transaction by transaction.
 */
const resolveRaceGen =
	(env: RaceModel, sketch: RaceSketch): Gen<Resolved> =>
	(source) => {
		const seeded = seededRace(env, sketch)
		const kinds = Arr.map(sketch.txns, (x) =>
			Arr.map(x.threats, () => source.draw(swarmChoice(x.threatSwarm, seeded.applicable)))
		)
		return raceOf(env, sketch, seeded, kinds)
	}

const zeros: ReadonlyArray<number> = [0, 0, 0, 0, 0, 0]

/**
 * A planted transaction's statement below SERIALIZABLE, as the full writer swarm's first choices make it: an insertion
 * at the lowest level, reading first. A transaction that runs another writer never reads it.
 */
const plantedBelow: BelowChoice = {
	kind: "write",
	level: "read uncommitted",
	form: "insert",
	read: true
}

/**
 * A planted transaction as `writer`: one threat, in `form`, drawing a fact by `values`, its kind drawn under
 * `threatSwarm`, making every constraint immediate.
 */
const plantedTxn = (
	writer: WriterChoice,
	form: PutForm,
	values: ReadonlyArray<number>,
	threatSwarm: Swarm<ThreatKind>
): TxnSketch => ({
	writer,
	immediacy: "every constraint",
	threats: [{ pick: 0, form, values }],
	below: plantedBelow,
	threatSwarm
})

/** A planted race's sketch on the `law`th threatened law: its seed at the first picks, and its transactions. */
const plantedSketch = (
	law: number,
	initial: CaseSketch,
	txns: ReadonlyArray<TxnSketch>
): RaceSketch => ({ law, anchor: zeros, seed: [zeros, zeros], initial, txns })

/**
 * The initial states a planted search tries on a law: the seeded one, it with one of its sources deleted, and it with
 * every source at the anchor deleted and then the anchor, each a case sketch the seeded state folds; a step the host
 * refuses leaves the state as it was, and the search reads the standing it reaches.
 */
const plantedInitials = (env: RaceModel, law: number): ReadonlyArray<CaseSketch> => {
	const base = seededRace(env, plantedSketch(law, [], []))
	const sources = defined(base.standing.state.get(base.t.source.relation), "the seed's sources")
	const anchors = defined(base.standing.state.get(base.t.anchor.relation), "the seed's anchors")
	const anchorAt = Arr.findFirstIndex(anchors, (f) =>
		sameKey(env, base.t.anchor.relation, f, base.standing.anchor)
	)
	const each = Arr.map(indices(sources.length), (i): CaseSketch => [
		[plantedDeletion(env.host, base.t.source.relation, i, sources.length)]
	])
	const linked = base.standing.linked.length
	const emptied: CaseSketch = [
		...Arr.map(indices(linked), (k): CaseSketch[number] => [
			plantedDeletion(env.host, base.t.source.relation, 0, sources.length - k)
		]),
		...Option.toArray(
			Option.map(anchorAt, (at): CaseSketch[number] => [
				plantedDeletion(env.host, base.t.anchor.relation, at, anchors.length)
			])
		)
	]
	return [[], ...each, emptied]
}

/**
 * The pairs of threats, a grizzle writer's and then a direct writer's at `redraw`'s payload, that make a write skew
 * from `initial` on `law`: each lawful alone and each refused after the other, as the host model judges them.
 */
const skewPairs = (
	env: RaceModel,
	law: number,
	initial: CaseSketch,
	redraw: number
): ReadonlyArray<readonly [ThreatKind, ThreatKind]> => {
	const { t, standing, applicable } = seededRace(env, plantedSketch(law, initial, []))
	const threat = (kind: ThreatKind, values: ReadonlyArray<number>) =>
		threatOps(env, t, standing, kind, { pick: 0, form: "put", values })
	return Arr.flatMap(applicable, (grizzleThreat) => {
		const grizzle: LawTxn = {
			kind: "grizzle",
			writer: "g",
			session: "g",
			ops: writtenBy(env, "grizzle", threat(grizzleThreat, zeros), "put").ops,
			after: undefined
		}
		return Arr.flatMap(
			applicable,
			(directThreat): ReadonlyArray<readonly [ThreatKind, ThreatKind]> => {
				const writing = writtenBy(
					env,
					"direct",
					threat(directThreat, strided(zeros, redraw)),
					"put"
				)
				const direct: LawTxn = {
					kind: "direct",
					writer: "a",
					session: "a",
					immediate: "deferred",
					ops: directOps(env.host, writing.ops, writing.replacements),
					after: undefined
				}
				return writeSkew(env, standing.state, grizzle, direct)
					? [[grizzleThreat, directThreat]]
					: []
			}
		)
	})
}

/** A start that makes a write skew: a schema, a threatened law, a planted initial state, a redraw and the two threats. */
interface SkewStart {
	readonly variant: number
	readonly law: number
	readonly initial: CaseSketch
	readonly redraw: number
	readonly threats: readonly [ThreatKind, ThreatKind]
}

/**
 * Every start of a family's schemas that makes a write skew, as the host model judges it: over each schema, each law
 * its races threaten, each planted initial state of the law and each strided redraw of the direct writer's payload, the
 * pairs of threats skewPairs finds. Computed once, when the suite is built.
 */
const skewStartsOf = <P>(
	h: HistoryFamily<P>,
	variants: ReadonlyArray<P>
): ReadonlyArray<SkewStart> =>
	Arr.flatMap(variants, (p, variant) => {
		const env: RaceModel = { host: h.family.host(p), domains: h.family.domains }
		const laws = Arr.flatMap(env.host.laws, threatened).length
		return Arr.flatMap(
			upTo(laws, (l) => pickOf(l, laws)),
			(law) =>
				Arr.flatMap(plantedInitials(env, law), (initial) =>
					Arr.flatMap(
						Arr.makeBy(writeSkewRedraws, (redraw) => redraw),
						(redraw) =>
							Arr.map(skewPairs(env, law, initial, redraw), (threats): SkewStart => ({
								variant,
								law,
								initial,
								redraw,
								threats
							}))
					)
				)
		)
	})

/**
 * A race case shaped for a write skew: a start drawn among those that make one, a grizzle writer's put against a direct
 * writer's at the start's redraw, each transaction's threat swarm holding its own threat of the start alone, so the
 * race is the start's write skew by construction.
 */
const skewCaseGen =
	(starts: Arr.NonEmptyReadonlyArray<SkewStart>): Gen<RaceCase> =>
	(source) => {
		const start = elementAt(starts, source.draw(int(0, starts.length - 1)), "the write skews")
		return {
			variant: start.variant,
			race: plantedSketch(start.law, start.initial, [
				plantedTxn("grizzle", "put", zeros, fullSwarm([start.threats[0]])),
				plantedTxn("direct", "put", strided(zeros, start.redraw), fullSwarm([start.threats[1]]))
			])
		}
	}

/**
 * A start that opens a replacement's window: a schema, a threatened law, a planted initial state that stores the
 * anchor, and the strided redraw of the anchor's payload a direct writer's replacement writes, which changes the anchor
 * and which the host model accepts from that state.
 */
interface WindowStart {
	readonly variant: number
	readonly law: number
	readonly initial: CaseSketch
	readonly redraw: number
}

/**
 * Every start of `variants`, one mode's schemas, that opens a replacement's window: over each schema, each law its
 * races threaten, each planted initial state that stores the anchor and each strided redraw of the anchor's payload,
 * the direct writer's replacement of the anchor that changes it and that the host model accepts from that state.
 * Computed once, when the suite is built: the planted replacement is the first, and the window arm draws among them.
 */
const windowStartsOf = <P>(
	h: HistoryFamily<P>,
	variants: Arr.NonEmptyReadonlyArray<P>
): Arr.NonEmptyReadonlyArray<WindowStart> => {
	const starts = Arr.flatMap(variants, (p, variant) => {
		const env: RaceModel = { host: h.family.host(p), domains: h.family.domains }
		const laws = Arr.flatMap(env.host.laws, threatened).length
		return Arr.flatMap(
			upTo(laws, (l) => pickOf(l, laws)),
			(law) =>
				Arr.flatMap(plantedInitials(env, law), (initial) => {
					const { t, standing, applicable } = seededRace(env, plantedSketch(law, initial, []))
					if (!applicable.includes("replace anchor")) {
						return []
					}
					return Arr.flatMap(
						Arr.makeBy(seedRedraws, (redraw) => redraw),
						(redraw): ReadonlyArray<WindowStart> => {
							const w = threatOps(env, t, standing, "replace anchor", {
								pick: 0,
								form: "replacement",
								values: strided(zeros, redraw)
							})
							const [replacement] = writtenBy(env, "direct", w, "replacement").replacements
							return replacement !== undefined &&
								expectDirect(env.host, standing.state, directOps(env.host, [], [replacement]))
									.kind === "accepted"
								? [{ variant, law, initial, redraw }]
								: []
						}
					)
				})
		)
	})
	if (!Arr.isReadonlyArrayNonEmpty(starts)) {
		throw new Error(
			`no law of a ${modeOf(h.family.host(Arr.headNonEmpty(variants)))} schema of ${h.family.label} has an anchor a direct writer can replace`
		)
	}
	return starts
}

/**
 * A race case shaped for a replacement's window, reaching it by construction: a mode drawn, then one of its window
 * starts (windowStartsOf). A direct writer replaces the anchor at the start's redraw, the anchor's replacement the one
 * threat its swarm holds, against a grizzle writer whose payload is drawn and whose threat is drawn between a source's
 * insertion at the anchor and the anchor's own replacement. The race makes at most seven moves, so it is explored in
 * every interleaving, one of which issues the grizzle writer's step between the replacement's deletion and its
 * insertion.
 */
const windowCaseGen =
	(modes: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<WindowStart>>): Gen<RaceCase> =>
	(source) => {
		const starts = elementAt(modes, source.draw(int(0, modes.length - 1)), "the modes' windows")
		const start = elementAt(starts, source.draw(int(0, starts.length - 1)), "a mode's windows")
		return {
			variant: start.variant,
			race: plantedSketch(start.law, start.initial, [
				plantedTxn(
					"direct",
					"replacement",
					strided(zeros, start.redraw),
					fullSwarm<ThreatKind>(["replace anchor"])
				),
				plantedTxn(
					"grizzle",
					"put",
					source.draw(sixPicks),
					fullSwarm<ThreatKind>(["insert source", "replace anchor"])
				)
			])
		}
	}

/** A race case on a drawn schema, its race drawn by `race`. */
const onDrawnSchema =
	(variants: number, race: Gen<RaceSketch>): Gen<RaceCase> =>
	(source) => ({ variant: source.draw(int(0, variants - 1)), race: source.draw(race) })

/**
 * Race cases over `variants` schemas: a drawn race six times in eight, once a race shaped for a replacement's window
 * in a drawn mode, and once a race from a start that makes a write skew, where the family has one; a drawn race of free
 * writers and threats seldom is either.
 */
const raceCaseGen = (
	variants: number,
	windows: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<WindowStart>>,
	skews: ReadonlyArray<SkewStart>
): Gen<RaceCase> =>
	weighted([
		[6, onDrawnSchema(variants, raceSketchGen)],
		[1, windowCaseGen(windows)],
		[
			1,
			Arr.isReadonlyArrayNonEmpty(skews)
				? skewCaseGen(skews)
				: onDrawnSchema(variants, raceSketchGen)
		]
	])

/** The strided redraws of the direct writer's payload a write skew's search tries (skewStartsOf). */
const writeSkewRedraws = 8

/** The races whose interleavings are explored to the last one: those of at most this many moves. */
const exhaustiveMoves = 7

const runsPerTest = 30

/**
 * What a race case notes: each threat it draws (and the first two transactions' threats as a pair), each shape its
 * threats give, a direct replacement, a step issued between a replacement's deletion and its insertion, a lock wait, a
 * deadlock PostgreSQL broke (and one broken while another session could move), the strategy, every recorded outcome
 * and abort cause, each planted writer's case, and the law, the variant and the writer mix it ran.
 */
type RaceFeature =
	| `threat: ${ThreatKind}`
	| RaceShape
	| "replacement"
	| "inside a replacement's window"
	| "blocked"
	| "deadlock"
	| "deadlock beside a runnable session"
	| "every interleaving"
	| "pct"
	| `${WriterKind} ${(Outcome | GrizzleSettled)["kind"]}`
	| `aborted: ${DirectAbort["kind"]}`
	| BelowFeature
	| `law ${string}`
	| `variant: ${string}`
	| `mix: ${string}`
	| Mode

/**
 * What every race suite's population must reach: every threat, a source moved out of the anchor's group, a lock wait,
 * both kinds of writer accepted, a deletion beside an insertion at one key for the anchor and for a source, a direct
 * replacement with another writer's step inside its window, and a planted writer refused by the guard.
 */
const situations: Arr.NonEmptyReadonlyArray<RaceFeature> = [
	...Arr.map(threatKinds, (k) => `threat: ${k}` as const),
	"moved out of the anchor's group",
	"blocked",
	"grizzle accepted",
	"direct accepted",
	"a deletion beside an insertion at the anchor's key",
	"a deletion beside an insertion at a source's key",
	"replacement",
	"inside a replacement's window",
	"refused by the guard"
]

/**
 * Whether another session's move was issued between a replacing session's first move, its first replacement's
 * deletion (directOps), finishing and its next move's issue.
 */
const insideReplacement = (i: Interleaving, replacing: ReadonlySet<string>): boolean =>
	Arr.some([...replacing], (session) => {
		const own = Arr.filter(i.moves, (m) => m.session === session)
		const [deletion, next] = own
		if (deletion === undefined || next === undefined || deletion.result._tag !== "Finished") {
			return false
		}
		const done = deletion.result.at
		return Arr.some(
			i.moves,
			(m) => m.session !== session && m.issued > done && m.issued < next.issued
		)
	})

/**
 * One resolved race on its variant's installation: it opens the case's own connections (the grizzle writers' Dbs and
 * the psql writers), and explores the race, noting what it reached on `c`. A race of more moves than every
 * interleaving covers runs under a PCT schedule it draws on `c` over its sessions: three levels of priority, so up to
 * two change points among its moves.
 */
const runRace = <P>(
	h: HistoryFamily<P>,
	install: HistoryInstall<P>,
	race: Resolved,
	c: Case<RaceFeature>
): Effect.Effect<void, CaseFailed, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const env = yield* h.connect(install)
		const actors = yield* lawActors(env)
		c.note(`law ${race.law}`)
		for (const kinds of race.threats) {
			for (const k of kinds) {
				c.note(`threat: ${k}`)
			}
		}
		for (const shape of race.shapes) {
			c.note(shape)
		}
		if (race.replacing.size > 0) {
			c.note("replacement")
		}
		for (const x of race.txns) {
			if (x.kind === "below") {
				c.noteAll(belowFeaturesOf(env.host, x.below))
			}
		}
		const [first, second] = race.threats
		for (const a of defined(first, "a race's first transaction")) {
			for (const b of defined(second, "a race's second transaction")) {
				c.pair(`threat: ${a}`, `threat: ${b}`)
			}
		}
		c.note(
			`mix: ${Arr.join(
				Arr.map(race.txns, (x) =>
					x.kind === "direct"
						? `direct${x.immediate === "deferred" ? "" : `, ${x.immediate} immediate`}`
						: x.kind === "below"
							? `below at ${x.below.level}`
							: "grizzle"
				),
				" vs "
			)}`
		)
		const spec = yield* lawExploration(
			env,
			`a race on ${race.law}`,
			race.initial,
			race.txns,
			(history, i) => {
				if (i.waits.length > 0) {
					c.note("blocked")
				}
				if (i.deadlocks.length > 0) {
					c.note("deadlock")
				}
				if (
					Arr.some(i.deadlocks, (d) => Option.exists(d.seen, (seen) => seen.runnable.length > 0))
				) {
					c.note("deadlock beside a runnable session")
				}
				if (insideReplacement(i, race.replacing)) {
					c.note("inside a replacement's window")
				}
				for (const r of history.recorded) {
					c.note(`${r.kind} ${r.outcome.kind}`)
					if (r.outcome.kind === "aborted") {
						c.note(`aborted: ${r.outcome.cause.kind}`)
					}
				}
			}
		)
		const moves = movesOf(spec.txns)
		const strategy: Strategy =
			moves <= exhaustiveMoves
				? every
				: {
						kind: "pct",
						schedule: c.draw(
							pctSchedule(
								nonEmptyList(
									Arr.map(race.txns, (x) => x.session),
									"a race's transactions"
								),
								3,
								moves
							)
						),
						nature: c
					}
		c.note(strategy.kind === "every" ? "every interleaving" : "pct")
		const observer = yield* exploreEnv(s)
		yield* exploreInterleavings(observer, actors, spec, strategy)
	}).pipe(
		Effect.catchCause((cause) => {
			const error = Cause.squash(cause)
			return Effect.fail(
				error instanceof CaseFailed ? error : new CaseFailed({ report: messageOf(error) })
			)
		})
	)

/**
 * Generated law races: two or three transactions that threaten one law at one anchor, explored in every order the
 * database lets them take, or under a PCT schedule when there are too many, and judged by the history oracle. Every
 * writer runs SERIALIZABLE, so PostgreSQL's SSI orders every write and every law's reads; a writer below SERIALIZABLE
 * is a planted case, refused at its write.
 *
 * A race is drawn per case from a family's own vocabulary of threats: it picks one of the
 * schema's laws, an anchor of it in a lawful initial state (a target fact of a containment or a coverage), and for each
 * transaction one or two threats to that anchor:
 *
 * - the anchor replaced with a redrawn payload (its selector);
 * - the anchor deleted, or inserted when the state holds none at its key, or inserted again at its key;
 * - the anchor retired: deleted with every stored fact its laws tie to it, so a lawful retirement races the sources
 *   inserted at it;
 * - a source fact inserted at the anchor, selected as the law's source side selects;
 * - a source fact at the anchor deleted, inserted again exactly, or replaced with a redrawn payload (its selector),
 *   which may take it out of the law's selection;
 * - a source fact moved to the anchor from another one, or away from it, out of the anchor's group.
 *
 * A fact replaced or moved at its own key is a put: a grizzle writer's on either kind of relation, and a direct
 * writer's upsert on a `mutable` one or insertion at the key on an immutable one, or, when the payload changes, its
 * replacement on either: the fact's deletion and an insertion at its key, as any psql writer replaces a fact and as
 * grizzle's own put does on an immutable relation. A fact moved to another key of an immutable relation is its deletion
 * and the insertion there.
 *
 * The initial state is seeded by construction before the drawn steps fold on top: the anchor with two, one or no
 * sources at it, two sources being two facts by their keys, and every fact the schema's containments and coverages
 * require of them, transitively. The seed is the first the host model accepts, most sources first, among
 * the drawn payloads and their strided redraws, so every threat that needs a stored fact can be drawn whatever the
 * anchor's or its sources' payloads need. Each threat is chosen among the kinds that apply to the initial state, so
 * every transaction has operations and every race has its two or three transactions.
 *
 * Each transaction runs as a grizzle writer (`g` or `h`), a direct psql writer (setting its constraints IMMEDIATE after
 * its last statement or not, and applying each put as the SQL put its relation admits or as a replacement), or a
 * planted psql writer below SERIALIZABLE that runs one write of a drawn form on the relation its first threat writes,
 * all drawn by the case's swarm. Every interleaving is a history: every planted writer refused at its write and
 * committing nothing, no law violated, every abort a concurrency failure, and serial orders respecting real time
 * explaining every outcome, each refusal naming a law violated at its place. Which writer is refused or aborted, the
 * lock waits, the deadlock victim and the lock order are never asserted: they are the database's.
 *
 * The generated races of one law family, over each population of its box (laws/boxes.ts populationsOf), as one
 * exploration. A test installs each variant the first time a case draws it and keeps the installation; every case
 * opens and closes its own connections, so a test holds one case's connections at a time whatever the variant count.
 */
/**
 * A population's schemas, window starts and requirements: its mode and variants, the starts that open a replacement's
 * window (windowStartsOf), and the write skew where its schemas make one (skewStartsOf).
 */
const modeRaces = <P>(h: HistoryFamily<P>, population: Population<P>) => {
	const variants = population.variants
	const windows = windowStartsOf(h, variants)
	/** A family with a write skew must break it in its population too. */
	const reach: Arr.NonEmptyReadonlyArray<RaceFeature> = Arr.isReadonlyArrayNonEmpty(
		skewStartsOf(h, variants)
	)
		? Arr.append(situations, "write skew")
		: situations
	return { mode: population.mode, variants, windows, reach }
}

/**
 * The generated law races of one family, over every population of its box in one exploration: a case's variant names
 * its schema and so its population, every feature a race notes is paired with its population's mode, and each
 * population must reach, in its own races, everything a family requires, its write skew included when it makes one.
 * Each population's window starts name its schemas past those of the populations before it.
 */
export const raceSuite = <P>(h: HistoryFamily<P>): void => {
	layer(Substrate.layer, { excludeTestServices: true })(
		`generated law races: ${h.family.label}`,
		(it) => {
			const populations = Arr.map(populationsOf(h.family), (population) => modeRaces(h, population))
			/** Each population with the number of schemas before it, which its windows are offset by. */
			const placed = Arr.map(populations, (population, i) => ({
				...population,
				offset: Arr.reduce(Arr.take(populations, i), 0, (n, q) => n + q.variants.length)
			}))
			const variants = Arr.flatMap(placed, (q) => q.variants)
			const windows: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<WindowStart>> = Arr.map(
				placed,
				(q) => Arr.map(q.windows, (w) => ({ ...w, variant: w.variant + q.offset }))
			)
			const reach: Situations<RaceFeature> = Arr.flatMap(placed, (q) =>
				Arr.map(q.reach, (f) => [q.mode, f] as const)
			)
			const races = Effect.gen(function* () {
				/** Every variant's installation, made before the first race and checked against its host. */
				const installs = yield* Effect.forEach(variants, (p) =>
					Effect.gen(function* () {
						const i = yield* h.install(p)
						const problem = enforcementProblem(i.host, i.names)
						if (problem !== undefined) {
							return yield* new CaseFailed({ report: problem })
						}
						return i
					}).pipe(
						Effect.mapError((e) =>
							e instanceof CaseFailed
								? e
								: new CaseFailed({
										report: `${h.family.describe(p)} did not install: ${messageOf(e)}`
									})
						)
					)
				)
				return yield* explore(
					{
						oracle: {
							kind: "specification",
							name: "the host model of the family's laws, as a serial reference of every interleaving"
						},
						suite: `races/${Str.replaceAll(regex("[^a-z0-9]+", "g"), "-")(h.family.label)}`,
						draw: drawn(raceCaseGen(variants.length, windows, skewStartsOf(h, variants))),
						literal: Formatter.format,
						coverage: required<RaceFeature>(reach, { cases: 8 * runsPerTest, sense: notesOnly }),
						kept: [],
						runs: 2 * runsPerTest,
						shrink: { kind: "bounded", candidates: 300 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(rc, c) =>
						Effect.gen(function* () {
							const variant = elementAt(variants, rc.variant, "the family's schemas")
							const host = h.family.host(variant)
							const mode = modeOf(host)
							/** The case as the race sees it: every feature it notes is also noted beside its mode. */
							const modal: Case<RaceFeature> = {
								...c,
								note: (feature) => {
									c.note(feature)
									c.note(mode)
									c.pair(mode, feature)
								},
								noteAll: (noted) => {
									for (const feature of noted) {
										c.note(feature)
										c.pair(mode, feature)
									}
									c.note(mode)
								}
							}
							modal.note(`variant: ${h.family.describe(variant)}`)
							/** The race on its variant's model, the one the variant's installation holds. */
							const race = c.draw(resolveRaceGen({ host, domains: h.family.domains }, rc.race))
							const i = elementAt(installs, rc.variant, "the family's installations")
							yield* Effect.scoped(runRace(h, i, race, modal))
						})
				)
			})
			it.effect(
				"every race is lawful, serial and every abort explained, on immutable and mutable schemas",
				(ctx) => searched(ctx, races)
			)
		}
	)
}
