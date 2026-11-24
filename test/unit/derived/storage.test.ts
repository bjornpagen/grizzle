/**
 * Where a derived relation's rows live is the installation's inference, never its author's declaration
 * (analysis/derived/storage.ts): stored, in a table grizzle keeps equal to its definition at every COMMIT, exactly where
 * its definition is unit-local within one declared unit, every declared function it calls immutable throughout, at the
 * widest unit its head delivers, that unit wider than the declared one, so its upkeep re-derives the keys a write
 * touched alone, or its key holding a key of every relation it reads, so its upkeep reads one row of each at a key (or
 * the declared unit sealed at founding, which no unit of the box is), and its table can hold its rows;
 * live otherwise, by the first condition of unit-locality it lacks, for its upkeep, which would re-derive the whole
 * declared unit at every write, or for its table. Whether the relations it reads are closed decides nothing: an open relation
 * inside its unit is kept under the borrow its writers hold. A read of a stored relation reads its table, a write of one
 * of the relations its definition reads reads its definition, whose table the write's own COMMIT replaces
 * (analysis/schema.ts CheckedSchema serves, ir/derived.ts servedQuery), and a read of a live one reads the relations
 * its definition reads.
 *
 * The box is every definition of storage.fixtures.ts over a document's places, links and notes: a projection, the same
 * under other names, one that drops the place, one that hides its unit, counts by document and across documents, a join
 * across documents, a negation within one and across, a call of an immutable function, of a stable one and of an
 * immutable one whose body calls a stable one, a cast value no table holds (edullm's NamedDeclaration), one whose one
 * key holds a text of no byte bound, and a closed relation alone, frozen at the installation (ir/unit.ts FrozenUnit); every relation closed under no unit declared, a unit
 * of the document, or one of the document and its place, which every relation sits in alike; or Doc open under either
 * unit.
 *
 * The oracle is the rule restated as a model (a specification): stored at the unit its head delivers, in the declared
 * unit its relations sit in, or live by the condition it lacks, its unit-locality before its borrow before its table.
 *
 * Features: each shape's holding, each live holding for a borrow, and a relation stored over an open one.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { compiledOf } from "#test/unit/analysis/theory/rule-query.fixtures.ts"
import {
	derivedName,
	holdingOf,
	holdingStated,
	readsOf,
	type Shape,
	storageCase,
	storageSchemaOf
} from "#test/unit/derived/storage.fixtures.ts"

type StorageFeature =
	| `${"stored" | "live"} ${Shape}`
	| "live for its borrow, no unit declared"
	| "live for its borrow, a unit wider than its own"
	| "live for its upkeep, a unit no wider than the declared one"
	| "stored over an open relation"

/**
 * A derived relation is stored exactly where its definition is unit-local within one declared unit and its table holds
 * its rows, and live by the condition it lacks otherwise; a read of a stored one reads its table, a write of a relation
 * it reads its definition, and a read of a live one the relations its definition reads.
 */
