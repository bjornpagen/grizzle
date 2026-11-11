import { array, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import type { PctSchedule } from "@grizzle/testing/interleave"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Effect, Option, Record, String as Str } from "effect"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import {
	emptyState,
	expect,
	type HostFact,
	type HostSchema,
	type HostState,
	isDrawn,
	isSpan,
	needs,
	type HostOp,
	relationOf,
	hostSpan,
	type HostValue
} from "#test/support/laws/model.ts"

import { quoteIdent } from "#compiler/sql/print.ts"
import { defined } from "#test/support/assert.ts"
import { type ClosedField, closedField, namedText } from "#test/support/closed/stored.ts"
import type { GrizzleSettled, Outcome, Settled, WitnessKey } from "#test/support/history/check.ts"
import type { GrizzleWriter, HistoryRig } from "#test/support/history/families.ts"
import { directOps, expectDirect, type Immediacy } from "#test/support/history/model.ts"
import {
	type Below,
	type BelowForm,
	type BelowSpelling,
	belowForms,
	belowLevels,
	type Cell
} from "#test/support/history/refused.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import {
	type CaseSketch,
	caseSketchGen,
	type Domains,
	domainFacts,
	plantedGroup,
	plantedInsert,
	resolveStep,
	type StepSketch,
	stepSwarmGen,
	unorderableCycle
} from "#test/support/laws/support.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { untilAnswered } from "#test/support/schedules/grizzle.ts"

