import { array, type Gen, int, map } from "@grizzle/testing/gen"
import { exact, set } from "@grizzle/testing/oracle"
import { keep, type Swarm, swarm as swarmOf, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option, String as Str } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import {
	closed,
	contained as containment,
	key as keyStatement,
	login,
	mutable,
	on,
	type Relation,
	relation as declareRelation,
	role,
	type Statement,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { foreignKeyColumns, installationNamesOf } from "#test/support/kernel/naming.ts"
import { nonEmptyArgumentsOf } from "#test/support/list.ts"
import type { OracleRelation, OracleSchema } from "#test/support/oracle/addwins.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import {
	fieldOf,
	isSerialKind,
	referable,
	rosterHandles,
	rosterName,
	type SerialKind,
	type TypeKind,
	typeInfo,
	typeKinds
} from "#test/support/oracle/write/domain.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { selectorOf } from "#test/support/worlds/execute/build.ts"

interface WColumn {
	readonly name: string
	readonly kind: TypeKind
}

export interface WRelation {
	readonly name: string
	readonly columns: ReadonlyArray<WColumn>
	readonly primaryKey: ReadonlyArray<string>
	/** Candidate keys beyond the primary key. */
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly mutable: boolean
}

/**
 * A containment of `from.fields` into the primary key or a candidate key `to.fields` of an earlier relation of the same
 * group.
 */
export interface WContainment {
	readonly from: { readonly relation: string; readonly fields: ReadonlyArray<string> }
	readonly to: { readonly relation: string; readonly fields: ReadonlyArray<string> }
}

/**
 * A projected key, key(on(select(R, (r) => r.eq(r[selector], true)), ...fields)): among the facts of `relation` whose
 * boolean field `selector` is true, at most one per value of `fields`.
 */
export interface WProjectedKey {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly selector: string
}

export interface WGroup {
	readonly index: number
	/**
	 * A group the sketch drew, or the planted group (plantedGroup), whose fixed relations a ChangeSet's planted arm
	 * writes (changeset.ts PlantedArm).
	 */
	readonly role: "drawn" | "planted"
	/** In declaration order: a containment's target precedes its source. */
	readonly relations: ReadonlyArray<WRelation>
	readonly containments: ReadonlyArray<WContainment>
	readonly projectedKeys: ReadonlyArray<WProjectedKey>
}

/**
 * Generated write schemas.
 *
 * A write run installs one generated schema of one to three independent groups of relations and opens it as one Db
 * (run.ts); each of its cases writes the relations of one group. A schema is drawn as a sketch of picks and a swarm
 * (@grizzle/testing/swarm), resolved by a generator that draws only the swarm's thinning, so a shrink of the case's
 * tape shrinks every part of a failing schema and every resolution is a valid schema. Each relation has:
 *
 * - one to four fields named a, b, c and d, so relations of the schema share field names with different types, and two
 *   programs then read back equal statement text over carriers of different column types (the carriers' naming must
 *   keep their result types apart);
 * - its declared primary key, which a pure set makes its whole heading, and at most one candidate key beyond it,
 *   every key over keyable columns (domain.ts) and so representable;
 * - identity columns: one, in the key or in the payload, beside other fields, or every field an identity column (one
 *   or two of them), whose generated addition supplies no field at all. ChangeSets write explicit values through
 *   OVERRIDING SYSTEM VALUE and the sequence advance, or omit them as generated additions;
 * - `mutable(R)` or the pinned immutable default;
 * - at most one containment of some of its fields into the primary key, or a candidate key, of an earlier relation of
 *   its group, a native foreign key. By the compiler's deferral rule it is DEFERRABLE INITIALLY DEFERRED, judged at
 *   COMMIT, when its target has a field outside the referenced key, which every candidate key's target has, and
 *   immediate, judged at every statement, when its target is a pure set;
 * - at most one projected key: of the facts whose boolean field is true, at most one per value of some fields, of the
 *   types of an earlier relation's primary key. It installs as a UNIQUE NULLS DISTINCT over its selected side's law
 *   columns, null where the field is not true, a native law immediate like every key.
 *
 * Beside the drawn groups a schema may hold the planted group (plantedGroup), of fixed relations whose ChangeSet arms
 * (changeset.ts PlantedArm) reach outcomes the drawn population meets too rarely to rely on.
 *
 * The writer is a full role writing every relation, so described members may read any relation of the schema.
 */
export interface WSchema {
	readonly groups: ReadonlyArray<WGroup>
}

