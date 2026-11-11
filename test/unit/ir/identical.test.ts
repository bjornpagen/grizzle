/**
 * Structural identity (ir/identical.ts) against the equality of canonical text, the oracle it replaces: over a drawn
 * value and a one-leaf edit of it, both decoded, the two agree. An edit replaces one string, number, bigint or boolean
 * anywhere in the value, or drops one key, so a field the structural comparison misses is an edit it calls identical
 * while the canonical texts differ. A canonical value is edited inside too, rebuilt through its own constructor: a
 * roster's name or one of its handles, replaced or dropped, and one digit of a decimal, so a canonical form that misses
 * a part its structural comparison reads, or the reverse, is a disagreement as well.
 *
 * Oracle: a second implementation, canonical text equality (core/canonical.ts canonicalEquals).
 *
 * Features: types and tables identical and different, an edit the decoder refuses, a roster and a decimal edited
 * inside.
 *
 * Plants: ir-identical-byte-bound-ignored (two texts identical whatever their byte bounds).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import {
	canonicalEquals,
	everyProperty,
	isCanonicalizable,
	taggedValueOf
} from "#compiler/core/canonical.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import type * as Result from "#compiler/core/result.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import { identicalExprTable, identicalScalarType } from "#compiler/ir/identical.ts"
import { decodeScalarType, exprTableShape } from "#compiler/ir/scalar-shape.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { decodeWith } from "#compiler/ir/shape.ts"
import { assert } from "#test/support/assert.ts"
import { toTable } from "#test/support/dag.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
import { generatedDags } from "#test/unit/ir/population.ts"
import { scalarTypeGen } from "#test/unit/ir/types.ts"

type Segment = string | number

/** A one-leaf edit: where, and whether it replaces the leaf or drops the key that holds it. */
interface Edit {
	readonly path: ReadonlyArray<Segment>
	readonly drop: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/** A decimal's text with its digit at `at` stepped to the next, when that is a decimal's one text. */
const steppedDigit = (text: string, at: number): DecimalText | undefined => {
	const digit = Number(text[at])
	return DecimalText.parse(`${Str.slice(0, at)(text)}${(digit + 1) % 10}${Str.slice(at + 1)(text)}`)
}

/** A decimal-tagged value's text: its canonical payload. */
const decimalText = (value: unknown): string | undefined => {
	const tagged = taggedValueOf(value)
	return tagged?.tag === "d" ? tagged.payload : undefined
}

type Path = ReadonlyArray<Segment>

/**
 * Where a value is edited: the path to every leaf of it as a plain value, a canonical value other than a roster or a
 * decimal (money, a vector) a leaf of its own; the paths to each roster's name and each of its handles; and the paths
 * to each digit of a decimal that steps to another decimal's text.
 */
interface Sites {
	readonly plain: ReadonlyArray<Path>
	readonly roster: ReadonlyArray<Path>
	readonly decimal: ReadonlyArray<Path>
}

const sitesOf = (root: unknown): Sites => {
	const plain: Array<Path> = []
	const roster: Array<Path> = []
	const decimal: Array<Path> = []
	const stack: Array<{ readonly value: unknown; readonly path: ReadonlyArray<Segment> }> = [
		{ value: root, path: [] }
	]
	for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
		const { value, path } = top
		if (Arr.isArray(value)) {
			for (const [i, item] of value.entries()) {
				stack.push({ value: item, path: [...path, i] })
			}
		} else if (isRecord(value) && !isCanonicalizable(value)) {
			for (const [key, item] of Rec.toEntries(value)) {
				stack.push({ value: item, path: [...path, key] })
			}
		} else if (value instanceof Roster) {
			roster.push([...path, "closed"])
			for (const i of upTo(value.handles.length, (at) => at)) {
				roster.push([...path, "handles", i])
			}
		} else {
			const text = decimalText(value)
			if (text === undefined) {
				plain.push(path)
			} else {
				for (const i of upTo(text.length, (at) => at)) {
					if (steppedDigit(text, i) !== undefined) {
						decimal.push([...path, "digits", i])
					}
				}
			}
		}
	}
	return { plain, roster, decimal }
}

/** Another value of a leaf's own kind: a string extended, a number or bigint stepped, a boolean flipped. */
const replaced = (leaf: unknown): unknown => {
	switch (typeof leaf) {
		case "string":
			return `${leaf}x`
		case "number":
			return leaf + 1
		case "bigint":
			return leaf + 1n
		case "boolean":
			return !leaf
		case "function":
		case "object":
		case "symbol":
		case "undefined":
			return leaf
	}
}

/**
 * A roster with its name replaced, or its handle at `at` replaced or dropped, made by its constructor; the roster as it
 * is where the edit leaves no declared name or no handle.
 */
const rosterEdited = (
	roster: Roster,
	part: Segment,
	at: Segment | undefined,
	drop: boolean
): Roster => {
	if (part === "closed") {
		const name = parseDeclaredName(`${roster.closed}x`)
		return name.ok ? Roster.of(name.value, roster.handles) : roster
	}
	if (typeof at !== "number") {
		return roster
	}
	const handles = drop
		? Arr.filter(roster.handles, (_, i) => i !== at)
		: Arr.map(roster.handles, (h, i) => (i === at ? `${h}x` : h))
	return Arr.isReadonlyArrayNonEmpty(handles) ? Roster.of(roster.closed, handles) : roster
}

