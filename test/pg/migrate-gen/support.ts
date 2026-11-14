import { array, boolean, constant, element, type Gen, int, map } from "@grizzle/testing/gen"
import { type Swarm, swarm, swarmChoice, weightOf } from "@grizzle/testing/swarm"
import {
	Array as Arr,
	Equal,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import {
	conversionOf as converts,
	identity,
	maxIdentifierBytes,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import {
	admitLoginRoles,
	decodeRoleOver,
	everyFact,
	type FieldDecl,
	type FieldDesc,
	type LiteralDesc,
	type LoginDesc,
	type RoleEntryDesc,
	type SchemaDesc,
	type SideDesc
} from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	contractOf,
	type IntegerCarrier,
	rosterOf,
	type ScalarType,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { noParamTypes, noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import {
	type InstallExtension,
	noCarriers,
	noCertificates,
	noFences,
	noHolds,
	servesNoParams
} from "#compiler/physical/install/extension.ts"
import {
	type StatisticsRequest,
	statisticsKinds
} from "#compiler/physical/statistics/statistics.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import type { ColumnDef } from "#compiler/sql/ast.ts"
import { types as sqlTypes } from "#compiler/sql/build.ts"
import { printType, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import type {
	SchemaDesc as AuthoredSchemaDesc,
	AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	admittedByFeature,
	catalogConversions,
	catalogTypeNames
} from "#test/support/kernel/dict.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import {
	fieldDescOf,
	int4,
	int8,
	keyFieldType,
	typedLiteralDesc,
	resolveValue,
	literalRowKey,
	type Spelling,
	scalarOfSpec
} from "#test/support/oracle/gen/domain.ts"

import {
	type FactsSketch,
	factsSketchGen,
	factValues,
	type LiteralRow,
	resolveFacts,
	type ValueFacts
} from "#test/support/oracle/gen/facts.ts"

import { noLive } from "#compiler/live/notify.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	allKeys,
	closedIdType,
	containmentFrom,
	defaultSchemaLimits,
	fullDataSwarm,
	type GenClosed,
	type GenContainment,
	type GenRelation,
	type GenSchema,
	keyIndices,
	resolveSchema,
	type SchemaLimits,
	type SchemaSketch,
	schemaDesc,
	schemaName,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { inputText } from "#test/support/oracle/runner.ts"
import { pickGen, pickIndex, pickOf } from "#test/support/pick.ts"
import { upTo } from "#test/support/up-to.ts"

/** The kinds a path may draw, each a swarm feature: the edits a successor applies to its predecessor's sketch, the
 * edits of its extras, and the renames a renamed path makes.
 *
 * Generated migration paths: a random schema A, its successor B and B's successor C, each an oracle schema
 * (, read only here), with A's facts; the decisions of a reviewer who chooses the path's own
 * renames (the reviewing itself is); and the model of the facts a migration carries.
 *
 * A successor is A's sketch with a few edits, so B stays close to A and the draft exercises the migration rules
 * rather than a wholesale replacement: a field added, removed or retyped, the primary key or the candidate keys
 * changed, `mutable` declared or removed, a containment added or removed, a relation added or removed, a closed
 * handle added, a closed payload replaced, a closed roster added, which moves every palette type and so retypes
 * many fields at once, a relation the predecessor removed declared again, created afresh, a candidate key promoted
 * to the primary key with the next relation's containment into it, and a relation given back A's declaration of it,
 * which declares again the fields an earlier edit removed, with their keys and containment. Beside the oracle schema each
 * version carries what the oracle schema has no form for, each by pick into its relations and fields so renames carry
 * it along: bound checks on integer fields (a law family a successor adds to, changes and removes), extended
 * statistics over two fields (a workload of synthetic requests, which grizzle installs as it does a program's), a field
 * `sq` that is a serial, a bigserial, a pg.uuidv7 or a uuid its caller writes (a successor adds, removes or retypes it,
 * which converts an integer serial to a uuidv7 and back, and declares a uuid's draw and removes it), existing integer fields declared
 * serial (an identity added to a column that holds rows, or removed), and relations the role `reader` does not hold
 * (a successor drops or adds them, its view going or coming). Every sketch resolves to a valid schema, and so does every edited one.
 *
 * A renamed path (renamedDrawGen) also makes a few renames in B, and maybe in C, as a user renames: relations and
 * fields, a field of a key a containment references, a field with its type changed, a relation with the type of one of
 * its fields changed (which, with the key edits, also renames relations whose primary key changes), two names swapped, a closed
 * roster, a relation renamed to the name a roster renamed away had (a hop across kinds, whose PostgreSQL type names
 * collide), a name renamed to another spelling of it that converts to the same identifier (an alias, which drafts no
 * statement), a name renamed to a name of the identifier dictionary (identifiers longer
 * than 63 bytes that differ after byte 54, digit boundaries, reserved words), a relation or a closed roster renamed to
 * the name of a PostgreSQL type or function (its row type or enum then a type of that name), and, in C, a name renamed to the name of
 * one B removed, which B's migration dropped; each name maybe renamed twice or back. It may also reorder a closed roster's handles or
 * remove its last one, which the draft rebuilds the enum for, a removed handle mapped by the reviewer to the new roster's
 * first, or rename one of its handles in place, which the reviewer confirms. Where the draft offers a candidate rename
 * for a rename the path made, a reviewer who chooses chooses it.
 *
 * Which edits, extras and renames a path draws is a swarm: each path turns some kinds
 * off, so paths with few kinds are drawn as often as paths with most, each change draws its kind among those the swarm
 * left on, as often as its weight, and every pick into what is there is a pick over 0..0xffff, without modulo skew.
 *
 * The facts a migration carries, as the drafted rules say: a relation of both A and B keeps each of its rows; a field
 * both declare with one type keeps its value, a closed handle B's roster removed taking the roster's first; a field B
 * adds, or retypes, holds the reviewer's value, here the typed default of its B type; a field B removes is dropped and
 * leaves B's heading; a chosen rename, or a rename to
 * an alias, carries the relation's rows or the field's values under the new name. A relation only B declares starts
 * empty. Rows whose carried form would break a law of B fail the migration's validation, which is a reviewed data
 * step, so the model loads into A only the facts whose carried forms are lawful in B, and the rows of A they need: the
 * result is a fixpoint of removals. */
const editKinds = [
	"addColumn",
	"dropColumn",
	"retype",
	"primaryKey",
	"candidateKeys",
	"mutable",
	"containment",
	"addRelation",
	"dropRelation",
	"addHandle",
	"payload",
	"addClosed",
	"revive",
	"promoteKey",
	"restore"
] as const
type EditKind = (typeof editKinds)[number]

const extraKinds = [
	"addCheck",
	"changeCheck",
	"removeChecks",
	"addStatistics",
	"dropStatistics",
	"addSerial",
	"dropSerial",
	"retypeSerial",
	"addIdentity",
	"dropIdentity",
	"toggleRead",
	"addCoded"
] as const
type ExtraKind = (typeof extraKinds)[number]

const renameKinds = [
	"relation",
	"column",
	"retyped",
	"relationRetyped",
	"swapRelations",
	"swapColumns",
	"closed",
	"hop",
	"alias",
	"dictionary",
	"catalog",
	"ontoRemoved",
	"removeHandle"
] as const
type RenameKind = (typeof renameKinds)[number]

export type PathKind = EditKind | ExtraKind | RenameKind
const pathKinds = [...editKinds, ...extraKinds, ...renameKinds] as const

/** The picks one edit, extra edit or rename resolves against what is there: picks over 0..0xffff into lists, a mask of
 * columns, masks of candidate keys and a flag. */
interface Picks {
	readonly first: number
	readonly second: number
	readonly third: number
	readonly mask: number
	readonly masks: ReadonlyArray<number>
	readonly flag: boolean
}

const picksGen: Gen<Picks> = (source) => ({
	first: source.draw(pickGen),
	second: source.draw(pickGen),
	third: source.draw(pickGen),
	mask: source.draw(int(0, 31)),
	masks: source.draw(array(int(0, 31), { min: 0, max: 2 })),
	flag: source.draw(boolean)
})

/** One drawn change: its kind, which the path's swarm chose, and its picks. */
interface Change<K> {
	readonly kind: K
	readonly picks: Picks
}

type Edit = Change<EditKind>
type ExtraEdit = Change<ExtraKind>
type RenameEdit = Change<RenameKind>

/** One change whose kind the path's swarm chooses among `kinds`, each as often as its weight, and the first when the
 * swarm turns every one off. */
const changeGen =
	<K extends PathKind>(
		drawn: Swarm<PathKind>,
		kinds: readonly [K, ...ReadonlyArray<K>]
	): Gen<Change<K>> =>
	(source) => ({ kind: source.draw(swarmChoice(drawn, kinds)), picks: source.draw(picksGen) })

/** The item a pick selects, or undefined in an empty list. */
const at = <A>(xs: ReadonlyArray<A>, pick: number): A | undefined =>
	xs.length === 0 ? undefined : xs[pickIndex(pick, xs.length)]

/** The index a pick selects in a list of `n`, which must hold one. */
const indexIn = (pick: number, n: number): number => pickIndex(pick, Math.max(1, n))

/** The palette picks a column draws from: the oracle generator reads a column's number as a palette pick. */
const palettePicks = 8

type RelationSketch = SchemaSketch["relations"][number]
type ClosedSketch = SchemaSketch["closed"][number]

/** A mask with bit `bit` removed and the bits above it moved down, so a key keeps naming the same columns once one
 * before them is removed. */
const withoutBit = (mask: number, bit: number): number =>
	(mask & ((1 << bit) - 1)) | ((mask >> (bit + 1)) << bit)

/** The most handles a roster grows to. */
const maxHandles = 4

const applyEdit = (
	sketch: SchemaSketch,
	donor: SchemaSketch,
	first: SchemaSketch,
	limits: SchemaLimits,
	{ kind, picks }: Edit
): SchemaSketch => {
	const relations = [...sketch.relations]
	const closed = [...sketch.closed]
	const n = relations.length
	const replace = (f: (r: RelationSketch) => RelationSketch): SchemaSketch => {
		if (n === 0) {
			return sketch
		}
		const i = indexIn(picks.first, n)
		const r = relations[i]
		if (r === undefined) {
			return sketch
		}
		relations[i] = f(r)
		return { ...sketch, relations }
	}
	switch (kind) {
		case "addColumn":
			return replace((r) =>
				r.columns.length >= limits.maxColumns
					? r
					: { ...r, columns: [...r.columns, pickIndex(picks.second, palettePicks)] }
			)
		case "dropColumn":
			return replace((r) => {
				if (r.columns.length <= 1) {
					return r
				}
				const bit = indexIn(picks.second, r.columns.length)
				return {
					...r,
					columns: Arr.remove(r.columns, bit),
					pkMask: withoutBit(r.pkMask, bit),
					keyMasks: Arr.map(r.keyMasks, (m) => withoutBit(m, bit))
				}
			})
		case "retype":
			return replace((r) => {
				const column = indexIn(picks.second, r.columns.length)
				return {
					...r,
					columns: Arr.map(r.columns, (c, i) =>
						i === column ? pickIndex(picks.third, palettePicks) : c
					)
				}
			})
		case "primaryKey":
			return replace((r) => ({ ...r, pkMask: picks.mask, pure: picks.flag }))
		case "candidateKeys":
			return replace((r) => ({ ...r, keyMasks: [...picks.masks] }))
		case "mutable":
			return replace((r) => ({ ...r, mutable: !r.mutable }))
		case "containment":
			return replace((r) => ({
				...r,
				fk: { enabled: picks.flag, target: pickIndex(picks.second, 4), typed: false }
			}))
		case "addRelation": {
			const added = at(donor.relations, picks.first)
			if (added === undefined || n >= limits.maxRelations) {
				return sketch
			}
			return { ...sketch, relations: [...relations, added] }
		}
		case "dropRelation":
			if (n <= 1) {
				return sketch
			}
			return { ...sketch, relations: Arr.remove(relations, indexIn(picks.first, n)) }
		case "addHandle": {
			const k = indexIn(picks.first, closed.length)
			const c = closed[k]
			if (c === undefined || c.pattern.slots.length >= maxHandles) {
				return sketch
			}
			closed[k] = {
				...c,
				pattern: {
					...c.pattern,
					slots: [...c.pattern.slots, { kind: "live", handle: `G${c.pattern.slots.length}` }]
				},
				payload: Arr.map(c.payload, (p) => ({
					...p,
					/** The new handle's code takes a payload value too: the column's first. */
					values: [...p.values, ...p.values.slice(0, 1)]
				}))
			}
			return { ...sketch, closed }
		}
		case "payload": {
			const k = indexIn(picks.first, closed.length)
			const c = closed[k]
			const from: ClosedSketch | undefined = at(donor.closed, picks.second)
			if (c === undefined || from === undefined) {
				return sketch
			}
			/** The codes of this roster, each of which the donor's payload columns hold a value for, the donor's in turn. */
			const codes = c.pattern.slots.length
			closed[k] = {
				...c,
				payload: Arr.map(from.payload, (p) => ({
					...p,
					values: Arr.flatMap(
						upTo(codes, (i) => i),
						(i) => Option.toArray(Arr.get(p.values, i % Math.max(p.values.length, 1)))
					)
				}))
			}
			return { ...sketch, closed }
		}
		case "addClosed": {
			const from: ClosedSketch | undefined = at(donor.closed, picks.first)
			if (from === undefined || closed.length >= limits.maxClosed) {
				return sketch
			}
			return { ...sketch, closed: [...closed, from] }
		}
		case "revive": {
			/** Relations are named by position, so the first one's relation at this one's next position comes back under
			 * its own name. */
			const back = first.relations[n]
			if (back === undefined || n >= limits.maxRelations) {
				return sketch
			}
			return { ...sketch, relations: [...relations, back] }
		}
		case "promoteKey": {
			/** A candidate key becomes the primary key, and the relation after it references it: a containment into a key
			 * that was unique but not primary before. */
			const i = indexIn(picks.first, n)
			const r = relations[i]
			const mask = r === undefined ? undefined : at(r.keyMasks, picks.second)
			if (r === undefined || mask === undefined) {
				return sketch
			}
			relations[i] = {
				...r,
				pkMask: mask,
				pure: false,
				keyMasks: Arr.filter(r.keyMasks, (m) => m !== mask)
			}
			const next = relations[i + 1]
			if (next !== undefined) {
				relations[i + 1] = { ...next, fk: { enabled: true, target: i, typed: true } }
			}
			return { ...sketch, relations }
		}
		case "restore": {
			/** A relation given back the declaration the first schema had for it: the fields removed since declared again,
			 * with their keys and its containment. */
			const i = indexIn(picks.first, n)
			const was = first.relations[i]
			if (was === undefined) {
				return sketch
			}
			relations[i] = was
			return { ...sketch, relations }
		}
	}
}

const applyEdits = (
	sketch: SchemaSketch,
	donor: SchemaSketch,
	first: SchemaSketch,
	limits: SchemaLimits,
	edits: ReadonlyArray<Edit>
): SchemaSketch => Arr.reduce(edits, sketch, (s, e) => applyEdit(s, donor, first, limits, e))

/** What a version carries beside its oracle schema, each item by picks into its relations and fields, so a rename
 * carries it along. */
export interface Extras {
	/** Bound checks `Bound<k>` on an integer field: at least its type's least value, or at most its greatest. */
	readonly checks: ReadonlyArray<{
		readonly relation: number
		readonly column: number
		readonly lower: boolean
	}>
	/** Extended statistics over two fields of a relation. */
	readonly statistics: ReadonlyArray<{
		readonly relation: number
		readonly first: number
		readonly second: number
	}>
	/** The relations with a field `sq`, by its type (SqType). */
	readonly serials: ReadonlyArray<{ readonly relation: number; readonly type: SqType }>
	/** Integer fields declared serial: an identity over a column of the oracle schema. */
	readonly identities: ReadonlyArray<{ readonly relation: number; readonly column: number }>
	/** The relations the reader does not read, by position. */
	readonly unread: ReadonlyArray<number>
	/** The coded pair, when the path draws it. */
	readonly coded: Coded
}

/** The coded pair: CodeTarget keyed by a field of the contract Code over refined text, and CodeSource whose field of
 * Code references it, with fixed rows, under the native foreign key of their containment. */
export type Coded = { readonly kind: "absent" } | { readonly kind: "present" }

export const noExtras: Extras = {
	checks: [],
	statistics: [],
	serials: [],
	identities: [],
	unread: [],
	coded: { kind: "absent" }
}

/** The contract over refined text the coded pair is keyed by. */
const codeType = scalarOfSpec({ carrier: "contract", name: "Code" })

const codedRelations = { target: "CodeTarget", source: "CodeSource" } as const

/** The coded pair's rows: two targets, the first referenced twice and the second once, lawful under every bound drawn. */
export const codedFacts: Readonly<
	Record<string, ReadonlyArray<Readonly<Record<string, LiteralDesc>>>>
> = {
	[codedRelations.target]: Arr.map(["a", "b"], (code) => ({
		code: typedLiteralDesc({ kind: "text", value: code }, codeType)
	})),
	[codedRelations.source]: Arr.map(
		[
			[1n, "a"],
			[2n, "a"],
			[3n, "b"]
		] as const,
		([id, code]) => ({
			id: typedLiteralDesc({ kind: "int", value: id }, int4),
			code: typedLiteralDesc({ kind: "text", value: code }, codeType)
		})
	)
}

/** The type of the field `sq`: an integer serial, int4 or int8, drawn by its identity; a pg.uuidv7, drawn by its
 * `uuidv7()` default; or a uuid its caller writes. */
export type SqType = "serial" | "bigserial" | "uuidv7" | "uuid"

const sqTypes: Arr.NonEmptyReadonlyArray<SqType> = ["serial", "bigserial", "uuidv7", "uuid"]

/** The type a pick draws `sq` with, among all four without modulo skew. */
const sqTypeOf = (pick: number): SqType =>
	defined(sqTypes[pickIndex(pick, sqTypes.length)], "a type of sq")

/**
 * The type a successor retypes `sq` to, by `flag`: an integer serial to the other width or to a uuidv7, a uuidv7 to a
 * serial or to a uuid, a uuid to a uuidv7. No uuid becomes a bigserial: the reviewer converts a column to a bigint
 * serial by its cast (typedValue castsSerial), which reads an integer.
 */
const retypedSq = (type: SqType, flag: boolean): SqType => {
	switch (type) {
		case "serial":
			return flag ? "bigserial" : "uuidv7"
		case "bigserial":
			return flag ? "serial" : "uuidv7"
		case "uuidv7":
			return flag ? "serial" : "uuid"
		case "uuid":
			return "uuidv7"
	}
}

const without = <A>(xs: ReadonlyArray<A>, pick: number): ReadonlyArray<A> =>
	xs.length === 0 ? xs : Arr.remove(xs, pickIndex(pick, xs.length))

const applyExtraEdit = (x: Extras, { kind, picks }: ExtraEdit): Extras => {
	switch (kind) {
		case "addCheck":
			return {
				...x,
				checks: [...x.checks, { relation: picks.first, column: picks.second, lower: picks.flag }]
			}
		case "changeCheck": {
			const k = indexIn(picks.first, x.checks.length)
			return {
				...x,
				checks: Arr.map(x.checks, (c, i) => (i === k ? { ...c, lower: !c.lower } : c))
			}
		}
		case "removeChecks":
			return { ...x, checks: [] }
		case "addStatistics":
			return {
				...x,
				statistics: [
					...x.statistics,
					{ relation: picks.first, first: picks.second, second: picks.third }
				]
			}
		case "dropStatistics":
			return { ...x, statistics: without(x.statistics, picks.first) }
		case "addSerial":
			return {
				...x,
				serials: [...x.serials, { relation: picks.first, type: sqTypeOf(picks.second) }]
			}
		case "dropSerial":
			return { ...x, serials: without(x.serials, picks.first) }
		case "retypeSerial": {
			const k = indexIn(picks.first, x.serials.length)
			return {
				...x,
				serials: Arr.map(x.serials, (s, i) =>
					i === k ? { ...s, type: retypedSq(s.type, picks.flag) } : s
				)
			}
		}
		case "addIdentity":
			return {
				...x,
				identities: [...x.identities, { relation: picks.first, column: picks.second }]
			}
		case "dropIdentity":
			return { ...x, identities: without(x.identities, picks.first) }
		case "toggleRead": {
			const relation = pickIndex(picks.first, pathLimits.maxRelations)
			return {
				...x,
				unread: x.unread.includes(relation)
					? Arr.filter(x.unread, (r) => r !== relation)
					: [...x.unread, relation]
			}
		}
		case "addCoded":
			return x.coded.kind === "absent" ? { ...x, coded: { kind: "present" } } : x
	}
}

/** The limits of generated paths: small schemas, so a case is a few migrations of a few files. */
const pathLimits: SchemaLimits = { ...defaultSchemaLimits, maxRelations: 3, maxColumns: 4 }

/** The extras A starts with, before the swarm turns some kinds off. */
interface ExtrasSketch {
	readonly checks: ReadonlyArray<Picks>
	readonly statistics: ReadonlyArray<Picks>
	readonly serials: ReadonlyArray<Picks>
	readonly identities: ReadonlyArray<Picks>
	readonly unread: ReadonlyArray<number>
}

const extrasSketchGen: Gen<ExtrasSketch> = (source) => ({
	checks: source.draw(array(picksGen, { min: 0, max: 2 })),
	statistics: source.draw(array(picksGen, { min: 0, max: 2 })),
	serials: source.draw(array(picksGen, { min: 0, max: 1 })),
	identities: source.draw(array(picksGen, { min: 0, max: 1 })),
	unread: source.draw(array(pickGen, { min: 0, max: 1 }))
})

export interface PathSketch {
	readonly swarm: Swarm<PathKind>
	readonly a: SchemaSketch
	readonly donor: SchemaSketch
	readonly toB: ReadonlyArray<Edit>
	readonly toC: ReadonlyArray<Edit>
	readonly extras: ExtrasSketch
	readonly extrasToB: ReadonlyArray<ExtraEdit>
	readonly extrasToC: ReadonlyArray<ExtraEdit>
	readonly facts: FactsSketch
}

/** Between `min` and two more changes, each of a kind the swarm chooses among `kinds`. */
const changesGen = <K extends PathKind>(
	drawn: Swarm<PathKind>,
	kinds: readonly [K, ...ReadonlyArray<K>],
	min: number
): Gen<ReadonlyArray<Change<K>>> => array(changeGen(drawn, kinds), { min, max: min + 2 })

/** A path's sketch: its swarm first, which every change's kind is chosen under. */
const pathSketchGen: Gen<PathSketch> = (source) => {
	const drawn = source.draw(swarm(pathKinds))
	return {
		swarm: drawn,
		a: source.draw(schemaSketchGen(pathLimits)),
		donor: source.draw(schemaSketchGen(pathLimits)),
		toB: source.draw(changesGen(drawn, editKinds, 1)),
		toC: source.draw(changesGen(drawn, editKinds, 1)),
		extras: source.draw(extrasSketchGen),
		extrasToB: source.draw(changesGen(drawn, extraKinds, 0)),
		extrasToC: source.draw(changesGen(drawn, extraKinds, 0)),
		facts: source.draw(factsSketchGen({ maxRows: 4 }, pathLimits.maxRelations))
	}
}

export interface Version {
	readonly schema: GenSchema
	readonly extras: Extras
	/**
	 * The schema's Description with its extras, admitted as a user's description is (schema/admit.ts admitSchemaDesc):
	 * each closed relation it holds admitted once, so every login over it holds admitted ones.
	 */
	readonly desc: SchemaDesc
}

export interface MigrationPath {
	readonly a: Version
	readonly b: Version
	readonly c: Version
	/** A's generated facts, before the carry model selects the ones lawful in B. */
	readonly facts: ValueFacts
	readonly spelling: Spelling
	readonly edits: { readonly toB: ReadonlyArray<Edit>; readonly toC: ReadonlyArray<Edit> }
	/** The kinds the path's swarm left on. */
	readonly kinds: ReadonlyArray<PathKind>
}

/** The least and greatest value of an integer carrier, which bound checks compare with: every value satisfies both. Each
 * is the literal host type its carrier takes: a JavaScript integer for int2 and int4, a bigint for int8. */
const integerBounds = {
	int2: [-32768, 32767],
	int4: [-2147483648, 2147483647],
	int8: [-9223372036854775808n, 9223372036854775807n]
} as const satisfies { readonly [C in IntegerCarrier]: readonly [LiteralDesc, LiteralDesc] }

/** The bounds a check on a field of `type` compares with: its integer carrier's; a contract or any other carrier draws
 * no check. */
const boundsOf = (type: ScalarType): readonly [LiteralDesc, LiteralDesc] | undefined => {
	if (contractOf(type) !== undefined) {
		return undefined
	}
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return integerBounds[type.carrier]
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
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

/** The integer types a serial field may have, whose sequence draws its values. */
const serialTypes: ReadonlySet<string> = new Set(["smallint", "integer", "bigint"])

/** A field its caller writes. */
const callerWritten = (type: FieldDesc): FieldDecl => ({ type, writing: { kind: "caller" } })

/** The field `sq` of its type: an integer serial GENERATED ALWAYS AS IDENTITY, its sequence drawing its values; a
 * pg.uuidv7, its `uuidv7()` default drawing them; or a uuid its caller writes. */
const sqDecl = (type: SqType): FieldDecl => {
	switch (type) {
		case "serial":
			return { type: { kind: "pg", type: "integer" }, writing: { kind: "serial" } }
		case "bigserial":
			return { type: { kind: "pg", type: "bigint" }, writing: { kind: "serial" } }
		case "uuidv7":
			return { type: { kind: "uuid" }, writing: { kind: "serial" } }
		case "uuid":
			return callerWritten({ kind: "uuid" })
	}
}

/** The bound checks of a version: each on its integer field, skipped where the field is of another type. */
const checksOf = (schema: GenSchema, extras: Extras): ReadonlyArray<StatementDesc> =>
	Arr.flatMap(extras.checks, (c, k) => {
		const r = at(schema.relations, c.relation)
		const col = r === undefined ? undefined : at(r.columns, c.column)
		const bounds = col === undefined ? undefined : boundsOf(col.type)
		if (r === undefined || col === undefined || bounds === undefined) {
			return []
		}
		const [least, greatest] = bounds
		return [
			{
				kind: "check",
				name: `Bound${k}`,
				relation: r.name,
				predicate: {
					kind: "compare",
					op: c.lower ? "ge" : "le",
					left: { kind: "field", field: col.name },
					right: { kind: "literal", value: c.lower ? least : greatest }
				}
			}
		]
	})

/** The serial field's name: no oracle schema field is named like it, and no rename takes it. */
/**
 * Whether a version names a relation or a closed relation as PostgreSQL names one of its types or functions: the name
 * the type namespace's builtins shadow-check against.
 */
export const holdsCatalogName = (v: Version): boolean =>
	Arr.some(
		[...Arr.map(v.schema.relations, (r) => r.name), ...Arr.map(v.schema.closed, (c) => c.name)],
		(name) => {
			const ident = converted(name)
			return ident !== undefined && catalogConversions.has(ident)
		}
	)

export const serialField = "sq"

/** The fields a version declares serial, `<relation>.<field>`: its serial field's, and each integer field the extras
 * declare serial. */
export const serialFields = (v: Version): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(v.desc.relations, (r) =>
			r.kind === "relation"
				? Arr.flatMap(Rec.toEntries(r.fields), ([f, d]) =>
						d.writing.kind === "serial" ? [`${r.name}.${f}`] : []
					)
				: []
		)
	)

/** The relations of a version with a field `sq`, and its type. */
export const serialRelations = (schema: GenSchema, extras: Extras): ReadonlyMap<string, SqType> =>
	new Map(
		Arr.flatMap(extras.serials, (s) => {
			const r = at(schema.relations, s.relation)
			return r === undefined ? [] : [[r.name, s.type] as const]
		})
	)

/** The fields of a version declared serial, `<relation>.<field>`, with their declaration: integer fields only. */
const identityFields = (schema: GenSchema, extras: Extras): ReadonlyMap<string, FieldDecl> =>
	new Map(
		Arr.flatMap(extras.identities, (x) => {
			const r = at(schema.relations, x.relation)
			const col = r === undefined ? undefined : at(r.columns, x.column)
			const desc = col === undefined ? undefined : fieldDescOf(col.type)
			if (
				r === undefined ||
				col === undefined ||
				desc?.kind !== "pg" ||
				!serialTypes.has(desc.type)
			) {
				return []
			}
			const decl: FieldDecl = { type: desc, writing: { kind: "serial" } }
			return [[`${r.name}.${col.name}`, decl] as const]
		})
	)

const withExtras = (schema: GenSchema, extras: Extras): AuthoredSchemaDesc => {
	const desc = schemaDesc(schema)
	const serials = serialRelations(schema, extras)
	const identities = identityFields(schema, extras)
	const coded = codedOf(extras.coded)
	return {
		...desc,
		relations: [
			...Arr.map(desc.relations, (r): AuthoredSchemaDesc["relations"][number] => {
				if (r.kind !== "relation") {
					return r
				}
				const fields = Rec.fromEntries(
					Arr.map(
						Rec.toEntries(r.fields),
						([f, d]) => [f, identities.get(`${r.name}.${f}`) ?? d] as const
					)
				)
				const serial = serials.get(r.name)
				return {
					...r,
					fields:
						serial === undefined
							? fields
							: {
									...fields,
									[serialField]: sqDecl(serial)
								}
				}
			}),
			...coded.relations
		],
		statements: [...desc.statements, ...checksOf(schema, extras), ...coded.statements]
	}
}

/** The worlds of a version, over its admitted Description: the login `server`, holding the role `writer`, which holds
 * every stored relation whole and writes them, and the role `reader`, which holds every relation whole, closed ones
 * included, but the unread ones, when one is left to read, and writes none. A role holds at least one relation, so a
 * version whose every relation is unread has no reader. */
const worldsOf = (
	schema: GenSchema,
	extras: Extras,
	desc: SchemaDesc
): ReadonlyArray<LoginDesc> => {
	const loc = SourceLoc(`the worlds of ${desc.name}`, [])
	const unread = new Set(
		Arr.flatMap(extras.unread, (i) =>
			Option.toArray(Option.map(Arr.get(schema.relations, i), (r) => r.name))
		)
	)
	const stored = [
		...Arr.map(schema.relations, (r) => r.name),
		...Arr.map(codedOf(extras.coded).relations, (r) => r.name)
	]
	const read = [
		...Arr.map(schema.closed, (c) => c.name),
		...Arr.filter(stored, (r) => !unread.has(r))
	]
	const whole = (names: ReadonlyArray<string>) =>
		Arr.map(names, (name): RoleEntryDesc => ({ kind: "whole", name, loc }))
	const login = Result.flatMap(
		decodeRoleOver(desc, {
			name: "writer",
			relations: whole(stored),
			write: stored,
			refresh: [],
			loc
		}),
		(writer) =>
			read.length > 0
				? Result.flatMap(
						decodeRoleOver(desc, {
							name: "reader",
							relations: whole(read),
							write: [],
							refresh: [],
							loc
						}),
						(reader) => admitLoginRoles(desc, { name: "server", roles: [writer, reader], loc })
					)
				: admitLoginRoles(desc, { name: "server", roles: [writer], loc })
	)
	if (!login.ok) {
		throw new Error(login.error.message)
	}
	return [login.value]
}

/** A side over every fact of `relation`, by its code. */
const on = (relation: string): SideDesc => ({
	relation,
	terms: [{ kind: "field", field: "code" }],
	selection: everyFact
})

/** The coded pair's relations and statements at a version: none when the path does not draw it. */
const codedOf = (
	coded: Coded
): {
	readonly relations: AuthoredSchemaDesc["relations"]
	readonly statements: ReadonlyArray<StatementDesc>
} => {
	if (coded.kind === "absent") {
		return { relations: [], statements: [] }
	}
	const code = callerWritten(fieldDescOf(codeType))
	const { target, source } = codedRelations
	return {
		relations: [
			{ kind: "relation", name: target, fields: { code }, primaryKey: ["code"] },
			{
				kind: "relation",
				name: source,
				fields: { id: callerWritten(fieldDescOf(int4)), code },
				primaryKey: ["id"]
			}
		],
		statements: [{ kind: "contained", left: on(source), right: on(target) }]
	}
}

export const versionOf = (schema: GenSchema, extras: Extras): Version => ({
	schema,
	extras,
	desc: succeeded(admitSchemaDesc(withExtras(schema, extras)), "a version's description")
})

/** The logins a version installs (worldsOf). */
export const versionLogins = (v: Version): ReadonlyArray<LoginDesc> =>
	worldsOf(v.schema, v.extras, v.desc)

/** The statistics a version requests, synthetic requests: two distinct fields of a relation each, in code point order. */
const statisticsRequests = (v: Version): ReadonlyArray<StatisticsRequest> =>
	Arr.flatMap(v.extras.statistics, (x) => {
		const r = at(v.schema.relations, x.relation)
		const a = r === undefined ? undefined : at(r.columns, x.first)
		const b = r === undefined ? undefined : at(r.columns, x.second)
		if (r === undefined || a === undefined || b === undefined || a.name === b.name) {
			return []
		}
		return [
			{
				relation: r.name,
				columns: Arr.sort([a.name, b.name], Order.String),
				kinds: statisticsKinds,
				uses: ["correlated selection" as const]
			}
		]
	})

/**
 * The installer extensions a version needs: its statistics, if it requests any, as a workload of the schema the
 * installation installs, whatever names its levels are installed under.
 */
export const extensionsOf = (v: Version): ReadonlyArray<InstallExtension> => {
	const statistics = statisticsRequests(v)
	return statistics.length === 0
		? []
		: [
				{
					contribute: (b) =>
						workloadExtension({
							schema: b.owned.fingerprint,
							paths: [],
							statistics,
							params: noParamTypes
						}).contribute(b),
					textDomainUses: noTextDomainUses,
					params: servesNoParams,
					certifies: noCertificates,
					carriers: noCarriers,
					holds: noHolds,
					live: noLive,
					fences: noFences
				}
			]
}

/** Whether the path's swarm leaves a kind on. */
const kindOn = (drawn: Swarm<PathKind>, kind: PathKind): boolean => weightOf(drawn, kind) > 0

/** A's extras: each list only when the swarm leaves its kind on. */
const initialExtras = (drawn: Swarm<PathKind>, sketch: ExtrasSketch): Extras => ({
	checks: kindOn(drawn, "addCheck")
		? Arr.map(sketch.checks, (p) => ({ relation: p.first, column: p.second, lower: p.flag }))
		: [],
	statistics: kindOn(drawn, "addStatistics")
		? Arr.map(sketch.statistics, (p) => ({ relation: p.first, first: p.second, second: p.third }))
		: [],
	serials: kindOn(drawn, "addSerial")
		? Arr.map(sketch.serials, (p) => ({ relation: p.first, type: sqTypeOf(p.second) }))
		: [],
	identities: kindOn(drawn, "addIdentity")
		? Arr.map(sketch.identities, (p) => ({ relation: p.first, column: p.second }))
		: [],
	unread: kindOn(drawn, "toggleRead")
		? Arr.map(sketch.unread, (p) => pickIndex(p, pathLimits.maxRelations))
		: [],
	coded: kindOn(drawn, "addCoded") ? { kind: "present" } : { kind: "absent" }
})

/** A version's schema, resolved under the full data swarm: the path's own swarm already decides which edits, extras and
 * renames a path draws, and every drawn path states the data swarm its schemas and facts resolve under. The full data
 * swarm keeps every place, so the resolution draws nothing from the case's tape. */
const version = (sketch: SchemaSketch, spelling: Spelling, extras: Extras): Gen<Version> =>
	map(resolveSchema(sketch, spelling, fullDataSwarm), (schema) => versionOf(schema, extras))

/**
 * A roster as its first migration installs it: its live handles in declared order, each holding the code of its
 * position, with no hole, since the migration that creates a roster drafts its codes from no history. Its later
 * versions keep those codes, a handle appended taking the next one and a removed one leaving a hole
 * (lastHandleRemoved), as the migrations between them draft them.
 */
const firstInstalled = (c: ClosedSketch): ClosedSketch => ({
	...c,
	pattern: {
		...c.pattern,
		slots: nonEmptyList(
			Arr.filter(c.pattern.slots, (slot) => slot.kind === "live"),
			"a roster's live handle"
		)
	}
})

/** A schema sketch whose rosters are as their first migration installs them (firstInstalled). */
const withFirstInstalled = (sketch: SchemaSketch): SchemaSketch => ({
	...sketch,
	closed: Arr.map(sketch.closed, firstInstalled)
})

const resolvePath =
	(drawn: PathSketch): Gen<MigrationPath> =>
	(source) => {
		/** A's rosters, and every roster a later version adds from the donor, as their first migration installs them. */
		const sketch: PathSketch = {
			...drawn,
			a: withFirstInstalled(drawn.a),
			donor: withFirstInstalled(drawn.donor)
		}
		const spelling: Spelling = { mode: "drawn", edge: false }
		const b = applyEdits(sketch.a, sketch.donor, sketch.a, pathLimits, sketch.toB)
		const c = applyEdits(b, sketch.donor, sketch.a, pathLimits, sketch.toC)
		const extrasA = initialExtras(sketch.swarm, sketch.extras)
		const extrasB = Arr.reduce(sketch.extrasToB, extrasA, applyExtraEdit)
		const extrasC = Arr.reduce(sketch.extrasToC, extrasB, applyExtraEdit)
		const a = source.draw(version(sketch.a, spelling, extrasA))
		return {
			a,
			b: source.draw(version(b, spelling, extrasB)),
			c: source.draw(version(c, spelling, extrasC)),
			facts: factValues(resolveFacts(a.schema, sketch.facts, spelling, fullDataSwarm)),
			spelling,
			edits: { toB: sketch.toB, toC: sketch.toC },
			kinds: Arr.filter(pathKinds, (k) => kindOn(sketch.swarm, k))
		}
	}

/** A path stated by its three schemas and their extras: a finding the generated paths made once, kept by value. Its
 * kinds are the kinds of its edits. */
export interface StatedPath {
	readonly a: GenSchema
	readonly b: GenSchema
	readonly c: GenSchema
	readonly extras: StatedExtras
	readonly facts: ValueFacts
	readonly spelling: Spelling
	readonly edits: MigrationPath["edits"]
}

/** The extras of a stated path's three versions. */
export interface StatedExtras {
	readonly a: Extras
	readonly b: Extras
	readonly c: Extras
}

/** A stated path whose versions carry no extras. */
const noStatedExtras: StatedExtras = { a: noExtras, b: noExtras, c: noExtras }

const statedPath = (p: StatedPath): MigrationPath => ({
	...installedVersions(p, p.extras),
	facts: p.facts,
	spelling: p.spelling,
	edits: p.edits,
	kinds: Arr.filter(pathKinds, (k) =>
		Arr.some([...p.edits.toB, ...p.edits.toC], (e) => e.kind === k)
	)
})

/** Where each relation and field of a version came from: the name it had in the path's first schema, which renames
 * carry along. Two versions' names of one origin are one relation or field, renamed when the names differ. */
export interface Origins {
	readonly relations: ReadonlyMap<string, string>
	/** `<relation>.<field>` to the origin relation and field, `<relation>.<field>`. */
	readonly columns: ReadonlyMap<string, string>
}

/** Every name of a schema its own origin. */
const ownOrigins = (schema: GenSchema): Origins => ({
	relations: new Map(Arr.map(schema.relations, (r) => [r.name, r.name])),
	columns: new Map(
		Arr.flatMap(schema.relations, (r) =>
			Arr.map(r.columns, (c) => [`${r.name}.${c.name}`, `${r.name}.${c.name}`])
		)
	)
})

/** A version with where its names came from. */
interface TracedSchema {
	readonly schema: GenSchema
	readonly origins: Origins
}

/** The names the previous migration removed when a version is drafted, which it may take again: the relations, and the
 * fields of each relation, the version before its predecessor had and its predecessor does not. */
interface Removed {
	readonly relations: ReadonlyArray<string>
	readonly columns: ReadonlyMap<string, ReadonlyArray<string>>
}

const noRemoved: Removed = { relations: [], columns: new Map() }

const removedOf = (before: GenSchema, after: GenSchema): Removed => ({
	relations: Arr.filter(
		Arr.map(before.relations, (r) => r.name),
		(n) => !Arr.some(after.relations, (r) => r.name === n)
	),
	columns: new Map(
		Arr.flatMap(before.relations, (r) => {
			const now = Arr.findFirst(after.relations, (x) => x.name === r.name)
			return Option.isNone(now)
				? []
				: [
						[
							r.name,
							Arr.filter(
								Arr.map(r.columns, (c) => c.name),
								(n) => !Arr.some(now.value.columns, (c) => c.name === n)
							)
						] as const
					]
		})
	)
})

/** The identifier a declared name converts to (core/identity.ts parseDeclaredName), or undefined when it has none. */
const converted = (name: string): string | undefined => {
	const r = parseDeclaredName(name)
	return r.ok ? converts(r.value) : undefined
}

/**
 * A declared name's conversion: its identifier wherever the naming door names it readable (a table, an enum, a
 * column), so two declared names of one namespace are one name exactly when their conversions are equal. A name the
 * rule refuses is a defect of the generator that drew it.
 */
const conversionOf = (declared: string): string => {
	const r = parseDeclaredName(declared)
	if (!r.ok) {
		throw new Error(
			`the generator drew ${Formatter.format(declared)}, which the naming rule refuses: ${r.error}`
		)
	}
	return converts(r.value)
}

/** Whether a relation may take `name`: it converts, and to no other relation's or roster's identifier (a table's row
 * type and an enum share PostgreSQL's type namespace). */
const relationNameFree = (schema: GenSchema, name: string, self: string): boolean => {
	const ident = converted(name)
	return (
		ident !== undefined &&
		!Arr.some(schema.relations, (r) => r.name !== self && converted(r.name) === ident) &&
		!Arr.some(schema.closed, (c) => converted(c.name) === ident)
	)
}

/** Whether a field of `relation` may take `name`: it converts, to no other field's identifier, nor the serial field's. */
const fieldNameFree = (relation: GenRelation, name: string, self: string): boolean => {
	const ident = converted(name)
	return (
		ident !== undefined &&
		ident !== converted(serialField) &&
		!Arr.some(relation.columns, (c) => c.name !== self && converted(c.name) === ident)
	)
}

/** Renames relations and the fields of one relation at once, by maps of old to new names, so two names may swap. */
const renameNames = (
	t: TracedSchema,
	relations: (name: string) => string,
	columns: { readonly relation: string; readonly rename: (name: string) => string } | undefined
): TracedSchema => {
	const col = (relation: string) => (name: string) =>
		columns?.relation === relation ? columns.rename(name) : name
	const side = (x: { readonly relation: string; readonly fields: ReadonlyArray<string> }) => ({
		relation: relations(x.relation),
		fields: Arr.map(x.fields, col(x.relation))
	})
	const schema: GenSchema = {
		...t.schema,
		relations: Arr.map(t.schema.relations, (r) => {
			const c = col(r.name)
			return {
				...r,
				name: relations(r.name),
				columns: Arr.map(r.columns, (x) => ({ ...x, name: c(x.name) })),
				primaryKey: Arr.map(r.primaryKey, c),
				keys: Arr.map(r.keys, (k) => Arr.map(k, c))
			}
		}),
		containments: Arr.map(t.schema.containments, (x) => ({ from: side(x.from), to: side(x.to) }))
	}
	const columnKey = (key: string) => {
		const dot = Option.getOrThrowWith(
			pipe(key, Str.indexOf(".")),
			() => new Error(`the column key ${key} holds a dot`)
		)
		const relation = Str.slice(0, dot)(key)
		return `${relations(relation)}.${col(relation)(Str.slice(dot + 1)(key))}`
	}
	return {
		schema,
		origins: {
			relations: new Map(
				Arr.map([...t.origins.relations], ([name, origin]) => [relations(name), origin])
			),
			columns: new Map(Arr.map([...t.origins.columns], ([key, origin]) => [columnKey(key), origin]))
		}
	}
}

const swap =
	(a: string, b: string) =>
	(name: string): string =>
		name === a ? b : name === b ? a : name

/** Whether a field takes part in a containment, whose two sides must keep one type. */
const contained = (schema: GenSchema, relation: string, field: string): boolean =>
	Arr.some(
		schema.containments,
		(c) =>
			(c.from.relation === relation && c.from.fields.includes(field)) ||
			(c.to.relation === relation && c.to.fields.includes(field))
	)

/** A relation renamed to `to`, when it may take the name. */
const renameRelation = (t: TracedSchema, target: GenRelation, to: string): TracedSchema =>
	to !== target.name && relationNameFree(t.schema, to, target.name)
		? renameNames(t, (name) => (name === target.name ? to : name), undefined)
		: t

/** A field of `target` renamed to `to`, when it may take the name. */
const renameField = (
	t: TracedSchema,
	target: GenRelation,
	from: string,
	to: string
): TracedSchema =>
	to !== from && fieldNameFree(target, to, from)
		? renameNames(t, (name) => name, {
				relation: target.name,
				rename: (name) => (name === from ? to : name)
			})
		: t

/** Applies one rename to a version; prefixed names start with `prefix` (relations upper case, fields lower case), so a
 * later step's renames never take an earlier step's names. `removed` names what the previous migration dropped.
 *
 * Another spelling that converts to the same identifier: an underscore at the end ends no segment. */
const renamed = (
	t: TracedSchema,
	{ kind, picks }: RenameEdit,
	prefix: string,
	removed: Removed
): TracedSchema => {
	const relations = t.schema.relations
	const upper = Str.toUpperCase(prefix)
	const lower = Str.toLowerCase(prefix)
	const relation = at(relations, picks.first)
	const columnOf = (r: GenRelation) => at(r.columns, picks.second)
	switch (kind) {
		case "relation": {
			const referenced = Arr.filter(relations, (r) =>
				Arr.some(t.schema.containments, (c) => c.to.relation === r.name)
			)
			const target = at(picks.flag && referenced.length > 0 ? referenced : relations, picks.first)
			return target === undefined
				? t
				: renameRelation(t, target, `${upper}${relations.indexOf(target)}`)
		}
		case "column": {
			/** A field of a key a containment references, when the flag asks for one and there is one. */
			const keyed = Arr.flatMap(relations, (r) => {
				const referencing = Arr.filter(t.schema.containments, (c) => c.to.relation === r.name)
				return Arr.flatMap(referencing, (c) =>
					Arr.map(c.to.fields, (field) => ({ relation: r, field }))
				)
			})
			const picked =
				(picks.flag ? at(keyed, picks.first) : undefined) ??
				(relation === undefined ? undefined : { relation, field: columnOf(relation)?.name })
			if (picked?.field === undefined) {
				return t
			}
			const from = picked.field
			return renameField(
				t,
				picked.relation,
				from,
				`${lower}${Option.getOrThrowWith(
					Arr.findFirstIndex(picked.relation.columns, (c) => c.name === from),
					() => new Error(`${picked.relation.name} has no field ${from}`)
				)}`
			)
		}
		case "retyped": {
			const column = relation === undefined ? undefined : columnOf(relation)
			if (relation === undefined || column === undefined) {
				return t
			}
			const to = `${lower}${relation.columns.indexOf(column)}`
			const next = renameField(t, relation, column.name, to)
			if (next === t || contained(t.schema, relation.name, column.name)) {
				return next
			}
			/** A type another field of the schema has, as a key field takes it when the field is keyed. */
			const keyed = [...relation.primaryKey, ...relation.keys.flat()].includes(column.name)
			const fieldTypes = Arr.flatMap(relations, (r) =>
				Arr.map(r.columns, (c) => (keyed ? keyFieldType(c.type, "scalar") : c.type))
			)
			const otherTypes = Arr.filter(
				fieldTypes,
				(candidate) => !sameScalarType(candidate, column.type)
			)
			/** Every other type of the schema's fields, once each, in field order. */
			const types = Arr.dedupeWith(otherTypes, sameScalarType)
			const type = at(types, picks.third)
			if (type === undefined) {
				return next
			}
			return {
				...next,
				schema: {
					...next.schema,
					relations: Arr.map(next.schema.relations, (r) =>
						r.name === relation.name
							? { ...r, columns: Arr.map(r.columns, (c) => (c.name === to ? { ...c, type } : c)) }
							: r
					)
				}
			}
		}
		case "relationRetyped": {
			/** A relation renamed with a field it neither keys nor contains converted to another type of the schema. */
			const column = relation === undefined ? undefined : columnOf(relation)
			if (relation === undefined || column === undefined) {
				return t
			}
			const keyed = [...relation.primaryKey, ...relation.keys.flat()].includes(column.name)
			if (keyed || contained(t.schema, relation.name, column.name)) {
				return t
			}
			const next = renameRelation(t, relation, `${upper}${relations.indexOf(relation)}`)
			if (next === t) {
				return t
			}
			const to = next.schema.relations[relations.indexOf(relation)]?.name
			const fieldTypes = Arr.flatMap(relations, (r) => Arr.map(r.columns, (c) => c.type))
			const otherTypes = Arr.filter(
				fieldTypes,
				(candidate) => !sameScalarType(candidate, column.type)
			)
			/** Every other type of the schema's fields, once each, in field order. */
			const types = Arr.dedupeWith(otherTypes, sameScalarType)
			const type = at(types, picks.third)
			if (to === undefined || type === undefined) {
				return next
			}
			return {
				...next,
				schema: {
					...next.schema,
					relations: Arr.map(next.schema.relations, (r) =>
						r.name === to
							? {
									...r,
									columns: Arr.map(r.columns, (c) => (c.name === column.name ? { ...c, type } : c))
								}
							: r
					)
				}
			}
		}
		case "swapRelations": {
			const a = relation
			const b = at(relations, picks.second)
			if (a === undefined || b === undefined || a === b) {
				return t
			}
			return renameNames(t, swap(a.name, b.name), undefined)
		}
		case "swapColumns": {
			const a = relation === undefined ? undefined : columnOf(relation)
			const b = relation === undefined ? undefined : at(relation.columns, picks.third)
			if (relation === undefined || a === undefined || b === undefined || a === b) {
				return t
			}
			return renameNames(t, (name) => name, {
				relation: relation.name,
				rename: swap(a.name, b.name)
			})
		}
		case "hop": {
			const k = indexIn(picks.second, t.schema.closed.length)
			const closed = t.schema.closed[k]
			if (closed === undefined || relation === undefined) {
				return t
			}
			const away = renamedRoster(t, k, upper)
			if (!relationNameFree(away.schema, closed.name, relation.name)) {
				return t
			}
			return renameNames(away, (name) => (name === relation.name ? closed.name : name), undefined)
		}
		case "closed":
			return renamedRoster(t, indexIn(picks.second, t.schema.closed.length), upper)
		case "removeHandle":
			return lastHandleRemoved(t, indexIn(picks.second, t.schema.closed.length))
		case "alias": {
			if (relation === undefined) {
				return t
			}
			if (!picks.flag) {
				return renameRelation(t, relation, `${relation.name}_`)
			}
			const column = columnOf(relation)
			return column === undefined ? t : renameField(t, relation, column.name, `${column.name}_`)
		}
		case "dictionary": {
			/** A feature, each as often, then a name of it: the catalog-type names are one kind among the others. */
			const group = at(admittedByFeature, picks.second)
			const entry = group === undefined ? undefined : at(group, picks.third)
			if (entry === undefined) {
				return t
			}
			/** A closed relation takes the name: its enum is a type of that name, where a builtin type's lives. */
			const toRoster = picks.mask % 3 === 2
			if (toRoster) {
				return renamedRosterTo(
					t,
					indexIn(Math.floor(picks.mask / 3), t.schema.closed.length),
					entry.declared
				)
			}
			if (relation === undefined) {
				return t
			}
			if (!picks.flag) {
				return renameRelation(t, relation, entry.declared)
			}
			/**
			 * A closed id's field has a decoded column `<field>_name` in each role's view, which fits a name too, so a
			 * dictionary name too long to take that suffix is no name of one.
			 */
			const column = columnOf(relation)
			const decodedFits =
				column === undefined ||
				rosterOf(column.type) === undefined ||
				Buffer.byteLength(`${conversionOf(entry.declared)}_name`, "utf8") <=
					maxIdentifierBytes.value
			return column === undefined || !decodedFits
				? t
				: renameField(t, relation, column.name, entry.declared)
		}
		case "catalog": {
			/** A name a PostgreSQL type or function holds: a relation's row type or a closed relation's enum takes it. */
			const name = at(catalogTypeNames, picks.second)
			if (name === undefined) {
				return t
			}
			if (picks.flag) {
				return renamedRosterTo(t, indexIn(picks.mask, t.schema.closed.length), name)
			}
			return relation === undefined ? t : renameRelation(t, relation, name)
		}
		case "ontoRemoved": {
			if (relation === undefined) {
				return t
			}
			if (!picks.flag) {
				const to = at(removed.relations, picks.third)
				return to === undefined ? t : renameRelation(t, relation, to)
			}
			const column = columnOf(relation)
			const to = at(removed.columns.get(relation.name) ?? [], picks.third)
			return column === undefined || to === undefined
				? t
				: renameField(t, relation, column.name, to)
		}
	}
}

/** A closed roster renamed, which retypes every field it types. */
const renamedRoster = (t: TracedSchema, k: number, upper: string): TracedSchema =>
	renamedRosterTo(t, k, `${upper}${k}K`)

/** The closed roster `k` renamed to `name`, which retypes every field it types; left as it is where `name` is taken. */
const renamedRosterTo = (t: TracedSchema, k: number, name: string): TracedSchema => {
	const closed = t.schema.closed[k]
	if (closed === undefined) {
		return t
	}
	const to = { ...closed, name }
	if (!relationNameFree(t.schema, to.name, "")) {
		return t
	}
	const roster = (type: GenRelation["columns"][number]["type"]) =>
		rosterOf(type)?.closed === closed.name ? closedIdType(to) : type
	return {
		...t,
		schema: {
			...t.schema,
			closed: Arr.map(t.schema.closed, (c) => (c === closed ? to : c)),
			relations: Arr.map(t.schema.relations, (r) => ({
				...r,
				columns: Arr.map(r.columns, (c) => ({ ...c, type: roster(c.type) }))
			}))
		}
	}
}

/**
 * Roster `k` with its last live handle removed: its code becomes a hole no handle takes again, its payload row goes,
 * and every field it types is retyped to the roster's live handles; a roster of fewer than two live handles is left as
 * it is, since a roster holds one at least.
 */
const lastHandleRemoved = (t: TracedSchema, k: number): TracedSchema => {
	const closed = t.schema.closed[k]
	if (closed === undefined || closed.handles.length < 2) {
		return t
	}
	const last = Arr.lastNonEmpty(closed.handles)
	const handles = nonEmptyList(closed.handles.slice(0, -1), "a roster keeps one live handle")
	const to: GenClosed = {
		...closed,
		handles,
		codes: Arr.map(closed.codes, (slot): CodeSlot =>
			slot.kind === "live" && slot.handle === last ? { kind: "hole" } : slot
		),
		rows: Arr.filter(closed.rows, (row) => {
			const [id] = row
			return !(id?.kind === "handle" && id.handle === last)
		})
	}
	const roster = (type: GenRelation["columns"][number]["type"]) =>
		rosterOf(type)?.closed === closed.name ? closedIdType(to) : type
	return {
		...t,
		schema: {
			...t.schema,
			closed: Arr.map(t.schema.closed, (c) => (c === closed ? to : c)),
			relations: Arr.map(t.schema.relations, (r) => ({
				...r,
				columns: Arr.map(r.columns, (c) => ({ ...c, type: roster(c.type) }))
			}))
		}
	}
}

const renamedAll = (
	t: TracedSchema,
	edits: ReadonlyArray<RenameEdit>,
	prefix: string,
	removed: Removed
): TracedSchema => Arr.reduce(edits, t, (x, e) => renamed(x, e, prefix, removed))

/** A path whose B makes a few renames, and whose C makes a few of its own, either on top of B's (a chain: each
 * relation or field renamed twice) or on C's first names (B's renames undone: renamed back); the reviewer keeps every
 * candidate rename as its two operations, or chooses each candidate of a rename the path made. */
export interface RenamedPath {
	readonly path: MigrationPath
	readonly origins: { readonly a: Origins; readonly b: Origins; readonly c: Origins }
	readonly choose: boolean
	readonly chained: boolean
	/** The renames each successor made, resolved. */
	readonly renames: {
		readonly toB: ReadonlyArray<RenameKind>
		readonly toC: ReadonlyArray<RenameKind>
	}
}

/** A renamed path as the generator draws it: a path's sketch, the renames B and C make, whether C's chain on B's, whether
 * C renames what B renamed once more, and whether the reviewer chooses. */
export interface RenamedSketch {
	readonly path: PathSketch
	readonly toB: ReadonlyArray<RenameEdit>
	readonly toC: ReadonlyArray<RenameEdit>
	readonly chained: boolean
	/** On a chain, whether C renames what B renamed once more. */
	readonly again: boolean
	readonly choose: boolean
}

/** A renamed path's sketch: the path's, then renames whose kinds its swarm chooses. */
const renamedSketchGen: Gen<RenamedSketch> = (source) => {
	const path = source.draw(pathSketchGen)
	return {
		path,
		toB: source.draw(array(changeGen(path.swarm, renameKinds), { min: 1, max: 3 })),
		toC: source.draw(array(changeGen(path.swarm, renameKinds), { min: 0, max: 2 })),
		chained: source.draw(boolean),
		again: source.draw(boolean),
		choose: source.draw(boolean)
	}
}

/**
 * `c` with every handle B removed from a roster of A removed from that roster in C too, while it keeps a handle: a
 * removed handle's code is a hole no handle takes again, so C declaring it back would give it a new code after B and
 * its old one straight from A, and no catalog of C would be one whichever path led to it.
 */
const removalsKept = (a: GenSchema, b: GenSchema, c: GenSchema): GenSchema => {
	const named = (s: GenSchema, name: string) => Arr.findFirst(s.closed, (x) => x.name === name)
	return Arr.reduce(c.closed, c, (schema, rc) => {
		const was = named(a, rc.name)
		const now = named(b, rc.name)
		if (Option.isNone(was) || Option.isNone(now)) {
			return schema
		}
		const gone = new Set(Arr.filter(was.value.handles, (h) => !now.value.handles.includes(h)))
		const kept = Arr.filter(rc.handles, (h) => !gone.has(h))
		return Arr.isReadonlyArrayNonEmpty(kept) && kept.length < rc.handles.length
			? handlesRemoved(schema, rc, kept)
			: schema
	})
}

/** `schema` with the roster `closed` holding only `handles`: each removed handle's code a hole, its payload row gone,
 * and every field the roster types retyped to its live handles. */
const handlesRemoved = (
	schema: GenSchema,
	closed: GenClosed,
	handles: Arr.NonEmptyReadonlyArray<string>
): GenSchema => {
	const to: GenClosed = {
		...closed,
		handles,
		codes: Arr.map(closed.codes, (slot): CodeSlot =>
			slot.kind === "live" && !handles.includes(slot.handle) ? { kind: "hole" } : slot
		),
		rows: Arr.filter(closed.rows, (row) => {
			const [id] = row
			return !(id?.kind === "handle" && !handles.includes(id.handle))
		})
	}
	const roster = (type: GenRelation["columns"][number]["type"]) =>
		rosterOf(type)?.closed === closed.name ? closedIdType(to) : type
	return {
		...schema,
		closed: Arr.map(schema.closed, (c) => (c.name === closed.name ? to : c)),
		relations: Arr.map(schema.relations, (r) => ({
			...r,
			columns: Arr.map(r.columns, (c) => ({ ...c, type: roster(c.type) }))
		}))
	}
}

/**
 * `after` with each roster's codes as the migration from `before` drafts them, the roster by its name: each handle it
 * held and still holds keeps its code, one it no longer holds leaves a hole no handle takes again, and one new to it
 * takes the next code, a handle given back after its removal among them; a roster new to `after` is installed fresh, its
 * handles in declared order. A removal takes a roster's last handle and an addition appends one, so a later version
 * still declares its handles in their codes' order.
 */
const continuedCodes = (before: ReadonlyArray<GenClosed>, after: GenSchema): GenSchema => ({
	...after,
	closed: Arr.map(after.closed, (c): GenClosed => {
		const was = Arr.findFirst(before, (x) => x.name === c.name)
		if (Option.isNone(was)) {
			return { ...c, codes: Arr.map(c.handles, (handle): CodeSlot => ({ kind: "live", handle })) }
		}
		const kept = Arr.map(was.value.codes, (slot): CodeSlot =>
			slot.kind === "live" && c.handles.includes(slot.handle) ? slot : { kind: "hole" }
		)
		const held = new Set(Arr.flatMap(kept, (slot) => (slot.kind === "live" ? [slot.handle] : [])))
		const added = Arr.flatMap(c.handles, (handle): ReadonlyArray<CodeSlot> =>
			held.has(handle) ? [] : [{ kind: "live", handle }]
		)
		return { ...c, codes: [...kept, ...added] }
	})
})

/**
 * C as the direct migration from A drafts it: C's declaration, each roster's codes continued from A's rather than B's,
 * since a code is history (continuedCodes), so a handle B added and C no longer holds leaves no hole on the direct path.
 */
export const directVersion = (path: MigrationPath): Version =>
	versionOf(continuedCodes(path.a.schema.closed, path.c.schema), path.c.extras)

/**
 * A path's three versions as its migrations install them: each roster's codes continued from the version before
 * (continuedCodes), A's from none. A path states no codes: a code is history, and no step declares a roster renamed
 * (declarationsOf), so a roster under a new name is a new roster, installed fresh, whatever codes its schema carried.
 */
const installedVersions = (
	schemas: { readonly a: GenSchema; readonly b: GenSchema; readonly c: GenSchema },
	extras: StatedExtras
): Pick<MigrationPath, "a" | "b" | "c"> => {
	const a = continuedCodes([], schemas.a)
	const b = continuedCodes(a.closed, schemas.b)
	return {
		a: versionOf(a, extras.a),
		b: versionOf(b, extras.b),
		c: versionOf(continuedCodes(b.closed, schemas.c), extras.c)
	}
}

const resolveRenamed =
	({
		path,
		toB: renamesB,
		toC: renamesC,
		chained,
		again,
		choose
	}: RenamedSketch): Gen<RenamedPath> =>
	(source) => {
		const p = source.draw(resolvePath(path))
		const b = renamedAll(
			{ schema: p.b.schema, origins: ownOrigins(p.b.schema) },
			renamesB,
			"q",
			noRemoved
		)
		/** C's own names first, then, on a chain, B's renames, then C's, and maybe B's once more under new names. A
		 * rename of C onto a removed name takes one A had and B does not, which B's migration dropped. */
		const removed = removedOf(p.a.schema, b.schema)
		const cFirst = { schema: p.c.schema, origins: ownOrigins(p.c.schema) }
		const c = chained
			? renamedAll(
					renamedAll(cFirst, renamesB, "q", noRemoved),
					[...renamesC, ...(again ? renamesB : [])],
					"p",
					removed
				)
			: renamedAll(cFirst, renamesC, "p", removed)
		return {
			path: {
				...p,
				...installedVersions(
					{ a: p.a.schema, b: b.schema, c: removalsKept(p.a.schema, b.schema, c.schema) },
					{ a: p.a.extras, b: p.b.extras, c: p.c.extras }
				)
			},
			origins: { a: ownOrigins(p.a.schema), b: b.origins, c: c.origins },
			choose,
			chained,
			renames: { toB: Arr.map(renamesB, (r) => r.kind), toC: Arr.map(renamesC, (r) => r.kind) }
		}
	}

/** A renamed path stated by value: a finding the generated renamed paths made once. */
export interface StatedRenamedPath {
	readonly path: StatedPath
	readonly origins: RenamedPath["origins"]
	readonly choose: boolean
	readonly chained: boolean
	readonly renames: RenamedPath["renames"]
}

/** A renamed path as a suite draws it: a drawn sketch, resolved, a joint rename's sketch (jointDrawGen), or a stated
 * path, a kept case's. */
export type RenamedDraw =
	| { readonly kind: "drawn"; readonly sketch: RenamedSketch }
	| { readonly kind: "joint"; readonly sketch: JointSketch }
	| { readonly kind: "stated"; readonly path: StatedRenamedPath }

export const renamedDrawGen: Gen<RenamedDraw> = map(renamedSketchGen, (sketch): RenamedDraw => ({
	kind: "drawn",
	sketch
}))

/**
 * A renamed path whose B also renames a relation or a closed roster to the name of a PostgreSQL type, whatever the
 * path's swarm left on: the arm a suite draws so a catalog type's name meets the paths its sessions start under.
 */
export const catalogRenamedDrawGen: Gen<RenamedDraw> = (source) => {
	const sketch = source.draw(renamedSketchGen)
	const catalog = source.draw(changeGen(sketch.path.swarm, ["catalog"]))
	return { kind: "drawn", sketch: { ...sketch, toB: [...sketch.toB, catalog] } }
}

/** A stated renamed path as the suites take it. */
const statedRenamed = (stated: StatedRenamedPath): RenamedPath => ({
	path: statedPath(stated.path),
	origins: stated.origins,
	choose: stated.choose,
	chained: stated.chained,
	renames: stated.renames
})

/** A renamed path a suite draws, resolved: a drawn sketch resolves its schemas from the case's tape, which under the
 * full data swarm draws nothing, so a kept case replays with no property draws; a joint rename and a stated path are
 * their values. */
export const resolveRenamedDraw = (d: RenamedDraw): Gen<RenamedPath> => {
	switch (d.kind) {
		case "drawn":
			return resolveRenamed(d.sketch)
		case "joint":
			return constant(statedRenamed(jointRename(d.sketch)))
		case "stated":
			return constant(statedRenamed(d.path))
	}
}

type GenColumn = GenRelation["columns"][number]

/** Whether two fields are declared alike: one field descriptor. */
const sameType = (a: GenColumn, b: GenColumn): boolean =>
	Equal.equals(fieldDescOf(a.type), fieldDescOf(b.type))

/** Whether two relations have one heading as the draft compares them: their physical columns, each of one type. */
const sameHeading = (a: GenRelation, b: GenRelation): boolean =>
	a.columns.length === b.columns.length &&
	Arr.every(a.columns, (c) =>
		Arr.some(b.columns, (d) => conversionOf(d.name) === conversionOf(c.name) && sameType(c, d))
	)

const relationOf = (schema: GenSchema, name: string): Option.Option<GenRelation> =>
	Arr.findFirst(schema.relations, (r) => r.name === name)

/** Whether a relation of version `av` and one of `bv` have one heading as the draft compares a whole table's: their
 * fields, the serial field `sq` of each version's extras, and which of their integer fields each declares serial. */
const sameTableHeading = (av: Version, a: GenRelation, bv: Version, b: GenRelation): boolean => {
	const serial = (v: Version, r: GenRelation) => serialRelations(v.schema, v.extras).get(r.name)
	const identities = (v: Version, r: GenRelation) =>
		Arr.join(
			Arr.sort(
				Arr.map(
					Arr.filter([...identityFields(v.schema, v.extras).keys()], (key) =>
						Str.startsWith(`${r.name}.`)(key)
					),
					(key) => conversionOf(Str.slice(r.name.length + 1)(key))
				),
				Order.String
			),
			","
		)
	return (
		sameHeading(a, b) && serial(av, a) === serial(bv, b) && identities(av, a) === identities(bv, b)
	)
}

/** The identifiers of the relations whose kept name the draft sets aside, as documented: a
 * relation of both versions, by identifier, whose heading changes while another relation of `to`, added or itself
 * changed, has exactly the heading it held. Its identity may move there: its rows go where the reviewer chooses, and
 * its name holds a relation afresh, never the old rows. */
const movedRelations = (from: Version, to: Version): ReadonlySet<string> => {
	const at = (v: Version, ident: string) =>
		Arr.findFirst(v.schema.relations, (x) => conversionOf(x.name) === ident)
	const open = Arr.filter(to.schema.relations, (r) => {
		const was = at(from, conversionOf(r.name))
		return Option.isNone(was) || !sameTableHeading(from, was.value, to, r)
	})
	return new Set(
		Arr.flatMap(from.schema.relations, (was) => {
			const ident = conversionOf(was.name)
			const now = at(to, ident)
			if (Option.isNone(now) || sameTableHeading(from, was, to, now.value)) {
				return []
			}
			return Arr.some(
				open,
				(o) => conversionOf(o.name) !== ident && sameTableHeading(from, was, to, o)
			)
				? [ident]
				: []
		})
	)
}

/** A version traced: its relations' and fields' origins beside it. */
export interface TracedVersion {
	readonly version: Version
	readonly origins: Origins
}

/** Whether the draft pairs a removed relation with an added one as a candidate this model chooses: one heading, or one
 * primary key and one set of fields with only field types changed (the draft converts them in place). A key a
 * containment references may change: the candidate drops the reference before the key and the draft adds it again. The
 * extras' serial fields and identities, which the oracle schema has no form for, change in place with the rename too. */
const renamePairs = (removed: GenRelation, added: GenRelation): boolean => {
	if (sameHeading(removed, added)) {
		return true
	}
	const names = (r: GenRelation) =>
		Arr.join(
			Arr.sort(
				Arr.map(r.columns, (c) => conversionOf(c.name)),
				Order.String
			),
			","
		)
	const key = (r: GenRelation) => Arr.join(Arr.map(r.primaryKey, conversionOf), ",")
	return key(removed) === key(added) && names(removed) === names(added)
}

/** The renames a reviewer chose: each target relation by the relation it was before, and each target field
 * (`<relation>.<field>`, the relation's target name) by the field it was before. */
export interface Renames {
	readonly relations: ReadonlyMap<string, string>
	readonly columns: ReadonlyMap<string, string>
}

export const noRenames: Renames = { relations: new Map(), columns: new Map() }

const has = (rel: GenRelation, name: string) => Arr.some(rel.columns, (c) => c.name === name)

/** The renames of a step from `from` to `to`: those whose two names have one origin, a relation renamed to a name of
 * its heading, as a candidate needs, and a field of a relation of both renamed to a field of its type, or of another
 * when no removed field has its type; or, with
 * `alias`, those between two names of one identifier, which no candidate needs: the draft holds such a name as no
 * change, the same table or column whatever the name's origin or heading. For the chosen renames, a relation whose
 * kept name another relation's identity takes (movedRelations) is a rename from that one when the two have one
 * origin, its rows carried only when chosen. */
const originRenames = (
	fromVersion: TracedVersion,
	toVersion: TracedVersion,
	alias: boolean
): Renames => {
	/** The names whose identity moves, which a chosen rename may take; an alias is one table whatever moves. */
	const moved = alias ? new Set<string>() : movedRelations(fromVersion.version, toVersion.version)
	const from: TracedSchema = { schema: fromVersion.version.schema, origins: fromVersion.origins }
	const to: TracedSchema = { schema: toVersion.version.schema, origins: toVersion.origins }
	const named = (s: GenSchema, name: string) =>
		!moved.has(conversionOf(name)) && Arr.some(s.relations, (r) => r.name === name)
	const relations = new Map<string, string>()
	for (const added of to.schema.relations) {
		if (named(from.schema, added.name)) {
			continue
		}
		const origin = to.origins.relations.get(added.name)
		const removed = Arr.findFirst(
			from.schema.relations,
			(r) =>
				!named(to.schema, r.name) &&
				(alias
					? conversionOf(r.name) === conversionOf(added.name)
					: origin !== undefined &&
						from.origins.relations.get(r.name) === origin &&
						renamePairs(r, added))
		)
		if (Option.isSome(removed)) {
			relations.set(added.name, removed.value.name)
		}
	}
	const columns = new Map<string, string>()
	for (const r of to.schema.relations) {
		/** The same table: a relation of the same name, or of another spelling of it, unless its name is set aside. A
		 * relation renamed to another table is a candidate of its own, whose fields come along by name. */
		const found = Arr.findFirst(
			from.schema.relations,
			(x) => conversionOf(x.name) === conversionOf(r.name)
		)
		if (Option.isNone(found) || moved.has(conversionOf(r.name))) {
			continue
		}
		const before = found.value
		for (const added of r.columns) {
			if (has(before, added.name)) {
				continue
			}
			const origin = to.origins.columns.get(`${r.name}.${added.name}`)
			/** A field renamed with its type changed is a candidate too when no removed field has the added one's type
			 *, its value the reviewer's conversion. */
			const ofItsType = Arr.some(before.columns, (c) => !has(r, c.name) && sameType(c, added))
			const removed = Arr.findFirst(
				before.columns,
				(c) =>
					!has(r, c.name) &&
					(alias
						? conversionOf(c.name) === conversionOf(added.name)
						: origin !== undefined &&
							from.origins.columns.get(`${before.name}.${c.name}`) === origin &&
							(sameType(c, added) || !ofItsType))
			)
			if (Option.isSome(removed)) {
				columns.set(`${r.name}.${added.name}`, removed.value.name)
			}
		}
	}
	return { relations, columns }
}

/** The renames a reviewer who chooses the path's renames may choose in a draft from `from` to `to`: each removed and
 * added relation of one heading, or removed and added field of one relation and type, whose two names have one origin.
 * A rename the draft offers no candidate for, because another change came with it, is carried by name or not at all,
 * as the draft does. */
export const chosenRenames = (from: TracedVersion, to: TracedVersion): Renames =>
	originRenames(from, to, false)

/** The renames between names of one identifier, which the draft holds as no change: their rows stay where they are. */
export const aliasRenames = (from: TracedVersion, to: TracedVersion): Renames =>
	originRenames(from, to, true)

/** Two sets of renames in one. */
export const bothRenames = (a: Renames, b: Renames): Renames => ({
	relations: new Map([...a.relations, ...b.relations]),
	columns: new Map([...a.columns, ...b.columns])
})

/**
 * What a draft from `a` to `b` declares (`--rename`, `--drop`): each relation rename and each field rename of
 * `declared`, a field's `from` named as `a` names it and its `to` as `b` does; every relation and field `a` holds that `b`
 * carries nowhere, by a declared rename, an alias (`aliases`, a rename between names of one identifier, which the draft
 * holds as no change) or its own name, dropped; and each removed handle, a code `b` holds as a hole, dropped.
 */
const declarationsOf = (
	a: Version,
	b: Version,
	declared: Renames,
	aliases: Renames
): Declarations => {
	const renames: Array<Rename> = []
	const drops: Array<Named> = []
	const named = (name: string) => parsedName(name)
	const renamedFrom = (map: ReadonlyMap<string, string>, from: string): string | undefined => {
		for (const [to, was] of map) {
			if (was === from) {
				return to
			}
		}
		return undefined
	}
	const carriedTo = (
		from: string
	): { readonly to: string; readonly declared: boolean } | undefined => {
		const viaDeclared = renamedFrom(declared.relations, from)
		if (viaDeclared !== undefined) {
			return { to: viaDeclared, declared: true }
		}
		const viaAlias = renamedFrom(aliases.relations, from)
		if (viaAlias !== undefined) {
			return { to: viaAlias, declared: false }
		}
		return Arr.some(b.schema.relations, (r) => r.name === from) &&
			!declared.relations.has(from) &&
			!aliases.relations.has(from)
			? { to: from, declared: false }
			: undefined
	}
	for (const ar of a.schema.relations) {
		const carried = carriedTo(ar.name)
		const br =
			carried === undefined
				? Option.none()
				: Arr.findFirst(b.schema.relations, (r) => r.name === carried.to)
		if (carried === undefined || Option.isNone(br)) {
			drops.push({ kind: "relation", relation: named(ar.name) })
			continue
		}
		if (carried.declared) {
			renames.push({
				from: { kind: "relation", relation: named(ar.name) },
				to: { kind: "relation", relation: named(carried.to) }
			})
		}
		for (const ac of ar.columns) {
			const key = (bc: GenColumn) => `${carried.to}.${bc.name}`
			/** The field `ac` is in B: a declared or aliased rename's, or the field of its conversion, one column. */
			const into = Arr.findFirst(br.value.columns, (bc) => {
				const was = declared.columns.get(key(bc)) ?? aliases.columns.get(key(bc))
				return was === undefined ? conversionOf(bc.name) === conversionOf(ac.name) : was === ac.name
			})
			if (Option.isNone(into)) {
				drops.push({ kind: "field", relation: named(ar.name), field: named(ac.name) })
			} else if (declared.columns.get(key(into.value)) === ac.name && into.value.name !== ac.name) {
				renames.push({
					from: { kind: "field", relation: named(ar.name), field: named(ac.name) },
					to: { kind: "field", relation: named(carried.to), field: named(into.value.name) }
				})
			}
		}
	}
	/** Each relation's field `sq`, which an extra declares, holds the values its rows were given, so its drop is
	 * declared: a relation carried to one that declares none. */
	const serialsA = serialRelations(a.schema, a.extras)
	const serialsB = serialRelations(b.schema, b.extras)
	for (const ar of a.schema.relations) {
		const carried = carriedTo(ar.name)
		if (
			serialsA.has(ar.name) &&
			carried !== undefined &&
			Arr.some(b.schema.relations, (r) => r.name === carried.to) &&
			!serialsB.has(carried.to)
		) {
			drops.push({ kind: "field", relation: named(ar.name), field: named(serialField) })
		}
	}
	for (const ac of a.schema.closed) {
		const bc = Arr.findFirst(b.schema.closed, (c) => c.name === ac.name)
		if (Option.isNone(bc)) {
			drops.push({ kind: "relation", relation: named(ac.name) })
			continue
		}
		for (const [code, slot] of ac.codes.entries()) {
			if (slot.kind === "live" && bc.value.codes[code]?.kind !== "live") {
				drops.push({ kind: "handle", roster: named(ac.name), handle: slot.handle })
			}
		}
	}
	return { renames, drops }
}

/**
 * What a step of a path from `from` to `to` declares: with `choose`, the path's renames (chosenRenames) as `--rename`s;
 * every other relation, field or handle removed as a `--drop`; an alias rename, which the draft holds as no change,
 * neither. The draft then drafts what a reviewer choosing the path's renames chose.
 */
export const declarationsAlong = (
	from: TracedVersion,
	to: TracedVersion,
	choose: boolean
): Declarations =>
	declarationsOf(
		from.version,
		to.version,
		choose ? chosenRenames(from, to) : noRenames,
		aliasRenames(from, to)
	)

/** Renamed paths stated by value, every candidate
 * kept, each relation with no candidate key and each value its first spelling (the edits that led to them are not restated: no property reads
 * a path's edits). */
const statedRelation = (
	name: string,
	columns: GenRelation["columns"],
	primaryKey: ReadonlyArray<string>,
	mutable: boolean
): GenRelation => ({ name, columns, primaryKey, keys: [], mutable })

/** A roster stated by its handles, each holding the code of its position, as a fresh installation gives them. */
const statedRoster = (name: string, handles: Arr.NonEmptyReadonlyArray<string>): GenClosed => ({
	name,
	handles,
	codes: Arr.map(handles, (handle): CodeSlot => ({ kind: "live", handle })),
	payload: [],
	rows: Arr.map(handles, (handle) => [{ kind: "handle", handle }])
})

const statedSchema = (
	relations: ReadonlyArray<GenRelation>,
	closed: ReadonlyArray<GenClosed>
): GenSchema => ({
	name: schemaName,
	relations,
	closed,
	containments: []
})

const statedOrigins = (
	relations: ReadonlyArray<readonly [string, string]>,
	columns: ReadonlyArray<readonly [string, string]>
): Origins => ({ relations: new Map(relations), columns: new Map(columns) })
const firstSpellings: Spelling = { mode: "drawn", edge: false }

/** Planted renames the generated paths reach only a few times a run, each over int4 fields. */
const ints = (
	name: string,
	fields: ReadonlyArray<string>,
	key: ReadonlyArray<string>
): GenRelation =>
	statedRelation(
		name,
		Arr.map(fields, (f) => ({ name: f, type: int4 })),
		key,
		false
	)
const one = (n: bigint): LiteralRow => [{ kind: "int", value: n }]
const two = (x: bigint, y: bigint): LiteralRow => [
	{ kind: "int", value: x },
	{ kind: "int", value: y }
]

const containedIn = (
	from: string,
	fromField: string,
	to: string,
	toField: string
): GenContainment => ({
	from: { relation: from, fields: [fromField] },
	to: { relation: to, fields: [toField] }
})

const plantedRenameWith = (
	versions: { readonly a: GenSchema; readonly b: GenSchema; readonly c: GenSchema },
	extras: StatedExtras,
	facts: ValueFacts,
	origins: StatedRenamedPath["origins"],
	choose: boolean,
	renames: StatedRenamedPath["renames"]
): StatedRenamedPath => ({
	path: { ...versions, extras, facts, spelling: firstSpellings, edits: { toB: [], toC: [] } },
	origins,
	choose,
	chained: false,
	renames
})

const plantedRename = (
	versions: { readonly a: GenSchema; readonly b: GenSchema; readonly c: GenSchema },
	facts: ValueFacts,
	origins: StatedRenamedPath["origins"],
	choose: boolean,
	renames: StatedRenamedPath["renames"]
): StatedRenamedPath => plantedRenameWith(versions, noStatedExtras, facts, origins, choose, renames)

/** A joint rename: B renames R0, which R1's containment references, and R1, both chosen, and converts the referenced
 * field and the referencing one to another integer type, which each rename converts in place: each alternative drops
 * R1's foreign key, R0's before the key it references and R1's as its own over a converted field, so the two candidates
 * decide one statement alike. The relation renamed first in the draft is the referenced one (the added relations draft
 * by name: P0 before Q1), or the referencing one (P1 before Q0). C is B, or renames both back to A's names and types,
 * which offers the two candidates of the way back. A has R0's keys, and R1's rows, each referencing the key its pick
 * selects and keyed by its position from 2 on. */
export interface JointSketch {
	readonly referencedFirst: boolean
	/** The contained fields' integer type in A, and the other one B converts them to. */
	readonly conversion: readonly [from: IntegerCarrier, to: IntegerCarrier]
	readonly keys: ReadonlyArray<number>
	readonly references: ReadonlyArray<number>
	readonly back: boolean
}

const keyedBy = (name: string, type: ScalarType): GenRelation =>
	statedRelation(name, [{ name: "a", type }], ["a"], false)

const referrerOf = (name: string, type: ScalarType): GenRelation =>
	statedRelation(
		name,
		[
			{ name: "a", type },
			{ name: "b", type: int4 }
		],
		["b"],
		false
	)

const jointVersion = (referenced: string, referrer: string, type: ScalarType): GenSchema => ({
	...statedSchema([keyedBy(referenced, type), referrerOf(referrer, type)], []),
	containments: [containedIn(referrer, "a", referenced, "a")]
})

const jointOrigins = (referenced: string, referrer: string) =>
	statedOrigins(
		[
			[referenced, "R0"],
			[referrer, "R1"]
		],
		[
			[`${referenced}.a`, "R0.a"],
			[`${referrer}.a`, "R1.a"],
			[`${referrer}.b`, "R1.b"]
		]
	)

const jointRename = ({
	referencedFirst,
	conversion: [from, to],
	keys,
	references,
	back
}: JointSketch): StatedRenamedPath => {
	const [referenced, referrer] = referencedFirst ? (["P0", "Q1"] as const) : (["Q0", "P1"] as const)
	const a = jointVersion("R0", "R1", scalarOfSpec({ carrier: from }))
	const b = jointVersion(referenced, referrer, scalarOfSpec({ carrier: to }))
	const renamedB = jointOrigins(referenced, referrer)
	return plantedRename(
		{ a, b, c: back ? a : b },
		{
			R0: Arr.map(keys, (k) => one(BigInt(k))),
			R1: Arr.map(references, (pick, i) =>
				two(BigInt(defined(at(keys, pick), "R0's keys")), BigInt(i + 2))
			)
		},
		{ a: jointOrigins("R0", "R1"), b: renamedB, c: back ? jointOrigins("R0", "R1") : renamedB },
		true,
		{
			toB: ["relationRetyped", "relationRetyped"],
			toC: back ? ["relationRetyped", "relationRetyped"] : []
		}
	)
}

/** The joint rename first found: int4 widened to int8, R0 holding the key 1 and R1 the row (1, 2), C as B. */
const statedJoint = (referencedFirst: boolean): StatedRenamedPath =>
	jointRename({
		referencedFirst,
		conversion: ["int4", "int8"],
		keys: [1],
		references: [0],
		back: false
	})
export const referencedRenamedFirst: StatedRenamedPath = statedJoint(true)

/** B widens R0's field b from int4 to int8 and renames its field c to Select, chosen: A's key over b and c is B's over b
 * and Select under the rename (a carried key must be built again over the converted column of b). */
const keyedOver = (fields: ReadonlyArray<GenColumn>, key: ReadonlyArray<string>): GenRelation => ({
	...statedRelation("R0", fields, ["a"], false),
	keys: [key]
})

const keyCarryOrigins = statedOrigins(
	[["R0", "R0"]],
	[
		["R0.a", "R0.a"],
		["R0.b", "R0.b"],
		["R0.Select", "R0.c"]
	]
)

const keyCarryTarget = statedSchema(
	[
		keyedOver(
			[
				{ name: "a", type: int4 },
				{ name: "b", type: int8 },
				{ name: "Select", type: int4 }
			],
			["b", "Select"]
		)
	],
	[]
)

export const keyCarriedOverRetyped: StatedRenamedPath = plantedRename(
	{
		a: statedSchema(
			[
				keyedOver(
					[
						{ name: "a", type: int4 },
						{ name: "b", type: int4 },
						{ name: "c", type: int4 }
					],
					["b", "c"]
				)
			],
			[]
		),
		b: keyCarryTarget,
		c: keyCarryTarget
	},
	{ R0: [[...one(1n), ...two(2n, 3n)]] },
	{
		a: statedOrigins(
			[["R0", "R0"]],
			[
				["R0.a", "R0.a"],
				["R0.b", "R0.b"],
				["R0.c", "R0.c"]
			]
		),
		b: keyCarryOrigins,
		c: keyCarryOrigins
	},
	true,
	{ toB: ["column", "retyped"], toC: [] }
)

/** B renames R0's field b, which A's candidate key holds, to c, chosen, and makes c R0's primary key, which R1's new
 * containment references: under the rename A's key stands over c beside B's primary key, and the containment, added
 * after, would bind the first index over c, A's key's, whose drop PostgreSQL then refuses (2BP01: the drafting paths
 * compared a key under its old names). */
const keyOverB: GenRelation = {
	...statedRelation(
		"R0",
		[
			{ name: "a", type: int4 },
			{ name: "b", type: int4 }
		],
		["a"],
		false
	),
	keys: [["b"]]
}

const promotedTarget: GenSchema = {
	...statedSchema(
		[
			statedRelation(
				"R0",
				[
					{ name: "a", type: int4 },
					{ name: "c", type: int4 }
				],
				["c"],
				false
			),
			statedRelation("R1", [{ name: "a", type: int4 }], ["a"], false)
		],
		[]
	),
	containments: [containedIn("R1", "a", "R0", "c")]
}

const promotedOrigins = statedOrigins(
	[
		["R0", "R0"],
		["R1", "R1"]
	],
	[
		["R0.a", "R0.a"],
		["R0.c", "R0.b"],
		["R1.a", "R1.a"]
	]
)

export const keyRenamedOntoPrimary: StatedRenamedPath = plantedRename(
	{
		a: statedSchema(
			[keyOverB, statedRelation("R1", [{ name: "a", type: int4 }], ["a"], false)],
			[]
		),
		b: promotedTarget,
		c: promotedTarget
	},
	{ R0: [two(1n, 10n), two(2n, 20n)], R1: [one(10n), one(20n)] },
	{
		a: statedOrigins(
			[
				["R0", "R0"],
				["R1", "R1"]
			],
			[
				["R0.a", "R0.a"],
				["R0.b", "R0.b"],
				["R1.a", "R1.a"]
			]
		),
		b: promotedOrigins,
		c: promotedOrigins
	},
	true,
	{ toB: ["column"], toC: [] }
)

/** R1 keyed by x, which R0's field b contains. */
const referrerOfB: GenRelation = statedRelation("R1", [{ name: "x", type: int4 }], ["x"], false)

const promotedSurrogateGone: GenSchema = {
	...statedSchema(
		[statedRelation("R0", [{ name: "b", type: int4 }], ["b"], false), referrerOfB],
		[]
	),
	containments: [containedIn("R1", "x", "R0", "b")]
}

const surrogateGoneOrigins = statedOrigins(
	[
		["R0", "R0"],
		["R1", "R1"]
	],
	[
		["R0.b", "R0.b"],
		["R1.x", "R1.x"]
	]
)

/** B drops R0's surrogate primary key e, declared, and promotes its candidate key b to its primary key, which R1's
 * containment references in A and B alike: its foreign key keeps its name and turns from deferred, R0 holding e
 * beside b, to immediate, R0 holding b alone, in the migration that replaces the key over b it references. The draft
 * drops the changed foreign key in Structure and adds it after B's key is attached, and the rebinding of the foreign
 * keys the target keeps unchanged over a replaced key leaves it alone, so no statement drops it twice (42704). */
export const keyPromotedBesideChangedReference: StatedRenamedPath = plantedRename(
	{
		a: {
			...statedSchema(
				[
					{
						...statedRelation(
							"R0",
							[
								{ name: "e", type: int4 },
								{ name: "b", type: int4 }
							],
							["e"],
							false
						),
						keys: [["b"]]
					},
					referrerOfB
				],
				[]
			),
			containments: [containedIn("R1", "x", "R0", "b")]
		},
		b: promotedSurrogateGone,
		c: promotedSurrogateGone
	},
	{ R0: [two(1n, 10n), two(2n, 20n)], R1: [one(10n), one(20n)] },
	{
		a: statedOrigins(
			[
				["R0", "R0"],
				["R1", "R1"]
			],
			[
				["R0.e", "R0.e"],
				["R0.b", "R0.b"],
				["R1.x", "R1.x"]
			]
		),
		b: surrogateGoneOrigins,
		c: surrogateGoneOrigins
	},
	true,
	{ toB: [], toC: [] }
)

/** B renames R0 to P0 with its field b retyped from int4 to text, the rename chosen. */
const retypedOrigins = statedOrigins(
	[["P0", "R0"]],
	[
		["P0.a", "R0.a"],
		["P0.b", "R0.b"]
	]
)

const retypedHolder = statedRelation(
	"P0",
	[
		{ name: "a", type: int4 },
		{ name: "b", type: scalarOfSpec({ carrier: "text" }) }
	],
	["a"],
	false
)

export const renamedWithRetype: StatedRenamedPath = plantedRename(
	{
		a: statedSchema([ints("R0", ["a", "b"], ["a"])], []),
		b: statedSchema([retypedHolder], []),
		c: statedSchema([retypedHolder], [])
	},
	{ R0: [two(1n, 2n)] },
	{
		a: statedOrigins(
			[["R0", "R0"]],
			[
				["R0.a", "R0.a"],
				["R0.b", "R0.b"]
			]
		),
		b: retypedOrigins,
		c: retypedOrigins
	},
	true,
	{ toB: ["relationRetyped"], toC: [] }
)

/** The value a reviewer supplies for a placeholder of a field of `type`: the first value of its domain, the same on
 * every run (domain.ts: class 0, first spelling). */
const typedDefault = (type: GenColumn["type"]): TypedLiteral =>
	resolveValue(type, { cls: 0, sp: 0 }, false)

/** The type of the column of `sq`, by its type: an integer as wide as its sequence, or a uuid. */
const serialColumnType: Readonly<Record<SqType, ScalarType>> = {
	serial: int4,
	bigserial: int8,
	uuidv7: scalarOfSpec({ carrier: "uuid" }),
	uuid: scalarOfSpec({ carrier: "uuid" })
}

/** The type of each physical column of a version's plan, by table and column: each oracle schema field's, and the
 * serial field's. */
const physicalTypes = (
	plan: RealInstallPlan,
	v: Version
): ReadonlyMap<string, ReadonlyMap<string, ScalarType>> => {
	const serials = serialRelations(v.schema, v.extras)
	const tables = new Map<string, ReadonlyMap<string, ScalarType>>()
	for (const r of v.schema.relations) {
		const table = defined(plan.tables[r.name], `the table of ${r.name}`)
		const column = (field: string) =>
			Option.getOrThrowWith(
				Arr.findFirst(table.columns, (c) => c.field === field),
				() => new Error(`the column of ${r.name}.${field}`)
			).column
		const serial = serials.get(r.name)
		tables.set(
			table.name.name,
			new Map([
				...Arr.map(r.columns, (c) => [column(c.name), c.type] as const),
				...(serial === undefined ? [] : [[column(serialField), serialColumnType[serial]] as const])
			])
		)
	}
	return tables
}

/** Whether a placeholder converts a column `to` declares serial to bigint, which holds every value of every integer
 * type: the reviewer converts such a column by its cast, so its values, and its identity's advance past them, carry
 * (carriedRow). The field `sq` is cast only from an integer, its type before by its relation's name in `to` (`sqBefore`):
 * no uuid casts to a bigint. */
const castsSerial = (
	to: { readonly plan: RealInstallPlan },
	sqBefore: SqBefore,
	p: Extract<Placeholder, { readonly kind: "placeholderRetype" }>
): boolean =>
	printType(p.column.type) === printType(sqlTypes.bigint) &&
	Arr.some(
		Rec.values(to.plan.tables),
		(t) =>
			t.name.schema === p.table.schema &&
			t.name.name === p.table.name &&
			Arr.some(
				t.columns,
				(c) =>
					c.column === p.column.name &&
					c.drawn.kind === "identity" &&
					(c.field !== serialField ||
						sqBefore(t.relation) === "serial" ||
						sqBefore(t.relation) === "bigserial")
			)
	)

/** The type of the field `sq` a relation of a migration's target held before it, by the relation's name in the target:
 * none where it held no `sq`. */
export type SqBefore = (relation: string) => SqType | undefined

/** The types of `sq` in `before`, read at each target relation through the renames that carry it (Renames: a target
 * relation's name to its name in `before`, the name it keeps where none renames it). */
export const sqBeforeOf =
	(before: Version, renames: Renames): SqBefore =>
	(relation) =>
		serialRelations(before.schema, before.extras).get(renames.relations.get(relation) ?? relation)

/** A migration whose target's relations held no `sq` before it: one whose versions declare no extras. */
export const noSq: SqBefore = () => undefined

/** The SQL a reviewer writes for each placeholder of a migration to `to` (planned under the migrated schema): a serial
 * column converted to bigint by its cast (castsSerial, `sq` by its type before, `sqBefore`), any other the typed default
 * of the type it is written for, a type of `to`'s columns. A placeholder of a type no column of `to` has is a defect of
 * the case, thrown. */
export const typedValue = (
	to: {
		readonly plan: RealInstallPlan
		readonly version: Version
	},
	sqBefore: SqBefore
): ((placeholder: Placeholder) => string) => {
	/** The target's scalar type of each physical type a target column has, by its printed SQL type: a placeholder carries
	 * the type it is written for, also when it converts a removed column under its removed names, as an enum rebuild's
	 * conversion a chosen candidate offers does. */
	const after = physicalTypes(to.plan, to.version)
	const byType = new Map(
		Arr.flatMap(Rec.values(to.plan.tables), (t) =>
			Arr.flatMap(t.columns, (c) => {
				const scalar = after.get(t.name.name)?.get(c.column)
				return scalar === undefined ? [] : [[printType(c.type.sql), scalar] as const]
			})
		)
	)
	const typeOf = (p: { readonly column: ColumnDef }) =>
		defined(
			byType.get(printType(p.column.type)),
			`the target's scalar type of ${printType(p.column.type)}`
		)
	return (p) => {
		switch (p.kind) {
			case "placeholderRetype":
				return castsSerial(to, sqBefore, p)
					? `${quoteIdent(p.column.name)}::${printType(p.column.type)}`
					: quoteString(
							inputText(typedDefault(typeOf(p)), typeOf(p), to.plan.installation.names.codes)
						)
			case "placeholderColumn":
				return quoteString(
					inputText(typedDefault(typeOf(p)), typeOf(p), to.plan.installation.names.codes)
				)
		}
	}
}

/** Whether a column of A converts to the serial field `bc` of B by its cast (typedValue castsSerial): B's field is a
 * bigint and A's column an integer, so the value carries. */
const castToSerial = (was: GenColumn, bc: GenColumn): boolean => {
	const from = fieldDescOf(was.type)
	const to = fieldDescOf(bc.type)
	return (
		to.kind === "pg" &&
		to.type === "bigint" &&
		from.kind === "pg" &&
		(from.type === "smallint" || from.type === "integer" || from.type === "bigint")
	)
}

export interface Carry {
	/** The facts loaded into A: A's generated facts lawful in A, whose carried forms are lawful in B. */
	readonly loaded: ValueFacts
	/** B's facts after the migration, by B relation. */
	readonly expected: ValueFacts
	/** The fields of B, `<relation>.<field>`, whose values the migration numbers: B declares each serial and its
	 * relation's rows in A hold no column of its name, so the draft adds it with its identity, which numbers the rows
	 * from 1 in the order the table is read. The model numbers them in its own order, so a numbered field's values are
	 * compared as a set (rowsSql). */
	readonly numbered: ReadonlySet<string>
	/** The relation of A each relation of B is carried from, by name: its rows in `expected` are the images of that one's
	 * rows in `loaded`, position by position. */
	readonly sources: ReadonlyMap<string, string>
}

/** Whether the field `bc` of B is numbered when the rows of A's relation `a` are carried into B's `b` (Carry.numbered). */
const isNumbered = (
	a: GenRelation,
	b: GenRelation,
	bc: GenColumn,
	renames: Renames,
	serial: ReadonlySet<string>
) => serial.has(`${b.name}.${bc.name}`) && Option.isNone(columnWas(a, b, bc, renames))

/** The column of A's relation `a` that B's field `bc` of `b` is: the field a chosen rename names, else the field of its
 * identifier, the column it is by name in the table A's relation became (a field spelt otherwise is the same column). */
const columnWas = (
	a: GenRelation,
	b: GenRelation,
	bc: GenColumn,
	renames: Renames
): Option.Option<number> => {
	const was = renames.columns.get(`${b.name}.${bc.name}`)
	return Arr.findFirstIndex(a.columns, (ac) =>
		was === undefined ? conversionOf(ac.name) === conversionOf(bc.name) : ac.name === was
	)
}

/**
 * The row of `a` carried into `b`, numbered `ordinal` among the carried rows; none where it holds a handle B's roster
 * removed, a hole B's domain refuses, which no reviewed data step keeps.
 */
const carriedRow = (
	a: GenRelation,
	b: GenRelation,
	row: LiteralRow,
	renames: Renames,
	serial: ReadonlySet<string>,
	ordinal: number
): LiteralRow | undefined => {
	const image = Arr.map(b.columns, (bc): TypedLiteral | undefined => {
		if (isNumbered(a, b, bc, renames, serial)) {
			return { kind: "int", value: BigInt(ordinal) }
		}
		/** The column of A the field is, where it keeps that column's type or is a serial field of B the reviewer casts
		 * it to (castToSerial), and the row's value in it. */
		const kept = Option.flatMap(
			Option.filter(
				Option.map(columnWas(a, b, bc, renames), (at) => ({
					at,
					was: defined(a.columns[at], `column ${at} of ${a.name}`)
				})),
				({ was }) =>
					sameType(was, bc) || (serial.has(`${b.name}.${bc.name}`) && castToSerial(was, bc))
			),
			({ at, was }) => Option.map(Arr.get(row, at), (value) => ({ was, value }))
		)
		const handles = rosterOf(bc.type)?.handles
		if (
			Option.isSome(kept) &&
			kept.value.value.kind === "handle" &&
			handles !== undefined &&
			!handles.includes(kept.value.value.handle)
		) {
			return undefined
		}
		return Option.isSome(kept) ? kept.value.value : typedDefault(bc.type)
	})
	const carried: Array<TypedLiteral> = []
	for (const v of image) {
		if (v === undefined) {
			return undefined
		}
		carried.push(v)
	}
	return carried
}

/** Whether `row` of `relation` names a kept row of its containment's target. */
const contains = (
	schema: GenSchema,
	relation: GenRelation,
	row: LiteralRow,
	kept: Readonly<Record<string, ReadonlyArray<LiteralRow>>>
): boolean => {
	const found = containmentFrom(schema, relation.name)
	if (Option.isNone(found)) {
		return true
	}
	const c = found.value
	const target = relationOf(schema, c.to.relation)
	if (Option.isNone(target)) {
		return false
	}
	const key = literalRowKey(row, keyIndices(relation, c.from.fields))
	const toCols = keyIndices(target.value, c.to.fields)
	return Arr.some(kept[target.value.name] ?? [], (t) => literalRowKey(t, toCols) === key)
}

/** The carry model of the header: removes rows of A until every carried form is lawful in B and A is lawful. A
 * chosen rename carries the renamed relation's rows, or the renamed field's values, and the relation of A a rename takes
 * to another name leaves its own name to a relation afresh; any other relation of B carries the rows of A's relation of
 * its name, which the draft keeps and changes in place, since a draft renames only what is declared, a field it adds
 * holding the reviewer's value. `serial` holds the fields B declares serial, `<relation>.<field>`.
 *
 * A's containments, in declaration order: a target precedes its source. */
export const carry = (
	av: Version,
	bv: Version,
	facts: ValueFacts,
	renames: Renames,
	serial: ReadonlySet<string>
): Carry => {
	const a = av.schema
	const b = bv.schema
	const loaded: Record<string, Array<LiteralRow>> = {}
	for (const r of a.relations) {
		loaded[r.name] = [...(facts[r.name] ?? [])]
	}
	/** The relations of A a rename takes to another name of B: each leaves its name, which holds a relation afresh
	 * unless a rename fills it. */
	const renamedAway = new Set(
		Arr.flatMap([...renames.relations], ([to, was]) => (to === was ? [] : [was]))
	)
	for (;;) {
		let removed = false
		for (const r of a.relations) {
			const rows = loaded[r.name] ?? []
			const kept = Arr.filter(rows, (row) => contains(a, r, row, loaded))
			if (kept.length !== rows.length) {
				removed = true
			}
			loaded[r.name] = kept
		}
		const expected: Record<string, Array<LiteralRow>> = {}
		const numbered = new Set<string>()
		const sources = new Map<string, string>()
		for (const br of b.relations) {
			const from = renames.relations.get(br.name)
			const carried =
				from !== undefined
					? relationOf(a, from)
					: renamedAway.has(br.name)
						? Option.none()
						: relationOf(a, br.name)
			const out: Array<LiteralRow> = []
			expected[br.name] = out
			if (Option.isNone(carried)) {
				continue
			}
			const ar = carried.value
			sources.set(br.name, ar.name)
			const counted = Arr.map(
				Arr.filter(br.columns, (bc) => isNumbered(ar, br, bc, renames, serial)),
				(bc) => bc.name
			)
			for (const f of counted) {
				numbered.add(`${br.name}.${f}`)
			}
			/** Whether a row's containment holds in B by the value the draft numbers it with, which depends on the order
			 * the table is read in: the model loads no such row. A numbered key a containment targets is no such case,
			 * since its values are the same set in every order. */
			const ordered = Option.exists(containmentFrom(b, br.name), (c) =>
				Arr.some(c.from.fields, (f) => counted.includes(f))
			)
			const rows = loaded[ar.name] ?? []
			const keep: Array<LiteralRow> = []
			for (const row of rows) {
				const image = carriedRow(ar, br, row, renames, serial, out.length + 1)
				if (image === undefined) {
					removed = true
					continue
				}
				const conflict = Arr.some(allKeys(br), (key) => {
					const cols = keyIndices(br, key)
					const k = literalRowKey(image, cols)
					return Arr.some(out, (other) => literalRowKey(other, cols) === k)
				})
				if (ordered || conflict || !contains(b, br, image, expected)) {
					removed = true
					continue
				}
				out.push(image)
				keep.push(row)
			}
			loaded[ar.name] = keep
		}
		if (!removed) {
			return { loaded, expected, numbered, sources }
		}
	}
}

/** A row's text, every column: two rows of one relation are one fact exactly when their texts are one. */
const rowText = (row: LiteralRow): string => literalRowKey(row, indices(row.length))

/** The carry model of a chain of two migrations, A to B to C, and A to C directly: removes rows of A until every carried
 * form is lawful in B, its image in B carried on to C is lawful in C, and A's rows carried to C directly are lawful in C,
 * each migration's validation being a reviewed data step. `renames` holds each migration's chosen renames; `serial` the
 * fields B and C declare serial. The result is the A to B carry of the rows so kept. */
export const carryChain = (
	versions: { readonly a: Version; readonly b: Version; readonly c: Version },
	facts: ValueFacts,
	renames: { readonly ab: Renames; readonly bc: Renames; readonly ac: Renames },
	serial: { readonly b: ReadonlySet<string>; readonly c: ReadonlySet<string> }
): Carry => {
	let loaded: ValueFacts = facts
	for (;;) {
		const ab = carry(versions.a, versions.b, loaded, renames.ab, serial.b)
		const bc = carry(versions.b, versions.c, ab.expected, renames.bc, serial.c)
		const ac = carry(versions.a, versions.c, ab.loaded, renames.ac, serial.c)
		/** Each row of A kept: carried to C directly, and its image in B, if it has one, carried on to C. */
		const next: Record<string, Array<LiteralRow>> = {}
		let removed = false
		for (const [relation, rows] of Rec.toEntries(ab.loaded)) {
			const direct = new Set(Arr.map(ac.loaded[relation] ?? [], rowText))
			const imageOf = Arr.findFirst(ab.sources, ([, from]) => from === relation)
			const images = Option.isNone(imageOf) ? undefined : (ab.expected[imageOf.value[0]] ?? [])
			const onward = Option.isNone(imageOf)
				? undefined
				: new Set(Arr.map(bc.loaded[imageOf.value[0]] ?? [], rowText))
			const kept = Arr.filter(rows, (row, i) => {
				const image = images?.[i]
				return (
					direct.has(rowText(row)) &&
					(onward === undefined || (image !== undefined && onward.has(rowText(image))))
				)
			})
			next[relation] = kept
			if (kept.length !== rows.length) {
				removed = true
			}
		}
		if (!removed) {
			return ab
		}
		loaded = next
	}
}

/** The codes a version's rosters hold, holes included, as its history drafted them (GenClosed.codes). */
const versionCodes = (v: Version): Codebook => ({
	rosters: new Map(
		Arr.map(
			v.schema.closed,
			(c) => [parsedName(c.name), rosterCodec(parsedName(c.name), c.codes)] as const
		)
	)
})

/** The installation plan of a version under `schema`, for its physical names and its fact statements: a fresh install
 * under the version's codes, so it installs every law and derived relation, as a draft's compilation does. */
export const planOf = (v: Version, schema: string, owner: string): RealInstallPlan => {
	const planned = planRealInstall(v.desc, {
		installation: identity.schema(parsedSchemaName(schema)),
		owner,
		logins: versionLogins(v),
		extensions: extensionsOf(v),
		codes: versionCodes(v),
		compile: compileInstallation
	})
	if (!planned.ok) {
		throw new Error(planned.error.message)
	}
	return planned.value
}

/** The rows of every relation of a version in `schema`, its fields in declaration order, each value as its output
 * function's text, sorted: a multiset that two installations of one version compare by. Each query is keyed by its
 * relation, or by `<relation>.<field>` for a numbered field's values. */
export const rowsSql = (
	plan: RealInstallPlan,
	v: Version,
	schema: string,
	numbered: ReadonlySet<string>
): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(v.schema.relations, (r) => {
		const table = plan.tables[r.name]
		if (table === undefined) {
			return []
		}
		const from = `${quoteIdent(schema)}.${quoteIdent(table.name.name)}`
		/** The oracle schema's fields only: a serial field's values are the sequence's, not the facts'. A numbered field
		 * (Carry.numbered) is read on its own, its values a set. */
		const fields = Arr.filter(table.columns, (c) => Arr.some(r.columns, (x) => x.name === c.field))
		const counted = (c: (typeof fields)[number]) => numbered.has(`${r.name}.${c.field}`)
		const cols = Arr.join(
			Arr.map(
				Arr.filter(fields, (c) => !counted(c)),
				(c) => `${quoteIdent(c.column)}::text`
			),
			", "
		)
		return [
			[r.name, `SELECT ${cols} FROM ${from}`] as const,
			...Arr.map(
				Arr.filter(fields, counted),
				(c) =>
					[`${r.name}.${c.field}`, `SELECT ${quoteIdent(c.column)}::text FROM ${from}`] as const
			)
		]
	})

/** Extras requesting extended statistics over two fields of a relation each, by position: the relation `relation` of a
 * version's `relations`, over its fields `first` and `second` of `fields`. */
interface StatisticsAt {
	readonly relation: number
	readonly relations: number
	readonly first: number
	readonly second: number
	readonly fields: number
}

const statisticsAt = (requests: ReadonlyArray<StatisticsAt>): Extras => ({
	...noExtras,
	statistics: Arr.map(requests, (r) => ({
		relation: pickOf(r.relation, r.relations),
		first: pickOf(r.first, r.fields),
		second: pickOf(r.second, r.fields)
	}))
})
const textField = scalarOfSpec({ carrier: "text" })
const fieldsOfR0 = (fields: ReadonlyArray<string>): Origins =>
	statedOrigins(
		[["R0", "R0"]],
		Arr.map(fields, (f) => [`R0.${f}`, `R0.${f}`] as const)
	)
const overAB = statisticsAt([{ relation: 0, relations: 1, first: 0, second: 1, fields: 2 }])
const retypedB = statedRelation(
	"R0",
	[
		{ name: "a", type: int4 },
		{ name: "b", type: textField }
	],
	["a"],
	false
)

/** B retypes R0's field b and no longer requests the statistics over a and b; C requests them again (statistics
 * over a retyped column created again over the wrong column, or lost). The generated paths found it with B swapping two fields of
 * two types, each retyped. */
export const statisticsOverRetyped: StatedRenamedPath = plantedRenameWith(
	{
		a: statedSchema([ints("R0", ["a", "b"], ["a"])], []),
		b: statedSchema([retypedB], []),
		c: statedSchema([retypedB], [])
	},
	{ a: overAB, b: noExtras, c: overAB },
	{ R0: [two(1n, 2n)] },
	{ a: fieldsOfR0(["a", "b"]), b: fieldsOfR0(["a", "b"]), c: fieldsOfR0(["a", "b"]) },
	false,
	{ toB: [], toC: [] }
)

/** B renames R0, with statistics over a and b and over a and c, to P0, chosen, which requests the first alone; C declares
 * a new R0 with both (statistics created again on the wrong table, or not at all). */
const renamedRelationOrigins = (relations: ReadonlyArray<string>) =>
	statedOrigins(
		Arr.map(relations, (r) => [r, "R0"] as const),
		Arr.flatMap(relations, (r) =>
			Arr.map(["a", "b", "c"], (f) => [`${r}.${f}`, `R0.${f}`] as const)
		)
	)

const overABandAC = (relation: number, relations: number): ReadonlyArray<StatisticsAt> => [
	{ relation, relations, first: 0, second: 1, fields: 3 },
	{ relation, relations, first: 0, second: 2, fields: 3 }
]

export const statisticsOfRenamedRelation: StatedRenamedPath = plantedRenameWith(
	{
		a: statedSchema([ints("R0", ["a", "b", "c"], ["a"])], []),
		b: statedSchema([ints("P0", ["a", "b", "c"], ["a"])], []),
		c: statedSchema([ints("P0", ["a", "b", "c"], ["a"]), ints("R0", ["a", "b", "c"], ["a"])], [])
	},
	{
		a: statisticsAt(overABandAC(0, 1)),
		b: statisticsAt([{ relation: 0, relations: 1, first: 0, second: 1, fields: 3 }]),
		c: statisticsAt([
			{ relation: 0, relations: 2, first: 0, second: 1, fields: 3 },
			...overABandAC(1, 2)
		])
	},
	{ R0: [[...one(1n), ...two(2n, 3n)]] },
	{
		a: renamedRelationOrigins(["R0"]),
		b: renamedRelationOrigins(["P0"]),
		c: renamedRelationOrigins(["P0", "R0"])
	},
	true,
	{ toB: ["relation"], toC: [] }
)

/** A roster stated by its handles (statedRoster), carrying the text payload t, each handle's value its position. */
const payloadRoster = (name: string, handles: Arr.NonEmptyReadonlyArray<string>): GenClosed => ({
	...statedRoster(name, handles),
	payload: [{ name: "t", type: textField }],
	rows: Arr.map(handles, (handle, i): ReadonlyArray<TypedLiteral> => [
		{ kind: "handle", handle },
		{ kind: "text", value: `${i}` }
	])
})

const payloadRosterOrigins = (relation: string) =>
	statedOrigins([[relation, "R0"]], [[`${relation}.a`, "R0.a"]])

/** A's roster K0 and B's added K1 each carry a text payload, which a version's description declares as the roster's
 * closed relation (oracle/gen/schema.ts payloadPatterns), and B renames R0 to P0, chosen: every version's worlds hold
 * those closed relations as the version's admission made them. The generated paths found it with two such rosters in
 * A, a third added in B and one restored in C. */
export const payloadRostersRenamed: StatedRenamedPath = plantedRename(
	{
		a: statedSchema([ints("R0", ["a"], ["a"])], [payloadRoster("K0", ["Open", "Shut"])]),
		b: statedSchema(
			[ints("P0", ["a"], ["a"])],
			[payloadRoster("K0", ["Open", "Shut"]), payloadRoster("K1", ["Low"])]
		),
		c: statedSchema(
			[ints("P0", ["a"], ["a"])],
			[payloadRoster("K0", ["Open", "Shut"]), payloadRoster("K1", ["Low"])]
		)
	},
	{ R0: [one(1n)] },
	{ a: payloadRosterOrigins("R0"), b: payloadRosterOrigins("P0"), c: payloadRosterOrigins("P0") },
	true,
	{ toB: ["relation"], toC: [] }
)

/** The adversarial rename generator: named rename intents over a hazard base.
 *
 * The base A holds one of each hazard: the roster K0 of six handles; R0 keyed by k, with a handle a of K0 and an
 * integer b under a bound check; and R1 keyed by id, whose r is contained in R0's key (a foreign key on a key) and whose
 * c sits beside r under extended statistics over (r, c), with a serial field. B applies one intent or more to A, and C
 * one intent or none to B. An intent names its target by origin (Origins), never by name, so intents compose: each
 * renames whatever name its target has by then, and every name an intent gives is fresh (its step's prefix and its
 * position), so no intent is a silent no-op. The legal intents:
 *
 * - renameReferenced, renameReferencing: R0, which R1's containment references, or R1, renamed;
 * - swapRelations: R0 and R1 exchange names; chainRelations: R1 renamed afresh and R0 renamed to R1's old name;
 * - renameKeyField: R0's key field k, which the containment references, renamed;
 * - swapFields: R1's contained r and its c, under statistics, exchange names;
 * - retypeKey: R0's key k and R1's r, the two sides of the containment, widened to int8 (a key over retyped columns);
 * - renameRetyped: R1's c renamed with its type widened; relationAndField: R1 renamed and its c renamed with it;
 * - renameRoster: K0 renamed, which no step declares, so it drafts K0's drop and a new roster (installedVersions);
 * - removeLastHandle: K0's last handle removed, its code a hole R0's a then refuses;
 * - retypeRosterField: R0's a, of K0, retyped to an integer, a code column converted to the integer it holds;
 * - hop: K0 renamed afresh and R1 renamed to K0's old name, a name hopping across the relation and type namespaces;
 * - retypeSerial: R1's serial field, an integer serial, widened to bigserial; no uuid widens;
 * - sqUuidv7, sqSerial, sqUuid: R1's field `sq` retyped to a pg.uuidv7, a serial or a uuid its caller writes, which
 *   converts an integer serial to a uuidv7 and back, and declares a uuid's `uuidv7()` draw in place and removes it;
 * - retypedOffRebuilt, relationRetypedOffRebuilt: K0's last handle removed while R0's a, of K0, is renamed with its
 *   type changed to an integer, or while R0 is renamed with a so retyped: one conversion of a code column, whichever
 *   way the reviewer decides.
 *
 * And, at the path's level, takeDropped: B drops R1's c, and C renames R1's r to the name B dropped; and
 * freshRelations: whether the names intents give relations sort before the base's or after them (FreshRelations).
 *
 * The invalid and ambiguous intents are named cases with their own outcome, never filtered away:
 *
 * - ontoTaken: R1 renamed to R0's name while R0 keeps it, which the schema boundary refuses;
 * - ambiguousPair: R1 removed and two relations of its heading added, so the draft offers both as candidates for R1's
 *   rename, and a reviewer may choose at most one: `grizzle check` refuses two. */
export const legalIntents = [
	"renameReferenced",
	"renameReferencing",
	"swapRelations",
	"chainRelations",
	"renameKeyField",
	"swapFields",
	"retypeKey",
	"renameRetyped",
	"relationAndField",
	"renameRoster",
	"removeLastHandle",
	"retypeRosterField",
	"hop",
	"retypeSerial",
	"sqUuidv7",
	"sqSerial",
	"sqUuid",
	"retypedOffRebuilt",
	"relationRetypedOffRebuilt"
] as const
export type LegalIntentKind = (typeof legalIntents)[number]

/** One legal intent. */
export type LegalIntent = { readonly kind: LegalIntentKind }

/** Where the fresh names intents give relations sort against the base's R0 and R1: before them, each its step's
 * letter and its position (Q0 in B, P0 in C), or after them, T before the same (TQ0, TP0). The draft plans and drafts
 * the relations in the target's install order, which follows their names, so this decides whether a renamed
 * relation's candidate comes before a kept relation's field candidates or after them, and with it which of two
 * candidates' alternatives that drop one constraint runs first. */
export type FreshRelations = "before" | "after"

const relationLead: { readonly [F in FreshRelations]: string } = { before: "", after: "T" }

/** A path of intents as the generator draws it: legal intents for B and C, maybe B's dropped name taken in C, whether
 * the reviewer chooses, and where the relations' fresh names sort; or one of the named invalid and ambiguous cases. */
export type IntentSketch =
	| {
			readonly kind: "legal"
			readonly toB: readonly [LegalIntent, ...Array<LegalIntent>]
			readonly toC: ReadonlyArray<LegalIntent>
			readonly takeDropped: boolean
			readonly choose: boolean
			readonly freshRelations: FreshRelations
	  }
	| { readonly kind: "ontoTaken" }
	| { readonly kind: "ambiguousPair" }

/** The intents that name R1's c, which a path whose B drops it (takeDropped) cannot make in C. */
const namingDropped: ReadonlySet<LegalIntentKind> = new Set([
	"swapFields",
	"renameRetyped",
	"relationAndField"
])

/**
 * A legal intent among `kinds`, each kind as likely as any other, so every intent a suite requires is drawn as often as
 * the rest.
 */
const legalIntentGen =
	(kinds: Arr.NonEmptyReadonlyArray<LegalIntentKind>): Gen<LegalIntent> =>
	(source) => ({ kind: source.draw(element(kinds)) })
const everyIntentGen = legalIntentGen(legalIntents)
const keptNameIntentGen = legalIntentGen(
	nonEmptyList(
		Arr.filter(legalIntents, (k) => !namingDropped.has(k)),
		"the intents that name no dropped field"
	)
)

/** A legal path of intents: one to three for B, none to two for C, which make no intent naming R1's c when B drops it. */
export const legalIntentSketchGen: Gen<IntentSketch & { readonly kind: "legal" }> = (source) => {
	const takeDropped = source.draw(boolean)
	return {
		kind: "legal",
		toB: [source.draw(everyIntentGen), ...source.draw(array(everyIntentGen, { min: 0, max: 2 }))],
		toC: source.draw(array(takeDropped ? keptNameIntentGen : everyIntentGen, { min: 0, max: 2 })),
		takeDropped,
		choose: source.draw(boolean),
		freshRelations: source.draw(element(["before", "after"] as const))
	}
}

/** Six handles, so every rebuild a path draws (five at most) leaves one. */
const baseRoster = statedRoster("K0", ["H0", "H1", "H2", "H3", "H4", "H5"])
const hazardBase: GenSchema = {
	...statedSchema(
		[
			statedRelation(
				"R0",
				[
					{ name: "k", type: int4 },
					{ name: "a", type: closedIdType(baseRoster) },
					{ name: "b", type: int4 }
				],
				["k"],
				false
			),
			statedRelation(
				"R1",
				[
					{ name: "id", type: int4 },
					{ name: "r", type: int4 },
					{ name: "c", type: int4 }
				],
				["id"],
				false
			)
		],
		[baseRoster]
	),
	containments: [containedIn("R1", "r", "R0", "k")]
}

/** The extras with every field `sq` retyped to `type`. */
const sqRetyped = (extras: Extras, type: SqType): Extras => ({
	...extras,
	serials: Arr.map(extras.serials, (s) => ({ ...s, type }))
})

/** A conversion of `sq` between two versions, at one relation of both: one of the four a uuidv7 draw makes. */
export type SqConversion =
	| "an integer serial to a uuidv7"
	| "a uuidv7 to an integer serial"
	| "a uuid to a uuidv7"
	| "a uuidv7 to a uuid"

/** The conversions of `sq` from `from` to `to`, at each relation of both by its name. */
export const sqConversions = (from: Version, to: Version): ReadonlyArray<SqConversion> => {
	const before = serialRelations(from.schema, from.extras)
	return Arr.flatMap(
		[...serialRelations(to.schema, to.extras)],
		([relation, now]): ReadonlyArray<SqConversion> => {
			const was = before.get(relation)
			const integer = (type: SqType | undefined) => type === "serial" || type === "bigserial"
			return integer(was) && now === "uuidv7"
				? ["an integer serial to a uuidv7"]
				: was === "uuidv7" && integer(now)
					? ["a uuidv7 to an integer serial"]
					: was === "uuid" && now === "uuidv7"
						? ["a uuid to a uuidv7"]
						: was === "uuidv7" && now === "uuid"
							? ["a uuidv7 to a uuid"]
							: []
		}
	)
}

/** A bound check on R0's b, statistics over R1's r and c, and R1's serial field. */
const hazardExtras = (big: boolean): Extras => ({
	...noExtras,
	checks: [{ relation: 0, column: 2, lower: true }],
	statistics: [{ relation: 1, first: 1, second: 2 }],
	serials: [{ relation: 1, type: big ? "bigserial" : "serial" }]
})

const hazardFacts: ValueFacts = {
	R0: [
		[
			{ kind: "int", value: 1n },
			{ kind: "handle", handle: "H0" },
			{ kind: "int", value: 2n }
		]
	],
	R1: [
		[
			{ kind: "int", value: 1n },
			{ kind: "int", value: 1n },
			{ kind: "int", value: 3n }
		]
	]
}

/** The relation, and a field of it, a version holds of an origin. */
const relationOfOrigin = (t: TracedSchema, origin: string): GenRelation =>
	Option.getOrThrowWith(
		Arr.findFirst(t.schema.relations, (r) => t.origins.relations.get(r.name) === origin),
		() => new Error(`the relation of origin ${origin}`)
	)

const fieldOfOrigin = (
	t: TracedSchema,
	origin: string,
	field: string
): { readonly relation: GenRelation; readonly field: string } => {
	const relation = relationOfOrigin(t, origin)
	const name = Arr.findFirst(
		relation.columns,
		(c) => t.origins.columns.get(`${relation.name}.${c.name}`) === `${origin}.${field}`
	)
	return {
		relation,
		field: Option.getOrThrowWith(name, () => new Error(`the field of origin ${origin}.${field}`))
			.name
	}
}

/** A field's type changed in place, by its current names. */
const retypedField = (
	t: TracedSchema,
	relation: string,
	field: string,
	type: ScalarType
): TracedSchema => ({
	...t,
	schema: {
		...t.schema,
		relations: Arr.map(t.schema.relations, (r) =>
			r.name === relation
				? { ...r, columns: Arr.map(r.columns, (c) => (c.name === field ? { ...c, type } : c)) }
				: r
		)
	}
})

/** The roster K0, renamed to `to`, which every field of it follows. */
const rosterRenamedTo = (t: TracedSchema, to: string): TracedSchema => {
	const closed = defined(t.schema.closed[0], "the roster of the hazard base")
	const renamedTo = { ...closed, name: to }
	const roster = (type: GenRelation["columns"][number]["type"]) =>
		rosterOf(type)?.closed === closed.name ? closedIdType(renamedTo) : type
	return {
		...t,
		schema: {
			...t.schema,
			closed: [renamedTo, ...t.schema.closed.slice(1)],
			relations: Arr.map(t.schema.relations, (r) => ({
				...r,
				columns: Arr.map(r.columns, (c) => ({ ...c, type: roster(c.type) }))
			}))
		}
	}
}

/** What one legal intent does to a version and its extras; `fresh` is a name no other intent of the path gives. */
const applyIntent = (
	v: { readonly t: TracedSchema; readonly extras: Extras },
	intent: LegalIntent,
	fresh: {
		readonly relation: string
		readonly field: string
		readonly roster: string
		readonly handle: string
	}
): { readonly t: TracedSchema; readonly extras: Extras } => {
	const { t, extras } = v
	const step = (next: TracedSchema) => ({ t: next, extras })
	switch (intent.kind) {
		case "renameReferenced":
			return step(renameRelation(t, relationOfOrigin(t, "R0"), fresh.relation))
		case "renameReferencing":
			return step(renameRelation(t, relationOfOrigin(t, "R1"), fresh.relation))
		case "swapRelations":
			return step(
				renameNames(
					t,
					swap(relationOfOrigin(t, "R0").name, relationOfOrigin(t, "R1").name),
					undefined
				)
			)
		case "chainRelations": {
			const was = relationOfOrigin(t, "R1").name
			const away = renameRelation(t, relationOfOrigin(t, "R1"), fresh.relation)
			return step(renameRelation(away, relationOfOrigin(away, "R0"), was))
		}
		case "renameKeyField": {
			const k = fieldOfOrigin(t, "R0", "k")
			return step(renameField(t, k.relation, k.field, fresh.field))
		}
		case "swapFields": {
			const r = fieldOfOrigin(t, "R1", "r")
			const c = fieldOfOrigin(t, "R1", "c")
			return step(
				renameNames(t, (name) => name, {
					relation: r.relation.name,
					rename: swap(r.field, c.field)
				})
			)
		}
		case "retypeKey": {
			const k = fieldOfOrigin(t, "R0", "k")
			const r = fieldOfOrigin(t, "R1", "r")
			return step(
				retypedField(
					retypedField(t, k.relation.name, k.field, int8),
					r.relation.name,
					r.field,
					int8
				)
			)
		}
		case "renameRetyped": {
			const c = fieldOfOrigin(t, "R1", "c")
			const renamedC = renameField(t, c.relation, c.field, fresh.field)
			return step(retypedField(renamedC, c.relation.name, fresh.field, int8))
		}
		case "relationAndField": {
			const c = fieldOfOrigin(t, "R1", "c")
			const renamedC = renameField(t, c.relation, c.field, fresh.field)
			return step(renameRelation(renamedC, relationOfOrigin(renamedC, "R1"), fresh.relation))
		}
		case "renameRoster":
			return step(rosterRenamedTo(t, fresh.roster))
		case "removeLastHandle":
			return step(lastHandleRemoved(t, 0))
		case "retypeRosterField": {
			const a = fieldOfOrigin(t, "R0", "a")
			return step(retypedField(t, a.relation.name, a.field, int4))
		}
		case "hop": {
			const was = defined(t.schema.closed[0], "the roster of the hazard base").name
			const away = rosterRenamedTo(t, fresh.roster)
			return step(renameRelation(away, relationOfOrigin(away, "R1"), was))
		}
		case "retypeSerial":
			return {
				t,
				extras: {
					...extras,
					serials: Arr.map(extras.serials, (s) => ({
						...s,
						type: s.type === "serial" ? "bigserial" : s.type
					}))
				}
			}
		case "sqUuidv7":
			return { t, extras: sqRetyped(extras, "uuidv7") }
		case "sqSerial":
			return { t, extras: sqRetyped(extras, "serial") }
		case "sqUuid":
			return { t, extras: sqRetyped(extras, "uuid") }
		case "retypedOffRebuilt": {
			const shortened = lastHandleRemoved(t, 0)
			const a = fieldOfOrigin(shortened, "R0", "a")
			const renamedA = renameField(shortened, a.relation, a.field, fresh.field)
			return step(retypedField(renamedA, a.relation.name, fresh.field, int4))
		}
		case "relationRetypedOffRebuilt": {
			const shortened = lastHandleRemoved(t, 0)
			const a = fieldOfOrigin(shortened, "R0", "a")
			const retypedA = retypedField(shortened, a.relation.name, a.field, int4)
			return step(renameRelation(retypedA, relationOfOrigin(retypedA, "R0"), fresh.relation))
		}
	}
}

/** The intents of one step applied in order, each given fresh names by its step's prefix and its position, a
 * relation's sorting against the base's as `fresh` says. */
const applyIntents = (
	v: { readonly t: TracedSchema; readonly extras: Extras },
	intents: ReadonlyArray<LegalIntent>,
	prefix: string,
	fresh: FreshRelations
): { readonly t: TracedSchema; readonly extras: Extras } =>
	Arr.reduce(intents, v, (at, intent, n) =>
		applyIntent(at, intent, {
			relation: `${relationLead[fresh]}${Str.toUpperCase(prefix)}${n}`,
			field: `${prefix}${n}`,
			roster: `${Str.toUpperCase(prefix)}${n}K`,
			handle: `${Str.toUpperCase(prefix)}${n}`
		})
	)

/** The rename kind of the shared features (RenamedPath renames) closest to an intent. */
const intentRenameKinds: { readonly [K in LegalIntentKind]: ReadonlyArray<RenameKind> } = {
	renameReferenced: ["relation"],
	renameReferencing: ["relation"],
	swapRelations: ["swapRelations"],
	chainRelations: ["relation"],
	renameKeyField: ["column"],
	swapFields: ["swapColumns"],
	retypeKey: [],
	renameRetyped: ["retyped"],
	relationAndField: ["relation", "column"],
	renameRoster: ["closed"],
	removeLastHandle: ["removeHandle"],
	retypeRosterField: [],
	hop: ["hop"],
	retypeSerial: [],
	sqUuidv7: [],
	sqSerial: [],
	sqUuid: [],
	retypedOffRebuilt: ["retyped", "removeHandle"],
	relationRetypedOffRebuilt: ["relationRetyped", "removeHandle"]
}

const renameKindsOf = (intents: ReadonlyArray<LegalIntent>): ReadonlyArray<RenameKind> =>
	Arr.flatMap(intents, (i) => intentRenameKinds[i.kind])

/** A legal path of intents resolved: its stated path, and the intents it made. */
const legalIntentPath = (
	sketch: IntentSketch & { readonly kind: "legal" }
): { readonly path: StatedRenamedPath; readonly intents: ReadonlyArray<LegalIntent> } => {
	const a: TracedSchema = { schema: hazardBase, origins: ownOrigins(hazardBase) }
	const extrasA = hazardExtras(false)
	const b = applyIntents({ t: a, extras: extrasA }, sketch.toB, "q", sketch.freshRelations)
	const dropped = fieldOfOrigin(b.t, "R1", "c")
	/** takeDropped: B drops R1's c, whose statistics and origin go with it, and C renames R1's r to c. */
	const bDropped = sketch.takeDropped
		? {
				t: {
					schema: {
						...b.t.schema,
						relations: Arr.map(b.t.schema.relations, (r) =>
							b.t.origins.relations.get(r.name) === "R1"
								? {
										...r,
										columns: Arr.filter(
											r.columns,
											(c) => b.t.origins.columns.get(`${r.name}.${c.name}`) !== "R1.c"
										)
									}
								: r
						)
					},
					origins: {
						relations: b.t.origins.relations,
						columns: new Map(
							Arr.filter([...b.t.origins.columns], ([, origin]) => origin !== "R1.c")
						)
					}
				},
				extras: { ...b.extras, statistics: [] }
			}
		: b
	const c = applyIntents(bDropped, sketch.toC, "p", sketch.freshRelations)
	const r = fieldOfOrigin(c.t, "R1", "r")
	const cTaken = sketch.takeDropped
		? { ...c, t: renameField(c.t, r.relation, r.field, dropped.field) }
		: c
	return {
		path: {
			path: {
				a: hazardBase,
				b: bDropped.t.schema,
				c: cTaken.t.schema,
				extras: { a: extrasA, b: bDropped.extras, c: cTaken.extras },
				facts: hazardFacts,
				spelling: firstSpellings,
				edits: { toB: [], toC: [] }
			},
			origins: { a: a.origins, b: bDropped.t.origins, c: cTaken.t.origins },
			choose: sketch.choose,
			chained: true,
			renames: { toB: renameKindsOf(sketch.toB), toC: renameKindsOf(sketch.toC) }
		},
		intents: [...sketch.toB, ...sketch.toC]
	}
}

/** A legal path of intents as a renamed path. */
export const resolveLegalIntents = (
	sketch: IntentSketch & { readonly kind: "legal" }
): RenamedPath => statedRenamed(legalIntentPath(sketch).path)