import {
	type PgErrorFields,
	reportedOwnerOf,
	type TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * The features a history's swarm turns on, off or weighs: each writer kind, immediate constraints, a writer copying
 * another's list, and each choice of a planted writer. The sketch
 * states what the swarm chose by name, so resolving a history reads no swarm and a kept case names its writers.
 */
const historyFeatures = [
	"grizzle",
	"direct",
	"below",
	"immediate",
	"repeats",
	...belowForms,
	"read only",
	"read first"
] as const
type HistoryFeature = (typeof historyFeatures)[number]

/** A writer's kind as its swarm chose it, before the history's preemption and free actors settle it (resolveHistory). */
type WriterChoice = "grizzle" | "direct" | "below"

const writerChoices = ["grizzle", "direct", "below"] as const

/**
 * What a direct writer makes immediate after its last statement, drawn under its swarm: nothing, unless the swarm keeps
 * immediate constraints, and then every constraint.
 */
export const immediacyGen =
	(drawn: Swarm<"immediate">): Gen<Immediacy> =>
	(source) =>
		source.draw(keep(drawn, "immediate")) ? "every constraint" : "deferred"

/**
 * A planted writer's level and statement, as its swarm chose them: a write of a form, reading the relation first when
 * the swarm keeps it, or a read alone. What it names is the resolver's: the relation and fact a history picks, or what
 * a race's threat writes.
 */
export type BelowChoice =
	| { readonly kind: "read only"; readonly level: BelowSerializable }
	| {
			readonly kind: "write"
			readonly level: BelowSerializable
			readonly form: BelowForm
			readonly read: boolean
	  }

/** A planted writer's level, drawn evenly, then its form or a read alone under its swarm. */
export const belowChoiceGen =
	(drawn: Swarm<BelowForm | "read only" | "read first">): Gen<BelowChoice> =>
	(source) => {
		const level = source.draw(element(belowLevels))
		const form = source.draw(swarmChoice(drawn, Arr.append(belowForms, "read only")))
		return form === "read only"
			? { kind: "read only", level }
			: { kind: "write", level, form, read: source.draw(keep(drawn, "read first")) }
	}

/**
 * A planted writer below SERIALIZABLE as its sketch states it: its level and statement as its swarm chose them, and as
 * picks the relation it names and the fact its statement names: `stored` picks a stored fact of the relation when the
 * initial state holds one, `values` draws one otherwise.
 */
interface BelowSketch {
	readonly choice: BelowChoice
	readonly relation: number
	readonly stored: number
	readonly values: ReadonlyArray<number>
}

const sixPicks: Gen<ReadonlyArray<number>> = array(pickGen, { min: 6, max: 6 })

const belowSketchGen =
	(drawn: Swarm<HistoryFeature>): Gen<BelowSketch> =>
	(source) => ({
		choice: source.draw(belowChoiceGen(drawn)),
		relation: source.draw(pickGen),
		stored: source.draw(pickGen),
		values: source.draw(sixPicks)
	})

/**
 * A writer as its sketch states it: its kind, what it makes immediate when it runs direct, the writer whose list of
 * case sketches it runs (its own, or another's when the swarm keeps repeats, which makes concurrent exact repeats), its
 * list, and its planted transaction when it runs below SERIALIZABLE. Every field is drawn whatever the kind, since the
 * history's preemption and free actors may settle another (resolveHistory).
 */
interface WriterSketch {
	readonly kind: WriterChoice
	readonly immediacy: Immediacy
	readonly copies: number
	readonly steps: CaseSketch
	readonly below: BelowSketch
}

/**
 * Whether a history preempts a direct transaction: none, or the writer, by its index, that runs a direct transaction
 * first, one of the first three so a direct actor is free for it whatever its swarm chose before it, and the other
 * writer whose operation runs while it is open (scheduleOf). Operations of two writers overlap in real time only when a
 * direct transaction is preempted between its first statement and its end, or a step waits on a lock; PCT places its
 * change points over every move, so a run of drawn schedules alone reaches an overlap too rarely to count on, and one
 * history in three draws the preemption itself.
 */
type Preempt =
	| { readonly kind: "none" }
	| { readonly kind: "preempt"; readonly direct: number; readonly other: number }

/** A preemption among `writers` writers. */
const preemptGen = (writers: number): Gen<Preempt> =>
	weighted<Preempt>([
		[2, constant({ kind: "none" })],
		[
			1,
			(source) => {
				const direct = source.draw(int(0, Math.min(writers, directActors.length) - 1))
				const k = source.draw(int(0, writers - 2))
				return { kind: "preempt", direct, other: k < direct ? k : k + 1 }
			}
		]
	])

interface HistorySketch {
	readonly initial: CaseSketch
	readonly writers: ReadonlyArray<WriterSketch>
	readonly preempt: Preempt
}

/**
 * A history: its swarm and its step swarm, the initial state's steps and two or three writers under them, each writer
 * one case sketch's steps, then its preemption. The writers are a collection's items, each in its span, so shrinking
 * deletes a writer as it deletes an array's item.
 */
const historySketchGen: Gen<HistorySketch> = (source) => {
	const drawn = source.draw(swarm(historyFeatures))
	const steps = source.draw(stepSwarmGen)
	const initial = source.draw(caseSketchGen(steps))
	const writers = source.span("array", () => {
		const count = source.draw(int(2, 3))
		return Arr.map(Arr.range(0, count - 1), (index) =>
			source.span("element", (): WriterSketch => ({
				kind: source.draw(swarmChoice(drawn, writerChoices)),
				immediacy: source.draw(immediacyGen(drawn)),
				copies: source.draw(keep(drawn, "repeats")) ? source.draw(int(0, count - 1)) : index,
				steps: source.draw(caseSketchGen(steps)),
				below: source.draw(belowSketchGen(drawn))
			}))
		)
	})
	return { initial, writers, preempt: source.draw(preemptGen(writers.length)) }
}

/**
 * The order a history's transactions run in: the order their writers list them, with no change point, or a PCT schedule
 * the property draws once it knows the transactions (scheduleOf). Either way a preemption puts its writers first.
 */
type HistoryOrder = "listed" | "drawn"

/**
 * A history case: which of the family's schemas it runs on, by its index among them, its history, and its order.
 */
export interface HistoryCase {
	readonly variant: number
	readonly history: HistorySketch
	readonly order: HistoryOrder
}

/**
 * History cases over `variants` schemas. The listed order is the simpler arm, so a failure that holds in it shrinks to
 * it and replays with no schedule drawn; drawn schedules are seven cases in eight, since they include the listed order
 * only as one order among the transactions' every permutation.
 */
export const historyCaseGen =
	(variants: number): Gen<HistoryCase> =>
	(source) => ({
		variant: source.draw(int(0, variants - 1)),
		history: source.draw(historySketchGen),
		order: source.draw(
			weighted<HistoryOrder>([
				[1, constant("listed")],
				[7, constant("drawn")]
			])
		)
	})

/**
 * A writer of a history with its actor: a grizzle or direct writer with its list of ChangeSets, each its host
 * operations, or a planted writer with its one transaction.
 */
type ListedWriter =
	| {
			readonly kind: "grizzle"
			readonly actor: "g" | "h"
			readonly ops: ReadonlyArray<ReadonlyArray<HostOp>>
	  }
	| {
			readonly kind: "direct"
			readonly actor: DirectActor
			readonly immediate: Immediacy
			readonly ops: ReadonlyArray<ReadonlyArray<HostOp>>
	  }
	| { readonly kind: "below"; readonly actor: DirectActor; readonly below: Below }

type DirectActor = "a" | "b" | "c"

/** The transactions a writer runs: its list's, or a planted writer's one. */
const transactionsOf = (w: ListedWriter): number => (w.kind === "below" ? 1 : w.ops.length)

/** The session of a writer's `j`-th transaction: its actor and the transaction's place in its list. */
export const sessionOf = (actor: string, j: number): string => `${actor}${j}`

export interface Resolved {
	readonly initial: HostState
	readonly writers: ReadonlyArray<ListedWriter>
	readonly preempt: Preempt
}

const grizzleActors = ["g", "h"] as const
const directActors = ["a", "b", "c"] as const

/** The `n`-th actor of a kind, which the caller has bounded. */
const actorAt = <A extends string>(actors: Arr.NonEmptyReadonlyArray<A>, n: number): A =>
	actors[n] ?? actors[0]

/** A fact of `relation` drawn from its fields' domains, field i by pick i of six. */
const domainFact = (
	host: HostSchema,
	domains: Domains,
	relation: string,
	values: ReadonlyArray<number>
): HostFact =>
	Record.fromEntries(
		Arr.map(relationOf(host, relation).fields, (f, i) => {
			const [first, ...rest] = defined(
				domains[relation]?.[f.name],
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

/** The planted writer a sketch draws from `state`: its relation, and for a write the fact its statement names. */
const resolveBelow = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	sketch: BelowSketch
): Below => {
	const [first, ...rest] = host.relations
	if (first === undefined) {
		throw new Error("a family schema holds no relation")
	}
	const relation = pickFrom([first, ...rest], sketch.relation).name
	const choice = sketch.choice
	if (choice.kind === "read only") {
		return { kind: "read only", level: choice.level, relation }
	}
	const [stored, ...others] = state.get(relation) ?? []
	const fact =
		stored === undefined
			? domainFact(host, domains, relation, sketch.values)
			: pickFrom([stored, ...others], sketch.stored)
	return {
		kind: "write",
		level: choice.level,
		form: choice.form,
		relation,
		fact,
		read: choice.read
	}
}

/**
 * Generated histories: concurrent writers over one law-family installation, run in an order a PCT schedule chooses,
 * recorded and checked after the fact.
 *
 * A history is drawn as a sketch (HistorySketch): its writers' kinds and forms named as a swarm over them chose them,
 * and the choices among what the resolver computes as picks. The property draws its PCT schedule once the history is
 * resolved, on the same tape, so a failing case shrinks whole and its report is the case to replay:
 *
 * - an initial state: a few ChangeSets the host applies serially from the empty state, keeping the accepted ones, so
 *   the state is lawful (resolveStep, model.ts expect);
 * - two or three writers, each a grizzle writer, a direct SQL writer, or a planted writer below SERIALIZABLE. A grizzle
 *   or direct writer runs a list of ChangeSets resolved against the initial state, so they delete, replace and repeat
 *   the facts the others touch; a writer may copy another's list exactly, which makes concurrent exact repeats. A
 *   grizzle writer runs db.apply of an enumerated ChangeSet on a Db of `app` with a pool of its own, so two grizzle
 *   writers hold two sessions. A direct writer is a psql child that has taken on the role `direct` and runs the same
 *   operations as plain SQL, each in one SERIALIZABLE transaction, setting, when the swarm says so, every
 *   constraint IMMEDIATE after its last statement. A
 *   planted writer is a psql child too, that begins below SERIALIZABLE and runs one write of a drawn form on a drawn
 *   relation, or only reads: it must be refused at its write, and commits nothing.
 *
 * Each writer's operations run in order, and the writers' moves interleave as the PCT schedule chooses, every lock wait
 * observed, so a history is a deterministic function of its case: its order is not the operating system's. Every
 * operation is recorded with its outcome and its span on the exploration's event clock, the committed state is read
 * back as the owner and checked: no law violated, every abort explained, and serial orders respecting real
 * time explain every outcome and the state. Then exact repeats must be `no-change`: every accepted grizzle ChangeSet
 * that the committed state already reflects is submitted again by both grizzle writers at once, and each must be
 * no-change with the state untouched.
 */
export const resolveHistory = (
	host: HostSchema,
	domains: Domains,
	sketch: HistorySketch
): Resolved => {
	let initial = emptyState(host)
	for (const step of sketch.initial) {
		const e = expect(host, initial, resolveStep(host, domains, initial, step))
		if (e.kind === "accepted" || e.kind === "no-change") {
			initial = e.state
		}
	}
	const lists = Arr.map(sketch.writers, (w) =>
		Arr.map(w.steps, (step) => resolveStep(host, domains, initial, step))
	)
	const preempt = sketch.preempt
	let grizzles = 0
	let directs = 0
	const writers = Arr.map(sketch.writers, (w, i): ListedWriter => {
		const ops = defined(lists[w.copies], `the list of writer ${w.copies}, which writer ${i} copies`)
		/**
		 * Each kind has as many actors as its swarm chose and the history leaves free: two grizzle writers, three
		 * direct ones, planted writers among them; a preemption's direct writer is direct whatever its swarm chose.
		 */
		const forced = preempt.kind === "preempt" && preempt.direct === i
		const kind = forced ? "direct" : w.kind
		if ((kind === "grizzle" && grizzles < grizzleActors.length) || directs >= directActors.length) {
			return { kind: "grizzle", actor: actorAt(grizzleActors, grizzles++), ops }
		}
		const actor = actorAt(directActors, directs++)
		if (kind === "below") {
			return { kind: "below", actor, below: resolveBelow(host, domains, initial, w.below) }
		}
		return {
			kind: "direct",
			actor,
			immediate: w.immediacy,
			ops: Arr.filter(
				Arr.map(ops, (o) => directOps(host, o, [])),
				(o) => o.length > 0
			)
		}
	})
	return { initial, writers, preempt }
}

/**
 * The schedule a resolved history runs under, from `base`, the order its transactions take without a preemption: their
 * listed order (suite.ts historyTxns) with no change point, or a PCT schedule the property drew over their sessions.
 * With a preemption, the direct writer's first transaction comes first and the other writer's first next, then every
 * other in the base's order, and a change point after the first move precedes the base's, so the direct transaction
 * drops below every other once its first statement has run and the other writer's operation runs while it is open.
 * Every list a writer's swarm keeps holds an operation (a resolved step writes at least one fact, and a direct writer's
 * first keeps its first write or deletion), so both first transactions exist.
 */
export const scheduleOf = (resolved: Resolved, base: PctSchedule<string>): PctSchedule<string> => {
	if (resolved.preempt.kind === "none") {
		return base
	}
	const firstOf = (writer: number): string => {
		const w = defined(resolved.writers[writer], `the preemption's writer ${writer}`)
		if (transactionsOf(w) === 0) {
			throw new Error(`the preemption's writer ${writer} runs no transaction`)
		}
		return sessionOf(w.actor, 0)
	}
	const d = firstOf(resolved.preempt.direct)
	const o = firstOf(resolved.preempt.other)
	return {
		priorities: [d, o, ...Arr.filter(base.priorities, (x) => x !== d && x !== o)],
		changes: [1, ...base.changes]
	}
}

/**
 * Planted histories: what the drawn histories reach a few times a run, as kept cases. Each has two writers from the
 * empty state, a direct writer storing one step and then a grizzle writer storing another, each running its own list,
 * the direct writer making every constraint immediate, run in their listed order:
 *
 * - serial: the direct writer's transaction runs to its end before the grizzle writer's operation, so both are accepted;
 * - overlapping: the direct writer's transaction is preempted after its first statement, so the grizzle writer's
 *   operation runs while it is open.
 *
 * The steps are the first pair, in a fixed order, of single-member steps: every fact of each relation inserted as its
 * domains draw it, then each law's lawful referring group from every referring fact the domains draw. The direct step's
 * transaction must store it from the empty state, and the grizzle step's ChangeSet must store it from the state that
 * leaves. There are none when no pair qualifies.
 */
interface PlantedHistories {
	readonly serial: HistorySketch
	readonly overlapping: HistorySketch
}

/** A planted history of a direct writer's step and then a grizzle writer's, from the empty state. */
const plantedSketch = (
	direct: StepSketch,
	grizzle: StepSketch,
	preempt: Preempt
): HistorySketch => ({
	initial: [],
	writers: [plantedWriter("direct", direct, 0), plantedWriter("grizzle", grizzle, 1)],
	preempt
})

/** A planted history's writer: its kind, its one step, and its index among the two writers, whose list it runs. */
const plantedWriter = (kind: WriterChoice, step: StepSketch, index: number): WriterSketch => ({
	kind,
	immediacy: "every constraint",
	copies: index,
	steps: [step],
	below: unreadBelow
})

/** The planted transaction of a writer whose kind is not below, which its resolution never reads. */
const unreadBelow: BelowSketch = {
	choice: { kind: "read only", level: "read uncommitted" },
	relation: 0,
	stored: 0,
	values: [0, 0, 0, 0, 0, 0]
}

export const plantedHistories = (
	host: HostSchema,
	domains: Domains
): PlantedHistories | undefined => {
	const empty = emptyState(host)
	const members = [
		...Arr.flatMap(host.relations, (r) =>
			Arr.map([...domainFacts(host, domains, r.name)], (fact) =>
				plantedInsert(host, domains, r.name, fact)
			)
		),
		...Arr.flatMap(host.laws, (law) => {
			const [need] = needs(law)
			if (need === undefined) {
				return []
			}
			return Arr.map([...domainFacts(host, domains, need.from.relation)], (from) =>
				plantedGroup(host, domains, law, from)
			)
		})
	]
	const steps = Arr.map(
		members,
		(member): { readonly step: StepSketch; readonly ops: ReadonlyArray<HostOp> } => {
			const step = [member]
			return { step, ops: resolveStep(host, domains, empty, step) }
		}
	)
	for (const direct of steps) {
		const ops = directOps(host, direct.ops, [])
		if (ops.length === 0) {
			continue
		}
		const stored = expectDirect(host, empty, ops)
		if (stored.kind !== "accepted") {
			continue
		}
		const grizzle = Arr.findFirst(
			steps,
			(g) => expect(host, stored.state, g.ops).kind === "accepted"
		)
		if (Option.isNone(grizzle)) {
			continue
		}
		return {
			serial: plantedSketch(direct.step, grizzle.value.step, { kind: "none" }),
			overlapping: plantedSketch(direct.step, grizzle.value.step, {
				kind: "preempt",
				direct: 0,
				other: 1
			})
		}
	}
	return undefined
}

/** One installed family schema, with the reads the histories share. */
export interface HistoryEnv {
	readonly host: HostSchema
	readonly domains: Domains
	readonly rig: HistoryRig
	/** The installation's names, through the naming door: tables and constraints' laws. */
	readonly names: Names
}

/** The closed id `relation`'s `field` holds on this installation, whose column stores its handle's code. */
const closedOf = (env: HistoryEnv, relation: string, field: string): ClosedField | undefined =>
	closedField(env.rig.installed.installation, relation, field)

/** A value as a literal at its column: a closed id as its handle's code, which its column stores. */
const literal = (closed: ClosedField | undefined, x: HostValue): string => {
	if (isDrawn(x)) {
		throw new Error(
			`draw ${String(x.draw)} has no SQL literal: a writer sends only values it has seen`
		)
	}
	if (isSpan(x)) {
		return `int4range(${x.start}, ${x.end})`
	}
	if (typeof x !== "string") {
		return String(x)
	}
	return closed === undefined ? `'${Str.replaceAll("'", "''")(x)}'` : closed.literal(x)
}

/**
 * A value's host form from its text, by the kind its field's domain draws: an integer, a boolean, a span, or a text.
 */
const hostValue = (sample: HostValue | undefined, text: string): HostValue => {
	if (sample === undefined) {
		throw new Error(`no domain for a value spelled ${text}`)
	}
	if (typeof sample === "number") {
		return Number(text)
	}
	if (typeof sample === "boolean") {
		return text === "true"
	}
	if (isSpan(sample)) {
		const bounds = regex("^\\[(-?[0-9]+),(-?[0-9]+)\\)$").exec(text)
		if (bounds === null) {
			throw new Error(`a span spelled ${text}`)
		}
		return hostSpan(Number(bounds[1]), Number(bounds[2]))
	}
	return text
}

const sampleOf = (env: HistoryEnv, relation: string, field: string): HostValue | undefined =>
	env.domains[relation]?.[field]?.[0]

const tableOf = (env: HistoryEnv, relation: string): string =>
	`${quoteIdent(env.rig.installed.schema)}.${quoteIdent(relationOf(env.host, relation).table)}`

/** A fact's cells in heading order, each value a literal; a fact without a field of its relation is a defect. */
const cellsOf = (
	env: HistoryEnv,
	relation: string,
	fact: HostFact
): Arr.NonEmptyReadonlyArray<Cell> => {
	const [first, ...rest] = Arr.map(relationOf(env.host, relation).fields, (f): Cell => {
		const x = fact[f.name]
		if (x === undefined) {
			throw new Error(`${relation} fact without ${f.name}`)
		}
		return {
			field: f.name,
			column: quoteIdent(f.column),
			value: literal(closedOf(env, relation, f.name), x)
		}
	})
	if (first === undefined) {
		throw new Error(`${relation} has no field`)
	}
	return [first, ...rest]
}

/** How a planted writer's SQL is spelled on this installation. */
export const belowSpelling = (env: HistoryEnv): BelowSpelling => ({
	table: (relation) => tableOf(env, relation),
	cells: (relation, fact) => cellsOf(env, relation, fact)
})

const rowOf = (env: HistoryEnv, relation: string, fact: HostFact): string =>
	`(${Arr.join(
		Arr.map(cellsOf(env, relation, fact), (c) => c.value),
		", "
	)})`

const columnsOf = (env: HistoryEnv, relation: string): string =>
	Arr.join(
		Arr.map(relationOf(env.host, relation).fields, (f) => quoteIdent(f.column)),
		", "
	)

const insertSql = (env: HistoryEnv, relation: string, facts: ReadonlyArray<HostFact>): string =>
	`INSERT INTO ${tableOf(env, relation)} (${columnsOf(env, relation)}) VALUES ${Arr.join(
		Arr.map(facts, (f) => rowOf(env, relation, f)),
		", "
	)}`

/**
 * A direct writer's statements for `ops`, each with the relation it writes: every deletion, then every insertion and
 * put, in order.
 */
export const writeSteps = (
	env: HistoryEnv,
	ops: ReadonlyArray<HostOp>
): ReadonlyArray<{ readonly sql: string; readonly relation: string }> => {
	const deletes = Arr.map(
		Arr.filter(ops, (o) => o.kind === "delete"),
		(o) => ({
			relation: o.relation,
			sql: `DELETE FROM ${tableOf(env, o.relation)} WHERE (${columnsOf(env, o.relation)}) IN (${Arr.join(
				Arr.map(o.facts, (f) => rowOf(env, o.relation, f)),
				", "
			)})`
		})
	)
	const writes = Arr.map(
		Arr.filter(ops, (o) => o.kind !== "delete"),
		(o) => {
			const insert = insertSql(env, o.relation, o.facts)
			if (o.kind === "insert") {
				return { relation: o.relation, sql: insert }
			}
			const r = relationOf(env.host, o.relation)
			const keys = Arr.map(
				Arr.filter(r.fields, (f) => r.key.includes(f.name)),
				(f) => quoteIdent(f.column)
			)
			const payload = Arr.map(
				Arr.filter(r.fields, (f) => !r.key.includes(f.name)),
				(f) => `${quoteIdent(f.column)} = EXCLUDED.${quoteIdent(f.column)}`
			)
			return {
				relation: o.relation,
				sql: `${insert} ON CONFLICT (${Arr.join(keys, ", ")}) DO UPDATE SET ${Arr.join(payload, ", ")}`
			}
		}
	)
	return [...deletes, ...writes]
}

/**
 * Empties every table and loads `state`, as the owner, in one transaction. RESTART IDENTITY restarts every sequence a
 * table owns, so a run's physical start is a function of its logical state.
 */
export const load = (
	env: HistoryEnv,
	state: HostState
): Effect.Effect<void, SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* transaction(s.admin, [
			`TRUNCATE ${Arr.join(
				Arr.map(env.host.relations, (r) => tableOf(env, r.name)),
				", "
			)} RESTART IDENTITY`,
			...Arr.flatMap(env.host.relations, (r) => {
				const facts = state.get(r.name) ?? []
				return facts.length === 0 ? [] : [insertSql(env, r.name, facts)]
			})
		])
	})

/**
 * The committed state, read as the owner, each value parsed by the kind its domain draws, a closed id's code read back
 * as the handle it names.
 */
export const read = (env: HistoryEnv): Effect.Effect<HostState, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const out = new Map<string, ReadonlyArray<HostFact>>()
		for (const r of env.host.relations) {
			const texts = Arr.map(r.fields, (f) =>
				namedText(env.rig.installed.installation, r.name, f.name)
			)
			const rows = yield* s.admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(r.fields, (f) => `${quoteIdent(f.column)}::text`),
					", "
				)} FROM ${tableOf(env, r.name)}`,
				[]
			)
			out.set(
				r.name,
				Arr.map(rows, (row) =>
					Record.fromEntries(
						Arr.map(
							r.fields,
							(f, i) =>
								[
									f.name,
									hostValue(
										sampleOf(env, r.name, f.name),
										defined(texts[i], `${r.name}'s reader ${i}`)(String(row[i]))
									)
								] as const
						)
					)
				)
			)
		}
		return out
	})