/** The value with the edit applied: each container on the path copied, every other part shared. */
const applied = (value: unknown, path: ReadonlyArray<Segment>, drop: boolean): unknown => {
	const [head, ...rest] = path
	if (head === undefined) {
		return replaced(value)
	}
	if (value instanceof Roster) {
		return rosterEdited(value, head, rest[0], drop)
	}
	const text = decimalText(value)
	if (text !== undefined) {
		const at = rest[0]
		return typeof at === "number" ? (steppedDigit(text, at) ?? value) : value
	}
	if (Arr.isArray(value) && typeof head === "number") {
		const items: Array<unknown> = [...value]
		if (rest.length === 0 && drop) {
			items.splice(head, 1)
		} else {
			items[head] = applied(items[head], rest, drop)
		}
		return items
	}
	if (isRecord(value) && typeof head === "string") {
		const entries = Arr.flatMap(
			Rec.toEntries(value),
			([key, item]): ReadonlyArray<[string, unknown]> =>
				key !== head
					? [[key, item]]
					: rest.length === 0 && drop
						? []
						: [[key, applied(item, rest, drop)]]
		)
		return Rec.fromEntries(entries)
	}
	return value
}

/**
 * A drawn edit of `value`: one of its sites, replaced or dropped, the kind of site drawn first among those it has, so a
 * roster's part or a decimal's digit is drawn as often as a plain leaf however few of them the value holds.
 */
const editOf =
	(value: unknown): Gen<Edit | undefined> =>
	(source) => {
		const sites = sitesOf(value)
		const kinds = Arr.filter(
			[sites.plain, sites.roster, sites.decimal],
			(paths) => paths.length > 0
		)
		const paths = kinds[source.draw(int(0, Math.max(0, kinds.length - 1)))]
		const path = paths === undefined ? undefined : paths[source.draw(int(0, paths.length - 1))]
		return path === undefined ? undefined : { path, drop: source.draw(int(0, 3)) === 0 }
	}

type Population =
	| { readonly kind: "type"; readonly value: unknown; readonly edit: Edit | undefined }
	| { readonly kind: "table"; readonly value: unknown; readonly edit: Edit | undefined }

const typePopulation: Gen<Population> = (source) => {
	const value = source.draw(scalarTypeGen)
	return { kind: "type", value, edit: source.draw(editOf(value)) }
}

/** A generated DAG's expressions as one table, rooted at its first. */
const tablePopulation: Gen<Population> = (source) => {
	const table = toTable(source.draw(generatedDags))
	const first = table.ok ? Rec.keys(table.value.exprs)[0] : undefined
	const value = table.ok && first !== undefined ? { root: first, exprs: table.value.exprs } : {}
	return { kind: "table", value, edit: source.draw(editOf(value)) }
}

type Feature =
	| "types identical"
	| "types different"
	| "tables identical"
	| "tables different"
	| "an edit refused"
	| "a roster edited inside"
	| "a decimal edited inside"

/** The canonical value an edit's path enters, if any: a roster or a decimal it edits a part of. */
const enteredAt = (value: unknown, path: ReadonlyArray<Segment>): Feature | undefined => {
	const [head, ...rest] = path
	if (head === undefined) {
		return undefined
	}
	if (value instanceof Roster) {
		return "a roster edited inside"
	}
	if (decimalText(value) !== undefined) {
		return "a decimal edited inside"
	}
	if (Arr.isArray(value) && typeof head === "number") {
		return enteredAt(value[head], rest)
	}
	return isRecord(value) && typeof head === "string" ? enteredAt(value[head], rest) : undefined
}

/** The two decoded values of a case, or none where either does not decode. */
const decodedPair = <A>(
	decode: (value: unknown) => Result.Result<A, unknown>,
	c: Population
): readonly [A, A] | undefined => {
	const original = decode(c.value)
	const other = decode(c.edit === undefined ? c.value : applied(c.value, c.edit.path, c.edit.drop))
	return original.ok && other.ok ? [original.value, other.value] : undefined
}

const decodeTable = (value: unknown): Result.Result<ExprTable, unknown> =>
	decodeWith(exprTableShape, value, "expression table")

describe("structural identity", () => {
	it.effect(
		"agrees with canonical text equality over every one-leaf edit of a decoded type or expression table",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/identical",
						literal: Formatter.format,
						draw: drawn(oneOf([typePopulation, tablePopulation])),
						runs: 400,
						shrink: completeShrink,
						coverage: required<Feature>(
							[
								"types identical",
								"types different",
								"tables identical",
								"tables different",
								"an edit refused",
								"a roster edited inside",
								"a decimal edited inside"
							],
							{ cases: 800, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "second-implementation", name: "canonical text equality" }
					},
					(c, n) =>
						Effect.sync(() => {
							const entered = c.edit === undefined ? undefined : enteredAt(c.value, c.edit.path)
							if (entered !== undefined) {
								n.note(entered)
							}
							if (c.kind === "type") {
								const pair = decodedPair(decodeScalarType, c)
								if (pair === undefined) {
									n.note("an edit refused")
									return
								}
								const canonical = canonicalEquals(pair[0], pair[1], everyProperty)
								n.note(canonical ? "types identical" : "types different")
								assert.equal(identicalScalarType(pair[0], pair[1]), canonical)
								return
							}
							const pair = decodedPair(decodeTable, c)
							if (pair === undefined) {
								n.note("an edit refused")
								return
							}
							const canonical = canonicalEquals(pair[0], pair[1], everyProperty)
							n.note(canonical ? "tables identical" : "tables different")
							assert.equal(identicalExprTable(pair[0], pair[1]), canonical)
						})
				)
			)
	)
})
