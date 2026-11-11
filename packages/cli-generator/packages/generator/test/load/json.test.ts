import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { ByteSize, Effect, FileSystem, Option, Schema, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { loadFile, loadStream } from "#load/index.ts"
import type { LoadOptions, LoadRefusal } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"

const fixture = (name: string) => path.join(import.meta.dirname, "..", "fixtures", "load", name)

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec.json")

const options = (limits?: LoadOptions["limits"]): LoadOptions =>
	limits === undefined ? { document } : { document, limits }

const encode = (text: string) => new TextEncoder().encode(text)

const file = (name: string, limits?: LoadOptions["limits"]) =>
	loadFile(fixture(name), options(limits)).pipe(Effect.provide(NodeFileSystem.layer))

const refusal = <A>(effect: Effect.Effect<A, LoadRefusal>) => Effect.runPromise(Effect.flip(effect))

describe("load: strict JSON", () => {
	test("a file over the limit is refused from its size before it is read", async () => {
		const error = await refusal(file("duplicate-key.json", { maxBytes: 16 }))
		expect(error.diagnostic.code).toBe("DOC-14/too-large")
	})

	test("a stream over the limit is refused", async () => {
		const chunks = Stream.make(encode('{"a":"'), encode("x".repeat(64)), encode('"}'))
		const error = await refusal(loadStream(chunks, options({ maxBytes: 32 })))
		expect(error.diagnostic.code).toBe("DOC-14/too-large")

		const within = await Effect.runPromise(loadStream(chunks, options()))
		expect(within.format).toBe("json")
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
				loadFile(link, options()).pipe(Effect.provide(NodeFileSystem.layer))
			)
			expect(loaded.format).toBe("yaml")
			expect(loaded.document).toBe(document)
		} finally {
			rmSync(base, { force: true, recursive: true })
		}
	})
})

const withFs = (overrides: Partial<FileSystem.FileSystem>) =>
	loadFile("/virtual/spec.json", options({ maxBytes: 1024, maxDepth: 256, maxNodes: 10_000 })).pipe(
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
	test("a file that reports a small size but streams past the cap is refused at the cap", async () => {
		let served = 0
		const chunk = new Uint8Array(512).fill(0x20)
		const endless: FileSystem.File = {
			[FileSystem.FileTypeId]: FileSystem.FileTypeId,
			read: () => Effect.succeed(0),
			readAlloc: () =>
				Effect.sync(() => {
					served += chunk.length

					return Option.some(chunk)
				}),
			seek: () => Effect.succeed(0n),
			stat: Effect.succeed(info(10, "File")),
			sync: Effect.void,
			truncate: () => Effect.void,
			write: () => Effect.succeed(0),
			writeAll: () => Effect.void
		}
		const error = await refusal(
			withFs({
				open: () => Effect.succeed(endless),
				stat: () => Effect.succeed(info(10, "File"))
			})
		)
		expect(error.diagnostic.code).toBe("DOC-14/too-large")
		expect(served).toBeLessThanOrEqual(1024 + 512 * 2)
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
				loadFile(fifo, options()).pipe(Effect.provide(NodeFileSystem.layer))
			)
			expect(error.diagnostic.code).toBe("DOC-14/unreadable")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
