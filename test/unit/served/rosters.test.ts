/**
 * A served file's rosters read back as the codes they were written from. A roster's codes are history: a removed
 * handle leaves a hole no handle takes again, so a code after a hole names its handle only while every code keeps its
 * place. The served file writes each roster's codes in their own form (served/json.ts RosterWire, code c at position
 * c, a live code its handle and a hole `false`), and a load reads them once into the codes a layer's codecs, decoders
 * and classifier are rebuilt under (ir/codes.ts rosterCodebook).
 *
 * Over generated rosters, each a nonempty list of codes with holes anywhere and at least one live code, each live code
 * a distinct handle of up to the bytes a handle holds (core/limits.ts handleMaxBytes), any text a roster admits, under
 * distinct declared names:
 *
 * - The wire form: a roster's codes written (rosterWire) and read (rosterCodesOf) are its codes.
 * - The file: a served file holding the rosters, its text written (servedText) and read from the JSON value it parses
 *   to (servedFile), holds every roster's codes, and the codebook built from them is the one built from the codes
 *   written, codec for codec, as the runtime reads them (test/support/served.ts runtimeDifference).
 * - Fail closed: the file with one roster's live codes all turned to holes does not read back: a roster holds a live
 *   handle, so a load of one that holds none is a defect, never a roster of no handle.
 *
 * The oracle is the codes themselves: identity, and the codebook rosterCodebook builds from them.
 *
 * Plant (~/.cache/grizzle-release/TSERVED/plants): served-wire-holes-dropped.patch writes a roster's live handles
 * alone, so every code after a hole reads back one place lower.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, map, oneOf, string, uniqueArray, unicodeScalar } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Result as Answered,
	Array as Arr,
	Effect,
	Formatter,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { handleMaxBytes } from "#compiler/core/limits.ts"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { rosterCodebook } from "#compiler/ir/codes.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { rosterCodesOf, rosterWire, servedFile, servedText } from "#compiler/served/json.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { dictionaryNameGen } from "#test/support/kernel/dict.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { runtimeDifference } from "#test/support/served.ts"
import { upTo } from "#test/support/up-to.ts"

type Feature =
	| "a leading hole"
	| "a trailing hole"
	| "a run of holes"
	| "exactly one hole"
	| "one live code, every other a hole"
	| "no hole"
	| "a handle beginning with ~"
	| "a handle JSON escapes"
	| "rosters of a file"

/** A UTF-8 code unit count every scalar value fits in: a handle of this many scalar values fits handleMaxBytes. */
const utf8MaxBytes = 4

/** A handle: any text of scalar values a handle holds, or one beginning with `~`, which the file's own tags begin with. */
const handleGen: Gen<string> = oneOf([
	string(unicodeScalar, { min: 1, max: Math.floor(handleMaxBytes.value / utf8MaxBytes) }),
	map(
		string(unicodeScalar, { min: 0, max: Math.floor(handleMaxBytes.value / utf8MaxBytes) - 1 }),
		(rest) => `~${rest}`
	)
])

const hole: CodeSlot = { kind: "hole" }

/** A run of holes, none or several. */
const holesGen: Gen<ReadonlyArray<CodeSlot>> = map(int(0, 3), (count) => upTo(count, () => hole))

/**
 * A roster's codes: its live handles, distinct and in code order, one at least, each after a run of holes, and a run
 * of holes after the last, so a hole lies anywhere: leading, trailing, between, in runs.
 */
const codesGen: Gen<RosterCodes> = (source) => {
	const handles = source.draw(uniqueArray(handleGen, (h) => h, { min: 1, max: 4 }))
	return [
		...Arr.flatMap(handles, (handle): ReadonlyArray<CodeSlot> => [
			...source.draw(holesGen),
			{ kind: "live", handle }
		]),
		...source.draw(holesGen)
	]
}

/** A file's rosters: one or more, under distinct declared names. */
const rostersGen: Gen<ReadonlyArray<readonly [DeclaredName, RosterCodes]>> = (source) => {
	const names = source.draw(uniqueArray(dictionaryNameGen, (n) => n.declared, { min: 1, max: 3 }))
	return Arr.map(names, (n) => [parsedName(n.declared), source.draw(codesGen)] as const)
}