export const columnOf = (relation: WRelation, name: string): WColumn => {
	const c = Arr.findFirst(relation.columns, (x) => x.name === name)
	if (Option.isNone(c)) {
		throw new Error(`${relation.name} has no column ${name}`)
	}
	return c.value
}

/** A relation's identity columns, in field order. */
export const serialColumns = (relation: WRelation): ReadonlyArray<WColumn> =>
	Arr.filter(relation.columns, (c) => isSerialKind(c.kind))

export const relationIn = (group: WGroup, name: string): WRelation => {
	const r = Arr.findFirst(group.relations, (x) => x.name === name)
	if (Option.isNone(r)) {
		throw new Error(`group ${group.index} has no relation ${name}`)
	}
	return r.value
}

/**
 * Whether a containment is checked at every statement: its target has no field outside the referenced key, a pure set
 * referenced by its primary key, so the deferral rule keeps the foreign key immediate.
 */
export const isImmediate = (group: WGroup, c: WContainment): boolean =>
	Arr.every(relationIn(group, c.to.relation).columns, (col) => c.to.fields.includes(col.name))

/** Two column lists name one key when they hold the same columns, in any order. */
const sameColumns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	Option.isNone(set(exact)(a, b))

/** Whether a containment references its target's candidate key rather than its primary key. */
export const intoCandidateKey = (group: WGroup, c: WContainment): boolean =>
	!sameColumns(relationIn(group, c.to.relation).primaryKey, c.to.fields)

/** The features a schema's swarm turns on, off or thins, place by place. */
const schemaFeatures = [
	"pureSets",
	"candidateKeys",
	"identities",
	"allIdentities",
	"mutable",
	"references",
	"immediateReferences",
	"projectedKeys",
	"candidateReferences"
] as const
type SchemaFeature = (typeof schemaFeatures)[number]

interface RelationSketch {
	readonly width: number
	readonly kinds: ReadonlyArray<number>
	readonly key: ReadonlyArray<number>
	readonly candidate: ReadonlyArray<number>
	/**
	 * Where the identity column goes and its kind; for a relation of identity columns alone, how many and the second's
	 * kind.
	 */
	readonly serial: {
		readonly at: number
		readonly kind: number
		readonly count: number
		readonly second: number
	}
	readonly target: number
}

interface GroupSketch {
	readonly relations: ReadonlyArray<RelationSketch>
}

export interface SchemaSketch {
	readonly groups: ReadonlyArray<GroupSketch>
	/** Whether the schema holds the planted group beside the drawn ones. */
	readonly planted: boolean
	readonly swarm: Swarm<SchemaFeature>
}

const fourPicks = array(pickGen, { min: 4, max: 4 })

const relationSketchGen: Gen<RelationSketch> = (source) => ({
	width: source.draw(pickGen),
	kinds: source.draw(fourPicks),
	key: source.draw(fourPicks),
	candidate: source.draw(fourPicks),
	serial: {
		at: source.draw(pickGen),
		kind: source.draw(pickGen),
		count: source.draw(pickGen),
		second: source.draw(pickGen)
	},
	target: source.draw(pickGen)
})

const groupSketchGen: Gen<GroupSketch> = (source) => ({
	relations: source.draw(array(relationSketchGen, { min: 1, max: 3 }))
})

export const schemaSketchGen: Gen<SchemaSketch> = (source) => ({
	groups: source.draw(array(groupSketchGen, { min: 1, max: 3 })),
	/** Three schemas in four hold the planted group; a shrink drops it. */
	planted: source.draw(map(int(0, 3), (n) => n > 0)),
	swarm: source.draw(swarmOf(schemaFeatures))
})

const columnNames: Arr.NonEmptyReadonlyArray<string> = ["a", "b", "c", "d"]
const serialKinds: Arr.NonEmptyReadonlyArray<SerialKind> = ["bigserial", "serial"]
const drawnKinds: Arr.NonEmptyReadonlyArray<TypeKind> =
	((): Arr.NonEmptyReadonlyArray<TypeKind> => {
		const [first, ...rest] = typeKinds
		if (first === undefined) {
			throw new Error("the write domain draws no kind")
		}
		return [first, ...rest]
	})()

/** The upper half of a pick: a coin a shrink turns to tails. */
const heads = (pick: number): boolean => pickIndex(pick, 2) === 1

const nonEmptyNames = (names: ReadonlyArray<string>): Arr.NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = names
	if (first === undefined) {
		throw new Error("a relation of no field")
	}
	return [first, ...rest]
}

