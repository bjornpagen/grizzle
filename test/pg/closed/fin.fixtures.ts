/** What the properties of fin.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { type Codebook, codeOf } from "#compiler/ir/codes.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { generatedLaw } from "#compiler/plan/change.ts"
import { bits, closedId, generated, natural, slot } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, fin, on, relation, schema } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import {
	codebookOfStates,
	codecFor,
	type ModelSlot,
	type RosterState
} from "#test/support/closed/generate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { PgErrorFields, SqlError } from "#test/support/pg.ts"

/** A roster's model state from its slots, live handles and holes in code order. */
const stateOf = (name: string, slots: NonEmptyReadonlyArray<ModelSlot>): RosterState => ({
	closed: parsedName(name),
	slots,
	spellings: { plain: 1 }
})

const live = (handle: string): ModelSlot => ({ kind: "live", handle })

/** `count` live handles `<prefix>0` to `<prefix><count - 1>`, codes 0 to count - 1. */
const liveRun = (prefix: string, count: number): NonEmptyReadonlyArray<ModelSlot> =>
	nonEmpty(Array.from({ length: count }, (_, i) => live(`${prefix}${i}`)))

const versionState = stateOf("Version", [live("v0"), live("v1")])

const kindState = stateOf("Kind", [live("k0"), { kind: "hole", was: "k1" }, live("k2")])

const positionState = stateOf("Position", liveRun("p", 3))

const labelState = stateOf("Label", liveRun("x", 2))

export const payloadState = stateOf("Payload", liveRun("w", 16))

const idState = stateOf("Id", liveRun("i", 36))

const states = Object.freeze([
	versionState,
	kindState,
	positionState,
	labelState,
	payloadState,
	idState
])

export const codes: Codebook = codebookOfStates(states)

const Version = closed.ordered("Version", ["v0", "v1"])

const Kind = closed.ordered("Kind", ["k0", "k2"])

const Position = closed.ordered("Position", ["p0", "p1", "p2"])

const Label = closed.ordered("Label", ["x0", "x1"])

const Payload = closed.ordered("Payload", [
	"w0",
	"w1",
	"w2",
	"w3",
	"w4",
	"w5",
	"w6",
	"w7",
	"w8",
	"w9",
	"w10",
	"w11",
	"w12",
	"w13",
	"w14",
	"w15"
])

const Id = closed.ordered("Id", [
	"i0",
	"i1",
	"i2",
	"i3",
	"i4",
	"i5",
	"i6",
	"i7",
	"i8",
	"i9",
	"i10",
	"i11",
	"i12",
	"i13",
	"i14",
	"i15",
	"i16",
	"i17",
	"i18",
	"i19",
	"i20",
	"i21",
	"i22",
	"i23",
	"i24",
	"i25",
	"i26",
	"i27",
	"i28",
	"i29",
	"i30",
	"i31",
	"i32",
	"i33",
	"i34",
	"i35"
])

/** The live owners, each a version and a kind with their codes, in owner index order. */
export const owners = [
	{ version: "v0", kind: "k0", codes: [0, 0] },
	{ version: "v0", kind: "k2", codes: [0, 2] },
	{ version: "v1", kind: "k0", codes: [1, 0] },
	{ version: "v1", kind: "k2", codes: [1, 2] }
] as const

type Held = "none" | 1 | 2

type Shape = "follow" | "last" | "symbol"

export interface FinCase {
	readonly held: ReadonlyArray<Held>
	readonly shape: Shape
}

/** A key: its owner's position among the live owners, and its block's codes in key order. */
export interface Key {
	readonly owner: number
	readonly block: ReadonlyArray<number>
}

/** The block fields of a shape, in key order, with the live codes each takes. */
export const blockOf = (
	shape: Shape
): ReadonlyArray<{ readonly field: string; readonly codes: number }> =>
	shape === "follow"
		? [
				{ field: "from", codes: 3 },
				{ field: "to", codes: 3 }
			]
		: shape === "last"
			? [{ field: "at", codes: 3 }]
			: [
					{ field: "label", codes: 2 },
					{ field: "position", codes: 3 }
				]

/** The count an owner's row gives its slots: 0 where it has no row. */
const countOf = (held: Held): number => (held === "none" ? 0 : held)

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant. */
const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
	const origin: ReadonlyArray<ReadonlyArray<number>> = [[]]
	return Arr.reduce(sizes, origin, (prefixes, size) =>
		Arr.flatMap(prefixes, (prefix) =>
			Array.from({ length: size }, (_, digit) => [...prefix, digit])
		)
	)
}

