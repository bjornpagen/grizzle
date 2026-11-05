import { compareText, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { constantMaxBits } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import {
	type Constant,
	constantDigestOf,
	constantOf,
	type Layout,
	rowMajorIndex,
	type Side,
	type Split,
	type Tuple
} from "#compiler/ir/cells.ts"
import { type Codebook, codeOf, type RosterCodec } from "#compiler/ir/codes.ts"
import { identityValueOf, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { ClosedTheoryRelation, LawField, NativeColumn, NativeOf } from "#compiler/ir/law.ts"
import { baseTypeRef, type ClosedConstant } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { baseOf, rosterOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { persistentText } from "#compiler/physical/ddl/expr.ts"
import { enforcement, lawReasons, type Node } from "#compiler/physical/obligations/graph.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type {
	CreateConstant,
	CreateDomain,
	Expr,
	ObjectName,
	PackConstant,
	PackRow,
	SqlStatement
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	binary,
	call,
	cast,
	eq,
	lit,
	ne,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"
import {
	constantValue,
	inSet,
	mixedRadix,
	pack,
	pairIn,
	payloadDigit
} from "#compiler/sql/constants.ts"

/**
 * The installation's constants: the functions a closed fact is read from, each an IMMUTABLE SQL function of no argument
 * named by the digest of its content, so equal contents are one function, a changed one is a new function, and none is
 * ever replaced in place (sql/ast.ts CreateConstant).
 *
 * - A roster installs its names constant, its handles in code order, a hole the empty name, as one name[], and the
 *   smallint domain over it, whose one CHECK admits exactly the codes whose name is not empty: every closed id column is
 *   typed by it, so it is the range proof every digit of a constant's index needs. A roster some set is typed over also
 *   installs its live-codes constant, derived from the names constant by its body so the roster's one fact is stated
 *   once, and the bits domain over bit(n), n every code it has minted, whose CHECK admits only live codes' bits.
 * - A closed relation installs its string of cells, read at the mixed-radix index of its key fields' codes, its key
 *   set, one bit per point of its key space, and a dictionary per open-typed payload field, the field's values in code
 *   order. A relation of no payload is its own key set, one function.
 * - A containment into a closed relation's side installs the side's string of cells, as a closed relation of its own,
 *   which the table CHECK that holds the containment reads (`closedMembership`).
 *
 * PostgreSQL packs every string of cells from rows of codes (sql/ast.ts PackConstant), so the host states the codes and
 * never the bits. A role is granted EXECUTE on every constant a statement it runs calls (physical/ddl/roles.ts).
 */

/** The code space of one coordinate of a closed relation's cells: a closed id's roster, or an open field's values. */
type CodeSpace =
	| { readonly kind: "roster"; readonly field: LawField; readonly codec: RosterCodec }
	| {
			readonly kind: "dictionary"
			readonly field: LawField
			/** The field's distinct values, in canonical text order, a value's code its position. */
			readonly values: ReadonlyArray<TypedLiteral>
			readonly codes: ReadonlyMap<string, number>
	  }

/**
 * The codes a coordinate holds: a roster's every minted code, holes included, or a dictionary's values, at least one: a
 * relation that holds no fact has an empty dictionary, whose cells still take one bit, since PostgreSQL has no bit(0)
 * and no code of it is ever read.
 */
const radixOf = (space: CodeSpace): number =>
	space.kind === "roster" ? space.codec.size : Math.max(1, space.values.length)

/** A literal's code in its coordinate's space: a live handle's code, or a value's position in its dictionary. */
const codeIn = (space: CodeSpace, literal: TypedLiteral): number => {
	if (space.kind === "roster") {
		if (literal.kind !== "handle") {
			throw defect("a closed id's value is a handle of its roster")
		}
		return codeOf(space.codec, literal.handle)
	}
	return defined(space.codes.get(literalKey(literal)), "a value is in its field's dictionary")
}

/** The roster codes of a closed id field, which every key field of a closed relation is. */
const rosterSpace = (codes: Codebook, field: LawField): CodeSpace => {
	const roster = rosterOf(baseOf(field.type))
	if (roster === undefined || baseOf(field.type).carrier !== "code") {
		throw defect(`the closed id ${field.name} is typed by its roster`)
	}
	return {
		kind: "roster",
		field,
		codec: defined(codes.rosters.get(roster.closed), "the codebook holds every roster")
	}
}

/** The code space of a payload field over `values`, the field's values in its relation's rows. */
const payloadSpace = (
	codes: Codebook,
	field: LawField,
	values: ReadonlyArray<TypedLiteral>
): CodeSpace => {
	if (baseOf(field.type).carrier === "code") {
		return rosterSpace(codes, field)
	}
	const distinct = new Map(values.map((v) => [literalKey(v), v] as const))
	const ordered = [...distinct].toSorted(([a], [b]) => compareText(a, b))
	return {
		kind: "dictionary",
		field,
		values: ordered.map(([, v]) => v),
		codes: new Map(ordered.map(([key], code) => [key, code] as const))
	}
}

/** A string of cells planned for its pack: its function's identity, its content, its key radices and its pack's rows. */
interface PlannedCells {
	readonly kind: "cells"
	readonly named: Identity<"closedConstant">
	readonly constant: Constant
	readonly radices: NonEmptyReadonlyArray<number>
	readonly rows: ReadonlyArray<PackRow>
}

/** A dictionary planned: its function's identity, its field, and its values in code order. */
interface PlannedDictionary {
	readonly kind: "dictionary"
	readonly named: Identity<"closedConstant">
	readonly field: LawField
	readonly values: ReadonlyArray<TypedLiteral>
}

type PlannedConstant = PlannedCells | PlannedDictionary

/** How a tuple's key and payload values are spelled in its pack row's comment: a handle, or a value's display. */
const displayOf = (literal: TypedLiteral): string => identityValueOf(literal).display

/**
 * The string of cells of `rows` over the coordinates `key` and `payload`, refused as ResourceBound when it is longer
 * than PostgreSQL's longest bit string, measured before it is built (`what` names it). Rows that repeat a tuple are one
 * cell; two at one key with different payloads are a key the declaration held, so their meeting is a defect.
 */
const plannedCells = (
	key: NonEmptyReadonlyArray<CodeSpace>,
	payload: ReadonlyArray<CodeSpace>,
	rows: ReadonlyArray<Split<TypedLiteral>>,
	what: string
): PlannedCells => {
	const layout: Layout = { key: mapNonEmpty(key, radixOf), payload: payload.map(radixOf) }
	const tuples = rows.map((row): Tuple => ({
		key: key.map((space, i) => codeIn(space, defined(row.key[i], "a key value per key field"))),
		payload: payload.map((space, i) =>
			codeIn(space, defined(row.payload[i], "a payload value per payload field"))
		)
	}))
	const encoded = constantOf(layout, tuples)
	if (!encoded.ok) {
		throw defect(`the declared key of ${what} holds its rows apart`)
	}
	const constant = encoded.value
	const bits = constant.cells * BigInt(constant.width)
	if (bits > BigInt(constantMaxBits.value)) {
		throw new Refusal(
			resourceBound(SourceLoc(what, []), {
				kind: "constantBits",
				constant: what,
				limit: constantMaxBits.value,
				needed: bits
			})
		)
	}
	const packed = new Map<bigint, PackRow>()
	for (const [i, tuple] of tuples.entries()) {
		const index = defined(rowMajorIndex(layout.key, tuple.key), "a tuple's key is in its space")
		const row = defined(rows[i], "a tuple per row")
		packed.set(index, {
			key: mapNonEmpty(layout.key, (_, k) => defined(tuple.key[k], "a code per key field")),
			payload: defined(rowMajorIndex(layout.payload, tuple.payload), "a payload in its space"),
			names: extendNonEmpty(
				mapNonEmpty(layout.key, (_, k) =>
					displayOf(defined(row.key[k], "a key value per key field"))
				),
				row.payload.map(displayOf)
			)
		})
	}
	return {
		kind: "cells",
		named: identity.closedConstant(constantDigestOf(constant)),
		constant,
		radices: layout.key,
		rows: [...packed].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row)
	}
}

/** A dictionary of `space`'s values, named by the digest of its element type and its values in code order. */
const plannedDictionary = (
	space: Extract<CodeSpace, { readonly kind: "dictionary" }>
): PlannedDictionary => ({
	kind: "dictionary",
	named: identity.closedConstant(
		constantDigest(
			"closed-constant",
			{ dictionary: typeLabel(baseOf(space.field.type)), values: space.values.map(literalKey) },
			everyProperty
		)
	),
	field: space.field,
	values: space.values
})

/** A closed relation's or side's constants as planned: the string of cells, the key set, and the dictionaries. */
interface PlannedRelation {
	readonly cells: PlannedCells
	readonly keys: PlannedCells
	readonly key: NonEmptyReadonlyArray<CodeSpace>
	readonly payload: ReadonlyArray<CodeSpace>
	readonly dictionaries: ReadonlyArray<PlannedDictionary>
}

/** The constants of `rows` over their key fields `key` and payload fields `payload`, `what` naming them. */
const plannedRelation = (
	codes: Codebook,
	key: NonEmptyReadonlyArray<LawField>,
	payloadFields: ReadonlyArray<LawField>,
	rows: ReadonlyArray<Split<TypedLiteral>>,
	what: string
): PlannedRelation => {
	const keySpaces = mapNonEmpty(key, (f) => rosterSpace(codes, f))
	const payload = payloadFields.map((f, i) =>
		payloadSpace(
			codes,
			f,
			rows.map((row) => defined(row.payload[i], "a payload value per payload field"))
		)
	)
	return {
		cells: plannedCells(keySpaces, payload, rows, what),
		keys: plannedCells(
			keySpaces,
			[],
			rows.map((row) => ({ key: row.key, payload: [] })),
			`the key set of ${what}`
		),
		key: keySpaces,
		payload,
		dictionaries: payload.flatMap((space) =>
			space.kind === "dictionary" ? [plannedDictionary(space)] : []
		)
	}
}

/** A field of a closed relation by name: every name a side or key reads is one of its fields. */
const fieldNamed = (relation: ClosedTheoryRelation, name: string): LawField =>
	defined(
		relation.fields.find((f) => f.name === name),
		`a field ${name} of the closed relation ${relation.name}`
	)

/**
 * The installation's closed relations, by name, each with its constants planned: every closed relation the owned
 * schema declares, a roster aside (its codes are its names constant's). Planned before any name is read, since every
 * reader of the installation's names reads a closed relation's constants by them (PhysicalNames.closed).
 */
export interface ClosedPlan {
	readonly relations: ReadonlyMap<string, PlannedRelation>
}

/** Each closed relation of `owned` the theory holds, its constants planned over the installation's codes. */
export const planClosed = (
	owned: Owned,
	closed: ReadonlyArray<ClosedTheoryRelation>,
	codes: Codebook
): ClosedPlan => {
	const out = new Map<string, PlannedRelation>()
	for (const r of closed.toSorted((x, y) => compareText(x.name, y.name))) {
		if (owned.relations[r.name]?.kind !== "closedRelation") {
			continue
		}
		const key = r.primaryFields
		const payload = r.fields.filter((f) => !key.includes(f))
		const rows = r.rows.map((row): Split<TypedLiteral> => ({
			key: key.map((f) => defined(row[f.position], "a value per field")),
			payload: payload.map((f) => defined(row[f.position], "a value per field"))
		}))
		out.set(r.name, plannedRelation(codes, key, payload, rows, `closed relation ${r.name}`))
	}
	return { relations: out }
}

/** A planned constant's function in the installed schema. */
const functionOf = (schema: string, named: Identity<"closedConstant">): ObjectName => ({
	schema,
	name: identifierOf(named)
})

/** How readers address a planned relation's constants (PhysicalNames.closed), under the installed schema. */
const closedConstantOf = (schema: string, plan: PlannedRelation): ClosedConstant => {
	const dictionaries = new Map(plan.dictionaries.map((d) => [d.field.name, d] as const))
	return {
		function: functionOf(schema, plan.cells.named),
		key: mapNonEmpty(plan.key, (space) => ({ field: space.field.name, radix: radixOf(space) })),
		width: plan.cells.constant.width,
		payload: plan.payload.map((space) => {
			const dictionary = dictionaries.get(space.field.name)
			return {
				field: space.field.name,
				radix: radixOf(space),
				dictionary: dictionary === undefined ? undefined : functionOf(schema, dictionary.named)
			}
		}),
		keys: functionOf(schema, plan.keys.named)
	}
}

/** Each planned closed relation's constants as its readers address them, by name. */
export const closedConstants = (
	schema: string,
	plan: ClosedPlan
): ReadonlyMap<string, ClosedConstant> =>
	new Map([...plan.relations].map(([name, r]) => [name, closedConstantOf(schema, r)] as const))

/** A constant's revoke from PUBLIC, which holds EXECUTE on every new function: a role is granted what it calls. */
const revokeFromPublic = (fn: ObjectName): SqlStatement => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
	from: [{ kind: "PUBLIC" }]
})

