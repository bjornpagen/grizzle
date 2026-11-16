/**
 * A nested write's identities are structural (write/family/nesting.ts NestedSet): a row's identity is its filled
 * columns' texts themselves, and a fact's signature its own texts and the rows it nests, each row the set's one token,
 * never one text joined from their contents. A lawful write whose texts sum past the longest string V8 holds binds
 * (test/pg/write/nested-identity.test.ts keeps that case on PostgreSQL); here the search holds the representation to
 * that at every content length.
 *
 * The schema is the downstream case's shape: an owner with a caller's title and an ordered family of members, each a
 * body of letters. A case draws one to three owner facts of two ids and two titles, each nesting up to two bodies of
 * two letters, every body one letter repeated to the case's content length.
 *
 * Two oracles:
 * - The specification as a second implementation of the dedupe: the facts are a set by their whole content, own
 *   fields and nested members alike, so a fact stated twice is one, and two distinct facts at one owner id are refused
 *   by the owner's key law before any SQL; an accepted write inserts every distinct fact's members once.
 * - The identity gate: every text the nested set keys a row or a fact by is one column's text, none longer than the
 *   longest text the write states, and the set keys by exactly as many texts at the case's content length as at
 *   length 1. A key joined from texts is longer than each of them, and one spelled per character grows with the
 *   content; neither holds the gate.
 *
 * Features: a fact stated twice, two facts at one id differing in their title alone or in their members, facts at one
 * id that differ in their members' bodies alone (every fact at an id of one title and one count of members), two bodies
 * of one length that differ, an owner with no members.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inputSlotsOf, type MemberFacts } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
import { nestedRowsColumn } from "#test/support/compile.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	Bodies,
	caseGen,
	factsOf,
	type IdentityFeature,
	keyedAt,
	lawNames,
	Owner,
	programOf,
	sameFact,
	statedTexts
} from "#test/unit/write/nested-identity.fixtures.ts"

/** A nested write's identities dedupe its facts and rows by their whole content, refuse two at one key, and key each by its texts themselves at any content length. */
export const aNestedWritesIdentitiesDedupeItsFactsAndRowsByTheirWholeContentRefuseTwoAtOneKeyAndKeyEachByItsTextsThemselvesAtAnyContentLength =
	property.explore(caseGen, {
		needs: {},
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
			Effect.gen(function* () {
				const value = ChangeSet.empty(Bodies).insert(Owner, factsOf(box.facts, box.length))
				const program = programOf(value)
				const members: MemberFacts = yield* collectInputs(
					program.binding.groups,
					parsedOf(value).inputs
				)
				const bound = succeeded(
					bindWrite(runnableWrite(program, program.frontend.codes), {
						members,
						params: {},
						transport: inForce(bindFrame)
					})
				)
				const keyed = keyedAt(program, box.facts, box.length)
				const longest = Arr.reduce(statedTexts(box.facts, box.length), 0, (n, t) =>
					Math.max(n, t.length)
				)
				for (const t of keyed) {
					assert.ok(
						t.length <= longest,
						`a text the nested set keys by is one column's: ${t.length} units, past the longest stated text's ${longest}`
					)
				}
				assert.equal(
					keyed.length,
					keyedAt(program, box.facts, 1).length,
					"the nested set keys by as many texts at any content length as at length 1"
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
				assertVariant(
					bound.flights,
					"kind",
					"write",
					"a nested write reads nothing first: every group it writes is its own new owner's"
				)
				const group = defined(program.binding.groups[0], "the owners' slot group")
				const [input] = group.inputs
				const [slot] = inputSlotsOf(input)
				assert.equal(
					bound.flights.stated.slot(group, input, slot).length,
					distinct.length,
					"each distinct Owner is written once"
				)
				const written = nestedRowsColumn(program, bound.flights.chunks, "Member", 0)
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