/** The fields of `names` whose pick is heads, never none and, when `proper`, never all. */
const subsetOf = (
	names: ReadonlyArray<string>,
	picks: ReadonlyArray<number>,
	proper: boolean
): ReadonlyArray<string> => {
	const chosen = Arr.flatMap(names, (name, i) => (heads(picks[i] ?? 0) ? [name] : []))
	if (chosen.length === 0) {
		return [nonEmptyNames(names)[0]]
	}
	return proper && chosen.length === names.length ? chosen.slice(0, -1) : chosen
}

const columnsOf = (
	names: ReadonlyArray<string>,
	kinds: ReadonlyArray<TypeKind>
): ReadonlyArray<WColumn> =>
	Arr.map(names, (name, i) => {
		const kind = kinds[i]
		if (kind === undefined) {
			throw new Error(`no kind for column ${name}`)
		}
		return { name, kind }
	})

/** A relation every field of which is an identity column: one or two of them, the first the key. */
const allIdentities = (name: string, sketch: RelationSketch, isMutable: boolean): WRelation => {
	const names = columnNames.slice(0, 1 + pickIndex(sketch.serial.count, 2))
	return {
		name,
		columns: Arr.map(names, (n, i) => ({
			name: n,
			kind: pickFrom(serialKinds, i === 0 ? sketch.serial.kind : sketch.serial.second)
		})),
		primaryKey: [nonEmptyNames(names)[0]],
		keys: [],
		mutable: isMutable
	}
}

/**
 * A referencing field's kind for a referenced key field of `kind`: an identity column's base integer, which references
 * it exactly (domain.ts referable), and any other kind itself.
 */
const referencingKind = (kind: TypeKind): TypeKind =>
	kind === "serial" ? "int4" : kind === "bigserial" ? "int8" : kind

/**
 * The relation a sketch draws, its first fields of the kinds `leading` states: a referencing source's partners for the
 * key it references, so `referencing` always finds them. A relation with leading fields is never one of identity
 * columns alone, and its identity column goes after them. The swarm's thinned features each take a decision of the
 * case, in the order the resolution meets them.
 *
 * One identity column beside the other fields, in the key or in the payload, after the leading fields.
 */
const resolveRelation =
	(
		name: string,
		sketch: RelationSketch,
		swarm: Swarm<SchemaFeature>,
		leading: ReadonlyArray<TypeKind>
	): Gen<WRelation> =>
	(source) => {
		const kept = (feature: SchemaFeature): boolean => source.draw(keep(swarm, feature))
		const isMutable = kept("mutable")
		if (leading.length === 0 && kept("allIdentities")) {
			return allIdentities(name, sketch, isMutable)
		}
		const width = Math.max(1 + pickIndex(sketch.width, 4), leading.length)
		const names = columnNames.slice(0, width)
		const pure = width === 1 || kept("pureSets")
		const primaryKey = pure ? names : subsetOf(names, sketch.key, true)
		const candidate =
			!pure && kept("candidateKeys") ? subsetOf(names, sketch.candidate, false) : undefined
		const keys =
			candidate !== undefined &&
			!Arr.every(primaryKey, (c) => candidate.includes(c)) &&
			!sameColumns(candidate, primaryKey)
				? [candidate]
				: []
		const keyed = new Set([...primaryKey, ...keys.flat()])
		/** Every key column takes a keyable type. */
		const kinds: Array<TypeKind> = Arr.map(names, (n, i) => {
			const kind =
				i < leading.length
					? elementAt(leading, i, "the leading kinds")
					: pickFrom(drawnKinds, sketch.kinds[i] ?? 0)
			return keyed.has(n) && !typeInfo[kind].keyable ? "int4" : kind
		})
		if (width > Math.max(1, leading.length) && kept("identities")) {
			kinds[leading.length + pickIndex(sketch.serial.at, width - leading.length)] = pickFrom(
				serialKinds,
				sketch.serial.kind
			)
		}
		return { name, columns: columnsOf(names, kinds), primaryKey, keys, mutable: isMutable }
	}

/**
 * The fields of `source` that reference `key`, a key of `target`, position by position, each a field of a referable
 * type used once and no identity column, or undefined when some key field has no such partner.
 */
const referencing = (
	source: WRelation,
	target: WRelation,
	key: ReadonlyArray<string>,
	excluded: ReadonlySet<string>
): ReadonlyArray<string> | undefined => {
	const used = new Set<string>(excluded)
	const fields: Array<string> = []
	for (const pk of key) {
		const want = columnOf(target, pk).kind
		const match = Arr.findFirst(
			source.columns,
			(c) => !used.has(c.name) && !isSerialKind(c.kind) && referable(c.kind, want)
		)
		if (Option.isNone(match)) {
			return undefined
		}
		used.add(match.value.name)
		fields.push(match.value.name)
	}
	return fields
}

