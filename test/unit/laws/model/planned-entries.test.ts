/**
 * Every B-tree index the law model plans fits its entry for every value its columns admit, or the schema is refused
 * with UnrepresentableKey naming that index's columns, where PostgreSQL would refuse the first write that outgrew it
 * (54000): the UNIQUE a containment references where its target's columns are a superkey of a declared key, as well as
 * the declared keys ownership checks first. The containment's reverse index never refuses here: its referencing columns
 * are of the target's types, whose UNIQUE an admitted schema fits in any order of them, so no admitted containment's
 * referencing run outgrows an entry (reverse-index.test.ts plans the run where one does).
 *
 * Each case draws a target relation B, its declared key, and a containment from a source relation A into a side of B
 * that is B's key or a superkey of it, in a drawn order, every pair of one type: a fixed-width type, a text bounded by
 * an octet_length contract (sometimes sized to bring the target's entry to the item limit plus a drawn delta), ASCII
 * text of a bounded pattern, or the wildcard, which bounds nothing, so no index holds it. The oracle restates PostgreSQL:
 * index_form_tuple's layout of each index's columns in any order of them (heaptuple.c fill_val), each datum at its worst
 * padding, against nbtree.h's BTMaxItemSize, the indexes checked in the order compilation meets them: A's and B's
 * primary keys, then the target's UNIQUE where one is planned. The first that fails is the refusal, by its columns and
 * its fault: a text of no byte bound, unbounded, or an entry past the limit.
 *
 * Features: the target the declared key or a superkey; admitted; the declared key refused; the target's UNIQUE refused
 * over the limit, or admitted at the limit; a text no pattern bounds, refused.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import type { KeyFault } from "#compiler/core/causes.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { containedBuilder, onBuilder } from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { refused, refusedKeys, succeeded } from "#test/support/assert.ts"
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

/** The law model's planned B-tree indexes fit their entries in any order of their columns, or every one that outgrows its entry, a text no pattern bounds among them, is named by one UnrepresentableKey, in compile order. Its budget is its suite's before it was a property (test/unit/laws/model/planned-entries.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theLawModelsPlannedBTreeIndexesFitTheirEntriesOrEveryOneThatOutgrowsItsEntryATextNoPatternBoundsAmongThemIsNamedByOneUnrepresentableKey =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"target is the declared key",
			"target is a superkey",
			"admitted",
			"a text no pattern bounds, refused",
			"target UNIQUE refused, over the limit",
			"target UNIQUE at the limit, admitted"
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
				const failing = Arr.flatMap(checked, (index) => {
					const fault = faultOf(index.columns)
					return fault === undefined ? [] : [{ ...index, fault }]
				})
				if (!Arr.isReadonlyArrayNonEmpty(failing)) {
					succeeded(compiled, "every planned index fits")
					c.note("admitted")
					if (s.target.superkey && s.boundary.kind === "at") {
						c.note("target UNIQUE at the limit, admitted")
					}
					return
				}
				const keys = refusedKeys(refused(compiled, "UnrepresentableKey"))
				assert.deepEqual(
					Arr.map(keys, (k) => ({ key: k.key, fault: k.fault })),
					Arr.map(failing, (index) => ({
						key: Arr.map(index.columns, (col) => col.name),
						fault: index.fault
					})),
					"the refusal names every index that does not fit, in compile order"
				)
				c.noteAll(
					Arr.map(failing, (index) =>
						index.fault.kind === "unboundedText"
							? "a text no pattern bounds, refused"
							: index.feature(index.fault)
					)
				)
			}),
		oracle: {
			kind: "specification",
			name: "index_form_tuple's layout of each planned index's columns against nbtree.h's BTMaxItemSize, every one that fails refused in compile order"
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
				file: "packages/engine/src/schema/representability.ts",
				original: "\t\t\t(offset, c) => afterAtWorst(offset, c.datum),",
				replacement: "\t\t\t(offset, c) => alignUp(offset, c.datum.align) + c.datum.bytes,",
				why: "A planned UNIQUE measured in the order it lists its columns, every offset as if exact: a target UNIQUE past the any-order bound is admitted, which a reference listing its columns in another order would refuse."
			}
		]
	})
