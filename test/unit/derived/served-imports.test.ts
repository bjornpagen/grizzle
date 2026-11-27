/**
 * A closed, parameter-free derivation a served program imports is read from the table admission stores it in, never
 * computed over the content at every call (analysis/derived/served.ts): every query a served program imports under an
 * empty bind map, at any depth, is a canonical relation of its schema, admitted beside its definitions' (schema/reach.ts
 * Slice `served`, analysis/schema.ts CheckedSchema), and its table, where admission stores it, is what the served
 * statement reads in its place (ir/derived.ts servedDag), its being computed there an internal compiler error; one
 * admission keeps live is computed where it stands. Kept cases of edullm's take, enter and finish (reads, their
 * statements led by `r33` and `r8`) and answer and record (a write, led by `r18`), whose statements computed their
 * lesson's test roots over every package's content, seq-scanning 1.81M nodes and 932K attributes at every call, 180K to
 * 620K pages warm, where the bound is the lesson's.
 *
 * The box is served-imports.fixtures.ts: a read of a learner's visit, bound by the call's parameters, joined to the
 * roots of its package, or a write of the rows of a declared function's call over the roots (response admission's), the
 * roots imported where they stand or inside a query bound to the visit's package, each root's path and package kept,
 * its path dropped, or its package dropped too, the content's unit sealed at founding or not.
 *
 * The oracle is the rule restated: stored where each root's path is kept, so its upkeep re-derives one path, or the
 * package is sealed, or its path alone is dropped under an open package, its delta form monotone over the closed content
 * (analysis/theory/upkeep.ts deltaBoundOf), and then the program's statement reads its table, never the content; live
 * where its package is dropped, local to no unit, and then computed over the content, imported where it stands.
 *
 * Features: each program, each placement, each verdict.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { succeeded } from "#test/support/assert.ts"
import {
	contentRelations,
	type Placement,
	type Program,
	servedCase,
	servedReads,
	type Verdict,
	verdictOf
} from "#test/unit/derived/served-imports.fixtures.ts"

type ServedFeature = `${Program} ${Placement} ${Verdict}`

/** The canonical tables' names' lead (analysis/derived/canonical.ts canonicalName). */
const canonicalLead = "__canonical_"

/**
 * A served program's closed, parameter-free derivation is read from the table admission stores it in, never computed
 * over the content at every call, and computed where it stands where admission keeps it live.
 */
export const aServedProgramsClosedDerivationIsReadFromTheTableAdmissionStoresItIn =
	property.exhaust(finite(servedCase), {
		needs: {},
		situations: [
			"read matched stored",
			"read matched live",
			"read bound stored",
			"call matched stored",
			"call matched live",
			"call bound stored"
		] satisfies ReadonlyArray<Reached<ServedFeature>>,
		check: (_, c: Case<ServedFeature>) => (served) =>
			Effect.sync(() => {
				const compiled = servedReads(served)
				const verdict = verdictOf(served)
				c.note(`${served.program} ${served.placement} ${verdict}`)
				switch (verdict) {
					case "stored": {
						const reads = succeeded(compiled, "a program over a stored derivation compiles")
						assert.ok(
							Arr.some(reads, Str.startsWith(canonicalLead)),
							"the statement reads the derivation's table"
						)
						assert.ok(
							Arr.every(contentRelations, (r) => !reads.includes(r)),
							"the statement reads no content relation, the derivation's table standing in its place"
						)
						return
					}
					case "live": {
						const reads = succeeded(
							compiled,
							"a program over a derivation local to the package its visit names compiles"
						)
						assert.ok(
							Arr.every(reads, (r) => !Str.startsWith(canonicalLead)(r)),
							"the statement reads no table of a live derivation"
						)
						assert.ok(
							Arr.some(contentRelations, (r) => reads.includes(r)),
							"the statement computes the derivation over the content"
						)
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "analysis/derived/served.ts: a served program's closed import is a canonical relation, read from its table where admission stores it (its upkeep bounded or its unit sealed), computed where it stands where admission keeps it live"
		},
		box: "a read of a learner's visit joined to its package's test roots, or a write of a call over them, imported where they stand or inside a bound query, each root's path and package kept, its path dropped or its package too, the content's unit sealed or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/reach.ts",
				original:
					"\t\t\t\tif (!out.has(imported) && readsOf(imported).every((r) => baseSpelled(role, r))) {\n",
				replacement: "\t\t\t\tif (false) {\n",
				why: "No served program's closed import admitted: every take, answer and finish derives its lesson's roots over every package's content at every call."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\tread.served.forEach(admitServed)\n",
				replacement: "\t\t\t[].forEach(admitServed)\n",
				why: "The served imports a slice carries never admitted: the program's derivation stays computed over the content at every call."
			},
			{
				file: "packages/engine/src/ir/derived.ts",
				original: "\t\t\tstored.set(node, read)\n",
				replacement: "\t\t\tappendAll(pending, edgesOf(node))\n",
				why: "A stored form never read from its table: the statement computes its lesson's roots over every package's content where the installation holds them, an internal compiler error."
			}
		]
	})