/**
 * The group a sketch draws, each thinned feature taking a decision of the case as the resolution meets it. A projected
 * key over a key or a superset of one would be implied by that key.
 */
const resolveGroup =
	(index: number, sketch: GroupSketch, swarm: Swarm<SchemaFeature>): Gen<WGroup> =>
	(source) => {
		const kept = (feature: SchemaFeature): boolean => source.draw(keep(swarm, feature))
		const relations: Array<WRelation> = []
		const containments: Array<WContainment> = []
		const projectedKeys: Array<WProjectedKey> = []
		for (const [i, rs] of sketch.relations.entries()) {
			const name = `G${index}R${i}`
			const [first, ...rest] = relations
			if (first === undefined) {
				relations.push(source.draw(resolveRelation(name, rs, swarm, [])))
				continue
			}
			/**
			 * The target and the key a reference names come first, so a referencing source draws its partners by
			 * construction: the target's candidate key, where it has one and the swarm keeps such references,
			 * else its primary key. A pure set referenced by its primary key is an immediate reference, which fails at
			 * the statement that breaks it: the target is such a set where one precedes and the swarm keeps such
			 * references.
			 */
			const [pure, ...purer] = Arr.filter([first, ...rest], (x) =>
				Arr.every(x.columns, (col) => x.primaryKey.includes(col.name))
			)
			const target =
				pure !== undefined && kept("immediateReferences")
					? pickFrom([pure, ...purer], rs.target)
					: pickFrom([first, ...rest], rs.target)
			const [candidate, ...others] = target.keys
			const referenced =
				candidate !== undefined && kept("candidateReferences")
					? pickFrom([candidate, ...others], rs.target)
					: target.primaryKey
			const immediate = Arr.every(target.columns, (col) => referenced.includes(col.name))
			const references =
				kept("references") && (!immediate || weightOf(swarm, "immediateReferences") > 0)
			const r = source.draw(
				resolveRelation(
					name,
					rs,
					swarm,
					references ? Arr.map(referenced, (f) => referencingKind(columnOf(target, f).kind)) : []
				)
			)
			relations.push(r)
			if (references) {
				const fields = referencing(r, target, referenced, new Set())
				if (fields !== undefined) {
					containments.push({
						from: { relation: r.name, fields },
						to: { relation: target.name, fields: [...referenced] }
					})
				}
			}
			if (kept("projectedKeys")) {
				const selector = Arr.findFirst(r.columns, (c) => c.kind === "bool")
				const fields = Option.flatMap(selector, (s) =>
					Option.fromUndefinedOr(referencing(r, target, target.primaryKey, new Set([s.name])))
				)
				if (
					Option.isSome(selector) &&
					Option.isSome(fields) &&
					!Arr.some([r.primaryKey, ...r.keys], (k) => Arr.every(k, (f) => fields.value.includes(f)))
				) {
					projectedKeys.push({
						relation: r.name,
						fields: fields.value,
						selector: selector.value.name
					})
				}
			}
		}
		return { index, role: "drawn", relations, containments, projectedKeys }
	}

/**
 * The planted group's relations, by the part each plays in a planted arm (changeset.ts PlantedArm), each keyed by its
 * field a:
 * - `parent(a int4, b int4)` and `child(a int4, b int4)`, whose b references the parent's key: the parent's payload
 *   keeps it from being a pure set, so the containment is deferred, and nothing else of the group constrains either
 *   relation, so a ChangeSet that adds or removes a parent and a child fact meets no law but that containment;
 * - `flagged(a int4, b int4, c bool)`, of which at most one fact whose c is true per value of b: a projected key, a
 *   UNIQUE over its selected side;
 * - the mutable `merged(a int4, b int4, c memo)`, whose payload b is a deletion's scope and c an unbounded text, so a
 *   put on it beside a scoped deletion is a MERGE, an enumerated one alone an ON CONFLICT DO UPDATE, and a described
 *   one reading its own keys an UPDATE ... FROM;
 * - `wide(a int4, b text6)` and `narrow(a int4, b text)`, a described member reading the wide text into the narrow one;
 * - `keyed(a int4, b int4)` with the candidate key b, which `referrer(a int4, b int4)` references by its b;
 * - the pure set `pure(a int4)`, which `member(a int4, b int4)` references by its b, an immediate containment;
 * - `serialized(a serial, b int4)`, keyed by its identity column;
 * - `precise(a int4, b numeric(12, 4))` and `rounded(a int4, b numeric(5, 2))`, a described member reading one typmod
 *   into the other;
 * - `numbered(a int4, b serial)`, whose identity column lies outside its key;
 * - the mutable `tallied(a serial, b int4)`, keyed by its identity column, so a described put of its own facts is an
 *   UPDATE ... FROM;
 * - the pure set `issued(a serial)`, every field an identity column, which `holding(a int4, b int4)` references by its
 *   b, an immediate containment.
 */
