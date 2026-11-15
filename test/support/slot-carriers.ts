import { Array as Arr, String as Str } from "effect"
import type { ParamId } from "#compiler/core/ids.ts"
import type { MemberParamSlot } from "#compiler/lower/conservative/types.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"
import { relationAccess } from "#compiler/sql/access.ts"
import type { ArtifactStatement, WriteArtifact } from "#compiler/write/program/artifact.ts"

/**
 * Each carrier of `artifact` a staged member slot fills (write/program/slot-carriers.ts), by name: the member placeholder
 * its fill binds first, which names the slot and its relation. A carrier filled from anything else, a described member,
 * a shared sub-query, a snapshot or a delta, binds no member placeholder and is none of them.
 */
export const slotCarriers = (artifact: WriteArtifact): ReadonlyMap<string, MemberParamSlot> =>
	new Map(
		Arr.flatMap(artifact.statements, (s): ReadonlyArray<readonly [string, MemberParamSlot]> => {
			const [first] = s.spec.paramSlots
			return s.step.kind === "carrier" && s.step.step === "fill" && first?.kind === "member"
				? [[s.step.carrier, first]]
				: []
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
	const carried = Arr.flatMap([...relationAccess(statement.ast).reads], (name) => {
		const slot = carriers.get(name)
		return slot === undefined ? [] : [slot]
	})
	return new Map(Arr.map([...own, ...carried], (s) => [s.slot, s] as const))
}

/**
 * The carriers a loaded flight's staged member slots fill (write/program/slot-carriers.ts), by name: each carrier step's
 * carrier whose fill binds a member slot's placeholders, as `slotCarriers` reads a compiled artifact's.
 */
export const flightSlotCarriers = (flight: FlightWrite): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(flight.statements, (s) =>
			s.step.kind === "carrier" && s.step.step === "fill" && s.form.paramSlots[0]?.kind === "member"
				? [s.step.carrier]
				: []
		)
	)

/**
 * The prepared names of every text of a loaded flight that names one of the carriers `carriers`, as a quoted identifier:
 * each such carrier's creation and fill, its ANALYZE, and each statement that reads it.
 */
export const textsNaming = (
	flight: FlightWrite,
	carriers: ReadonlySet<string>
): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(flight.statements, (s) =>
			Arr.flatMap(
				[s.form.text, ...(s.forms.kind === "chosen" ? [s.forms.large.text] : [])],
				(text) =>
					Arr.some([...carriers], (c) => Str.includes(`"${c}"`)(text.sql)) ? [text.name] : []
			)
		)
	)
