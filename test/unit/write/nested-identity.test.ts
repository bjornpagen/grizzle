/**
 * A nested write's identities are structural (write/family/nesting.ts NestedSet): a row's identity is its filled
 * columns' texts themselves, and a fact's signature its own texts and the rows it nests, each row the set's one token,
 * never one text joined from their contents. A lawful write whose texts sum past the longest string V8 holds binds;
 * here the search holds the representation to that at every content length.
 *
 * The schema is the downstream case's shape: an owner with a caller's title and an ordered family of members, each a
 * body of letters. A case draws one to three owner facts of two ids and two titles, each nesting up to two bodies of
 * two letters, every body one letter repeated to the case's content length.
 *
 * Two oracles:
 * - The specification as a second implementation of the dedupe: the facts are a set by their whole content, own
 *   fields and nested members alike, so a fact stated twice is one, and two distinct facts at one owner id are refused
 *   by the owner's key law before any SQL; an accepted write inserts every distinct fact's members once.
 * - The identity gate: every key the nested set holds a fact or a row at is its key's texts (core/text.ts TextsId),
 *   the same keys at the case's content length as at length 1, and every text it keeps of what it holds is
 *   one column's text, none longer than the longest text the write states, as many at the case's content length as at
 *   length 1. A key or a text joined from a row's texts grows with the content, and one spelled per character keeps
 *   more texts as it grows; neither holds the gate.
 *
 * Features: a fact stated twice, two facts at one id differing in their title alone or in their members, facts at one
 * id that differ in their members' bodies alone (every fact at an id of one title and one count of members), two bodies
 * of one length that differ, an owner with no members.
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import type { MemberFacts } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { nestedRowsColumn } from "#test/support/compile.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	Bodies,
	boundSet,
	byOwner,
	caseGen,
	factsOf,
	type IdentityFeature,
	insertOwners,
	keyedAt,
	lawNames,
	Owner,
	ownersInConflict,
	programOf,
	rowsAsASet,
	sameFact,
	type SetFeature,
	setGen,
	setLength,
	setSpace,
	statedTexts
} from "#test/unit/write/nested-identity.fixtures.ts"

/**
 * A nested write's identities dedupe its facts and rows by their whole content, refuse two at one key, and key each by
 * its texts themselves at any content length.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/write/nested-identity.test.ts:214 at 8cad5bce, its runs and its coverage's cases).
 */
