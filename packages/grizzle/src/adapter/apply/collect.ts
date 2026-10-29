import { Array as Arr, Effect, Stream } from "effect"
import { InputTooLarge } from "#adapter/errors/failures.ts"
import type { ChangeSetInput } from "#compiler/write/changeset/value.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { type MemberFacts, memberSlots } from "#compiler/write/normalize/normalize.ts"

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
 * A Stream member travels by the recordset path like an array: it is collected on the host up to `maxRows` facts
 * (`recordsetMaxRows` in production), counted as received, before deduplication, and one fact more is the relation input
 * past the size limit, InputTooLarge, raised after reading at most the bound plus one, so
 * host memory stays bounded. A Stream member has no error or requirement channel: the caller handled its failures and
 * provided its services before it became a member, so a caller's retry after a TransientFailure replays it here. The
 * engine receives arrays only. */
export const collectInputs = (
	frontend: WriteFrontend,
	inputs: ReadonlyMap<string, ChangeSetInput>,
	maxRows: number
): Effect.Effect<MemberFacts, InputTooLarge> =>
	Effect.map(
		Effect.forEach(slotInputs(frontend, inputs), ([member, input]) => {
			if (input.kind === "array") {
				return Effect.succeed([member, input.facts] as const)
			}
			return Effect.flatMap(Stream.runCollect(Stream.take(input.stream, maxRows + 1)), (facts) =>
				facts.length > maxRows
					? Effect.fail(InputTooLarge.make())
					: Effect.succeed([member, facts] as const)
			)
		}),
		(entries): MemberFacts => new Map<string, Iterable<unknown>>(entries)
	)
