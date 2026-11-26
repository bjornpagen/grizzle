/**
 * A drafted lookup never indexes a column that does not fit its entry, and holds every other one as itself: over a
 * relation R whose fields are drawn over pg_type's sizes, a workload's request over them under a drawn use, and, where a
 * case draws one, a candidate key over the same fields:
 *
 * - a request that binds a text of no byte bound by equality, a seek's fixed prefix among them, is refused naming each
 *   such text (KeyFault `undigestedText`): no entry holds it and R declares no digest of it to seek by
 *   (digest-seeks.test.ts holds the digest's seek);
 * - otherwise the request's created index holds every key as itself where its entry, in any order of its keys, fits
 *   BTMaxItemSize; else it leaves out the keys the request binds by equality, the widest first, until the rest fit, a
 *   seek's fixed prefix among them, each left out a filter beside the index: no index holds a column by an image of it,
 *   and none holds one whose entry could pass the limit;
 * - a key it reads in its order or matches a prefix of stays: one of no byte bound is refused as unbounded, and an entry
 *   those still overfill is refused naming its varlenas among them (KeyFault `orderedColumns`), or for its bytes where it
 *   holds none;
 * - the created index's comment names each key it leaves out, so the draft states every lookup column read past it;
 * - a candidate key over the fields is admitted exactly where they fit an entry in any order, and otherwise refused.
 *
 * Oracle: PostgreSQL's B-tree item limit and pg_type's sizes and alignments, restated (representability.fixtures.ts).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { refused, refusedKey, refusedKeys, succeeded } from "#test/support/assert.ts"
import {
	fieldName,
	installLookup,
	keyAdmitted,
	type LookupFeature,
	lookupGen,
	lookupSchema,
	lookupVerdict
} from "#test/unit/physical/lookup-entries.fixtures.ts"
import {
	btreeTupleBytes,
	datumOf,
	type KeyFieldSketch,
	postgresBtreeMaxItem
} from "#test/unit/schema/representability.fixtures.ts"

/** What a created index's comment says of the keys it leaves out, its display's tail (core/identity.ts accessIndex). */
const filteredTail = " filtered beside it, not indexed: no byte bound fits the entry"

/** The keys a created index's comment names as left out, in its order: none where its display has no such tail. */
const filteredIn = (comment: string): ReadonlyArray<string> => {
	if (!Str.endsWith(filteredTail)(comment)) {
		return []
	}
	const head = Str.slice(0, comment.length - filteredTail.length)(comment)
	return Option.match(Str.lastIndexOf("), ")(head), {
		onNone: () => [],
		onSome: (at) => Str.split(", ")(Str.slice(at + 3)(head))
	})
}

