/**
 * A write's nested sources (runtime/write/bind.ts, runtime/write/staged.ts NestedSource): every stratum's nested rows
 * of a relation that a statement of the flight sends are built once for the write, each column of them written whole
 * and measured once, and every statement that sends them reads that one source. Sharing is invisible on the wire: each
 * statement's executions, every Bind's text and parameters, are byte for byte the ones it sends as its flight's only
 * statement, where no other statement's source exists to share, so its cells, its arrays and its measures are its
 * own, built for it alone: the per-statement form the write's sources replace.
 *
 * The schema holds pantry's import shape beside a ledger and a tree: a Package whose ordered Entry family carries bytes
 * and a path, each entry a counted member of a Bin the write inserts and of a mutable Shelf it does not, each folding
 * its entries' sizes, and each entry owning an ordered family of Chunks; a mutable Doc whose ordered Lines fold their
 * quantities into its total; and a tree of Nodes. A case inserts up to two packages of up to three entries, each of a
 * drawn bin, shelf and length of bytes and up to two chunks of drawn bodies, up to two docs of up to two lines of drawn
 * notes, and up to two trees of up to four nodes, so one stratum nests several relations' rows, each relation's rows
 * one source. Every statement is cut under the transport in force or under a drawn message bound, past which its
 * nested rows travel through its staged form's carriers in chunks, and a row no fill carries even alone is refused.
 *
 * Oracle: a second derivation, the per-statement form. The write is bound once, and each statement's executions
 * (BoundWrite flights' chunks) must equal, refusals included, those of the same statement bound alone in a flight of
 * its own under the same inputs and transport.
 *
 * Features: several sources in one stratum, a statement inline, a statement staged in several fills, a row past one
 * fill alone, an owner of no member.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property as propertyOf } from "@bjornpagen/testing/property"
import { type Feature, property, sketchGen } from "#test/unit/write/nested-sources.fixtures.ts"

/** A write's nested sources send every statement the bytes it sends as its flight's only statement, inline and staged. */
export const aWritesNestedSourcesSendEveryStatementTheBytesItSendsAsItsFlightsOnlyStatementInlineAndStaged =
	propertyOf.explore(sketchGen, {
		needs: {},
		situations: [
			"several sources in one stratum",
			"a statement inline",
			"a statement staged in several fills",
			"a row past one fill alone",
			"an owner of no member"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (value) => property(value, c),
		oracle: {
			kind: "second-implementation",
			name: "each statement's executions bound alone in a flight of its own"
		},
		kept: [],
		kills: []
	})
