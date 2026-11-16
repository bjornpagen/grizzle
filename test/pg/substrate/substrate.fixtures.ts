/** What the property of substrate.test.ts reads: its space, the schemas it draws, and its judgments. */

import { constant, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { rolePrefix } from "#test/support/substrate/names.ts"
import type { SubstrateShape } from "#test/support/substrate/substrate.ts"

/**
 * Who creates a role under a schema's prefix: the substrate (SubstrateShape role), which gives each its own finalizer,
 * or an installation's migration, whose world roles nothing but the schema's release drops.
 */
const creators = ["the substrate", "an installation"] as const

type Creator = (typeof creators)[number]

/** A released schema: the creators of the roles it holds under its prefix when it is released, none for a bare one. */
interface Releasing {
	readonly creators: ReadonlyArray<Creator>
}

export const releasingGen: Gen<Releasing> = (source) => ({
	creators: source.draw(subarray(creators))
})

/** What a released schema held: a role each creator made, roles of both in one schema, or no role. */
export type ReleaseFeature = `a role ${Creator} created` | "roles of both creators" | "no role"

/** The creators a steered case gives its schema to reach each feature (releaseAims). */
const reaching: Readonly<Record<ReleaseFeature, ReadonlyArray<Creator>>> = {
	"a role the substrate created": ["the substrate"],
	"a role an installation created": ["an installation"],
	"roles of both creators": creators,
	"no role": []
}

/** Every situation the released-roles property requires, the order a steered case's turn aims at them in. */
export const releaseFeatures = [
	"a role the substrate created",
	"a role an installation created",
	"roles of both creators",
	"no role"
] as const satisfies ReadonlyArray<ReleaseFeature>

/** Each feature, with the schema a case whose turn aims at it releases (aimed): one its creators reach. */
export const releaseAims: ReadonlyArray<readonly [ReleaseFeature, Gen<Releasing>]> = Arr.map(
	releaseFeatures,
	(feature) => [feature, constant({ creators: reaching[feature] })] as const
)

/** Every role on the substrate's member whose name starts with the prefix of the allocated schema name `schema`. */
export const rolesUnder = (s: SubstrateShape, schema: string) =>
	Effect.map(
		s.admin.queryValues(
			"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY 1",
			[rolePrefix(schema)]
		),
		(rows) => Arr.map(rows, ([role]) => String(role))
	)