export interface Planted {
	readonly parent: WRelation
	readonly child: WRelation
	readonly containment: WContainment
	readonly flagged: WRelation
	readonly projectedKey: WProjectedKey
	readonly merged: WRelation
	readonly wide: WRelation
	readonly narrow: WRelation
	readonly keyed: WRelation
	readonly referrer: WRelation
	readonly pure: WRelation
	readonly member: WRelation
	readonly serialized: WRelation
	readonly precise: WRelation
	readonly rounded: WRelation
	readonly numbered: WRelation
	readonly tallied: WRelation
	readonly issued: WRelation
	readonly holding: WRelation
}

const plantedNames = [
	"parent",
	"child",
	"flagged",
	"merged",
	"wide",
	"narrow",
	"keyed",
	"referrer",
	"pure",
	"member",
	"serialized",
	"precise",
	"rounded",
	"numbered",
	"tallied",
	"issued",
	"holding"
] as const
type PlantedName = (typeof plantedNames)[number]

const b = (kind: TypeKind): WColumn => ({ name: "b", kind })

const contained = (from: WRelation, to: WRelation, field: string): WContainment => ({
	from: { relation: from.name, fields: ["b"] },
	to: { relation: to.name, fields: [field] }
})

/** The planted group of index `index` (see Planted), its relations named as a drawn group's are. */
const plantedGroup = (index: number): WGroup => {
	const nameOf = (part: PlantedName): string => `G${index}R${plantedNames.indexOf(part)}`
	/** A relation keyed by a, of int4 unless `key` says otherwise, beside `payload`. */
	const relationOf = (
		part: PlantedName,
		key: TypeKind,
		payload: ReadonlyArray<WColumn>,
		keys: ReadonlyArray<ReadonlyArray<string>>,
		isMutable: boolean
	): WRelation => ({
		name: nameOf(part),
		columns: [{ name: "a", kind: key }, ...payload],
		primaryKey: ["a"],
		keys,
		mutable: isMutable
	})
	const parent = relationOf("parent", "int4", [b("int4")], [], false)
	const child = relationOf("child", "int4", [b("int4")], [], false)
	const flagged = relationOf("flagged", "int4", [b("int4"), { name: "c", kind: "bool" }], [], false)
	const merged = relationOf("merged", "int4", [b("int4"), { name: "c", kind: "memo" }], [], true)
	const keyed = relationOf("keyed", "int4", [b("int4")], [["b"]], false)
	const pure = relationOf("pure", "int4", [], [], false)
	const member = relationOf("member", "int4", [b("int4")], [], false)
	const referrer = relationOf("referrer", "int4", [b("int4")], [], false)
	const issued = relationOf("issued", "serial", [], [], false)
	const holding = relationOf("holding", "int4", [b("int4")], [], false)
	return {
		index,
		role: "planted",
		relations: [
			parent,
			child,
			flagged,
			merged,
			relationOf("wide", "int4", [b("text6")], [], false),
			relationOf("narrow", "int4", [b("text")], [], false),
			keyed,
			referrer,
			pure,
			member,
			relationOf("serialized", "serial", [b("int4")], [], false),
			relationOf("precise", "int4", [b("numeric(12, 4)")], [], false),
			relationOf("rounded", "int4", [b("numeric(5, 2)")], [], false),
			relationOf("numbered", "int4", [b("serial")], [], false),
			relationOf("tallied", "serial", [b("int4")], [], true),
			issued,
			holding
		],
		containments: [
			contained(child, parent, "a"),
			contained(referrer, keyed, "b"),
			contained(member, pure, "a"),
			contained(holding, issued, "a")
		],
		projectedKeys: [{ relation: flagged.name, fields: ["b"], selector: "c" }]
	}
}

