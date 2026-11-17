import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import {
	Array as Arr,
	ByteSize,
	Effect,
	FileSystem,
	Option,
	Schema,
	Stream,
	String as Str
} from "effect"
import { describe, expect, test } from "vitest"
import { loadFile, loadStream } from "#load/index.ts"
import type { LoadOptions, LoadRefusal } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"

const fixture = (name: string) => path.join(import.meta.dirname, "..", "fixtures", "load", name)

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec.json")

const options: LoadOptions = { document }

const encode = (text: string) => new TextEncoder().encode(text)

const file = (name: string) =>
	loadFile(fixture(name), options).pipe(Effect.provide(NodeFileSystem.layer))

const refusal = <A>(effect: Effect.Effect<A, LoadRefusal>) => Effect.runPromise(Effect.flip(effect))

describe("load: strict JSON", () => {
	test("a stream is read whole, across its chunks", async () => {
		const filler = Str.repeat(64)("x")
		const chunks = Stream.make(encode('{"a":"'), encode(filler), encode('"}'))
		const loaded = await Effect.runPromise(loadStream(chunks, options))
		expect(loaded.format).toBe("json")
		expect(loaded.value).toEqual({ a: filler })
	})

	test("anything not starting with a brace is routed to YAML", async () => {
		const loaded = await Effect.runPromise(file("spec.yaml"))
		expect(loaded.format).toBe("yaml")
	})

	test("a missing file is refused as unreadable", async () => {
		const error = await refusal(file("missing.json"))
		expect(error.diagnostic.code).toBe("DOC-14/unreadable")
	})

	test("an entry document named through a symlink loads", async () => {
		const scratch = path.join(import.meta.dirname, "..", "..", "work")

		mkdirSync(scratch, { recursive: true })

		const base = mkdtempSync(path.join(scratch, "load-link-"))
		const link = path.join(base, "spec.yaml")

		try {
			symlinkSync(fixture("spec.yaml"), link)

			const loaded = await Effect.runPromise(
				loadFile(link, options).pipe(Effect.provide(NodeFileSystem.layer))
			)
			expect(loaded.format).toBe("yaml")
			expect(loaded.document).toBe(document)
		} finally {
			rmSync(base, { force: true, recursive: true })
		}
	})
})

const withFs = (overrides: Partial<FileSystem.FileSystem>) =>
	loadFile("/virtual/spec.json", options).pipe(
		Effect.provide(
			FileSystem.layerNoop({ realPath: (given) => Effect.succeed(given), ...overrides })
		)
	)

const info = (size: number, type: FileSystem.File.Type): FileSystem.File.Info => ({
	atime: Option.none(),
	birthtime: Option.none(),
	blksize: Option.none(),
	blocks: Option.none(),
	dev: 0n,
	gid: Option.none(),
	ino: Option.none(),
	mode: 0,
	mtime: Option.none(),
	nlink: Option.none(),
	rdev: Option.none(),
	size: ByteSize.bytes(size),
	type,
	uid: Option.none()
})

describe("load: bytes actually read", () => {
	test("a file that holds more than its size reports is read on to its end", async () => {
		const filler = Str.repeat(100)("x")
		const text = encode(`{"a":"${filler}"}`)
		const asked: Array<number> = []
		let at = 0
		const growing: FileSystem.File = {
			[FileSystem.FileTypeId]: FileSystem.FileTypeId,
			read: () => Effect.succeed(0),
			readAlloc: (size) =>
				Effect.sync(() => {
					asked.push(size)
					const chunk = text.subarray(at, at + size)
					at += chunk.length

					return chunk.length === 0 ? Option.none() : Option.some(chunk)
				}),
			seek: () => Effect.succeed(0n),
			stat: Effect.succeed(info(10, "File")),
			sync: Effect.void,
			truncate: () => Effect.void,
			write: () => Effect.succeed(0),
			writeAll: () => Effect.void
		}
		const loaded = await Effect.runPromise(
			withFs({
				open: () => Effect.succeed(growing),
				stat: () => Effect.succeed(info(10, "File"))
			})
		)
		expect(loaded.value).toEqual({ a: filler })
		expect(Arr.dedupe(asked)).toEqual([10])
	})

	test("a non-regular file is refused without being opened", async () => {
		let opened = false
		const error = await refusal(
			withFs({
				readFile: () =>
					Effect.sync(() => {
						opened = true

						return new Uint8Array()
					}),
				stat: () => Effect.succeed(info(0, "CharacterDevice")),
				stream: () =>
					Stream.sync(() => {
						opened = true

						return new Uint8Array()
					})
			})
		)
		expect(error.diagnostic.code).toBe("DOC-14/unreadable")
		expect(opened).toBe(false)
	})

	test("a real FIFO is refused", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "load-fifo-"))
		const fifo = path.join(dir, "spec.json")

		try {
			execFileSync("mkfifo", [fifo])

			const error = await refusal(
				loadFile(fifo, options).pipe(Effect.provide(NodeFileSystem.layer))
			)
			expect(error.diagnostic.code).toBe("DOC-14/unreadable")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
