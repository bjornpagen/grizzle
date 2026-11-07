import { Array as Arr, Effect, Stream } from "effect"
import {
	type ChangeSetInput,
	type MemberFacts,
	memberSlots,
	type WriteFrontend
} from "#compiler/plan/change.ts"

/**
 * Each member slot the compiled ChangeSet reads with the ChangeSet value's input for it, in slot order. The program was
 * compiled from the value's own Description, so the value holds an input for every slot; the engine's normalization
 * reads each slot's facts through its own one site of that fact (write/normalize), so a slot is paired here only with
 * the input the value holds.
 */
const slotInputs = (
	frontend: WriteFrontend,
	inputs: ReadonlyMap<string, ChangeSetInput>
): ReadonlyArray<readonly [string, ChangeSetInput]> =>
	Arr.flatMap(memberSlots(frontend), (member) => {
		const input = inputs.get(member)
		return input === undefined ? [] : [[member, input] as const]
	})

/** The facts of every member slot the compiled ChangeSet reads, from the ChangeSet value's inputs. The program was
 * compiled from the value's own Description, so the value holds an input for every slot.
 * A Stream member travels as its arrays like an array: it is collected on the host, whole, before any SQL, since host
 * normalization reads every fact before the transaction begins. A Stream member has no error or requirement channel:
 * the caller handled its failures and provided its services before it became a member, so a caller's retry after a
 * TransientFailure replays it here. The engine receives arrays only. */
export const collectInputs = (
	frontend: WriteFrontend,
	inputs: ReadonlyMap<string, ChangeSetInput>
): Effect.Effect<MemberFacts> =>
	Effect.map(
		Effect.forEach(slotInputs(frontend, inputs), ([member, input]) =>
			input.kind === "array"
				? Effect.succeed([member, input.facts] as const)
				: Effect.map(Stream.runCollect(input.stream), (facts) => [member, facts] as const)
		),
		(entries): MemberFacts => new Map<string, Iterable<unknown>>(entries)
	)
