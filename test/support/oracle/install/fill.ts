/**
 * The stored rows of a fact set's family relations, filled as grizzle's own host fill fills a nested insert
 * (write/family/fold.ts filler). A fact is a written row (rows-first): its caller's fields and its serial ones, never a
 * value a family draws. The fill draws the rest from the facts alone: each owner's count and ends, each member's group
 * fields from its owner, its index, its copy of its owner's count, and each fold's running values, in the row layout
 * every family statement writes (write/family/statements.ts rowLayout). So the loader states no drawn value, and the
 * family's natives judge the fill at COMMIT as they judge grizzle's own.
 *
 * A counted family's members take their slots in the order the facts list them, which is grizzle's to choose; an
 * ordered family's, in that order too, its caller's order. A member is a member of one family, under the owner its group
 * fields name, and a tree's shape is its caller's nesting, which no fact states: each is refused, as a member no owner
 * fact holds is.
 */
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, LawRelation, RelationInfo } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { admittedText, admitValue } from "#compiler/scalar/values/identity.ts"
import { builtinType } from "#compiler/sql/build.ts"
import {
	closedLeaf,
	type ColumnKey,
	type FilledNode,
	fieldKey,
	filler,
	type HostNode,
	hostEvaluator
} from "#compiler/write/family/fold.ts"
import { rowLayout } from "#compiler/write/family/statements.ts"
import { Identities, type Interned } from "#test/support/kernel/identity.ts"
import {
	type ColumnType,
	type InstallPlan,
	uncontracted
} from "#test/support/oracle/install/model.ts"

/** A column a family relation's INSERT writes: a field, by its name, or a drawn law column, by its name and type. */
type FilledColumn =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "law"; readonly column: string; readonly type: ColumnType }

/** A family relation's stored rows: the columns its INSERT writes, and each row's host values in their order. */
export interface FilledRelation {
	readonly columns: ReadonlyArray<FilledColumn>
	readonly rows: ReadonlyArray<ReadonlyArray<unknown>>
}

/** A fact of a family relation admitted: each written field's host value, by its name, and where the fact stands. */
interface Admitted {
	readonly values: ReadonlyMap<string, unknown>
	readonly location: string
}

const refuse = (location: string, capability: string): Result.Result<never, CompileError> =>
	Result.err(malformedDescription(SourceLoc(location, []), capability))

/** The fields a fact of `relation` states: its caller's and its serial ones. */
const writtenFields = (relation: LawRelation): ReadonlyArray<LawField> =>
	Arr.filter(relation.fields, (f) => f.writing.kind === "caller" || f.writing.kind === "serial")

/**
 * A drawn law column's type as the loader spells its values: an integer, numeric, float, money or boolean carrier, each
 * its builtin type, a law column being typed by no contract; none for another carrier, which no fold accumulates.
 */
