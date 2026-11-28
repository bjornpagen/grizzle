/**
 * A row's calls (test/types/evidence/call-keys.ts, test/unit/program/describe.test.ts): a row keyed by its id, of a
 * variant cell, a list, a base and a series' two ends, matched with the rows a call returns at the fields it reads
 * (ir/rel.ts CallFunction): its cell's arm (V.arm), its list's tokens (r.tokens) and pieces at a comma (r.split), its
 * list's rest after a prefix (r.rest), the path it spells (r.decodedPath), its target within the row's base
 * (r.resolvedWithin), its split at its last comma (r.splitLast), a series from its low to its high (r.series), a declared
 * function's rows at its list (Fn.rows) and the rows a field of a declared function's row holds at it (Fn.row); each
 * cell's query built through the builder's JavaScript view, its row's id pinned by a parameter or not and a call's place,
 * where a column numbers its rows, delivered, fixed to a literal or dropped. metis's kept feedback is of them: its
 * snapshot's 'string' arm, which the snapshot's key fixes (packages/delivery/src/reads.ts), the cell's arm at a pinned id.
 */
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Record as Rec } from "effect"
import { Fn } from "#compiler/public/compute.ts"
import { variant, bool, int4 } from "#compiler/public/fields.ts"
import { v } from "#compiler/public/query.ts"
import { closed, fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { UntypedTerm } from "#compiler/query/build/terms.ts"

/** How a cell reads a call's place: delivered in its head, fixed to a literal, or bound and dropped. */
export type PlaceUse = "delivered" | "fixed to a literal" | "dropped"

/** The row's fields a call reads. */
export type RowField = "cell" | "list" | "base" | "lo" | "hi"

/** A call's place: the field numbering its rows, and the literal a cell fixes it to, none for an exact integer's. */
interface Place {
	readonly field: string
	readonly literal: { readonly value: number | bigint; readonly spelled: string } | undefined
}

/**
 * A call a cell matches: the row's fields it reads, its fields, its place where it has one, and its source over the row's
 * variables, through the builder's JavaScript view and as the program spells it over `f`.
 */
export interface CallSpec {
	readonly reads: Arr.NonEmptyReadonlyArray<RowField>
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	readonly place: Place | undefined
	readonly built: (r: RuleValue, f: RowVars) => unknown
	readonly spelled: string
}

/** A text within 512 UTF-8 bytes: the row's list and base, so a target within its base is bounded (r.resolvedWithin). */
const Text = str.bytes(512, str.regex("^.*$", "su"))
/** A text within 40 UTF-8 bytes: the cell's name and a declared function's piece. */
const Name = str.bytes(40, str.regex("^.*$", "su"))

const Kind = closed.unordered("Kind", ["flag", "name"])
/** The row's cell: a flag, or a name, the arm a cell reads. */
const Value = variant("Value", Kind, { flag: { value: bool }, name: { text: Name } })
export const Row = relation(
	"Row",
	{ id: int4, cell: Value, list: Text, base: Text, lo: int4, hi: int4 },
	["id"]
)
/** A declared function's rows of a list: each piece at its place, the rows PostgreSQL alone evaluates. */
const pieces = fn("pieces", {
	calls: [],
	args: { t: Text },
	returns: rows({ at: int4, piece: Name }),
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT o::integer, left(p, 10) FROM unnest(string_to_array(t, ' ')) WITH ORDINALITY AS u(p, o)`
})
/** A declared function of one row, whose one field holds a list's pieces at their places. */
const parted = fn("parted", {
	calls: [],
	args: { t: Text },
	returns: row(rows({ parts: rows({ at: int4, piece: Name }) })),
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT NULL`
})
export const CallKeys = schema("CallKeys", [Kind, Row, pieces, parted], [])

/** The row's variables, each a term of its field, which a call's arguments read. */
const rowVars = () => v(Row, "row")
type RowVars = ReturnType<typeof rowVars>

/** A place fixed to the bigint 0, a split's. */
const bigZero: Place["literal"] = { value: 0n, spelled: "0n" }
/** A place fixed to the integer 0, a declared function's. */
const intZero: Place["literal"] = { value: 0, spelled: "0" }

/** Every call a cell matches, by what it returns at the row. */
export const calls = {
	"its cell's name arm": {
		reads: ["cell"],
		fields: ["text"],
		place: undefined,
		built: (_r, f) => Value.arm(f.cell, "name"),
		spelled: 'Value.arm(f.cell, "name")'
	},
	"its list's tokens": {
		reads: ["list"],
		fields: ["at", "token"],
		place: { field: "at", literal: bigZero },
		built: (r, f) => r.tokens(f.list),
		spelled: "r.tokens(f.list)"
	},
	"its list's pieces at a comma": {
		reads: ["list"],
		fields: ["at", "piece"],
		place: { field: "at", literal: bigZero },
		built: (r, f) => r.split(f.list, ","),
		spelled: 'r.split(f.list, ",")'
	},
	"its list's rest after a prefix": {
		reads: ["list"],
		fields: ["rest"],
		place: undefined,
		built: (r, f) => r.rest(f.list, "a"),
		spelled: 'r.rest(f.list, "a")'
	},
	"the path its list spells": {
		reads: ["list"],
		fields: ["path"],
		place: undefined,
		built: (r, f) => r.decodedPath(f.list),
		spelled: "r.decodedPath(f.list)"
	},
	"its list's target within its base": {
		reads: ["base", "list"],
		fields: ["target"],
		place: undefined,
		built: (r, f) => r.resolvedWithin(f.base, f.list),
		spelled: "r.resolvedWithin(f.base, f.list)"
	},
	"its list split at its last comma": {
		reads: ["list"],
		fields: ["before", "after"],
		place: undefined,
		built: (r, f) => r.splitLast(f.list, ","),
		spelled: 'r.splitLast(f.list, ",")'
	},
	"a series from its low to its high": {
		reads: ["lo", "hi"],
		fields: ["at"],
		place: { field: "at", literal: undefined },
		built: (r, f) => r.series(f.lo, f.hi),
		spelled: "r.series(f.lo, f.hi)"
	},
	"a declared function's rows at its list": {
		reads: ["list"],
		fields: ["at", "piece"],
		place: { field: "at", literal: intZero },
		built: (_r, f) => Fn.rows(pieces, { t: f.list }),
		spelled: "Fn.rows(pieces, { t: f.list })"
	},
	"a declared function's row's field at its list": {
		reads: ["list"],
		fields: ["at", "piece"],
		place: { field: "at", literal: intZero },
		built: (_r, f) => Fn.row(parted, { t: f.list }).parts,
		spelled: "Fn.row(parted, { t: f.list }).parts"
	}
} as const satisfies Readonly<Record<string, CallSpec>>

export type CallKind = keyof typeof calls

/** Every call a rule matches at the row, by what it returns there. */
export const callKinds: Arr.NonEmptyReadonlyArray<CallKind> = nonEmpty(Rec.keys(calls), "a call")

/**
 * A cell of each call: the row's id pinned and its place, where it has one, delivered, as metis's kept feedback reads
 * its snapshot's arm at the snapshot's whole key.
 */
export const pinnedCell = (call: CallKind): Cell => ({
	call,
	pinned: true,
	place: calls[call].place === undefined ? undefined : "delivered"
})

/** A cell: the call it matches, whether the row's id is pinned, and how it reads the call's place where it has one. */
export interface Cell {
	readonly call: CallKind
	readonly pinned: boolean
	readonly place: PlaceUse | undefined
}

/** The ways a cell reads a call's place: none for a call of no place, and fixed only where a literal is of its type. */
export const placeUses = (spec: CallSpec): ReadonlyArray<PlaceUse | undefined> =>
	spec.place === undefined
		? [undefined]
		: spec.place.literal === undefined
			? ["delivered", "dropped"]
			: ["delivered", "fixed to a literal", "dropped"]

/** What a cell's match binds a call's field to: its variable, or the place's literal where the cell fixes it. */
type Bound =
	| { readonly kind: "variable" }
	| { readonly kind: "literal"; readonly literal: NonNullable<Place["literal"]> }

/** What a cell binds each field of its call to, in heading order, and whether its head delivers the field. */
export const fieldsOf = (
	cell: Cell
): ReadonlyArray<{
	readonly field: string
	readonly bound: Bound
	readonly delivered: boolean
}> => {
	const spec: CallSpec = calls[cell.call]
	return Arr.map(spec.fields, (field) => {
		const place = spec.place?.field === field ? spec.place : undefined
		const literal = place?.literal
		return place === undefined
			? { field, bound: { kind: "variable" }, delivered: true }
			: cell.place === "fixed to a literal" && literal !== undefined
				? { field, bound: { kind: "literal", literal }, delivered: false }
				: { field, bound: { kind: "variable" }, delivered: cell.place === "delivered" }
	})
}

/** A cell's query, through the builder's JavaScript view, as the engine compiles it. */
export const cellQuery = (cell: Cell): unknown =>
	queryOver(CallKeys).rule((r: RuleValue) => {
		const spec: CallSpec = calls[cell.call]
		const f = rowVars()
		const source = spec.built(r, f)
		const own = varsOver(source, "call")
		const c = (field: string): UntypedTerm => defined(own[field], `the call's field ${field}`)
		const fields = fieldsOf(cell)
		const rowBound: ReadonlyArray<"id" | RowField> = ["id", ...spec.reads]
		const matched = r
			.match(Row, Rec.fromEntries(Arr.map(rowBound, (k) => [k, f[k]] as const)))
			.match(
				source,
				Rec.fromEntries(
					Arr.map(fields, ({ field, bound }) =>
						bound.kind === "literal"
							? ([field, bound.literal.value] as const)
							: ([field, c(field)] as const)
					)
				)
			)
		return (cell.pinned ? matched.where(r.eq(f.id, r.param("id", int4))) : matched).find(
			Rec.fromEntries([
				["id", f.id] as const,
				...Arr.flatMap(fields, ({ field, delivered }) =>
					delivered ? [[field, c(field)] as const] : []
				)
			])
		)
	})