/** A string of cells' pack, under its function. */
const packOf = (schema: string, planned: PlannedCells): PackConstant =>
	pack(functionOf(schema, planned.named), planned.radices, planned.constant.width, planned.rows)

/**
 * A dictionary's CREATE: its values as one array literal of their base type, each element the text its input function
 * reads, in code order, so (D())[c + 1] is code c's value.
 */
const dictionaryOf = (b: InstallBuilder, planned: PlannedDictionary): CreateConstant => {
	const array = defined(
		arrayOf(baseTypeRef(b.names, planned.field.type)),
		"a dictionary's payload field is never a set"
	)
	return {
		kind: "createConstant",
		name: functionOf(b.schema, planned.named),
		params: [],
		returns: array,
		body: lit.text(
			arrayText(planned.values.map((v) => persistentText(b.names, v, planned.field.type))),
			array
		)
	}
}

/** One planned constant as an object of the installation, after the schema; equal constants are one object, which
 * holds every reason it is there for. */
const addPlanned = (
	b: InstallBuilder,
	planned: PlannedConstant,
	reasons: ReadonlyArray<PhysicalReason>
): Node<"setup"> => {
	b.name(planned.named)
	const fn = functionOf(b.schema, planned.named)
	return b.addConstant(
		planned.named,
		{
			ddl: [
				planned.kind === "cells" ? packOf(b.schema, planned) : dictionaryOf(b, planned),
				revokeFromPublic(fn)
			],
			reasons
		},
		[b.schemaNode]
	)
}

