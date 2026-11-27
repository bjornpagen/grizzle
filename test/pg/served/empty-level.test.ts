/**
 * A read of no relation is written over the empty level (schema.empty), which every role holds whole, so the role
 * serving it holds nothing for it, as den's role serves a schedule's input derived from its key while it holds nothing
 * of the app's base: on PostgreSQL 19, a role holding Hour alone, over an app whose base and a level declaring no
 * relation of its own over it hold Want, serves the read of its two parameters over the empty level and the commit of
 * its rows into Hour, and holds SELECT on no relation of the base's level; and a workload over it of a read of Want over
 * that level is refused, as a level that declares nothing over the base is no empty level.
 *
 * Den's census of a root derived from its key, a rule over its role matching the read over the empty level bound by
 * the request's own parameters, is a source over a level of the role's, the empty level, which the rule's match admits
 * as schema/levels.ts isLevelOf does: it commits the key's row into Hour.
 *
 * Oracle: PostgreSQL itself, its privileges (has_table_privilege over the base's level) and its acceptance of every
 * served statement, each answering the key's row; and the level rule's refusal of the workload.
 *
 * The box, exhausted: the read, the commit and the census, each with its read back, and the refused read over the level
 * of no relation.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	calls,
	type EmptyLevelFeature,
	emptyLevelCase
} from "#test/pg/served/empty-level.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A read of no relation runs on a role holding nothing of the base, which holds no level beyond it. */
export const aReadOfNoRelationRunsOnARoleHoldingNothingOfTheBaseWhichHoldsNoLevelBeyondIt =
	property.exhaust(finite(calls), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"the read of no relation by a role holding nothing of the base",
			"the commit of its rows by a role holding nothing of the base",
			"the census of its rows by a role holding nothing of the base",
			"a read over a level declaring nothing of its own, refused by a role holding nothing of the base"
		] satisfies ReadonlyArray<Reached<EmptyLevelFeature>>,
		check:
			({ substrate }, c: Case<EmptyLevelFeature>) =>
			(call) =>
				Effect.provideServiceEffect(
					emptyLevelCase(call, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's privileges over the base's level and its acceptance of every served statement, and the level rule's refusal"
		},
		box: "the read of no relation, the commit of its rows and den's census of them, each with their read back, and a read of the base's relation over a level of it declaring nothing of its own",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/levels.ts",
				original: "\treturn sameLevel(emptyLevel, lower)\n",
				replacement: "\treturn false\n",
				why: "No level holds the empty level below its root (K1): den's workload of the read over schema.empty is refused as the installation is built."
			},
			{
				file: "packages/engine/src/schema/levels.ts",
				original: "\treturn sameLevel(emptyLevel, lower)\n",
				replacement: "\treturn lower.relations.size === 0 && lower.statements.size === 0\n",
				why: "The empty level told by a level's own relations alone (K2): Thin, which declares nothing over the base, is taken for it, so den's workload of a read of Want over Thin is admitted where it is refused."
			}
		]
	})
