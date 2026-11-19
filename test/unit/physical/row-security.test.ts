import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	expected,
	features,
	installationOf,
	notesOf,
	observed,
	pointGen,
	type RowSecurityFeature
} from "#test/unit/physical/row-security.fixtures.ts"

/** Row security is enabled on exactly the tables some writer narrows, after one policy per writer there. */
export const rowSecurityIsEnabledOnExactlyTheTablesSomeWriterNarrowsAfterOnePolicyPerWriterThere =
	property.exhaust(finite(pointGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<RowSecurityFeature>>,
		check: (_, c: Case<RowSecurityFeature>) => (p) =>
			Effect.sync(() => {
				for (const f of notesOf(p)) {
					c.note(f)
				}
				const seen = observed(installationOf(p))
				const want = expected(p)
				assert.deepEqual(
					Arr.sort(
						Arr.map(seen.secured, (s) => s.table),
						Order.String
					),
					Arr.sort(want.secured, Order.String),
					"the tables under row security"
				)
				for (const s of seen.secured) {
					assert.ok(s.afterPolicies, `row security on ${s.table} after its policies`)
				}
				unorderedEqual(seen.policies, want.policies, "the policies")
			}),
		oracle: {
			kind: "specification",
			name: "row security on exactly the tables some writer narrows, one policy per writer there"
		},
		box: "five writes for each of two roles on each of two tables, in one login or two",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: '\t\tif (on.every((w) => w.membership.kind === "every")) {',
				replacement: '\t\tif (on.some((w) => w.membership.kind === "every")) {',
				why: "A table some writer holds whole goes without row security, whoever else narrows it."
			}
		]
	})