/** Every closed relation's constants as objects of the installation, in relation name order: its cells, its key set
 * (the cells themselves for no payload) and each dictionary. */
export const addClosedRelations = (b: InstallBuilder, plan: ClosedPlan): void => {
	for (const [name, r] of plan.relations) {
		const why = [enforcement(`closed relation ${name}`)]
		for (const planned of [r.cells, r.keys, ...r.dictionaries]) {
			addPlanned(b, planned, why)
		}
	}
}

/**
 * The text of an array literal of `elements`, each double-quoted with its backslashes and quotes escaped, so an empty
 * element, a hole's name, and one holding a comma, a brace or a space read back as themselves.
 */
const arrayText = (elements: ReadonlyArray<string>): string =>
	`{${elements.map((e) => `"${e.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`

/** What one roster installs: its names constant and its domain, and, when a set is typed over it, its live-codes
 * constant and its bits domain. */
export interface RosterObjects {
	readonly roster: DeclaredName
	readonly names: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly domain: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly bits:
		| {
				readonly live: { readonly name: ObjectName; readonly node: Node<"setup"> }
				readonly domain: { readonly name: ObjectName; readonly node: Node<"setup"> }
		  }
		| undefined
}

/** The identity of a roster's names constant: its roster and the digest of its names in code order. */
const namesIdentity = (codec: RosterCodec): Identity<"rosterConstant"> =>
	identity.rosterConstant(codec.roster, constantDigest("roster-names", codec.names, everyProperty))

