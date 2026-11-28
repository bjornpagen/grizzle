import { Array as Arr, Effect } from "effect"
import type { CompiledChange } from "#adapter/apply/compile.ts"
import type { HostCall } from "#adapter/apply/run.ts"
import type { CallInputRefused } from "#adapter/errors/failures.ts"
import { readParams } from "#adapter/reader/params.ts"
import {
	type ChangeSetInput,
	type GroupData,
	type MemberFacts,
	memberSlots
} from "#compiler/plan/change.ts"

/**
 * Each member slot the compiled ChangeSet reads with the ChangeSet value's input for it, in slot order. The program was
 * compiled from the value's own Description, so the value holds an input for every slot; the engine's normalization
 * reads each slot's facts through its own one site of that fact (write/normalize), so a slot is paired here only with
 * the input the value holds.
 */
const slotInputs = (
	groups: ReadonlyArray<GroupData>,
	inputs: ReadonlyMap<string, ChangeSetInput>
): ReadonlyArray<readonly [string, ChangeSetInput]> =>
	Arr.flatMap(memberSlots(groups), (member) => {
		const input = inputs.get(member)
		return input === undefined ? [] : [[member, input] as const]
	})

/** The facts of every member slot the compiled ChangeSet reads, from the ChangeSet value's inputs: each array member's
 * facts, by its slot. The program was compiled from the value's own Description, so the value holds an input for every
 * slot. */
export const collectInputs = (
	groups: ReadonlyArray<GroupData>,
	inputs: ReadonlyMap<string, ChangeSetInput>
): MemberFacts => new Map<string, Iterable<unknown>>(slotInputs(groups, inputs))

/**
 * The call of a ChangeSet value compiled in process as the program `program` (run.ts HostCall): the caller's parameters,
 * read by its declared names (reader/params.ts readParams), the value's bound values, and its members' facts
 * (`collectInputs`).
 */
export const changeCall = (
	program: string,
	compiled: CompiledChange,
	params: unknown
): Effect.Effect<HostCall, CallInputRefused> =>
	Effect.map(
		Effect.fromResult(
			readParams(
				program,
				Arr.map(compiled.program.params, (decl) => decl.name),
				params
			)
		),
		(read): HostCall => ({
			params: read,
			bound: compiled.change.values,
			members: collectInputs(compiled.program.binding.groups, compiled.change.inputs)
		})
	)