/** A witness key's values in the host's form: an integer key host value may arrive as a bigint. */
const hostKeys = (keys: ReadonlyArray<WitnessKey>): ReadonlyArray<WitnessKey> =>
	Arr.map(keys, (k) => ({
		relation: k.relation,
		values: Record.fromEntries(
			Arr.map(Record.toEntries(k.values), ([f, x]) => [f, typeof x === "bigint" ? Number(x) : x])
		)
	}))

/**
 * A grizzle operation's answer as a history outcome. A history's writers run as full roles, whose worlds are reality:
 * no fact lies outside them, so an outside-world outcome is a defect.
 */
const grizzleOutcome = (names: Names, o: ApplyOutcome<unknown>): Effect.Effect<Settled> => {
	if (o.kind === "outside-world") {
		return Effect.die(new Error(`a full role's write is outside its world: ${o.relation}`))
	}
	if (o.kind !== "invariant-rejected") {
		return Effect.succeed({ kind: o.kind })
	}
	return Effect.succeed({
		kind: "invariant-rejected",
		laws: Arr.map(o.refused.laws, names.reported),
		keys: o.witness.kind === "key" ? hostKeys([o.witness]) : []
	})
}

/**
 * A grizzle operation's outcome and the TransientFailure reason each discarded attempt met. grizzle makes one attempt
 * per call; the writer calls again after each TransientFailure until a call answers (untilAnswered), as an
 * application does, so a refused attempt committed nothing and takes no place in the order, and the operation's
 * outcome is its answer. Its refusals end with the history's other transactions, so an operation that never answers is
 * its case's hang (caseHang).
 */
