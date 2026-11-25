/**
 * A level's contracts are a fact of its content, read once where schema(...) or schema.extend(...) builds it
 * (schema/levels.ts SchemaContent contracts): every contract a relation of the level or of a level below declares a field
 * by, natural's among them, each with the descriptor ownership holds for it (own.ts Owned contracts), so records(...)
 * types a contract column by its level's content and owns no level (program/records.ts contractsOf). Exhausted over a
 * contract at each place a field holds one: a root relation's field, a base's under an extension that declares none, an
 * extension's, both levels' alike, another contract's base and a span's endpoint.
 *
 * Oracle: ownership's contracts, read off each level's Owned.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { contractsOf, places } from "#test/unit/schema/level-contracts.fixtures.ts"

/** Each level's content holds exactly its ownership's contracts, each by name with the descriptor ownership holds. */
export const aLevelsContentHoldsItsOwnedSchemasContracts = property.exhaust(places, {
	box: "a contract on a root relation's field, a base's under an extension, an extension's, both levels' alike, another contract's base or a span's endpoint",
	needs: {},
	situations: [],
	check: () => (place) =>
		Effect.sync(() => {
			for (const [at, level] of contractsOf(place).entries()) {
				assert.deepEqual(level.held, level.owned, `${place}: schema ${String(at)}`)
			}
		}),
	oracle: {
		kind: "specification",
		name: "ownership's contracts (own.ts Owned contracts), level by level"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/schema/levels.ts",
			original: "visitDeclaredFields(r.desc, (_field, nested) => {",
			replacement: "visitDeclaredFields(r.desc, (_field, _nested, nested) => {",
			why: "A level collects its fields' own descriptors alone, not the contracts inside them: a contract that is another's base, or a span's endpoint, is missing from its content."
		},
		{
			file: "packages/engine/src/schema/levels.ts",
			original:
				"const held = below?.contracts ?? new Map([[naturalContract.name, naturalContract]])",
			replacement: "const held = new Map([[naturalContract.name, naturalContract]])",
			why: "A level holds its own relations' contracts and none of the levels below it: an extension's content is missing its base's contracts."
		}
	]
})
