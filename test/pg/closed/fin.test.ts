/**
 * Dependent-sum keys on closed relations, read by PostgreSQL through every reader grizzle installs, over an exhaustive
 * box of small dependent spaces: the alias bar.
 *
 * Each case installs a count relation Model over the owner prefix (Version, Kind), Kind holding a hole at code 1 so a
 * live owner's code lies past its declared position, each live owner counting 1 or 2 slots of Position or holding no
 * row; and a slotted relation Slotted of one of three shapes (two slots; one slot; a closed id of Label before a slot),
 * holding the points of its dependent space whose codes sum to an even number, each with a payload of its own. Every key
 * of the product of the key fields' live codes is then read four ways. The keys include every slot code at or past its
 * owner's count, at which a mixed radix without the range check would land on another key's cell, and each read is
 * judged against the model, Slotted's rows, a second implementation that shares nothing with the packing or the
 * reads:
 *
 * - **the containment CHECK:** a row of CheckProbe holding the key is accepted exactly where Slotted holds the key, and
 *   elsewhere refused by the containment's law, 23514 on the CHECK that reports it;
 * - **C.at in a generated field:** a row of AtProbe is accepted with exactly the key's own payload where Slotted holds
 *   the key, and elsewhere refused by the generated field's law, `{ kind: "generated", relation, field }`: an absent key
 *   reads NULL, which every domain admits, so the generated column's NOT NULL refuses it, 23502 on that column;
 * - **C.row in a generated field:** each prefix's set in RowProbe is exactly the codes Slotted's rows complete it with,
 *   the empty set for a prefix past its owner's count, as Position's bits domain stores it, whole hex digits wide;
 * - **R07's membership read:** a query matching Item against Slotted on every key field delivers exactly the items
 *   whose key Slotted holds, read through its key set with the rewrite's certificate;
 * - **a containment into a projection:** a row of ProjProbe holding an owner and a slot code is accepted exactly where
 *   some row of Slotted holds both, the side (version, parent, last field) a dependent space of its own, and elsewhere
 *   refused by that containment's law.
 *
 * A refusal is judged by the law PostgreSQL's report names, as grizzle's writer names it, never by its SQLSTATE alone: a
 * roster domain's 23514 names no law, grizzle's own defect, and is no refusal any probe expects.
 *
 * No two distinct keys share a cell: an alias would read another key's presence, payload or completions. Each case
 * installs every closed constant, the owner functions' too, as its hex literal, padded with 0 bits to whole digits, so
 * a read past the last cell reads the padding, absent. The box: 3 shapes and every assignment of no row, 1 or 2 slots
 * to the 4 live owners, 243 installations.
 */
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { type Codebook, codeOf } from "#compiler/ir/codes.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { generatedLaw } from "#compiler/plan/change.ts"
import { bits, closedId, generated, natural, slot } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, fin, on, relation, schema } from "#compiler/public/schema.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { setText } from "#test/support/closed/bit-text.ts"
import {
	codebookOfStates,
	codecFor,
	type ModelSlot,
	type RosterState
} from "#test/support/closed/generate.ts"
import {
	compileTemplate,
	installationSql,
	installedCodes,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import { installationNamesOf, parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { PgErrorFields, SqlError } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

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
const payloadState = stateOf("Payload", liveRun("w", 16))
const idState = stateOf("Id", liveRun("i", 36))

const states = [versionState, kindState, positionState, labelState, payloadState, idState]
const codes: Codebook = codebookOfStates(states)

const Version = closed("Version", ["v0", "v1"])
const Kind = closed("Kind", ["k0", "k2"])
const Position = closed("Position", ["p0", "p1", "p2"])
const Label = closed("Label", ["x0", "x1"])
const Payload = closed("Payload", [
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
const Id = closed("Id", [
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
const owners = [
	{ version: "v0", kind: "k0", codes: [0, 0] },
	{ version: "v0", kind: "k2", codes: [0, 2] },
	{ version: "v1", kind: "k0", codes: [1, 0] },
	{ version: "v1", kind: "k2", codes: [1, 2] }
] as const

type Held = "none" | 1 | 2
type Shape = "follow" | "last" | "symbol"
interface FinCase {
	readonly held: ReadonlyArray<Held>
	readonly shape: Shape
}

/** A key: its owner's position among the live owners, and its block's codes in key order. */
interface Key {
	readonly owner: number
	readonly block: ReadonlyArray<number>
}

/** The block fields of a shape, in key order, with the live codes each takes. */
const blockOf = (shape: Shape): ReadonlyArray<{ readonly field: string; readonly codes: number }> =>
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
const keyCodes = (key: Key): ReadonlyArray<number> => [
	...defined(owners[key.owner]).codes,
	...key.block
]

/** Every key of the product of the key fields' live codes: every probe. */
const probesOf = (shape: Shape): ReadonlyArray<Key> =>
	Arr.flatMap(owners, (_, owner) =>
		Arr.map(odometer(Arr.map(blockOf(shape), (b) => b.codes)), (block) => ({ owner, block }))
	)

/** The keys Slotted holds: the points of the dependent space whose codes sum to an even number, in probe order. */
const heldKeys = (c: FinCase): ReadonlyArray<Key> =>
	Arr.filter(
		probesOf(c.shape),
		(key) => inSpace(c, key) && Arr.reduce(keyCodes(key), 0, (a, b) => a + b) % 2 === 0
	)

/** A key's text, for a Map and a report. */
const keyText = (key: Key): string => Arr.join(Arr.map(keyCodes(key), String), ",")

/**
 * The case's schema: Model, Slotted, and the probes CheckProbe, AtProbe, RowProbe, ProjProbe and Item, by shape, with
 * the containments of CheckProbe and ProjProbe into Slotted.
 */
const schemaOf = (name: string, c: FinCase) => {
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
				{
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
				},
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
				{
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
				},
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
				{
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
				},
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
const insertSql = (
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
const idCode = (n: number): number => codeOf(codecFor(idState), `i${n}`)

/**
 * A refused write into one relation, by the law PostgreSQL's report names on the relation's table, as an outcome names
 * it (types/changeset Law), grizzle's writer's `invariant-rejected` alike: a CHECK's (23514) by the law its constraint
 * reports; a NOT NULL's (23502) on a generated field's column, which names no constraint, by that field's law, its term
 * having no value at the row; or unnamed, a report that names no law of the relation, a roster domain's refusal among
 * them.
 */
type Refusal =
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
		const generatedField = Arr.findFirst(
			defined(installation.checked.relations.get(relation)).fields,
			(f) => f.writing.kind === "generated" && Option.contains(fields.column, f.column)
		)
		return Option.getOrUndefined(Option.map(generatedField, (f) => generatedLaw(relation, f.name)))
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
const outcomeOf = (
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

type FinFeature =
	| "an aliasing slot digit"
	| "an owner with no row"
	| "an empty relation"
	| "every live owner counting slots"
	| "two slots"
	| "one slot"
	| "a closed id before a slot"

/** Every case of the box: each live owner holding no row or counting 1 or 2 slots, under each shape. */
const cases: Gen<FinCase> = (s) => ({
	held: Array.from({ length: owners.length }, () => s.draw(element<Held>(["none", 1, 2]))),
	shape: s.draw(element<Shape>(["follow", "last", "symbol"]))
})

/**
 * Whether a key outside the space would land on a cell of the space if its block were read in mixed radix at its owner's
 * radices with no range check: the alias the read's check refuses.
 */
const aliases = (c: FinCase, key: Key): boolean => {
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

layer(Substrate.layer, { excludeTestServices: true })("dependent keys on PostgreSQL", (it) => {
	it.effect(
		"every reader reads each key's own cell, and a slot code past its count reads absent",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "closed/fin",
						oracle: {
							kind: "second-implementation",
							name: "Slotted's rows: the keys it holds, each key's payload and each prefix's completions"
						},
						box: "3 shapes, each of 4 live owners (a hole among Kind's codes) holding no row or counting 1 or 2 slots, every key of the live codes' product",
						generator: cases,
						literal: Formatter.format,
						limit: 243,
						coverage: requiredInSpace<FinFeature>([
							"an aliasing slot digit",
							"an owner with no row",
							"an empty relation",
							"every live owner counting slots",
							"two slots",
							"one slot",
							"a closed id before a slot"
						]),
						caseHang
					},
					(c: FinCase, notes: Case<FinFeature>) =>
						Effect.gen(function* () {
							const s = yield* Substrate
							const name = yield* s.schema({ create: false, label: "fin" })
							const installation = identity.schema(parsedSchemaName(name))
							const built = schemaOf(name, c)
							const owned = succeeded(ownedInput(built.base))
							const compiled = succeeded(
								compileInstallation(owned, {
									...completeInstallOptions(owned, [installation], [], [], codes),
									owner: s.owner.role
								})
							)
							yield* transaction(s.admin, installationSql(compiled))
							const names = compiled.names
							const lawNames = installationNamesOf(compiled)
							const rejected = (law: Law): Option.Option<Refusal> =>
								Option.some({ kind: "rejected", law })
							const checkRefused = rejected(lawNames.described(lawNames.lawOf(built.laws.checked)))
							const projectionRefused = rejected(
								lawNames.described(lawNames.lawOf(built.laws.projected))
							)
							const atRefused = rejected(generatedLaw("AtProbe", "w"))
							const block = blockOf(c.shape)
							const fields = ["id", "version", "kind", ...Arr.map(block, (b) => b.field)]
							const probes = probesOf(c.shape)
							const held = heldKeys(c)
							const payloadAt = new Map(Arr.map(held, (key, at) => [keyText(key), at] as const))
							const valuesOf = (key: Key, n: number) => [idCode(n), ...keyCodes(key)]
							for (const [n, key] of probes.entries()) {
								const at = payloadAt.get(keyText(key))
								const check = yield* outcomeOf(
									compiled,
									"CheckProbe",
									s.admin.query(insertSql(names, "CheckProbe", fields, valuesOf(key, n)), [])
								)
								assert.deepEqual(
									check,
									at === undefined ? checkRefused : Option.none(),
									`the containment CHECK at ${keyText(key)}`
								)
								const read = yield* outcomeOf(
									compiled,
									"AtProbe",
									s.admin.query(insertSql(names, "AtProbe", fields, valuesOf(key, n)), [])
								)
								assert.deepEqual(
									read,
									at === undefined ? atRefused : Option.none(),
									`C.at's generated field at ${keyText(key)}`
								)
								if (aliases(c, key)) {
									notes.note("an aliasing slot digit")
								}
							}
							const stored = yield* s.admin.queryValues(
								`SELECT ${quoteIdent(names.column("AtProbe", "id"))}, ${quoteIdent(names.column("AtProbe", "w"))} FROM ${printObjectName(names.relation("AtProbe"))}`,
								[]
							)
							const payloadCode = (at: number) => codeOf(codecFor(payloadState), `w${at}`)
							assert.deepEqual(
								Arr.sort(
									Arr.map(stored, (row) => `${String(row[0])}:${String(row[1])}`),
									Order.String
								),
								Arr.sort(
									Arr.flatMap(probes, (key, n) => {
										const at = payloadAt.get(keyText(key))
										return at === undefined ? [] : [`${idCode(n)}:${payloadCode(at)}`]
									}),
									Order.String
								),
								"each held key's generated field holds its own payload"
							)
							const prefixFields = fields.slice(0, -1)
							const lastCodes = defined(block[block.length - 1]).codes
							const prefixes = [
								...new Map(
									Arr.map(probes, (key): readonly [string, Key] => {
										const prefix = { owner: key.owner, block: key.block.slice(0, -1) }
										return [keyText(prefix), prefix]
									})
								).values()
							]
							for (const [n, prefix] of prefixes.entries()) {
								yield* s.admin.query(
									insertSql(names, "RowProbe", prefixFields, valuesOf(prefix, n)),
									[]
								)
							}
							const rows = yield* s.admin.queryValues(
								`SELECT ${quoteIdent(names.column("RowProbe", "id"))}, ${quoteIdent(names.column("RowProbe", "next"))}::text FROM ${printObjectName(names.relation("RowProbe"))}`,
								[]
							)
							const completionsOf = (prefix: Key): string =>
								setText(
									lastCodes,
									Arr.filter(
										Array.from({ length: lastCodes }, (_, code) => code),
										(code) =>
											payloadAt.has(
												keyText({ owner: prefix.owner, block: [...prefix.block, code] })
											)
									)
								)
							assert.deepEqual(
								Arr.sort(
									Arr.map(rows, (row) => `${String(row[0])}:${String(row[1])}`),
									Order.String
								),
								Arr.sort(
									Arr.map(prefixes, (prefix, n) => `${idCode(n)}:${completionsOf(prefix)}`),
									Order.String
								),
								"each prefix's generated set holds exactly its completions"
							)
							for (const [n, key] of probes.entries()) {
								yield* s.admin.query(insertSql(names, "Item", fields, valuesOf(key, n)), [])
							}
							const projected = new Set(
								Arr.map(held, (key) => `${key.owner}:${defined(key.block[key.block.length - 1])}`)
							)
							for (const owner of Arr.map(owners, (_, o) => o)) {
								for (const last of [0, 1, 2]) {
									const n = owner * 3 + last
									const verdict = yield* outcomeOf(
										compiled,
										"ProjProbe",
										s.admin.query(
											insertSql(
												names,
												"ProjProbe",
												["id", "version", "kind", "last"],
												[idCode(n), ...defined(owners[owner]).codes, last]
											),
											[]
										)
									)
									assert.deepEqual(
										verdict,
										projected.has(`${owner}:${last}`) ? Option.none() : projectionRefused,
										`the containment into Slotted's projection at owner ${owner}, ${last}`
									)
								}
							}
							const template = succeeded(
								compileTemplate(built.membership, built.base, {
									...testCompile,
									installation,
									codes: installedCodes(codes)
								})
							)
							const [optimized] = template.optimized
							const delivered = yield* s.admin.queryValues(
								defined(optimized).sql,
								paramTexts(defined(optimized), {}, { params: template.params, codes })
							)
							assert.deepEqual(
								Arr.sort(
									Arr.map(delivered, (row) => String(row[0])),
									Order.String
								),
								Arr.sort(
									Arr.flatMap(probes, (key, n) =>
										payloadAt.has(keyText(key)) ? [String(idCode(n))] : []
									),
									Order.String
								),
								`the membership read delivers exactly the items whose key Slotted holds:\n${defined(optimized).sql}`
							)
							if (held.length > 0) {
								assert.ok(
									Arr.some(template.certificates, (cert) => cert.rule === "R07.closedMembership"),
									"R07 reads Slotted's key set"
								)
							}
							if (c.held.includes("none")) {
								notes.note("an owner with no row")
							}
							if (held.length === 0) {
								notes.note("an empty relation")
							}
							if (Arr.every(c.held, (h) => h !== "none")) {
								notes.note("every live owner counting slots")
							}
							notes.note(
								c.shape === "follow"
									? "two slots"
									: c.shape === "last"
										? "one slot"
										: "a closed id before a slot"
							)
						}).pipe(Effect.scoped)
				)
			)
	)
})
