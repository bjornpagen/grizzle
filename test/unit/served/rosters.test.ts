/**
 * A served file's rosters read back as the codes they were written from. A roster's codes are history: a removed
 * handle leaves a hole no handle takes again, so a code after a hole names its handle only while every code keeps its
 * place. The served file writes each roster's codes in their own form (served/json.ts RosterWire, code c at position
 * c, a live code its handle and a hole `false`), and a load reads them once into the codes a layer's codecs, decoders
 * and classifier are rebuilt under (ir/codes.ts rosterCodebook).
 *
 * Over generated rosters, each a nonempty list of codes with holes anywhere and at least one live code, each live code
 * a distinct handle of up to the bytes a handle holds (@grizzle/limits handleMaxBytes), any text a roster admits, under
 * distinct declared names:
 *
 * - The wire form: a roster's codes written (rosterWire) and read (rosterCodesOf) are its codes.
 * - The file: a served file holding the rosters, its text written (servedText) and read from the JSON value it parses
 *   to (servedFile), holds every roster's codes, and the codebook built from them is the one built from the codes
 *   written, codec for codec, as the runtime reads them (test/support/served.ts runtimeDifference).
 * - Fail closed: the file with one roster's live codes all turned to holes does not read back: a roster holds a live
 *   handle, so the reader refuses one that holds none as a malformed served file at that roster (MalformedArtifact),
 *   never a roster of no handle.
 *
 * The oracle is the codes themselves: identity, and the codebook rosterCodebook builds from them.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type Feature, rostersGen, roundTrip } from "#test/unit/served/rosters.fixtures.ts"

/** A served file's rosters read back as the codes they were written from, a code after any hole in its place. */
export const aServedFilesRostersReadBackAsTheCodesTheyWereWrittenFromACodeAfterAnyHoleInItsPlace =
	property.explore(rostersGen, {
		needs: {},
		situations: [
			"a leading hole",
			"a trailing hole",
			"a run of holes",
			"exactly one hole",
			"one live code, every other a hole",
			"no hole",
			"a handle beginning with ~",
			"a handle JSON escapes",
			"rosters of a file"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (rosters) =>
			Effect.sync(() => roundTrip(rosters, notes.note)),
		oracle: { kind: "specification", name: "the codes written, and their codebook" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/served/json.ts",
				original: '\tcodes.map((slot) => (slot.kind === "live" ? slot.handle : false))',
				replacement: '\tcodes.flatMap((slot) => (slot.kind === "live" ? [slot.handle] : []))',
				why: "rosterWire writes a roster's live handles alone, so every code after a hole reads back one place lower; the wire form and the file fail."
			}
		]
	})