/** Whether a key is a point of the case's dependent space: each slot code below its owner's count. */
const inSpace = (c: FinCase, key: Key): boolean => {
	const count = countOf(defined(c.held[key.owner]))
	return Arr.every(blockOf(c.shape), (b, i) => b.field === "label" || defined(key.block[i]) < count)
}

/** The codes a key holds, its owner's then its block's. */
export const keyCodes = (key: Key): ReadonlyArray<number> => [
	...defined(owners[key.owner]).codes,
	...key.block
]

/** Every key of the product of the key fields' live codes: every probe. */
export const probesOf = (shape: Shape): ReadonlyArray<Key> =>
	Arr.flatMap(owners, (_, owner) =>
		Arr.map(odometer(Arr.map(blockOf(shape), (b) => b.codes)), (block) => ({ owner, block }))
	)

/** The keys Slotted holds: the points of the dependent space whose codes sum to an even number, in probe order. */
export const heldKeys = (c: FinCase): ReadonlyArray<Key> =>
	Arr.filter(
		probesOf(c.shape),
		(key) => inSpace(c, key) && Arr.reduce(keyCodes(key), 0, (a, b) => a + b) % 2 === 0
	)

/** A key's text, for a Map and a report. */
export const keyText = (key: Key): string => Arr.join(Arr.map(keyCodes(key), String), ",")

/**
 * The case's schema: Model, Slotted, and the probes CheckProbe, AtProbe, RowProbe, ProjProbe and Item, by shape, with
 * the containments of CheckProbe and ProjProbe into Slotted.
 */