export const aNestedWritesIdentitiesDedupeItsFactsAndRowsByTheirWholeContentRefuseTwoAtOneKeyAndKeyEachByItsTextsThemselvesAtAnyContentLength =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a fact stated twice",
			"two facts at one id differing in their title alone",
			"two facts at one id differing in their members",
			"facts at one id that differ in their members' bodies alone",
			"two bodies of one length that differ",
			"an owner with no members",
			"accepted with members"
		] satisfies ReadonlyArray<Reached<IdentityFeature>>,
		check: (_, c: Case<IdentityFeature>) => (box) =>
			Effect.sync(() => {
				const value = ChangeSet.empty(Bodies).insert(Owner, factsOf(box.facts, box.length))
				const program = programOf(value)
				const members: MemberFacts = collectInputs(program.binding.groups, parsedOf(value).inputs)
				const bound = succeeded(
					bindWrite(flightOf(servableWrite(program), program.frontend.codes, noAdvice), {
						members,
						params: {},
						transport: inForce(bindFrame)
					})
				)
				const keyed = keyedAt(program, box.facts, box.length)
				const atOne = keyedAt(program, box.facts, 1)
				const longest = Arr.reduce(statedTexts(box.facts, box.length), 0, (n, t) =>
					Math.max(n, t.length)
				)
				for (const t of keyed.texts) {
					assert.ok(
						t.length <= longest,
						`a text the nested set keeps is one column's: ${t.length} units, past the longest stated text's ${longest}`
					)
				}
				assert.equal(
					keyed.texts.length,
					atOne.texts.length,
					"the nested set keeps as many texts at any content length as at length 1"
				)
				assert.deepEqual(
					Arr.sort(keyed.keys, Order.Array(Str.Order)),
					Arr.sort(atOne.keys, Order.Array(Str.Order)),
					"the nested set holds its facts and rows at the same keys at any content length as at length 1"
				)
				const distinct = Arr.dedupeWith(box.facts, sameFact)
				if (distinct.length < box.facts.length) {
					c.note("a fact stated twice")
				}
				if (
					Arr.some(distinct, (f) =>
						Arr.some(
							distinct,
							(g) =>
								f.owner === g.owner && f.title !== g.title && sameFact(f, { ...g, title: f.title })
						)
					)
				) {
					c.note("two facts at one id differing in their title alone")
				}
				if (
					Arr.some(distinct, (f) =>
						Arr.some(distinct, (g) => f.owner === g.owner && !sameFact(f, { ...g, title: f.title }))
					)
				) {
					c.note("two facts at one id differing in their members")
				}
				if (
					Arr.some(distinct, (f) => Arr.some(distinct, (g) => f !== g && f.owner === g.owner)) &&
					Arr.every(distinct, (f) =>
						Arr.every(
							distinct,
							(g) =>
								f.owner !== g.owner || (f.title === g.title && f.bodies.length === g.bodies.length)
						)
					)
				) {
					c.note("facts at one id that differ in their members' bodies alone")
				}
				const bodies = Arr.flatMap(distinct, (f) => f.bodies)
				if (Arr.contains(bodies, 0) && Arr.contains(bodies, 1)) {
					c.note("two bodies of one length that differ")
				}
				if (Arr.some(distinct, (f) => f.bodies.length === 0)) {
					c.note("an owner with no members")
				}
				const ids = Arr.map(distinct, (f) => f.owner)
				if (Arr.dedupe(ids).length < ids.length) {
					assertVariant(bound, "kind", "invariant-rejected", "two Owners at one id")
					assert.equal(
						bound.law,
						lawNames.primaryKeyLaw(Owner),
						"refused by Owner's key law before any SQL"
					)
					return
				}
				assertVariant(bound, "kind", "bound", "a set with one fact at each id binds")
				const group = defined(program.binding.groups[0], "the owners' slot group")
				const [input] = group.inputs
				assert.equal(
					bound.stated.slot(group, input, input.slot).length,
					distinct.length,
					"each distinct Owner is written once"
				)
				const written = nestedRowsColumn(program, bound.chunks, "Member", 0)
				assert.deepEqual(
					Arr.sort(written, Str.Order),
					Arr.sort(
						Arr.flatMap(distinct, (f) => Arr.map(f.bodies, () => uuidOf(100 + f.owner))),
						Str.Order
					),
					"each member of a distinct fact is written once"
				)
				if (bodies.length > 0) {
					c.note("accepted with members")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a nested write's facts are a set by their whole content, keyed by its texts themselves"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\t\t\t\tsignature.push(held)",
				replacement: '\t\t\t\tsignature.push(held.identity.join(","))',
				why: "A fact's signature holds each row it nests as one text joined from the row's identity, not the set's row itself; the identity gate fails."
			},
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\t\t\t\tsignature.push(held)\n",
				replacement: "",
				why: "A fact's signature is its own row's texts alone, never the rows it nests, so two facts at one owner id differing only in their members are one fact, not a key conflict; the specification oracle fails."
			}
		]
	})

/**
 * A nested write's set is the same set however its facts are stated (rule 0): over drawn owner facts, the facts stated
 * once in order, then each stated again where it first comes and all stated again after them, bind to the same write,
 * every statement's executions alike, or to the same refusal, its law and its witness; and stated with their owners in
 * ascending and in descending order, to the same refusal, or to the same rows inserted. The set keys its facts and rows
 * by their keys' texts (core/text.ts TextsId) and names a conflict by its key's order, never by the order its facts
 * came in, so where two owners each hold two facts in conflict, it names the same one whichever comes first.
 *
 * Budget: 200 runs and 200 steered cases, as the identities' property beside it.
 */