/** A roster's names constant's function, the one its domain's CHECK and a role view's decoded column read. */
export const namesConstant = (b: InstallBuilder, roster: DeclaredName): ObjectName => ({
	schema: b.schema,
	name: identifierOf(
		namesIdentity(defined(b.names.codes.rosters.get(roster), "the codebook holds every roster"))
	)
})

/** The empty name, a hole's: no handle is empty, so a code is live exactly when its name is not this. */
const holeName = lit.text("", types.name(false))

/** An integer PostgreSQL types integer, which prints bare. */
const int = (value: number): Expr => lit.int(value, types.integer)

/**
 * The live-codes constant's body, derived from the names constant N so the roster's one fact is stated once: one bit per
 * code, 1 where its name is not the empty name, as bit varying,
 * `(SELECT string_agg(CASE WHEN (N())[r0.c0] <> '' THEN '1' ELSE '0' END, '' ORDER BY r0.c0)::bit varying FROM
 * generate_subscripts(N(), 1) AS r0(c0))`, under the audit's generated names. A roster numbers at least one code, so the aggregate reads a row and is never
 * NULL; holes alone would read zeros. PostgreSQL evaluates it at plan time, as every zero-argument IMMUTABLE function.
 */
const liveBody = (names: ObjectName): Expr => {
	const position = { kind: "column", table: "r0", column: "c0" } as const
	const bit = (value: string): Expr => lit.text(value, types.text)
	const flag: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{
				when: ne({ kind: "subscript", array: constantValue(names), index: position }, holeName),
				result: bit("1")
			}
		],
		else: bit("0")
	}
	return {
		kind: "subquery",
		query: simpleSelect(
			[
				target(
					cast(
						{
							...call("string_agg", [flag, bit("")]),
							orderBy: [{ expr: position, direction: "ASC" }]
						},
						types.varbit
					)
				)
			],
			[
				{
					kind: "function",
					call: call("generate_subscripts", [constantValue(names), int(1)]),
					alias: "r0",
					columns: ["c0"],
					lateral: false
				}
			],
			undefined
		)
	}
}

