/** What the property of stored-kinds.test.ts reads: its schema, programs, spaces and helpers. */

import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import {
	printed,
	type RawDocument,
	raw,
	rawText,
	stored
} from "#test/unit/values/search-document.fixtures.ts"

/**
 * The bound of Kept's amount, pg.numeric.within(keptDigits, keptScale): below 10^6 in magnitude, at most 3 fraction
 * digits, a sum's of numeric(5, 3) over a few rows.
 */
const keptDigits = 6
const keptScale = 3

/**
 * Source: what a read delivers, each row written by a direct writer (the case's owner session), a document of drawn
 * text as tsvectorin stores it, an instant of drawn microseconds and a numeric of no typmod: what the case reads back
 * through grizzle and stores.
 */
export const Source = relation(
	"Source",
	{ id: pg.integer, at: instant.stored, doc: pg.tsvector("simple"), amount: pg.numeric },
	["id"]
)

/**
 * Kept: a read's rows stored as they were read, a stored instant in its primary key, a stored document and a computed
 * numeric of a bound (keptDigits, keptScale), each its caller's.
 */
export const Kept = relation(
	"Kept",
	{
		id: pg.integer,
		at: instant.stored,
		doc: pg.tsvector("simple"),
		amount: pg.numeric.within(keptDigits, keptScale)
	},
	["id", "at"]
)

/** Copied: a query's copy of Source's instants and documents, written in the statement that reads them. */
const Copied = relation(
	"Copied",
	{ id: pg.integer, at: instant.stored, doc: pg.tsvector("simple") },
	["id"]
)

/** Each id's rows one unit: Kept's rows are put again with another row's document, so Kept is mutable. */
export const Stored = schema(
	"StoredKinds",
	[Source, Kept, Copied],
	[mutable(Kept), unit("Read", { id: pg.integer })]
)

/** Every row of Source. */
const sources = query(Stored).rule((r) => {
	const { id, at, doc, amount } = v(Source, "s")
	return r.match(Source, { id, at, doc, amount }).find({ id, at, doc, amount })
})

/** Every row of Kept. */
const kept = query(Stored).rule((r) => {
	const { id, at, doc, amount } = v(Kept, "k")
	return r.match(Kept, { id, at, doc, amount }).find({ id, at, doc, amount })
})

/** Every row of Copied. */
const copied = query(Stored).rule((r) => {
	const { id, at, doc } = v(Copied, "c")
	return r.match(Copied, { id, at, doc }).find({ id, at, doc })
})

/**
 * The workload: Kept's rows written with the facts each call gives, inserted and put; Source, Kept and Copied read;
 * and Copied filled from Source by a query, its instants and documents stated by its terms.
 */
const programs = Object.freeze({
	keep: ChangeSet.empty(Stored).insert(Kept, []),
	rekeep: ChangeSet.empty(Stored).put(Kept, []),
	copy: ChangeSet.empty(Stored).insert(
		Copied,
		query(Stored).rule((r) => {
			const { id, at, doc } = v(Source, "s")
			return r.match(Source, { id, at, doc }).find({ id, at, doc })
		})
	),
	sources,
	kept,
	copied
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const storedInstall = Object.freeze({ label: "stored kinds", programs })

/** Stored installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const storedTemplate = fixtureTemplate(import.meta, Stored, storedInstall)

/** An amount as drawn: a finite decimal text, or a special. */
export type Amount =
	| {
			readonly kind: "finite"
			readonly negative: boolean
			readonly units: bigint
			readonly scale: number
	  }
	| { readonly kind: "special"; readonly text: "NaN" | "Infinity" | "-Infinity" }

/** One drawn row of Source: its document, its instant's microseconds and its amount. */
export interface DrawnRow {
	readonly doc: RawDocument
	readonly at: bigint
	readonly amount: Amount
}

/** A drawn case: Source's rows, each its own id, and which of them a put gives another row's document. */
export interface StoredCase {
	readonly rows: Arr.NonEmptyReadonlyArray<DrawnRow>
	readonly rekeyed: boolean
}

/** The greatest instant an instant holds, int8's top: bigint's own range above zero. */
const instantMax = 9_223_372_036_854_775_807n

/** An instant: zero, about now in microseconds, or bigint's top, each stored as it is. */
const instantGen: Gen<bigint> = weighted<bigint>([
	[1, () => 0n],
	[6, (s) => 1_763_700_000_000_000n + BigInt(s.draw(int(0, 1_000_000_000)))],
	[1, () => instantMax]
])

/**
 * An amount about the bound: a coefficient of up to keptDigits + keptScale + 1 digits at a scale of up to keptScale + 1,
 * so some lie past the bound by a digit or a fraction digit, and the specials.
 */
const amountGen: Gen<Amount> = weighted<Amount>([
	[
		8,
		(s) => {
			const scale = s.draw(int(0, keptScale + 1))
			const digits = s.draw(int(1, keptDigits + scale + 1))
			const nines = s.draw(boolean)
			return {
				kind: "finite",
				negative: s.draw(boolean),
				units: nines
					? 10n ** BigInt(digits) - 1n
					: BigInt(s.draw(int(0, 10 ** Math.min(digits, 9) - 1))),
				scale
			}
		}
	],
	[1, (s) => ({ kind: "special", text: s.draw(element(["NaN", "Infinity", "-Infinity"])) })]
])

const rowGen: Gen<DrawnRow> = (s) => ({
	doc: s.draw(raw),
	at: s.draw(instantGen),
	amount: s.draw(amountGen)
})

export const storedCaseGen: Gen<StoredCase> = (s) => {
	const [first, ...rest] = s.draw(array(rowGen, { min: 1, max: 6 }))
	return {
		rows: first === undefined ? [s.draw(rowGen)] : [first, ...rest],
		rekeyed: s.draw(boolean)
	}
}

/** An amount's text as numeric_in reads it. */
export const amountText = (a: Amount): string => {
	if (a.kind === "special") {
		return a.text
	}
	const digits = Str.padStart(a.scale + 1, "0")(a.units.toString())
	const whole = Str.slice(0, digits.length - a.scale)(digits)
	const fraction = Str.slice(digits.length - a.scale)(digits)
	return `${a.negative && a.units !== 0n ? "-" : ""}${whole}${a.scale > 0 ? `.${fraction}` : ""}`
}

/** Whether an amount lies within Kept's bound: a special, or a finite value of at most keptScale fraction digits below 10^keptDigits. */
export const withinKept = (a: Amount): boolean => {
	if (a.kind === "special") {
		return true
	}
	let units = a.units
	let scale = a.scale
	while (scale > 0 && units % 10n === 0n) {
		units /= 10n
		scale -= 1
	}
	return scale <= keptScale && units < 10n ** BigInt(keptDigits + scale)
}

/** A drawn row's document's text as its case writes it, and the text tsvectorin stores it as, the model's. */
export const documentTexts = (
	row: DrawnRow
): { readonly raw: string; readonly stored: string } => ({
	raw: rawText(row.doc),
	stored: printed(stored(row.doc))
})

export type StoredFeature =
	| "an amount within the bound kept"
	| "an amount past the bound refused"
	| "a special amount kept"
	| "an empty document"
	| "a document out of its one form written"
	| "an instant of bigint's top"
	| "a put of another row's document"
	| "a direct writer's amount past the bound refused"
