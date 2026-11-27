/** What the property of digest.test.ts reads: its values, its lowerings and its SQL. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import type { Lowered } from "#compiler/scalar/compute/lower.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import {
	baseParams,
	field,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql
} from "#test/unit/compute/support.ts"

/** `length` bytes of a xorshift stream from `seed`, so a case draws two numbers, not MiB. */
const streamBytes = (length: number, seed: number): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(length)
	let x = seed | 1
	for (let i = 0; i < length; i += 1) {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		out[i] = x & 0xff
	}
	return out
}

type Arm = "empty" | "one byte" | "every byte" | "about a block" | "short" | "long"

/** A drawn value: the arm it was drawn from, its length and its seed, its bytes made when the case runs. */
export interface Value {
	readonly arm: Arm
	readonly length: number
	readonly seed: number
}

/** A value's bytes: one byte of its seed's value, every byte value once rotated by its seed, or its stream. */
export const bodyOf = (value: Value): Uint8Array<ArrayBuffer> =>
	value.arm === "one byte"
		? Uint8Array.of(value.seed & 0xff)
		: value.arm === "every byte"
			? Uint8Array.from({ length: 256 }, (_, i) => (i + value.seed) & 0xff)
			: streamBytes(value.length, value.seed)

const seed: Gen<number> = int(1, 0x7fff_ffff)

/**
 * The lengths about SHA-256's blocks: a message of at most 55 bytes pads within its last block and one of 56 to 63 into
 * a block more, at one block and at two.
 */
const blockLengths: Arr.NonEmptyReadonlyArray<number> = [55, 56, 63, 64, 65, 119, 120, 127, 128]

const value: Gen<Value> = weighted<Value>([
	[1, () => ({ arm: "empty", length: 0, seed: 1 })],
	[2, (s) => ({ arm: "one byte", length: 1, seed: s.draw(int(0, 255)) })],
	[1, (s) => ({ arm: "every byte", length: 256, seed: s.draw(int(0, 255)) })],
	[3, (s) => ({ arm: "about a block", length: s.draw(element(blockLengths)), seed: s.draw(seed) })],
	[3, (s) => ({ arm: "short", length: s.draw(int(2, 200)), seed: s.draw(seed) })]
])

/** A long value of 1 to 4 MiB. */
const long: Gen<Value> = (s) => ({
	arm: "long",
	length: s.draw(int(1 << 20, 4 << 20)),
	seed: s.draw(seed)
})

/** A batch of values, a long one a quarter of the time. */
export const batch: Gen<ReadonlyArray<Value>> = (s) => {
	const values = s.draw(array(value, { min: 1, max: 24 }))
	return s.draw(int(0, 3)) === 0 ? [...values, s.draw(long)] : values
}

export type SqlFeature =
	| "the empty value"
	| "one byte"
	| "every byte value"
	| "a value that pads within its block"
	| "a value that pads into a block more"
	| "a long value"

export const sqlNotes = (values: ReadonlyArray<Value>): ReadonlyArray<SqlFeature> =>
	Arr.flatMap(values, (x): ReadonlyArray<SqlFeature> => {
		const tail = x.length % 64
		return [
			...(x.arm === "empty" ? (["the empty value"] as const) : []),
			...(x.arm === "one byte" ? (["one byte"] as const) : []),
			...(x.arm === "every byte" ? (["every byte value"] as const) : []),
			...(x.arm === "about a block" && tail <= 55
				? (["a value that pads within its block"] as const)
				: []),
			...(x.arm === "about a block" && tail > 55
				? (["a value that pads into a block more"] as const)
				: []),
			...(x.arm === "long" ? (["a long value"] as const) : [])
		]
	})

/** A bytes column, the operand every digest reads. */
const contentColumn: LeafBinding = {
	kind: "column",
	type: field({ kind: "bytes" }, "bytea").scalar
}

/** Crypto.sha256 of the variable v, as a Description states it. */
const digestDesc: ExprDesc = { kind: "compute", fn: "sha256", args: [{ kind: "var", var: "v" }] }

/** The term Crypto.sha256(v) lowers to as a check and as a query lower it. */
const lowered = (mode: "check" | "query"): Lowered =>
	succeeded(
		lowerWith(mode, digestDesc, { v: contentColumn }, false, baseParams),
		`Crypto.sha256 lowers in a ${mode}`
	).root

/** The host evaluator's value of a lowered term over a bytes value, as a write admits it: its bytes, as hex. */
export const hostDigest = (term: Lowered, body: Uint8Array<ArrayBuffer>): string => {
	const table = predicateTable(term.expr)
	const admitted = new AdmittedBytes(body)
	const value = succeeded(
		compiledExpr(table)(
			{ value: undefined, column: () => admitted, closed: () => undefined, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates the digest"
	)
	if (!(value instanceof Uint8Array)) {
		return assert.fail(`the host's digest is its bytes, not ${Formatter.format(value)}`)
	}
	return value.toHex()
}

/** A byte array's hex text, which the batch's SQL decodes. */
export const hexOf = (body: Uint8Array<ArrayBuffer>): string => Buffer.from(body).toString("hex")

/**
 * Every value's digest, row by row, each as hex beside its length: the check's rendered SQL, the query's, and
 * PostgreSQL's own sha256(v), so the three are compared as bytes.
 */
export const digestsSql = (check: Lowered, read: Lowered): string =>
	`SELECT pg_catalog.encode(${renderSql(check.expr, plainRender)}, 'hex'), pg_catalog.encode(${renderSql(read.expr, plainRender)}, 'hex'), pg_catalog.encode(pg_catalog.sha256(r0.v), 'hex'), (pg_catalog.octet_length(${renderSql(check.expr, plainRender)}) = pg_catalog.octet_length(pg_catalog.sha256(r0.v)))::text FROM unnest($1::text[]) WITH ORDINALITY AS h(hex, ord) CROSS JOIN LATERAL (SELECT pg_catalog.decode(h.hex, 'hex') AS v) AS r0 ORDER BY h.ord`

export const read = lowered("query")

/** What the search built once before its cases (check), now once per worker: every case on it reads it. */
export const checkNeed = {
	key: "test/pg/compute/digest.fixtures.ts checkNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const check = lowered("check")
		return Effect.succeed(check)
	})
} as const satisfies Need<unknown>
