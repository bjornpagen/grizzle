/** What the properties of read.test.ts read: the documents and carriers they draw, and the readings they expect. */

import {
	type Aimed,
	aimed,
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	recursive,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	ByteSize,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Option,
	Order,
	Path,
	Record,
	Ref,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { loadFile, type Loaded, loadStream, type LoadOptions } from "#load/index.ts"
import { type LoadCode, LoadRefusal, readMemberFile, refuse, wholeInput } from "#load/read.ts"
import { DocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import { finished } from "#test/support/process.ts"

const document = DocumentUri.make("file:///spec.json")

const options: LoadOptions = { document }

/** Characters a drawn string or key holds: plain, wide, astral, quotes, escapes, controls and YAML's own marks. */
const CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	" ",
	"é",
	"中",
	"😀",
	'"',
	"\\",
	"\n",
	"\u0001",
	":",
	"#",
	"-",
	"&",
	"*",
	"!"
]

const text: Gen<string> = string(characterOf(CHARS), { min: 0, max: 6 })

/** Object keys: drawn text, never `__proto__`, which a JSON object holds as an own key but no Record can. */
const key: Gen<string> = map(text, (drawn) => (drawn === "__proto__" ? "proto" : drawn))

const scalar: Gen<Json> = oneOf<Json>([
	constant<Json>(null),
	boolean,
	int(-1000, 1000),
	map(int(-1000, 1000), (n) => n / 8),
	text
])

/** An object member list of `inner` values under unique keys. */
const objectOf = (inner: Gen<Json>): Gen<Json> =>
	map(
		uniqueArray(key, (name) => map(inner, (value) => [name, value] as const), { min: 0, max: 4 }),
		(entries): Json => Record.fromEntries(entries)
	)

/** A JSON value up to three levels deep. */
const jsonValue: Gen<Json> = recursive<Json>(
	scalar,
	(inner) => oneOf<Json>([array(inner, { min: 0, max: 4 }), objectOf(inner)]),
	3
)

/** A JSON object, which a document writes starting with `{`. */
const objectValue: Gen<Json> = objectOf(jsonValue)

/** A JSON value that is no object, which a document writes starting with anything but `{`. */
const otherValue: Gen<Json> = oneOf<Json>([scalar, array(jsonValue, { min: 0, max: 4 })])

/**
 * Whitespace a document may open with before its first character: spaces and line breaks, which both formats skip (a
 * tab before a YAML document's first node is indentation, which YAML refuses).
 */
const lead: Gen<string> = weighted([
	[4, constant("")],
	[1, constant(" ")],
	[1, constant("\n  ")]
])

/** Whitespace before the first character, at least one. */
const someLead: Gen<string> = oneOf([constant(" "), constant("\n  ")])

/**
 * How a document reaches the loader: a regular file; a chain of symlinks to one; a name that is missing, a directory
 * or a FIFO; a stream cut into chunks; a file that has grown past the size its handle's stat reports (a file system
 * double); a special file the stat before the open reports (never opened); and a file swapped in for the one its stat
 * saw between that stat and the open.
 */
export type Carrier =
	| Readonly<{ kind: "file" }>
	| Readonly<{ kind: "symlinks"; hops: number }>
	| Readonly<{ kind: "missing" }>
	| Readonly<{ kind: "directory" }>
	| Readonly<{ kind: "fifo" }>
	| Readonly<{ kind: "stream"; cuts: ReadonlyArray<number> }>
	| Readonly<{ kind: "grown"; share: number }>
	| Readonly<{ kind: "special"; type: Exclude<FileSystem.File.Type, "File"> }>
	| Readonly<{ kind: "swapped" }>

/** The file types other than a regular file a stat may report. */
const specialType: Gen<Exclude<FileSystem.File.Type, "File">> = element<
	Exclude<FileSystem.File.Type, "File">
>(["Directory", "SymbolicLink", "BlockDevice", "CharacterDevice", "FIFO", "Socket", "Unknown"])

const carrier: Gen<Carrier> = oneOf<Carrier>([
	constant<Carrier>({ kind: "file" }),
	map(int(1, 3), (hops): Carrier => ({ kind: "symlinks", hops })),
	constant<Carrier>({ kind: "missing" }),
	constant<Carrier>({ kind: "directory" }),
	constant<Carrier>({ kind: "fifo" }),
	map(array(int(0, 1000), { min: 0, max: 4 }), (cuts): Carrier => ({ kind: "stream", cuts })),
	map(int(1, 999), (share): Carrier => ({ kind: "grown", share })),
	map(specialType, (type): Carrier => ({ kind: "special", type })),
	constant<Carrier>({ kind: "swapped" })
])

/** A document's value, the text it is written as (its JSON with what it opens with), and how it is carried. */
export type Delivery = Readonly<{ value: Json; text: string; carrier: Carrier }>

/** A delivery of a value from `values`, opened with `leads`, carried by `carriers`. */
const deliveryOf =
	(values: Gen<Json>, leads: Gen<string>, carriers: Gen<Carrier>): Gen<Delivery> =>
	(s) => {
		const value = s.draw(values)
		return {
			value,
			text: `${s.draw(leads)}${Formatter.formatJson(value)}`,
			carrier: s.draw(carriers)
		}
	}

/** A delivery of any value, carried as `carriers` draws. */
const carriedBy = (carriers: Gen<Carrier>): Gen<Delivery> => deliveryOf(jsonValue, lead, carriers)

/**
 * Deliveries of any value by any carrier, aimed at each pending situation by a delivery built to reach it: a format by
 * its value's kind, the brace after whitespace, and each carrier.
 */
export const deliveries: Aimed<Delivery, DeliveryFeature> = aimed(
	deliveryOf(jsonValue, lead, carrier),
	[
		["a JSON document", deliveryOf(objectValue, lead, carrier)],
		["a YAML document", deliveryOf(otherValue, lead, carrier)],
		["leading whitespace before a brace", deliveryOf(objectValue, someLead, carrier)],
		["a regular file", carriedBy(constant<Carrier>({ kind: "file" }))],
		[
			"a chain of symlinks",
			carriedBy(map(int(1, 3), (hops): Carrier => ({ kind: "symlinks", hops })))
		],
		["a missing name", carriedBy(constant<Carrier>({ kind: "missing" }))],
		["a directory", carriedBy(constant<Carrier>({ kind: "directory" }))],
		["a FIFO", carriedBy(constant<Carrier>({ kind: "fifo" }))],
		[
			"a stream cut into chunks",
			carriedBy(
				map(array(int(0, 1000), { min: 1, max: 4 }), (cuts): Carrier => ({ kind: "stream", cuts }))
			)
		],
		[
			"a file grown past its stat",
			deliveryOf(
				objectValue,
				lead,
				map(int(1, 999), (share): Carrier => ({ kind: "grown", share }))
			)
		],
		[
			"a special file left unopened",
			carriedBy(map(specialType, (type): Carrier => ({ kind: "special", type })))
		],
		[
			"a file swapped between its stat and its open",
			carriedBy(constant<Carrier>({ kind: "swapped" }))
		]
	]
)

/**
 * The size a grown file's handle reports: `share` thousandths of what it holds, at least one byte and, for a file of
 * two bytes or more, at least one byte short of it, so the file has grown past what it reports.
 */
const reportedOf = (length: number, share: number): number =>
	Math.max(1, Math.min(length - 1, Math.floor((share * length) / 1000)))

/** What a load gives: the format and value it loaded, or the code it refused with and whether the file was opened. */
export type Reading =
	| Readonly<{
			kind: "loaded"
			format: Loaded["format"]
			value: Json
			asked: ReadonlyArray<number>
	  }>
	| Readonly<{ kind: "refused"; code: string; scope: string; opened: boolean }>

const encoder = new TextEncoder()

/**
 * The reading the specification gives: a regular file, one reached through symlinks, a stream or a grown file load
 * whole, as JSON when the text's first non-whitespace character is `{` and as YAML otherwise (a JSON text is YAML 1.2),
 * each read of a grown file asking for the size its handle reported; everything else is refused as unreadable, a
 * special file before it is opened.
 */
export const expectedOf = (delivery: Delivery): Reading => {
	const format = Str.startsWith("{")(Str.trimStart(delivery.text)) ? "json" : "yaml"
	switch (delivery.carrier.kind) {
		case "file":
		case "symlinks":
		case "stream":
			return { kind: "loaded", format, value: delivery.value, asked: [] }
		case "grown":
			return {
				kind: "loaded",
				format,
				value: delivery.value,
				asked: [reportedOf(encoder.encode(delivery.text).length, delivery.carrier.share)]
			}
		case "missing":
		case "directory":
		case "fifo":
		case "swapped":
			return { kind: "refused", code: "DOC-14/unreadable", scope: "document", opened: true }
		case "special":
			return { kind: "refused", code: "DOC-14/unreadable", scope: "document", opened: false }
	}
}

const readingOf = (
	exit: Exit.Exit<Loaded, LoadRefusal>,
	asked: ReadonlyArray<number>,
	opened: boolean
): Reading =>
	Exit.match(exit, {
		onSuccess: (loaded): Reading => ({
			kind: "loaded",
			format: loaded.format,
			value: loaded.value,
			asked: Arr.dedupe(asked)
		}),
		onFailure: (cause): Reading =>
			Option.match(Cause.findErrorOption(cause), {
				onNone: () => ({ kind: "refused", code: "a defect", scope: "", opened }),
				onSome: (refusal) => ({
					kind: "refused",
					code: refusal.diagnostic.code,
					scope: refusal.diagnostic.scope,
					opened
				})
			})
	})

const info = (size: number, type: FileSystem.File.Type, ino: number): FileSystem.File.Info => ({
	atime: Option.none(),
	birthtime: Option.none(),
	blksize: Option.none(),
	blocks: Option.none(),
	dev: 0n,
	gid: Option.none(),
	ino: Option.some(BigInt(ino)),
	mode: 0,
	mtime: Option.none(),
	nlink: Option.none(),
	rdev: Option.none(),
	size: ByteSize.bytes(size),
	type,
	uid: Option.none()
})

/** A file of `bytes` whose handle's stat reports `reported`, recording the size each read asks for. */
const grownFile = (bytes: Uint8Array, reported: number, asked: Ref.Ref<ReadonlyArray<number>>) =>
	Effect.map(Ref.make(0), (at): FileSystem.File => ({
		[FileSystem.FileTypeId]: FileSystem.FileTypeId,
		read: () => Effect.succeed(0),
		readAlloc: (size) =>
			Effect.gen(function* () {
				yield* Ref.update(asked, Arr.append(size))
				const from = yield* Ref.get(at)
				const chunk = bytes.subarray(from, from + size)
				yield* Ref.set(at, from + chunk.length)
				return chunk.length === 0 ? Option.none() : Option.some(chunk)
			}),
		seek: () => Effect.succeed(0n),
		stat: Effect.succeed(info(reported, "File", 1)),
		sync: Effect.void,
		truncate: () => Effect.void,
		write: () => Effect.succeed(0),
		writeAll: () => Effect.void
	}))

/** A file system double whose every method is `overrides`' or refuses, with real paths as given. */
const doubled = (overrides: Partial<FileSystem.FileSystem>): FileSystem.FileSystem =>
	FileSystem.makeNoop({ realPath: (given) => Effect.succeed(given), ...overrides })

/** Stream chunks of `bytes`, cut at each of `cuts` (thousandths of its length), in order. */
const chunksOf = (bytes: Uint8Array, cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
	const at = Arr.dedupe(
		Arr.sort(
			Arr.map(cuts, (cut) => Math.floor((cut * bytes.length) / 1000)),
			Order.Number
		)
	)
	const bounds = [0, ...at, bytes.length]
	return Arr.map(Arr.zip(Arr.dropRight(bounds, 1), Arr.drop(bounds, 1)), ([from, to]) =>
		bytes.subarray(from, to)
	)
}

/**
 * The reading of a load of `name` through the real file system, every open first running `opened` on the path it
 * opens (marking it opened, or swapping another file in under it).
 */
const loadedThrough = (name: string, opened: (path: string) => Effect.Effect<void>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const hooked: FileSystem.FileSystem = {
			...fs,
			open: (file, openOptions) => Effect.andThen(opened(file), fs.open(file, openOptions))
		}
		return yield* Effect.exit(
			loadFile(name, options).pipe(Effect.provideService(FileSystem.FileSystem, hooked))
		)
	})

