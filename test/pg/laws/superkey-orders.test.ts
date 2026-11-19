/**
 * The keys of one relation, declared or a reference's, over the same columns in different orders, against PostgreSQL
 * 19's catalog and its foreign keys. A key holds apart rows equal at a set of columns, whatever order it lists them in
 * (ir/law.ts KeyColumnSet), and PostgreSQL matches a foreign key's referenced columns to a unique index in any order
 * (tablecmds.c transformFkeyCheckAttrs), so a relation holds one key per column set: a containment into a superkey of
 * its target's key needs a UNIQUE over the target's columns, and a fixed target, whose selection fixes a field by a
 * literal beyond its terms, one over its terms and then that field, which its sources meet by a constant each, or one
 * over its own columns, each term generated under its selection, whichever adds fewer objects to the whole schema
 * (laws/model/plan.ts; test/unit/laws/model/probed-target.test.ts judges that choice); each over a set a declared key
 * or an earlier plan states is that key, in its order (laws/model/model.ts nativeIdentity); and a declared key over the
 * set of another key of its relation is refused (schema/own.ts distinctKeys).
 *
 * A case draws T, keyed by `k` over `a`, `b` and `c`, up to two declared keys of T over some of its columns in any
 * order, and two to four references into T, each from a source relation of its own: a superkey reference over `k` and
 * some of the other fields, in any order, or a fixed target over the same, one of the other fields fixed by a literal
 * and the rest its terms in any order. Properties, the specification turned into a checker over the installed catalog
 * and PostgreSQL's verdicts:
 *
 * - the schema compiles exactly when no two of T's keys, its primary key and its distinct declared keys, are over one
 *   column set, and is refused MalformedDescription otherwise;
 * - each source holds one foreign key into T, a superkey reference's over its set and a fixed target's over its terms
 *   and its fixed field or over its own columns;
 * - T holds one unique index per column set, its primary key's, each declared key's and each set a reference's foreign
 *   key lands on, and no other;
 * - every foreign key into T lands on exactly one unique index over its referenced columns, as a set;
 * - each reference's foreign key holds: a source row meeting a row of T commits, all at once, and a source row naming a
 *   key T does not hold is refused by that reference's own foreign key (23503).
 *
 * Every install also passes the installed-catalog checker (test/support/catalog/installed.ts indexProblems), which
 * every suite's install runs: no two unique indexes of a table over one method and column set.
 *
 * And a migration that moves a kept foreign key off the UNIQUE it landed on: S1 references T over (k, a, b) throughout,
 * and a reference of S0's over the same columns, a superkey or a fixed target, which the law model reads first, is added
 * and then dropped, so the one UNIQUE over the set takes S0's order and then S1's again. PostgreSQL bound S1's foreign
 * key to the index it found when it was added, and refuses to drop that index under it (2BP01), so each step drops it
 * only after rebinding the foreign key (deploy/diff/diff.ts rebind). The box: S0's reference over (k, a, b) in every
 * order, a superkey or a fixed target fixing a or b, the walk drafted and applied through the real runner with rows in
 * every table, each apply admitted by the drift check and the installed-catalog checker, the migrated catalog equal to a
 * fresh install of each step, and S1's foreign key refusing a row naming no row of T after every step. T's table is
 * read by the name the installation gives it.
 *
 * Features: two references over one set in two orders, a fixed target and a superkey reference over one set,
 * references over two sets, a declared key and a reference over one set, a fixed target referenced at its own columns,
 * a clash refused, a source row committed and one refused by its own foreign key; the walk must move a kept foreign key
 * off the UNIQUE it landed on.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aims,
	drawnGen,
	type Feature,
	referencesCase,
	secondGen,
	walkCase
} from "#test/pg/laws/superkey-orders.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * References into one relation's superkeys in different orders one unique index per column set, every reference's foreign key landing on it and holding.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/laws/superkey-orders.test.ts at d8eed1786).
 */
export const referencesIntoOneRelationsSuperkeysInDifferentOrdersOneUniqueIndexPerColumnSetEveryReferencesForeignKeyLandingOnItAndHolding =
	property.explore(aimed(drawnGen, aims), {
		needs: { substrate: Substrate.installing },
		situations: [
			"two references over one set in two orders",
			"a fixed target and a superkey reference over one set",
			"references over two sets",
			"a declared key and a reference over one set",
			"a fixed target referenced at its own columns",
			"a declared key over the set of another key of T refused",
			"a source row meeting T committed",
			"a source row naming no row of T refused by its own foreign key"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, cx: Case<Feature>) =>
			(d) =>
				Effect.provideServiceEffect(
					Effect.scoped(referencesCase(d, cx.note)),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the keys T declares and its references' sets, against its installed unique indexes and PostgreSQL's foreign-key verdicts"
		},
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	})

/**
 * References into one relation's superkeys in different orders a migration moves a kept foreign key off the UNIQUE it landed on when the set's order changes.
 */
export const referencesIntoOneRelationsSuperkeysInDifferentOrdersAMigrationMovesAKeptForeignKeyOffTheUNIQUEItLandedOnWhenTheSetsOrderChanges =
	property.exhaust(finite(secondGen), {
		needs: { substrate: Substrate.installing },
		situations: ["a kept foreign key moved off the UNIQUE it landed on"] satisfies ReadonlyArray<
			Reached<"a kept foreign key moved off the UNIQUE it landed on">
		>,
		check:
			({ substrate }, c: Case<"a kept foreign key moved off the UNIQUE it landed on">) =>
			(second) =>
				Effect.provideServiceEffect(Effect.scoped(walkCase(second, c.note)), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "the drift check and catalog checker after every apply, a fresh install's catalog, and S1's foreign key refusing a row naming no row of T"
		},
		box: "S0's reference over S1's columns (k, a, b) in every order, a superkey or a fixed target fixing a or b, added and dropped again",
		kept: [],
		kills: []
	})
