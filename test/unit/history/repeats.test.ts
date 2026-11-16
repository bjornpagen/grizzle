/**
 * The host write models judge a fact stated twice by the relation's key, never by its multiplicity: a ChangeSet's facts
 * are a set by identity, and a stored relation holds each fact once because its primary key's law refuses a second
 * fact at one key.
 *
 * The space is exhaustive over a box: a fact is an id of two and a name of two, so two facts share a key, are one
 * fact, or neither; Worker holds at most one fact at each id; a write is one or two members, each inserting one or two
 * facts, repeats included, through a grizzle writer or a direct one; and the host states Worker's primary key's law
 * or does not. The oracle is the rule written naively:
 *
 * - a grizzle write's facts are one set by identity, so an identical fact stated twice, in one member or across two, is
 *   one fact; two facts at one key with different identities, or a fact at a stored fact's key with another identity,
 *   are refused by the key's law; otherwise the state is S ∪ A, unchanged when S holds A already;
 * - a direct writer inserts row by row, so a row at an occupied key, an exact repeat of a stored or an earlier row
 *   included, is refused by the key's law, as PostgreSQL's unique index refuses it;
 * - a host that states no law for Worker's primary key is refused by both models before they judge anything, so no
 *   state holding a fact twice ever passes its laws.
 *
 * Features: each writer under each host, a repeat in one member and across two, a fact at a stored fact's key.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	caseGen,
	featuresOf,
	law,
	naive,
	outcomeOf,
	type RepeatFeature,
	stateTexts
} from "#test/unit/history/repeats.fixtures.ts"

/** The host write models judge a repeated fact by its key over every write of up to two members of up to two Worker facts, from each state, through each writer. */
export const theHostWriteModelsJudgeARepeatedFactByItsKeyOverEveryWriteOfUpToTwoMembersOfUpToTwoWorkerFactsFromEachStateThroughEachWriter =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"an identical fact folded",
			"a shared key refused",
			"an exact repeat refused",
			"an unkeyed host refused"
		] satisfies ReadonlyArray<Reached<RepeatFeature>>,
		check: (_, k: Case<RepeatFeature>) => (c) =>
			Effect.sync(() => {
				const outcome = Result.try(() => outcomeOf(c))
				if (c.schema === "unkeyed") {
					assert.ok(Result.isFailure(outcome), "a host without its primary key's law is refused")
					k.note("an unkeyed host refused")
					return
				}
				const expected = naive(c)
				const got = Result.getOrThrow(outcome)
				if (expected.kind === "refused") {
					assert.ok(
						got.kind === "invariant-rejected" && Arr.some(got.violations, (v) => v.law === law),
						`refused by the key's law, not ${got.kind}`
					)
				} else {
					assert.equal(got.kind, expected.kind)
					if (got.kind === "accepted" || got.kind === "no-change") {
						assert.deepEqual(stateTexts(got.state), expected.state)
					}
				}
				k.noteAll(featuresOf(c, expected))
			}),
		oracle: {
			kind: "specification",
			name: "the identity-set and key rule, written naively (naive)"
		},
		box: "every write of one or two members of one or two Worker facts over two ids and two names, from every state the key admits, through each writer, under each host",
		kept: [],
		kills: []
	})
