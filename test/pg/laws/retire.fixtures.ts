/** What the properties of retire.test.ts read: its spaces, models and helpers. */

import { array, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, retirement } from "#compiler/public/fields.ts"
import {
	contained,
	login,
	on,
	relation,
	retirable,
	role,
	type Schema,
	schema,
	type StatementsByName,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { generatedTemplate } from "#test/support/install-migrate.ts"
import { rebuild } from "#test/support/installed.ts"

/**
 * A workflow's runs, retired whole by a role of their own, as den retires a finished root's graph: Flow, the header, one
 * row per run, with its retirement field; FlowStep and FlowClaim, its bodies, grouped by `flow`, a claim contained in its
 * step; and Audit, an application's rows outside the unit, each contained in a step, which refuse a retirement of their
 * step's run until they go (README Retirable units).
 */
const Flow = relation("Flow", { id: pg.integer, retired: retirement }, ["id"])

const FlowStep = relation("FlowStep", { flow: pg.integer, step: pg.integer }, ["flow", "step"])

const FlowClaim = relation(
	"FlowClaim",
	{ flow: pg.integer, step: pg.integer, attempt: pg.integer },
	["flow", "step", "attempt"]
)

const Audit = relation("Audit", { id: pg.integer, flow: pg.integer, step: pg.integer }, ["id"])

export const Flows = schema(
	"Flows",
	[Flow, FlowStep, FlowClaim, Audit],
	[
		retirable(Flow, [on(FlowStep, "flow"), on(FlowClaim, "flow")]),
		contained(on(FlowClaim, "flow", "step"), on(FlowStep, "flow", "step")),
		contained(on(Audit, "flow", "step"), on(FlowStep, "flow", "step"))
	]
)

/** Flows under another name, as an installation under a unique schema name opens it. */
type FlowsNamed<N extends string> = Schema<
	N,
	(typeof Flows)["relations"],
	StatementsByName<(typeof Flows)["statements"], (typeof Flows)["relations"]>
>

/**
 * The flows' login over the schema it is given: the worker, which inserts every relation and so runs a flow, admitting
 * a run with its steps, claiming a step and auditing one, each a ChangeSet of array members; and the retirer, which
 * writes nothing and retires Flow's groups, by its one member, as den's census retires its finished roots (den
 * runtime/retire.ts).
 */
export const flowsApp = (installed: FlowsNamed<string>) => {
	const worker = role(installed, "worker", wholeEntriesOf(installed), {
		insert: ["Flow", "FlowStep", "FlowClaim", "Audit"]
	})
	const retirer = role(installed, "retirer", wholeEntriesOf(installed), { retire: ["Flow"] })
	return login(installed, "flows_app", [worker, retirer], {
		workload: [
			workload(worker, {
				admit: ChangeSet.empty(installed).insert(Flow, []).insert(FlowStep, []),
				claim: ChangeSet.empty(installed).insert(FlowClaim, []),
				audit: ChangeSet.empty(installed).insert(Audit, [])
			}),
			workload(retirer, { retire: ChangeSet.empty(installed).retire(Flow, []) })
		]
	})
}

/** Flows drafted and served as `grizzle generate` does, with its login, which Served.of serves per case. */
export const flowsTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "flows retired by a role of their own",
	content: {
		schema: "Flows",
		logins: [
			"flows_app: a worker inserting runs, steps, claims and audits; a retirer retiring runs"
		]
	},
	build: (name) => {
		const named = rebuild(Flows, name)
		return { schema: named, logins: [flowsApp(named)] }
	},
	ambient: ordinarySession
})

/** One call of the case, in order: a worker's admission, claim or audit, or the retirer's retirement of runs. */
export type Call =
	| {
			readonly kind: "admit"
			readonly flow: number
			readonly steps: Arr.NonEmptyReadonlyArray<number>
	  }
	| {
			readonly kind: "claim"
			readonly flow: number
			readonly step: number
			readonly attempt: number
	  }
	| { readonly kind: "audit"; readonly id: number; readonly flow: number; readonly step: number }
	| { readonly kind: "retire"; readonly flows: Arr.NonEmptyReadonlyArray<number> }

