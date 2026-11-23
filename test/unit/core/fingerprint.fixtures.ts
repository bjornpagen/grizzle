/** What the properties of fingerprint.test.ts read: its spaces, models and helpers. */

import { getHeapStatistics } from "node:v8"
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
import { Array as Arr, Order, Record, String as Str } from "effect"
import { maxStringLength, type Path } from "#compiler/core/canonical.ts"
import { type SourceLoc, sitedLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import { messageChunk, Sha256Messages, sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { isList } from "#test/support/list.ts"
import { Exact, specified, value } from "#test/unit/core/canonical.fixtures.ts"

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

/** The first line of every digest's frame, as the module header specifies it. */
const formatLine = "grizzle-canonical\n"

/** The bytes a digest hashes, as the module header specifies them: the frame, then the specified canonical text. */
export const framedText = (domain: string, text: string): string =>
	`${formatLine}${domain}\n${text}`

/** SHA-256 of a text's UTF-8, its bytes the platform's encoder's, hashed by sha256Hex's bytes path, which no message
 * writer reaches: a second implementation of a digest's writing. */
export const platformDigest = (text: string): string => sha256Hex(new TextEncoder().encode(text))

/**
 * The identity text of a value, as identityDigest's header specifies it: the canonical text with each array and plain
 * record it holds written as its own identity digest's tagged string, each member of a record and an array read by the
 * specification (canonical.fixtures.ts jsonForm, rfc8785); a container's own digest is SHA-256 of its identity text.
 */
export const identitySpecified = (v: unknown): string => {
	if (isList(v)) {
		return `[${Arr.join(Arr.map(v, memberSpecified), ",")}]`
	}
	if (isPlainRecord(v)) {
		const members = Arr.sort(
			Arr.filter(Record.toEntries(v), ([, x]) => x !== undefined),
			Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key)
		)
		return `{${Arr.join(
			Arr.map(members, ([k, x]) => `${jsonText(k)}:${memberSpecified(x)}`),
			","
		)}}`
	}
	return specified(v)
}

/** A member's text in its container's identity text: a container's tagged digest, any other value's specified text. */
const memberSpecified = (v: unknown): string =>
	isList(v) || isPlainRecord(v)
		? `"~identity:${platformDigest(identitySpecified(v))}"`
		: specified(v)

/** Whether a drawn value is a plain record, which the canonical model reads as a container. */
const isPlainRecord = (v: unknown): v is Readonly<globalThis.Record<string, unknown>> =>
	isRecord(v) && !isList(v) && !(v instanceof Exact) && !(v instanceof Float32Array)

export type DigestFeature = "a container" | "a scalar" | "a container shared twice"

/** A value of the canonical model drawn as canonical.test.ts draws it, a one-line domain, and whether the value is held
 * twice by one container, which identityDigest digests once. */
export const digestGen: Gen<readonly [unknown, string, boolean]> = (source) =>
	[
		source.draw(value),
		source.draw(string(codePoint(0x21, 0x7e), { min: 1, max: 8 })),
		source.draw(boolean)
	] as const

/**
 * A string's scalars, repeated to 2^20 code units, a length past which a text allocated for each character would pass
 * the heap a digest allocates for its containers.
 */
export const longStringGen: Gen<string> = string(
	element(["a", "é", "€", "😀", '"', "\n", "\u0001"]),
	{ min: 1, max: 6 }
)

/** The length of each long string a digest's allocation is measured over. */
export const longLength = 2 ** 20

/** A text of `length` code units at least, `unit` repeated, flattened so no rope is read. */
export const longString = (length: number, unit: string): string => {
	const text = Str.repeat(Math.ceil(length / unit.length))(unit)
	return Arr.join(Arr.fromIterable(text), "")
}

/**
 * The heap bytes V8 allocates for each run of `f`, averaged over eight runs after four that compile it: V8 counts what
 * it allocates a buffer at a time, so a single run's count is the buffers it began, and an average of runs is what
 * each allocates.
 */
export const allocatedBy = (f: () => unknown): number => {
	for (let warm = 0; warm < 4; warm++) {
		f()
	}
	const before = getHeapStatistics().total_allocated_bytes
	for (let run = 0; run < 8; run++) {
		f()
	}
	return (getHeapStatistics().total_allocated_bytes - before) / 8
}

/**
 * A schema level whose one derived relation reads a union chain `depth` deep, each level a union of `reads` rules, every
 * rule reading the one object of the level below, as a Description shares the queries it imports by reference: its
 * canonical text spells the leaf reads^depth times, its parts are linear in the depth.
 */
export const chainLevel = (depth: number, reads: number): unknown => {
	let query: unknown = Object.freeze({
		kind: "base",
		relation: "Node",
		fields: Object.freeze(["id", "kind"])
	})
	for (let at = 0; at < depth; at++) {
		const below = query
		query = Object.freeze({
			kind: "union",
			arms: Object.freeze(
				Array.from({ length: reads }, (_, rule) =>
					Object.freeze({ rule: `r${rule + 1}`, reads: below })
				)
			)
		})
	}
	return Object.freeze({
		name: "Chain",
		relations: Object.freeze([Object.freeze({ name: "Top", definition: query })]),
		statements: Object.freeze([]),
		bases: Object.freeze([])
	})
}

/** A union chain's depth and its levels' reads (chainLevel). */
export const chainGen: Gen<readonly [number, number]> = (source) =>
	[source.draw(int(1, 12)), source.draw(int(2, 3))] as const

/** Every container `v` holds, itself included, each once: the parts a frozen value's identity digests hold. */
export const containersOf = (v: unknown): ReadonlyArray<object> => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [v]
	for (let at = pending.pop(); at !== undefined || pending.length > 0; at = pending.pop()) {
		if (typeof at !== "object" || at === null || seen.has(at)) {
			continue
		}
		seen.add(at)
		for (const member of isList(at) ? at : isRecord(at) ? Record.values(at) : []) {
			pending.push(member)
		}
	}
	return [...seen]
}

