/** What the properties of binding.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import type { Binding } from "#compiler/runtime/write/binding.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { evaluationOf, hostFillOf } from "#compiler/write/program/decide.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	buildFill,
	type FillSpec,
	fillSpecGen,
	insertedRelations,
	instanceFacts,
	instanceGen,
	type InstanceRow,
	mutableOrDrawn,
	relationName
} from "#test/support/families/fill.ts"
import { bindingAgrees } from "#test/support/oracle/binding.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** The situations a drawn write reaches. */
export type BindingSituation =
	| "a nested write"
	| "a fresh owner's counts drawn"
	| "a write with no family"

export const situations: Arr.NonEmptyReadonlyArray<BindingSituation> = [
	"a nested write",
	"a fresh owner's counts drawn",
	"a write with no family"
]

interface BindingCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
}

export const caseGen: Gen<BindingCase> = (source) => {
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
			patterns: evaluationOf(frontend, fill, program.binding.computed).patterns
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
	return Arr.map(flight.statements, (s) => {
		const executions = value.chunks(s, inForce(bindFrame))
		return executions.ok ? executions.value : { refused: executions.error }
	})
}

export const property = (
	case_: BindingCase,
	note: (s: BindingSituation) => void
): Effect.Effect<void> =>
	Effect.sync(() => {
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
		const members = collectInputs(program.binding.groups, parsedOf(all).inputs)
		const inputs = { members, params: {}, transport: inForce(bindFrame) }
		const wide = widened(program)
		const write = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
		const wideWrite = flightOf(servableWrite(wide), wide.frontend.codes, noAdvice)
		assert.deepEqual(
			sent(write, bindWrite(write, inputs)),
			sent(wideWrite, bindWrite(wideWrite, inputs)),
			"the write binds by its slice as by the whole fill order"
		)
	})
