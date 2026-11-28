/**
 * A read that binds a text by equality binds its digest beside it wherever the text's relation generates the digest of
 * it, whoever wrote the equality: the binding owes, for each equality of a text column whose digest column holds its
 * SHA-256 (ir/law.ts textDigestsOf), the digest column's equality with the value's digest (sql/bind.ts owedDigests), so
 * the read seeks the digest's index and rechecks the text on its rows (physical/indexes/engine.ts refusedUndigested).
 * Where only a rule's equalities owed their digests (check/checker.ts RuleCheck `#stateDigests`), a stored relation
 * whose head copies a text and names its row apart from the text's relation's key, so that its upkeep finds the
 * source row a stored row copies by the copied text, bound the text alone: qti-pie's DeclarationAttribute, its
 * ItemBodyAttribute and the ledger's declared values (stored-content.ts), each copying Attribute's value under a token
 * or a holder in place of the attribute's name, were refused as UnrepresentableKey on Attribute(package, path, start,
 * value) at grizzle 9ad07e56 (qti-pie ededff69, the ledger's result composition; edullm KEYBOUND3).
 *
 * The bound: an upkeep's read of the source row a stored row copies is one probe of the digest's index, O(log n), the
 * text rechecked on the rows of its digest.
 *
 * Oracle: the specification. The installation compiles, and an index of the relation the upkeep reads by the copied
 * value, Attr or Carrier, holds valueDigest where none holds value.
 *
 * Features: a stored relation naming its rows by a token, by its element's kind, and by a token over a stored relation
 * that carries the value's digest by lineage (ir/law.ts digestsOf, StoredDerivedRelation `digests`).
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	indexesOf,
	installationOf,
	type Naming,
	readOf,
	shapeGen
} from "#test/unit/derived/upkeep-digests.fixtures.ts"

type Feature = `named by a ${Naming}`

/** An upkeep that finds a source row by a copied text seeks its declared digest. */
export const anUpkeepFindingASourceRowByACopiedTextSeeksItsDigest = property.exhaust(shapeGen, {
	needs: {},
	situations: [
		"named by a token",
		"named by a holder",
		"named by a carried"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, notes: Case<Feature>) => (shape) =>
		Effect.sync(() => {
			notes.note(`named by a ${shape.naming}`)
			const installation = installationOf(shape)
			assert.ok(
				installation.ok,
				`the installation compiles: ${installation.ok ? "" : String(installation.error)}`
			)
			const read = readOf(shape)
			const indexes = indexesOf(installation.value, read)
			assert.deepEqual(
				Arr.filter(indexes, (keys) => Arr.contains(keys, "value")),
				[],
				`no index of ${read} holds its value, a text no B-tree entry holds`
			)
			assert.ok(
				Arr.some(indexes, (keys) => Arr.contains(keys, "valueDigest")),
				`an index of ${read} holds valueDigest, which the upkeep seeks: ${Arr.join(
					Arr.map(indexes, (keys) => `(${Arr.join(keys, ", ")})`),
					" "
				)}`
			)
		}),
	oracle: {
		kind: "specification",
		name: "the installation compiles, and an index of the relation the upkeep reads by the copied value holds valueDigest where none holds value"
	},
	box: "a stored relation copying Attr's value under a token or under its element's kind, or under a token over a stored relation carrying the value's digest, Attr and Node open",
	kept: [
		{
			token: ReplayToken(
				"test/unit/derived/upkeep-digests.test.ts#anUpkeepFindingASourceRowByACopiedTextSeeksItsDigest:-:0"
			),
			reason:
				"Copied names its rows by a graded token, as qti-pie's DeclarationAttribute and ItemBodyAttribute do: its upkeep checked each stored row at the row, binding Attr's value to the row's alone beside package and start, and was refused as UnrepresentableKey on Attr(package, start, value), as the ledger's result composition was on Attribute (qti-pie ededff69 at grizzle 9ad07e56)",
			since: "2026-11-28"
		},
		{
			token: ReplayToken(
				"test/unit/derived/upkeep-digests.test.ts#anUpkeepFindingASourceRowByACopiedTextSeeksItsDigest:-:1"
			),
			reason:
				"Copied names its rows by its element's kind, whose holder names the attribute, as the ledger's declared values (__canonical_66855312) do: refused alike",
			since: "2026-11-28"
		},
		{
			token: ReplayToken(
				"test/unit/derived/upkeep-digests.test.ts#anUpkeepFindingASourceRowByACopiedTextSeeksItsDigest:-:2"
			),
			reason:
				"Copied names its rows by a graded token over Carrier, a stored relation whose head carries Attr's value and its valueDigest by lineage, as qti-pie's __canonical_6b70a001 and __canonical_6c66061f carry them: a stored derived relation's carried digest was no digest of its value (its table's digests none), so the upkeep's read of Carrier at its value was refused as UnrepresentableKey (qti-pie ededff69 at grizzle 9cce8750)",
			since: "2026-11-28"
		}
	],
	kills: [
		{
			file: "packages/engine/src/analysis/derived/storage.ts",
			original: "\t\t].filter(([text, digest]) => heading.has(text) && heading.has(digest))\n",
			replacement: "\t\t].filter(() => false)\n",
			why: "A stored derived relation's head carries no digest of its own: Carrier, whose head copies Attr's value and its valueDigest, holds its value undigested, and Copied's upkeep, which reads Carrier at the value, is refused as UnrepresentableKey on Carrier(package, start, value)."
		},
		{
			file: "packages/engine/src/sql/bind.ts",
			original:
				"\t\treturn [eq(col(written, digest.column), qualifiedCall(digest.digest, [b.value]))]\n",
			replacement: "\t\treturn []\n",
			why: "A text's equality owes its digest nothing: Copied's upkeep binds Attr's value alone beside package and start, and the installation is refused as UnrepresentableKey on Attr(package, start, value)."
		}
	]
})