/** The parts of the planted group (see Planted). */
export const plantedOf = (group: WGroup): Planted => {
	if (group.role !== "planted") {
		throw new Error(`group ${group.index} is no planted group`)
	}
	const relationAt = (part: PlantedName): WRelation =>
		elementAt(group.relations, plantedNames.indexOf(part), "the planted group's relations")
	return {
		parent: relationAt("parent"),
		child: relationAt("child"),
		containment: elementAt(group.containments, 0, "the planted group's containments"),
		flagged: relationAt("flagged"),
		projectedKey: elementAt(group.projectedKeys, 0, "the planted group's projected key"),
		merged: relationAt("merged"),
		wide: relationAt("wide"),
		narrow: relationAt("narrow"),
		keyed: relationAt("keyed"),
		referrer: relationAt("referrer"),
		pure: relationAt("pure"),
		member: relationAt("member"),
		serialized: relationAt("serialized"),
		precise: relationAt("precise"),
		rounded: relationAt("rounded"),
		numbered: relationAt("numbered"),
		tallied: relationAt("tallied"),
		issued: relationAt("issued"),
		holding: relationAt("holding")
	}
}

/**
 * The schema a sketch draws, the planted group last where it holds one. The sketch's swarm thins its features place by
 * place, each place a decision of the case drawn as the resolution meets it, so a schema is resolved once, where its
 * case is drawn, and handed on resolved.
 */
export const resolveSchema =
	(sketch: SchemaSketch): Gen<WSchema> =>
	(source) => {
		const groups = Arr.map(sketch.groups, (g, i) => source.draw(resolveGroup(i, g, sketch.swarm)))
		return { groups: sketch.planted ? [...groups, plantedGroup(groups.length)] : groups }
	}

/**
 * A generated relation value: its name, fields and key are known only at run time, so its type is the widest the
 * relation constructor gives.
 */
export type WRelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

const rosterOf = () => closed(rosterName, [...rosterHandles])
type WRoster = ReturnType<typeof rosterOf>

const schemaOf = (
	declared: string,
	relations: Readonly<Record<string, WRoster | WRelationValue>>,
	statements: ReadonlyArray<Statement>
) => schema(declared, relations, statements)
/** The schema value of a generated schema, under any declared name. */
export type WSchemaValue = ReturnType<typeof schemaOf>

/**
 * The world a generated schema is written in: the full role `writer`, writing every relation, in its login `server`.
 */
const worldOf = (value: WSchemaValue, written: ReadonlyArray<string>) => {
	const writer = role(value, "writer", value.relations, { write: written })
	return { writer, server: login(value, "server", [writer]) }
}
export type WWorld = ReturnType<typeof worldOf>

/**
 * The public schema value of a generated schema, built by the real constructors. `relations` are
 * the relation values by name, which ChangeSet members name.
 */
export interface BuiltSchema {
	readonly value: WSchemaValue
	readonly relations: Readonly<Record<string, WRelationValue>>
	/**
	 * The same relations and statements declared under another name: an installed schema's own name, so
	 * the ChangeSets built over the relation values are the Db's own.
	 */
	readonly rename: (declared: string) => WSchemaValue
	/** The world over a schema value of this schema, the declared one or a rename. */
	readonly worldOf: (value: WSchemaValue) => WWorld
}

export const buildSchema = (w: WSchema, name: string): BuiltSchema => {
	const roster = rosterOf()
	const relations: Record<string, WRelationValue> = {}
	const statements: Array<Statement> = []
	const all = Arr.flatMap(w.groups, (g) => g.relations)
	const relationValue = (relation: string): WRelationValue => {
		const value = relations[relation]
		if (value === undefined) {
			throw new Error(`no relation value ${relation}`)
		}
		return value
	}
	for (const r of all) {
		const fields: Record<string, FieldBase> = {}
		for (const c of r.columns) {
			fields[c.name] = fieldOf(c.kind, roster)
		}
		relations[r.name] = declareRelation(
			r.name,
			fields,
			nonEmpty(r.primaryKey, `${r.name}'s primary key`)
		)
	}
	for (const r of all) {
		const value = relationValue(r.name)
		for (const k of r.keys) {
			statements.push(
				keyStatement(on(value, ...nonEmptyArgumentsOf(nonEmpty(k, `a key of ${r.name}`))))
			)
		}
		if (r.mutable) {
			statements.push(mutable(value))
		}
	}
	for (const g of w.groups) {
		for (const c of g.containments) {
			statements.push(
				containment(
					on(
						relationValue(c.from.relation),
						...nonEmptyArgumentsOf(nonEmpty(c.from.fields, `a containment from ${c.from.relation}`))
					),
					on(
						relationValue(c.to.relation),
						...nonEmptyArgumentsOf(nonEmpty(c.to.fields, `a containment into ${c.to.relation}`))
					)
				)
			)
		}
		for (const k of g.projectedKeys) {
			statements.push(
				keyStatement(
					on(
						select(relationValue(k.relation), (row) => selectorOf(row, [[k.selector, true]])),
						...nonEmptyArgumentsOf(nonEmpty(k.fields, `a projected key of ${k.relation}`))
					)
				)
			)
		}
	}
	const declaredRelations: Record<string, WRoster | WRelationValue> = {
		[rosterName]: roster,
		...relations
	}
	const rename = (declared: string): WSchemaValue =>
		schemaOf(declared, declaredRelations, statements)
	const written = Arr.map(all, (r) => r.name)
	return { value: rename(name), relations, rename, worldOf: (value) => worldOf(value, written) }
}