export const aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks =
	property.exhaust(finite(storageCase), {
		needs: {},
		situations: [
			"stored projection",
			"stored renamed",
			"live by document",
			"live hidden",
			"live counted by document",
			"live counted across documents",
			"live joined across documents",
			"stored negated within",
			"live negated across",
			"stored immutable call",
			"live stable call",
			"live call of a stable call",
			"stored cast value",
			"live unrepresentable",
			"stored closed alone",
			"live for its borrow, no unit declared",
			"live for its borrow, a unit wider than its own",
			"live for its upkeep, a unit no wider than the declared one",
			"stored over an open relation"
		] satisfies ReadonlyArray<Reached<StorageFeature>>,
		check: (_, c: Case<StorageFeature>) => (stored) =>
			Effect.sync(() => {
				const { top, read } = storageSchemaOf(stored)
				const artifacts = succeeded(compiledOf(top), "every schema of the box compiles")
				const expected = holdingOf(stored)
				assert.deepEqual(holdingStated(artifacts), expected, Formatter.format(stored))
				const read_ = readsOf(artifacts, read, new Set())
				const written = readsOf(artifacts, read, new Set(["Doc"]))
				const elsewhere = readsOf(artifacts, read, new Set(["Note"]))
				switch (expected.kind) {
					case "stored":
						assert.deepEqual(
							[...read_],
							[derivedName],
							"a read of a stored relation reads its table alone"
						)
						assert.ok(
							!written.has(derivedName),
							"a write of a relation its definition reads reads its definition, never its table"
						)
						assert.deepEqual(
							[...elsewhere],
							[derivedName],
							"a write of no relation its definition reads reads its table"
						)
						break
					case "frozen":
						for (const reads of [read_, written, elsewhere]) {
							assert.deepEqual(
								[...reads],
								[derivedName],
								"a read of a relation frozen at the installation reads its table alone, whatever a write writes"
							)
						}
						break
					case "live":
						assert.ok(
							!read_.has(derivedName),
							"a read of a live relation reads the relations its definition reads"
						)
						break
				}
				if (expected.kind === "live" && expected.lacks === "borrow") {
					c.note(
						stored.declared === "none"
							? "live for its borrow, no unit declared"
							: "live for its borrow, a unit wider than its own"
					)
					return
				}
				if (expected.kind === "live" && expected.lacks === "unboundedUpkeep") {
					c.note("live for its upkeep, a unit no wider than the declared one")
				}
				if (expected.kind === "stored" && stored.mutability === "Doc open") {
					c.note("stored over an open relation")
				}
				c.note(`${expected.kind === "live" ? "live" : "stored"} ${stored.shape}`)
			}),
		oracle: {
			kind: "specification",
			name: "analysis/derived/storage.ts: a derived relation is stored at the widest unit its head delivers where its definition is unit-local within one declared unit narrower than that unit, calls only immutable functions and its table holds its rows, else live by the first condition it lacks; a read of a stored one reads its table, a write of a relation it reads its definition"
		},
		box: "every shape of fifteen, every relation closed under no unit declared, a unit of the document or one of the document and its place, or Doc open inside either",
		kept: [
			{
				token: ReplayToken(
					"test/unit/derived/storage.test.ts#aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks:-:c.0.1"
				),
				reason:
					"A cast value no table of the base holds, closed under the unit of the document: edullm's NamedDeclaration, a declaration's identifier cast from its attribute's text, stored, so the judge of PlacedVariableRefDeclaration's reference rule reads its table by key, where it filtered every identifier attribute of a document per key, 368M rows for 7,774 keys on the giant publish",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					'\tconst analyzed = input.analyze()\n\tif (!analyzed.ok) {\n\t\treturn live({ kind: "unrepresentable", refusal: analyzed.error })\n\t}\n',
				replacement:
					'\tconst analyzed = input.analyze()\n\tif (analyzed.ok || !analyzed.ok) {\n\t\treturn live({ kind: "notUnitLocal", lacks: { condition: "noUnit", detail: "" } })\n\t}\n',
				why: "The inference disabled: every derived relation live, so no definition over content is kept at publish and every write and judge reads its holders again."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					'\tif (!analyzed.ok) {\n\t\treturn live({ kind: "unrepresentable", refusal: analyzed.error })\n\t}\n',
				replacement: "\tif (!analyzed.ok) {\n\t\tthrow analyzed.error\n\t}\n",
				why: "A definition whose table could not hold its rows refuses the schema, where its definition alone serves every reader."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\t\t\tmemberOf: (relation) => owned.unitOf.get(relation) ?? members.get(relation),\n",
				replacement:
					'\t\t\t\tmemberOf: (relation) =>\n\t\t\t\t\towned.unitOf.get(relation) ?? members.get(relation) ?? { unit: "Document", fields: ["doc"] },\n',
				why: "A relation in no declared unit read as one, so a relation is stored that no borrow covers a write of."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: '\t\tthis.#tables = (relation) => holdings.get(relation)?.kind === "stored"\n',
				replacement: "\t\tthis.#tables = () => false\n",
				why: "A read of a stored relation reads its definition again, every relation it reads scanned, where its table holds its rows."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\t!holdersOf(this.owned, r).some((holder) => written.has(holder))\n",
				replacement: "\t\t\ttrue\n",
				why: "A write of Doc reads the stored relation's table, which its own COMMIT replaces: a statement after the write reads rows its earlier statements made stale."
			},
			{
				file: "packages/engine/src/ir/derived.ts",
				original:
					"\t\tif (replacedBase(node)) {\n\t\t\treturn yield definitionOf(node.relation)\n\t\t}\n",
				replacement: "",
				why: "Every derived relation's Base lowered as a table, a live one's among them, which no installation holds: a read of it reads a relation that does not exist."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tif (frozen !== undefined) {\n\t\treturn frozen\n\t}\n",
				replacement: "",
				why: "A definition over constants alone kept live: every read evaluates it again, as ledger's TypoTarget, a nested loop of 999 by 645 rows, 297 ms in each grade."
			},
			{
				file: "packages/engine/src/analysis/theory/frozen.ts",
				original: '\t\t\tcase "relation":\n\t\t\t\treturn false\n',
				replacement: '\t\t\tcase "relation":\n\t\t\t\treturn true\n',
				why: "A relation a program writes read as frozen, as a constant given a writer would be: a definition over Doc frozen at the installation, kept by no COMMIT, its rows stale after the first write of Doc."
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
				why: "An open relation's own fields read as grizzle's rewrites in place: a definition over an open Doc kept live, though every write of it holds the unit."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\t\t: Object.freeze({ kind: "unit", unit: found.unit, fields: delivered.fields, declared })',
				replacement:
					'\t\t\t\t: Object.freeze({ kind: "unit", unit: found.unit, fields: headNonEmpty(found.unit.holders).fields, declared })',
				why: "The stored relation's unit fields read off its first holder's key, not its head: a definition that renames them names fields it does not have."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\tif (k === 1) {\n\t\t\treturn { condition: "hidden", detail: "its head delivers no field that holds its unit" }',
				replacement:
					'\t\tif (k >= 1) {\n\t\t\treturn { condition: "hidden", detail: "its head delivers no field that holds its unit" }',
				why: "A head that hides the widest unit kept live, where a narrower unit it delivers stores it: the document's values, which drop the place, kept live."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tif (!correlated) {",
				replacement: "\t\tif (correlated === !correlated) {",
				why: "A negation of another document stored, so a stored relation's rows at one document would change with another's."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tunit.fields.length > unit.declared.fields.length ||\n",
				replacement: "\tunit.fields.length >= unit.declared.fields.length ||\n",
				why: "A relation whose unit is no wider than its declared unit stored: its upkeep re-derives the whole unit at every write of it, as edullm's TestAttempt would read a learner's every attempt at each answer."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tkeyedAt(unit, known) ||\n\tfoundedAt(owned, unit.declared.unit)\n",
				replacement: "\tkeyedAt(unit, known) ||\n\ttrue\n",
				why: "Every declared unit read as sealed at founding: a relation over a unit later writes add to stored at the whole unit, its upkeep re-deriving the unit at each of them."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tkeyedAt(unit, known) ||\n",
				replacement: "",
				why: "A relation whose unit key holds a key of every relation it reads kept live, though its upkeep reads one row of each at a key: the places' projection under the unit of the document and its place, as rewrite-checks' XsView over T1(doc) under its document, is read through its definition by every reader."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: '\t\t\tif (desc.volatility !== "immutable") {',
				replacement: '\t\t\tif (desc.volatility === "volatile") {',
				why: "A stable function's relation stored, whose value may change with no write, leaving the stored rows stale."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\t\t\t\tpending.push(called)",
				replacement: "\t\t\t\tvoid called",
				why: "The calls closure not followed: an immutable function whose body calls a stable one stored."
			}
		]
	})