/** The features one roster's codes reach. */
const featuresOf = (codes: RosterCodes): ReadonlyArray<Feature> => {
	const holes = Arr.map(codes, (s) => s.kind === "hole")
	const count = Arr.filter(holes, (h) => h).length
	const handles = Arr.flatMap(codes, (s) => (s.kind === "live" ? [s.handle] : []))
	return [
		...(holes[0] === true ? (["a leading hole"] as const) : []),
		...(holes[holes.length - 1] === true ? (["a trailing hole"] as const) : []),
		...(Arr.some(holes, (h, i) => h && holes[i + 1] === true) ? (["a run of holes"] as const) : []),
		...(count === 1 ? (["exactly one hole"] as const) : []),
		...(handles.length === 1 && count > 0 ? (["one live code, every other a hole"] as const) : []),
		...(count === 0 ? (["no hole"] as const) : []),
		...(Arr.some(handles, Str.startsWith("~")) ? (["a handle beginning with ~"] as const) : []),
		...(Arr.some(handles, (h) => jsonText(h) !== `"${h}"`)
			? (["a handle JSON escapes"] as const)
			: [])
	]
}

/** A served file holding `rosters` and no member besides. */
const fileOf = (rosters: ReadonlyArray<readonly [DeclaredName, RosterCodes]>): ServedFile => ({
	...servedFile({ types: [], rosters: {} }),
	rosters: new Map(rosters)
})

/** The JSON value of a served file's text, the roster `turned`'s live codes all turned to holes. */
const holesOnly = (text: string, turned: DeclaredName): unknown => {
	const json = trustedJson<Readonly<Record<string, unknown>>>(text)
	const rosters = trusted<Readonly<Record<string, ReadonlyArray<string | false>>>>(json["rosters"])
	return {
		...json,
		rosters: Rec.set(
			rosters,
			turned,
			Arr.map(defined(rosters[turned], `roster ${turned}`), () => false)
		)
	}
}

const roundTrip = (
	rosters: ReadonlyArray<readonly [DeclaredName, RosterCodes]>,
	note: (feature: Feature) => void
): void => {
	const printed = Formatter.format(rosters)
	for (const [name, codes] of rosters) {
		assert.deepEqual(
			rosterCodesOf(rosterWire(codes)),
			codes,
			`roster ${name}'s codes read back from their wire form\n${printed}`
		)
		for (const feature of featuresOf(codes)) {
			note(feature)
		}
	}
	const text = succeeded(servedText(fileOf(rosters)), "the file's text")
	const back = servedFile(trustedJson<unknown>(text))
	const written = rosterCodebook(rosters)
	const read = rosterCodebook(back.rosters)
	assert.deepEqual(
		Arr.sort([...back.rosters.keys()], Order.String),
		Arr.sort(
			Arr.map(rosters, ([name]) => name),
			Order.String
		),
		`the file reads back every roster it holds and no other\n${printed}`
	)
	for (const [name, codes] of rosters) {
		assert.deepEqual(back.rosters.get(name), codes, `roster ${name} reads back\n${printed}`)
		const differs = runtimeDifference(read.rosters.get(name), written.rosters.get(name))
		assert.equal(
			differs,
			undefined,
			`roster ${name}'s codec reads back otherwise at ${differs}\n${printed}`
		)
		const turned = Answered.try(() => servedFile(holesOnly(text, name)))
		assert.ok(
			Answered.isFailure(turned),
			`the file with roster ${name}'s live codes turned to holes does not read back\n${printed}`
		)
	}
	if (rosters.length > 1) {
		note("rosters of a file")
	}
}

describe("a served file's rosters", () => {
	it.effect(
		"read back as the codes they were written from, a code after any hole in its place",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the codes written, and their codebook" },
						suite: "unit/served/rosters",
						draw: drawn(rostersGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a leading hole",
								"a trailing hole",
								"a run of holes",
								"exactly one hole",
								"one live code, every other a hole",
								"no hole",
								"a handle beginning with ~",
								"a handle JSON escapes",
								"rosters of a file"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(rosters, notes) => Effect.sync(() => roundTrip(rosters, notes.note))
				)
			)
	)
})