/** The reading a load through a file system double gives. */
const loadedFrom = (fileSystem: FileSystem.FileSystem) =>
	Effect.exit(
		loadFile("/virtual/spec.json", options).pipe(
			Effect.provideService(FileSystem.FileSystem, fileSystem)
		)
	)

/** A FIFO made at `path`, by mkfifo. */
const fifoAt = (path: string) => Effect.asVoid(finished(ChildProcess.make("mkfifo", [path])))

/** Lays out what a delivery's carrier names for the loader in `dir`, and the name the loader is given. */
const laidOut = (dir: ScratchDir, delivery: Delivery, bytes: Uint8Array) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spec = path.join(dir, "spec.json")
		switch (delivery.carrier.kind) {
			case "file":
			case "swapped":
				yield* fs.writeFile(spec, bytes)
				yield* fs.writeFile(path.join(dir, "other.json"), bytes)
				return spec
			case "symlinks": {
				yield* fs.writeFile(spec, bytes)
				let target = spec
				for (let hop = 0; hop < delivery.carrier.hops; hop += 1) {
					const link = path.join(dir, `link-${hop}.yaml`)
					yield* fs.symlink(target, link)
					target = link
				}
				return target
			}
			case "directory":
				yield* fs.makeDirectory(spec)
				return spec
			case "fifo":
				yield* fifoAt(spec)
				return spec
			case "missing":
			case "stream":
			case "grown":
			case "special":
				return spec
		}
	})