export const schemaOf = (name: string, c: FinCase) => {
	const Model = closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		Arr.flatMap(c.held, (held, owner) => {
			const o = defined(owners[owner])
			return held === "none"
				? []
				: [{ version: o.version, parent: o.kind, positions: BigInt(held) }]
		})
	)
	const p = slot(closedId(Position), fin(Model, "positions"))
	const prefix = { version: closedId(Version), parent: closedId(Kind) }
	const probe = { id: closedId(Id), version: closedId(Version), kind: closedId(Kind) }
	const held = heldKeys(c)
	const ownerRow = (key: Key) => {
		const o = defined(owners[key.owner])
		return { version: o.version, parent: o.kind }
	}
	const w = (at: number) => defined(Payload.handles[at])
	const pos = (code: number) => defined(Position.handles[code])
	const label = (code: number) => defined(Label.handles[code])
	switch (c.shape) {
		case "follow": {
			const Slotted = closed.relation(
				"Slotted",
				{ ...prefix, from: p, to: p, w: closedId(Payload) },
				["version", "parent", "from", "to"],
				Arr.map(held, (key, at) => ({
					...ownerRow(key),
					from: pos(defined(key.block[0])),
					to: pos(defined(key.block[1])),
					w: w(at)
				}))
			)
			const CheckProbe = relation(
				"CheckProbe",
				{ ...probe, from: closedId(Position), to: closedId(Position) },
				["id"]
			)
			const AtProbe = relation.generated(
				"AtProbe",
				{ ...probe, from: closedId(Position), to: closedId(Position) },
				["id"],
				(r) => ({
					w: generated(closedId(Payload), Slotted.at("w", r.version, r.kind, r.from, r.to))
				})
			)
			const RowProbe = relation.generated(
				"RowProbe",
				{ ...probe, from: closedId(Position) },
				["id"],
				(r) => ({ next: generated(bits(Position), Slotted.row(r.version, r.kind, r.from)) })
			)
			const ProjProbe = relation("ProjProbe", { ...probe, last: closedId(Position) }, ["id"])
			const Item = relation(
				"Item",
				{ ...probe, from: closedId(Position), to: closedId(Position) },
				["id"]
			)
			const checked = contained(
				on(CheckProbe, "version", "kind", "from", "to"),
				on(Slotted, "version", "parent", "from", "to")
			)
			const projected = contained(
				on(ProjProbe, "version", "kind", "last"),
				on(Slotted, "version", "parent", "to")
			)
			const base = schema(
				name,
				[
					Version,
					Kind,
					Position,
					Label,
					Payload,
					Id,
					Model,
					Slotted,
					CheckProbe,
					AtProbe,
					RowProbe,
					Item,
					ProjProbe
				],
				[checked, projected]
			)
			const membership = query(base).rule((r) => {
				const it = v(Item, "item")
				return r
					.match(Item, { id: it.id, version: it.version, kind: it.kind, from: it.from, to: it.to })
					.match(Slotted, { version: it.version, parent: it.kind, from: it.from, to: it.to })
					.find({ id: it.id })
			})
			return { base, membership, laws: { checked, projected } }
		}
		case "last": {
			const Slotted = closed.relation(
				"Slotted",
				{ ...prefix, at: p, w: closedId(Payload) },
				["version", "parent", "at"],
				Arr.map(held, (key, at) => ({ ...ownerRow(key), at: pos(defined(key.block[0])), w: w(at) }))
			)
			const CheckProbe = relation("CheckProbe", { ...probe, at: closedId(Position) }, ["id"])
			const AtProbe = relation.generated(
				"AtProbe",
				{ ...probe, at: closedId(Position) },
				["id"],
				(r) => ({ w: generated(closedId(Payload), Slotted.at("w", r.version, r.kind, r.at)) })
			)
			const RowProbe = relation.generated("RowProbe", { ...probe }, ["id"], (r) => ({
				next: generated(bits(Position), Slotted.row(r.version, r.kind))
			}))
			const ProjProbe = relation("ProjProbe", { ...probe, last: closedId(Position) }, ["id"])
			const Item = relation("Item", { ...probe, at: closedId(Position) }, ["id"])
			const checked = contained(
				on(CheckProbe, "version", "kind", "at"),
				on(Slotted, "version", "parent", "at")
			)
			const projected = contained(
				on(ProjProbe, "version", "kind", "last"),
				on(Slotted, "version", "parent", "at")
			)
			const base = schema(
				name,
				[
					Version,
					Kind,
					Position,
					Label,
					Payload,
					Id,
					Model,
					Slotted,
					CheckProbe,
					AtProbe,
					RowProbe,
					Item,
					ProjProbe
				],
				[checked, projected]
			)
			const membership = query(base).rule((r) => {
				const it = v(Item, "item")
				return r
					.match(Item, { id: it.id, version: it.version, kind: it.kind, at: it.at })
					.match(Slotted, { version: it.version, parent: it.kind, at: it.at })
					.find({ id: it.id })
			})
			return { base, membership, laws: { checked, projected } }
		}
		case "symbol": {
			const Slotted = closed.relation(
				"Slotted",
				{ ...prefix, label: closedId(Label), position: p, w: closedId(Payload) },
				["version", "parent", "label", "position"],
				Arr.map(held, (key, at) => ({
					...ownerRow(key),
					label: label(defined(key.block[0])),
					position: pos(defined(key.block[1])),
					w: w(at)
				}))
			)
			const CheckProbe = relation(
				"CheckProbe",
				{ ...probe, label: closedId(Label), position: closedId(Position) },
				["id"]
			)
			const AtProbe = relation.generated(
				"AtProbe",
				{ ...probe, label: closedId(Label), position: closedId(Position) },
				["id"],
				(r) => ({
					w: generated(closedId(Payload), Slotted.at("w", r.version, r.kind, r.label, r.position))
				})
			)
			const RowProbe = relation.generated(
				"RowProbe",
				{ ...probe, label: closedId(Label) },
				["id"],
				(r) => ({ next: generated(bits(Position), Slotted.row(r.version, r.kind, r.label)) })
			)
			const ProjProbe = relation("ProjProbe", { ...probe, last: closedId(Position) }, ["id"])
			const Item = relation(
				"Item",
				{ ...probe, label: closedId(Label), position: closedId(Position) },
				["id"]
			)
			const checked = contained(
				on(CheckProbe, "version", "kind", "label", "position"),
				on(Slotted, "version", "parent", "label", "position")
			)
			const projected = contained(
				on(ProjProbe, "version", "kind", "last"),
				on(Slotted, "version", "parent", "position")
			)
			const base = schema(
				name,
				[
					Version,
					Kind,
					Position,
					Label,
					Payload,
					Id,
					Model,
					Slotted,
					CheckProbe,
					AtProbe,
					RowProbe,
					Item,
					ProjProbe
				],
				[checked, projected]
			)
			const membership = query(base).rule((r) => {
				const it = v(Item, "item")
				return r
					.match(Item, {
						id: it.id,
						version: it.version,
						kind: it.kind,
						label: it.label,
						position: it.position
					})
					.match(Slotted, {
						version: it.version,
						parent: it.kind,
						label: it.label,
						position: it.position
					})
					.find({ id: it.id })
			})
			return { base, membership, laws: { checked, projected } }
		}
	}
}

/** A probe's row as an INSERT under the installation's codes: its id, its owner's codes and its block's. */
export const insertSql = (
	names: PhysicalNames,
	relation: string,
	fields: ReadonlyArray<string>,
	values: ReadonlyArray<number>
): string =>
	`INSERT INTO ${printObjectName(names.relation(relation))} (${Arr.join(
		Arr.map(fields, (f) => quoteIdent(names.column(relation, f))),
		", "
	)}) VALUES (${Arr.join(
		Arr.map(values, (code) => `${code}::smallint`),
		", "
	)})`

