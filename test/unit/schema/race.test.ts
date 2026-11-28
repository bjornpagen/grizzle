/**
 * race(R) at the schema door (schema/own.ts): a race over an ordinary relation's primary key owns exactly where an
 * insertion at that key can meet a row that differs from it and deliver that row, and is refused with
 * MalformedDescription everywhere else. The box is every race of a space: over an ordinary relation whose primary key
 * has a payload beside it, is its whole heading, holds a span or holds a field the database draws, mutable or not; over
 * a family's member or owner, mutable or not; and over a roster. The oracle restates the rule per case: it owns iff the
 * relation is ordinary, its key has a payload, holds no span and no drawn field, the relation is not mutable and no
 * family holds it; an owned race makes the raced relation's insertions race and leaves every other relation's
 * repeatable.
 *
 * Features: each case of the space.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { ownInput } from "#test/support/policy.ts"
import {
	caseText,
	keys,
	owns,
	raceCaseGen,
	type RaceFeature,
	schemaOf
} from "#test/unit/schema/race.fixtures.ts"

/** Race(R) owns over an ordinary relation whose primary key has a payload, holds no span and no drawn field, neither mutable nor a family's, raced alone, and is refused as MalformedDescription over every other. */
export const raceROwnsOverAnOrdinaryRelationWhosePrimaryKeyHasAPayloadHoldsNoSpanAndNoDrawnFieldNeitherMutableNorAFamilysRacedAloneAndIsRefusedAsMalformedDescriptionOverEveryOther =
	property.exhaust(finite(raceCaseGen), {
		needs: {},
		situations: [
			caseText({ kind: "roster" }),
			...Arr.flatMap(keys, (key) =>
				Arr.map([false, true], (m) => caseText({ kind: "plain", key, mutable: m }))
			),
			...Arr.flatMap(["member", "owner"] as const, (part) =>
				Arr.map([false, true], (m) => caseText({ kind: "family", part, mutable: m }))
			)
		] satisfies ReadonlyArray<Reached<RaceFeature>>,
		check: (_, k: Case<RaceFeature>) => (c) =>
			Effect.sync(() => {
				k.note(caseText(c))
				const owned = Result.flatMap(parseSchemaInput(schemaOf(c)), ownInput)
				if (!owns(c)) {
					refused(owned, "MalformedDescription", caseText(c))
					return
				}
				const relations = succeeded(owned, caseText(c)).relations
				for (const [name, r] of Rec.toEntries(relations)) {
					if (r.kind === "relation") {
						assert.equal(r.inserts, name === "R" ? "race" : "repeatable", `${name}'s insertions`)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the race's rule restated per case: an ordinary relation, its key with a payload, of no span or drawn field, neither mutable nor a family's"
		},
		box: "a race over a relation keyed beside a payload, by its whole heading, over a span or by a drawn field, mutable or not; over a family's member or owner, mutable or not; and over a roster",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: `\t\tconst spans = key.filter((f) => spanned(r.fields[f]?.type))\n\t\tif (spans.length > 0) {\n\t\t\tfail(\n\t\t\t\t"MalformedDescription",\n\t\t\t\ts.desc.loc,\n\t\t\t\t\`\${statementLabel(s.desc)} over a primary key of no range; \${r.name}.\${spans.join(", ")} is a range, whose exclusion constraint PostgreSQL arbitrates by DO NOTHING alone, which yields no row an insertion met\`\n\t\t\t)\n\t\t}`,
				replacement: "",
				why: "The span key's refusal dropped (schema/own.ts checkRacedKey)."
			}
		]
	})
