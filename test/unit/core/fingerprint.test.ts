import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	uniqueArray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record } from "effect"
import { everyProperty, type Path } from "#compiler/core/canonical.ts"
import { digest, schemaFingerprint } from "#compiler/core/fingerprint.ts"
import { type SourceLoc, sitedLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { isList } from "#test/support/list.ts"

/**
 * Fingerprints (core/fingerprint.ts): SHA-256 over the domain-separated canonical text, blind to source locations,
 * covering every part the contract names.
 */
const leaf = oneOf<string | number | boolean>([
	string(codePoint(0x20, 0x7e), { min: 0, max: 4 }),
	int(-(2 ** 31), 2 ** 31 - 1),
	boolean
])
const sourceLocGen: Gen<{ readonly label: string; readonly path: Path; readonly line: number }> = (
	source
) => ({
	label: source.draw(element(["relation Task", "field id"])),
	path: source.draw(array(element<string | number>(["Work", "Task", 0]), { min: 0, max: 3 })),
	line: source.draw(int(0, 99))
})

const located = (loc: { readonly label: string; readonly path: Path; readonly line: number }) =>
	sitedLoc(loc.label, loc.path, { file: "schema.ts", line: loc.line, column: 3 })

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

const contentWith = (
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
const stripped = (v: unknown): unknown => {
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
type Change = "content" | "a non-SourceLoc loc" | "SourceLocs moved"

const changes: Arr.NonEmptyReadonlyArray<Change> = [
	"content",
	"a non-SourceLoc loc",
	"SourceLocs moved"
]

interface Parts {
	readonly content: unknown
}

/** The parts after `change`, each change made so that it is one by construction. */
const changed = (
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

describe("fingerprints", () => {
	it.effect("cover every part the contract names and nothing else", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/core/fingerprint-parts",
					draw: drawn(
						(source) => [source.draw(contentGen), source.draw(element(changes))] as const
					),
					literal: Formatter.format,
					coverage: required<Change>(changes, { cases: 400, sense: notesOnly }),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([{ entries, locs }, change], c) =>
					Effect.sync(() => {
						const [first, second] = locs
						const here = located(defined(first, "a location"))
						const there = located(defined(second, "a location"))
						const p: Parts = { content: contentWith(entries, here) }
						/** A non-SourceLoc loc is compared with another one, as content: Paris against Rome. */
						const before: Parts =
							change === "a non-SourceLoc loc"
								? { ...p, content: { ...Record.fromEntries(entries), loc: "Paris" } }
								: p
						const after = changed(before, change, there, entries)
						const schema = (q: Parts) => succeeded(schemaFingerprint({ content: q.content }))
						const schemaParts: ReadonlySet<Change> = new Set(["content", "a non-SourceLoc loc"])
						assert.equal(
							schema(after) !== schema(before),
							schemaParts.has(change),
							"the schema fingerprint"
						)
						assert.equal(schema({ ...before, content: stripped(before.content) }), schema(before))
						c.note(change)
					})
			)
		)
	)

	it.effect("separate their domains, and refuse a domain of no single line", (ctx) =>
		Effect.gen(function* () {
			type DomainFeature = "two domains" | "an empty domain" | "a domain of two lines"
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/core/fingerprint-domain",
						draw: drawn(
							(source) =>
								[
									source.draw(
										map(
											uniqueArray(
												(source) =>
													[
														source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 4 })),
														source.draw(leaf)
													] as const,
												([k]) => k,
												{ min: 0, max: 3 },
												20
											),
											Record.fromEntries
										)
									),
									source.draw(string(codePoint(0x20, 0x7e), { min: 1, max: 8 })),
									source.draw(string(codePoint(0x20, 0x7e), { min: 1, max: 8 })),
									source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 4 }))
								] as const
						),
						literal: Formatter.format,
						coverage: required<DomainFeature>(
							["two domains", "an empty domain", "a domain of two lines"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([value, a, b, tail], c) =>
						Effect.sync(() => {
							if (a !== b) {
								assert.notEqual(
									succeeded(digest(a, value, everyProperty)),
									succeeded(digest(b, value, everyProperty))
								)
								c.note("two domains")
							}
							refused(digest("", value, everyProperty), "MalformedArtifact")
							c.note("an empty domain")
							refused(digest(`${a}\n${tail}`, value, everyProperty), "MalformedArtifact")
							c.note("a domain of two lines")
						})
				)
			)
		})
	)
})
