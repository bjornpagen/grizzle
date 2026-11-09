/**
 * Key text bounded by bytes, against PostgreSQL 19: a text whose contract bounds its octet_length at
 * keyTextBytes(companions) sits in a key beside those companions in any order, its widest value inserting with no
 * "index row size exceeds btree maximum" (54000), and a value one byte longer is refused by the contract's domain CHECK
 * (23514), before any index sees it.
 *
 * Each case draws the key's other fields, uuid, natural, integer, smallint, boolean and a closed id, the order of the
 * key, the text among them, and the text's code points: ASCII, two-byte, CJK and astral, drawn apart enough that no
 * compression shortens them, the last code point of each value of a drawn width, so the bound is met at a multibyte
 * boundary. Where every other field of the key comes before the text and lays out with the widest padding the budget
 * counts (each of alignment one, the text aligned past an odd offset), the budget is exactly the most the entry holds,
 * so a budget one byte too large fails the insert there.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, natural, pg, uuid } from "#compiler/public/fields.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { admittedClosedId, closed, relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A key's other field. */
type Companion = "uuid" | "natural" | "integer" | "smallint" | "boolean" | "closedId"

/** A code point's UTF-8 width, by its class: ASCII, two-byte, CJK and astral. */
type Width = 1 | 2 | 3 | 4

interface KeyCase {
	readonly companions: Arr.NonEmptyReadonlyArray<Companion>
	/** The key's order: each companion's position and the text's, `companions.length`, ranked. */
	readonly order: ReadonlyArray<number>
	/** The widths the text's code points are drawn from, and the width of each value's last code point. */
	readonly widths: Arr.NonEmptyReadonlyArray<Width>
	readonly last: Width
	readonly salt: number
}

const Kind = closed("Kind", ["A", "B"], [])

const descriptorOf = (c: Companion): FieldBase => {
	switch (c) {
		case "uuid":
			return uuid
		case "natural":
			return natural
		case "integer":
			return pg.integer
		case "smallint":
			return pg.smallint
		case "boolean":
			return pg.boolean
		case "closedId":
			return admittedClosedId(Kind)
	}
}

/** Each companion's widest value as SQL writes it: a closed id is its code, the largest Kind numbers. */
const widestOf = (c: Companion): string => {
	switch (c) {
		case "uuid":
			return "'ffffffff-ffff-ffff-ffff-ffffffffffff'"
		case "natural":
			return "9223372036854775807"
		case "integer":
			return "2147483647"
		case "smallint":
			return "32767"
		case "boolean":
			return "true"
		case "closedId":
			return "1"
	}
}

/** The first code point of each width's range and how many follow it, every one of them that width in UTF-8. */
const ranges: Readonly<Record<Width, readonly [number, number]>> = {
	1: [0x21, 0x5e],
	2: [0xa1, 0x75f],
	3: [0x4e00, 0x5200],
	4: [0x20000, 0xa000]
}

/**
 * A text of exactly `bytes` UTF-8 bytes: code points of `widths`, each fitting what is left, chosen by a generator
 * seeded with `salt` far enough apart that pglz finds no saving, then a last code point of width `last` where it fits.
 */
const textOf = (bytes: number, widths: ReadonlyArray<Width>, last: Width, salt: number): string => {
	let x = (salt * 2654435761) >>> 0
	const next = (): number => {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0
		return x >>> 7
	}
	const tail: Width = last <= bytes ? last : 1
	let out = ""
	for (let left = bytes - (bytes === 0 ? 0 : tail); left > 0;) {
		const fits = Arr.filter(widths, (w) => w <= left)
		const w: Width =
			fits.length === 0 ? 1 : defined(fits[next() % fits.length], "a width that fits")
		const [first, count] = ranges[w]
		out += String.fromCodePoint(first + (next() % count))
		left -= w
	}
	if (bytes > 0) {
		const [first, count] = ranges[tail]
		out += String.fromCodePoint(first + (next() % count))
	}
	return out
}

const utf8 = new TextEncoder()

/** The UTF-8 width of a text's last code point; none for the empty text. */
const lastWidth = (text: string): Width | undefined => {
	const last = Arr.last(Arr.fromIterable(text))
	if (Option.isNone(last)) {
		return undefined
	}
	switch (utf8.encode(last.value).length) {
		case 1:
			return 1
		case 2:
			return 2
		case 3:
			return 3
		default:
			return 4
	}
}

const companionGen: Gen<Companion> = weighted<Companion>([
	[3, element<Companion>(["uuid", "boolean"])],
	[2, element<Companion>(["natural", "integer", "smallint", "closedId"])]
])

const widthGen: Gen<Width> = element<Width>([1, 2, 3, 4])

const caseGen: Gen<KeyCase> = (source) => {
	const companions = source.draw(array(companionGen, { min: 1, max: 5 }))
	const first = defined(companions[0], "a companion")
	const all: Arr.NonEmptyReadonlyArray<Companion> = [first, ...Arr.drop(companions, 1)]
	const textLast = source.draw(boolean)
	const ranked = Arr.map(indices(all.length + 1), (position) => ({
		position,
		rank: textLast && position === all.length ? 0x10000 : source.draw(int(0, 0xffff))
	}))
	return {
		companions: all,
		order: Arr.map(
			Arr.sort(
				ranked,
				Order.mapInput(Order.Number, (p: { readonly rank: number }) => p.rank)
			),
			(p) => p.position
		),
		widths: [source.draw(widthGen), ...source.draw(array(widthGen, { min: 0, max: 3 }))],
		last: source.draw(widthGen),
		salt: source.draw(int(0, 0xffff))
	}
}

