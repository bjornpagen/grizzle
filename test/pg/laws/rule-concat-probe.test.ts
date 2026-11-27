/**
 * A rule's probe of a stored text its query equates with a concatenation of another match's columns reads it as a point
 * lookup: the equation lowers as the text's equality with the parts built under their bytes' guard
 * (scalar/compute/typing.ts concatEquation), which binds the text for its occurrence's lookup as a join with the match
 * that holds the parts (physical/access/atoms.ts termEq), so the engine plans an index over it, a text of a byte bound
 * its entry holds. On PostgreSQL 19, over a few
 * packages of thousands of references, each identifier the qualified name `scope<i>.var<j>`, analyzed, the
 * containment of each written variable in the references whose identifier is its scope's name, a dot and its own
 * reads, a loop, the one reference of its package that identifier names, however many references its package holds;
 * a variable no identifier names is refused (rule-concat-probe.fixtures.ts).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ConcatProbeFeature,
	concatProbeTemplates,
	runConcatProbe,
	storedGen
} from "#test/pg/laws/rule-concat-probe.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Each scan a rule's probe makes of a stored text a concatenation names reads, a loop, at most the rows the text
 * matches, however many rows share its package: the rows the judge touches grow with the write, flat
 * in the stored rows.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeOfATextAConcatenationNamesReadsItsRowsAsAPointLookup = property.explore(
	storedGen,
	{
		needs: Substrate.oneOf(concatProbeTemplates, Substrate.rolledBack),
		situations: [
			"a few thousand references a package",
			"six thousand references a package and more",
			"a variable no reference names refused"
		] satisfies ReadonlyArray<Reached<ConcatProbeFeature>>,
		check: (templates, c) => (stored) =>
			Effect.gen(function* () {
				const { connection, value } = yield* templates[`${stored.references}`]
				yield* runConcatProbe(value, connection, stored, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: each scan of Ref a rule's probe makes reads at most, a loop, the rows one identifier matches, its output and its filters' removals together; and the containment refusing a variable whose qualified name no reference's identifier is"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\t[this.comparison("eq", [bytesOf(t), bytes], here), this.comparison("eq", [t, guarded], here)],',
				replacement:
					'\t\t\t[this.comparison("eq", [bytesOf(t), bytes], here), this.native(this.overload("startsWith", [t.actual, guarded.actual], here), [t, guarded], bool, undefined, here, "startsWith")],',
				why: "The equation is decided as the old judge did, by the lengths and a prefix test, which no index serves: the same truth, but the probe of a written variable reads Ref by its package alone, every reference of it a loop."
			},
			{
				file: "packages/engine/src/physical/access/atoms.ts",
				original: '\t\treturn fn === "eq" ? termEqAtoms(l.name, r.reads) : []',
				replacement: "\t\treturn []",
				why: "An equality of a column with a term over another match's columns binds nothing: the engine plans no index over the identifier, so the probe reads Ref through its key's package alone, every reference of the package a loop."
			}
		]
	}
)
