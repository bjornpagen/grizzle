/**
 * A stored derived relation's keys lead with the columns its definition carries from a declared key, its computed and
 * value columns after them (analysis/logical/derived.ts inheritedKeys, keyCarried), so a read that binds the columns it
 * takes from its sources' keys binds a prefix of its key, the per-key proof's (cte-policy keyPrefixBound), and an
 * attachment reading it at those columns reads each parent's rows by a seek. Before, a derived relation keyed by its whole
 * heading in heading order led with whatever column sorted first: pantry's MaxAttempts with its computed `attempts`,
 * qti-pie's MaximumNormal with its `maximum`, so metis's session control and credit, each read at a package and path,
 * bound no prefix, were co-grouped and derived whole for every sitting (metis's `sitting` read cancelled at 20 minutes).
 *
 * On PostgreSQL 19, a package's nodes and a derived relation of each scope's allowance, a value computed from a node's raw
 * value, keyed by its whole heading, `allowance` first by name; a child's sessions of a stage, each with its item's
 * allowances attached; a few packages and then a few dozen, its tables in a drawn pg_class state as each load ends
 * (test/support/advice.ts PgClassState), the read run under its carried advice once the plan laws hold over it
 * (advisedRun).
 *
 * Oracle: the plan laws, and a bound: the read's scans read at most three times the child's sessions and their items' allowances, however
 * many packages stand beside them, in every pg_class state.
 *
 * Features: a read beside few packages and beside many; each pg_class state.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type KeyOrderFeature,
	keyOrderGen,
	keyOrderTemplate,
	runKeyOrder
} from "#test/pg/lower-shapes/derived-key-order.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A child's sessions, each with its item's allowances attached, read that child's sessions and their items' allowances
 * alone however many packages stand beside them, in every pg_class state: the attachment seeks the stored allowances at its
 * package and path, a prefix of their key.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDerivedRelationsKeyLeadsWithTheColumnsItCarriesFromASourcesKey = property.explore(
	keyOrderGen,
	{
		needs: { stored: Substrate.rolledBack(keyOrderTemplate) },
		situations: [
			"beside few packages",
			"beside many packages",
			"its tables never vacuumed",
			"its tables counted empty",
			"its tables analyzed",
			"its tables skewed",
			"its tables large"
		] satisfies ReadonlyArray<Reached<KeyOrderFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runKeyOrder(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "the plan laws over the read under its carried advice, and a bound: the read's scans read at most three times the child's sessions and their items' allowances, beside a few packages and beside a few dozen, in every pg_class state"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/logical/derived.ts",
				original: "\tconst keyOrder = isNonEmpty(ordered) ? ordered : heading\n",
				replacement: "\tconst keyOrder = heading\n",
				why: "A derived relation's keys are in heading order, as before: Allowance's leads with the computed allowance, the read binds no prefix of it, and the attachment reads every package's allowances."
			}
		]
	}
)