const flows = [1, 2] as const

const steps = [0, 1] as const

/** One or more of `values`, each drawn, repeats among them. */
const someOf =
	<A>(values: Arr.NonEmptyReadonlyArray<A>, max: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => {
		const first = source.draw(element(values))
		return [first, ...source.draw(array(element(values), { min: 0, max: max - 1 }))]
	}

const callGen: Gen<Call> = (source) => {
	const kind = source.draw(
		weighted<Call["kind"]>([
			[2, constant("admit")],
			[1, constant("claim")],
			[1, constant("audit")],
			[2, constant("retire")]
		])
	)
	switch (kind) {
		case "admit":
			return { kind, flow: source.draw(element(flows)), steps: source.draw(someOf(steps, 2)) }
		case "claim":
			return {
				kind,
				flow: source.draw(element(flows)),
				step: source.draw(element(steps)),
				attempt: source.draw(int(0, 1))
			}
		case "audit":
			return {
				kind,
				id: source.draw(int(1, 2)),
				flow: source.draw(element(flows)),
				step: source.draw(element(steps))
			}
		case "retire":
			return { kind, flows: source.draw(someOf(flows, 3)) }
	}
}

/** A case's calls: run 1 admitted first, so the calls after it meet a run, then one to five calls drawn. */
export const callsGen: Gen<ReadonlyArray<Call>> = (source) => [
	{ kind: "admit", flow: 1, steps: source.draw(someOf(steps, 2)) },
	...source.draw(array(callGen, { min: 1, max: 5 }))
]

/** The runs, steps, claims and audits stored, as the model holds them: each run open or retired, and each row by its key. */
export interface FlowState {
	readonly flows: ReadonlyMap<number, "open" | "retired">
	readonly steps: ReadonlySet<string>
	readonly claims: ReadonlySet<string>
	readonly audits: ReadonlyMap<number, string>
}

export const emptyState: FlowState = {
	flows: new Map(),
	steps: new Set(),
	claims: new Set(),
	audits: new Map()
}

/** One relation's counts as an accepted call answers them. */
export interface Counted {
	readonly relation: string
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

/**
 * What a call answers, as the model decides it: accepted with every written relation's counts, unchanged, or refused,
 * by a hold of a run that is not open, a law the worker's rows break, or, for a retirement, by an audit referencing a
 * step of a run it retires, the Audit containment named.
 */
export type Answer =
	| { readonly kind: "accepted"; readonly counts: ReadonlyArray<Counted> }
	| { readonly kind: "unchanged" }
	| { readonly kind: "refused"; readonly by: "hold" | "law" | "audit" }

const stepKey = (flow: number, step: number): string => `${flow}:${step}`

const counted = (relation: string, added: bigint, deleted: bigint, put: bigint): Counted => ({
	relation,
	added,
	deleted,
	put
})

/** The answer of counts that are all zero, unchanged, or else accepted with them. */
const answered = (counts: ReadonlyArray<Counted>): Answer =>
	Arr.some(counts, (c) => c.added + c.deleted + c.put > 0n)
		? { kind: "accepted", counts }
		: { kind: "unchanged" }

/**
 * The model of one call, its answer and the state it leaves (README Retirable units):
 *
 * - an admission inserts its run's header, a row already there no change, then its steps, after the hold of its run,
 *   which refuses a retired run: a retired key never starts a fresh run;
 * - a claim holds its run, refused where the run is absent or retired, and is contained in its step;
 * - an audit is contained in its step and keyed by its id;
 * - a retirement retires each open run it names, every step and claim of it removed, its header kept and retired, and is
 *   refused whole where an audit references a step of one; a run absent or retired is no change of it.
 */
export const stepOf = (
	state: FlowState,
	call: Call
): { readonly answer: Answer; readonly state: FlowState } => {
	const unchanged = { answer: { kind: "unchanged" } as const, state }
	const refused = (by: "hold" | "law" | "audit") => ({
		answer: { kind: "refused", by } as const,
		state
	})
	switch (call.kind) {
		case "admit": {
			const run = state.flows.get(call.flow)
			if (run === "retired") {
				return refused("hold")
			}
			const added = Arr.filter(
				Arr.dedupe(call.steps),
				(s) => !state.steps.has(stepKey(call.flow, s))
			)
			const flows = new Map(state.flows)
			flows.set(call.flow, "open")
			return {
				answer: answered([
					counted("Flow", run === undefined ? 1n : 0n, 0n, 0n),
					counted("FlowStep", BigInt(added.length), 0n, 0n)
				]),
				state: {
					...state,
					flows,
					steps: new Set([...state.steps, ...Arr.map(added, (s) => stepKey(call.flow, s))])
				}
			}
		}
		case "claim": {
			if (state.flows.get(call.flow) !== "open") {
				return refused("hold")
			}
			if (!state.steps.has(stepKey(call.flow, call.step))) {
				return refused("law")
			}
			const key = `${stepKey(call.flow, call.step)}:${call.attempt}`
			if (state.claims.has(key)) {
				return unchanged
			}
			return {
				answer: answered([counted("FlowClaim", 1n, 0n, 0n)]),
				state: { ...state, claims: new Set([...state.claims, key]) }
			}
		}
		case "audit": {
			const at = stepKey(call.flow, call.step)
			const held = state.audits.get(call.id)
			if (held !== undefined) {
				return held === at ? unchanged : refused("law")
			}
			if (!state.steps.has(at)) {
				return refused("law")
			}
			const audits = new Map(state.audits)
			audits.set(call.id, at)
			return {
				answer: answered([counted("Audit", 1n, 0n, 0n)]),
				state: { ...state, audits }
			}
		}
		case "retire": {
			const open = Arr.filter(Arr.dedupe(call.flows), (f) => state.flows.get(f) === "open")
			const inRetired = (key: string): boolean =>
				Arr.some(open, (f) => Str.startsWith(`${f}:`)(key))
			if (Arr.some([...state.audits.values()], inRetired)) {
				return refused("audit")
			}
			const flows = new Map(state.flows)
			for (const f of open) {
				flows.set(f, "retired")
			}
			return {
				answer: answered([
					counted("Flow", 0n, 0n, BigInt(open.length)),
					counted("FlowClaim", 0n, BigInt(Arr.filter([...state.claims], inRetired).length), 0n),
					counted("FlowStep", 0n, BigInt(Arr.filter([...state.steps], inRetired).length), 0n)
				]),
				state: {
					...state,
					flows,
					steps: new Set(Arr.filter([...state.steps], (k) => !inRetired(k))),
					claims: new Set(Arr.filter([...state.claims], (k) => !inRetired(k)))
				}
			}
		}
	}
}

export type Feature =
	| "a run admitted"
	| "a step claimed"
	| "a step audited"
	| "a run retired whole"
	| "a retirement of nothing open, unchanged"
	| "a retired run admitted again, refused"
	| "a retired run's step claimed, refused"
	| "a retirement an audit refuses"

/** The features a call notes: what it does, by the model's answer and the state before it. */
export const featuresOf = (
	state: FlowState,
	call: Call,
	answer: Answer
): ReadonlyArray<Feature> => {
	switch (call.kind) {
		case "admit":
			return answer.kind === "refused"
				? ["a retired run admitted again, refused"]
				: answer.kind === "accepted"
					? ["a run admitted"]
					: []
		case "claim":
			return answer.kind === "accepted"
				? ["a step claimed"]
				: state.flows.get(call.flow) === "retired"
					? ["a retired run's step claimed, refused"]
					: []
		case "audit":
			return answer.kind === "accepted" ? ["a step audited"] : []
		case "retire":
			return answer.kind === "refused"
				? ["a retirement an audit refuses"]
				: answer.kind === "accepted"
					? ["a run retired whole"]
					: ["a retirement of nothing open, unchanged"]
	}
}
