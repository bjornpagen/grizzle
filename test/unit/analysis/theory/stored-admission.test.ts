/**
 * A stored derived relation (derived.stored) is admitted exactly where its definition is unit-local, every declared
 * function it calls immutable throughout, at the widest unit its head delivers, and refused by name otherwise: the first
 * condition of unit-locality it lacks (analysis/theory/unit.ts storedUnit, analysis/theory/theory.ts, DerivedRefused
 * `notUnitLocal`). Its unit's fields are the stored relation's own, the theory's record of them (Theory `stored`), which
 * its upkeep and the isolation checker read.
 *
 * The box is every definition of stored-admission.fixtures.ts over a document's places and links: a projection, the
 * same under other names, one that drops the place, one that hides its unit, counts by document and across documents,
 * a join across documents, a negation within one and across, a call of an immutable function, of a stable one and of
 * an immutable one whose body calls a stable one, and a closed relation alone; every relation immutable, or Doc mutable.
 *
 * The oracle is the admission restated as a model (a specification, d11-design.md §2): admitted at the unit its head
 * delivers, or refused by the condition it lacks, its unit before its mutability before its shape.
 *
 * Features: each shape's verdict, and a mutable relation's refusal.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { compiledOf } from "#test/unit/analysis/theory/rule-query.fixtures.ts"
import {
	type Shape,
	storedCase,
	storedName,
	storedSchemaOf,
	verdictOf,
	verdictStated
} from "#test/unit/analysis/theory/stored-admission.fixtures.ts"

type StoredFeature = `${"admitted" | "refused"} ${Shape}` | "refused over a mutable relation"

/** A stored relation compiles exactly where its definition is unit-local, and is refused by the condition it lacks. */
export const aStoredRelationIsAdmittedAtTheUnitItsHeadDeliversOrRefusedByTheConditionOfUnitLocalityItLacks =
	property.exhaust(finite(storedCase), {
		needs: {},
		situations: [
			"admitted projection",
			"admitted renamed",
			"admitted by document",
			"refused hidden",
			"admitted counted by document",
			"refused counted across documents",
			"refused joined across documents",
			"admitted negated within",
			"refused negated across",
			"admitted immutable call",
			"refused stable call",
			"refused call of a stable call",
			"refused closed alone",
			"refused over a mutable relation"
		] satisfies ReadonlyArray<Reached<StoredFeature>>,
		check: (_, c: Case<StoredFeature>) => (stored) =>
			Effect.sync(() => {
				const compiled = compiledOf(storedSchemaOf(stored))
				const stated = verdictStated(
					compiled.ok
						? { ok: true, fields: compiled.value.laws.theory.stored[storedName]?.fields }
						: { ok: false, error: compiled.error }
				)
				const expected = verdictOf(stored)
				assert.deepEqual(stated, expected, Formatter.format(stored))
				if (stored.mutability === "Doc mutable" && stored.shape !== "closed alone") {
					c.note("refused over a mutable relation")
					return
				}
				c.note(`${expected.kind} ${stored.shape}`)
			}),
		oracle: {
			kind: "specification",
			name: "analysis/theory/unit.ts storedUnit (d11-design.md §2): a stored relation is admitted at the widest unit its head delivers where its definition is unit-local and calls only immutable functions, else refused by the first condition it lacks"
		},
		box: "every shape of thirteen, every relation immutable or Doc mutable",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tconst mutable = stored.find((r) => r.mutable)",
				replacement: "\tconst mutable = stored.find(() => false)",
				why: "A definition over a mutable relation admitted, whose rows change in place under rows grizzle would not replace."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\treturn Object.freeze({ unit: found.unit, fields: delivered.fields })",
				replacement:
					"\t\t\treturn Object.freeze({ unit: found.unit, fields: headNonEmpty(found.unit.holders).fields })",
				why: "The stored relation's unit fields read off its first holder's key, not its head: a definition that renames them names fields it does not have."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\tif (k === 1) {\n\t\t\treturn { condition: "hidden", detail: "its head delivers no field that holds its unit" }',
				replacement:
					'\t\tif (k >= 1) {\n\t\t\treturn { condition: "hidden", detail: "its head delivers no field that holds its unit" }',
				why: "A head that hides the widest unit refused, where a narrower unit it delivers admits it: the document's values, which drop the place, refused."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tif (!correlated) {",
				replacement: "\t\tif (correlated === !correlated) {",
				why: "A negation of another document admitted, so a stored relation's rows at one document would change with another's."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: '\t\t\t\tif (desc.volatility !== "immutable") {',
				replacement: '\t\t\t\tif (desc.volatility === "volatile") {',
				why: "A stable function admitted, whose value may change with no write, leaving the stored rows stale."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "\t\t\t\t\tpending.push(called)",
				replacement: "\t\t\t\t\tvoid called",
				why: "The calls closure not followed: an immutable function whose body calls a stable one admitted."
			}
		]
	})