/** The reading a delivery gets from the loader, on files laid out in the case's own directory. */
export const actualOf = (dir: ScratchDir, delivery: Delivery) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const bytes = encoder.encode(delivery.text)
		const asked = yield* Ref.make<ReadonlyArray<number>>([])
		const opened = yield* Ref.make(false)
		const open = Ref.set(opened, true)
		const name = yield* laidOut(dir, delivery, bytes)
		const carried = delivery.carrier
		switch (carried.kind) {
			case "file":
			case "symlinks":
			case "missing":
			case "directory":
			case "fifo": {
				const exit = yield* loadedThrough(name, () => open)
				return readingOf(exit, [], true)
			}
			case "swapped": {
				const exit = yield* loadedThrough(name, (file) =>
					Effect.andThen(open, Effect.orDie(fs.rename(path.join(dir, "other.json"), file)))
				)
				return readingOf(exit, [], true)
			}
			case "stream": {
				const exit = yield* Effect.exit(
					loadStream(Stream.fromIterable(chunksOf(bytes, carried.cuts)), options)
				)
				return readingOf(exit, [], true)
			}
			case "grown": {
				const reported = reportedOf(bytes.length, carried.share)
				const file = yield* grownFile(bytes, reported, asked)
				const exit = yield* loadedFrom(
					doubled({
						open: () => Effect.as(open, file),
						stat: () => Effect.succeed(info(reported, "File", 1))
					})
				)
				const sizes = yield* Ref.get(asked)
				return readingOf(exit, sizes, true)
			}
			case "special": {
				const exit = yield* loadedFrom(
					doubled({
						open: () => Effect.andThen(open, Effect.die("a special file was opened")),
						readFile: () => Effect.as(open, bytes),
						stat: () => Effect.succeed(info(bytes.length, carried.type, 1))
					})
				)
				const wasOpened = yield* Ref.get(opened)
				return readingOf(exit, [], wasOpened)
			}
		}
	})

