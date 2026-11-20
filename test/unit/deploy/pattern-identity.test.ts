/**
 * Patterns by language: a Compute.matches pattern is its pattern value, its language's key beside its spelling
 * (ir/pattern.ts PatternValue), and its spelling is no part of any identity (core/canonical.ts omitSourceLocs). So a
 * schema whose every match, guard, keyed selection, containment and derived relation reads a pattern installs the same
 * theory, every law under the same identifier with the same check identity, every relation's record and its schema's
 * fingerprint, and the same objects by kind and identifier, under any spelling of the pattern's language; a spelling of
 * another language identifies them otherwise. Each spelling's own SQL is what PostgreSQL reads: its ARE stands in what
 * the installation installs.
 *
 * The oracle is a specification: two installations are one by identity exactly when their patterns' language keys are
 * equal. The space: a pattern admitted over each family's alphabet (test/unit/text/generators.ts), written again in a
 * group, beside an empty piece, as an alternation of itself, or beside a code point no alphabet holds.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	identityOf,
	installedOf,
	installsAreOf,
	type Respelling,
	respellings,
	spellingCases
} from "#test/unit/deploy/pattern-identity.fixtures.ts"

type Feature = Respelling | "one language, two spellings" | "two languages"

/** Two spellings of one pattern install one identity exactly when they spell one language. */
export const twoSpellingsOfAPatternInstallOneIdentityExactlyWhenTheySpellOneLanguage =
	property.explore(spellingCases, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			...respellings,
			"one language, two spellings",
			"two languages"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				c.note(s.respelling)
				const first = installedOf(s.first)
				const second = installedOf(s.second)
				const oneLanguage = s.first.pattern === s.second.pattern
				c.note(oneLanguage ? "one language, two spellings" : "two languages")
				if (oneLanguage) {
					assert.deepEqual(
						identityOf(second.snapshot),
						identityOf(first.snapshot),
						`/${s.second.spelling}/ installs what /${s.first.spelling}/ does, one language`
					)
				} else {
					assert.notDeepEqual(
						identityOf(second.snapshot).theory.laws,
						identityOf(first.snapshot).theory.laws,
						`/${s.second.spelling}/ identifies its laws otherwise than /${s.first.spelling}/`
					)
				}
				assert.ok(
					installsAreOf(second.installation, s.second),
					`the installation reads the ARE of its own spelling, /${s.second.spelling}/`
				)
			}),
		oracle: {
			kind: "specification",
			name: "two installations one by identity exactly when their patterns' language keys are equal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					'\t\t(value["kind"] === "every" || value["kind"] === "refined")) ||\n\t(key === "spelling" && typeof value === "string")',
				replacement: '\t\t(value["kind"] === "every" || value["kind"] === "refined"))',
				why: "Identity by text: a pattern's spelling is part of every identity, so two spellings of one language are two laws, two checks and two derived relations, and every law over the pattern is identified anew."
			}
		]
	})
