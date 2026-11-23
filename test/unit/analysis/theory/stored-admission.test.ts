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
 * an immutable one whose body calls a stable one, and a closed relation alone; every relation immutable under no unit
 * declared, a unit of the document, or one of the document and its place, which Doc and Link sit in alike; or Doc
 * mutable (open, written in place inside its unit) under either unit.
 *
 * The oracle is the admission restated as a model (a specification, d11-design.md §2): admitted at the unit its head
 * delivers, in the declared unit its relations sit in, or refused by the condition it lacks, its unit-locality before
 * its borrow.
 *
 * Features: each shape's verdict, each refusal for a borrow, and an open relation admitted.
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

type StoredFeature =
	| `${"admitted" | "refused"} ${Shape}`
	| "refused for its borrow, no unit declared"
	| "refused for its borrow, a unit wider than its own"
	| "admitted over an open relation"

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
			"refused for its borrow, no unit declared",
			"refused for its borrow, a unit wider than its own",
			"admitted over an open relation"
		] satisfies ReadonlyArray<Reached<StoredFeature>>,
		check: (_, c: Case<StoredFeature>) => (stored) =>
			Effect.sync(() => {
				const compiled = compiledOf(storedSchemaOf(stored))
				const relation = compiled.ok ? compiled.value.laws.theory.relations[storedName] : undefined
				const stated = verdictStated(
					compiled.ok
						? { ok: true, stored: relation?.kind === "stored" ? relation.unit : undefined }
						: { ok: false, error: compiled.error }
				)
				const expected = verdictOf(stored)
				assert.deepEqual(stated, expected, Formatter.format(stored))
				if (expected.kind === "refused" && expected.lacks === "borrow") {
					c.note(
						stored.declared === "none"
							? "refused for its borrow, no unit declared"
							: "refused for its borrow, a unit wider than its own"
					)
					return
				}
				if (expected.kind === "admitted" && stored.mutability === "Doc mutable") {
					c.note("admitted over an open relation")
				}
				c.note(`${expected.kind} ${stored.shape}`)
			}),
		oracle: {
			kind: "specification",
			name: "analysis/theory/unit.ts storedUnit (d11-design.md §2): a stored relation is admitted at the widest unit its head delivers where its definition is unit-local and calls only immutable functions, else refused by the first condition it lacks"
		},
		box: "every shape of thirteen, every relation immutable under no unit declared, a unit of the document or one of the document and its place, or Doc mutable inside either unit",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "unfit, (relation) =>\n\t\t\t\tthis.owned.unitOf.get(relation)\n",
				replacement:
					'unfit, (relation) =>\n\t\t\t\tthis.owned.unitOf.get(relation) ?? { unit: "Document", fields: ["doc"] }\n',
				why: "A relation in no declared unit read as one, so a stored relation is admitted that no borrow covers a write of."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tif (width > unit.key.length || f0 === undefined) {",
				replacement: "\tif (f0 === undefined) {",
				why: "A declared unit wider than the definition's admitted: a stored row at one document reads places each written under a borrow of its own."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tconst relation = stored.find((s) => s.name === r.relation && !s.mutable)",
				replacement: "\t\tconst relation = stored.find((s) => s.name === r.relation)",
				why: "An open relation's own fields read as grizzle's rewrites in place: a definition over an open Doc refused, though every write of it holds the unit."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\t\t\t\t: Object.freeze({ unit: found.unit, fields: delivered.fields, declared })",
				replacement:
					"\t\t\t\t: Object.freeze({ unit: found.unit, fields: headNonEmpty(found.unit.holders).fields, declared })",
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