/** The situations a delivery reaches. */
export type DeliveryFeature =
	| "a JSON document"
	| "a YAML document"
	| "leading whitespace before a brace"
	| "a regular file"
	| "a chain of symlinks"
	| "a missing name"
	| "a directory"
	| "a FIFO"
	| "a stream cut into chunks"
	| "a file grown past its stat"
	| "a special file left unopened"
	| "a file swapped between its stat and its open"

/** The situation a delivery's carrier reaches: a grown file only when it holds more than its handle reports. */
const carrierFeature = (delivery: Delivery): ReadonlyArray<DeliveryFeature> => {
	switch (delivery.carrier.kind) {
		case "file":
			return ["a regular file"]
		case "symlinks":
			return ["a chain of symlinks"]
		case "missing":
			return ["a missing name"]
		case "directory":
			return ["a directory"]
		case "fifo":
			return ["a FIFO"]
		case "stream":
			return ["a stream cut into chunks"]
		case "grown": {
			const length = encoder.encode(delivery.text).length
			return reportedOf(length, delivery.carrier.share) < length
				? ["a file grown past its stat"]
				: []
		}
		case "special":
			return ["a special file left unopened"]
		case "swapped":
			return ["a file swapped between its stat and its open"]
	}
}

export const deliveryFeatures = (delivery: Delivery): ReadonlyArray<DeliveryFeature> => {
	const trimmed = Str.trimStart(delivery.text)
	const braced = Str.startsWith("{")(trimmed)
	return [
		braced ? "a JSON document" : "a YAML document",
		...(braced && trimmed.length < delivery.text.length
			? ["leading whitespace before a brace" as const]
			: []),
		...carrierFeature(delivery)
	]
}

