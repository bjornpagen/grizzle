/** What the properties of rosters.test.ts read: its spaces, models and helpers. */

import {
	type Gen,
	int,
	map,
	oneOf,
	string,
	unicodeScalar,
	uniqueArray,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { handleMaxBytes } from "@grizzle/limits"
import { Array as Arr, Formatter, Order, Record as Rec, String as Str } from "effect"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { rosterCodebook } from "#compiler/ir/codes.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { rosterCodesOf, rosterWire, servedFile, servedText } from "#compiler/served/json.ts"
import { artifactRefusal, assert, defined, failed, succeeded } from "#test/support/assert.ts"
import { dictionaryNameGen } from "#test/support/kernel/dict.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { runtimeDifference } from "#test/support/served.ts"
import { upTo } from "#test/support/up-to.ts"

export type Feature =
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
	const handles = source.draw(uniqueKeys(handleGen, { min: 1, max: 4 }))
	return [
		...Arr.flatMap(handles, (handle): ReadonlyArray<CodeSlot> => [
			...source.draw(holesGen),
			{ kind: "live", handle }
		]),
		...source.draw(holesGen)
	]
}

/** A file's rosters: one or more, under distinct declared names. */
export const rostersGen: Gen<ReadonlyArray<readonly [DeclaredName, RosterCodes]>> = uniqueArray(
	map(dictionaryNameGen, (n) => n.declared),
	(declared) => (source) => [parsedName(declared), source.draw(codesGen)] as const,
	{ min: 1, max: 3 }
)

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

/**
 * A served file holding `rosters` and no member besides: the writer walks a file's members as values of any shape, so
 * rosters alone are a file it writes.
 */
const fileOf = (rosters: ReadonlyArray<readonly [DeclaredName, RosterCodes]>): ServedFile =>
	trusted<ServedFile>({ rosters: new Map(rosters) })

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

export const roundTrip = (
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
	const back = succeeded(servedFile(trustedJson<unknown>(text)), "the file read back")
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
		const turned = artifactRefusal(
			failed(
				servedFile(holesOnly(text, name)),
				`the file with roster ${name}'s live codes turned to holes does not read back\n${printed}`
			)
		)
		assert.deepEqual(
			[turned.artifact, turned.at],
			["served", ["rosters", name]],
			`the reader refuses the served file at roster ${name}\n${printed}`
		)
	}
	if (rosters.length > 1) {
		note("rosters of a file")
	}
}
