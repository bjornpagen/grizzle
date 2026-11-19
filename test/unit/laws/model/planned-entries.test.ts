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
 * text of a bounded pattern, or the wildcard, which bounds nothing. The oracle restates PostgreSQL: index_form_tuple's
 * layout of each index's columns in their order (heaptuple.c fill_val), exact through a prefix of fixed-width columns
 * and at the worst padding from the first varlena on, against nbtree.h's BTMaxItemSize, the indexes checked in the
 * order compilation meets them: A's and B's primary keys, then the target's UNIQUE where one is planned. The first that
 * fails is the refusal, by its columns and its fault.
 *
 * Features: the target the declared key or a superkey; admitted; the declared key refused; the target's UNIQUE refused
 * as unbounded or over the limit, or admitted at the limit; a referencing run no B-tree entry holds, admitted.
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
	type IndexColumns,
	type PairType,
	type PlannedFeature,
	sketchGen,
	typesOf
} from "#test/unit/laws/model/planned-entries.fixtures.ts"

/** The law model's planned B-tree indexes fit their entries, or the first that outgrows its entry or holds unbounded text is UnrepresentableKey. Its budget is its suite's before it was a property (test/unit/laws/model/planned-entries.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theLawModelsPlannedBTreeIndexesFitTheirEntriesOrTheFirstThatOutgrowsItsEntryOrHoldsUnboundedTextIsUnrepresentableKey =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"target is the declared key",
			"target is a superkey",
			"admitted",
			"declared key refused",
			"target UNIQUE refused, unbounded",
			"target UNIQUE refused, over the limit",
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
									feature: (fault: KeyFault): PlannedFeature =>
										fault.kind === "unboundedText"
											? "target UNIQUE refused, unbounded"
											: "target UNIQUE refused, over the limit"
								}
							]
						: [])
				]
				const first = Arr.findFirst(checked, (index) => faultOf(index.columns) !== undefined)
				if (Option.isNone(first)) {
					succeeded(compiled, "every planned index fits")
					c.note("admitted")
					if (faultOf(columns(s.target.order, (p) => `s${p}`)) !== undefined) {
						c.note("a referencing run no B-tree entry holds, admitted")
					}
					if (s.target.superkey && s.boundary.kind === "at") {
						c.note("target UNIQUE at the limit, admitted")
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
			}
		]
	})