/**
 * How a member file is laid out where the reference root admitted it: a regular file of drawn bytes (empty, small or
 * past a megabyte), a symlink at the name's final component, a directory or a FIFO; and whether the boundary's check
 * of the opened handle admits it.
 */
export type Member = Readonly<{
	layout: "file" | "final symlink" | "directory" | "fifo"
	size: number
	admitted: boolean
}>

/** The sizes a member draws: empty, small, or past a megabyte, which no single small read returns whole. */
const memberSize: Gen<number> = weighted([
	[1, constant(0)],
	[6, int(1, 512)],
	[1, int(1024 * 1024, 1024 * 1024 + 64)]
])

/** A member laid out as `layouts` draws, of a size `sizes` draws, admitted as `admissions` draws. */
const memberOf =
	(layouts: Gen<Member["layout"]>, sizes: Gen<number>, admissions: Gen<boolean>): Gen<Member> =>
	(s) => ({ layout: s.draw(layouts), size: s.draw(sizes), admitted: s.draw(admissions) })

const anyLayout: Gen<Member["layout"]> = element<Member["layout"]>([
	"file",
	"final symlink",
	"directory",
	"fifo"
])

const admission: Gen<boolean> = weighted([
	[3, constant(true)],
	[1, constant(false)]
])

/** Members of any layout, size and admission, aimed at each pending situation by a member built to reach it. */
export const members: Aimed<Member, MemberFeature> = aimed(
	memberOf(anyLayout, memberSize, admission),
	[
		["a regular member admitted", memberOf(constant("file"), memberSize, constant(true))],
		["a member the check refuses", memberOf(constant("file"), memberSize, constant(false))],
		["an empty member", memberOf(constant("file"), constant(0), admission)],
		[
			"a member past a megabyte",
			memberOf(constant("file"), int(1024 * 1024, 1024 * 1024 + 64), admission)
		],
		[
			"a symlink at the final component",
			memberOf(constant("final symlink"), memberSize, admission)
		],
		["a directory member", memberOf(constant("directory"), memberSize, admission)],
		["a FIFO member", memberOf(constant("fifo"), memberSize, admission)]
	]
)

