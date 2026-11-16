/**
 * The role prefix, used verbatim (core/identity.ts parseRolePrefix, roleInSpace), with no database.
 *
 * A prefix names an installation's roles in the cluster: `<prefix>__<stem>`, exactly as its connection gives it, never
 * converted as a declared name, so `qti_pie_v2` stays `qti_pie_v2`.
 *
 * Properties, each against the specification spelled here apart from the code under test (arkregex over the text):
 * - Verbatim: for a drawn valid prefix, lowercase words and digit runs joined by single underscores, perhaps led or
 *   ended by one, and a drawn stem, two conversions joined by `__`, that fit 63 bytes together, the prefix parses to
 *   itself and the installed role is exactly `prefix + "__" + stem`.
 * - Refused: a drawn text over lowercase and uppercase letters, digits, `_`, `-` and a space, of zero to 70
 *   characters, perhaps led by `pg_`, or a run of `q` exactly at the budget or one byte past it, parses exactly when
 *   the specification admits it: `[a-z_][a-z0-9_]*`, no `__`, not led by `pg_`, and short enough that the longest
 *   hashed role name, `__aside_` and a ten-character digest, fits under it in 63 bytes (`<prefix>__<name>`), so at most
 *   63 - 2 - 18 = 43 bytes; every other text is refused.
 *
 * Features: a digit inside a word, a leading underscore, a trailing underscore; refused for a character, a leading
 * digit, a `__`, `pg_`, emptiness and length; a prefix at the budget, and one byte past it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	refusedCase,
	type RefusedFeature,
	textGen,
	validCase,
	type ValidFeature,
	validGen
} from "#test/unit/core/role-prefix.fixtures.ts"

/** The role prefix, used verbatim installs every drawn valid prefix, digits and single underscores and all, as exactly prefix, __ and the stem. Its budget is its suite's before it was a property (test/unit/core/role-prefix.test.ts at 4ca3036a): 256 runs and 32 steered cases. */
export const theRolePrefixUsedVerbatimInstallsEveryDrawnValidPrefixDigitsAndSingleUnderscoresAndAllAsExactlyPrefixAndTheStem =
	property.explore(validGen, {
		needs: {},
		budget: { runs: 256, steered: 32 },
		situations: [
			"a digit inside a word",
			"a leading underscore",
			"a trailing underscore"
		] satisfies ReadonlyArray<Reached<ValidFeature>>,
		check: (_, c: Case<ValidFeature>) => (value) => validCase(value, c),
		oracle: { kind: "specification", name: "`<prefix>__<stem>`, the prefix as given" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: `\tconst role = \`\${space.prefix}\${roleSeparator}\${name}\``,
				replacement: `\tconst role = \`\${conversionOf(space.prefix)}\${roleSeparator}\${name}\``,
				why: "roleInSpace converts the prefix as a declared name, so `qti_pie_v2` installs as `qti_pie_v_2`; the verbatim property fails."
			}
		]
	})

/** The role prefix, used verbatim parses a drawn text as a prefix exactly when it is a lowercase identifier segment with no __, not led by pg_, within the 43 bytes the longest hashed role name leaves, and refuses every other. Its budget is its suite's before it was a property (test/unit/core/role-prefix.test.ts at 4ca3036a): 256 runs and 32 steered cases. */
export const theRolePrefixUsedVerbatimParsesADrawnTextAsAPrefixExactlyWhenItIsALowercaseIdentifierSegmentWithNoNotLedByPgWithinThe43BytesTheLongestHashedRoleNameLeavesAndRefusesEveryOther =
	property.explore(textGen, {
		needs: {},
		budget: { runs: 256, steered: 32 },
		situations: [
			"a prefix",
			"a character",
			"a leading digit",
			"a double underscore",
			"pg_ first",
			"empty",
			"too long",
			"a prefix at the budget",
			"a prefix one byte past the budget"
		] satisfies ReadonlyArray<Reached<RefusedFeature>>,
		check: (_, c: Case<RefusedFeature>) => (value) => refusedCase(value, c),
		oracle: {
			kind: "specification",
			name: "[a-z_][a-z0-9_]*, no __, not led by pg_, at most 63 - 2 - |__aside_<digest>| bytes"
		},
		kept: [],
		kills: []
	})
