import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import type { Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { boundedShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import type { Binding } from "#compiler/runtime/write/binding.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { legacyFlights, runnableWrite } from "#compiler/write/program/bind.ts"
import { compileWrite, type CompiledWrite } from "#compiler/write/program/compile.ts"
import { evaluationOf, hostFillOf } from "#compiler/write/program/decide.ts"
import { servedWrite } from "#compiler/write/program/served.ts"
import { assert, defined } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	buildFill,
	type FillSpec,
	fillSpecGen,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	mutableOrDrawn,
	relationName
} from "#test/support/families/fill.ts"
import { caseHang } from "#test/support/limits.ts"
import { bindingAgrees } from "#test/support/oracle/binding.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A compiled write binds by what its compile decided, never by the law model (runtime/write/binding.ts Binding). Over
 * drawn schemas of trees, ordered and counted families nested in each other, folds and copies (test/support/families/
 * fill.ts), and an instance of each inserted whole:
 *
 * - **Every judgment the binding holds is the law model's** (test/support/oracle/binding.ts): each member slot's
 *   proposal, each in-flight stratum's fresh owners, each written relation's stated and primary fields, row layout and
 *   owned counts and ends, and a fill that holds exactly the layouts its walks and fresh fills meet.
 * - **The slice binds as the whole does**: the write bound by its binding and bound by one whose fill is every layout
 *   of the schema's fill order and whose evaluator reads every closed relation send the same statements with the same
 *   placeholder texts, or refuse alike, so nothing the slice leaves out is one the write reads.
 * - **A served write binds without its front end as the planner binds it with it**: a write a served file holds
 *   (write/program/served.ts servedWrite), bound from its flight alone, sends what the read-flight planner over its
 *   compiled front end sends, or refuses alike (runtime/write/bind.ts RunnableWrite).
 *
 * Features: a nested write, a fresh owner's counts drawn, a write with no family.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): binding-fill-without-fresh, a fill that misses the layouts a fresh
 * owner's fill meets.
 */

/** The situations a drawn write reaches. */
type BindingSituation = "a nested write" | "a fresh owner's counts drawn" | "a write with no family"

const situations: Arr.NonEmptyReadonlyArray<BindingSituation> = [
	"a nested write",
	"a fresh owner's counts drawn",
	"a write with no family"
]

interface BindingCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
}

const caseGen: Gen<BindingCase> = (source) => {
	const spec = source.draw(mutableOrDrawn(fillSpecGen({ relations: 4, families: 4, copies: 3 })))
	return { spec, rows: source.draw(instanceGen(spec)) }
}

/** A ChangeSet over `value` inserting each relation of `facts`, in the specification's relation order. */
const insertAll = (
	value: unknown,
	built: ReturnType<typeof buildFill>,
	facts: ReadonlyMap<number, ReadonlyArray<unknown>>,
	inserted: ReadonlyArray<number>
): ChangeSetValue =>
	Arr.reduce(inserted, ChangeSet.empty(value), (cs, r) =>
		cs.insert(
			defined(built.relations[relationName(r)], `the relation ${relationName(r)}`),
			facts.get(r) ?? []
		)
	)

/** `program` with a binding whose fill is every layout of its schema's fill order and whose evaluator reads every
 * closed relation of its schema, prepared as any binding is. */
const widened = (program: CompiledWrite): CompiledWrite => {
	const frontend = program.frontend
	const order = frontend.laws.theory.fill
	const fill = hostFillOf(
		order,
		Arr.map([...order.layouts.values()], (l) => ({
			relation: l.relation.name,
			position: l.position
		}))
	)
	const binding: Binding = {
		...program.binding,
		fill,
		evaluation: {
			closed: [...frontend.schema.closed.keys()],
			patterns: evaluationOf(frontend, fill).patterns
		}
	}
	return { ...program, binding }
}

/** What a bound write sends: every statement's executions' placeholder texts, or its refusal. */
const sent = (flight: FlightWrite, bound: ReturnType<typeof bindWrite>): unknown => {
	if (!bound.ok) {
		return { refused: bound.error }
	}
	const value = bound.value
	if (value.kind !== "bound") {
		return value
	}
	const flights = value.flights
	if (flights.kind !== "write") {
		return { reads: Arr.map(flights.reads, (r) => r.params) }
	}
	return Arr.map(flight.statements, (s) => {
		const executions = flights.chunks(s, inForce(bindFrame))
		return executions.ok ? executions.value : { refused: executions.error }
	})
}

const property = (case_: BindingCase, note: (s: BindingSituation) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { spec, rows } = case_
		const built = buildFill(spec)
		const value = built.rename("Fill")
		const artifacts = testArtifacts(value, testCompile)
		if (!artifacts.ok) {
			return
		}
		const all = insertAll(value, built, instanceFacts(spec, rows), insertedRelations(spec))
		const compiled = compileWrite(checking(value), descOf(all), realityWrite(artifacts.value))
		if (!compiled.ok) {
			return
		}
		const program = compiled.value
		bindingAgrees(program.frontend, program.binding)
		note(
			program.binding.nested.length > 0
				? "a nested write"
				: Arr.some(program.binding.fresh, (f) => f.counted.length > 0)
					? "a fresh owner's counts drawn"
					: "a write with no family"
		)
		const members = yield* collectInputs(program.binding.groups, parsedOf(all).inputs)
		const inputs = { members, params: {}, transport: inForce(bindFrame) }
		const wide = widened(program)
		const write = runnableWrite(program, program.frontend.codes)
		const wideWrite = runnableWrite(wide, wide.frontend.codes)
		assert.deepEqual(
			sent(write.flight, bindWrite(write, inputs)),
			sent(wideWrite.flight, bindWrite(wideWrite, inputs)),
			"the write binds by its slice as by the whole fill order"
		)
		if (servedWrite(program).ok) {
			assert.deepEqual(
				sent(write.flight, bindWrite(write, inputs)),
				sent(
					write.flight,
					bindWrite({ flight: write.flight, flights: legacyFlights(program) }, inputs)
				),
				"a served write binds in its one flight as the read-flight planner binds it"
			)
		}
	})

describe("a compiled write's binding", () => {
	it.effect("holds the law model's judgments, and binds by its slice as by the whole", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/write/program/binding",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<BindingSituation>(situations, { cases: 120, sense: notesOnly }),
					kept: [],
					runs: 60,
					shrink: boundedShrink(200),
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					oracle: {
						kind: "second-implementation",
						name: "the law model's own judgments of a binding (oracle/binding.ts) and the binding over the whole fill order"
					}
				},
				(c, at) => property(c, (s) => at.note(s))
			)
		)
	)
})