/** What reading a member gives: its bytes and the handle the check saw, or the code it was refused with. */
export type MemberReading =
	| Readonly<{ kind: "read"; bytes: number; checked: Option.Option<readonly [string, number]> }>
	| Readonly<{ kind: "refused"; code: string; checked: boolean }>

/** The bytes a member of `size` holds: a repeated pattern, so a read that reorders or drops a chunk changes them. */
const memberBytes = (size: number): Uint8Array =>
	Uint8Array.from({ length: size }, (_unused, at) => (at * 31 + 7) % 251)

/**
 * The reading the specification gives: a regular file the check admits is read whole from the handle the check saw (a
 * regular file of its size); one the check refuses is refused with the check's code; a symlink at the final
 * component, a directory or a FIFO is refused as unreadable before any check.
 */
export const expectedMember = (member: Member): MemberReading => {
	if (member.layout !== "file") {
		return { kind: "refused", code: "DOC-14/unreadable", checked: false }
	}
	return member.admitted
		? { kind: "read", bytes: member.size, checked: Option.some(["File", member.size] as const) }
		: { kind: "refused", code: "DOC-14/invalid-json", checked: true }
}

/** The reading of a member laid out in the case's own directory. */
export const actualMember = (dir: ScratchDir, member: Member) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const name = path.join(dir, "member.json")
		const target = path.join(dir, "target.json")
		const bytes = memberBytes(member.size)
		switch (member.layout) {
			case "file":
				yield* fs.writeFile(name, bytes)
				break
			case "final symlink":
				yield* fs.writeFile(target, bytes)
				yield* fs.symlink(target, name)
				break
			case "directory":
				yield* fs.makeDirectory(name)
				break
			case "fifo":
				yield* fifoAt(name)
				break
		}
		const seen = yield* Ref.make<Option.Option<readonly [string, number]>>(Option.none())
		const exit = yield* Effect.exit(
			readMemberFile(name, document, (opened) =>
				Effect.andThen(
					Ref.set(
						seen,
						Option.some([opened.type, Number(ByteSize.toBigInt(opened.size))] as const)
					),
					member.admitted ? Effect.void : refuse(document, "DOC-14/invalid-json", wholeInput)
				)
			)
		)
		const checked = yield* Ref.get(seen)
		return Exit.match(exit, {
			onSuccess: (read): MemberReading => ({
				kind: "read",
				bytes: Arr.every(Arr.fromIterable(read), (byte, at) => byte === bytes[at])
					? read.length
					: -1,
				checked
			}),
			onFailure: (cause): MemberReading => ({
				kind: "refused",
				code: Option.match(Cause.findErrorOption(cause), {
					onNone: () => "a defect",
					onSome: (refusal) => refusal.diagnostic.code
				}),
				checked: Option.isSome(checked)
			})
		})
	})

export type MemberFeature =
	| "a regular member admitted"
	| "a member the check refuses"
	| "an empty member"
	| "a member past a megabyte"
	| "a symlink at the final component"
	| "a directory member"
	| "a FIFO member"

export const memberFeatures = (member: Member): ReadonlyArray<MemberFeature> => [
	...(member.layout === "file"
		? [
				member.admitted
					? ("a regular member admitted" as const)
					: ("a member the check refuses" as const)
			]
		: []),
	...(member.layout === "file" && member.size === 0 ? ["an empty member" as const] : []),
	...(member.layout === "file" && member.size >= 1024 * 1024
		? ["a member past a megabyte" as const]
		: []),
	...(member.layout === "final symlink" ? ["a symlink at the final component" as const] : []),
	...(member.layout === "directory" ? ["a directory member" as const] : []),
	...(member.layout === "fifo" ? ["a FIFO member" as const] : [])
]

