/**
 * A statement that reads what it reads whole, once, asks the installation for no index: the data step's re-check
 * (physical/ddl/recheck.ts), installed as one routine of whole reads (sql/ast.ts PlStatement `wholeReads`), reads each
 * table at the values it fixes only where an index the installation plans for another reader serves it, and whole beside
 * its filter elsewhere (sql/bind.ts Binder `#serves`, physical/install/compile.ts `advised`), since no index stands for a
 * data step alone. Where the routine asked index planning for each read at the values it fixed, a stored relation read
 * at a literal of a column no B-tree entry holds asked an index on that column alone: qti-pie's uncounted attempts, each
 * sitting's response whose `count-attempt` snapshot is the cell `true` (ledger session-attempts.ts countedAttemptsOf),
 * asked an index on SnapshotSingle(value), its QtiValue cell, refused as UnrepresentableKey where the cell holds a text
 * of no byte bound (metis's generate at 1b28f756) and past the B-tree's 2,704 bytes where its texts are bounded (qti-pie
 * LEDGER-VALUECELL's probe of 83aaa65f, 131,152 bytes), and created led by the cell where it fit, an index on the hot
 * snapshot table every response's write maintains, for a re-check a migration runs once.
 *
 * The bound: a data step's re-check reads each table it reads once, O(n), with no index of its own; an index any reader
 * of the installation asks serves it where it binds that index's leading columns.
 *
 * Oracle: the specification. The installation compiles, no index of Snap holds the cell, and the re-check reads Snap
 * whole where it reads it at the cell's literal alone, and through Snap's key's index where a partner binds the sitting.
 *
 * Features: a cell of a text of no byte bound, and one of a bound past the B-tree's entry; Flagged read at the cell's
 * literal alone, and beside a partner binding the sitting.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	type Cell,
	installationOf,
	recheckReadsOfSnap,
	shapeGen,
	snapIndexes
} from "#test/unit/derived/recheck-whole.fixtures.ts"

type Feature = `a cell of ${Cell}` | "read at the literal alone" | "read beside a partner"

/** A data step's re-check of a stored relation read at a cell's literal asks no index of the cell. */
export const aDataStepsRecheckAsksNoIndexOfItsOwn = property.exhaust(shapeGen, {
	needs: {},
	situations: [
		"a cell of unbounded text",
		"a cell of wide bounded",
		"read at the literal alone",
		"read beside a partner"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, notes: Case<Feature>) => (shape) =>
		Effect.sync(() => {
			notes.note(`a cell of ${shape.cell}`)
			notes.note(shape.partnered ? "read beside a partner" : "read at the literal alone")
			const installation = installationOf(shape)
			assert.ok(
				installation.ok,
				`the installation compiles: ${installation.ok ? "" : String(installation.error)}`
			)
			assert.deepEqual(
				Arr.filter(snapIndexes(installation.value), (keys) => Arr.contains(keys, "value")),
				[],
				"no index of Snap holds the cell"
			)
			const reads = recheckReadsOfSnap(installation.value)
			if (shape.partnered) {
				assert.ok(
					Arr.isReadonlyArrayNonEmpty(reads) &&
						Arr.every(reads, (read) => Str.startsWith("index __snap_pk_")(read)),
					`the re-check reads Snap through its key's index, which stands for its key, at the sitting its partner binds: ${Arr.join(reads, ", ")}`
				)
			} else {
				assert.deepEqual(reads, [], "the re-check reads Snap whole, beside the cell's filter")
			}
		}),
	oracle: {
		kind: "specification",
		name: "the installation compiles, no index of Snap holds the cell, and the data step's re-check reads Snap whole at the cell's literal alone and through Snap's key's index beside a partner"
	},
	box: "a stored relation over a closed relation of cells, read at the flag's literal, alone or beside a partner, its cell of a text of no byte bound or past the B-tree's entry",
	kept: [
		{
			token: ReplayToken(
				"test/unit/derived/recheck-whole.test.ts#aDataStepsRecheckAsksNoIndexOfItsOwn:-:0.0"
			),
			reason:
				"Flagged read at the cell's literal alone, its cell holding a text of no byte bound: the re-check routine's refill read Snap at the one value it fixed, the cell, and asked index planning for an index on Snap(value), refused as UnrepresentableKey, as metis's generate refused SnapshotSingle(value) for qti-pie's uncounted attempts (METIS-TSGRADE's probe6 at 1b28f756)",
			since: "2026-11-28"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/indexes/engine.ts",
			original: '\t\treturn landing.kind === "served" ? landing.index : undefined\n',
			replacement: "\t\treturn undefined\n",
			why: "A whole read finds no index serving it (servingOf): the re-check reads Snap whole beside a partner that binds its sitting, every row of it, where Snap's key's index, which stands for its key, reaches the partner's rows alone."
		},
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original: "\t\t\t\tconst bound = asked.readsWhole\n",
			replacement: "\t\t\t\tconst bound = false\n",
			why: "A routine of whole reads is advised as its keyed binding planned it, each whole read whole: the re-check reads Snap whole beside a partner that binds its sitting, where Snap's key's index, which stands for its key, serves the read."
		},
		{
			file: "packages/engine/src/sql/bind.ts",
			original:
				'\t\treturn this.#reads.kind === "keyed" ? !this.#whole : this.#reads.serves(request)\n',
			replacement: '\t\treturn this.#reads.kind === "keyed" || this.#reads.serves(request)\n',
			why: "A whole-once read of a keyed binding asks index planning for an index at the values it fixes: the re-check's refill of Flagged asks one on Snap(value), the cell alone, refused as UnrepresentableKey where the cell holds a text of no byte bound, and planned on the cell where it fits."
		}
	]
})
