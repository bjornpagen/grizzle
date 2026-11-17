import { readFileSync } from "node:fs"
import path from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Array as Arr, Effect, Schema, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import { loadBytes, loadFile } from "#load/index.ts"
import type { LoadOptions, LoadRefusal } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"
import { RowId } from "#model/entities.ts"
import type { Json } from "#model/pointer.ts"

const fixture = (name: string) => path.join(import.meta.dirname, "..", "fixtures", "yaml", name)

const document = Schema.decodeUnknownSync(DocumentUri)("file:///spec.yaml")

const rowId = Schema.decodeUnknownSync(RowId)

const options: LoadOptions = { document }

const encode = (text: string) => new TextEncoder().encode(text)

const file = (name: string) =>
	loadFile(fixture(name), options).pipe(Effect.provide(NodeFileSystem.layer))

const text = (source: string) => loadBytes(encode(source), options)

const refusal = <A>(effect: Effect.Effect<A, LoadRefusal>) => Effect.runPromise(Effect.flip(effect))

const pointerOf = (error: LoadRefusal): string => error.diagnostic.pointer

const value = async (name: string) => {
	const loaded = await Effect.runPromise(file(name))

	return loaded.value
}

describe("load: strict YAML hazards", () => {
	const hazards = [
		["duplicate-key.yaml", "DOC-14/duplicate-key"],
		["multi-document.yaml", "DOC-14/yaml-multi-document"],
		["cyclic-anchor.yaml", "DOC-14/yaml-alias-cycle"],
		["non-scalar-key-seq.yaml", "DOC-14/yaml-non-string-key"],
		["non-scalar-key-map.yaml", "DOC-14/yaml-non-string-key"],
		["timestamp-tag.yaml", "DOC-14/yaml-non-json-tag"],
		["binary-tag.yaml", "DOC-14/yaml-non-json-tag"],
		["custom-tag.yaml", "DOC-14/yaml-non-json-tag"],
		["inf.yaml", "DOC-14/yaml-non-finite"],
		["nan.yaml", "DOC-14/yaml-non-finite"]
	] as const

	test.each(hazards)("%s is refused as %s", async (name, code) => {
		const error = await refusal(file(name))
		expect(error._tag).toBe("LoadRefusal")
		expect(error.diagnostic.code).toBe(code)
		expect(error.diagnostic.row).toBe(rowId("DOC-14"))
	})

	test("the merge key stays an ordinary key", async () => {
		expect(await value("merge-key.yaml")).toEqual({
			base: { x: 1 },
			m: { "<<": { x: 1 }, y: 2 }
		})
	})

	test("yes, = and an integer key stay strings", async () => {
		expect(await value("yes.yaml")).toEqual({ v: "yes" })
		expect(await value("equals.yaml")).toEqual({ v: "=" })
		expect(await value("integer-key.yaml")).toEqual({ "200": "ok" })
	})

	test("Failsafe key text and plain dates are kept as written", async () => {
		const loaded = await Effect.runPromise(text("0x1F: a\nnull: b\ntrue: c\nd: 2001-12-14\n"))
		expect(loaded.format).toBe("yaml")
		expect(loaded.value).toEqual({ "0x1F": "a", d: "2001-12-14", null: "b", true: "c" })
	})
})

describe("load: strict YAML positions", () => {
	test("a duplicate key reports its line, column and byte offset", async () => {
		const error = await refusal(file("duplicate-key.yaml"))
		expect(error.diagnostic.line).toBe(2)
		expect(error.diagnostic.column).toBe(1)
		expect(error.offset).toBe(5)
	})

	test("a non-finite number reports its pointer and position", async () => {
		const error = await refusal(file("inf.yaml"))
		expect(pointerOf(error)).toBe("/n")
		expect(error.diagnostic.line).toBe(1)
		expect(error.diagnostic.column).toBe(4)
		expect(error.offset).toBe(3)
	})

	test("a tag refusal points at the tagged value", async () => {
		const error = await refusal(file("timestamp-tag.yaml"))
		expect(pointerOf(error)).toBe("/t")
		expect(error.diagnostic.line).toBe(1)
	})

	test("offsets count bytes and include a byte order mark", async () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("é: 1\né: 2\n")])
		const error = await refusal(loadBytes(bytes, options))
		expect(error.diagnostic.code).toBe("DOC-14/duplicate-key")
		expect(error.diagnostic.line).toBe(2)
		expect(error.offset).toBe(3 + 6)
	})

	test("offset counts UTF-8 bytes", async () => {
		const source = "€: 1\nx: {é: 1, é: 2}\n"
		const plain = await refusal(text(source))
		expect(plain.diagnostic.code).toBe("DOC-14/duplicate-key")
		expect(plain.offset).toBe(18)
		expect(plain.diagnostic.line).toBe(2)
		expect(plain.diagnostic.column).toBe(11)

		const withBom = await refusal(
			loadBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...encode(source)]), options)
		)
		expect(withBom.offset).toBe(3 + 18)
		expect(withBom.diagnostic.line).toBe(2)
		expect(withBom.diagnostic.column).toBe(11)
	})
})

describe("load: strict YAML values", () => {
	test("a YAML file equals its JSON twin", async () => {
		const twin = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
			readFileSync(fixture("twin.json"), "utf-8")
		)
		const loaded = await value("twin.yaml")
		expect(loaded).toEqual(twin)
	})

	test("__proto__ is an own key and changes no prototype", async () => {
		const loaded = await Effect.runPromise(text("a:\n  __proto__:\n    polluted: 1\n"))
		expect(JSON.stringify(loaded.value)).toBe('{"a":{"__proto__":{"polluted":1}}}')
		expect(Reflect.has({}, "polluted")).toBe(false)
	})

	test("an alias loads as the anchored value", async () => {
		const loaded = await Effect.runPromise(text("a: &a [1, 2]\nb: *a\nc: *a\n"))
		expect(loaded.value).toEqual({ a: [1, 2], b: [1, 2], c: [1, 2] })
	})

	test("an alias bomb loads with each alias sharing its anchor's one value, never a copy", async () => {
		const loaded = await Effect.runPromise(file("alias-bomb.yaml"))
		const root = loaded.value as Readonly<Record<string, ReadonlyArray<unknown>>>
		expect(root["i"]?.length).toBe(10)
		expect(root["b"]?.[0]).toBe(root["a"])
		expect(root["i"]?.[9]).toBe(root["h"])
	})

	test("nesting 300 deep loads, refused by no depth", async () => {
		const loaded = await Effect.runPromise(
			text(`a: ${Str.repeat(300)("[")}${Str.repeat(300)("]")}\n`)
		)
		const nested = Arr.reduce(Arr.range(2, 300), Arr.empty<Json>(), (inner): Json => [inner])
		expect(loaded.value).toEqual({ a: nested })
	})

	test("very deep nesting is refused, not crashed", async () => {
		const error = await refusal(text(`a: ${"[".repeat(20_000)}`))
		expect(error._tag).toBe("LoadRefusal")
	})

	test("malformed YAML is refused as invalid", async () => {
		const error = await refusal(text("a: [1, 2\nb: {\n"))
		expect(error.diagnostic.code).toBe("DOC-14/invalid-yaml")
	})

	test("an empty stream is refused as invalid", async () => {
		const error = await refusal(text(""))
		expect(error.diagnostic.code).toBe("DOC-14/invalid-yaml")
	})
})
