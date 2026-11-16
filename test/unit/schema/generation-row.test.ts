/**
 * A generation expression reads the fields its caller writes (core/causes.ts GeneratedRule readsUnwritten): PostgreSQL
 * generates the column from them alone, and a drawn or an accumulated field, which grizzle writes on the host, is no
 * generation expression's to read. The public type leaves both out of the callback's row; a JavaScript caller's row
 * types them by their declared types, so an expression over one is built and reaches the checker, which refuses it by
 * name.
 *
 * Each case draws a relation R of up to two drawn counts, each the owner of a counted family, up to two accumulated
 * sets each a fold of the first family fills, and up to two sets the caller writes, every field under a drawn name, and
 * a generated field reading a drawn nonempty set of them, summed in a drawn order. The model: the least read in code
 * units grizzle writes is refused, with its writing; a read of the caller's fields alone is admitted.
 *
 * Oracle: the model above, a specification: the least read in code units among the fields grizzle writes.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	generationCaseGen,
	type RowField,
	schemaOf,
	type Situation
} from "#test/unit/schema/generation-row.fixtures.ts"

/** A generation expression's row admits a read of the caller's fields and refuses a read of a drawn or an accumulated field by name. */
export const aGenerationExpressionsRowAdmitsAReadOfTheCallersFieldsAndRefusesAReadOfADrawnOrAnAccumulatedFieldByName =
	property.explore(generationCaseGen, {
		needs: {},
		situations: [
			"refused at an accumulated read",
			"refused at a drawn read",
			"admitted"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, k: Case<Situation>) => (c) =>
			Effect.sync(() => {
				const artifacts = testArtifacts(schemaOf(c), testCompile)
				const unwritten = Arr.sort(
					Arr.filter(c.reads, (f) => f.writing !== "caller"),
					Order.mapInput(Order.String, (f: RowField) => f.name)
				)
				const [least] = unwritten
				if (least === undefined) {
					succeeded(artifacts, "a read of the caller's fields alone is admitted")
					k.note("admitted")
					return
				}
				const reason = refused(
					artifacts,
					"GeneratedRefused",
					"a generation expression reads no field grizzle writes"
				).reason
				if (reason._tag !== "GeneratedRefused") {
					return assert.fail("a GeneratedRefused")
				}
				assert.deepEqual(
					{ relation: reason.relation, field: reason.field, rule: reason.rule },
					{
						relation: "R",
						field: "zz",
						rule: {
							kind: "readsUnwritten",
							read: least.name,
							writing: least.writing === "drawn" ? "drawn" : "accumulated"
						}
					},
					"the refusal names the generated field, the least field grizzle writes it reads and its writing"
				)
				k.note(
					least.writing === "accumulated"
						? "refused at an accumulated read"
						: "refused at a drawn read"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the least read in code units grizzle writes is refused with its writing; the caller's fields alone are admitted"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/generated.ts",
				original: "\tfor (const field of reads) {",
				replacement: "\tfor (const field of reads.toReversed()) {",
				why: "The greatest read grizzle writes named, not the least (check/generated.ts generatedRule)."
			}
		]
	})