/** A union chain's depth and its levels' reads (chainLevel), and how many times the level is asked again. */
export const askedChainGen: Gen<readonly [number, number, number]> = (source) =>
	[source.draw(int(1, 8)), source.draw(int(2, 3)), source.draw(int(1, 3))] as const

/**
 * A record whose canonical text is longer than any string V8 builds (maxStringLength) and which holds one string of a
 * megabyte: as many members as pass it (pastLongestKeys), each the same string of `unit` (pastLongestMember), so its
 * text is past the bound however little of the heap the record holds, where members of half the bound each held half a
 * gigabyte of string and stretched a loaded worker's case past its minute. Its unit is written as itself in JSON, so its
 * text is known without being built.
 */
interface PastLongest {
	readonly unit: string
}

export const pastLongestGen: Gen<PastLongest> = (source) => ({
	unit: source.draw(element(["a", "z"]))
})

/**
 * The code units of the record's member string (pastLongestMember), one piece of the streamed digest's.
 *
 * @formatConstant a megabyte of one-byte string: 2^20 code units
 */
const memberLength = 2 ** 20

/** The member string of a record past V8's longest string (PastLongest): its unit repeated memberLength times. */
export const pastLongestMember = (p: PastLongest): string => Str.repeat(memberLength)(p.unit)

/**
 * The keys of a record past V8's longest string, k000 on, in their canonical order: one member more than V8's longest
 * string holds whole, so the members alone pass it.
 */
const pastLongestKeys: ReadonlyArray<string> = Array.from(
	{ length: Math.floor(maxStringLength / memberLength) + 1 },
	(_, i) => `k${Str.padStart(3, "0")(String(i))}`
)

/** The record (PastLongest), each key holding `member`. */
export const pastLongestRecord = (member: string): { readonly [key: string]: string } =>
	Record.fromEntries(Arr.map(pastLongestKeys, (key) => [key, member] as const))

/**
 * SHA-256 of a digest's frame and the canonical text of the record (pastLongestRecord), as the specification writes it
 * (framedText, the member's JSON literal its unit written as itself), written into a SHA-256 message (Sha256Messages)
 * a piece at a time and never built: the member's UTF-8, encoded once by the platform (TextEncoder), written again for
 * each key, and the rest. The second implementation of a digest over a text no string holds, which no canonical writer
 * reaches; and the record's canonical text's length in UTF-16 code units, the frame's aside.
 */
export const streamedDigest = (
	domain: string,
	member: string
): { readonly hex: string; readonly units: number } => {
	const message = new Sha256Messages(messageChunk)
	const write = (text: string): void => message.out.text(wellFormed(text))
	const encoded = new TextEncoder().encode(member)
	write(framedText(domain, ""))
	const start = message.out.units
	write("{")
	for (const [i, key] of pastLongestKeys.entries()) {
		write(`${i > 0 ? "," : ""}${jsonText(key)}:"`)
		message.out.encoded(encoded, member.length)
		write('"')
	}
	write("}")
	const units = message.out.units - start
	return { units, hex: message.hex() }
}
