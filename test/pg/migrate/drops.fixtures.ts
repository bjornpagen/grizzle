/** What the properties of drops.test.ts read: its spaces, models and helpers. */

import {
	concatNonEmpty,
	extendNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, option, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { printType } from "#compiler/sql/print.ts"
import { type Aim, sameCatalog } from "#test/pg/migrate/support.ts"
import {
	check,
	contained,
	eq,
	f,
	field,
	type FixtureField,
	ge,
	literal,
	value,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** What the second version does to a field its caller writes: keeps it; drops it; widens it from integer to bigint,
 * which holds other values, so the draft sets it aside and fills it at the reviewer's value; constrains it to a
 * contract over integer, which holds the same values, so the draft converts it in place by its cast; or generates it
 * from the key, so the draft drops it and adds it again by its generation. */
type CallerFate = "kept" | "dropped" | "widened" | "constrained" | "generated"

const callerFates = [
	"kept",
	"dropped",
	"widened",
	"constrained",
	"generated"
] as const satisfies ReadonlyArray<CallerFate>

/** What the second version does to a generated field: keeps it, drops it, or generates it from other caller fields
 * (`reads`), by the same function. It drops it whatever its fate when it drops a field the generation it holds reads. */
type GeneratedFate =
	| { readonly kind: "kept" }
	| { readonly kind: "dropped" }
	| { readonly kind: "reexpressed"; readonly reads: NonEmptyReadonlyArray<string> }

/** A field of R in the first version: one its caller writes; or one PostgreSQL generates from the caller fields it
 * reads, the least or the greatest of them; each with its fate. */
type FieldSketch =
	| { readonly kind: "caller"; readonly name: string; readonly fate: CallerFate }
	| {
			readonly kind: "generated"
			readonly name: string
			readonly reads: NonEmptyReadonlyArray<string>
			readonly fn: "least" | "greatest"
			readonly fate: GeneratedFate
	  }

/** A CHECK of R that each field it reads is at least 0, which the second version keeps or drops (`kept`), and drops
 * whatever `kept` says when it drops a field the CHECK reads. */
interface CheckSketch {
	readonly reads: NonEmptyReadonlyArray<string>
	readonly kept: boolean
}

/** A containment of R's caller field `term` in S's key: of every row, which grizzle installs as a foreign key; or of
 * the rows whose `where` field is the containment's place in its list, which grizzle stores as a generated law column
 * over both fields with its foreign key. The second version keeps or drops it (`kept`), and drops it whatever `kept`
 * says unless it keeps `term` as it is, an integer S's key holds, and its caller still writes `where`. */
interface ContainmentSketch {
	readonly term: string
	readonly where: Option.Option<string>
	readonly kept: boolean
}

/** A case: R's fields in their declared order, after its key `id`; its CHECKs and containments; and its rows, a value
 * in 0 … values − 1 of each caller field, by name. */
export interface DropCase {
	readonly fields: NonEmptyReadonlyArray<FieldSketch>
	readonly checks: ReadonlyArray<CheckSketch>
	readonly containments: ReadonlyArray<ContainmentSketch>
	readonly rows: ReadonlyArray<Readonly<Record<string, number>>>
}

/** The values a caller field holds, which are S's keys, so every containment holds of every row. */
const values = 3

const maxCallers = 4

const maxGenerated = 3

const maxChecks = 2

const maxContainments = 2

const maxRows = 4

/** Some of `names`, at least one, each in or out by one bit of a mask in 1 … 2^n − 1. */
const picked =
	(names: NonEmptyReadonlyArray<string>): Gen<NonEmptyReadonlyArray<string>> =>
	(s) => {
		const mask = s.draw(int(1, 2 ** names.length - 1))
		return nonEmpty(
			Arr.filter(names, (_, i) => (mask & (2 ** i)) !== 0),
			"a nonzero mask picks a name"
		)
	}

/** The names `0 … n − 1` under `prefix`. */
const namesOf = (prefix: string, n: number): ReadonlyArray<string> =>
	Array.from({ length: n }, (_, i) => `${prefix}${i}`)

const rowsGen =
	(fields: ReadonlyArray<FieldSketch>): Gen<DropCase["rows"]> =>
	(s) =>
		s.draw(
			array(
				(r) =>
					Rec.fromEntries(
						Arr.flatMap(fields, (x) =>
							x.kind === "caller" ? [[x.name, r.draw(int(0, values - 1))] as const] : []
						)
					),
				{ min: 0, max: maxRows }
			)
		)

const generatedFateGen =
	(callers: NonEmptyReadonlyArray<string>): Gen<GeneratedFate> =>
	(s) => {
		switch (s.draw(element(["kept", "dropped", "reexpressed"] as const))) {
			case "kept":
				return { kind: "kept" }
			case "dropped":
				return { kind: "dropped" }
			case "reexpressed":
				return { kind: "reexpressed", reads: s.draw(picked(callers)) }
		}
	}

/** The parts a drawn case holds besides its rows, which `withRows` draws once every field is placed. */
type Parts = Omit<DropCase, "rows">

const partsGen: Gen<Parts> = (s) => {
	const callers = nonEmpty(namesOf("c", s.draw(int(1, maxCallers))), "a case's callers")
	const declared: NonEmptyReadonlyArray<FieldSketch> = [
		...mapNonEmpty(callers, (name): FieldSketch => ({
			kind: "caller",
			name,
			fate: s.draw(element(callerFates))
		})),
		...Arr.map(namesOf("g", s.draw(int(0, maxGenerated))), (name): FieldSketch => ({
			kind: "generated",
			name,
			reads: s.draw(picked(callers)),
			fn: s.draw(element(["least", "greatest"] as const)),
			fate: s.draw(generatedFateGen(callers))
		}))
	]
	const fields = nonEmpty(
		s.draw(shuffled(declared, { min: declared.length, max: declared.length })),
		"a permutation of a case's fields"
	)
	const all = mapNonEmpty(fields, (x) => x.name)
	return {
		fields,
		checks: s.draw(
			array((c) => ({ reads: c.draw(picked(all)), kept: c.draw(boolean) }), {
				min: 0,
				max: maxChecks
			})
		),
		containments: Array.from({ length: s.draw(int(0, maxContainments)) }, (_, j) => ({
			term: s.draw(element(callers)),
			where: j === 0 ? s.draw(option(element(callers))) : Option.some(s.draw(element(callers))),
			kept: s.draw(boolean)
		}))
	}
}

const withRows =
	(parts: Gen<Parts>): Gen<DropCase> =>
	(s) => {
		const p = s.draw(parts)
		return { ...p, rows: s.draw(rowsGen(p.fields)) }
	}

export const caseGen: Gen<DropCase> = withRows(partsGen)

/** A field's type in a version: integer, as the first version types every field; a caller field's bigint once
 * widened, or contract once constrained; a generated field's bigint when it reads a widened field. */
type Width = "integer" | "bigint" | "contract"

/** How a version writes a field it holds: its caller, or PostgreSQL by a generation over the fields `reads`. */
type Writing =
	| { readonly kind: "caller" }
	| {
			readonly kind: "generated"
			readonly fn: "least" | "greatest"
			readonly reads: NonEmptyReadonlyArray<string>
	  }

/** A field a version holds, by name, with its type and its writing. */
interface Held {
	readonly name: string
	readonly width: Width
	readonly writing: Writing
}

const byCaller: Writing = { kind: "caller" }

/** R's key, an integer its caller writes, which every version holds. */
const key: Held = { name: "id", width: "integer", writing: byCaller }

/** A CHECK or containment a version holds, with its place in the case's list, which names it. */
interface Placed<A> {
	readonly at: number
	readonly part: A
}

/** A version of the case: the fields it holds, in declared order, and the CHECKs and containments it holds. */
interface Version {
	readonly fields: ReadonlyArray<Held>
	readonly checks: ReadonlyArray<Placed<CheckSketch>>
	readonly containments: ReadonlyArray<Placed<ContainmentSketch>>
}

const placed = <A>(parts: ReadonlyArray<A>): ReadonlyArray<Placed<A>> =>
	Arr.map(parts, (part, at) => ({ at, part }))

/** The first version: every field, an integer, and every CHECK and containment. */
const firstOf = (c: DropCase): Version => ({
	fields: [
		key,
		...Arr.map(c.fields, (x): Held => ({
			name: x.name,
			width: "integer",
			writing: x.kind === "generated" ? { kind: "generated", fn: x.fn, reads: x.reads } : byCaller
		}))
	],
	checks: placed(c.checks),
	containments: placed(c.containments)
})

const callerFate = (c: DropCase, name: string): Option.Option<CallerFate> =>
	Arr.findFirst(c.fields, (x) => x.name === name).pipe(
		Option.flatMap((x) => (x.kind === "caller" ? Option.some(x.fate) : Option.none()))
	)

const isFate =
	(c: DropCase, fate: CallerFate) =>
	(name: string): boolean =>
		Option.contains(callerFate(c, name), fate)

/** The second version, read off the fates: each caller field it does not drop, typed by its fate, one it generates
 * from the key; each generated field it keeps or re-expresses whose generation reads only fields its caller still
 * writes, bigint when one of them is widened; each CHECK it keeps whose fields it holds; and each containment it keeps
 * whose fields its caller still writes, its term still an integer. */
const secondOf = (c: DropCase): Version => {
	const written = (name: string): boolean =>
		Option.exists(callerFate(c, name), (fate) => fate !== "dropped" && fate !== "generated")
	const callerHeld = (name: string, fate: CallerFate): ReadonlyArray<Held> => {
		switch (fate) {
			case "dropped":
				return []
			case "kept":
				return [{ name, width: "integer", writing: byCaller }]
			case "widened":
				return [{ name, width: "bigint", writing: byCaller }]
			case "constrained":
				return [{ name, width: "contract", writing: byCaller }]
			case "generated":
				return [
					{ name, width: "integer", writing: { kind: "generated", fn: "least", reads: ["id"] } }
				]
		}
	}
	const generatedHeld = (
		x: Extract<FieldSketch, { readonly kind: "generated" }>,
		reads: NonEmptyReadonlyArray<string>
	): ReadonlyArray<Held> =>
		Arr.every(reads, written)
			? [
					{
						name: x.name,
						width: Arr.some(reads, isFate(c, "widened")) ? "bigint" : "integer",
						writing: { kind: "generated", fn: x.fn, reads }
					}
				]
			: []
	const fields = Arr.flatMap(c.fields, (x): ReadonlyArray<Held> => {
		switch (x.kind) {
			case "caller":
				return callerHeld(x.name, x.fate)
			case "generated":
				switch (x.fate.kind) {
					case "kept":
						return generatedHeld(x, x.reads)
					case "dropped":
						return []
					case "reexpressed":
						return generatedHeld(x, x.fate.reads)
				}
		}
	})
	const holds = (name: string): boolean => Arr.some(fields, (h) => h.name === name)
	return {
		fields: [key, ...fields],
		checks: Arr.filter(placed(c.checks), ({ part }) => part.kept && Arr.every(part.reads, holds)),
		containments: Arr.filter(
			placed(c.containments),
			({ part }) =>
				part.kept &&
				isFate(c, "kept")(part.term) &&
				Option.match(part.where, { onNone: () => true, onSome: written })
		)
	}
}

/** The contract a constrained field takes: an integer at least 0, as every value is. */
const counted = f.contract("Counted", f.integer, ge(value, literal(0)))

const typeOf = (width: Width): FieldDesc => {
	switch (width) {
		case "integer":
			return f.integer
		case "bigint":
			return f.bigint
		case "contract":
			return counted
	}
}

/** `n` as a literal of a field of `width`. */
const valueOf = (width: Width, n: number): ExprDesc => literal(width === "bigint" ? BigInt(n) : n)

/** A generated field's expression of type `width` over the fields it reads, each cast to `width` where its own type
 * is another: the one, or the least or greatest of them. */
const generation = (
	fn: "least" | "greatest",
	width: Width,
	reads: ReadonlyArray<{ readonly name: string; readonly width: Width }>
): ExprDesc => {
	const args = Arr.map(reads, (r): ExprDesc =>
		r.width === width ? field(r.name) : { kind: "cast", to: typeOf(width), arg: field(r.name) }
	)
	const [one, ...more] = args
	return one === undefined || more.length > 0 ? { kind: "compute", fn, args } : one
}

/** A version's schema under `name`: R with the fields it holds, typed as it holds them, S, and its CHECKs and
 * containments, each named or selected by its place in the case's list, so a kept one is the first version's. */
const schemaOf = (name: string, v: Version): SchemaDesc => {
	const widthOf = (n: string): Width =>
		Option.getOrThrowWith(
			Option.map(
				Arr.findFirst(v.fields, (h) => h.name === n),
				(h) => h.width
			),
			() => new Error(`a version reads only the fields it holds, not ${n}`)
		)
	const declared = ({ width, writing }: Held): FixtureField => {
		switch (writing.kind) {
			case "caller":
				return typeOf(width)
			case "generated":
				return f.generated(
					typeOf(width),
					generation(
						writing.fn,
						width,
						Arr.map(writing.reads, (r) => ({ name: r, width: widthOf(r) }))
					)
				)
		}
	}
	return {
		name,
		relations: [
			relation("R", Rec.fromEntries(Arr.map(v.fields, (h) => [h.name, declared(h)] as const)), [
				"id"
			]),
			relation("S", { id: f.integer }, ["id"])
		],
		statements: [
			...Arr.map(v.checks, ({ at, part }) => {
				const predicate: ExprDesc = {
					kind: "and",
					args: mapNonEmpty(part.reads, (n) => ge(field(n), valueOf(widthOf(n), 0)))
				}
				return check(`CNonNegative${at}`, "R", predicate)
			}),
			...Arr.map(v.containments, ({ at, part }) =>
				contained(
					Option.match(part.where, {
						onNone: () => on("R", [part.term]),
						onSome: (w) => onWhere("R", [part.term], eq(field(w), valueOf(widthOf(w), at)))
					}),
					on("S", ["id"])
				)
			)
		],
		bases: []
	}
}

/** The drops the second version declares: every field of R it no longer holds. */
const declaredOf =
	(c: DropCase) =>
	(version: number): Declarations => {
		const kept = Arr.map(secondOf(c).fields, (h) => h.name)
		return version === 1
			? {
					renames: [],
					drops: Arr.flatMap(c.fields, (x) =>
						Arr.contains(kept, x.name)
							? []
							: [{ kind: "field", relation: parsedName("R"), field: parsedName(x.name) } as const]
					)
				}
			: noDeclarations
	}

/** The reviewer's value of each placeholder: 0 for an added column, a conversion by its cast. */
const reviewed = (p: Placeholder): string => {
	switch (p.kind) {
		case "addColumnPlaceholder":
			return "0"
		case "placeholderRetype":
			return `${quoteIdent(p.column.name)}::${printType(p.column.type)}`
	}
}

const tableOf = (schema: string, name: string): string =>
	`${quoteIdent(schema)}.${quoteIdent(identifierOf(identity.table(parsedName(name))))}`

const columnOf = (name: string): string =>
	quoteIdent(identifierOf(identity.column(parsedName(name))))

/** The first version's rows: S's keys 0 … values − 1, and R's rows, keyed 1 … n. */
const rowsSql = (schema: string, c: DropCase): ReadonlyArray<string> => {
	const callers = Arr.flatMap(c.fields, (x) => (x.kind === "caller" ? [x.name] : []))
	return [
		...Array.from(
			{ length: values },
			(_, k) => `INSERT INTO ${tableOf(schema, "S")} (${columnOf("id")}) VALUES (${k})`
		),
		...Arr.map(
			c.rows,
			(r, i) =>
				`INSERT INTO ${tableOf(schema, "R")} (${Arr.join(Arr.map(["id", ...callers], columnOf), ", ")}) VALUES (${Arr.join(
					[String(i + 1), ...Arr.map(callers, (n) => String(r[n] ?? 0))],
					", "
				)})`
		)
	]
}

export type Feature =
	| "a dropped generated field declared after a dropped field it reads"
	| "a dropped generated field declared before a dropped field it reads"
	| "a dropped generated field over a field set aside"
	| "a dropped generated field over a field converted in place"
	| "a kept generated field declared before a field set aside it reads"
	| "a kept generated field over a field converted in place"
	| "a dropped generated field over a field turned generated"
	| "a generated field re-expressed off a field set aside"
	| "a generated field re-expressed off a field converted in place"
	| "a generated field re-expressed off a field turned generated"
	| "a generated field re-expressed beside a field converted in place"
	| "a dropped CHECK over a dropped field"
	| "a dropped law column over a dropped field"
	| "a dropped foreign key over a dropped field"

export const features: NonEmptyReadonlyArray<Feature> = [
	"a dropped generated field declared after a dropped field it reads",
	"a dropped generated field declared before a dropped field it reads",
	"a dropped generated field over a field set aside",
	"a dropped generated field over a field converted in place",
	"a kept generated field declared before a field set aside it reads",
	"a kept generated field over a field converted in place",
	"a dropped generated field over a field turned generated",
	"a generated field re-expressed off a field set aside",
	"a generated field re-expressed off a field converted in place",
	"a generated field re-expressed off a field turned generated",
	"a generated field re-expressed beside a field converted in place",
	"a dropped CHECK over a dropped field",
	"a dropped law column over a dropped field",
	"a dropped foreign key over a dropped field"
]

/** The features a case reaches. */
const reached = (c: DropCase): ReadonlyArray<Feature> => {
	const second = secondOf(c)
	/** Whether the first version declares the field `a` before the field `b`. */
	const before = (a: string, b: string): boolean => {
		const at = (n: string) => Arr.findFirstIndex(c.fields, (x) => x.name === n)
		return Option.exists(Option.all([at(a), at(b)]), ([i, j]) => i < j)
	}
	const held = (n: string): Option.Option<Held> => Arr.findFirst(second.fields, (h) => h.name === n)
	const dropped = (n: string): boolean => Option.isNone(held(n))
	const generated = Arr.flatMap(c.fields, (x) => (x.kind === "generated" ? [x] : []))
	const droppedReads = Arr.flatMap(generated, (g) =>
		dropped(g.name) ? Arr.map(Arr.filter(g.reads, dropped), (r) => ({ g, r })) : []
	)
	const widened = isFate(c, "widened")
	const constrained = isFate(c, "constrained")
	const turned = isFate(c, "generated")
	/** The generated fields the second version holds, each with the fields its generation reads there. */
	const kept = Arr.flatMap(generated, (g) =>
		Option.toArray(
			Option.flatMap(held(g.name), (h) =>
				h.writing.kind === "generated" ? Option.some({ g, now: h.writing.reads }) : Option.none()
			)
		)
	)
	const off = (from: (n: string) => boolean) =>
		Arr.some(kept, ({ g, now }) => Arr.some(g.reads, (r) => from(r) && !Arr.contains(now, r)))
	const droppedContainments = Arr.filter(
		placed(c.containments),
		(k) => !Arr.some(second.containments, (x) => x.at === k.at)
	)
	const named = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	return [
		...named(
			Arr.some(droppedReads, ({ g, r }) => before(r, g.name)),
			"a dropped generated field declared after a dropped field it reads"
		),
		...named(
			Arr.some(droppedReads, ({ g, r }) => before(g.name, r)),
			"a dropped generated field declared before a dropped field it reads"
		),
		...named(
			Arr.some(generated, (g) => dropped(g.name) && Arr.some(g.reads, widened)),
			"a dropped generated field over a field set aside"
		),
		...named(
			Arr.some(generated, (g) => dropped(g.name) && Arr.some(g.reads, constrained)),
			"a dropped generated field over a field converted in place"
		),
		...named(
			Arr.some(kept, ({ g, now }) => Arr.some(now, (r) => widened(r) && before(g.name, r))),
			"a kept generated field declared before a field set aside it reads"
		),
		...named(
			Arr.some(kept, ({ now }) => Arr.some(now, constrained)),
			"a kept generated field over a field converted in place"
		),
		...named(
			Arr.some(generated, (g) => dropped(g.name) && Arr.some(g.reads, turned)),
			"a dropped generated field over a field turned generated"
		),
		...named(off(widened), "a generated field re-expressed off a field set aside"),
		...named(off(constrained), "a generated field re-expressed off a field converted in place"),
		...named(off(turned), "a generated field re-expressed off a field turned generated"),
		...named(
			Arr.some(
				kept,
				({ g, now }) =>
					Arr.join(now, " ") !== Arr.join(g.reads, " ") &&
					Arr.every([...g.reads, ...now], isFate(c, "kept"))
			) && Arr.some(c.fields, (x) => constrained(x.name)),
			"a generated field re-expressed beside a field converted in place"
		),
		...named(
			Arr.some(c.checks, (k) => Arr.some(k.reads, dropped)),
			"a dropped CHECK over a dropped field"
		),
		...named(
			Arr.some(
				droppedContainments,
				({ part }) =>
					Option.isSome(part.where) && Arr.some([part.term, ...Option.toArray(part.where)], dropped)
			),
			"a dropped law column over a dropped field"
		),
		...named(
			Arr.some(droppedContainments, ({ part }) => Option.isNone(part.where) && dropped(part.term)),
			"a dropped foreign key over a dropped field"
		)
	]
}

/** What an aim adds to a drawn case: fields declared before and after the drawn ones, and CHECKs and containments
 * after the drawn ones, over the fields `xa`, `xb` and `xg` no drawn case names. */
interface Added {
	readonly first: ReadonlyArray<FieldSketch>
	readonly last: ReadonlyArray<FieldSketch>
	readonly checks: ReadonlyArray<CheckSketch>
	readonly containments: ReadonlyArray<ContainmentSketch>
}

/** A drawn case with `added` to it. */
const adding = (added: Partial<Added>): Gen<DropCase> =>
	withRows((s) => {
		const p = s.draw(partsGen)
		return {
			fields: concatNonEmpty(added.first ?? [], extendNonEmpty(p.fields, added.last ?? [])),
			checks: [...p.checks, ...(added.checks ?? [])],
			containments: [...p.containments, ...(added.containments ?? [])]
		}
	})

const xa = (fate: CallerFate): FieldSketch => ({ kind: "caller", name: "xa", fate })

const xb: FieldSketch = { kind: "caller", name: "xb", fate: "kept" }

const xc: FieldSketch = { kind: "caller", name: "xc", fate: "kept" }

/** The generated field `xg` over `xa`, of fate `fate`. */
const xg = (fate: GeneratedFate): FieldSketch => ({
	kind: "generated",
	name: "xg",
	reads: ["xa"],
	fn: "least",
	fate
})

/** `xg` over `xb`, re-expressed onto `xc`: no field it reads before or after is `xa`. */
const xgBeside: FieldSketch = {
	kind: "generated",
	name: "xg",
	reads: ["xb"],
	fn: "least",
	fate: { kind: "reexpressed", reads: ["xc"] }
}

const keptGeneration: GeneratedFate = { kind: "kept" }

const droppedGeneration: GeneratedFate = { kind: "dropped" }

/** `xg` re-expressed off `xa` onto `xb`. */
const ontoXb: GeneratedFate = { kind: "reexpressed", reads: ["xb"] }

/** The cases each required situation is aimed at while it is pending: the generator draws the one a case's turn aims
 * at (aimed) in place of its plain draw. */
export const aims: ReadonlyArray<Aim<DropCase, Feature>> = [
	[
		"a dropped generated field declared after a dropped field it reads",
		adding({ last: [xa("dropped"), xg(keptGeneration)] })
	],
	[
		"a dropped generated field declared before a dropped field it reads",
		adding({ first: [xg(keptGeneration)], last: [xa("dropped")] })
	],
	[
		"a dropped generated field over a field set aside",
		adding({ last: [xa("widened"), xg(droppedGeneration)] })
	],
	[
		"a dropped generated field over a field converted in place",
		adding({ last: [xa("constrained"), xg(droppedGeneration)] })
	],
	[
		"a kept generated field declared before a field set aside it reads",
		adding({ first: [xg(keptGeneration)], last: [xa("widened")] })
	],
	[
		"a kept generated field over a field converted in place",
		adding({ last: [xa("constrained"), xg(keptGeneration)] })
	],
	[
		"a dropped generated field over a field turned generated",
		adding({ last: [xa("generated"), xg(droppedGeneration)] })
	],
	[
		"a generated field re-expressed off a field set aside",
		adding({ last: [xa("widened"), xb, xg(ontoXb)] })
	],
	[
		"a generated field re-expressed off a field converted in place",
		adding({ last: [xa("constrained"), xb, xg(ontoXb)] })
	],
	[
		"a generated field re-expressed off a field turned generated",
		adding({ last: [xa("generated"), xb, xg(ontoXb)] })
	],
	[
		"a generated field re-expressed beside a field converted in place",
		adding({ last: [xa("constrained"), xb, xc, xgBeside] })
	],
	[
		"a dropped CHECK over a dropped field",
		adding({ last: [xa("dropped")], checks: [{ reads: ["xa"], kept: true }] })
	],
	[
		"a dropped law column over a dropped field",
		adding({
			last: [xa("dropped"), xb],
			containments: [{ term: "xa", where: Option.some("xb"), kept: true }]
		})
	],
	[
		"a dropped foreign key over a dropped field",
		adding({
			last: [xa("dropped")],
			containments: [{ term: "xa", where: Option.none(), kept: true }]
		})
	]
]

/** A case migrated: the first version installed and its rows stored, the second migrated over them by the real runner,
 * and its catalog compared with a fresh installation's of the second version. */
export const dropCase = (c: DropCase, note: (feature: Feature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			for (const feature of reached(c)) {
				note(feature)
			}
			const state = { schema: "" }
			const observe = (version: number, owner: RawSession) =>
				Effect.gen(function* () {
					if (version !== 0) {
						return
					}
					const loaded = yield* Effect.orDie(attempt(owner, rowsSql(state.schema, c)))
					if (loaded.kind !== "committed") {
						return yield* Effect.die(
							new Error(
								`the first version refused its rows: ${refusalText(loaded.fields)}: ${Formatter.format(c)}`
							)
						)
					}
				})
			const m = yield* migrated({
				label: "drops",
				schemaName: { kind: "unique" },
				first: (name) => {
					state.schema = identifierOf(identity.schema(parsedSchemaName(name)))
					return { described: schemaOf(name, firstOf(c)) }
				},
				later: [(name) => ({ described: schemaOf(name, secondOf(c)) })],
				apply: { kind: "values", value: reviewed },
				declared: declaredOf(c),
				observe: Option.some(observe)
			})
			const fresh = yield* migrated({
				label: "drops_fresh",
				schemaName: { kind: "unique" },
				first: (name) => ({ described: schemaOf(name, secondOf(c)) }),
				later: [],
				apply: { kind: "noPlaceholders" },
				declared: () => noDeclarations,
				observe: Option.none()
			})
			yield* sameCatalog(
				m.installation,
				fresh.installation,
				"the migrated second version against a fresh one"
			)
		})
	)