export const aNestedWritesSetIsTheSameSetHoweverItsFactsAreStatedAndNamesItsConflictByItsKeysOrder =
	property.explore(setSpace, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"accepted",
			"a fact stated twice",
			"refused at one key the nested set holds in conflict",
			"refused where the nested set holds two keys in conflict"
		] satisfies ReadonlyArray<Reached<SetFeature>>,
		check: (_, c: Case<SetFeature>) => (facts) =>
			Effect.gen(function* () {
				const once = yield* boundSet(facts)
				const again = yield* boundSet([...Arr.flatMap(facts, (f) => [f, f]), ...facts])
				const ascending = yield* boundSet(byOwner(facts, "ascending"))
				const descending = yield* boundSet(byOwner(facts, "descending"))
				if (Arr.dedupeWith(facts, sameFact).length < facts.length) {
					c.note("a fact stated twice")
				}
				switch (once.kind) {
					case "refused": {
						assert.deepEqual(again, once, "stated again, the same refusal, its law and witness")
						assert.deepEqual(
							ascending,
							once,
							"owners ascending, the same refusal, its law and witness"
						)
						assert.deepEqual(
							descending,
							once,
							"owners descending, the same refusal, its law and witness"
						)
						/** Two facts at one owner of two titles or two counts, which the same-key check refuses first. */
						const sameKeyFirst = Arr.some(facts, (f) =>
							Arr.some(
								facts,
								(g) =>
									f.owner === g.owner &&
									(f.title !== g.title || f.bodies.length !== g.bodies.length)
							)
						)
						const conflicts = sameKeyFirst ? 0 : ownersInConflict(facts).length
						if (conflicts > 1) {
							c.note("refused where the nested set holds two keys in conflict")
						} else if (conflicts === 1) {
							c.note("refused at one key the nested set holds in conflict")
						}
						return
					}
					case "bound": {
						assertVariant(again, "kind", "bound", "stated again, the set binds")
						assert.deepEqual(
							again.statements,
							once.statements,
							"stated again, every statement's executions alike"
						)
						for (const [order, other] of [
							["ascending", ascending],
							["descending", descending]
						] as const) {
							assertVariant(other, "kind", "bound", `owners ${order}, the set binds`)
							assert.deepEqual(
								rowsAsASet(other.inserted()),
								rowsAsASet(once.inserted()),
								`owners ${order}, the same rows inserted`
							)
						}
						c.note("accepted")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "rule 0: one set of facts, stated once, stated again or reordered, is one write or one refusal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original:
					"\t\tif (at.conflicted && (first === undefined || compareTextsIds(key, first.key) < 0)) {",
				replacement: "\t\tif (at.conflicted && first === undefined) {",
				why: "A conflict is named by the order its facts came in, the first key in conflict met: where two owners' keys are each in conflict, stating the other owner first names it, and the refusal's witness depends on the order the set was stated in."
			}
		]
	})

/** The calls a nested write's keys are counted by (core/text.ts textsId). */
const keySites = Object.freeze({
	keys: { file: "packages/engine/src/core/text.ts", name: "textsId" }
})

/**
 * A nested write keys each fact and each row once: over drawn owner facts, filling the nested set (runtime/write/
 * nesting.ts nestedRows) calls textsId exactly twice for each fact and each member as stated, once for its key and
 * once for its level's admitted identity, however many are stated twice; and the rows the bound insert inserts are
 * keyed once more for each distinct owner fact alone, every nested row inserted at the key its set holds it at (NestedRow
 * keyed), read off V8's call counts (kernel/calls.ts callCounts).
 */
export const aNestedWriteKeysEachFactAndEachRowOnce = property.explore(setGen, {
	needs: {},
	budget: { runs: 40, steered: 0 },
	situations: [],
	check: () => (facts) =>
		Effect.gen(function* () {
			const members = Arr.reduce(facts, 0, (n, f) => n + f.bodies.length)
			const [, setCounts] = yield* callCounts(
				Effect.sync(() => keyedAt(insertOwners, facts, setLength)),
				keySites
			)
			assert.equal(
				setCounts.keys,
				2 * (facts.length + members),
				"each stated fact and member keyed once and its identity once"
			)
			const bound = yield* boundSet(facts)
			if (bound.kind !== "bound") {
				return
			}
			const [, insertedCounts] = yield* callCounts(Effect.sync(bound.inserted), keySites)
			assert.equal(
				insertedCounts.keys,
				Arr.dedupeWith(facts, sameFact).length,
				"the inserted rows keyed once for each owner fact, no nested row again"
			)
		}),
	oracle: { kind: "specification", name: "one key per fact and per row, made once" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/runtime/write/nesting.ts",
			original: "\t\t\t\tconst at = known.get(row.keyed)",
			replacement: "\t\t\t\tconst at = known.get(textsId(row.key))",
			why: "The set keys each row again where it looks it up: every member is keyed twice."
		},
		{
			file: "packages/engine/src/runtime/write/bind.ts",
			original: "\t\t\t\t\t\t\t\tadd(relation, row.keyed, row.values)",
			replacement: "\t\t\t\t\t\t\t\tadd(relation, textsId(row.key), row.values)",
			why: "The inserted rows key each nested row again, which its set keyed: every member is keyed twice."
		}
	]
})