/** A drafted lookup indexes only the keys that fit its entry in any order, leaves each equality that does not out as a filter its comment names, and is refused where its ordered keys alone overfill it. Its budget is the runner's: a new property, with no suite before it to carry a count from. */
export const aDraftedLookupNeverIndexesAColumnThatDoesNotFitItsEntryLeavingEachSuchEqualityOutAsAFilterItsCommentNames =
	property.explore(lookupGen, {
		needs: {},
		situations: [
			"every key held",
			"an equality left out",
			"a text of no bound refused undigested",
			"an ordered key held beside a filter",
			"refused naming an ordered text",
			"refused naming a prefixed text",
			"refused naming an ordered numeric",
			"refused as unbounded",
			"served by the key's index",
			"a seek's fixed text refused undigested"
		] satisfies ReadonlyArray<Reached<LookupFeature>>,
		check: (_, c: Case<LookupFeature>) => (s) =>
			Effect.sync(() => {
				if (s.keyed && !keyAdmitted(s)) {
					refused(lookupSchema(s), "UnrepresentableKey", "a key whose entry could pass the limit")
					return
				}
				const verdict = lookupVerdict(s)
				const installed = installLookup(s)
				const byName = new Map<string, KeyFieldSketch>(
					Arr.map(s.fields, (f, i) => [fieldName(i), f])
				)
				switch (verdict.kind) {
					case "undigested": {
						const keys = refusedKeys(refused(installed, "UnrepresentableKey"))
						assert.deepEqual(
							Arr.sort(
								Arr.flatMap(keys, (k) =>
									k.fault.kind === "undigestedText" ? [k.fault.field] : []
								),
								Order.String
							),
							Arr.sort(verdict.fields, Order.String),
							"each text of no bound the request binds by equality refused, with no digest to seek by"
						)
						c.note("a text of no bound refused undigested")
						if (
							(s.use === "page seek" || s.use === "take seek") &&
							Arr.some(s.fields, (f, i) => f.kind === "wildcard" && i < s.fixed)
						) {
							c.note("a seek's fixed text refused undigested")
						}
						return
					}
					case "unbounded": {
						const { fault } = refusedKey(refused(installed, "UnrepresentableKey"))
						assert.ok(
							fault.kind === "unboundedText",
							"an ordered text of no bound refused as unbounded"
						)
						c.note("refused as unbounded")
						return
					}
					case "ordered": {
						const { fault } = refusedKey(refused(installed, "UnrepresentableKey"))
						if (fault.kind !== "orderedColumns") {
							return assert.fail(`refused for its ordered columns, not ${fault.kind}`)
						}
						assert.deepEqual(
							Arr.sort(
								Arr.map(fault.columns, (col) => col.field),
								Order.String
							),
							Arr.sort(verdict.fields, Order.String),
							"the refusal names the varlenas it reads in their order or matches a prefix of"
						)
						c.noteAll(
							Arr.map(fault.columns, (col) => {
								const sketch = byName.get(col.field)
								return sketch?.kind === "numeric" || sketch?.kind === "bare numeric"
									? "refused naming an ordered numeric"
									: col.role === "order"
										? "refused naming an ordered text"
										: "refused naming a prefixed text"
							})
						)
						return
					}
					case "entry": {
						const { fault } = refusedKey(refused(installed, "UnrepresentableKey"))
						assert.ok(fault.kind === "btreeEntry", "refused for its bytes")
						return
					}
					case "installed":
						break
				}
				const installation = succeeded(installed, "the case's installation")
				const created = Arr.filter(
					installation.indexes,
					(x) => x.relation === "R" && x.index.kind === "created"
				)
				const [index, ...others] = created
				if (index === undefined) {
					assert.ok(
						s.keyed && verdict.held.length === s.fields.length,
						"only the key's own index, holding every key as itself, serves the request"
					)
					c.note("served by the key's index")
					return
				}
				assert.equal(others.length, 0, "one index created for the request stated twice")
				const indexed = Arr.map(index.keys, (k) => {
					assert.ok(
						k.column.kind === "field",
						"a lookup's index holds each key as its field, never an image of it"
					)
					return k.column.field
				})
				const held = Arr.map(verdict.held, fieldName)
				const kept = new Set(held)
				assert.deepEqual(
					Arr.sort(indexed, Order.String),
					Arr.sort(held, Order.String),
					"the created index holds exactly the keys the model keeps"
				)
				const datums = Arr.flatMap(indexed, (field) => {
					const sketch = byName.get(field)
					const datum = sketch === undefined ? undefined : datumOf(sketch)
					return datum === undefined ? [] : [datum]
				})
				assert.ok(
					datums.length === indexed.length && btreeTupleBytes(datums) <= postgresBtreeMaxItem,
					"every key the index holds is bounded and fits its entry in any order"
				)
				const left = Arr.filter(
					Arr.map(s.fields, (_, i) => fieldName(i)),
					(f) => !kept.has(f)
				)
				const comments = Arr.flatMap(installation.statements, (st) =>
					st.kind === "comment" && st.on.kind === "INDEX" && st.on.name.name === index.index.name
						? [st.text]
						: []
				)
				const [comment] = comments
				assert.ok(comment !== undefined, "the created index carries its comment")
				assert.deepEqual(
					Arr.sort(filteredIn(comment), Order.String),
					Arr.sort(left, Order.String),
					"the index's comment names exactly the keys it leaves out as filters"
				)
				c.note(left.length === 0 ? "every key held" : "an equality left out")
				if (left.length > 0 && s.use !== "equality lookup") {
					c.note("an ordered key held beside a filter")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "BTMaxItemSize and pg_type's sizes and alignments, restated, every key as itself in any order, each equality left out widest first where the entry could pass the limit"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/lookup-entries.test.ts#aDraftedLookupNeverIndexesAColumnThatDoesNotFitItsEntryLeavingEachSuchEqualityOutAsAFilterItsCommentNames:-:0.2.4.4.0.0"
				),
				reason:
					"an equality lookup of two texts of no bound, each undigested: two faults of one key, where the refusal named the first alone",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					"\t\t\t\t\tsameContent(k.key, key.key) &&\n\t\t\t\t\tsameContent(k.fault, key.fault)\n",
				replacement: "\t\t\t\t\tsameContent(k.key, key.key)\n",
				why: "A key is met once whatever its fault: a lookup of two texts of no bound, each undigested, is refused naming the first alone, and the second text's want of a digest goes unnamed."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: '(at < request.fixed ? "equality" : past)',
				replacement:
					'(at < request.fixed && request.use !== "page seek" && request.use !== "take seek" ? "equality" : past)',
				why: "A seek's fixed prefix read as keys it orders by, as every seek key was: a page of a document by (package, path, start) keeps a fixed identity text in its index, so a fixed text of no bound is refused as an ordered one, unbounded, where its want of a digest to seek by is the fault, and a wide fixed text is refused for its bytes where a filter beside the index serves it."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: 'const past: EntryRole = request.use === "prefix search" ? "prefix" : "order"',
				replacement: 'const past: EntryRole = "equality"',
				why: "A key past a request's fixed prefix read as an equality: a range's last text, or a seek's ordered one, left out as a filter, so the range or the page reads the whole relation in no order its index keeps."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\treturn holds(p) || (fitting !== undefined && holds(fitting))",
				replacement: "\t\treturn holds(p)",
				why: "An index serves a request only by every key it states: a request whose entry leaves an equality out creates the index again for each time it is stated, two CREATE INDEX of one name, which the migration refuses (42P07)."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original:
					"const widest = rest.reduce((w, i) => (widthOf(at(i)) > widthOf(at(w)) ? i : w), first)",
				replacement:
					"const widest = rest.reduce((w, i) => (widthOf(at(i)) < widthOf(at(w)) ? i : w), first)",
				why: "The narrowest equality left out first: a lookup over an integer and a text of no bound leaves the integer out, then the text, and is refused where an index of the integer serves it."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original: '\treturn ordered.length === 0\n\t\t? Result.err({\n\t\t\t\tkind: "btreeEntry",',
				replacement:
					'\treturn ordered.length >= 0\n\t\t? Result.err({\n\t\t\t\tkind: "btreeEntry",',
				why: "An index past the limit for the keys it reads in their order refused for its bytes alone, never naming the varlenas whose byte bound or precision is the law it breaks."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: '${filtered.length === 0 ? "" :',
				replacement: '${filtered.length >= 0 ? "" :',
				why: "The index's comment silent on the columns it leaves out: the draft no longer states which lookup columns are read as filters beside their index, the fix a byte bound would make."
			}
		]
	})
