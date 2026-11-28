/** What level-reading.test.ts reads: the levels of a storage case, a chain of them, and each one's two readings. */

import { defined } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type CheckedSchema, checkedReality, checkedSchema } from "#compiler/analysis/schema.ts"
import { schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { owning } from "#test/support/policy.ts"
import {
	type StorageCase,
	storageCase,
	storageSchemaOf
} from "#test/support/unit/derived/storage.fixtures.ts"

/**
 * A case: a storage case (test/support/unit/derived/storage.fixtures.ts), its base and above it the derived relation of its
 * shape, one level, and `above` levels over that one, one over another, each declaring nothing of its own, the highest
 * the installation: each level a prefix of the installation's chain, as metis's logins' levels are of its schema's, all
 * sharing the base.
 */
export interface LevelCase {
	readonly storage: StorageCase
	readonly above: number
}

export const levelCaseGen: Gen<LevelCase> = (s) => ({
	storage: s.draw(storageCase),
	above: s.draw(int(1, 3))
})

/** A case's levels, the storage case's top first, then each level above it, the installation last. */
const levelsOf = (c: LevelCase) => {
	const { top } = storageSchemaOf(c.storage)
	const first = schema.extend([top], "LevelAbove1", [], [])
	const second = schema.extend([first], "LevelAbove2", [], [])
	const third = schema.extend([second], "LevelAbove3", [], [])
	const chain = [top, first, second, third] as const
	const levels = chain.slice(0, c.above + 1)
	return { levels, installation: defined(levels[levels.length - 1], "the installation") }
}

/** A level's checked schema read both ways: analyzed alone, and within its installation's checked schema. */
export interface LevelReadings {
	readonly analyzed: CheckedSchema
	readonly within: CheckedSchema
}

/** The installation's checked schema, and each level's two readings (`LevelReadings`), in the case's order. */
export const readingsOf = (
	c: LevelCase
): { readonly installation: CheckedSchema; readonly levels: ReadonlyArray<LevelReadings> } => {
	const { levels, installation } = levelsOf(c)
	const owned = owning(installation)
	const installed = succeeded(checkedSchema(owned), "the installation's checked schema")
	return {
		installation: installed,
		levels: Arr.map(levels, (level) => {
			const levelOwned = owning(level)
			return {
				analyzed: succeeded(checkedSchema(levelOwned), "the level analyzed alone"),
				within: succeeded(
					checkedReality(levelOwned, new Set(), { kind: "within", installation: installed }),
					"the level read within its installation"
				)
			}
		})
	}
}

/**
 * What a reading holds of its relations, each by what identifies it, in the reading's order: its ordinary, closed and
 * stored relations by name, each canonical relation by its digest, subject, placement and holding, each holding by its
 * relation's name and kind, and each stored derived relation's analysis by its name.
 */
export const readingOf = (c: CheckedSchema) => ({
	relations: [...c.relations.keys()],
	closed: [...c.closed.keys()],
	stored: Arr.map(c.stored, (r) => r.name),
	canonical: Arr.map(
		[...c.canonical.values()],
		(r) => `${r.digest} ${r.subject.name} at ${r.subject.level} ${r.holding.kind}`
	),
	holdings: Arr.map([...c.holdings], ([name, h]) => `${name} ${h.kind}`),
	derived: Arr.map(c.derived, (a) => a.name)
})