/** Where the text stands in the key: its place among the key's fields, `companions.length` its own position. */
const textPosition = (c: KeyCase): number =>
	defined(
		Option.getOrUndefined(Arr.findFirstIndex(c.order, (p) => p === c.companions.length)),
		"the text's place in the key"
	)

/**
 * Whether the budget is exactly the most the entry holds in this order: the text last, after companions that each
 * align to one byte and so pad nothing, ending at an offset one past a multiple of four, so the text's own padding is
 * the widest, three bytes.
 */
const tight = (c: KeyCase): boolean => {
	const textAt = textPosition(c)
	const before = Arr.map(Arr.take(c.order, textAt), (p) => defined(c.companions[p], "a companion"))
	const end = Arr.reduce(
		before,
		8,
		(o, comp) => o + (comp === "uuid" ? 16 : comp === "boolean" ? 1 : 0)
	)
	return (
		textAt === c.companions.length &&
		Arr.every(before, (comp) => comp === "uuid" || comp === "boolean") &&
		end % 4 === 1
	)
}

type BytesFeature =
	| "tight budget"
	| "text first"
	| "text last"
	| "text between"
	| "a closed id beside it"
	| `last code point of ${Width} bytes`

const runs = 40

layer(Substrate.layer)(
	"key text bounded by bytes, against PostgreSQL's B-tree item limit",
	(it) => {
		it.effect(
			"inserts a text of exactly keyTextBytes bytes in a key beside its companions, and refuses one byte more by its domain",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "oracle/key-text-bytes",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<BytesFeature>(
								[
									"text first",
									"text last",
									"text between",
									"a closed id beside it",
									"last code point of 1 bytes",
									"last code point of 2 bytes",
									"last code point of 3 bytes",
									"last code point of 4 bytes"
								],
								{ cases: runs, sense: notesOnly }
							),
							kept: [],
							runs,
							shrink: { kind: "bounded", candidates: 20 },
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const budget = keyTextBytes(Arr.map(c.companions, descriptorOf))
								const KeyText = contract("KeyText", str.regex("^.*$", "su"), (v) =>
									Compute.octetLength(v).le(budget)
								)
								const names = [...Arr.map(indices(c.companions.length), (i) => `c${i}`), "t"]
								const fields = Rec.fromEntries([
									...Arr.map(c.companions, (comp, i): readonly [string, FieldBase] => [
										`c${i}`,
										descriptorOf(comp)
									]),
									["t", KeyText] as const
								])
								const key = Arr.map(c.order, (p) => defined(names[p], "a key field"))
								const Keyed = relation("Keyed", fields, key, [])
								const installed = yield* install(schema("TextBytes", { Kind, Keyed }, [], []), {
									ambient: ordinarySession,
									label: "textbytes",
									logins: [],
									extensions: []
								})
								const textAt = textPosition(c)
								k.note(
									textAt === 0
										? "text first"
										: textAt === c.companions.length
											? "text last"
											: "text between"
								)
								if (tight(c)) {
									k.note("tight budget")
								}
								if (Arr.contains(c.companions, "closedId")) {
									k.note("a closed id beside it")
								}
								const substrate = yield* Substrate
								const session = yield* substrate.session({
									...ownerSession(),
									label: "text bytes writer"
								})
								const relationName = installed.names.relation("Keyed")
								const table = `${quoteIdent(relationName.schema)}.${quoteIdent(relationName.name)}`
								const columns = Arr.join(
									Arr.map(names, (n) => quoteIdent(installed.names.column("Keyed", n))),
									", "
								)
								const values = (text: string): string =>
									Arr.join(
										[...Arr.map(c.companions, widestOf), `'${Str.replaceAll("'", "''")(text)}'`],
										", "
									)
								const atBudget = textOf(budget, c.widths, c.last, c.salt)
								assert.equal(
									utf8.encode(atBudget).length,
									budget,
									"a text of exactly the budget's bytes"
								)
								const boundary = lastWidth(atBudget)
								if (boundary !== undefined) {
									k.note(`last code point of ${boundary} bytes`)
								}
								const stored = yield* Effect.result(
									session.query(
										`INSERT INTO ${table} (${columns}) VALUES (${values(atBudget)})`,
										[]
									)
								)
								assert.equal(
									stored._tag,
									"Success",
									`a text of ${budget} bytes beside ${Formatter.format(c.companions)} in key order ${Formatter.format(key)} is stored: ${stored._tag === "Failure" ? Formatter.format(pgErrorFields(stored.failure)) : ""}`
								)
								const past = textOf(budget + 1, c.widths, c.last, c.salt + 1)
								assert.equal(
									utf8.encode(past).length,
									budget + 1,
									"a text one byte past the budget"
								)
								const refused = yield* Effect.result(
									session.query(`INSERT INTO ${table} (${columns}) VALUES (${values(past)})`, [])
								)
								const error =
									refused._tag === "Failure" ? pgErrorFields(refused.failure) : undefined
								const domain = namesOf(installed).contract("KeyText")
								assert.equal(
									error?.code,
									"23514",
									"one byte past the budget is the domain's to refuse"
								)
								assert.equal(
									error?.constraint,
									domain.kind === "checked" ? domain.constraint : undefined,
									"the contract's domain CHECK refuses it"
								)
							})
					)
				)
		)
	}
)