export interface GrizzleRun {
	readonly outcome: GrizzleSettled
	readonly transients: ReadonlyArray<TransientTag>
}

/**
 * `writer`'s operation `ops`, run as an application runs a write: its answer, or its ChangeSet refused as it compiled,
 * before any attempt, because no order of its stratum's writes keeps every immediate key; any other failure is a
 * defect.
 */
export const runGrizzle = (
	env: HistoryEnv,
	writer: GrizzleWriter,
	ops: ReadonlyArray<HostOp>
): Effect.Effect<GrizzleRun> =>
	Effect.flatMap(env.rig.writes[writer](ops), (call) => untilAnswered(call)).pipe(
		Effect.flatMap((run) =>
			Effect.map(grizzleOutcome(env.names, run.answered), (outcome) => ({
				outcome,
				transients: run.refused
			}))
		),
		Effect.catch((failure) =>
			unorderableCycle(failure) === undefined
				? Effect.die(failure)
				: Effect.succeed<GrizzleRun>({ outcome: { kind: "unorderable" }, transients: [] })
		)
	)

/**
 * What classifying a direct writer's error reads: the installation's names (a constraint's law, through the naming
 * door), the host schema, and a witness key's text in its field's host form.
 */
interface DirectClassifier {
	readonly names: Names
	readonly host: HostSchema
	readonly value: (relation: string, field: string, text: string) => HostValue
}

