/**
 * Every B-tree index the law model plans fits its entry for every value its columns admit, or the schema is refused
 * with UnrepresentableKey naming that index's columns, where PostgreSQL would refuse the first write that outgrew it
 * (54000): the UNIQUE a containment references where its target's columns are a superkey of a declared key, as well as
 * the declared keys ownership checks first. The containment's reverse index never refuses here: it is a B-tree over the
 * longest leading run of its referencing columns that fits, else a hash index on one of them, and every type drawn here
 * is one a hash index takes (README, "A containment's reverse index never refuses free text";
 * reverse-index.test.ts plans it), so a containment whose whole referencing run outgrows an entry is admitted.
 *
 * Each case draws a target relation B, its declared key, and a containment from a source relation A into a side of B
 * that is B's key or a superkey of it, in a drawn order, every pair of one type: a fixed-width type, a text bounded by
 * an octet_length contract (sometimes sized to bring the target's entry to the item limit plus a drawn delta), ASCII
 * text of a bounded pattern, or the wildcard, which bounds nothing and which every index holds by its image, SHA-256's
 * 32 bytes (schema/representability.ts keyImageOf). The oracle restates PostgreSQL: index_form_tuple's
 * layout of each index's columns in their order (heaptuple.c fill_val), exact through a prefix of fixed-width columns
 * and at the worst padding from the first varlena on, against nbtree.h's BTMaxItemSize, the indexes checked in the
 * order compilation meets them: A's and B's primary keys, then the target's UNIQUE where one is planned. The first that
 * fails is the refusal, by its columns and its fault.
 *
 * Features: the target the declared key or a superkey; admitted; the declared key refused; the target's UNIQUE refused
 * over the limit, or admitted at the limit; a text no pattern bounds, keyed by its digest; a referencing run no B-tree
 * entry holds, admitted.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import type { KeyFault } from "#compiler/core/causes.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { containedBuilder, onBuilder } from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	descriptorOf,
	faultOf,
	imagedIndex,
	imagedOn,
	overflowsAsItself,
	type IndexColumns,
	type PairType,
	type PlannedFeature,
	sketchGen,
	typesOf
} from "#test/unit/laws/model/planned-entries.fixtures.ts"

/** The law model's planned B-tree indexes fit their entries, a text no pattern bounds held by its digest, or the first that outgrows its entry is UnrepresentableKey. Its budget is its suite's before it was a property (test/unit/laws/model/planned-entries.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theLawModelsPlannedBTreeIndexesFitTheirEntriesATextNoPatternBoundsHeldByItsDigestOrTheFirstThatOutgrowsItsEntryIsUnrepresentableKey =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"target is the declared key",
			"target is a superkey",
			"admitted",
			"a text no pattern bounds, keyed by its digest",
			"declared key over the limit, its texts by their digests",
			"target UNIQUE over the limit, its texts by their digests",
			"target UNIQUE at the limit, admitted",
			"a referencing run no B-tree entry holds, admitted"
		] satisfies ReadonlyArray<Reached<PlannedFeature>>,
		check: (_, c: Case<PlannedFeature>) => (s) =>
			Effect.sync(() => {
				const types = typesOf(s)
				const typeAt = (p: number): PairType => defined(types[p], "a field's type")
				const bNames = [
					...Arr.map(indices(s.key.length), (i) => `k${i}`),
					...Arr.map(indices(s.extra.length), (i) => `x${i}`)
				]
				const nameAt = (p: number): string => defined(bNames[p], "a field's name")
				const descriptors = Arr.map(types, descriptorOf)
				const descriptorAt = (p: number): FieldBase => defined(descriptors[p], "a descriptor")
				const B = relation(
					"B",
					Rec.fromEntries(Arr.map(bNames, (n, p) => [n, descriptorAt(p)])),
					Arr.map(s.keyOrder, nameAt),
					[]
				)
				const A = relation(
					"A",
					{
						id: Id,
						...Rec.fromEntries(Arr.map(s.target.order, (p) => [`s${p}`, descriptorAt(p)]))
					},
					["id"],
					[]
				)
				const owned = ownedInput(
					schema(
						"Planned",
						[A, B],
						[
							containedBuilder(
								onBuilder(
									A,
									Arr.map(s.target.order, (p) => `s${p}`)
								),
								onBuilder(B, Arr.map(s.target.order, nameAt))
							)
						],
						[]
					)
				)
				const compiled = owned.ok
					? compileInstallation(
							owned.value,
							completeInstallOptions(
								owned.value,
								installationsOf(owned.value),
								[],
								[],
								firstCodebook(rostersOf(owned.value))
							)
						)
					: owned
				const columns = (order: ReadonlyArray<number>, name: (p: number) => string): IndexColumns =>
					Arr.map(order, (p) => ({ name: name(p), type: typeAt(p) }))
				c.note(s.target.superkey ? "target is a superkey" : "target is the declared key")
				const checked: ReadonlyArray<{
					readonly columns: IndexColumns
					readonly feature: (fault: KeyFault) => PlannedFeature
				}> = [
					{ columns: columns(s.keyOrder, nameAt), feature: () => "declared key refused" },
					...(s.target.superkey
						? [
								{
									columns: columns(s.target.order, nameAt),
									feature: (): PlannedFeature => "target UNIQUE refused, over the limit"
								}
							]
						: [])
				]
				const first = Arr.findFirst(checked, (index) => faultOf(index.columns) !== undefined)
				if (Option.isNone(first)) {
					const model = succeeded(compiled, "every planned index fits").laws
					c.note("admitted")
					if (Arr.some(types, (t) => t.kind === "wildcard")) {
						c.note("a text no pattern bounds, keyed by its digest")
					}
					const declared = columns(s.keyOrder, nameAt)
					assert.equal(
						imagedOn(model, "B", "PrimaryKey"),
						imagedIndex(declared),
						"the primary key holds its texts by their digests exactly where it would outgrow its entry"
					)
					if (imagedIndex(declared) && Arr.some(types, (t) => t.kind !== "wildcard")) {
						c.note("declared key over the limit, its texts by their digests")
					}
					if (s.target.superkey) {
						const target = columns(s.target.order, nameAt)
						assert.equal(
							imagedOn(model, "B", "Unique"),
							imagedIndex(target),
							"the target UNIQUE holds its texts by their digests exactly where it would outgrow its entry"
						)
						if (imagedIndex(target) && s.boundary.kind === "at") {
							c.note("target UNIQUE over the limit, its texts by their digests")
						}
						if (!imagedIndex(target) && s.boundary.kind === "at") {
							c.note("target UNIQUE at the limit, admitted")
						}
					}
					if (overflowsAsItself(columns(s.target.order, (p) => `s${p}`))) {
						c.note("a referencing run no B-tree entry holds, admitted")
					}
					return
				}
				const fault = defined(faultOf(first.value.columns), "the first index's fault")
				const reason = refused(compiled, "UnrepresentableKey").reason
				if (reason._tag !== "UnrepresentableKey") {
					return assert.fail("an UnrepresentableKey reason")
				}
				assert.deepEqual(
					reason.key,
					Arr.map(first.value.columns, (col) => col.name),
					"the refusal names the first index that does not fit"
				)
				assert.deepEqual(reason.fault, fault)
				c.note(first.value.feature(fault))
			}),
		oracle: {
			kind: "specification",
			name: "index_form_tuple's layout of each planned index's columns against nbtree.h's BTMaxItemSize, the first that fails in compile order refused"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/representability.ts",
				original: "\treturn bytes > btreeMaxItemSize",
				replacement: "\treturn bytes >= btreeMaxItemSize",
				why: "An entry of exactly BTMaxItemSize is refused (schema/representability.ts btreeEntry)."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\tnullable: mayBeNull(c)\n\t\t}))\n\t)",
				replacement: "\t\t\tnullable: mayBeNull(c)\n\t\t}))\n\t).map(() => undefined)",
				why: "The law model plans every key as itself, so a key that outgrows its entry is refused where its texts' digests would hold it."
			}
		]
	})