/**
 * The law each key, foreign key and projected key of an installed write schema reports, read from its installation,
 * and the installed objects a statement names.
 */
export interface WriteLawNames {
	readonly primaryKey: (relation: string) => LawId
	readonly key: (relation: string, fields: ReadonlyArray<string>) => LawId
	readonly foreignKey: (relation: string, fields: ReadonlyArray<string>) => LawId
	/**
	 * The installed constraint of the relation's primary key, of its candidate key over `fields`, and of its foreign key
	 * over `fields`: what a direct writer's violation names beside the table.
	 */
	readonly primaryKeyConstraint: (relation: string) => ConstraintName
	readonly keyConstraint: (relation: string, fields: ReadonlyArray<string>) => ConstraintName
	readonly foreignKeyConstraint: (relation: string, fields: ReadonlyArray<string>) => ConstraintName
	/** The law of a projected key over `relation`'s `fields`, and its UNIQUE over its law columns. */
	readonly projectedKey: (
		relation: string,
		fields: ReadonlyArray<string>
	) => { readonly law: LawId; readonly constraint: ConstraintName }
	/**
	 * The law of the text refinement domain that types a column (kernel/naming.ts textDomain), which a value outside
	 * the domain violates.
	 */
	readonly textDomain: (relation: string, field: string) => LawId
	/** The installed table of a relation, as schema-qualified quoted SQL. */
	readonly table: (relation: string) => string
	/** The identity sequence of a serial column, as schema-qualified quoted SQL. */
	readonly sequence: (relation: string, field: string) => string
	readonly column: (relation: string, field: string) => string
}

const quote = (ident: string): string => `"${Str.replaceAll('"', '""')(ident)}"`

const qualified = (name: ObjectName): string => `${quote(name.schema)}.${quote(name.name)}`