/** The rosters some set is typed over: each a field of a stored relation holds a set of, or a persistent expression
 * the installation lowers holds a set of, so every bits domain a column, a literal or a cast names is installed. */
const setRosters = (b: InstallBuilder): ReadonlySet<DeclaredName> => {
	const out = new Set<DeclaredName>()
	const note = (t: ScalarType): void => {
		const base = baseOf(t)
		if (base.carrier === "bits") {
			out.add(base.roster.closed)
		}
	}
	const walk = (e: ScalarExpr): void => {
		note(e.type)
		for (const a of e.args) {
			walk(a)
		}
	}
	for (const r of b.model.relations.values()) {
		for (const f of r.relation.fields) {
			note(f.type)
			if (f.writing.kind === "generated") {
				walk(f.writing.expr)
			}
		}
	}
	for (const { object: o } of b.natives) {
		switch (o.kind) {
			case "TableCheck":
				walk(o.predicate)
				continue
			case "LawColumn":
				if (o.value.kind === "generated") {
					walk(o.value.term)
					for (const g of o.value.guard) {
						walk(g)
					}
				}
				continue
			case "ClosedCheck":
				for (const g of o.guard) {
					walk(g.predicate)
				}
				continue
			case "PrimaryKey":
			case "Unique":
			case "Domain":
			case "RosterDomain":
			case "ForeignKey":
			case "WithoutOverlaps":
			case "PeriodForeignKey":
			case "ReverseIndex":
				continue
		}
	}
	return out
}