/** The codes a load refusal may carry. */
const LOAD_CODES: Arr.NonEmptyReadonlyArray<LoadCode> = [
	"DOC-14/duplicate-key",
	"DOC-14/invalid-encoding",
	"DOC-14/invalid-json",
	"DOC-14/invalid-yaml",
	"DOC-14/unreadable",
	"DOC-14/unsafe-integer",
	"DOC-14/yaml-alias-cycle",
	"DOC-14/yaml-multi-document",
	"DOC-14/yaml-non-finite",
	"DOC-14/yaml-non-json-tag",
	"DOC-14/yaml-non-string-key"
]

/** A refusal as `refuse` is asked for it: its code, the pointer it names and where in the input, when known. */
export type Asked = Readonly<{
	code: LoadCode
	pointer: string
	position: Option.Option<Readonly<{ line: number; column: number; offset: number }>>
}>

const placeOf: Gen<Readonly<{ line: number; column: number; offset: number }>> = map(
	array(int(0, 10_000), { min: 3, max: 3 }),
	([line = 0, column = 0, offset = 0]) => ({ line: line + 1, column: column + 1, offset })
)

const pointerOf: Gen<string> = map(array(map(int(0, 9), String), { min: 0, max: 3 }), (tokens) =>
	Arr.join(
		Arr.map(tokens, (token) => `/${token}`),
		""
	)
)

/** Refusals asked with a place `places` draws. */
const askedWith =
	(
		places: Gen<Option.Option<Readonly<{ line: number; column: number; offset: number }>>>
	): Gen<Asked> =>
	(s) => ({
		code: s.draw(element(LOAD_CODES)),
		pointer: s.draw(pointerOf),
		position: s.draw(places)
	})

/** Refusals of any code and pointer, with a place or without, aimed at each while it is pending. */
export const askedRefusals: Aimed<Asked, AskedFeature> = aimed(askedWith(option(placeOf)), [
	["a placed refusal", askedWith(map(placeOf, Option.some))],
	["a refusal without a place", askedWith(constant(Option.none()))]
])

export type AskedFeature = "a placed refusal" | "a refusal without a place"

export const askedFeatures = (asked: Asked): ReadonlyArray<AskedFeature> => [
	Option.isSome(asked.position) ? "a placed refusal" : "a refusal without a place"
]

/** The fields a refusal holds, as the specification states them: its code, document scope, pointer, and its place. */
export const refusalFields = (refusal: LoadRefusal) => ({
	tag: refusal._tag,
	instance: Schema.is(LoadRefusal)(refusal),
	code: refusal.diagnostic.code,
	scope: refusal.diagnostic.scope,
	pointer: String(refusal.diagnostic.pointer),
	line: Option.fromNullishOr(refusal.diagnostic.line),
	column: Option.fromNullishOr(refusal.diagnostic.column),
	offset: Option.fromNullishOr(refusal.offset),
	ownOffset: "offset" in refusal
})

type RefusalFields = ReturnType<typeof refusalFields>

export const askedFields = (asked: Asked): RefusalFields => ({
	tag: "LoadRefusal",
	instance: true,
	code: asked.code,
	scope: "document",
	pointer: asked.pointer,
	line: Option.map(asked.position, (place) => place.line),
	column: Option.map(asked.position, (place) => place.column),
	offset: Option.map(asked.position, (place) => place.offset),
	ownOffset: Option.isSome(asked.position)
})

export const askedOf = (asked: Asked) =>
	Effect.flip(refuse(document, asked.code, { pointer: asked.pointer, position: asked.position }))
