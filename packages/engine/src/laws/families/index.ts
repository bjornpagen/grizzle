import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ResidualLaw } from "#compiler/ir/law.ts"
import { alternativesFamily } from "#compiler/laws/families/alternatives/index.ts"
import { capacityFamily } from "#compiler/laws/families/capacity/index.ts"
import { coverageFamily } from "#compiler/laws/families/coverage/index.ts"
import type { FamilyAt, FamilyUnit } from "#compiler/laws/families/plugin.ts"

/** Each participant of a residual law with its family's steps 2 and 3 for it, in law order, installed `at`.
 *
 * The residual-family dispatch: each admitted family to the plug-in directory that owns it: alternatives reverse,
 * scalar-group capacity and selected-source coverage. This dispatch is written once; a family's implementation lives
 * in its directory and never edits this file. */
export const familyUnits = (
	law: ResidualLaw,
	at: FamilyAt
): NonEmptyReadonlyArray<{
	readonly participant: ResidualLaw["participants"][number]
	readonly unit: FamilyUnit
}> => {
	switch (law.family) {
		case "alternativesReverse": {
			const unit = alternativesFamily({ ...at, law })
			return mapNonEmpty(law.participants, (participant) => ({
				participant,
				unit: unit(participant)
			}))
		}
		case "scalarCapacity": {
			const unit = capacityFamily({ ...at, law })
			return mapNonEmpty(law.participants, (participant) => ({
				participant,
				unit: unit(participant)
			}))
		}
		case "selectedSourceCoverage": {
			const unit = coverageFamily({ ...at, law })
			return mapNonEmpty(law.participants, (participant) => ({
				participant,
				unit: unit(participant)
			}))
		}
	}
}
