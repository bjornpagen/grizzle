/**
 * Keys over a retyped field, and key swaps, generated, on a relation that may hold rows.
 *
 * A key whose definition changes under its own name is built under a swap name and swapped in, and the swap name is
 * never a name ownership registers. A key's name is its constraint's, minted at the naming door from its identity: a
 * candidate key's segments name its relation and its columns, a digest of the identity after them
 * (`__task_key_a_<digest>`, `__task_key_a_next_<digest>`), so its definition changes under its own name only when a
 * field it holds changes type; the primary key's (`__task_pk_<digest>`) names no field, so it changes under its name
 * when it moves to other fields. A swap name is minted from the identity of the key it swaps (identity.swap,
 * `__next_task_key_a_<digest>`): one spelled where a standing name is, the key's own or the key over the same columns
 * and a field named `next`, would have the build's DROP INDEX ... IF EXISTS drop that live key's index. A key over a
 * field retyped in place is no swap: the conversion drops it first, since PostgreSQL would carry it across under its
 * old definition, and it is added again right after the conversion in the same Structure transaction, under the
 * conversion's lock, so it holds at every commit (built concurrently as a new key, it held no row written between
 * Structure and Validate). The relations here have fields named after the words key names are made of (`next`, `ix`,
 * `key`, `pk`), a primary key, a key over the first field, a key over the first two, and a key over the third; one
 * successor retypes the first field from integer to bigint, another moves the primary key to the second and third
 * fields. Properties:
 *
 * - every key over the retyped field is dropped in Structure before the conversion and added again there after it,
 *   under its own name, and never built concurrently or under a swap name;
 * - the moved primary key is built under its swap name and attached under its own name;
 * - every statement a successor's draft drafts names, among the relation's indexes and keys, only those keys and their
 *   swap names;
 * - over the installations of every drawn schema, no swap name of an index or a key is a name the installation
 *   registers, and no registered name lies in the swap names' namespace.
 *
 * Oracle: the properties above, a specification read off the drafted statements' slots and names, and the names each
 * installation registers.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, swaps } from "#test/unit/deploy/swaps.fixtures.ts"

/** Keys over a retyped field, and key swaps add a retyped key again in the conversion's transaction, and build a moved primary key under a swap name no installation registers. Its budget is its suite's before it was a property (test/unit/deploy/swaps.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const keysOverARetypedFieldAndKeySwapsAddARetypedKeyAgainInTheConversionsTransactionAndBuildAMovedPrimaryKeyUnderASwapNameNoInstallationRegisters =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"a key over the retyped field added again",
			"the primary key swapped"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (value) => Effect.sync(() => swaps(c, value)),
		oracle: {
			kind: "specification",
			name: "the drafted statements' slots and names, against the names each installation registers"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: `\t\tmint("swap", [of], ["next", ...nameSegments(of)], \`the next \${of}\`, hashed)`,
				replacement: `\t\tmint("swap", [of], ["next", ...nameSegments(of)], \`the next \${of}\`, readable(of))`,
				why: "A swap name is minted as the name of the key it swaps, a standing name; the property that no swap name is a registered name fails."
			}
		]
	})