/**
 * Each roster's objects, in roster name order, after the schema:
 *
 * - its names constant, `<roster>__names__<digest>() RETURNS name[] RETURN '{"h0","h1","",…}'::name[]`, code c's handle
 *   at subscript c + 1 and a hole the empty name;
 * - its domain, `CREATE DOMAIN <roster> AS smallint CONSTRAINT check CHECK (((N())[VALUE + 1] <> ''::name) IS TRUE)`,
 *   which admits exactly the live codes: a code past either end reads NULL, and a hole the empty name;
 * - for a roster some set is typed over (`setRosters`), its live-codes constant (`liveBody`) and its bits domain,
 *   `CREATE DOMAIN <roster>__bits__<n> AS bit(n) CONSTRAINT check CHECK (((VALUE & L()) = VALUE) IS TRUE)`, n every
 *   code the roster has minted, which admits only the live codes' bits.
 *
 * A changed roster is a new names constant (and live constant), and its domains' CHECKs re-point at them, keeping their
 * names; a grown one's bits domain is a new domain of the new size.
 */
export const addRosters = (b: InstallBuilder): ReadonlyArray<RosterObjects> => {
	const sets = setRosters(b)
	return Object.values(b.owned.relations)
		.flatMap((r) => (r.kind === "closed" ? [r] : []))
		.toSorted((x, y) => compareText(x.name, y.name))
		.map((r): RosterObjects => {
			const roster = r.name
			const codec = defined(b.names.codes.rosters.get(roster), "the codebook holds every roster")
			const digest = constantDigest("roster-names", codec.names, everyProperty)
			const why = [enforcement(`the codes of roster ${roster}`)]
			const namesNamed = namesIdentity(codec)
			const names: ObjectName = { schema: b.schema, name: b.name(namesNamed) }
			const namesType = types.name(true)
			const namesNode = b.addConstant(
				namesNamed,
				{
					ddl: [
						{
							kind: "createConstant",
							name: names,
							params: [],
							returns: namesType,
							body: lit.text(arrayText(codec.names), namesType)
						},
						revokeFromPublic(names)
					],
					reasons: why
				},
				[b.schemaNode]
			)
			const domainNamed = identity.rosterDomain(roster)
			const domain = b.names.rosterDomain(roster)
			const domainName: ObjectName = { schema: domain.schema, name: b.name(domainNamed) }
			const create: CreateDomain = {
				kind: "createDomain",
				name: domainName,
				base: types.smallint,
				collation: undefined,
				constraints: [
					{
						name: b.name(identity.domainCheck(domainNamed)),
						predicate: ne(
							{
								kind: "subscript",
								array: constantValue(names),
								index: binary("+", { kind: "domainValue" }, int(1))
							},
							holeName
						)
					}
				]
			}
			const domainNode = b.addType("domain", domainNamed, { ddl: [create], reasons: why }, [
				b.schemaNode,
				namesNode
			])
			return {
				roster,
				names: { name: names, node: namesNode },
				domain: { name: domainName, node: domainNode },
				bits: sets.has(roster) ? addBits(b, roster, codec, digest, names, namesNode) : undefined
			}
		})
}

/** A roster's live-codes constant and its bits domain over it (`addRosters`). */
const addBits = (
	b: InstallBuilder,
	roster: DeclaredName,
	codec: RosterCodec,
	digest: Parameters<typeof identity.rosterLive>[1],
	names: ObjectName,
	namesNode: Node<"setup">
): RosterObjects["bits"] => {
	const why = [enforcement(`the live codes of roster ${roster}, which a set over it holds`)]
	const liveNamed = identity.rosterLive(roster, digest)
	const live: ObjectName = { schema: b.schema, name: b.name(liveNamed) }
	const liveNode = b.addConstant(
		liveNamed,
		{
			ddl: [
				{
					kind: "createConstant",
					name: live,
					params: [],
					returns: types.varbit,
					body: liveBody(names)
				},
				revokeFromPublic(live)
			],
			reasons: why
		},
		[b.schemaNode, namesNode]
	)
	const domainNamed = identity.bitsDomain(roster, codec.size)
	const domain: ObjectName = {
		schema: b.names.bitsDomain(roster).schema,
		name: b.name(domainNamed)
	}
	const value: Expr = { kind: "domainValue" }
	const domainNode = b.addType(
		"domain",
		domainNamed,
		{
			ddl: [
				{
					kind: "createDomain",
					name: domain,
					base: types.bit(codec.size),
					collation: undefined,
					constraints: [
						{
							name: b.name(identity.domainCheck(domainNamed)),
							predicate: eq(binary("&", value, constantValue(live)), value)
						}
					]
				}
			],
			reasons: why
		},
		[b.schemaNode, liveNode]
	)
	return { live: { name: live, node: liveNode }, domain: { name: domain, node: domainNode } }
}

