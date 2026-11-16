/** What the properties of fingerprint.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	type GenValue,
	int,
	map,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Record } from "effect"
import type { Path } from "#compiler/core/canonical.ts"
import { type SourceLoc, sitedLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import { isList } from "#test/support/list.ts"

const leaf = weighted<string | number | boolean>([
	[1, string(codePoint(0x20, 0x7e), { min: 0, max: 4 })],
	[1, int(-(2 ** 31), 2 ** 31 - 1)],
	[1, boolean]
])
const sourceLocGen: Gen<{ readonly label: string; readonly path: Path; readonly line: number }> = (
	source
) => ({
	label: source.draw(element(["relation Task", "field id"])),
	path: source.draw(array(element<string | number>(["Work", "Task", 0]), { min: 0, max: 3 })),
	line: source.draw(int(0, 99))
})

export const located = (loc: {
	readonly label: string
	readonly path: Path
	readonly line: number
}) => sitedLoc(loc.label, loc.path, { file: "schema.ts", line: loc.line, column: 3 })

/** Content as a description holds it: records of leaves, each record located by a drawn SourceLoc under "loc". */
const contentGen: Gen<{
	readonly entries: ReadonlyArray<readonly [string, string | number | boolean]>
	readonly locs: ReadonlyArray<{
		readonly label: string
		readonly path: Path
		readonly line: number
	}>
}> = (source) => ({
	entries: source.draw(
		array(
			(source) =>
				[source.draw(element(["name", "kind", "q", "fields"])), source.draw(leaf)] as const,
			{ min: 1, max: 4 }
		)
	),
	locs: source.draw(array(sourceLocGen, { min: 2, max: 2 }))
})

export const contentWith = (
	entries: ReadonlyArray<readonly [string, unknown]>,
	loc: SourceLoc
): unknown => ({
	...Record.fromEntries(entries),
	loc,
	nested: { ...Record.fromEntries(entries), loc }
})

/**
 * The same content with every SourceLoc stripped: a "loc" holding a record, which the content holds only as a
 * SourceLoc.
 */
export const stripped = (v: unknown): unknown => {
	if (isList(v)) {
		return Arr.map(v, stripped)
	}
	if (!isRecord(v)) {
		return v
	}
	return Record.fromEntries(
		Arr.flatMap(Record.toEntries(v), ([k, x]) =>
			k === "loc" && isRecord(x) ? [] : [[k, stripped(x)]]
		)
	)
}

/**
 * One change of a fingerprint's parts: those the contract covers change it, a moved SourceLoc does not, and a "loc" that
 * holds no SourceLoc is content.
 */
export type Change = "content" | "a non-SourceLoc loc" | "SourceLocs moved"

export const changes: Arr.NonEmptyReadonlyArray<Change> = [
	"content",
	"a non-SourceLoc loc",
	"SourceLocs moved"
]

export interface Parts {
	readonly content: unknown
}

/** The parts after `change`, each change made so that it is one by construction. */
export const changed = (
	p: Parts,
	change: Change,
	loc: SourceLoc,
	base: ReadonlyArray<readonly [string, unknown]>
): Parts => {
	switch (change) {
		case "content":
			return { ...p, content: contentWith([...base, ["changed", true]], loc) }
		case "a non-SourceLoc loc":
			return { ...p, content: { ...Record.fromEntries(base), loc: "Rome" } }
		case "SourceLocs moved":
			return { ...p, content: contentWith(base, loc) }
	}
}

/** A content and one change of the fingerprint's parts. */
export const partsGen: Gen<readonly [GenValue<typeof contentGen>, Change]> = (source) =>
	[source.draw(contentGen), source.draw(element(changes))] as const

/** A situation of the domain property: two domains, an empty domain, a domain of two lines. */
export type DomainFeature = "two domains" | "an empty domain" | "a domain of two lines"

/** A value, two one-line domains and a tail, the second line of a domain of two lines. */
export const domainGen: Gen<
	readonly [{ readonly [key: string]: string | number | boolean }, string, string, string]
> = (source) =>
	[
		source.draw(
			map(
				uniqueArray(
					string(codePoint(0x20, 0x7e), { min: 0, max: 4 }),
					(k) => (source) => [k, source.draw(leaf)] as const,
					{ min: 0, max: 3 }
				),
				Record.fromEntries
			)
		),
		source.draw(string(codePoint(0x20, 0x7e), { min: 1, max: 8 })),
		source.draw(string(codePoint(0x20, 0x7e), { min: 1, max: 8 })),
		source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 4 }))
	] as const