export const directClassifier = (env: HistoryEnv): DirectClassifier => ({
	names: env.names,
	host: env.host,
	value: (relation, field, text) => hostValue(sampleOf(env, relation, field), text)
})

/**
 * A direct SERIALIZABLE writer's PostgreSQL error as an outcome: 40001 and 40P01 abort it; a native constraint's
 * violation refuses it with the law the constraint reports: a foreign key, a unique key, a row check, a span key's
 * exclusion. Every law is native (fin.md §7), so no 23000 is a law's. Any other error is a defect of the history.
 * PostgreSQL states the violating key only in prose.
 */
export const classifyDirect = (
	env: DirectClassifier,
	fields: PgErrorFields
): Effect.Effect<Outcome> =>
	Effect.sync((): Outcome => {
		const constraint = fields.constraint
		switch (fields.code) {
			case "40001":
				return { kind: "aborted", cause: { kind: "serialization failure" } }
			case "40P01":
				return { kind: "aborted", cause: { kind: "deadlock" } }
			case "23503":
			case "23505":
			case "23514":
			case "23P01": {
				const owner = reportedOwnerOf(fields)
				if (constraint === undefined || owner === undefined) {
					throw new Error(`SQLSTATE ${fields.code} on no constraint and owner: ${fields.message}`)
				}
				return {
					kind: "invariant-rejected",
					laws: [env.names.lawOfConstraint(owner, constraint)],
					keys: []
				}
			}
			default:
				throw new Error(`SQLSTATE ${fields.code}: ${fields.message}`)
		}
	})