/** An id's code: Id has no hole, so the n-th probe's id is code n. */
export const idCode = (n: number): number => codeOf(codecFor(idState), `i${n}`)

/**
 * A refused write into one relation, by the law PostgreSQL's report names on the relation's table, as an outcome names
 * it (types/changeset Law), grizzle's writer's `invariant-rejected` alike: a CHECK's (23514) by the law its constraint
 * reports; a NOT NULL's (23502) on a generated field's column, which names no constraint, by that field's law, its term
 * having no value at the row; or unnamed, a report that names no law of the relation, a roster domain's refusal among
 * them.
 */
export type Refusal =
	| { readonly kind: "rejected"; readonly law: Law }
	| { readonly kind: "unnamed"; readonly report: string }

/** The law PostgreSQL's report of a refused write into `relation` names (see Refusal), or none. */
const reportedLaw = (
	installation: Installation,
	relation: string,
	fields: PgErrorFields
): Law | undefined => {
	const table = installation.names.relation(relation)
	if (!Option.contains(fields.schema, table.schema) || !Option.contains(fields.table, table.name)) {
		return undefined
	}
	if (fields.code === sqlstates.notNullViolation) {
		const stored = defined(installation.checked.relations.get(relation))
		const generatedField = Arr.findFirst(
			stored.fields,
			(f) => f.writing.kind === "generated" && Option.contains(fields.column, f.column)
		)
		return Option.getOrUndefined(
			Option.map(generatedField, (f) => generatedLaw(stored.name, f.name))
		)
	}
	const law =
		fields.code === sqlstates.checkViolation && fields.constraint !== undefined
			? constraintLaw(
					installation.constraintToLaw,
					{ kind: "table", name: table.name },
					fields.constraint
				)
			: undefined
	return law === undefined ? undefined : installation.described.get(law)
}

/** What PostgreSQL's report of a refused write into `relation` names (see Refusal). */
const refusalOf = (installation: Installation, relation: string, error: SqlError): Refusal => {
	if (error.reason._tag === "ConnectionError") {
		return { kind: "unnamed", report: error.reason.message }
	}
	const law = reportedLaw(installation, relation, error.reason.fields)
	return law === undefined
		? { kind: "unnamed", report: Formatter.format(error.reason.fields) }
		: { kind: "rejected", law }
}

/** A write's outcome into `relation`: accepted, or its refusal. */
export const outcomeOf = (
	installation: Installation,
	relation: string,
	attempt: Effect.Effect<unknown, SqlError>
): Effect.Effect<Option.Option<Refusal>> =>
	Effect.map(Effect.result(attempt), (r) =>
		Result.match(r, {
			onSuccess: () => Option.none(),
			onFailure: (e) => Option.some(refusalOf(installation, relation, e))
		})
	)

export type FinFeature =
	| "an aliasing slot digit"
	| "an owner with no row"
	| "an empty relation"
	| "every live owner counting slots"
	| "two slots"
	| "one slot"
	| "a closed id before a slot"
	| "R07 read the key set"

/** Every case of the box: each live owner holding no row or counting 1 or 2 slots, under each shape. */
export const cases: Gen<FinCase> = (s) => ({
	held: Array.from({ length: owners.length }, () => s.draw(element<Held>(["none", 1, 2]))),
	shape: s.draw(element<Shape>(["follow", "last", "symbol"]))
})

/**
 * Whether a key outside the space would land on a cell of the space if its block were read in mixed radix at its owner's
 * radices with no range check: the alias the read's check refuses.
 */
export const aliases = (c: FinCase, key: Key): boolean => {
	const radices = (owner: number) =>
		Arr.map(blockOf(c.shape), (b) =>
			b.field === "label" ? b.codes : countOf(defined(c.held[owner]))
		)
	const blockSize = (owner: number) => Arr.reduce(radices(owner), 1, (a, b) => a * b)
	const base = Arr.reduce(
		Array.from({ length: key.owner }, (_, o) => o),
		0,
		(a, o) => a + blockSize(o)
	)
	const local = Arr.reduce(Arr.zip(key.block, radices(key.owner)), 0, (a, [d, r]) => a * r + d)
	const cells = Arr.reduce(
		Array.from({ length: owners.length }, (_, o) => o),
		0,
		(a, o) => a + blockSize(o)
	)
	return !inSpace(c, key) && base + local < cells
}
