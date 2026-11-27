import { Array as Arr } from "effect"
import type { ParamId } from "#compiler/core/ids.ts"
import type { MemberParamSlot } from "#compiler/lower/conservative/types.ts"
import type { ArtifactStatement, WriteArtifact } from "#compiler/write/program/artifact.ts"
import { carrierReads } from "#test/support/carrier-reads.ts"

/**
 * Each carrier of `artifact` a staged member slot fills (write/program/slot-carriers.ts), by name: the member placeholder
 * its fill binds first, which names the slot and its relation. A carrier filled from anything else, a described member,
 * a shared sub-query, a snapshot or a delta, binds no member placeholder and is none of them.
 */
export const slotCarriers = (artifact: WriteArtifact): ReadonlyMap<string, MemberParamSlot> =>
	new Map(
		Arr.flatMap(artifact.statements, (s): ReadonlyArray<readonly [string, MemberParamSlot]> => {
			const [first] = s.spec.paramSlots
			return s.step.kind === "carrier" && first?.kind === "member" ? [[s.step.carrier, first]] : []
		})
	)

/**
 * The member slots `statement` of `artifact` reads, by slot: each its own placeholders bind, and each a staged carrier
 * it reads holds (`slotCarriers`), a carrier's own fill reading none through it.
 */
export const slotsRead = (
	artifact: WriteArtifact,
	statement: ArtifactStatement
): ReadonlyMap<ParamId, MemberParamSlot> => {
	const carriers = slotCarriers(artifact)
	const own = Arr.flatMap(statement.spec.paramSlots, (s) => (s.kind === "member" ? [s] : []))
	const carried = Arr.flatMap([...carrierReads(statement.ast)], (name) => {
		const slot = carriers.get(name)
		return slot === undefined ? [] : [slot]
	})
	return new Map(Arr.map([...own, ...carried], (s) => [s.slot, s] as const))
}
