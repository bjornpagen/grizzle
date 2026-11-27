/**
 * A probe a statement joins from two row sources states each variable against the stored relation it joins, never the
 * carrier beside it (packages/engine/src/lower/conservative/match-region/index.ts regionParts bindValue): a region's
 * variable bound to a carrier's column and to a stored relation's takes the relation's, so an existence test's pairs
 * read the row's columns alone, and PostgreSQL parameterizes the probe's key path by the row it joins, as it does any
 * other index of the row's columns. Inside an anti join PostgreSQL derives no equality of the carrier's column to the
 * row's, so a key probed at the unit from the carrier and at its coordinates from the row needs both, priced at the
 * carrier's few loops, and loses to a spanning index of the coordinates parameterized by the row alone, read across
 * every unit (metis's submit probing processed_attempt, 16,384 rows a call).
 *
 * The box: a document's processed attempts X keyed by (doc, coordinates), its source rows S keyed alike, under the unit
 * Doc; a write inserting Y from the call's carrier of documents, and of the first coordinate where the case carries it,
 * joined to S at them, each row no X holds at its key; beside a read of X at its coordinates alone, which asks the
 * spanning index, or none.
 *
 * Oracle: the specification, read by the missed-index check's walk of the served write's statements (packages/engine/src
 * /sql/seeks.ts, Seek `against`): the write probes X at its whole key, every column of it bound against one item of the
 * level the probe joins, the stored row source.
 *
 * Features: a key of one coordinate or of two after the unit's field; a carrier of the unit alone or of the unit and a
 * coordinate; beside a spanning index of the coordinates or none.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	caseGen,
	type Feature,
	featuresOf,
	probesOf
} from "#test/unit/cli/joined-probe.fixtures.ts"

/** A probe the write joins from a carrier and a stored row binds its whole key against the row. */
export const aJoinedProbeBindsItsWholeKeyAgainstTheRowSourceItJoins = property.explore(caseGen, {
	needs: {},
	situations: [
		"a key of one coordinate",
		"a key of two coordinates",
		"the carrier binds the unit alone",
		"the carrier binds the unit and a coordinate",
		"beside a spanning index",
		"beside no spanning index"
	] satisfies ReadonlyArray<Reached<Feature>>,
	budget: { runs: 8, steered: 32 },
	check: (_, notes: CaseOf<Feature>) => (c) =>
		Effect.gen(function* () {
			const { columns, probes } = yield* probesOf(c)
			assert.ok(
				Arr.isReadonlyArrayNonEmpty(probes),
				`${Formatter.format(c)}: the write probes X at its whole key`
			)
			for (const p of probes) {
				const sources = new Set(Arr.flatMap([...columns], (k) => [...(p.against.get(k) ?? [])]))
				assert.equal(
					sources.size,
					1,
					`${Formatter.format(c)}: the probe of X binds its key against one row source, not ${Arr.join([...sources], ", ")}`
				)
				for (const k of columns) {
					assert.equal(
						p.against.get(k)?.size ?? 0,
						1,
						`${Formatter.format(c)}: the probe of X binds ${k} against the row source it joins`
					)
				}
			}
			notes.noteAll(featuresOf(c))
		}),
	oracle: {
		kind: "specification",
		name: "the write probes X at its whole key, every column bound against the one stored row source it joins"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/match-region/index.ts",
			original: "\t\tif (!value.has(v) || (row && !rowValued.has(v))) {\n",
			replacement: "\t\tif (!value.has(v)) {\n",
			why: "A variable keeps its first value, the carrier's: the probe of X reads its unit from the carrier and its coordinates from the row, and PostgreSQL reads it through the spanning index of the coordinates parameterized by the row alone, every unit's rows at them."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original:
				'\t\tif (x.kind === "column" && x.table !== undefined && !aliases.has(x.table)) {\n',
			replacement: "\t\tif (false) {\n",
			why: "A seek is read as bound against nothing it joins: a probe's columns bound at an enclosing level's rows are told from none bound at a parameter, so no read of a probe's row sources holds."
		}
	]
})