const lawColumnType = (type: ScalarType): ColumnType | undefined => {
	switch (type.carrier) {
		case "int2":
			return {
				sql: builtinType("smallint"),
				value: { kind: "integer", carrier: "int2" },
				contract: uncontracted
			}
		case "int4":
			return {
				sql: builtinType("integer"),
				value: { kind: "integer", carrier: "int4" },
				contract: uncontracted
			}
		case "int8":
			return {
				sql: builtinType("bigint"),
				value: { kind: "integer", carrier: "int8" },
				contract: uncontracted
			}
		case "numeric":
			return { sql: builtinType("numeric"), value: { kind: "numeric" }, contract: uncontracted }
		case "float4":
			return {
				sql: builtinType("real"),
				value: { kind: "float", carrier: "float4" },
				contract: uncontracted
			}
		case "float8":
			return {
				sql: builtinType("double precision"),
				value: { kind: "float", carrier: "float8" },
				contract: uncontracted
			}
		case "money":
			return { sql: builtinType("money"), value: { kind: "money" }, contract: uncontracted }
		case "bool":
			return { sql: builtinType("boolean"), value: { kind: "bool" }, contract: uncontracted }
		case "uuid":
		case "date":
		case "bytes":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/**
 * The stored rows of every relation the plan's families name, as owner or member, from `facts`: none for a plan of no
 * family. Every other relation's facts are the loader's own.
 */
export const familyRows = (
	plan: InstallPlan,
	facts: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>
): Result.Result<ReadonlyMap<string, FilledRelation>, CompileError> => {
	const { order, closed, patterns } = plan.fill
	const families = order.families
	const codes = plan.codes
	const relations = new Map<string, RelationInfo>()
	const memberOf = new Map<string, Family>()
	for (const f of families) {
		const at = formatLoc(SourceLoc(`family ${f.id.owner}.${f.id.count}`, [plan.declared]))
		if (f.members.kind === "tree") {
			return refuse(
				at,
				"a family whose members' shape the facts state: a tree's is its caller's nesting"
			)
		}
		if (memberOf.has(f.member.name)) {
			return refuse(at, `a member of one family at most: ${f.member.name} is a member of two`)
		}
		memberOf.set(f.member.name, f)
		relations.set(f.owner.name, f.owner)
		relations.set(f.member.name, f.member)
	}
	const owned = (relation: string): ReadonlyArray<Family> =>
		Arr.filter(families, (f) => f.owner.name === relation)
	const textOf = (field: LawField, value: unknown): string =>
		admittedText(carrierSpecOf(field.type, codes), value)
	/** Facts' identities and groups' keys, interned: each its texts in order, never one text joined from them. */
	const identities = new Identities()
	/** Each relation's facts admitted, an exact repeat of a fact once, as facts are a set. */
	const admitted = new Map<string, ReadonlyArray<Admitted>>()
	for (const [name, relation] of relations) {
		const fields = writtenFields(relation)
		const names = Arr.map(fields, (f) => f.name)
		const seen = new Set<Interned>()
		const list: Array<Admitted> = []
		const given = Rec.has(facts, name) ? (facts[name] ?? []) : []
		for (const [index, fact] of given.entries()) {
			const location = formatLoc(
				SourceLoc(`fact ${name}[${index}]`, [plan.declared, "facts", name, index])
			)
			const keys = Rec.keys(fact)
			if (keys.length !== names.length || !Arr.every(keys, (k) => names.includes(k))) {
				return refuse(
					location,
					`a written fact of ${name}: exactly the fields ${Arr.join(names, ", ")}, a family's drawn values being grizzle's`
				)
			}
			const values = new Map<string, unknown>()
			for (const field of fields) {
				const value = admitValue(carrierSpecOf(field.type, codes), fact[field.name])
				if (!value.ok) {
					return refuse(
						`${location}.${field.name}`,
						`a value of ${field.name}'s type, not one refused ${value.error}`
					)
				}
				values.set(field.name, value.value)
			}
			const identity = identities.of(Arr.map(fields, (f) => textOf(f, values.get(f.name))))
			if (!seen.has(identity)) {
				seen.add(identity)
				list.push({ values, location })
			}
		}
		admitted.set(name, list)
	}
	const factsOf = (relation: string): ReadonlyArray<Admitted> => admitted.get(relation) ?? []
	/** A fact's group in `family`, interned: its member side's, or its owner side's key, which a member's names. */
	const groupOf = (family: Family, side: "member" | "owner", fact: Admitted): Interned =>
		identities.of(Arr.map(family.group, (g) => textOf(g[side], fact.values.get(g[side].name))))
	const groups = new Map<Family, ReadonlyMap<Interned, ReadonlyArray<Admitted>>>()
	for (const f of families) {
		const byOwner = new Map<Interned, Array<Admitted>>()
		for (const m of factsOf(f.member.name)) {
			const group = groupOf(f, "member", m)
			byOwner.set(group, [...(byOwner.get(group) ?? []), m])
		}
		groups.set(f, byOwner)
	}
	const placed = new Set<Admitted>()
	/** A fact's nesting: its own written fields, but the group its family supplies, and every family it owns. */
	const nodeOf = (relation: LawRelation, family: Family | undefined, fact: Admitted): HostNode => {
		const supplied = new Set(
			family === undefined ? [] : Arr.map(family.group, (g) => g.member.name)
		)
		return {
			relation: relation.name,
			values: new Map(
				Arr.flatMap(writtenFields(relation), (f) =>
					supplied.has(f.name) ? [] : [[fieldKey(f.name), fact.values.get(f.name)] as const]
				)
			),
			families: Arr.map(owned(relation.name), (g) => ({
				family: g.id,
				members: Arr.map(groups.get(g)?.get(groupOf(g, "owner", fact)) ?? [], (m) => {
					placed.add(m)
					return nodeOf(g.member, g, m)
				})
			}))
		}
	}
	const fill = filler(order, codes, hostEvaluator(codes, closedLeaf(closed), patterns))
	const rows = new Map<string, Array<ReadonlyMap<ColumnKey, unknown>>>()
	const collect = (node: FilledNode): void => {
		rows.set(node.relation, [...(rows.get(node.relation) ?? []), node.values])
		for (const g of node.families) {
			for (const m of g.members) {
				collect(m)
			}
		}
	}
	for (const [name, relation] of relations) {
		if (memberOf.has(name)) {
			continue
		}
		for (const fact of factsOf(name)) {
			const filled = fill(nodeOf(relation, undefined, fact), { kind: "top" })
			if (!filled.ok) {
				return refuse(
					fact.location,
					`a fill of its families, not ${Formatter.format(filled.error)}`
				)
			}
			collect(filled.value)
		}
	}
	for (const f of families) {
		const orphan = Arr.findFirst(factsOf(f.member.name), (m) => !placed.has(m))
		if (Option.isSome(orphan)) {
			return refuse(
				orphan.value.location,
				`a member of the family ${f.id.owner}.${f.id.count} whose owner is a fact of ${f.owner.name}`
			)
		}
	}
	const out = new Map<string, FilledRelation>()
	for (const [name, relation] of relations) {
		const layout = rowLayout(relation, families)
		const laid = [...layout.key, ...layout.columns]
		const columns: Array<FilledColumn> = []
		for (const c of laid) {
			if (c.column.kind === "field") {
				columns.push({ kind: "field", field: c.column.field.name })
				continue
			}
			const type = lawColumnType(c.type)
			if (type === undefined) {
				return refuse(
					formatLoc(SourceLoc(`relation ${name}`, [plan.declared])),
					`a drawn law column the loader spells: ${c.key} is of carrier ${c.type.carrier}`
				)
			}
			columns.push({ kind: "law", column: c.column.column, type })
		}
		out.set(name, {
			columns,
			rows: Arr.map(rows.get(name) ?? [], (values) =>
				Arr.map(laid, (c) => {
					const value = values.get(c.key)
					if (value === undefined) {
						throw new Error(`the fill leaves ${name}'s ${c.key} without a value`)
					}
					return value
				})
			)
		})
	}
	return Result.ok(out)
}
