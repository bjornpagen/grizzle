import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, type Gen, int, map } from "@bjornpagen/testing/gen"
import { exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { keep, type Swarm, swarm as swarmOf, weightOf } from "@bjornpagen/testing/swarm"
import { Array as Arr, Option, Record as Rec } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { constraintLawMap } from "#compiler/laws/model/model.ts"
import {
	closed,
	contained as containment,
	key as keyStatement,
	login,
	on,
	type Relation,
	role,
	type Statement,
	schema,
	select,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { foreignKeyColumns, installationNamesOf } from "#test/support/kernel/naming.ts"
import { nonEmptyArgumentsOf } from "#test/support/list.ts"
import { opened } from "#test/support/open.ts"
import type { OracleRelation, OracleSchema } from "#test/support/oracle/addwins.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import {
	fieldOf,
	referable,
	rosterHandles,
	rosterName,
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
 * (@bjornpagen/testing/swarm), resolved by a generator that draws only the swarm's thinning, so a shrink of the case's
 * tape shrinks every part of a failing schema and every resolution is a valid schema. Each relation has:
 *
 * - one to four fields named a, b, c and d, so relations of the schema share field names with different types, and two
 *   programs then read back equal statement text over carriers of different column types (the carriers' naming must
 *   keep their result types apart);
 * - its declared primary key, which a pure set makes its whole heading, and at most one candidate key beyond it,
 *   every key over keyable columns (domain.ts) and so representable;
 * - open, `mutable(R)` in the unit over its primary key's first field (test/support/open.ts opened), which a ChangeSet
 *   may put and delete, or closed, the default, which a ChangeSet only inserts into (changeset.ts memberOps);
 * - at most one containment of some of its fields into the primary key, or a candidate key, of an earlier relation of
 *   its group. Into a pure set it is a foreign key immediate by the compiler's deferral rule, judged at every
 *   statement; into a target with a field outside the referenced key, which every candidate key's target has, it is
 *   judged at COMMIT, by a foreign key DEFERRABLE INITIALLY DEFERRED, or by the rule judge where both relations are
 *   immutable and the containment joins within one unit (laws/model/plan.ts containmentDischarge): the same law either
 *   way, refused at COMMIT under the name of whichever holds it;
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
	Option.isNone(set(structuralHash, exact)(a, b))

/** Whether a containment references its target's candidate key rather than its primary key. */
export const intoCandidateKey = (group: WGroup, c: WContainment): boolean =>
	!sameColumns(relationIn(group, c.to.relation).primaryKey, c.to.fields)

/** The features a schema's swarm turns on, off or thins, place by place. */
const schemaFeatures = [
	"pureSets",
	"candidateKeys",
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

/**
 * The relation a sketch draws, its first fields of the kinds `leading` states: a referencing source's partners for the
 * key it references, so `referencing` always finds them. The swarm's thinned features each take a decision of the
 * case, in the order the resolution meets them.
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
		return { name, columns: columnsOf(names, kinds), primaryKey, keys, mutable: isMutable }
	}

/**
 * The fields of `source` that reference `key`, a key of `target`, position by position, each a field of a referable
 * type used once, or undefined when some key field has no such partner.
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
		const match = Arr.findFirst(source.columns, (c) => !used.has(c.name) && referable(c.kind, want))
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
					references ? Arr.map(referenced, (f) => columnOf(target, f).kind) : []
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
 * - `merged(a int4, b int4, c memo)`, whose payload b is a deletion's scope and c an unbounded text, so a
 *   put on it beside a scoped deletion is a MERGE, an enumerated one alone an ON CONFLICT DO UPDATE, and a described
 *   one reading its own keys an UPDATE ... FROM;
 * - `wide(a int4, b text6)` and `narrow(a int4, b text, c text)`, a described member reading the wide text into both
 *   narrow fields, which the narrow text's one domain types;
 * - `keyed(a int4, b int4)` with the candidate key b, which `referrer(a int4, b int4)` references by its b;
 * - the pure set `pure(a int4)`, which `member(a int4, b int4)` references by its b, an immediate containment;
 * - `precise(a int4, b numeric(12, 4))` and `rounded(a int4, b numeric(5, 2))`, a described member reading one typmod
 *   into the other;
 * - the pure set `marked(a int4, c bool)`, of which at most one fact whose c is true per value of a, a projected key, so
 *   its facts meet at a unique object besides its key, which `marker(a int4, b int4, c bool)` references by its b and
 *   c, an immediate containment.
 *
 * The relations a planted arm puts or deletes are open, in the unit over their key a (parent, child, merged, narrow,
 * keyed, pure, member, marked, marker); the rest, which the arms only insert into, are closed.
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
	readonly precise: WRelation
	readonly rounded: WRelation
	readonly marked: WRelation
	readonly marker: WRelation
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
	"precise",
	"rounded",
	"marked",
	"marker"
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
	const parent = relationOf("parent", "int4", [b("int4")], [], true)
	const child = relationOf("child", "int4", [b("int4")], [], true)
	const flagged = relationOf("flagged", "int4", [b("int4"), { name: "c", kind: "bool" }], [], false)
	const merged = relationOf("merged", "int4", [b("int4"), { name: "c", kind: "memo" }], [], true)
	const keyed = relationOf("keyed", "int4", [b("int4")], [["b"]], true)
	const pure = relationOf("pure", "int4", [], [], true)
	const member = relationOf("member", "int4", [b("int4")], [], true)
	const referrer = relationOf("referrer", "int4", [b("int4")], [], false)
	const marked: WRelation = {
		name: nameOf("marked"),
		columns: [
			{ name: "a", kind: "int4" },
			{ name: "c", kind: "bool" }
		],
		primaryKey: ["a", "c"],
		keys: [],
		mutable: true
	}
	const marker = relationOf("marker", "int4", [b("int4"), { name: "c", kind: "bool" }], [], true)
	return {
		index,
		role: "planted",
		relations: [
			parent,
			child,
			flagged,
			merged,
			relationOf("wide", "int4", [b("text6")], [], false),
			relationOf("narrow", "int4", [b("text"), { name: "c", kind: "text" }], [], true),
			keyed,
			referrer,
			pure,
			member,
			relationOf("precise", "int4", [b("numeric(12, 4)")], [], false),
			relationOf("rounded", "int4", [b("numeric(5, 2)")], [], false),
			marked,
			marker
		],
		containments: [
			contained(child, parent, "a"),
			contained(referrer, keyed, "b"),
			contained(member, pure, "a"),
			{
				from: { relation: marker.name, fields: ["b", "c"] },
				to: { relation: marked.name, fields: ["a", "c"] }
			}
		],
		projectedKeys: [
			{ relation: flagged.name, fields: ["b"], selector: "c" },
			{ relation: marked.name, fields: ["a"], selector: "c" }
		]
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
		precise: relationAt("precise"),
		rounded: relationAt("rounded"),
		marked: relationAt("marked"),
		marker: relationAt("marker")
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

const rosterOf = () => closed.ordered(rosterName, [...rosterHandles])
type WRoster = ReturnType<typeof rosterOf>

const schemaOf = (
	declared: string,
	relations: Readonly<Record<string, WRoster | WRelationValue>>,
	statements: ReadonlyArray<Statement>
) => schema(declared, Rec.values(relations), statements)
/** The schema value of a generated schema, under any declared name. */
export type WSchemaValue = ReturnType<typeof schemaOf>

/**
 * The world a generated schema is written in: the full role `writer`, writing every relation, in its login `server`.
 */
const worldOf = (value: WSchemaValue) => {
	const writer = role(value, "writer", wholeEntriesOf(value), wholeWritesOf(value))
	return { writer, server: login(value, "server", [writer]) }
}
export type WWorld = ReturnType<typeof worldOf>

/**
 * The public schema value of a generated schema, built by the real constructors. `relations` are
 * the relation values by name, which ChangeSet members name.
 */
export interface WBuiltSchema {
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

export const buildWSchema = (w: WSchema, name: string): WBuiltSchema => {
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
		relations[r.name] = relationBuilder(
			r.name,
			fields,
			nonEmpty(r.primaryKey, `${r.name}'s primary key`),
			[]
		)
	}
	for (const r of all) {
		const value = relationValue(r.name)
		for (const k of r.keys) {
			statements.push(
				keyStatement(on(value, ...nonEmptyArgumentsOf(nonEmpty(k, `a key of ${r.name}`))))
			)
		}
	}
	appendAll(statements, opened(Arr.flatMap(all, (r) => (r.mutable ? [relationValue(r.name)] : []))))
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
	return { value: rename(name), relations, rename, worldOf }
}

/**
 * The law each key, foreign key and projected key of an installed write schema reports, read from its installation,
 * and the installed objects a statement names.
 */
export interface WriteLawNames {
	readonly primaryKey: (relation: string) => LawId
	readonly key: (relation: string, fields: ReadonlyArray<string>) => LawId
	/** The law of the relation's containment from `fields`, the theory's whatever discharges it. */
	readonly containment: (relation: string, fields: ReadonlyArray<string>) => LawId
	/**
	 * The installed constraint of the relation's primary key, of its candidate key over `fields`, and the name a
	 * refusal of its containment from `fields` carries, its foreign key's or, judged whole, its rule's: what a direct
	 * writer's violation names beside the table.
	 */
	readonly primaryKeyConstraint: (relation: string) => ConstraintName
	readonly keyConstraint: (relation: string, fields: ReadonlyArray<string>) => ConstraintName
	readonly containmentConstraint: (
		relation: string,
		fields: ReadonlyArray<string>
	) => ConstraintName
	/** The law of a projected key over `relation`'s `fields`, and its UNIQUE over its law columns. */
	readonly projectedKey: (
		relation: string,
		fields: ReadonlyArray<string>
	) => { readonly law: LawId; readonly constraint: ConstraintName }
	/**
	 * A stored field's pattern law (kernel/naming.ts patternLaw), which a value outside its column's text refinement
	 * domain violates: the field's own, whatever other fields the domain types.
	 */
	readonly patternLaw: (relation: string, field: string) => LawId
	/** The installed table of a relation, as schema-qualified quoted SQL. */
	readonly table: (relation: string) => string
	readonly column: (relation: string, field: string) => string
}

const qualified = (name: ObjectName): string =>
	`${quoteIdent(name.schema)}.${quoteIdent(name.name)}`

export const lawNames = (plan: RealInstallPlan): WriteLawNames => {
	const tableOf = (relation: string) => {
		const t = plan.tables[relation]
		if (t === undefined) {
			throw new Error(`no installed table for ${relation}`)
		}
		return t
	}
	const laws = plan.installation.laws
	const toLaw = constraintLawMap(laws.constraints)
	/**
	 * The key law of the relation that an installed key constraint or unique index of its table holds: among every law the
	 * constraint serves (a family member's primary key serves the family's law beside the key's), the one key of the
	 * relation.
	 */
	const keyLawOf = (relation: string, constraint: ConstraintName): LawId => {
		const owned = plan.installation.owned.relations[relation]
		if (owned?.kind !== "relation") {
			throw new Error(`no owned stored relation ${relation}`)
		}
		const served = lawsOfConstraint(toLaw, { kind: "table", name: owned.ident }, constraint) ?? []
		const keys = Arr.filter(served, (id) =>
			Arr.some(
				laws.theory.laws,
				(l) => l.id === id && l.detail.kind === "key" && l.detail.relation === relation
			)
		)
		const [key, ...more] = keys
		if (key === undefined || more.length > 0) {
			throw new Error(
				`the installed constraint ${constraint} of ${relation} serves ${keys.length} key laws of it among ${Arr.join(served, ", ")}`
			)
		}
		return key
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
	/** The theory's law of the relation's containment from `fields` (as a set), of every fact of either side. */
	const containment = (relation: string, fields: ReadonlyArray<string>): LawId => {
		for (const law of laws.theory.laws) {
			const d = law.detail
			if (
				d.kind === "containment" &&
				d.from.relation === relation &&
				d.from.selection.conjuncts.length === 0 &&
				sameColumns(
					Arr.flatMap(d.from.terms, (t) => (t.kind === "field" ? [t.column.name] : [])),
					fields
				)
			) {
				return law.id
			}
		}
		throw new Error(`no containment law of ${relation}(${Arr.join(fields, ", ")})`)
	}
	/** The name a refusal of the containment carries: its foreign key's constraint where a native holds it, a PERIOD
	 * one's among them, and its rule's where the judge holds it whole. */
	const containmentConstraint = (
		relation: string,
		fields: ReadonlyArray<string>
	): ConstraintName => {
		const law = containment(relation, fields)
		for (const n of laws.natives) {
			const o = n.object
			if (
				n.namespace === "constraint" &&
				(o.kind === "ForeignKey" || o.kind === "PeriodForeignKey") &&
				o.lawIds.includes(law) &&
				foreignKeyColumns(o).relation === relation
			) {
				return identifierOf(n.named)
			}
		}
		for (const r of laws.rules) {
			if (r.law.id === law) {
				return identifierOf(r.named)
			}
		}
		throw new Error(
			`no installed object holds the containment ${relation}(${Arr.join(fields, ", ")})`
		)
	}
	return {
		primaryKey: (relation) => keyLawOf(relation, keyConstraint(relation, { primary: true })),
		key: (relation, fields) => keyLawOf(relation, keyConstraint(relation, { fields })),
		containment,
		primaryKeyConstraint: (relation) => keyConstraint(relation, { primary: true }),
		keyConstraint: (relation, fields) => keyConstraint(relation, { fields }),
		containmentConstraint,
		/**
		 * A relation's one projected key, as the sketch draws at most one per relation: the theory's key over its
		 * selected side's fields, and the UNIQUE the law model installs for that law, however the side lowers its terms
		 * (laws/model/plan.ts sideColumns).
		 */
		projectedKey: (relation, fields) => {
			for (const law of laws.theory.laws) {
				const d = law.detail
				if (
					d.kind !== "projectedKey" ||
					d.side.relation !== relation ||
					!sameColumns(
						Arr.flatMap(d.side.terms, (t) => (t.kind === "field" ? [t.column.name] : [])),
						fields
					)
				) {
					continue
				}
				for (const n of laws.natives) {
					const o = n.object
					if (n.namespace === "constraint" && o.kind === "Unique" && o.lawIds.includes(law.id)) {
						return { law: law.id, constraint: identifierOf(n.named) }
					}
				}
			}
			throw new Error(`no installed projected key ${relation}(${Arr.join(fields, ", ")})`)
		},
		patternLaw: (relation, field) =>
			installationNamesOf(plan.installation).patternLaw({ name: relation }, field),
		table: (relation) => {
			const n = tableOf(relation).name
			return qualified(n)
		},
		column: (relation, field) => {
			const c = Arr.findFirst(tableOf(relation).columns, (x) => x.field === field)
			if (Option.isNone(c)) {
				throw new Error(`${relation} has no column ${field}`)
			}
			return quoteIdent(c.value.column)
		}
	}
}

/**
 * A group as the add-wins calculator reads it (test/support/oracle/addwins.ts): each relation's heading as carrier
 * specs, its keys and its projected keys under their laws' names.
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
		)
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