/**
 * A containment into a closed relation's side as the table CHECK that holds it, after its constants, which it adds:
 * the side's string of cells as a closed relation of its own, read at the mixed-radix index of the row's key columns,
 * `NOT guard OR member`, the guard the source side's selection, each conjunct lowered over the row by `lower`.
 *
 * The guard is C2's RowGuard, the one representation of a selection over a row. An installed CHECK lowers it by the
 * persistent lowering (physical/ddl/expr.ts lowerPersistent), as every row CHECK and law column's guard is, so a
 * literal is typed by its base and never cast to a domain, whose later tightening would refuse every later insert;
 * only a probe's query, which runs once per statement, lowers a guard through write/insert/unique.ts withinRow.
 *
 * A side of no payload is a set, `substring(S(), i + 1, 1) = '1'::bit(1)`. A side whose payload fields are closed ids
 * compares its one cell, `substring(S(), i · w + 1, w)::integer = 1 + p`, p the mixed-radix code of the row's payload
 * columns. A side with an open-typed payload field compares each payload coordinate on its own, a closed id's code
 * with its column and an open value through its dictionary, `(D())[c + 1] = column`. An absent key reads NULL, which
 * the CHECK's IS TRUE refuses. Every key column is typed by its key field's roster domain (ir/law.ts ClosedCheck), so
 * every digit is below its radix and no index aliases a neighbour's.
 */
export const closedMembership = (
	b: InstallBuilder,
	check: NativeOf<"ClosedCheck">,
	column: (c: NativeColumn) => Expr,
	lower: (predicate: ScalarExpr) => Expr
): { readonly predicate: Expr; readonly constants: ReadonlyArray<Node<"setup">> } => {
	const side: Side<TypedLiteral> = check.side
	const closed = check.target
	const plan = plannedRelation(
		b.names.codes,
		mapNonEmpty(side.key, (f) => fieldNamed(closed, f)),
		side.payload.map((f) => fieldNamed(closed, f)),
		side.rows,
		`the side of ${closed.name} a containment from ${check.relation.name} reads`
	)
	const why = lawReasons(check.lawIds)
	const constants = [plan.cells, ...plan.dictionaries].map((planned) => addPlanned(b, planned, why))
	const sourceOf = (field: string): Expr =>
		column(
			defined(
				check.pairs.find((p) => p.target.name === field),
				`a source column for the side's field ${field}`
			).source
		)
	const index = mixedRadix(
		mapNonEmpty(plan.key, (space) => ({ digit: sourceOf(space.field.name), radix: radixOf(space) }))
	)
	const cells = functionOf(b.schema, plan.cells.named)
	const width = plan.cells.constant.width
	const radices = plan.payload.map(radixOf)
	const member = !isNonEmpty(plan.payload)
		? inSet(cells, index)
		: plan.payload.every((space) => space.kind === "roster")
			? pairIn(
					cells,
					index,
					width,
					mixedRadix(
						mapNonEmpty(plan.payload, (space) => ({
							digit: sourceOf(space.field.name),
							radix: radixOf(space)
						}))
					)
				)
			: and(
					mapNonEmpty(plan.payload, (space, position) => {
						const code = payloadDigit(cells, index, width, radices, position)
						const dictionary = plan.dictionaries.find((d) => d.field === space.field)
						return eq(
							dictionary === undefined
								? code
								: {
										kind: "subscript",
										array: constantValue(functionOf(b.schema, dictionary.named)),
										index: binary("+", code, int(1))
									},
							sourceOf(space.field.name)
						)
					})
				)
	const guards = check.guard.map((g) => lower(g.predicate))
	return {
		predicate: isNonEmpty(guards)
			? { kind: "or", args: [{ kind: "not", expr: and(guards) }, member] }
			: member,
		constants
	}
}
