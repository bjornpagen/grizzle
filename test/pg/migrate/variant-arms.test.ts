/**
 * A variant's arms grow by migration on PostgreSQL 19 without rewriting a stored value (physical/ddl/variants.ts,
 * deploy/diff/diff.ts rowTypeGrown): an arm appended to the tag's roster takes the next code, so its attributes come
 * after every one the composite holds (ir/codes.ts variantLayout) and ALTER TYPE … ADD ATTRIBUTE adds them in place; a
 * handle renamed keeps its code, and so its arm's attributes, which are named by it; and a handle removed from the
 * roster an arm's field holds is judged against the stored values through the variant's domain, whose CHECK casts the
 * field to the roster's domain and which the migration replaces and validates (deploy/diff/diff.ts domainObject).
 *
 * A case installs the first version, Kind's arms count, flag and pick, pick a closed id of Color (green, red), writes
 * drawn cells and values seen through a Db of the writer, and migrates to the second, which renames flag to bit,
 * appends the arms absent and name, removes green and appends blue.
 *
 * Beside them, Picks holds a variant both versions declare alike, Picked, its one arm a closed id of Color, so its
 * domain's CHECK is one text in both and only Color's losing green judges its stored picks again.
 *
 * Oracle: the reference model of the values written. Where a stored value's pick holds green, Value's or Picked's, the
 * migration is refused, 23514; otherwise it commits, its catalog is a fresh install's of the second version, every stored value reads back
 * under the second version with flag as bit, a value of each appended arm and of blue is written and read back, and a
 * stored value seen again meets itself under Seen's key.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ArmsCase,
	armsCase,
	armsCases,
	type ArmsFeature,
	type SubsetCase,
	subsetCase,
	subsetCases,
	type SubsetFeature
} from "#test/pg/migrate/variant-arms.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** A variant's arms appended, renamed and their fields' rosters shrunk by migration keep every stored value. */
export const aVariantsArmsGrowByMigrationKeepingEveryStoredValue = property.explore(armsCases, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"arms appended over stored values",
		"arms appended over no stored value",
		"a removed handle a stored value's field holds refused",
		"a removed handle only an unchanged variant's field holds refused"
	] satisfies ReadonlyArray<Reached<ArmsFeature>>,
	check:
		({ substrate }, c: Case<ArmsFeature>) =>
		(k: ArmsCase) =>
			Effect.scoped(
				Effect.provideServiceEffect(
					armsCase(k, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				)
			),
	oracle: {
		kind: "second-implementation",
		name: "the values written, under the second version's handles"
	},
	budget: { runs: 12, steered: 12 },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: "\t\t\t\t.slice(held.length)\n",
			replacement: "\t\t\t\t.slice(target.length)\n",
			why: "A variant's appended attributes are never added: the composite keeps its first version's attributes, so the migrated catalog is no fresh install's and a value of an appended arm is no record of it."
		},
		{
			file: "packages/engine/src/ir/codes.ts",
			original: "\tfor (const [code, handle] of names.entries()) {\n",
			replacement:
				"\tfor (const [code, handle] of [...names.entries()].toSorted((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))) {\n",
			why: "A variant's layout follows its handles' order, not its codes': an appended arm whose handle sorts first puts its attributes before the composite's own, which no ALTER TYPE does, so the draft is refused."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\t\t![...qualifiedNames((hooks) => transformExpr(b.predicate, hooks), this.levelSchemas)].some(\n\t\t\t\t(k) => this.rejudged.has(k)\n\t\t\t)\n",
			replacement: "\t\t\ttrue\n",
			why: "A variant's domain is not judged again when a roster its CHECK casts a field to loses a handle: a stored pick of green survives the migration that removes green."
		}
	]
})

/**
 * A variant's subset of its roster widens and narrows by migration (variant-arms.fixtures.ts subsetCase): Sub over Mode
 * holds alpha, an integer, and beta, of no field, then leaves beta out and takes in delta, of no field, below gamma's
 * code, and gamma, a text, past every arm's code. An arm of no field holds no attribute, so taking it in or leaving it
 * out replaces the domain's CHECK alone, validated against the stored values; gamma's attribute comes after every one
 * the composite holds, ALTER TYPE … ADD ATTRIBUTE. Each other change to the composite, an arm with a field taken in
 * below an arm's code or left out, would rewrite every stored value, and is refused when drafted as a custom migration.
 *
 * Oracle: the reference model of the values written. Where a stored value is beta's, the migration is refused, 23514;
 * otherwise it commits, its catalog is a fresh install's of the second version, every stored value reads back, and a
 * value of each arm taken in is written and read back.
 */
export const aVariantsSubsetWidensAndNarrowsByMigration = property.explore(subsetCases, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"the subset widened over stored values",
		"the subset widened over no stored value",
		"a narrowing over a stored value outside the subset refused"
	] satisfies ReadonlyArray<Reached<SubsetFeature>>,
	check:
		({ substrate }, c: Case<SubsetFeature>) =>
		(k: SubsetCase) =>
			Effect.scoped(
				Effect.provideServiceEffect(
					subsetCase(k, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				)
			),
	oracle: {
		kind: "second-implementation",
		name: "the values written, under the second version's subset"
	},
	budget: { runs: 12, steered: 12 },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: "\t\t\t\t.slice(held.length)\n",
			replacement: "\t\t\t\t.slice(target.length)\n",
			why: "The attribute of gamma, taken into the subset past every arm's code, is never added: the migrated catalog is no fresh install's and a value of gamma is no record of the composite."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\tif (\n\t\t\ttarget.length < held.length ||\n\t\t\theld.some((attribute, i) => !canonicalEquals(attribute, target[i]))\n\t\t) {\n",
			replacement: "\t\tif (false) {\n",
			why: "A composite rearranged by the subset is drafted: an arm with a field taken in below an arm's code, or left out, is a draft of attributes no ALTER TYPE adds in place, where it is refused as a custom migration."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\tthis.sql("publish.validate", [\n\t\t\t\t{\n\t\t\t\t\tkind: "alterDomain",\n\t\t\t\t\tname: create.name,\n\t\t\t\t\taction: { kind: "validateConstraint", name: b.name }\n\t\t\t\t}\n\t\t\t])\n',
			replacement: "",
			why: "The variant's domain's CHECK, replaced when the subset leaves beta out, is never validated: a stored value of beta outlives the narrowing that refuses it."
		}
	]
})