export const lawNames = (plan: RealInstallPlan): WriteLawNames => {
	const tableOf = (relation: string) => {
		const t = plan.tables[relation]
		if (t === undefined) {
			throw new Error(`no installed table for ${relation}`)
		}
		return t
	}
	const laws = plan.installation.laws
	/** The law an installed constraint or unique index of the relation's table reports. */
	const lawOf = (relation: string, constraint: ConstraintName): LawId => {
		const owned = plan.installation.owned.relations[relation]
		if (owned === undefined) {
			throw new Error(`no owned relation ${relation}`)
		}
		const owner = { kind: "table", name: owned.ident } as const
		const law = constraintLaw(laws.constraintToLaw, owner, constraint)
		if (law === undefined) {
			throw new Error(`no law reports the installed constraint ${constraint} of ${relation}`)
		}
		return law
	}
	/** The constraint of the relation's primary key, or of its candidate key over `fields` (as a set). */
	const keyConstraint = (
		relation: string,
		key: { readonly primary: true } | { readonly fields: ReadonlyArray<string> }
	) => {
		const k = Option.getOrUndefined(
			Arr.findFirst(plan.installation.owned.relations[relation]?.keys ?? [], (x) =>
				"primary" in key ? x.primary : !x.primary && sameColumns(x.fields, key.fields)
			)
		)
		if (k === undefined) {
			throw new Error(
				`no installed ${"primary" in key ? "primary key" : `key (${Arr.join(key.fields, ", ")})`} of ${relation}`
			)
		}
		return k.constraint
	}
	/** The constraint of the relation's foreign key over `fields` (as a set), a PERIOD one's span among them. */
	const foreignKeyConstraint = (
		relation: string,
		fields: ReadonlyArray<string>
	): ConstraintName => {
		for (const n of laws.natives) {
			const o = n.object
			if (n.namespace !== "constraint") {
				continue
			}
			if (o.kind !== "ForeignKey" && o.kind !== "PeriodForeignKey") {
				continue
			}
			const fk = foreignKeyColumns(o)
			if (fk.relation === relation && sameColumns(fk.columns, fields)) {
				return identifierOf(n.named)
			}
		}
		throw new Error(`no installed foreign key ${relation}(${Arr.join(fields, ", ")})`)
	}
	return {
		primaryKey: (relation) => lawOf(relation, keyConstraint(relation, { primary: true })),
		key: (relation, fields) => lawOf(relation, keyConstraint(relation, { fields })),
		foreignKey: (relation, fields) => lawOf(relation, foreignKeyConstraint(relation, fields)),
		primaryKeyConstraint: (relation) => keyConstraint(relation, { primary: true }),
		keyConstraint: (relation, fields) => keyConstraint(relation, { fields }),
		foreignKeyConstraint,
		/**
		 * A relation's one projected key, as the sketch draws at most one per relation: the UNIQUE of its selected
		 * side, over a law column per field, where a declared key's are fields.
		 */
		projectedKey: (relation, fields) => {
			for (const n of laws.natives) {
				const o = n.object
				if (
					n.namespace !== "constraint" ||
					o.kind !== "Unique" ||
					o.relation.name !== relation ||
					o.columns.length !== fields.length ||
					!Arr.every(o.columns, (c) => c.kind === "law")
				) {
					continue
				}
				return { law: lawOf(relation, identifierOf(n.named)), constraint: identifierOf(n.named) }
			}
			throw new Error(`no installed projected key ${relation}(${Arr.join(fields, ", ")})`)
		},
		textDomain: (relation, field) =>
			installationNamesOf(plan.installation).textDomain({ name: relation }, field).law,
		table: (relation) => {
			const n = tableOf(relation).name
			return qualified(n)
		},
		sequence: (relation, field) => {
			const c = Arr.findFirst(tableOf(relation).columns, (x) => x.field === field)
			if (Option.isNone(c) || c.value.sequence.kind === "none") {
				throw new Error(`${relation}.${field} has no identity sequence`)
			}
			return qualified(c.value.sequence.name)
		},
		column: (relation, field) => {
			const c = Arr.findFirst(tableOf(relation).columns, (x) => x.field === field)
			if (Option.isNone(c)) {
				throw new Error(`${relation} has no column ${field}`)
			}
			return quote(c.value.column)
		}
	}
}

/**
 * A group as the add-wins calculator reads it (test/support/oracle/addwins.ts): each relation's heading as carrier
 * specs, its keys and its projected keys under their laws' names, and its serial fields.
 */
export const oracleSchemaOf = (group: WGroup, laws: WriteLawNames): OracleSchema => ({
	relations: Arr.map(group.relations, (r): OracleRelation => ({
		name: r.name,
		heading: Arr.map(r.columns, (c) => ({ name: c.name, spec: typeInfo[c.kind].spec })),
		primaryKey: { law: laws.primaryKey(r.name), fields: [...r.primaryKey] },
		keys: Arr.map(r.keys, (k) => ({ law: laws.key(r.name, k), fields: [...k] })),
		projectedKeys: Arr.map(
			Arr.filter(group.projectedKeys, (k) => k.relation === r.name),
			(k) => ({
				law: laws.projectedKey(r.name, k.fields).law,
				fields: [...k.fields],
				where: { field: k.selector, value: true }
			})
		),
		serial: Arr.map(serialColumns(r), (c) => c.name)
	}))
})

/** A printable form of a group, for failure reports. */
export const printGroup = (group: WGroup): string =>
	Arr.join(
		[
			`${group.role === "planted" ? "planted group" : "group"} ${group.index}:`,
			...Arr.map(
				group.relations,
				(r) =>
					`  ${r.mutable ? "mutable " : ""}${r.name}(${Arr.join(
						Arr.map(r.columns, (c) => `${c.name}: ${c.kind}`),
						", "
					)}) key [${Arr.join(r.primaryKey, ", ")}]${Arr.join(
						Arr.map(r.keys, (k) => ` key(${Arr.join(k, ", ")})`),
						""
					)}`
			),
			...Arr.map(
				group.containments,
				(c) =>
					`  contained(${c.from.relation}(${Arr.join(c.from.fields, ", ")}), ${c.to.relation}(${Arr.join(c.to.fields, ", ")}))${isImmediate(group, c) ? " immediate" : ""}`
			),
			...Arr.map(
				group.projectedKeys,
				(k) => `  key(on(select(${k.relation}, ${k.selector}), ${Arr.join(k.fields, ", ")}))`
			)
		],
		"\n"
	)

export const printSchema = (s: WSchema): string => Arr.join(Arr.map(s.groups, printGroup), "\n")
