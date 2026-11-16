/** What the properties of identical.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { isCanonicalizable, taggedValueOf } from "#compiler/core/canonical.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import type * as Result from "#compiler/core/result.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import { exprTableShape } from "#compiler/ir/scalar-shape.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { decodeWith } from "#compiler/ir/shape.ts"
import { toTable } from "#test/support/dag.ts"
import { upTo } from "#test/support/up-to.ts"
import { generatedDags } from "#test/unit/ir/population.ts"
import { scalarTypeGen } from "#test/unit/ir/types.ts"

/** One step of a path: a key or an index. */
type Segment = string | number

/** A one-leaf edit: where, and whether it replaces the leaf or drops the key that holds it. */
interface Edit {
	readonly path: ReadonlyArray<Segment>
	readonly drop: boolean
}

/** Whether a value is a plain record: an object that is no array. */
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

/** A path from a value's root to one of its members. */
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

/** Where a value is edited: every leaf of it by its kind (Sites). */
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

/** A decoded type or expression table, and the one-leaf edit made of it, if any. */
type Population =
	| { readonly kind: "type"; readonly value: unknown; readonly edit: Edit | undefined }
	| { readonly kind: "table"; readonly value: unknown; readonly edit: Edit | undefined }

/** A generated scalar type and an edit of one of its leaves, or none. */
export const typePopulation: Gen<Population> = (source) => {
	const value = source.draw(scalarTypeGen)
	return { kind: "type", value, edit: source.draw(editOf(value)) }
}

/** A generated DAG's expressions as one table, rooted at its first. */
export const tablePopulation: Gen<Population> = (source) => {
	const table = toTable(source.draw(generatedDags))
	const first = table.ok ? Rec.keys(table.value.exprs)[0] : undefined
	const value = table.ok && first !== undefined ? { root: first, exprs: table.value.exprs } : {}
	return { kind: "table", value, edit: source.draw(editOf(value)) }
}

/** What a case reached: two types or two tables, identical or different, and each kind of edit. */
export type Feature =
	| "types identical"
	| "types different"
	| "tables identical"
	| "tables different"
	| "an edit refused"
	| "a roster edited inside"
	| "a decimal edited inside"

/** The canonical value an edit's path enters, if any: a roster or a decimal it edits a part of. */
export const enteredAt = (value: unknown, path: ReadonlyArray<Segment>): Feature | undefined => {
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
export const decodedPair = <A>(
	decode: (value: unknown) => Result.Result<A, unknown>,
	c: Population
): readonly [A, A] | undefined => {
	const original = decode(c.value)
	const other = decode(c.edit === undefined ? c.value : applied(c.value, c.edit.path, c.edit.drop))
	return original.ok && other.ok ? [original.value, other.value] : undefined
}

/** An expression table decoded through its shape. */
export const decodeTable = (value: unknown): Result.Result<ExprTable, unknown> =>
	decodeWith(exprTableShape, value, "expression table")
