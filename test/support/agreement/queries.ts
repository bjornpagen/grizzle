import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import {
	Array as Arr,
	Effect,
	Result as EffectResult,
	Option,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { pageRequest } from "#adapter/page/request.ts"
import { requireGet } from "#compiler/analysis/logical/get.ts"
import { cursorCodec, cursorTokenMaxLength } from "#compiler/codec/cursor/codec.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileReason } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type KeyClasses, type KeyProof, keyFactors } from "#compiler/ir/keys.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Card } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { compilePage, statedOrderOf } from "#compiler/lower/shapes/page/compile.ts"
import { type QueryTemplate, queryInput } from "#compiler/program/compile.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { date, pg, uuid, Vector } from "#compiler/public/fields.ts"
import { keyLookup } from "#compiler/query/build/key.ts"
import { isQueryValue, queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import {
	type AdmissionCell,
	admissionCells,
	admissionModule,
	admissionSize,
	combinatorCells,
	scopeCells
} from "#test/support/agreement/admission.ts"
import { argumentCells, argumentModule } from "#test/support/agreement/arguments.ts"
import {
	columnFacts,
	groupFields,
	paramsType,
	recordType
} from "#test/support/agreement/heading.ts"
import {
	Agree,
	Batch,
	byOwner,
	Cell,
	Cents,
	Item,
	ItemTones,
	Note,
	Owned,
	OwnerCounts,
	Reader,
	Reporter,
	Rollup,
	Slot,
	Stray,
	Tag,
	Tone,
	Tones,
	ToneWeight
} from "#test/support/agreement/schema.ts"
import { defined } from "#test/support/assert.ts"
import { codebookFor, compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import { admittedNames, refusedNames } from "#test/support/kernel/dict.ts"
import { argumentsOf } from "#test/support/list.ts"
import { messageOf } from "#test/support/message.ts"
import {
	identifiers,
	preludeAt,
	type PreludeAt,
	preludeFrom,
	preludeImports,
	preludeProgram
} from "#test/support/prelude.ts"

/**
 * The type/engine agreement: queries drawn over the agreement schema (./schema.ts), each with the engine's verdict on
 * it, and the one TypeScript program that states every verdict as a type assertion, which the type tier checks
 * (test/types/evidence/agreement.test.ts). The engine is the oracle: a drawn query typechecks exactly when the engine
 * compiles it, db.get accepts exactly what the engine proves at most one row per binding, every key the types claim is
 * one the engine proves, its cardinality is the engine's, and the records the types infer, of a snapshot read and of
 * db.execute and db.get, are the engine's decoded heading (./heading.ts), as are its parameters.
 *
 * A query is drawn as data (QuerySpec) and read twice: rendered as TypeScript source for the program, and built through
 * the query builder's JavaScript view (queryOver, varsOver, computeCore) for the engine, which compiles it as the
 * runtime does (snapshot context, rows) and reads the root of its analyzed DAG: whether get may read it
 * (analysis/logical/get.ts requireGet), its cardinality and its minimal keys; each arm, built and compiled alone, gives
 * its heading group's decoded record. Both readings walk one spec construct by construct, so the program and the engine
 * see one query.
 *
 * Two populations share the generator. The clean one plants no fault: the floor's witnesses (floorPopulation), the
 * same in every run, which alone meet the required constructs, and the run's own stream (agreementCases samples it from
 * the run's seed), new every run. The faulted one (faultCases) plants one fault per case at a site the generator draws
 * (Fault): a scope's name drawn from the declared-name dictionary, or left out, or spelled through a `string`; a
 * binding of a name drawn from every relation's fields and a stranger; a match of Stray, which Agree does not hold; a
 * fold whose match keeps the keys it binds as drawn; a second arm of another heading whose fields are named as the
 * first's; a relation parameter of no field, or one taking its heading from Stray; Owned matched unbound; an Allen
 * predicate over a term that is no span; a head's cosine distance from Slot's embedding to a vector of other
 * dimensions, or to an integer, beside the same vector; an Allen predicate, a point's test or a producer over Slot's
 * spans of two endpoint types, beside one of one; r.pack over a drawn variable; a span producer beside a second one
 * or an aggregate; an approximate search ranking by a name drawn among the head's, its distance drawn to a query
 * vector or to a column, or over a head that also counts or produces spans; and a take ordered by a name drawn among
 * the heading's and others. The engine decides each: where it refuses, the program states the refusal its reason is,
 * at the fault's site (refusalOf), under the directive the type-test batch disarms; where it admits, the program
 * states every verdict as for a clean query. A name spelled through a `string` is the one fault no engine sees, since
 * every value a `string` holds at run time is a literal: the types refuse the widening of every name the engine
 * admits, so two scopes never share a type.
 *
 * Each case first draws a swarm over the constructs (@grizzle/testing/swarm), then its query construct by construct:
 * the swarm turns constructs off for a whole case and thins the rest, so the forms that crowd others out are left out
 * of some cases and the rest combine. Each constant's construct is drawn at a place every case visits, so a case whose
 * swarm keeps it holds it and the floor reaches it by construction: a constant of Tone through the rule's anchor
 * (Anchor), a handle discriminant before the union's own gates, a constant at Tones as the rule's last match. So is a
 * self-join whose get the engine proves (pinnedSelfJoin), drawn as a rule's second match: two scopes of one relation,
 * each with a key bound to values fixed per binding, in a query of no other arm, which reaches the pair a repeat and a
 * proved get make (agreementPairs) wherever the swarm keeps it.
 *
 * A constant stands in every term position: a JavaScript value (`literal`), Tone's handle (`handle`) at Item.tone in a
 * binding, a filter, first in a comparison, a head, a union's discriminant and a binding at Tones, the union source of
 * ./schema.ts, whose arm it selects, and a typed constant (`constant`), `Compute.literal(pg.integer, v)` where its
 * value never reaches the evidence (Compute operands, a conditional's branch) and `Compute.literal(Cents, v)` where it
 * stands for a value of Item.cost: its type keeps its descriptor's whole host type, the one approximation of a typed
 * constant's value, so the evidence never reads it.
 *
 * Slot's spans are variables like any other, of a kind per endpoint type (integer, bigint, Cents and calendar dates),
 * which only a span parameter stands for. A rule's span and vector constructs are drawn where every rule visits, each
 * with the match of Slot it reads appended, its span of dates and its date where the swarm keeps dateSpan: an Allen
 * predicate under a drawn mask, and a point's test of a value of a span's endpoint type, each over a span variable and a
 * span variable or parameter; one producer in the head (r.intersection, r.difference over the same operands, r.pack
 * over a variable); a span's width (Compute.width), a count of days over dates and an exact integer otherwise; a cosine
 * distance from Slot's embedding to a vector parameter, a vector value or a column; and the embedding itself in the
 * head. The vectors are no binding's draw, so no filter reads them. A query whose swarm keeps nearest is drawn in the
 * shape an approximate search ranks, and searched (approximateNearest): one arm whose head holds no aggregate, no
 * producer and a distance to a query vector, which the search ranks by; its records, parameters and evidence are the
 * engine's, as every query's are.
 *
 * A rule's sources are Agree's relations, its roster Tone and its closed relation ToneWeight, and Rollup's derived
 * relations, keyed as their definitions prove; a query matching or negating a derived relation is over Rollup
 * (schemaOf). Each case reads through the Db of a full role, Reader over Agree or Reporter over Rollup, which reads its
 * query exactly where the runtime's compilation against the role does (readsThrough): Reporter reads queries over Agree,
 * and Reader refuses one over Rollup, its get and execute under their directives. Each clean case also states a keyed
 * get (keyedOf): through a relation's primary key, Item's candidate key, the closed relation's key or the roster's id,
 * its values named exactly the key's fields, those and one more, all but one, or all but one and one more in its
 * place, admitted exactly where the names hold the engine's key fields (query/build/key.ts keyLookup), as the runtime
 * reads them, its row the keyed relation's decoded fact.
 *
 * A query no take closes and of one heading is also paged (pageOf): ordered by its first head field, as db.page
 * compiles it, its page is of that very ordered query (Page<records, typeof ordered>, whatever the types infer of its
 * parameters on the way), its error channel ReadError | CursorError, the query unordered is refused a page as the
 * engine reads no stated order of it, and a page request drawn valid, of a shape the runtime refuses, or with an anchor
 * null, undefined or a plain string is admitted exactly where the runtime admits it: its shape where its request reader
 * does (adapter/page/request.ts pageRequest), and a plain string's anchor where the page's cursor codec decodes it
 * (adapter/page/template.ts pageRuntimeOf). Each page is also read through a compiled handle of the ordered query,
 * its type and verdict the same. A cursor anchor is another query's, a module's PageCursor<unknown>, which the types and
 * the request reader admit and the page's codec refuses by the query it was made for: a declared class, the request's
 * shape admitted. An approximate search is no page's.
 *
 * The clean program is emitted twice, in the drawn order and in a second drawn order, as two modules, and a third
 * asserts every query's head and keys equal across the two: TypeScript's evaluation of the evidence must not depend on
 * the order of unrelated statements. A fourth module is the admission agreement (./admission.ts), and a fifth the
 * faulted population.
 */

/** The constructs a drawn query may use, each a swarm feature. */
export const agreementFeatures = [
	"ownVar",
	"join",
	"foreignVar",
	"param",
	"literal",
	"omit",
	"computedBinding",
	"secondMatch",
	"thirdMatch",
	"repeat",
	"pinnedSelfJoin",
	"fixFilter",
	"computedFix",
	"varEquality",
	"rangeFilter",
	"computeFilter",
	"conjunction",
	"disjunction",
	"negation",
	"flaggedEither",
	"flaggedSpread",
	"headVar",
	"computedHead",
	"condHead",
	"literalHead",
	"paramHead",
	"constantBinding",
	"constantFirst",
	"constantFilter",
	"constantHead",
	"handleDiscriminant",
	"constantAtUnionSource",
	"relationParam",
	"rowsRelation",
	"boundImport",
	"interiorStage",
	"aggregate",
	"groupTerm",
	"sum",
	"minMax",
	"mean",
	"union",
	"discriminant",
	"heterogeneous",
	"take",
	"namedTake",
	"allen",
	"pointIn",
	"spanOperand",
	"spanParam",
	"producer",
	"intersection",
	"difference",
	"pack",
	"cosine",
	"cosineParam",
	"cosineVector",
	"cosineColumns",
	"vectorHead",
	"nearest",
	"reporterDb",
	"dateSpan",
	"width"
] as const
export type AgreementFeature = (typeof agreementFeatures)[number]

/**
 * The faults a faulted case plants, one per case: a site whose drawn value the engine may refuse (or, for widenedName,
 * a spelling no engine sees).
 */
export const agreementFaults = [
	"scopeName",
	"unnamedScope",
	"widenedName",
	"stranger",
	"stray",
	"unkeyedFold",
	"unionTypes",
	"emptyRelation",
	"strayRows",
	"unboundImport",
	"allenTerm",
	"cosineDims",
	"cosineTerm",
	"orderHidden",
	"spanEndpoints",
	"packTerm",
	"producerHead",
	"nearestBy",
	"nearestSource"
] as const
export type Fault = (typeof agreementFaults)[number]

/** What a case plants: no fault, or one. */
type Planted = "clean" | Fault

/** What a drawn case reached: its constructs, and the engine's verdict on it. */
export type AgreementNote =
	| AgreementFeature
	| "get proved"
	| "get refused"
	| "a key below the heading"
	| "a variable two filters fix"
	| "a flag whose readings each prove more than both state"
	| "a contract in the head"
	| "a page request admitted"
	| "a page request refused"
	| "an unordered page refused"
	| "a span parameter opposite r.allen"
	| "a span parameter opposite r.pointIn"
	| "a producer over a span parameter"
	| "a distance to a vector parameter"
	| "a search get proves"
	| "a contract's span refused against its base's"
	| "a closed relation matched"
	| "r.allen over date spans"
	| "a date's point test"
	| "a producer over date spans"
	| "a date span parameter"
	| "a width in days"
	| "a width over integer endpoints"
	| "a roster matched"
	| "a derived relation's get proved"
	| "an extension's Db read a base query"
	| "a base Db refused an extension query"
	| "a keyed get admitted"
	| "a keyed get naming a field beside its key admitted"
	| "a keyed get missing a key field refused"
	| "a keyed get naming a field in a key field's place refused"
	| "a keyed get through a candidate key"
	| "a keyed get of a closed relation"
	| "a keyed get of a roster"

/** What a faulted case reached: its fault, and whether its site's drawn value was refused or admitted. */
export type FaultNote = `${Fault} refused` | `${Fault} admitted`

/**
 * The pairs of notes one case must reach together: a self-join whose get the engine proves, which pinnedSelfJoin
 * draws by construction.
 */
export const agreementPairs: ReadonlyArray<readonly [AgreementNote, AgreementNote]> = [
	["repeat", "get proved"]
]

type Rel = "Item" | "Tag" | "Note" | "Slot" | "Tone" | "ToneWeight" | "ItemTones" | "OwnerCounts"
/** Rollup's derived relations, which a query matching or negating one is over Rollup to read. */
type DerivedRel = "ItemTones" | "OwnerCounts"
/**
 * A source a rule mints variables over: a relation of Agree, its roster Tone and its closed relation ToneWeight, a
 * derived relation of Rollup, the rule's relation parameter (Rows), the import Owned, or Stray, which Agree does not
 * hold.
 */
type Minted = Rel | "Rows" | "Owned" | "Stage" | "Stray"
/** What a match reads: a source of variables, or Tones, the union of Item's facts by tone (./schema.ts). */
type MatchSource = Minted | "Tones"
/**
 * The kinds of value a JavaScript value or a contract's typed constant is written for: big is a plain bigint, a count's,
 * and date a calendar date, written as its ISO text.
 */
type LiteralKind = "uuid" | "int" | "code" | "cents" | "big" | "date"
/** A span's kind, by its endpoint type: integer, bigint, Cents, or calendar dates. */
type SpanKind = "span" | "bigSpan" | "centsSpan" | "dateSpan"
/** A field's kind: a literal's, a span's or a vector's. */
type Kind = LiteralKind | SpanKind | "vector"

interface Field {
	readonly rel: Minted
	readonly name: string
	readonly kind: Kind
}

/** A field of Item, Slot or Cell, whose descriptor a parameter is declared at. */
interface ParamField {
	readonly rel: "Item" | "Slot" | "Cell"
	readonly name: string
	readonly kind: Kind
}

const itemFields: Arr.NonEmptyReadonlyArray<Field> = [
	{ rel: "Item", name: "id", kind: "uuid" },
	{ rel: "Item", name: "owner", kind: "uuid" },
	{ rel: "Item", name: "n", kind: "int" },
	{ rel: "Item", name: "m", kind: "int" },
	{ rel: "Item", name: "tone", kind: "code" },
	{ rel: "Item", name: "cost", kind: "cents" }
]
const slotFields: Arr.NonEmptyReadonlyArray<Field> = [
	{ rel: "Slot", name: "item", kind: "uuid" },
	{ rel: "Slot", name: "during", kind: "span" },
	{ rel: "Slot", name: "budget", kind: "centsSpan" },
	{ rel: "Slot", name: "raw", kind: "bigSpan" },
	{ rel: "Slot", name: "day", kind: "date" },
	{ rel: "Slot", name: "when", kind: "dateSpan" }
]
/** Slot's vectors, which no binding draws: a distance or a head reads them, through the match of Slot it appends. */
const embeddingField: Field = { rel: "Slot", name: "embedding", kind: "vector" }
const imageField: Field = { rel: "Slot", name: "image", kind: "vector" }
/** Slot's span over integer ticks, its span of dates and its date, and its item. */
const duringField: Field = { rel: "Slot", name: "during", kind: "span" }
const whenField: Field = { rel: "Slot", name: "when", kind: "dateSpan" }
const dayField: Field = { rel: "Slot", name: "day", kind: "date" }
const slotItemField: Field = { rel: "Slot", name: "item", kind: "uuid" }

const fieldsOf: { readonly [S in Minted]: Arr.NonEmptyReadonlyArray<Field> } = {
	Item: itemFields,
	Slot: slotFields,
	Tone: [{ rel: "Tone", name: "id", kind: "code" }],
	ToneWeight: [
		{ rel: "ToneWeight", name: "tone", kind: "code" },
		{ rel: "ToneWeight", name: "weight", kind: "cents" }
	],
	ItemTones: [
		{ rel: "ItemTones", name: "id", kind: "uuid" },
		{ rel: "ItemTones", name: "tone", kind: "code" },
		{ rel: "ItemTones", name: "owner", kind: "uuid" }
	],
	OwnerCounts: [
		{ rel: "OwnerCounts", name: "owner", kind: "uuid" },
		{ rel: "OwnerCounts", name: "items", kind: "big" }
	],
	Tag: [
		{ rel: "Tag", name: "item", kind: "uuid" },
		{ rel: "Tag", name: "label", kind: "int" },
		{ rel: "Tag", name: "w", kind: "int" }
	],
	Note: [
		{ rel: "Note", name: "item", kind: "uuid" },
		{ rel: "Note", name: "k", kind: "int" }
	],
	Rows: [
		{ rel: "Rows", name: "id", kind: "uuid" },
		{ rel: "Rows", name: "n", kind: "int" }
	],
	Owned: [
		{ rel: "Owned", name: "id", kind: "uuid" },
		{ rel: "Owned", name: "n", kind: "int" }
	],
	Stage: [
		{ rel: "Stage", name: "id", kind: "uuid" },
		{ rel: "Stage", name: "n", kind: "int" }
	],
	Stray: [
		{ rel: "Stray", name: "id", kind: "uuid" },
		{ rel: "Stray", name: "n", kind: "int" }
	]
}
const rels: Arr.NonEmptyReadonlyArray<Rel> = [
	"Item",
	"Tag",
	"Note",
	"Slot",
	"Tone",
	"ToneWeight",
	"ItemTones",
	"OwnerCounts"
]
/**
 * Each source's keys, by their fields (./schema.ts): a roster's by its id, a closed relation's and a derived relation's
 * those their declaration and definition state, a relation parameter's rows are a set, and so are an import's, each
 * keyed by its whole heading.
 */
const keysOf: { readonly [S in Minted]: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> } = {
	Item: [["id"], ["owner", "n"]],
	Tag: [["item", "label"]],
	Note: [["item"]],
	Slot: [["item", "during"]],
	Tone: [["id"]],
	ToneWeight: [["tone"]],
	ItemTones: [["id"]],
	OwnerCounts: [["owner"]],
	Rows: [["id", "n"]],
	Owned: [["id", "n"]],
	Stage: [["id", "n"]],
	Stray: [["id"]]
}
const allFields: Arr.NonEmptyReadonlyArray<Field> = Arr.flatMap(rels, (rel) => fieldsOf[rel])
/** Every field a parameter is declared at: Item's, Slot's, and Cell's plain bigint. */
const declared: Arr.NonEmptyReadonlyArray<ParamField> = [
	...Arr.map(itemFields, (f): ParamField => ({ rel: "Item", name: f.name, kind: f.kind })),
	...Arr.map(slotFields, (f): ParamField => ({ rel: "Slot", name: f.name, kind: f.kind })),
	{ rel: "Slot", name: embeddingField.name, kind: "vector" },
	{ rel: "Slot", name: imageField.name, kind: "vector" },
	{ rel: "Cell", name: "bigint", kind: "big" }
]
/**
 * The field a parameter of each kind is declared at, wherever it stands: Item's field of the kind, Slot's for a span or
 * a vector, and Cell's for a plain bigint.
 */
const paramField = (kind: Kind): ParamField =>
	Option.getOrThrowWith(
		Arr.findFirst(declared, (f) => f.kind === kind),
		() => new Error(`no relation of Agree has a ${kind} field`)
	)
/** The descriptor a parameter standing for a field is declared at: the field's own, Item's or Slot's, else its kind's. */
const declaredAt = (at: Field): ParamField =>
	Option.getOrElse(
		Arr.findFirst(declared, (f) => f.rel === at.rel && f.name === at.name),
		() => paramField(at.kind)
	)
/** Item's field of a kind. */
const itemField = (kind: Kind): Field =>
	Option.getOrThrowWith(
		Arr.findFirst(itemFields, (f) => f.kind === kind),
		() => new Error(`Item has no ${kind} field`)
	)
/** The integer field a parameter compared with a constant is typed by, where the rule binds no variable. */
const integerField: Field = itemField("int")
/** Item.tone, the field a rule's first match binds when it draws a constant of Tone by construction (Anchor). */
const toneField: Field = itemField("code")
/** A field of a kind some relation of the schema holds, which a parameter of the kind is declared at. */
const fieldOfKind = (kind: Kind): Field =>
	Option.getOrThrowWith(
		Arr.findFirst(allFields, (f) => f.kind === kind),
		() => new Error(`no relation of the schema has a ${kind} field`)
	)
/** Whether a kind is a span's. */
const isSpan = (kind: Kind): boolean =>
	kind === "span" || kind === "bigSpan" || kind === "centsSpan" || kind === "dateSpan"

/** The kind of a span's endpoints, which a point it holds is of: none for a kind that is no span's. */
const pointKind = (kind: Kind): Kind | undefined => {
	switch (kind) {
		case "span":
			return "int"
		case "bigSpan":
			return "big"
		case "centsSpan":
			return "cents"
		case "dateSpan":
			return "date"
		case "uuid":
		case "int":
		case "code":
		case "cents":
		case "big":
		case "date":
		case "vector":
			return undefined
	}
}

/** Owned through the query builder's JavaScript view, whose bind the engine reads a drawn binding through. */
const ownedImport: QueryValue = Owned

/** The relations a match reads, as values, and Item's and Slot's field descriptors, which every parameter is declared at. */
const relations: { readonly [R in Rel | "Stray" | "Tones"]: unknown } = {
	Item,
	Tag,
	Note,
	Slot,
	Tone,
	ToneWeight,
	ItemTones,
	OwnerCounts,
	Stray,
	Tones
}
const descriptorsOf: { readonly [R in ParamField["rel"]]: Readonly<Record<string, unknown>> } = {
	Item: Item.fields,
	Slot: Slot.fields,
	Cell: Cell.fields
}
const descriptorOf = (f: ParamField): unknown => descriptorsOf[f.rel][f.name]

/**
 * A variable v mints over a source's field, in the scope of the source's `copy`-th match in its rule: a self-join's two
 * matches mint in two scopes (scopeOf).
 */
interface Var {
	readonly field: Field
	readonly copy: number
}

type Term =
	| { readonly kind: "var"; readonly v: Var }
	| { readonly kind: "param"; readonly name: string; readonly at: ParamField }
	| {
			readonly kind: "literal"
			readonly type: Exclude<LiteralKind, "cents">
			readonly value: number
	  }
	| { readonly kind: "constant"; readonly of: "integer" | "cents"; readonly value: number }
	| { readonly kind: "handle"; readonly value: number }
	| { readonly kind: "vector"; readonly dims: number }
	| {
			readonly kind: "arith"
			readonly op: "add" | "sub" | "mul"
			readonly a: Term
			readonly b: Term
	  }
	| { readonly kind: "neg"; readonly a: Term }
	| { readonly kind: "cond"; readonly p: Pred; readonly onTrue: Term; readonly onFalse: Term }

/** A rule's predicate (r.eq, r.and, ...) or Compute's (Compute.eq, Compute.and, ...). */
type Via = "rule" | "compute"

type Pred =
	| {
			readonly kind: "cmp"
			readonly op: "eq" | "ne" | "lt" | "ge"
			readonly a: Term
			readonly b: Term
			readonly via: Via
	  }
	| { readonly kind: "and" | "or"; readonly ps: readonly [Pred, Pred]; readonly via: Via }
	| { readonly kind: "not"; readonly rel: Rel; readonly field: string; readonly t: Term }
	| { readonly kind: "allen"; readonly left: Term; readonly mask: Mask; readonly right: Term }
	| { readonly kind: "pointIn"; readonly point: Term; readonly span: Term }

/** One of ALLEN's named masks: a basic relation or a named union of them. */
type MaskName = Exclude<keyof typeof ALLEN, "complement" | "converse">

/** An Allen mask as the program writes it: a named mask or a union of two, or the complement or converse of that. */
interface Mask {
	readonly names: readonly [MaskName] | readonly [MaskName, MaskName]
	readonly op: "none" | "complement" | "converse"
}

/** ALLEN's named masks, read off the namespace. */
const maskNames: Arr.NonEmptyReadonlyArray<MaskName> = Option.getOrThrowWith(
	Arr.match(
		Arr.filter(Rec.keys(ALLEN), (k): k is MaskName => k !== "complement" && k !== "converse"),
		{ onEmpty: () => Option.none(), onNonEmpty: (names) => Option.some(names) }
	),
	() => new Error("ALLEN names no mask")
)

/** An aggregate a grouped head folds its matches by. */
type Fold = "sum" | "min" | "max" | "mean"

type HeadTerm =
	| { readonly kind: "term"; readonly t: Term }
	| { readonly kind: "literal"; readonly value: number | string }
	| { readonly kind: "count" }
	| { readonly kind: "fold"; readonly fold: Fold; readonly of: Term }
	| {
			readonly kind: "produce"
			readonly fn: "intersection" | "difference"
			readonly left: Term
			readonly right: Term
	  }
	| { readonly kind: "pack"; readonly of: Term }
	| { readonly kind: "cosine"; readonly of: Term; readonly to: Term }
	| { readonly kind: "width"; readonly of: Term; readonly span: SpanKind }

interface Match {
	readonly rel: MatchSource
	readonly copy: number
	readonly bindings: ReadonlyArray<readonly [string, Term]>
}

/** How a scope's name is written: a literal, left out of v, or spelled through a `string` (Fault). */
type Spelling =
	| { readonly kind: "literal"; readonly name: string }
	| { readonly kind: "omitted" }
	| { readonly kind: "widened" }

/**
 * A filter whose predicate turns on a boolean the program does not know: one of two predicates (`flag ? a : b`), or a
 * predicate a spread array of unknown length may hold (`...Arr.filter([p], () => flag)`). The engine reads the rule
 * under each value the flag may take (flagVariants), and the types must hold what holds under both.
 */
type Flagged =
	| { readonly kind: "either"; readonly ifTrue: Pred; readonly ifFalse: Pred }
	| { readonly kind: "spread"; readonly p: Pred }

/**
 * A rule's relation parameter, which every match of Rows reads: its name, and its heading, stated as fields, or as a
 * relation whose heading Rows' fields name, Batch, of Agree, or Stray, which Agree does not hold, where a case plants
 * that fault (r.relation(name, Relation)).
 */
type RowsDecl =
	| { readonly kind: "fields"; readonly name: string; readonly heading: ReadonlyArray<Field> }
	| { readonly kind: "relation"; readonly name: string; readonly relation: "Batch" | "Stray" }

/** The fields a relation parameter's heading holds: those it states, or its relation's, which Rows' fields name. */
const rowsHeading = (rows: RowsDecl): ReadonlyArray<Field> =>
	rows.kind === "fields" ? rows.heading : fieldsOf.Rows

/** Owned's parameter under one of its matches: bound to a term, or unbound where a case plants that fault. */
type OwnedBind = { readonly kind: "bound"; readonly owner: Term } | { readonly kind: "unbound" }

/**
 * An interior stage under one of its matches, the id and n of Item's facts (r.interior): their owner bound to a
 * parameter the stage declares, which joins the rule's parameters, to a literal, or free. It reads no variable of the
 * rule, whose stage it is.
 */
type StageOwner =
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "literal"; readonly value: number }
	| { readonly kind: "free" }

interface RuleSpec {
	readonly matches: Arr.NonEmptyReadonlyArray<Match>
	readonly filters: ReadonlyArray<Pred>
	/** A filter on a flag, where the rule states one. */
	readonly flagged: Flagged | undefined
	readonly head: Arr.NonEmptyReadonlyArray<readonly [string, HeadTerm]>
	/** The relation parameter the rule declares, where it declares one. */
	readonly rows: RowsDecl | undefined
	/** Owned's binding under each of its matches, by the match's copy. */
	readonly owned: ReadonlyArray<OwnedBind>
	/** Each interior stage's owner, by its match's copy. */
	readonly stages: ReadonlyArray<StageOwner>
	/** A scope whose name is written otherwise than as its own literal (scopeOf), by its scope. */
	readonly spellings: ReadonlyArray<readonly [string, Spelling]>
}

/**
 * A page request a case states over its ordered query: each control property it holds, by its value. A size is 2; an
 * anchor is a cursor, null, undefined or a plain string, a `string` no cursor codec made. Each request plants at most
 * one fault: a shape the runtime refuses (both sizes, no size, both anchors, an anchor of the other direction), or an
 * anchor that is no cursor.
 */
type RequestValue = "size" | "cursor" | "null" | "undefined" | "string"
type PageRequestSpec = ReadonlyArray<readonly ["first" | "last" | "after" | "before", RequestValue]>

/** One query: its arms (a union when two), the take that closes it, if any, and the fault it plants. */
interface QuerySpec {
	readonly arms: Arr.NonEmptyReadonlyArray<RuleSpec>
	readonly take: 1 | 2 | "k" | undefined
	/**
	 * A take's order field where a case plants orderHidden: half the time a name of the heading, otherwise one drawn among
	 * names the heading may not hold.
	 */
	readonly hidden: string | undefined
	readonly fault: Planted
	/**
	 * The request a page of the query states, where the query is no take's, which a page reads no further, and no union
	 * of two headings, which shares no field a page could order by.
	 */
	readonly request: PageRequestSpec | undefined
	/** The approximate search that closes the query's arm, before its take, where the query states one. */
	readonly nearest: Nearest | undefined
	/** The role whose Db the query's reads go through: the full role over Agree, or over Rollup. */
	readonly db: "Reader" | "Reporter"
	/** The keyed get a clean case states beside its query. */
	readonly keyed: KeyedGet | undefined
}

/**
 * A key position a keyed get reads through: a relation's primary key, Item's candidate key byOwner, the closed
 * relation's key and the roster's id.
 */
const keyTargets = ["Item", "Tag", "Note", "Slot", "Cell", "ToneWeight", "Tone", "byOwner"] as const
type KeyTarget = (typeof keyTargets)[number]

/**
 * A keyed get: its key position, and its values' names, the key's fields, those and one name more, all but one of them,
 * or all but one and one name more in its place.
 */
interface KeyedGet {
	readonly target: KeyTarget
	readonly shape: "key" | "beside" | "short" | "instead"
}

/** An approximate search: the head field it ranks by and the facts it takes. */
interface Nearest {
	readonly by: string
	readonly take: 1 | 3
}

/** A form a draw may take: the construct it uses, and the part it draws. */
type Form<A> = readonly [AgreementFeature, () => A]

/**
 * One query's drawing: the case's swarm, the fault it plants, the source its decisions come from, the constructs it
 * reached and its fresh names.
 */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<AgreementFeature>
	readonly fault: Planted
	#params = 0
	readonly reached = new Set<AgreementFeature>()

	constructor(source: Source, drawn: Swarm<AgreementFeature>, fault: Planted) {
		this.#source = source
		this.#swarm = drawn
		this.fault = fault
	}

	/** Whether `feature` appears at this place, as the swarm keeps it; noted when it does. */
	keep(feature: AgreementFeature): boolean {
		const kept = this.#source.draw(keep(this.#swarm, feature))
		if (kept) {
			this.reached.add(feature)
		}
		return kept
	}

	/** Notes a construct another construct's draw made, as the draw that kept it would. */
	note(feature: AgreementFeature): void {
		this.reached.add(feature)
	}

	/** One of `forms`, by the swarm's weights of their constructs, the first when every one is off; noted. */
	choose<A>(forms: Arr.NonEmptyReadonlyArray<Form<A>>): A {
		const feature = this.#source.draw(
			swarmChoice(
				this.#swarm,
				Arr.map(forms, ([f]) => f)
			)
		)
		this.reached.add(feature)
		const [, draw] = Option.getOrThrowWith(
			Arr.findFirst(forms, ([f]) => f === feature),
			() => new Error(`the swarm chose ${feature}, no form of the draw`)
		)
		return draw()
	}

	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}

	/** A parameter name no other draw of the query takes. */
	paramName(): string {
		const name = `p${this.#params}`
		this.#params += 1
		return name
	}

	param(at: Field): Term {
		return { kind: "param", name: this.paramName(), at: declaredAt(at) }
	}
}

const sameVar = (a: Var, b: Var): boolean =>
	a.field.rel === b.field.rel && a.field.name === b.field.name && a.copy === b.copy

const varTerm = (v: Var): Term => ({ kind: "var", v })

/** A value of a literal kind written in the program: a JavaScript value, or a contract's typed constant. */
const literalOf = (d: Drawing, kind: LiteralKind): Term =>
	kind === "cents"
		? { kind: "constant", of: "cents", value: d.from([0, 1, 2, 3]) }
		: { kind: "literal", type: kind, value: d.from([0, 1, 2, 3]) }

/** Tone's members, which a handle and a JavaScript value of Item.tone name by index. */
const tones = Tone.handles

const toneOf = (value: number): (typeof tones)[number] => Arr.getUnsafe(tones, value % tones.length)

const handleOf = (d: Drawing): Term => ({ kind: "handle", value: d.from([0, 1, 2]) })

/** A value a field's binding fixes per binding: a parameter or a literal of the field's type. */
const boundInputs = (d: Drawing, at: Field): Arr.NonEmptyReadonlyArray<Form<Term>> => [
	["param", () => d.param(at)],
	...literalForms(d, at.kind)
]

/** The literal a field of a kind may be written as: none for a span or a vector, which only a parameter stands for. */
const literalForms = (d: Drawing, kind: Kind): ReadonlyArray<Form<Term>> => {
	switch (kind) {
		case "uuid":
		case "int":
		case "code":
		case "cents":
		case "big":
		case "date":
			return [["literal", () => literalOf(d, kind)]]
		case "span":
		case "bigSpan":
		case "centsSpan":
		case "dateSpan":
		case "vector":
			return []
	}
}

/** A value fixed per binding: a parameter or a literal, or Compute over a constant and a parameter. */
const inputOf = (d: Drawing, at: Field): Term => {
	const plain = boundInputs(d, at)
	switch (at.kind) {
		case "int":
			return d.choose([
				...plain,
				[
					"computedFix",
					() => ({
						kind: "arith",
						op: d.from(["add", "mul"] as const),
						a: { kind: "constant", of: "integer", value: d.from([1, 2]) },
						b: d.param(at)
					})
				]
			])
		case "code":
			return d.choose([...plain, ["constantFilter", () => handleOf(d)]])
		case "uuid":
		case "cents":
		case "big":
		case "date":
		case "span":
		case "bigSpan":
		case "centsSpan":
		case "dateSpan":
		case "vector":
			return d.choose(plain)
	}
}

/**
 * A Compute term over the bound integer variables: arithmetic with a literal, a parameter or a variable, or a negation.
 */
const computedOver = (d: Drawing, ints: Arr.NonEmptyReadonlyArray<Var>): Term => {
	const a = varTerm(d.from(ints))
	switch (d.from(["literal", "param", "var", "neg"] as const)) {
		case "literal":
			return {
				kind: "arith",
				op: d.from(["add", "sub", "mul"] as const),
				a,
				b: literalOf(d, "int")
			}
		case "param":
			return {
				kind: "arith",
				op: d.from(["add", "sub", "mul"] as const),
				a,
				b: d.param(d.from(ints).field)
			}
		case "var":
			return { kind: "arith", op: d.from(["add", "mul"] as const), a, b: varTerm(d.from(ints)) }
		case "neg":
			return { kind: "neg", a }
	}
}

const viaOf = (d: Drawing): Via => (d.keep("computeFilter") ? "compute" : "rule")

/**
 * A comparison of a bound variable with a value fixed per binding or a literal bound, or of inputs when none is bound.
 */
const comparisonOver = (d: Drawing, bound: ReadonlyArray<Var>): Pred => {
	const via = viaOf(d)
	if (!Arr.isReadonlyArrayNonEmpty(bound)) {
		return {
			kind: "cmp",
			op: "ge",
			a: { kind: "constant", of: "integer", value: 1 },
			b: d.param(integerField),
			via
		}
	}
	const v = d.from(bound)
	if (v.field.kind === "code" && d.keep("constantFirst")) {
		return { kind: "cmp", op: d.from(["eq", "ne"] as const), a: handleOf(d), b: varTerm(v), via }
	}
	return v.field.kind === "int" && d.from([0, 1]) === 0
		? { kind: "cmp", op: d.from(["lt", "ge"] as const), a: varTerm(v), b: literalOf(d, "int"), via }
		: { kind: "cmp", op: d.from(["eq", "ne"] as const), a: varTerm(v), b: inputOf(d, v.field), via }
}

/**
 * The forms a field's binding may take: its own variable, a join, a foreign variable, an input, a computation, none.
 */
const bindingForms = (
	d: Drawing,
	field: Field,
	own: Var,
	bound: ReadonlyArray<Var>
): Arr.NonEmptyReadonlyArray<Form<Term | undefined>> => {
	const joins = Arr.filter(bound, (b) => b.field.kind === field.kind && !sameVar(b, own))
	const foreign = Arr.filter(
		allFields,
		(f) => f.kind === field.kind && !(f.rel === field.rel && f.name === field.name)
	)
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	return [
		["ownVar", () => varTerm(own)],
		...(Arr.isReadonlyArrayNonEmpty(joins)
			? [["join", () => varTerm(d.from(joins))] as const]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(foreign)
			? [["foreignVar", () => varTerm({ field: d.from(foreign), copy: 0 })] as const]
			: []),
		["param", () => d.param(field)],
		...literalForms(d, field.kind),
		...(field.kind === "code" ? [["constantBinding", () => handleOf(d)] as const] : []),
		["omit", () => undefined],
		...(field.kind === "int" && Arr.isReadonlyArrayNonEmpty(ints)
			? [
					[
						"computedBinding",
						(): Term => ({
							kind: "arith",
							op: d.from(["add", "mul"] as const),
							a: varTerm(d.from(ints)),
							b: literalOf(d, "int")
						})
					] as const
				]
			: [])
	]
}

/** A match's bindings, and the variables bound once they are. */
interface Bound {
	readonly bindings: ReadonlyArray<readonly [string, Term]>
	readonly bound: ReadonlyArray<Var>
}

/**
 * A rule's constant of Tone drawn by construction: its first match is Item, whose tone it binds to a handle
 * (constantBinding), or to tone's variable, which a filter compares with a handle second (constantFilter) or first
 * (constantFirst). Each is otherwise drawn only where Item.tone's variable happens to be bound, which few cases do.
 */
type Anchor =
	| { readonly kind: "binding"; readonly handle: Term }
	| { readonly kind: "variable"; readonly filter: boolean; readonly first: boolean }

const anchorOf = (d: Drawing): Anchor | undefined => {
	if (d.keep("constantBinding")) {
		return { kind: "binding", handle: handleOf(d) }
	}
	const filter = d.keep("constantFilter")
	const first = d.keep("constantFirst")
	return filter || first ? { kind: "variable", filter, first } : undefined
}

/** The filters an anchor's variable is compared with a handle in. */
const anchorFilters = (d: Drawing, anchor: Anchor | undefined): ReadonlyArray<Pred> => {
	if (anchor === undefined || anchor.kind === "binding") {
		return []
	}
	const tone = varTerm({ field: toneField, copy: 0 })
	const compared = (a: Term, b: Term): Pred => ({
		kind: "cmp",
		op: d.from(["eq", "ne"] as const),
		a,
		b,
		via: viaOf(d)
	})
	return [
		...(anchor.filter ? [compared(tone, handleOf(d))] : []),
		...(anchor.first ? [compared(handleOf(d), tone)] : [])
	]
}

/** What an anchor binds Item.tone to, where it binds it. */
const anchored = (anchor: Anchor | undefined, field: Field, own: Var): Term | undefined =>
	anchor === undefined || field.rel !== toneField.rel || field.name !== toneField.name
		? undefined
		: anchor.kind === "binding"
			? anchor.handle
			: varTerm(own)

/**
 * A match's bindings, field by field, each drawn over the variables bound before it, a join among them; a field the
 * anchor binds is bound as it says, and a field of `inputs` to a value fixed per binding.
 */
const bindingsOf = (
	d: Drawing,
	fields: ReadonlyArray<Field>,
	copy: number,
	before: ReadonlyArray<Var>,
	anchor: Anchor | undefined,
	inputs: ReadonlyArray<string>
): Bound =>
	Arr.reduce(fields, { bindings: [], bound: before }, (drawn: Bound, field): Bound => {
		const own: Var = { field, copy }
		const term = Arr.contains(inputs, field.name)
			? d.choose(boundInputs(d, field))
			: (anchored(anchor, field, own) ?? d.choose(bindingForms(d, field, own, drawn.bound)))
		return term === undefined
			? drawn
			: {
					bindings: [...drawn.bindings, [field.name, term] as const],
					bound: withVariable(drawn.bound, term)
				}
	})

const withVariable = (bound: ReadonlyArray<Var>, term: Term): ReadonlyArray<Var> =>
	term.kind === "var" && !Arr.some(bound, (b) => sameVar(b, term.v)) ? [...bound, term.v] : bound

/** A rule's matches, and the variables they bind. */
interface Matched {
	readonly matches: Arr.NonEmptyReadonlyArray<Match>
	readonly bound: ReadonlyArray<Var>
}

/** The copy the next match of `source` mints its scope in, after `matches`. */
const nextCopy = (matches: ReadonlyArray<Match>, source: MatchSource): number =>
	Arr.filter(matches, (m) => m.rel === source).length

/**
 * One to three matches, each of a drawn relation, the first Item when an anchor draws a constant of Tone (Anchor): a
 * relation already matched again only where the swarm keeps the repeat.
 */
const drawnMatches = (d: Drawing, anchor: Anchor | undefined, second: boolean): Matched => {
	const count = second ? (d.keep("thirdMatch") ? 3 : 2) : 1
	const matched: Array<Rel> = []
	let bound: ReadonlyArray<Var> = []
	const matches: Array<Match> = []
	for (let i = 0; i < count; i++) {
		const drawn = i === 0 && anchor !== undefined ? "Item" : d.from(rels)
		const unmatched = Arr.filter(rels, (rel) => !Arr.contains(matched, rel))
		const rel =
			Arr.contains(matched, drawn) && Arr.isReadonlyArrayNonEmpty(unmatched) && !d.keep("repeat")
				? d.from(unmatched)
				: drawn
		const copy = Arr.filter(matched, (m) => m === rel).length
		matched.push(rel)
		const bindings = bindingsOf(d, fieldsOf[rel], copy, bound, i === 0 ? anchor : undefined, [])
		bound = bindings.bound
		matches.push({ rel, copy, bindings: bindings.bindings })
	}
	return { matches: [defined(matches[0], "the first match"), ...matches.slice(1)], bound }
}

/**
 * A self-join whose get the engine proves, drawn by construction (pinnedSelfJoin): two matches of one relation, Item
 * when an anchor draws a constant of Tone, each scope binding one of the relation's keys to values fixed per binding,
 * so both facts are pinned and so is every variable the rule binds. Its other fields are drawn as any match's.
 */
const pinnedMatches = (d: Drawing, anchor: Anchor | undefined): Matched => {
	d.note("repeat")
	const rel = anchor === undefined ? d.from(rels) : "Item"
	const first = bindingsOf(d, fieldsOf[rel], 0, [], anchor, d.from(keysOf[rel]))
	const second = bindingsOf(d, fieldsOf[rel], 1, first.bound, undefined, d.from(keysOf[rel]))
	return {
		matches: [
			{ rel, copy: 0, bindings: first.bindings },
			{ rel, copy: 1, bindings: second.bindings }
		],
		bound: second.bound
	}
}

/**
 * The further sources a rule may match after its drawn matches: the relation parameter it declares, Owned bound to a
 * uuid input or variable, and Stray, each with its fields bound as any match's; a faulted case's own source among them,
 * so its fault stands at a match of the rule (Fault). A relation parameter of no field is declared, and matched by no
 * match, where the case plants that fault.
 */
interface Further {
	readonly matches: ReadonlyArray<Match>
	readonly bound: ReadonlyArray<Var>
	readonly rows: RowsDecl | undefined
	readonly owned: ReadonlyArray<OwnedBind>
	readonly stages: ReadonlyArray<StageOwner>
}

const furtherMatches = (
	d: Drawing,
	before: ReadonlyArray<Match>,
	bound: ReadonlyArray<Var>,
	rowsName: string
): Further => {
	const rows =
		d.fault === "emptyRelation" || d.fault === "strayRows" ? false : d.keep("relationParam")
	const owned = d.fault === "unboundImport" || d.keep("boundImport")
	const staged = d.keep("interiorStage")
	const stray = d.fault === "stray"
	const sources: ReadonlyArray<MatchSource> = [
		...(rows || d.fault === "emptyRelation" || d.fault === "strayRows" ? ["Rows" as const] : []),
		...(owned ? ["Owned" as const] : []),
		...(staged ? ["Stage" as const] : []),
		...(stray ? ["Stray" as const] : [])
	]
	const start: Further = {
		matches: [],
		bound,
		rows:
			d.fault === "emptyRelation"
				? { kind: "fields", name: rowsName, heading: [] }
				: d.fault === "strayRows"
					? { kind: "relation", name: rowsName, relation: "Stray" }
					: rows
						? d.keep("rowsRelation")
							? { kind: "relation", name: rowsName, relation: "Batch" }
							: { kind: "fields", name: rowsName, heading: fieldsOf.Rows }
						: undefined,
		owned: [],
		stages: []
	}
	return Arr.reduce(sources, start, (drawn: Further, source): Further => {
		const binds: ReadonlyArray<OwnedBind> =
			source === "Owned"
				? [
						...drawn.owned,
						d.fault === "unboundImport"
							? { kind: "unbound" }
							: { kind: "bound", owner: ownerOf(d, drawn.bound) }
					]
				: drawn.owned
		const stages: ReadonlyArray<StageOwner> =
			source === "Stage" ? [...drawn.stages, stageOwnerOf(d)] : drawn.stages
		const minted: Minted = source === "Tones" ? "Item" : source
		const copy = nextCopy([...before, ...drawn.matches], source)
		const fields =
			source === "Rows" && drawn.rows !== undefined ? rowsHeading(drawn.rows) : fieldsOf[minted]
		const bindings = bindingsOf(d, fields, copy, drawn.bound, undefined, [])
		return {
			matches: [...drawn.matches, { rel: source, copy, bindings: bindings.bindings }],
			bound: bindings.bound,
			rows: drawn.rows,
			owned: binds,
			stages
		}
	})
}

/** An interior stage's owner: a parameter of the stage, a literal, or free. */
const stageOwnerOf = (d: Drawing): StageOwner =>
	d.from<() => StageOwner>([
		() => ({ kind: "param", name: d.paramName() }),
		() => ({ kind: "literal", value: d.from([0, 1, 2, 3]) }),
		() => ({ kind: "free" })
	])()

/**
 * Owned's owner: a uuid variable of the rule bound before it, or a value fixed per binding; never a variable of Owned's
 * own, whose source is the binding itself.
 */
const ownerOf = (d: Drawing, bound: ReadonlyArray<Var>): Term => {
	const uuids = Arr.filter(bound, (b) => b.field.kind === "uuid" && b.field.rel !== "Owned")
	return Arr.isReadonlyArrayNonEmpty(uuids) && d.from([0, 1]) === 0
		? varTerm(d.from(uuids))
		: d.choose(boundInputs(d, itemField("uuid")))
}

/** A drawn rule, and whether it is a pinned self-join, which no union's arm is. */
interface DrawnRule {
	readonly rule: RuleSpec
	readonly pinned: boolean
}

/**
 * A rule: its matches, its filters and its head, over the variables its matches bind, its head fields named by
 * `prefix`. A second match may be a pinned self-join's (pinnedMatches), the rule's matches alone; any other rule's are
 * drawn, then its further matches (furtherMatches), then the match of Slot its span and vector constructs read
 * (Planned), and its last, under constantAtUnionSource, is Tones with a constant bound at tone, a handle or its member's
 * JavaScript value, which selects the arm holding it. A rule an approximate search ranks (`search`) holds a distance
 * to a query vector and folds and produces nothing. A faulted case plants its fault here, but for unionTypes, which its
 * query plants.
 */
const drawRule = (d: Drawing, prefix: "h" | "g", rowsName: string, search: boolean): DrawnRule => {
	const anchor = anchorOf(d)
	const second = d.keep("secondMatch")
	const pinned = second && d.keep("pinnedSelfJoin")
	const drawn = pinned ? pinnedMatches(d, anchor) : drawnMatches(d, anchor, second)
	const further = pinned
		? { matches: [], bound: drawn.bound, rows: undefined, owned: [], stages: [] }
		: furtherMatches(d, drawn.matches, drawn.bound, rowsName)
	const plan = planOf(d, search)
	const slot = slottedOf(d, plan, [...drawn.matches, ...further.matches], further.bound)
	const atUnion: ReadonlyArray<Match> =
		!pinned && d.keep("constantAtUnionSource")
			? [{ rel: "Tones", copy: 0, bindings: [["tone", tonesConstant(d)]] }]
			: []
	const endpoint =
		d.fault === "spanEndpoints" && Arr.isReadonlyArrayNonEmpty(slot.spans)
			? endpointOf(d, slot.spans, slot.bound)
			: undefined
	const filters = [
		...anchorFilters(d, anchor),
		...filtersOver(d, slot.bound),
		...spanFilters(d, plan, slot.bound),
		...(endpoint?.kind === "filter" ? [endpoint.p] : []),
		...(d.fault === "allenTerm" && Arr.isReadonlyArrayNonEmpty(slot.bound)
			? [allenOver(d.from(slot.bound))]
			: [])
	]
	const flagged = flaggedOver(d, slot.bound)
	const drawnHead = headOver(d, slot.bound, prefix, plan.fold)
	const head = Arr.appendAll(
		drawnHead,
		Arr.map(
			[...extrasOf(d, plan, slot), ...(endpoint?.kind === "head" ? [endpoint.h] : [])],
			(h, i) => [`${prefix}${drawnHead.length + i}`, h] as const
		)
	)
	const all = [...drawn.matches, ...further.matches, ...slot.matches, ...atUnion]
	const folded = Arr.some(head, ([, h]) => h.kind === "count" || h.kind === "fold")
	const matches: Arr.NonEmptyReadonlyArray<Match> = Arr.appendAll(
		drawn.matches,
		Arr.appendAll(further.matches, Arr.appendAll(slot.matches, atUnion))
	)
	const headless =
		further.rows !== undefined && !Arr.isReadonlyArrayNonEmpty(rowsHeading(further.rows))
	const keyed: Arr.NonEmptyReadonlyArray<Match> =
		folded && d.fault !== "unkeyedFold"
			? Arr.map(matches, (m) => (m.rel === "Rows" && headless ? m : keyedMatch(m)))
			: matches
	const stranger = d.fault === "stranger" ? strangerOf(d, keyed) : keyed
	const rule: RuleSpec = {
		matches: stranger,
		filters,
		flagged,
		head,
		rows: further.rows,
		owned: further.owned,
		stages: further.stages,
		spellings: []
	}
	return {
		rule: d.fault === "clean" || all.length === 0 ? rule : spelled(d, rule),
		pinned
	}
}

/**
 * What a cosine distance from Slot's embedding is to: a vector parameter, a vector value, Slot's image or the embedding
 * itself; and, where a case plants a cosine fault, a vector of other dimensions or an integer, which is no vector.
 */
type CosineTo = "param" | "vector" | "image" | "self" | "short" | "integer"

/**
 * The span and vector constructs a rule holds, drawn where every rule visits: whether its head folds; an Allen predicate
 * and a point's test; the one producer of its head; a cosine distance and what it is to; and the embedding in its head.
 * A rule an approximate search ranks holds a distance to a query vector, and neither folds nor produces; a rule
 * planting a cosine fault holds a distance to the fault's value, and one planting a fault of a producer or a span's
 * endpoints folds nothing.
 */
interface Plan {
	readonly fold: boolean
	readonly allen: boolean
	readonly pointIn: boolean
	readonly producer: "intersection" | "difference" | "pack" | undefined
	readonly cosine: CosineTo | undefined
	readonly vectorHead: boolean
	/** Whether the rule's match of Slot binds its span of dates and its date, so its span constructs may read them. */
	readonly dates: boolean
	/** Whether the head holds a span's width, upper minus lower, in its endpoint type's unit. */
	readonly width: boolean
}

const planOf = (d: Drawing, search: boolean): Plan => {
	const cosineFault = d.fault === "cosineDims" || d.fault === "cosineTerm"
	const producing =
		d.fault === "producerHead" || d.fault === "packTerm" || d.fault === "spanEndpoints"
	const fold =
		!search && !cosineFault && !producing && (d.fault === "unkeyedFold" || d.keep("aggregate"))
	const allen = d.keep("allen")
	const pointIn = d.keep("pointIn")
	const producer =
		!fold &&
		!search &&
		d.fault !== "packTerm" &&
		d.fault !== "spanEndpoints" &&
		(d.fault === "producerHead" || d.keep("producer"))
			? d.choose<"intersection" | "difference" | "pack">([
					["intersection", () => "intersection"],
					["difference", () => "difference"],
					["pack", () => "pack"]
				])
			: undefined
	const cosine = ((): CosineTo | undefined => {
		switch (d.fault) {
			case "cosineDims":
				return d.from(["self", "short"] as const)
			case "cosineTerm":
				return d.from(["self", "integer"] as const)
			case "nearestBy":
				return d.from(["param", "vector", "image", "self"] as const)
			case "clean":
			case "scopeName":
			case "unnamedScope":
			case "widenedName":
			case "stranger":
			case "stray":
			case "unkeyedFold":
			case "unionTypes":
			case "emptyRelation":
			case "strayRows":
			case "unboundImport":
			case "allenTerm":
			case "orderHidden":
			case "spanEndpoints":
			case "packTerm":
			case "producerHead":
			case "nearestSource":
				return search
					? d.choose<CosineTo>([
							["cosineParam", () => "param"],
							["cosineVector", () => "vector"]
						])
					: !fold && d.keep("cosine")
						? d.choose<CosineTo>([
								["cosineParam", () => "param"],
								["cosineVector", () => "vector"],
								["cosineColumns", () => d.from(["image", "self"] as const)]
							])
						: undefined
		}
	})()
	return {
		fold,
		allen,
		pointIn,
		producer,
		cosine,
		vectorHead: !fold && d.keep("vectorHead"),
		dates: d.keep("dateSpan"),
		width: !fold && d.keep("width")
	}
}

/**
 * A rule's match of Slot, if any: the matches, the variables bound once they are, the copy its vectors and spans are
 * of, and the spans it binds to variables of its own.
 */
interface Slotted {
	readonly matches: ReadonlyArray<Match>
	readonly bound: ReadonlyArray<Var>
	readonly copy: number
	readonly spans: ReadonlyArray<Var>
}

/**
 * The match of Slot a rule's span and vector constructs read, appended to `before` where its plan holds one: its item
 * bound as any field, its span over integer ticks to its own variable, its other spans too where the case plants
 * spanEndpoints, and its embedding, and its image where the distance is to it, to variables no other term reads, so no
 * filter or second match reads a vector a search ranks by.
 */
const slottedOf = (
	d: Drawing,
	plan: Plan,
	before: ReadonlyArray<Match>,
	bound: ReadonlyArray<Var>
): Slotted => {
	const copy = nextCopy(before, "Slot")
	const vectors = plan.cosine !== undefined || plan.vectorHead
	const spanned =
		plan.allen ||
		plan.pointIn ||
		plan.producer !== undefined ||
		plan.dates ||
		plan.width ||
		d.fault === "spanEndpoints" ||
		d.fault === "packTerm" ||
		d.fault === "nearestSource"
	if (!vectors && !spanned) {
		return { matches: [], bound, copy, spans: [] }
	}
	const item = bindingsOf(d, [slotItemField], copy, bound, undefined, [])
	const own = (f: Field): readonly [string, Term] => [f.name, varTerm({ field: f, copy })] as const
	const spans = Arr.filter(slotFields, (f) =>
		d.fault === "spanEndpoints"
			? isSpan(f.kind)
			: f.name === duringField.name ||
				(plan.dates && (f.name === whenField.name || f.name === dayField.name))
	)
	const vectorFields = [
		...(vectors ? [embeddingField] : []),
		...(plan.cosine === "image" ? [imageField] : [])
	]
	return {
		matches: [
			{
				rel: "Slot",
				copy,
				bindings: [...item.bindings, ...Arr.map(spans, own), ...Arr.map(vectorFields, own)]
			}
		],
		bound: Arr.reduce(spans, item.bound, (vs, f) => withVariable(vs, varTerm({ field: f, copy }))),
		copy,
		spans: Arr.map(spans, (f) => ({ field: f, copy }))
	}
}

/** A span variable or a span parameter of `left`'s type, opposite it. */
const oppositeOf = (d: Drawing, left: Var, bound: ReadonlyArray<Var>): Term =>
	d.choose([
		[
			"spanOperand",
			() => varTerm(d.from([left, ...Arr.filter(bound, (v) => v.field.kind === left.field.kind)]))
		],
		["spanParam", () => d.param(left.field)]
	])

/** An Allen mask drawn as the program writes one: one or two named masks, as they are, complemented or conversed. */
const maskOf = (d: Drawing): Mask => ({
	names: d.from([0, 1]) === 0 ? [d.from(maskNames)] : [d.from(maskNames), d.from(maskNames)],
	op: d.from(["none", "complement", "converse"] as const)
})

/** An Allen predicate relating a variable to itself, which allenTerm plants over a drawn variable of any kind. */
const allenOver = (v: Var): Pred => ({
	kind: "allen",
	left: varTerm(v),
	mask: { names: ["overlaps"], op: "none" },
	right: varTerm(v)
})

/**
 * A rule's span predicates over its bound spans, as its plan holds them: an Allen predicate relating a span to a span
 * of its type or a span parameter under a drawn mask, and a point's test of a variable or parameter of a span's
 * endpoint type, an integer, a bigint, Cents or a date, in that span or a parameter of its type.
 */
const spanFilters = (d: Drawing, plan: Plan, bound: ReadonlyArray<Var>): ReadonlyArray<Pred> => {
	const spans = Arr.filter(bound, (v) => isSpan(v.field.kind))
	const allen = ((): ReadonlyArray<Pred> => {
		if (!plan.allen || !Arr.isReadonlyArrayNonEmpty(spans)) {
			return []
		}
		const left = d.from(spans)
		return [
			{ kind: "allen", left: varTerm(left), mask: maskOf(d), right: oppositeOf(d, left, spans) }
		]
	})()
	const pointIn = ((): ReadonlyArray<Pred> => {
		if (!plan.pointIn || !Arr.isReadonlyArrayNonEmpty(spans)) {
			return []
		}
		const span = d.from(spans)
		const of = pointKind(span.field.kind)
		if (of === undefined) {
			return []
		}
		const points = Arr.filter(bound, (v) => v.field.kind === of)
		const point =
			Arr.isReadonlyArrayNonEmpty(points) && d.from([0, 1]) === 0
				? varTerm(d.from(points))
				: d.param(fieldOfKind(of))
		return [{ kind: "pointIn", point, span: oppositeOf(d, span, spans) }]
	})()
	return [...allen, ...pointIn]
}

/** A producer over a drawn span: intersection and difference with a span or span parameter of its type, pack alone. */
const producerOf = (
	d: Drawing,
	fn: "intersection" | "difference" | "pack",
	spans: Arr.NonEmptyReadonlyArray<Var>
): HeadTerm => {
	const left = d.from(spans)
	return fn === "pack"
		? { kind: "pack", of: varTerm(left) }
		: { kind: "produce", fn, left: varTerm(left), right: oppositeOf(d, left, spans) }
}

/** What a cosine distance from the embedding of Slot's `copy`-th match is to. */
const cosineTerm = (d: Drawing, to: CosineTo, copy: number): Term => {
	switch (to) {
		case "param":
			return d.param(embeddingField)
		case "vector":
			return { kind: "vector", dims: 3 }
		case "image":
			return varTerm({ field: imageField, copy })
		case "self":
			return varTerm({ field: embeddingField, copy })
		case "short":
			return { kind: "vector", dims: 2 }
		case "integer":
			return { kind: "constant", of: "integer", value: 1 }
	}
}

/** A span's width over a drawn bound span, where the plan holds one: in days over dates, an exact integer otherwise. */
const widthOf = (d: Drawing, plan: Plan, spans: ReadonlyArray<Var>): ReadonlyArray<HeadTerm> => {
	if (!plan.width || !Arr.isReadonlyArrayNonEmpty(spans)) {
		return []
	}
	const span = d.from(spans)
	const kind = spanKindOf(span.field.kind)
	return kind === undefined ? [] : [{ kind: "width", of: varTerm(span), span: kind }]
}

/** A kind as a span's kind, where it is one. */
const spanKindOf = (kind: Kind): SpanKind | undefined => {
	switch (kind) {
		case "span":
		case "bigSpan":
		case "centsSpan":
		case "dateSpan":
			return kind
		case "uuid":
		case "int":
		case "code":
		case "cents":
		case "big":
		case "date":
		case "vector":
			return undefined
	}
}

/** The endpoint descriptor of a span kind, which Compute.width takes beside the span: its source and its value. */
const endpointDescriptors: { readonly [K in SpanKind]: readonly [string, unknown] } = {
	span: ["pg.integer", pg.integer],
	bigSpan: ["pg.bigint", pg.bigint],
	centsSpan: ["Cents", Cents],
	dateSpan: ["date", date]
}

/**
 * The head terms a rule's plan adds after its drawn head: its producer, its distance, its embedding; and the producer
 * packTerm plants over a drawn variable, the second producer or the count producerHead plants beside its producer, and
 * the count, the producer or nothing nearestSource plants beside a search's distance.
 */
const extrasOf = (d: Drawing, plan: Plan, slot: Slotted): ReadonlyArray<HeadTerm> => {
	const spans = Arr.filter(slot.bound, (v) => isSpan(v.field.kind))
	const embedding = varTerm({ field: embeddingField, copy: slot.copy })
	const produced: ReadonlyArray<HeadTerm> =
		plan.producer !== undefined && Arr.isReadonlyArrayNonEmpty(spans)
			? [producerOf(d, plan.producer, spans)]
			: []
	const planted = ((): ReadonlyArray<HeadTerm> => {
		if (d.fault === "packTerm" && Arr.isReadonlyArrayNonEmpty(slot.bound)) {
			return [{ kind: "pack", of: varTerm(d.from(slot.bound)) }]
		}
		if (d.fault === "producerHead" && Arr.isReadonlyArrayNonEmpty(spans)) {
			return [
				d.from([0, 1]) === 0
					? { kind: "count" }
					: producerOf(d, d.from(["intersection", "difference", "pack"] as const), spans)
			]
		}
		if (d.fault === "nearestSource" && Arr.isReadonlyArrayNonEmpty(spans)) {
			switch (d.from(["count", "producer", "none"] as const)) {
				case "count":
					return [{ kind: "count" }]
				case "producer":
					return [producerOf(d, d.from(["intersection", "difference", "pack"] as const), spans)]
				case "none":
					return []
			}
		}
		return []
	})()
	return [
		...produced,
		...widthOf(d, plan, spans),
		...(plan.cosine === undefined
			? []
			: [{ kind: "cosine", of: embedding, to: cosineTerm(d, plan.cosine, slot.copy) } as const]),
		...(plan.vectorHead ? [{ kind: "term", t: embedding } as const] : []),
		...planted
	]
}

/**
 * The construct spanEndpoints plants over Slot's spans, of three endpoint types: an Allen predicate or a producer over
 * two, or a point's test of an integer in one, which the engine admits exactly where the types meet. The second span is
 * three times in four the first's partner, a span over Cents for one over its base bigint and back, the subtle pair, whose
 * carriers agree and whose brands do not.
 */
type Endpoint =
	| { readonly kind: "filter"; readonly p: Pred }
	| { readonly kind: "head"; readonly h: HeadTerm }

const endpointOf = (
	d: Drawing,
	spans: Arr.NonEmptyReadonlyArray<Var>,
	bound: ReadonlyArray<Var>
): Endpoint => {
	const ints = Arr.filter(bound, (v) => v.field.kind === "int")
	const first = d.from(spans)
	const partner = Arr.filter(spans, (v) => v.field.kind === partnerKind(first.field.kind))
	const left = varTerm(first)
	const right = varTerm(
		Arr.isReadonlyArrayNonEmpty(partner) && d.from([0, 1, 2, 3]) !== 0
			? d.from(partner)
			: d.from(spans)
	)
	switch (d.from(["allen", "pointIn", "intersection", "difference"] as const)) {
		case "allen":
			return { kind: "filter", p: { kind: "allen", left, mask: maskOf(d), right } }
		case "pointIn":
			return {
				kind: "filter",
				p: {
					kind: "pointIn",
					point: Arr.isReadonlyArrayNonEmpty(ints) ? varTerm(d.from(ints)) : d.param(integerField),
					span: right
				}
			}
		case "intersection":
			return { kind: "head", h: { kind: "produce", fn: "intersection", left, right } }
		case "difference":
			return { kind: "head", h: { kind: "produce", fn: "difference", left, right } }
	}
}

/** The kind of span a span's endpoint type is nearest to: a span over Cents and one over bigint each other's. */
const partnerKind = (kind: Kind): Kind => {
	switch (kind) {
		case "centsSpan":
			return "bigSpan"
		case "bigSpan":
			return "centsSpan"
		case "uuid":
		case "int":
		case "code":
		case "cents":
		case "big":
		case "date":
		case "span":
		case "dateSpan":
		case "vector":
			return kind
	}
}

/** The names a stranger binding is drawn from: every relation's fields, and one no source has. */
const strangerNames: Arr.NonEmptyReadonlyArray<string> = [
	...Arr.dedupe(Arr.map(allFields, (f) => f.name)),
	"nope"
]

/**
 * A rule's matches with one binding more, at a match other than Tones: a name drawn half the time among the source's
 * own fields the match leaves unbound, and otherwise among every relation's fields and a stranger's, bound where it
 * names a field of the source to that field's own variable, and otherwise to a literal. The engine decides whether the
 * source has the field.
 */
const strangerOf = (
	d: Drawing,
	matches: Arr.NonEmptyReadonlyArray<Match>
): Arr.NonEmptyReadonlyArray<Match> => {
	const at = d.from(Arr.map(matches, (_m, i) => i))
	return Arr.map(matches, (m, i) => {
		if (i !== at || m.rel === "Tones") {
			return m
		}
		const named = Arr.map(m.bindings, ([f]) => f)
		const free = Arr.filter(strangerNames, (n) => !Arr.contains(named, n))
		if (!Arr.isReadonlyArrayNonEmpty(free)) {
			return m
		}
		const own = Arr.filter(
			Arr.map(fieldsOf[m.rel], (f) => f.name),
			(n) => !Arr.contains(named, n)
		)
		const name =
			Arr.isReadonlyArrayNonEmpty(own) && d.from([0, 1]) === 0 ? d.from(own) : d.from(free)
		const field = Arr.findFirst(fieldsOf[m.rel], (f) => f.name === name)
		const term: Term = Option.isSome(field)
			? varTerm({ field: field.value, copy: m.copy })
			: { kind: "literal", type: "int", value: 0 }
		return { ...m, bindings: [...m.bindings, [name, term] as const] }
	})
}

/**
 * The scope names a scope's name is drawn from where a case plants scopeName: the declared-name dictionary's admitted
 * names and its refused ones, each half the draws, so the few refused spellings are drawn as often as the many admitted.
 */
const scopeNames: readonly [ReadonlyArray<string>, ReadonlyArray<string>] = [
	["peer", ...Arr.map(admittedNames, (n) => n.declared)],
	Arr.map(refusedNames, (n) => n.declared)
]

/**
 * A rule whose one scope, drawn among the scopes its terms read, is written as the case's scope fault says: a name of
 * the dictionary, other than any scope of the rule, under scopeName; no name under unnamedScope; its own name spelled
 * through a `string` under widenedName. A rule that reads no variable is left as it is.
 */
const spelled = (d: Drawing, rule: RuleSpec): RuleSpec => {
	const scopes = Arr.dedupe(Arr.map(variablesOf(rule), scopeOf))
	if (!Arr.isReadonlyArrayNonEmpty(scopes)) {
		return rule
	}
	const scope = d.from(scopes)
	const spelling = (): Spelling | undefined => {
		switch (d.fault) {
			case "scopeName": {
				const free = Arr.filter(d.from(scopeNames), (n) => !Arr.contains(scopes, n))
				return Arr.isReadonlyArrayNonEmpty(free)
					? { kind: "literal", name: d.from(free) }
					: undefined
			}
			case "unnamedScope":
				return { kind: "omitted" }
			case "widenedName":
				return { kind: "widened" }
			case "clean":
			case "stranger":
			case "stray":
			case "unkeyedFold":
			case "unionTypes":
			case "emptyRelation":
			case "strayRows":
			case "unboundImport":
			case "allenTerm":
			case "cosineDims":
			case "cosineTerm":
			case "orderHidden":
			case "spanEndpoints":
			case "packTerm":
			case "producerHead":
			case "nearestBy":
			case "nearestSource":
				return undefined
		}
	}
	const drawn = spelling()
	return drawn === undefined ? rule : { ...rule, spellings: [[scope, drawn]] }
}

/** Each key of a match's source, by its fields: Tones, a union keyed by its heading, by id and tone. */
const sourceKeys = (source: MatchSource): Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> =>
	source === "Tones" ? [["id", "tone"]] : keysOf[source]

/**
 * A match a fold reads, which binds every field of one key of its source (a fold reads each fact it matches once, by a
 * key): as drawn when it does, and otherwise with its source's first key's unbound fields bound to variables of its
 * own scope; Tones' id, a field of Item's facts, to the first Item match's.
 */
const keyedMatch = (m: Match): Match => {
	const named = new Set(Arr.map(m.bindings, ([f]) => f))
	const keys = sourceKeys(m.rel)
	if (Option.isSome(Arr.findFirst(keys, (k) => Arr.every(k, (f) => named.has(f))))) {
		return m
	}
	const fields = m.rel === "Tones" ? fieldsOf.Item : fieldsOf[m.rel]
	const [first] = keys
	const added = Arr.flatMap(first, (name: string): ReadonlyArray<readonly [string, Term]> => {
		const field = Arr.findFirst(fields, (f) => f.name === name)
		return named.has(name) || Option.isNone(field)
			? []
			: [[name, varTerm({ field: field.value, copy: m.copy })]]
	})
	return { ...m, bindings: Arr.appendAll(m.bindings, added) }
}

/** A constant some arm of Tones holds at tone: low or mid, as a handle or as the member's JavaScript value. */
const tonesConstant = (d: Drawing): Term => {
	const value = d.from([0, 1])
	return d.from([0, 1]) === 0 ? { kind: "handle", value } : { kind: "literal", type: "code", value }
}

/** The rule's filters: an equality with a value fixed per binding, between two variables, a range; joined or not. */
const filtersOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<Pred> => {
	const simple: Array<Pred> = []
	if (Arr.isReadonlyArrayNonEmpty(bound) && d.keep("fixFilter")) {
		const v = d.from(bound)
		simple.push({ kind: "cmp", op: "eq", a: varTerm(v), b: inputOf(d, v.field), via: viaOf(d) })
	}
	const pairs = Arr.flatMap(bound, (a, i) =>
		Arr.flatMap(bound.slice(i + 1), (b) => (a.field.kind === b.field.kind ? [[a, b] as const] : []))
	)
	if (Arr.isReadonlyArrayNonEmpty(pairs) && d.keep("varEquality")) {
		const [a, b] = d.from(pairs)
		simple.push({ kind: "cmp", op: "eq", a: varTerm(a), b: varTerm(b), via: viaOf(d) })
	}
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	if (Arr.isReadonlyArrayNonEmpty(ints) && d.keep("rangeFilter")) {
		simple.push({
			kind: "cmp",
			op: d.from(["lt", "ge"] as const),
			a: varTerm(d.from(ints)),
			b:
				d.from([0, 1]) === 0
					? literalOf(d, "int")
					: { kind: "constant", of: "integer", value: d.from([1, 2]) },
			via: viaOf(d)
		})
	}
	const negated = negationOver(d, bound)
	const [first, second, ...rest] = simple
	if (first === undefined || second === undefined) {
		return [...simple, ...negated]
	}
	if (d.keep("disjunction")) {
		return [{ kind: "or", ps: [first, second], via: viaOf(d) }, ...rest, ...negated]
	}
	if (d.keep("conjunction")) {
		return [{ kind: "and", ps: [first, second], via: viaOf(d) }, ...rest, ...negated]
	}
	return [...simple, ...negated]
}

/**
 * A filter on a flag over the bound variables: one of two comparisons, or one a spread array may hold, each an
 * equality with a value fixed per binding, which fixes its variable under the flag's one value alone.
 */
const flaggedOver = (d: Drawing, bound: ReadonlyArray<Var>): Flagged | undefined => {
	if (!Arr.isReadonlyArrayNonEmpty(bound)) {
		return undefined
	}
	const fixing = (): Pred => {
		const v = d.from(bound)
		return { kind: "cmp", op: "eq", a: varTerm(v), b: inputOf(d, v.field), via: viaOf(d) }
	}
	if (d.keep("flaggedEither")) {
		return { kind: "either", ifTrue: fixing(), ifFalse: fixing() }
	}
	return d.keep("flaggedSpread") ? { kind: "spread", p: fixing() } : undefined
}

/** A negation: no fact of a relation whose field holds a bound variable of its kind. */
const negationOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<Pred> => {
	const pairs = Arr.flatMap(rels, (rel) =>
		Arr.flatMap(fieldsOf[rel], (f) =>
			Arr.flatMap(bound, (v) => (v.field.kind === f.kind ? [[rel, f.name, v] as const] : []))
		)
	)
	if (!Arr.isReadonlyArrayNonEmpty(pairs) || !d.keep("negation")) {
		return []
	}
	const [rel, field, v] = d.from(pairs)
	return [{ kind: "not", rel, field, t: varTerm(v) }]
}

/**
 * A conditional over a comparison, or a conjunction of two, whose branches are bound integers, constants or literals.
 */
const condOver = (d: Drawing, bound: ReadonlyArray<Var>, ints: ReadonlyArray<Var>): Term => {
	const first = comparisonOver(d, bound)
	const p: Pred = d.keep("conjunction")
		? { kind: "and", ps: [first, comparisonOver(d, bound)], via: viaOf(d) }
		: first
	const onTrue: Term =
		Arr.isReadonlyArrayNonEmpty(ints) && d.from([0, 1]) === 0
			? varTerm(d.from(ints))
			: { kind: "constant", of: "integer", value: 1 }
	const onFalse: Term =
		Arr.isReadonlyArrayNonEmpty(ints) && d.from([0, 1]) === 0
			? varTerm(d.from(ints))
			: literalOf(d, "int")
	return { kind: "cond", p, onTrue, onFalse }
}

/** Up to two distinct group terms over the bound variables. */
const groupsOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<Var> => {
	if (!Arr.isReadonlyArrayNonEmpty(bound)) {
		return []
	}
	const groups: Array<Var> = []
	for (let i = 0; i < 2; i++) {
		const v = d.keep("groupTerm") ? d.from(bound) : undefined
		if (v !== undefined && !Arr.some(groups, (g) => sameVar(g, v))) {
			groups.push(v)
		}
	}
	return groups
}

/**
 * The folds a grouped head may hold beside its count: a sum, a least or greatest value, a mean, each over a bound
 * integer or Item.cost, a contract's, whose brand min and max keep.
 */
const foldsOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<HeadTerm> => {
	const folded = Arr.filter(bound, (b) => b.field.kind === "int" || b.field.kind === "cents")
	if (!Arr.isReadonlyArrayNonEmpty(folded)) {
		return []
	}
	const of = (): Term => varTerm(d.from(folded))
	return [
		...(d.keep("sum") ? [{ kind: "fold", fold: "sum", of: of() } as const] : []),
		...(d.keep("minMax")
			? [{ kind: "fold", fold: d.from(["min", "max"] as const), of: of() } as const]
			: []),
		...(d.keep("mean") ? [{ kind: "fold", fold: "mean", of: of() } as const] : [])
	]
}

/**
 * The head: a grouped aggregate, or one to three fields of variables, computations, conditionals, literals and
 * parameters, each a parameter declared at a field's descriptor, which types it. Its fields are named by `prefix`.
 */
const headOver = (
	d: Drawing,
	bound: ReadonlyArray<Var>,
	prefix: "h" | "g",
	fold: boolean
): Arr.NonEmptyReadonlyArray<readonly [string, HeadTerm]> => {
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	if (fold) {
		const groups = groupsOver(d, bound)
		const terms: Arr.NonEmptyReadonlyArray<HeadTerm> = [
			{ kind: "count" },
			...Arr.map(groups, (g): HeadTerm => ({ kind: "term", t: varTerm(g) })),
			...foldsOver(d, bound)
		]
		return Arr.map(terms, (t, i) => [`${prefix}${i}`, t] as const)
	}
	return Arr.map(Arr.range(0, d.from([0, 1, 2])), (i) => {
		const anywhere: ReadonlyArray<Form<HeadTerm>> = [
			["condHead", () => ({ kind: "term", t: condOver(d, bound, ints) })],
			["literalHead", () => ({ kind: "literal", value: d.from([0, 1, "a", "b"]) })],
			["constantHead", () => ({ kind: "term", t: handleOf(d) })],
			["paramHead", () => ({ kind: "term", t: d.param(d.from(fieldsOf.Item)) })]
		]
		const forms: Arr.NonEmptyReadonlyArray<Form<HeadTerm>> = Arr.isReadonlyArrayNonEmpty(bound)
			? [
					["headVar", () => ({ kind: "term", t: varTerm(d.from(bound)) })],
					...(Arr.isReadonlyArrayNonEmpty(ints)
						? [
								[
									"computedHead",
									(): HeadTerm => ({ kind: "term", t: computedOver(d, ints) })
								] as const
							]
						: []),
					...anywhere
				]
			: [["literalHead", () => ({ kind: "literal", value: d.from([0, 1, "a", "b"]) })], ...anywhere]
		return [`${prefix}${i}`, d.choose(forms)] as const
	})
}

/** A union's second arm: the first's, with its parameters renamed and, under a discriminant, each arm told apart. */
const secondArm = (arm: RuleSpec): RuleSpec => ({ ...arm, ...renamed(arm) })

const renamed = (
	arm: RuleSpec
): Pick<RuleSpec, "matches" | "filters" | "flagged" | "head" | "rows" | "owned" | "stages"> => {
	const term = (t: Term): Term => {
		switch (t.kind) {
			case "param":
				return { ...t, name: `${t.name}b` }
			case "arith":
				return { ...t, a: term(t.a), b: term(t.b) }
			case "neg":
				return { ...t, a: term(t.a) }
			case "cond":
				return { ...t, p: pred(t.p), onTrue: term(t.onTrue), onFalse: term(t.onFalse) }
			case "var":
			case "literal":
			case "constant":
			case "handle":
			case "vector":
				return t
		}
	}
	const pred = (p: Pred): Pred => {
		switch (p.kind) {
			case "cmp":
				return { ...p, a: term(p.a), b: term(p.b) }
			case "and":
			case "or":
				return { ...p, ps: [pred(p.ps[0]), pred(p.ps[1])] }
			case "not":
				return { ...p, t: term(p.t) }
			case "allen":
				return { ...p, left: term(p.left), right: term(p.right) }
			case "pointIn":
				return { ...p, point: term(p.point), span: term(p.span) }
		}
	}
	const head = (h: HeadTerm): HeadTerm => {
		switch (h.kind) {
			case "term":
				return { kind: "term", t: term(h.t) }
			case "fold":
			case "pack":
				return { ...h, of: term(h.of) }
			case "produce":
				return { ...h, left: term(h.left), right: term(h.right) }
			case "cosine":
				return { ...h, of: term(h.of), to: term(h.to) }
			case "width":
				return { ...h, of: term(h.of) }
			case "literal":
			case "count":
				return h
		}
	}
	return {
		matches: Arr.map(arm.matches, (m) => ({
			...m,
			bindings: Arr.map(m.bindings, ([f, t]) => [f, term(t)] as const)
		})),
		filters: Arr.map(arm.filters, pred),
		flagged:
			arm.flagged === undefined
				? undefined
				: arm.flagged.kind === "either"
					? { kind: "either", ifTrue: pred(arm.flagged.ifTrue), ifFalse: pred(arm.flagged.ifFalse) }
					: { kind: "spread", p: pred(arm.flagged.p) },
		head: Arr.map(arm.head, ([n, h]) => [n, head(h)] as const),
		rows: arm.rows === undefined ? undefined : { ...arm.rows, name: `${arm.rows.name}b` },
		owned: Arr.map(arm.owned, (o) =>
			o.kind === "bound" ? { kind: "bound", owner: term(o.owner) } : o
		),
		stages: Arr.map(arm.stages, (o) => (o.kind === "param" ? { ...o, name: `${o.name}b` } : o))
	}
}

const discriminated = (arm: RuleSpec, value: HeadTerm): RuleSpec => ({
	...arm,
	head: [...arm.head, ["d", value]]
})

/**
 * A union's two discriminants of Tone: the first arm's a handle, the second arm's a handle or its member's JavaScript
 * value, which the first arm's closed id types.
 */
const handleDiscriminants = (d: Drawing): readonly [HeadTerm, HeadTerm] => [
	{ kind: "term", t: { kind: "handle", value: 0 } },
	d.from([0, 1]) === 0
		? { kind: "term", t: { kind: "handle", value: 1 } }
		: { kind: "literal", value: toneOf(1) }
]

/** A union's two discriminants as JavaScript values. */
const literalDiscriminants: readonly [HeadTerm, HeadTerm] = [
	{ kind: "literal", value: "a" },
	{ kind: "literal", value: "b" }
]

/**
 * The query a drawing draws: a rule, a union of it with its renamed twin or with a rule of its own heading, and a take
 * that closes it. A handle discriminant is drawn first, so a case that keeps it is a discriminated union whatever the
 * union's own gates draw. A pinned self-join is no union's arm, so its get is proved whatever the rest of the case
 * draws. A union of two headings is discriminated, its second arm's fields named apart from the first's, but where the
 * case plants unionTypes, which names them as the first's. A faulted case's query is one rule, so its fault stands
 * once, but for unionTypes, whose fault is its second arm.
 */
const drawQuery = (d: Drawing): QuerySpec => {
	const search =
		d.fault === "nearestBy" ||
		d.fault === "nearestSource" ||
		(d.fault === "clean" && d.keep("nearest"))
	const { rule: first, pinned } = drawRule(d, "h", "rows", search)
	const plain = d.fault === "clean" && !pinned && !search
	const handled = plain && d.keep("handleDiscriminant")
	if (handled) {
		d.note("union")
		d.note("discriminant")
	}
	const heterogeneous = d.fault === "unionTypes" || (plain && d.keep("heterogeneous"))
	const union = handled || heterogeneous || (plain && d.keep("union"))
	const tagged = handled
		? handleDiscriminants(d)
		: heterogeneous || (union && d.keep("discriminant"))
			? literalDiscriminants
			: undefined
	const second = (): RuleSpec =>
		heterogeneous
			? drawRule(d, d.fault === "unionTypes" ? "h" : "g", "rowsb", false).rule
			: secondArm(first)
	const arms: Arr.NonEmptyReadonlyArray<RuleSpec> = union
		? tagged !== undefined
			? [discriminated(first, tagged[0]), discriminated(second(), tagged[1])]
			: [first, second()]
		: [first]
	const hiding = d.fault === "orderHidden"
	const take = hiding
		? 1
		: !heterogeneous && d.keep("take")
			? d.keep("namedTake")
				? "k"
				: d.from([1, 2] as const)
			: undefined
	return {
		arms,
		take,
		hidden: hiding
			? d.from([0, 1]) === 0
				? d.from(Arr.map(first.head, ([name]) => name))
				: d.from(["id", "owner", "nope"] as const)
			: undefined,
		fault: d.fault,
		request: take === undefined && !heterogeneous && !search ? requestOf(d) : undefined,
		nearest: search ? nearestOf(d, first) : undefined,
		db: d.keep("reporterDb") ? "Reporter" : "Reader",
		keyed:
			d.fault === "clean"
				? {
						target: d.from(keyTargets),
						shape: d.from(["key", "beside", "short", "instead"] as const)
					}
				: undefined
	}
}

/**
 * The approximate search over a rule its draw made rankable: by its distance, or, where the case plants nearestBy, by its
 * distance half the time and otherwise by a name drawn among its head's; taking one fact or three.
 */
const nearestOf = (d: Drawing, rule: RuleSpec): Nearest => {
	const names = Arr.map(rule.head, ([name]) => name)
	const distance = Arr.findFirst(rule.head, ([, h]) => h.kind === "cosine")
	return {
		by:
			Option.isNone(distance) || (d.fault === "nearestBy" && d.from([0, 1]) === 0)
				? d.from(names)
				: distance.value[0],
		take: d.from([1, 3] as const)
	}
}

/**
 * A page request: a valid one, one of a shape the runtime refuses, or one whose anchor is null or undefined, each a
 * direction's size with its anchor or none.
 */
const requestOf = (d: Drawing): PageRequestSpec => {
	const [size, anchor] = d.from([
		["first", "after"],
		["last", "before"]
	] as const)
	const anchored = (value: RequestValue): PageRequestSpec => [
		[size, "size"],
		[anchor, value]
	]
	switch (d.from(["valid", "valid", "shape", "null", "undefined", "string"] as const)) {
		case "valid":
			return d.from([[[size, "size"]], anchored("cursor")] as const)
		case "null":
			return anchored("null")
		case "undefined":
			return anchored("undefined")
		case "string":
			return anchored("string")
		case "shape":
			return d.from<PageRequestSpec>([
				[
					["first", "size"],
					["last", "size"]
				],
				[],
				[[anchor, "cursor"]],
				[
					[size, "size"],
					["after", "cursor"],
					["before", "cursor"]
				],
				[
					[size, "size"],
					[anchor === "after" ? "before" : "after", "cursor"]
				]
			])
	}
}

/** A calendar date a literal of index `value` names, in January 2026. */
const dateOf = (value: number): string => `2026-01-${pipe(String(value + 1), Str.padStart(2, "0"))}`

const uuidOf = (value: number): string =>
	`00000000-0000-4000-8000-${pipe(String(value), Str.padStart(12, "0"))}`

/** The words that name the second and third scope of one source in a rule. */
const ordinals = ["second", "third", "fourth"] as const

/**
 * A variable's scope name, which the program also declares its variables under: its source's name in lower camel case
 * for the first match of it, prefixed by the ordinal of its match after that, as a reader would name two scopes of one
 * relation by role.
 */
const scopeOf = (v: Var): string =>
	v.copy === 0
		? Str.uncapitalize(v.field.rel)
		: `${defined(ordinals[v.copy - 1], "a fourth match at most")}${v.field.rel}`

/** The name a bound Owned of a scope is declared under. */
const boundName = (scope: string): string => `${scope}Source`

/** The name a rule's relation parameter is declared under. */
const rowsConst = "rowsParam"

/** The scope Owned's `copy`-th match mints its variables in. */
const ownedScope = (copy: number): string => scopeOf({ field: fieldsOf.Owned[0], copy })

/** The name the interior stage of a rule's `copy`-th match of Stage is declared under, as a bound Owned's is. */
const stageConst = (copy: number): string => boundName(scopeOf({ field: fieldsOf.Stage[0], copy }))

/** An interior stage's owner binding in the program, a property of Item's bindings: none where it is free. */
const stageOwnerText = (owner: StageOwner): string => {
	switch (owner.kind) {
		case "param":
			return ` owner: r.param(${jsonText(owner.name)}, Item.fields.owner),`
		case "literal":
			return ` owner: ${jsonText(uuidOf(owner.value))},`
		case "free":
			return ""
	}
}

/** A line of a rendered query, and whether it is the line its planted fault's diagnostic is on. */
interface Line {
	readonly text: string
	readonly fault: boolean
}

/** The source of one query, its lines marking the one its planted fault's diagnostic is on. */
class Rendering {
	readonly #fault: Planted

	constructor(fault: Planted) {
		this.#fault = fault
	}

	term(t: Term): string {
		switch (t.kind) {
			case "var":
				return `${scopeOf(t.v)}.${t.v.field.name}`
			case "param":
				return `r.param(${jsonText(t.name)}, ${t.at.rel}.fields.${t.at.name})`
			case "literal":
				switch (t.type) {
					case "int":
						return String(t.value)
					case "big":
						return `${t.value}n`
					case "date":
						return jsonText(dateOf(t.value))
					case "uuid":
						return jsonText(uuidOf(t.value))
					case "code":
						return jsonText(toneOf(t.value))
				}
			case "constant":
				if (t.of === "cents") {
					return `Compute.literal(Cents, ${t.value}n)`
				}
				return `Compute.literal(pg.integer, ${t.value})`
			case "handle":
				return `Tone.handle(${jsonText(toneOf(t.value))})`
			case "vector":
				return `Vector.make(Float32Array.of(${Arr.join(Arr.map(componentsOf(t.dims), String), ", ")}), ${t.dims})`
			case "arith":
				return `Compute.${t.op}(${this.term(t.a)}, ${this.term(t.b)})`
			case "neg":
				return `Compute.neg(${this.term(t.a)})`
			case "cond":
				return `Compute.cond(${this.pred(t.p)}, ${this.term(t.onTrue)}, ${this.term(t.onFalse)})`
		}
	}

	pred(p: Pred): string {
		switch (p.kind) {
			case "not":
				return `r.not(${p.rel}, { ${p.field}: ${this.term(p.t)} })`
			case "allen":
				return `r.allen(${this.term(p.left)}, ${maskText(p.mask)}, ${this.term(p.right)})`
			case "pointIn":
				return `r.pointIn(${this.term(p.point)}, ${this.term(p.span)})`
			case "cmp":
				return `${p.via === "rule" ? "r" : "Compute"}.${p.op}(${this.term(p.a)}, ${this.term(p.b)})`
			case "and":
			case "or":
				return `${p.via === "rule" ? "r" : "Compute"}.${p.kind}(${this.pred(p.ps[0])}, ${this.pred(p.ps[1])})`
		}
	}

	head(h: HeadTerm): string {
		switch (h.kind) {
			case "term":
				return this.term(h.t)
			case "literal":
				return jsonText(h.value)
			case "count":
				return "r.count()"
			case "fold":
				return `r.${h.fold}(${this.term(h.of)})`
			case "produce":
				return `r.${h.fn}(${this.term(h.left)}, ${this.term(h.right)})`
			case "pack":
				return `r.pack(${this.term(h.of)})`
			case "cosine":
				return `Compute.cosineDistance(${this.term(h.of)}, ${this.term(h.to)})`
			case "width":
				return `Compute.width(${this.term(h.of)}, ${endpointDescriptors[h.span][0]})`
		}
	}

	/** A scope's v call: over its source, named as its spelling says. */
	scope(v: Var, arm: RuleSpec): string {
		const scope = scopeOf(v)
		const spelling = Option.getOrElse(
			Option.map(
				Arr.findFirst(arm.spellings, ([s]) => s === scope),
				([, s]) => s
			),
			(): Spelling => ({ kind: "literal", name: scope })
		)
		const over = sourceText(v.field.rel, v.copy, arm)
		switch (spelling.kind) {
			case "literal":
				return `v(${over}, ${jsonText(spelling.name)})`
			case "omitted":
				return `v(${over})`
			case "widened":
				return `v(${over}, anyName)`
		}
	}

	/** One arm's lines: its `.rule(` line, its declarations, its body, and its close. */
	rule(arm: RuleSpec, second: boolean): ReadonlyArray<Line> {
		const matches = Arr.map(arm.matches, (m) => {
			const bindings = Arr.map(m.bindings, ([f, t]) => `${f}: ${this.term(t)}`)
			const record = Arr.isReadonlyArrayNonEmpty(bindings)
				? `{ ${Arr.join(bindings, ", ")} }`
				: "{}"
			return `.match(${sourceText(m.rel, m.copy, arm)}, ${record})`
		})
		const flagged =
			arm.flagged === undefined
				? []
				: arm.flagged.kind === "either"
					? [`flag ? ${this.pred(arm.flagged.ifTrue)} : ${this.pred(arm.flagged.ifFalse)}`]
					: [`...Arr.filter([${this.pred(arm.flagged.p)}], () => flag)`]
		const predicates = [...Arr.map(arm.filters, (p) => this.pred(p)), ...flagged]
		const filters = Arr.isReadonlyArrayNonEmpty(predicates)
			? [`.where(${Arr.join(predicates, ", ")})`]
			: []
		const head = `.find({ ${Arr.join(
			Arr.map(arm.head, ([n, h]) => `${n}: ${this.head(h)}`),
			", "
		)} })`
		const body = `r${Arr.join([...matches, ...filters, head], "")}`
		const variables = variablesOf(arm)
		const rows: ReadonlyArray<Line> =
			arm.rows === undefined
				? []
				: [
						{
							text: `\t\tconst ${rowsConst} = r.relation(${jsonText(arm.rows.name)}, ${arm.rows.kind === "fields" ? this.heading(arm.rows.heading) : arm.rows.relation})`,
							fault: this.#fault === "emptyRelation" || this.#fault === "strayRows"
						}
					]
		const declare = (vs: ReadonlyArray<Var>): ReadonlyArray<Line> =>
			Arr.map(scopesOf(vs), (v) => ({
				text: `\t\tconst ${scopeOf(v)} = ${this.scope(v, arm)}`,
				fault: Arr.some(arm.spellings, ([s]) => s === scopeOf(v))
			}))
		const owned: ReadonlyArray<Line> = Arr.flatMap(arm.owned, (bind, copy) =>
			bind.kind === "bound"
				? [
						{
							text: `\t\tconst ${boundName(ownedScope(copy))} = Owned.bind({ owner: ${this.term(bind.owner)} })`,
							fault: false
						}
					]
				: []
		)
		const stages: ReadonlyArray<Line> = Arr.map(arm.stages, (owner, copy) => ({
			text: `\t\tconst ${stageConst(copy)} = r.interior((r) => { const inner = v(Item, "inner"); return r.match(Item, { id: inner.id,${stageOwnerText(owner)} n: inner.n }).find({ id: inner.id, n: inner.n }) })`,
			fault: false
		}))
		const returned: Line = {
			text: `\t\treturn ${body}`,
			fault: !second && returnFaults.has(this.#fault)
		}
		return [
			{ text: "\t.rule((r) => {", fault: second && this.#fault === "unionTypes" },
			...rows,
			...stages,
			...declare(Arr.filter(variables, (v) => v.field.rel !== "Owned")),
			...owned,
			...declare(Arr.filter(variables, (v) => v.field.rel === "Owned")),
			returned,
			{ text: "\t})", fault: false }
		]
	}

	/** A relation parameter's heading: its fields' descriptors, by name. */
	heading(fields: ReadonlyArray<Field>): string {
		const entries = Arr.map(fields, (f) => {
			switch (f.kind) {
				case "uuid":
					return `${f.name}: uuid`
				case "int":
					return `${f.name}: pg.integer`
				case "code":
				case "cents":
				case "big":
				case "date":
				case "span":
				case "bigSpan":
				case "centsSpan":
				case "dateSpan":
				case "vector": {
					const at = paramField(f.kind)
					return `${f.name}: ${at.rel}.fields.${at.name}`
				}
			}
		})
		return Arr.isReadonlyArrayNonEmpty(entries) ? `{ ${Arr.join(entries, ", ")} }` : "{}"
	}

	query(spec: QuerySpec): Arr.NonEmptyReadonlyArray<Line> {
		const arms = Arr.flatMap(spec.arms, (arm, i) => this.rule(arm, i > 0))
		const nearest: ReadonlyArray<Line> =
			spec.nearest === undefined
				? []
				: [
						{
							text: `\t.approximateNearest({ by: ${jsonText(spec.nearest.by)}, take: ${spec.nearest.take} })`,
							fault: this.#fault === "nearestBy" || this.#fault === "nearestSource"
						}
					]
		const take =
			spec.take === undefined
				? []
				: [
						{
							text: `\t.orderBy([${jsonText(orderedBy(spec))}, "asc"])`,
							fault: this.#fault === "orderHidden"
						},
						{ text: `\t.take(${jsonText(spec.take)})`, fault: false }
					]
		return [{ text: `query(${schemaOf(spec)})`, fault: false }, ...arms, ...nearest, ...take]
	}
}

/**
 * What a match of `rel` reads in the program, its `copy`-th of it: a relation's name, the rule's declared relation
 * parameter, Owned's binding under that match, Owned itself where that match leaves it unbound, or the interior stage
 * the rule describes for it.
 */
const sourceText = (rel: MatchSource, copy: number, arm: RuleSpec): string => {
	switch (rel) {
		case "Rows":
			return rowsConst
		case "Stage":
			return stageConst(copy)
		case "Owned": {
			const bind = arm.owned[copy]
			return bind === undefined || bind.kind === "unbound" ? "Owned" : boundName(ownedScope(copy))
		}
		case "Item":
		case "Tag":
		case "Note":
		case "Slot":
		case "Tone":
		case "ToneWeight":
		case "ItemTones":
		case "OwnerCounts":
		case "Stray":
		case "Tones":
			return rel
	}
}

/** The components of a vector value of `dims` dimensions, each nonzero, so its norm is in the cosine domain. */
const componentsOf = (dims: number): ReadonlyArray<number> => Arr.makeBy(dims, (i) => (i + 1) / 2)

/** An Allen mask as the program writes it: its names joined by `|`, under ALLEN's complement or converse. */
const maskText = (mask: Mask): string => {
	const union = Arr.join(
		Arr.map(mask.names, (n) => `ALLEN.${n}`),
		" | "
	)
	return mask.op === "none" ? union : `ALLEN.${mask.op}(${union})`
}

/** An Allen mask's value: its names' union, under ALLEN's complement or converse. */
const maskValue = (mask: Mask): number => {
	const union = Arr.reduce(mask.names, 0, (m, n) => m | ALLEN[n])
	switch (mask.op) {
		case "none":
			return union
		case "complement":
			return ALLEN.complement(union)
		case "converse":
			return ALLEN.converse(union)
	}
}

/**
 * The faults whose diagnostic is on the first arm's return line: a binding's, a match's, a fold's, an Allen
 * predicate's, a cosine distance's, a span's endpoints', a pack's and a producer's.
 */
const returnFaults: ReadonlySet<Planted> = new Set<Planted>([
	"stranger",
	"stray",
	"unkeyedFold",
	"unboundImport",
	"allenTerm",
	"cosineDims",
	"cosineTerm",
	"spanEndpoints",
	"packTerm",
	"producerHead"
])

/**
 * The field a take orders by: the first head field, which every arm of a union of one heading delivers, and whose
 * order the take completes by the rest of the heading, a key of each arm.
 */
const orderedBy = (spec: QuerySpec): string => spec.hidden ?? spec.arms[0].head[0][0]

/** The variables of each scope, one per scope, in their order. */
const scopesOf = (vs: ReadonlyArray<Var>): ReadonlyArray<Var> => {
	const seen = new Map<string, Var>()
	for (const v of vs) {
		if (!seen.has(scopeOf(v))) {
			seen.set(scopeOf(v), v)
		}
	}
	return [...seen.values()]
}

/** Every variable an arm reads, in the order of first use, an Owned binding's owner first. */
const variablesOf = (arm: RuleSpec): ReadonlyArray<Var> => {
	const seen = new Map<string, Var>()
	const term = (t: Term): void => {
		switch (t.kind) {
			case "var": {
				const key = `${scopeOf(t.v)}.${t.v.field.name}`
				if (!seen.has(key)) {
					seen.set(key, t.v)
				}
				return
			}
			case "arith":
				term(t.a)
				term(t.b)
				return
			case "neg":
				term(t.a)
				return
			case "cond":
				pred(t.p)
				term(t.onTrue)
				term(t.onFalse)
				return
			case "param":
			case "literal":
			case "constant":
			case "handle":
			case "vector":
				return
		}
	}
	const pred = (p: Pred): void => {
		switch (p.kind) {
			case "cmp":
				term(p.a)
				term(p.b)
				return
			case "and":
			case "or":
				pred(p.ps[0])
				pred(p.ps[1])
				return
			case "not":
				term(p.t)
				return
			case "allen":
				term(p.left)
				term(p.right)
				return
			case "pointIn":
				term(p.point)
				term(p.span)
				return
		}
	}
	for (const bind of arm.owned) {
		if (bind.kind === "bound") {
			term(bind.owner)
		}
	}
	for (const m of arm.matches) {
		for (const [, t] of m.bindings) {
			term(t)
		}
	}
	for (const p of [...arm.filters, ...flaggedPreds(arm.flagged)]) {
		pred(p)
	}
	for (const [, h] of arm.head) {
		switch (h.kind) {
			case "term":
				term(h.t)
				break
			case "fold":
			case "pack":
				term(h.of)
				break
			case "produce":
				term(h.left)
				term(h.right)
				break
			case "cosine":
				term(h.of)
				term(h.to)
				break
			case "width":
				term(h.of)
				break
			case "literal":
			case "count":
				break
		}
	}
	return [...seen.values()]
}

/** The predicates a flagged filter may hold. */
const flaggedPreds = (flagged: Flagged | undefined): ReadonlyArray<Pred> =>
	flagged === undefined
		? []
		: flagged.kind === "either"
			? [flagged.ifTrue, flagged.ifFalse]
			: [flagged.p]

/**
 * A spec under each value its flags may take: the spec itself where no rule states a flagged filter, and otherwise
 * the spec with every flagged filter resolved as the flag's true, and as its false, each a plain filter or none.
 */
const flagVariants = (spec: QuerySpec): Arr.NonEmptyReadonlyArray<QuerySpec> => {
	const resolved = (flag: boolean): QuerySpec => ({
		...spec,
		arms: Arr.map(spec.arms, (arm) => resolvedArm(arm, flag))
	})
	return Arr.some(spec.arms, (arm) => arm.flagged !== undefined)
		? [resolved(true), resolved(false)]
		: [spec]
}

/** An arm with its flagged filter, if it states one, resolved as the flag's one value reads it. */
const resolvedArm = (arm: RuleSpec, flag: boolean): RuleSpec => {
	const f = arm.flagged
	const extra: ReadonlyArray<Pred> =
		f === undefined ? [] : f.kind === "either" ? [flag ? f.ifTrue : f.ifFalse] : flag ? [f.p] : []
	return { ...arm, filters: [...arm.filters, ...extra], flagged: undefined }
}

/**
 * The two readings of the i-th arm's flagged filter, one of two predicates, as the types read a proof by cases
 * (evidence/evidence.ts SplitPinned): that arm's filter resolved as each value of the flag, every other arm's at what
 * both its predicates state. Only a choice of two predicates splits: a spread array states nothing under either value
 * that its absence does not.
 */
const splitReadings = (
	spec: QuerySpec,
	arm: RuleSpec,
	i: number
): readonly [QuerySpec, QuerySpec] => {
	const shared = sharedReading(spec)
	const reading = (flag: boolean): QuerySpec => ({
		...shared,
		arms: Arr.map(shared.arms, (other, j) => (j === i ? resolvedArm(arm, flag) : other))
	})
	return [reading(true), reading(false)]
}

/**
 * A spec as the types read its flags, whichever value the flag takes: each flagged filter resolved to what both its
 * predicates state (evidence/evidence.ts MustState). Two equalities that fix one variable leave it fixed, to the input
 * both name where they name one, and otherwise to a parameter of the arm's own that no other filter names, a value the
 * types do not name; two that fix different variables state nothing, and so does a spread array of unknown length.
 */
const sharedReading = (spec: QuerySpec): QuerySpec => ({
	...spec,
	arms: Arr.map(spec.arms, (arm, i) => {
		const f = arm.flagged
		const extra: ReadonlyArray<Pred> =
			f === undefined || f.kind === "spread" ? [] : bothState(f.ifTrue, f.ifFalse, `shared${i}`)
		return { ...arm, filters: [...arm.filters, ...extra], flagged: undefined }
	})
})

/** What two predicates, either of which may run, both state: the variable both fix, where they fix one. */
const bothState = (a: Pred, b: Pred, fresh: string): ReadonlyArray<Pred> => {
	if (a.kind !== "cmp" || b.kind !== "cmp" || a.op !== "eq" || b.op !== "eq") {
		return []
	}
	const [x, y] = [a.a, b.a]
	if (x.kind !== "var" || y.kind !== "var" || !sameVar(x.v, y.v)) {
		return []
	}
	return [
		sameInput(a.b, b.b)
			? a
			: {
					kind: "cmp",
					op: "eq",
					a: x,
					b: { kind: "param", name: fresh, at: paramField(x.v.field.kind) },
					via: "rule"
				}
	]
}

/** Whether two inputs name one value, as the types name a fixed variable's value: one literal, handle or parameter. */
const sameInput = (x: Term, y: Term): boolean =>
	(x.kind === "literal" && y.kind === "literal" && x.type === y.type && x.value === y.value) ||
	(x.kind === "handle" && y.kind === "handle" && x.value === y.value) ||
	(x.kind === "param" && y.kind === "param" && x.name === y.name)

/** The rule a spec's arm states, built through the query builder's JavaScript view, as the engine compiles it. */
const builtArm =
	(arm: RuleSpec) =>
	(r: RuleValue): unknown => {
		const rows =
			arm.rows === undefined
				? undefined
				: r.relation(
						arm.rows.name,
						arm.rows.kind === "fields"
							? Rec.fromEntries(
									Arr.map(arm.rows.heading, (f) => [f.name, rowsDescriptor(f)] as const)
								)
							: arm.rows.relation === "Batch"
								? Batch
								: Stray
					)
		const stages = Arr.map(arm.stages, (owner) =>
			r.interior((inner: RuleValue) => {
				const vars = varsOver(Item, "inner")
				return inner
					.match(Item, { id: vars["id"], ...stageOwnerValue(inner, owner), n: vars["n"] })
					.find({ id: vars["id"], n: vars["n"] })
			})
		)
		const minted = new Map<string, Readonly<Record<string, unknown>>>()
		const bound = new Map<number, unknown>()
		const sourceOf = (rel: MatchSource, copy: number): unknown => {
			switch (rel) {
				case "Rows":
					return rows
				case "Stage":
					return stages[copy]
				case "Owned":
					return bound.get(copy) ?? ownedImport
				case "Item":
				case "Tag":
				case "Note":
				case "Slot":
				case "Tone":
				case "ToneWeight":
				case "ItemTones":
				case "OwnerCounts":
				case "Stray":
				case "Tones":
					return relations[rel]
			}
		}
		const variable = (v: Var): unknown => {
			const scope = scopeOf(v)
			const spelling = Option.map(
				Arr.findFirst(arm.spellings, ([s]) => s === scope),
				([, s]) => s
			)
			const name =
				Option.isSome(spelling) && spelling.value.kind === "omitted"
					? undefined
					: scopeName(spelling, scope)
			const vars = minted.get(scope) ?? varsOver(sourceOf(v.field.rel, v.copy), name)
			minted.set(scope, vars)
			return vars[v.field.name]
		}
		const term = (t: Term): unknown => {
			switch (t.kind) {
				case "var":
					return variable(t.v)
				case "param":
					return r.param(t.name, descriptorOf(t.at))
				case "literal":
					switch (t.type) {
						case "int":
							return t.value
						case "big":
							return BigInt(t.value)
						case "date":
							return dateOf(t.value)
						case "uuid":
							return uuidOf(t.value)
						case "code":
							return toneOf(t.value)
					}
				case "constant":
					return t.of === "cents"
						? computeCore.literal(Cents, BigInt(t.value))
						: computeCore.literal(pg.integer, t.value)
				case "handle":
					return Tone.handle(toneOf(t.value))
				case "vector":
					return Vector.make(Float32Array.from(componentsOf(t.dims)), t.dims)
				case "arith": {
					const a = term(t.a)
					const b = term(t.b)
					return t.op === "add"
						? computeCore.add(a, b)
						: t.op === "sub"
							? computeCore.sub(a, b)
							: computeCore.mul(a, b)
				}
				case "neg":
					return computeCore.neg(term(t.a))
				case "cond":
					return computeCore.cond(pred(t.p), term(t.onTrue), term(t.onFalse))
			}
		}
		const pred = (p: Pred): unknown => {
			if (p.kind === "not") {
				return r.not(relations[p.rel], { [p.field]: term(p.t) })
			}
			if (p.kind === "allen") {
				return r.allen(term(p.left), maskValue(p.mask), term(p.right))
			}
			if (p.kind === "pointIn") {
				return r.pointIn(term(p.point), term(p.span))
			}
			if (p.kind !== "cmp") {
				const [x, y] = [pred(p.ps[0]), pred(p.ps[1])]
				return p.via === "rule"
					? p.kind === "and"
						? r.and(x, y)
						: r.or(x, y)
					: p.kind === "and"
						? computeCore.and(x, y)
						: computeCore.or(x, y)
			}
			const a = term(p.a)
			const b = term(p.b)
			const compare = p.via === "rule" ? r : computeCore
			switch (p.op) {
				case "eq":
					return compare.eq(a, b)
				case "ne":
					return compare.ne(a, b)
				case "lt":
					return compare.lt(a, b)
				case "ge":
					return compare.ge(a, b)
			}
		}
		const head = (h: HeadTerm): unknown => {
			switch (h.kind) {
				case "term":
					return term(h.t)
				case "literal":
					return h.value
				case "count":
					return r.count()
				case "fold":
					return r[h.fold](term(h.of))
				case "produce":
					return h.fn === "intersection"
						? r.intersection(term(h.left), term(h.right))
						: r.difference(term(h.left), term(h.right))
				case "pack":
					return r.pack(term(h.of))
				case "cosine":
					return computeCore.cosineDistance(term(h.of), term(h.to))
				case "width":
					return computeCore.width(term(h.of), endpointDescriptors[h.span][1])
			}
		}
		for (const [copy, bind] of arm.owned.entries()) {
			if (bind.kind === "bound") {
				bound.set(copy, ownedImport.bind({ owner: term(bind.owner) }))
			}
		}
		const matched = Arr.reduce(arm.matches, r, (rule, m) =>
			rule.match(
				sourceOf(m.rel, m.copy),
				Rec.fromEntries(Arr.map(m.bindings, ([f, t]) => [f, term(t)] as const))
			)
		)
		const filtered = Arr.reduce(
			Arr.chunksOf(Arr.map(arm.filters, pred), 8),
			matched,
			(rule, predicates) => rule.where(...argumentsOf(predicates))
		)
		return filtered.find(Rec.fromEntries(Arr.map(arm.head, ([n, h]) => [n, head(h)] as const)))
	}

/** An interior stage's owner binding through the JavaScript view of its rule `inner`: none where it is free. */
const stageOwnerValue = (
	inner: RuleValue,
	owner: StageOwner
): Readonly<Record<string, unknown>> => {
	switch (owner.kind) {
		case "param":
			return { owner: inner.param(owner.name, Item.fields.owner) }
		case "literal":
			return { owner: uuidOf(owner.value) }
		case "free":
			return {}
	}
}

/** The name a scope's v call passes: its spelling's literal, or the scope's own name, the value a `string` holds. */
const scopeName = (spelling: Option.Option<Spelling>, scope: string): string =>
	Option.isSome(spelling) && spelling.value.kind === "literal" ? spelling.value.name : scope

/** A relation parameter field's descriptor: the one its heading states it at. */
const rowsDescriptor = (f: Field): unknown => {
	switch (f.kind) {
		case "uuid":
			return uuid
		case "int":
			return pg.integer
		case "code":
		case "cents":
		case "big":
		case "date":
		case "span":
		case "bigSpan":
		case "centsSpan":
		case "dateSpan":
		case "vector":
			return descriptorOf(paramField(f.kind))
	}
}

/** Whether a source is one of Rollup's derived relations. */
const isDerived = (rel: MatchSource): rel is DerivedRel =>
	rel === "ItemTones" || rel === "OwnerCounts"

/** Whether a predicate negates a derived relation, at any depth of its connectives. */
const negatesDerived = (p: Pred): boolean => {
	switch (p.kind) {
		case "not":
			return isDerived(p.rel)
		case "and":
		case "or":
			return negatesDerived(p.ps[0]) || negatesDerived(p.ps[1])
		case "cmp":
		case "allen":
		case "pointIn":
			return false
	}
}

/** The schema a query is over: Rollup where an arm matches or negates a derived relation, which only Rollup holds. */
const schemaOf = (spec: QuerySpec): "Agree" | "Rollup" =>
	Arr.some(
		spec.arms,
		(arm) =>
			Arr.some(arm.matches, (m) => isDerived(m.rel)) ||
			Arr.some([...arm.filters, ...flaggedPreds(arm.flagged)], negatesDerived)
	)
		? "Rollup"
		: "Agree"

/** The schema value a query is built over. */
const schemaValue = (spec: QuerySpec): unknown => (schemaOf(spec) === "Rollup" ? Rollup : Agree)

/** The query a spec states, built through the query builder's JavaScript view, as the engine compiles it. */
const built = (spec: QuerySpec): QueryValue => {
	const [first, ...rest] = Arr.map(spec.arms, builtArm)
	const union = Arr.reduce(rest, queryOver(schemaValue(spec)).rule(first), (q, arm) => q.rule(arm))
	const searched =
		spec.nearest === undefined
			? union
			: union.approximateNearest({ by: spec.nearest.by, take: spec.nearest.take })
	return spec.take === undefined
		? searched
		: searched.orderBy([orderedBy(spec), "asc"]).take(spec.take)
}

/**
 * What the engine proves of a query's root: whether get may read it, its cardinality, and its minimal keys, every key
 * its proofs state (ir/keys.ts keyFactors), each over its classes of equal columns: one column of each class, together,
 * are a key. Each class is in name order, and a key's classes by their first names. And the query as the types see it:
 * its records, the decoded record of each heading group, and its parameters, as ./heading.ts writes them.
 */
interface Proved {
	/** Whether get may read the query, and its cardinality, under what every reading of its flags states. */
	readonly get: boolean
	readonly card: Card
	/** Whether the card rests on a proof by cases over one flagged filter's readings, what both state not pinning it. */
	readonly split: boolean
	/**
	 * The cardinality every reading of its flags holds, each compiled alone, all flags read as one value (meetCard): its
	 * card where it states no flagged filter. It is stronger than card only where the flags prove more read together
	 * than any one of them read alone, a proof over several flags at once, which the types do not make.
	 */
	readonly readings: Card
	/** The keys of each reading of the query, one where it states no flagged filter, two where it does. */
	readonly keys: Arr.NonEmptyReadonlyArray<ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>>
	readonly head: string
	readonly params: string
	/** Its page's verdicts, where the query is no take's: the order it pages by, and its request's refusal, if any. */
	readonly page: PageVerdict | undefined
	/**
	 * The facts a variable read from each column of its heading has, by the column's type (./heading.ts columnFacts),
	 * where the query is of one heading group.
	 */
	readonly facts: string | undefined
	/**
	 * Whether the Db of the case's role reads the query, as the runtime compiles it against the role (program/schema.ts
	 * levelSchema): a full role reads queries over its schema and over every level below it, and no other.
	 */
	readonly reads: boolean
}

/** The engine's verdicts on a page of a query: the field it orders by, and the runtime's verdict on its request. */
interface PageVerdict {
	readonly by: string
	readonly request: PageRequestSpec
	readonly refused: Refused | undefined
	/** The refusal of a page of the query itself, unordered, which the engine reads no stated order of. */
	readonly unordered: TypeRefusal | undefined
}

/** What the program states of a query the types must refuse: its diagnostic, and the refusal or prose it names. */
interface Refused {
	readonly code: "TS2322" | "TS2345" | "TS2353" | "TS2379" | "TS2554"
	readonly claim:
		| { readonly kind: "refusal"; readonly refusal: TypeRefusal }
		| { readonly kind: "prose"; readonly reason: string }
}

/** The engine's verdict on a drawn query: what it proves of one it compiles, or the refusal its reason is. */
type Verdict =
	| { readonly kind: "admitted"; readonly proved: Proved }
	| { readonly kind: "refused"; readonly refused: Refused }

/**
 * Every key a key proof states, each over its classes: one minimal key of each of its factors (ir/keys.ts keyFactors),
 * each class its column and the columns its members state equal to it, in name order, the classes by their first
 * names.
 */
const keysInNameOrder = (k: KeyProof): ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>> => {
	const keys = Arr.reduce(keyFactors(k), [[]], (chosen: ReadonlyArray<KeyClasses>, alternatives) =>
		Arr.flatMap(chosen, (key) => Arr.map(alternatives, (a): KeyClasses => [...key, ...a]))
	)
	return Arr.map(keys, (classes) =>
		Arr.sort(
			Arr.map(classes, (c) => Arr.sort(c, Str.Order)),
			Arr.makeOrder(Str.Order)
		)
	)
}

/** A refusal the types name, under its diagnostic. */
const named = (code: Refused["code"], refusal: TypeRefusal): Refused => ({
	code,
	claim: { kind: "refusal", refusal }
})

/**
 * The refusal the types state where the engine refuses a case's planted fault: the engine's reason must be the fault's
 * site's (its tag, and the builder call or field it names), and the refusal is the one the types name for that site.
 * A reason at no site of the case's fault is the generator's defect: undefined.
 */
const refusalOf = (spec: QuerySpec, reason: CompileReason): Refused | undefined => {
	const fault = spec.fault
	const label = "at" in reason && "label" in reason.at ? reason.at.label : ""
	const malformed = reason._tag === "MalformedDescription"
	const unsupported = reason._tag === "UnsupportedOperation"
	switch (fault) {
		case "scopeName":
			return malformed && label === "v"
				? named("TS2345", "a declared name: ASCII letters, digits and underscores, a letter first")
				: undefined
		case "unnamedScope":
			return malformed && label === "v"
				? {
						code: "TS2554",
						claim: { kind: "prose", reason: "v takes the scope's name beside its source" }
					}
				: undefined
		case "stranger":
			return malformed && Str.startsWith("r.match(")(label)
				? Arr.some(spec.arms[0].matches, strangerAlone)
					? prose("TS2353", "a match's one binding names no field of its source")
					: named("TS2322", "not a field of the arms the bindings select")
				: undefined
		case "stray":
			return malformed && label === "r.match(Stray)"
				? named("TS2345", "the relation is not in this query's schema")
				: undefined
		case "unkeyedFold":
			return reason._tag === "FoldOverProjection"
				? named(
						"TS2322",
						"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values"
					)
				: undefined
		case "unionTypes":
			return malformed &&
				(Str.startsWith("union field ")(label) ||
					(label === "query.rule" && "path" in reason.at && reason.at.path[0] === "arms"))
				? named("TS2345", "a union's arms deliver each field at one type")
				: undefined
		case "emptyRelation":
			return malformed && Str.startsWith("r.relation(")(label)
				? named("TS2345", "a relation parameter has at least one field, as a relation does")
				: undefined
		case "strayRows":
			return malformed && Str.startsWith("r.match(parameter ")(label)
				? named("TS2345", "the relation is not in this query's schema")
				: undefined
		case "unboundImport":
			return malformed && "path" in reason.at && reason.at.path[0] === "bindings"
				? named("TS2345", "bind the query's parameters before matching it: Q.bind({ ... })")
				: undefined
		case "allenTerm":
			return malformed && label === "r.allen"
				? named("TS2345", "a span term is required")
				: undefined
		case "cosineDims":
			return malformed && label === "Compute.cosineDistance"
				? prose("TS2345", "cosine distance needs one dimension count")
				: undefined
		case "cosineTerm":
			return malformed && label === "Compute.cosineDistance"
				? prose("TS2345", "cosine distance needs a vector term")
				: undefined
		case "orderHidden":
			return malformed && label === "Query.orderBy"
				? prose("TS2322", "the order names no field of the heading")
				: undefined
		case "spanEndpoints":
			return malformed && Arr.contains(spanLabels, label)
				? prose(
						"TS2345",
						label === "r.pointIn"
							? "a point of the span's endpoint type"
							: "two spans over one endpoint type"
					)
				: undefined
		case "packTerm":
			return malformed && label === "r.pack"
				? prose("TS2345", "r.pack needs a span term")
				: undefined
		case "producerHead":
			return unsupported && label === "rule"
				? named(
						"TS2322",
						Arr.some(spec.arms[0].head, ([, h]) => h.kind === "count")
							? "aggregate and span producer in one head: a producer yields facts per binding, an aggregate folds them"
							: "one span producer per head"
					)
				: undefined
		case "nearestBy":
			return unsupported && label === "Query.approximateNearest"
				? prose("TS2322", "by names a distance output, not a key field")
				: undefined
		case "nearestSource":
			return unsupported && label === "Query.approximateNearest"
				? named(
						"TS2345",
						Arr.some(spec.arms[0].head, ([, h]) => h.kind === "count")
							? "approximateNearest over one rule's projection; this source is an aggregate rule, whose output is a nonlinear fold rather than a distance of one stored vector"
							: "approximateNearest over one rule's projection; this source is a rule whose head produces spans, facts per binding rather than its projection"
					)
				: undefined
		case "clean":
		case "widenedName":
			return undefined
	}
}

/**
 * Whether a match's one binding is a stranger's, a name no field of its source has: the binding shares no property with
 * the source's bindings, all optional, so the types refuse it as an excess property of their own type rather than by
 * the refusal they name beside a field.
 */
const strangerAlone = (m: Match): boolean => {
	if (m.rel === "Tones") {
		return false
	}
	const fields = fieldsOf[m.rel]
	return (
		Arr.length(m.bindings) === 1 &&
		!Arr.some(m.bindings, ([name]) => Arr.some(fields, (f) => f.name === name))
	)
}

/** A structural refusal the types state under its diagnostic, its prose naming what the program breaks. */
const prose = (code: Refused["code"], reason: string): Refused => ({
	code,
	claim: { kind: "prose", reason }
})

/** The builder calls that take two spans, or a point and a span, of one endpoint type. */
const spanLabels: ReadonlyArray<string> = ["r.allen", "r.pointIn", "r.intersection", "r.difference"]

/** The refusal of a scope's name spelled through a `string`, which no engine sees (see the header). */
const widened: Refused = named("TS2345", "one literal name")

/**
 * The records of each arm, as its decoded heading group, the union of them the query's records: one member per arm,
 * since each arm's records are a type of their own, however alike two arms' are.
 */
const headOf = (spec: QuerySpec): string =>
	Arr.join(
		Arr.map(spec.arms, (arm) => {
			const q: QueryValue = queryOver(schemaValue(spec)).rule(builtArm(arm))
			const template = compileTemplate(q, undefined, testCompile)
			if (!template.ok) {
				throw new Error(
					`the engine refuses an arm of a query it compiles: ${messageOf(template.error)}`
				)
			}
			const keys = defined(q.rows.headings[0], "an arm's one heading group")
			return recordType(groupFields(keys, q.heading, template.value.heading))
		}),
		" | "
	)

/** The plain string a request's anchor is, which no cursor codec made. */
const plainToken = "not a cursor"

/** A request's value as the runtime reads it: a size, a cursor's token, null, undefined or a plain string. */
const requestValue = (value: RequestValue): unknown => {
	switch (value) {
		case "size":
			return 2
		case "cursor":
			return "token"
		case "null":
			return null
		case "undefined":
			return undefined
		case "string":
			return plainToken
	}
}

/**
 * The refusal the types state of a page request the runtime refuses: of its shape (adapter/page/request.ts
 * pageRequest), an anchor that is null or no string, which an anchor's property refuses, an explicitly undefined one
 * under exactOptionalPropertyTypes, and any other shape the request's argument refuses; and of a shape it admits, a
 * plain string's anchor the page's cursor codec refuses (`decodes`).
 */
const requestRefusal = (
	request: PageRequestSpec,
	decodes: (token: string) => boolean
): Refused | undefined => {
	const value = Rec.fromEntries(Arr.map(request, ([k, v]) => [k, requestValue(v)] as const))
	if (EffectResult.isSuccess(pageRequest(value))) {
		return Arr.some(request, ([, v]) => v === "string") && !decodes(plainToken)
			? { code: "TS2322", claim: { kind: "prose", reason: "a plain string is no cursor" } }
			: undefined
	}
	const values = Arr.map(request, ([, v]) => v)
	return Arr.contains(values, "null")
		? { code: "TS2322", claim: { kind: "prose", reason: "an explicitly supplied null cursor" } }
		: Arr.contains(values, "undefined")
			? {
					code: "TS2379",
					claim: { kind: "prose", reason: "an explicitly supplied undefined cursor" }
				}
			: { code: "TS2345", claim: { kind: "prose", reason: "a request shape the runtime refuses" } }
}

/**
 * A page of the query ordered by its first head field, as db.page compiles it (adapter/page/template.ts): the page
 * compiler over the template compiled for a page and its stated order, against the schema's names.
 */
const pageOf = (spec: QuerySpec, request: PageRequestSpec): PageVerdict => {
	const by = orderedBy(spec)
	const paged = Result.flatMap(
		catchCompileError(() => built(spec).orderBy([by, "asc"])),
		(ordered) =>
			Result.flatMap(
				compileTemplate(ordered, undefined, { ...testCompile, read: "page" }),
				(template) =>
					Result.flatMap(testArtifacts(schemaValue(spec), testCompile), (artifacts) =>
						Result.flatMap(queryInput(ordered), (input) =>
							Result.flatMap(statedOrderOf(input.desc, SourceLoc("query", [])), (stated) =>
								compilePage({
									checked: template.programs.checked,
									stated,
									optimized: template.programs.optimized,
									names: artifacts.names
								})
							)
						)
					)
			)
	)
	if (!paged.ok) {
		throw new Error(`the engine refuses a page of a drawn query: ${messageOf(paged.error)}`)
	}
	const codec = Result.flatMap(
		Result.flatMap(parseSchemaInput(schemaValue(spec)), (input) =>
			codebookFor(input, testCompile.codes)
		),
		(codes) =>
			cursorCodec(
				{
					query: "the drawn query",
					comparators: paged.value.comparators,
					generation: { schema: "the agreement schema", extensions: {} }
				},
				cursorTokenMaxLength,
				codes
			)
	)
	if (!codec.ok) {
		throw new Error(`the engine makes no cursor codec of a drawn page: ${messageOf(codec.error)}`)
	}
	const unordered = Result.flatMap(
		catchCompileError(() => built(spec)),
		(q) =>
			Result.flatMap(queryInput(q), (input) => statedOrderOf(input.desc, SourceLoc("query", [])))
	)
	return {
		by,
		request,
		refused: requestRefusal(request, (token) => codec.value.decode(token).ok),
		unordered: unordered.ok ? undefined : "page needs an ordered query"
	}
}

/** The cardinality both readings of a flagged rule hold: the one they share, else at most one where each is, else many. */
const meetCard = (cards: Arr.NonEmptyReadonlyArray<Card>): Card =>
	Arr.every(cards, (c) => c === cards[0])
		? cards[0]
		: Arr.every(cards, (c) => c !== "many")
			? "atMostOne"
			: "many"

const verdictOf = (spec: QuerySpec, source: string): Verdict => {
	const failed = (what: string): never => {
		throw new Error(
			`the engine refuses a drawn query at no site of its fault (${spec.fault}), a defect of the generator: ${what}\n${source}`
		)
	}
	const variants = flagVariants(spec)
	const compiled = Arr.map(variants, (variant) =>
		Result.flatMap(
			catchCompileError(() => built(variant)),
			(q) => compileTemplate(q, undefined, testCompile)
		)
	)
	const templates: Array<QueryTemplate> = []
	for (const template of compiled) {
		if (!template.ok) {
			const refused = refusalOf(spec, template.error.reason)
			return refused === undefined
				? failed(messageOf(template.error))
				: { kind: "refused", refused }
		}
		templates.push(template.value)
	}
	const [first, ...rest] = templates
	if (first === undefined) {
		return failed("no reading of the query")
	}
	if (
		spec.fault === "widenedName" &&
		Arr.some(spec.arms, (arm) => Arr.isReadonlyArrayNonEmpty(arm.spellings))
	) {
		return { kind: "refused", refused: widened }
	}
	const all: Arr.NonEmptyReadonlyArray<QueryTemplate> = [first, ...rest]
	const roots = Arr.map(all, (t) => t.analyzed.roots[0])
	const shared = Arr.some(spec.arms, (arm) => arm.flagged !== undefined)
		? Result.flatMap(
				catchCompileError(() => built(sharedReading(spec))),
				(q) => compileTemplate(q, undefined, testCompile)
			)
		: Result.ok(first)
	if (!shared.ok) {
		return failed(`what both readings of its flag state: ${messageOf(shared.error)}`)
	}
	const read = shared.value.analyzed.roots[0]
	const readingOf = (reading: QuerySpec) => {
		const compiled = Result.flatMap(
			catchCompileError(() => built(reading)),
			(q) => compileTemplate(q, undefined, testCompile)
		)
		if (!compiled.ok) {
			return failed(`a reading of one flag: ${messageOf(compiled.error)}`)
		}
		const root = compiled.value.analyzed.roots[0]
		return {
			get: requireGet(root, SourceLoc("agreement", [])).ok,
			pinned: root.meta.card !== "many"
		}
	}
	const split = Arr.flatMap(spec.arms, (arm, i) =>
		arm.flagged?.kind === "either" ? [Arr.map(splitReadings(spec, arm, i), readingOf)] : []
	)
	const splitGet = Arr.some(split, (readings) => Arr.every(readings, (r) => r.get))
	const splitPinned = Arr.some(split, (readings) => Arr.every(readings, (r) => r.pinned))
	const params = Arr.reduce(
		Arr.flatMap(all, (t) => t.params),
		[],
		(kept: ReadonlyArray<ParamDecl>, p): ReadonlyArray<ParamDecl> =>
			Arr.some(kept, (k) => k.name === p.name) ? kept : [...kept, p]
	)
	return {
		kind: "admitted",
		proved: {
			get: requireGet(read, SourceLoc("agreement", [])).ok || splitGet,
			card: read.meta.card === "many" && splitPinned ? "atMostOne" : read.meta.card,
			split: read.meta.card === "many" && splitPinned,
			readings: meetCard(Arr.map(roots, (root) => root.meta.card)),
			keys: Arr.map(roots, (root) => Arr.flatMap(root.meta.logicalKeys, keysInNameOrder)),
			head: headOf(variants[0]),
			facts: Arr.every(spec.arms, (arm) => sameHeadKeys(arm, spec.arms[0]))
				? recordType(Arr.map(first.heading, (c) => [c.name, columnFacts(c.type)] as const))
				: undefined,
			params: paramsType(params),
			page: spec.request === undefined ? undefined : pageOf(variants[0], spec.request),
			reads: readsThrough(spec, failed)
		}
	}
}

/**
 * Whether the Db of a query's role reads it: the query compiled against the role as the runtime compiles a read, which
 * refuses a query over no level of the role's schema before any SQL, and compiles any other as over its own schema.
 */
const readsThrough = (spec: QuerySpec, failed: (what: string) => never): boolean => {
	const role = spec.db === "Reader" ? Reader : Reporter
	const compiled = Result.flatMap(
		catchCompileError(() => built(spec)),
		(q) => compileTemplate(q, role, testCompile)
	)
	if (compiled.ok) {
		return true
	}
	const reason = compiled.error.reason
	const label = "at" in reason && "label" in reason.at ? reason.at.label : ""
	return reason._tag === "MalformedDescription" && label === "compile"
		? false
		: failed(`a read through ${spec.db}: ${messageOf(compiled.error)}`)
}

/**
 * The refusal a read through a Db reading no level of a query's schema names: execute's, and get's once its card
 * admits a get.
 */
const levelRefusal: TypeRefusal = "a program over no level of the database's schema"

/**
 * The engine's verdict on a keyed get: its key position's fields (query/build/key.ts keyLookup), the names its values
 * state, whether they are exactly the key's, and the record the keyed relation's facts decode to, the keyed lookup's
 * heading as ./heading.ts writes it.
 */
interface KeyedVerdict {
	readonly target: KeyTarget
	readonly shape: KeyedGet["shape"]
	readonly record: string
	readonly admitted: boolean
	readonly fact: string
}

/** The value of each key position, as the program and the engine read it. */
const keyValues: { readonly [K in KeyTarget]: unknown } = {
	Item,
	Tag,
	Note,
	Slot,
	Cell,
	ToneWeight,
	Tone,
	byOwner
}

/** A value of a key field's type, written in the program: a uuid, an integer, Tone's first member, a span of ticks. */
const keyValueText = (type: ScalarType): string => {
	switch (type.carrier) {
		case "uuid":
			return jsonText(uuidOf(1))
		case "int4":
			return "1"
		case "code":
			return jsonText(Arr.getUnsafe(type.roster.handles, 0))
		case "range4":
			return "{ start: 0, end: 1 }"
		case "int2":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "date":
		case "text":
		case "bytes":
		case "bits":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			throw new Error(`no key of the agreement schema has a ${type.carrier} field`)
	}
}

/**
 * A keyed get's verdict: its values named as its shape says, each a value of its field's type, and one name beside the
 * key a field of the relation outside it or, where it has none, a name no field has; admitted exactly where the names
 * hold every key field, as the runtime reads them (adapter/reader/params.ts readKeyValues), each key field's value
 * bound to the keyed lookup's parameter, and any other name read by none.
 */
const keyedOf = (k: KeyedGet): KeyedVerdict => {
	const lookup = keyLookup(Agree, keyValues[k.target])
	if (lookup === undefined || !isQueryValue(lookup.query)) {
		throw new Error(`the engine reads no key through ${k.target}`)
	}
	const q = lookup.query
	const template = compileTemplate(q, undefined, testCompile)
	if (!template.ok) {
		throw new Error(
			`the engine refuses the keyed lookup of ${k.target}: ${messageOf(template.error)}`
		)
	}
	const heading = template.value.heading
	const key = lookup.target.fields
	const outside = Arr.filter(
		Arr.map(heading, (c) => c.name),
		(name) => !Arr.contains(key, name)
	)
	const stranger = Arr.isReadonlyArrayNonEmpty(outside) ? outside[0] : "nope"
	const names = ((): ReadonlyArray<string> => {
		switch (k.shape) {
			case "key":
				return key
			case "beside":
				return [...key, stranger]
			case "short":
				return key.slice(1)
			case "instead":
				return [...key.slice(1), stranger]
		}
	})()
	const valueOf = (name: string): string =>
		Option.match(
			Arr.findFirst(heading, (c) => c.name === name),
			{ onNone: () => "0", onSome: (c) => (Arr.contains(key, name) ? keyValueText(c.type) : "0") }
		)
	const keys = defined(q.rows.headings[0], "the keyed lookup's one heading group")
	return {
		target: k.target,
		shape: k.shape,
		record: Arr.isReadonlyArrayNonEmpty(names)
			? `{ ${Arr.join(
					Arr.map(names, (name) => `${name}: ${valueOf(name)}`),
					", "
				)} }`
			: "{}",
		admitted: Arr.every(key, (field) => Arr.contains(names, field)),
		fact: recordType(groupFields(keys, q.heading, heading))
	}
}

/** Whether two arms head the same fields, of one heading group. */
const sameHeadKeys = (a: RuleSpec, b: RuleSpec): boolean => {
	const keys = (arm: RuleSpec) =>
		Arr.sort(
			Arr.map(arm.head, ([k]) => k),
			Str.Order
		)
	return Arr.makeEquivalence(Str.Equivalence)(keys(a), keys(b))
}

/**
 * One drawn query: its source's lines, the engine's verdict, which the program asserts of the types exactly, a
 * self-join's included, and what it reached.
 */
interface AgreementCase {
	readonly spec: QuerySpec
	readonly lines: Arr.NonEmptyReadonlyArray<Line>
	readonly source: string
	readonly verdict: Verdict
	readonly keyed: KeyedVerdict | undefined
	readonly notes: ReadonlySet<AgreementNote | FaultNote>
}

/** A drawn query and the constructs its drawing reached. */
interface Drawn {
	readonly spec: QuerySpec
	readonly reached: ReadonlySet<AgreementFeature>
}

/** One query planting `fault`: the case's swarm over the constructs, then the query under it. */
const drawnGen =
	(fault: Planted): Gen<Drawn> =>
	(source) => {
		const d = new Drawing(source, source.draw(swarm(agreementFeatures)), fault)
		return { spec: drawQuery(d), reached: d.reached }
	}

const caseOf = ({ spec, reached }: Drawn): AgreementCase => {
	const rendering = new Rendering(spec.fault)
	const lines = rendering.query(spec)
	const source = Arr.join(
		Arr.map(lines, (l) => l.text),
		"\n"
	)
	const verdict = verdictOf(spec, source)
	const notes = new Set<AgreementNote | FaultNote>(reached)
	if (spec.fault !== "clean") {
		notes.add(verdict.kind === "refused" ? `${spec.fault} refused` : `${spec.fault} admitted`)
	}
	if (
		spec.fault === "spanEndpoints" &&
		verdict.kind === "refused" &&
		Arr.some(spec.arms, contractAgainstBase)
	) {
		notes.add("a contract's span refused against its base's")
	}
	if (verdict.kind === "admitted") {
		const heading = Arr.length(spec.arms[0].head)
		notes.add(verdict.proved.get ? "get proved" : "get refused")
		if (verdict.proved.split) {
			notes.add("a flag whose readings each prove more than both state")
		}
		if (Arr.some(verdict.proved.keys[0], (k) => k.length < heading)) {
			notes.add("a key below the heading")
		}
		if (Str.includes("Brand.Brand")(verdict.proved.head)) {
			notes.add("a contract in the head")
		}
		const page = verdict.proved.page
		if (page !== undefined) {
			notes.add(page.refused === undefined ? "a page request admitted" : "a page request refused")
			if (page.unordered !== undefined) {
				notes.add("an unordered page refused")
			}
		}
		for (const note of spanNotes(spec)) {
			notes.add(note)
		}
		if (spec.nearest !== undefined && verdict.proved.get) {
			notes.add("a search get proves")
		}
		for (const note of sourceNotes(spec, verdict.proved)) {
			notes.add(note)
		}
	}
	if (Arr.some(spec.arms, fixedTwice)) {
		notes.add("a variable two filters fix")
	}
	const keyed = spec.keyed === undefined ? undefined : keyedOf(spec.keyed)
	for (const note of keyed === undefined ? [] : keyedNotes(keyed)) {
		notes.add(note)
	}
	return { spec, lines, source, verdict, keyed, notes }
}

/**
 * What an admitted query's sources and Db reach: a closed relation and a roster matched, a get proved over a derived
 * relation, an extension's Db reading a query over its base, and a base Db refusing a query over its extension.
 */
const sourceNotes = (spec: QuerySpec, proved: Proved): ReadonlyArray<AgreementNote> => {
	const matched = (rel: MatchSource): boolean =>
		Arr.some(spec.arms, (arm) => Arr.some(arm.matches, (m) => m.rel === rel))
	const rollup = schemaOf(spec) === "Rollup"
	return [
		...(matched("ToneWeight") ? ["a closed relation matched" as const] : []),
		...(matched("Tone") ? ["a roster matched" as const] : []),
		...(rollup && proved.get ? ["a derived relation's get proved" as const] : []),
		...(!rollup && spec.db === "Reporter" && proved.reads
			? ["an extension's Db read a base query" as const]
			: []),
		...(rollup && spec.db === "Reader" && !proved.reads
			? ["a base Db refused an extension query" as const]
			: [])
	]
}

/**
 * What a keyed get reaches: admitted, the kind of key position it reads through, and whether a name beside the key's
 * rode along; refused, what its values' names break, a key field missing, alone or with a name in its place.
 */
const keyedNotes = (k: KeyedVerdict): ReadonlyArray<AgreementNote> => {
	if (k.admitted) {
		const admitted: AgreementNote =
			k.shape === "beside"
				? "a keyed get naming a field beside its key admitted"
				: "a keyed get admitted"
		switch (k.target) {
			case "byOwner":
				return [admitted, "a keyed get through a candidate key"]
			case "ToneWeight":
				return [admitted, "a keyed get of a closed relation"]
			case "Tone":
				return [admitted, "a keyed get of a roster"]
			case "Item":
			case "Tag":
			case "Note":
			case "Slot":
			case "Cell":
				return [admitted]
		}
	}
	switch (k.shape) {
		case "short":
			return ["a keyed get missing a key field refused"]
		case "instead":
			return ["a keyed get naming a field in a key field's place refused"]
		case "key":
		case "beside":
			return []
	}
}

/** Whether a span predicate or producer of an arm relates a span over Cents to a span over its base, bigint. */
const contractAgainstBase = (arm: RuleSpec): boolean => {
	const kinds = (a: Term, b: Term): boolean =>
		a.kind === "var" &&
		b.kind === "var" &&
		new Set([a.v.field.kind, b.v.field.kind]).size === 2 &&
		Arr.every([a.v.field.kind, b.v.field.kind], (k) => k === "centsSpan" || k === "bigSpan")
	return (
		Arr.some(arm.filters, (p) => p.kind === "allen" && kinds(p.left, p.right)) ||
		Arr.some(arm.head, ([, h]) => h.kind === "produce" && kinds(h.left, h.right))
	)
}

/**
 * What an admitted query's span and vector terms take a parameter at: opposite an Allen predicate or a point's test, as
 * a producer's operand, and as a distance's query vector.
 */
const spanNotes = (spec: QuerySpec): ReadonlyArray<AgreementNote> =>
	Arr.flatMap(spec.arms, (arm) => [
		...Arr.flatMap(arm.filters, (p): ReadonlyArray<AgreementNote> => {
			switch (p.kind) {
				case "allen":
					return [
						...(p.right.kind === "param" ? ["a span parameter opposite r.allen" as const] : []),
						...(isDates(p.left) ? ["r.allen over date spans" as const] : []),
						...(isDates(p.right) && p.right.kind === "param"
							? ["a date span parameter" as const]
							: [])
					]
				case "pointIn":
					return [
						...(p.span.kind === "param" ? ["a span parameter opposite r.pointIn" as const] : []),
						...(isDates(p.span) ? ["a date's point test" as const] : []),
						...(isDates(p.span) && p.span.kind === "param"
							? ["a date span parameter" as const]
							: [])
					]
				case "cmp":
				case "and":
				case "or":
				case "not":
					return []
			}
		}),
		...Arr.flatMap(arm.head, ([, h]): ReadonlyArray<AgreementNote> => {
			switch (h.kind) {
				case "produce":
					return [
						...(h.right.kind === "param" ? ["a producer over a span parameter" as const] : []),
						...(isDates(h.left) ? ["a producer over date spans" as const] : []),
						...(isDates(h.right) && h.right.kind === "param"
							? ["a date span parameter" as const]
							: [])
					]
				case "pack":
					return isDates(h.of) ? ["a producer over date spans"] : []
				case "cosine":
					return h.to.kind === "param" ? ["a distance to a vector parameter"] : []
				case "width":
					return [h.span === "dateSpan" ? "a width in days" : "a width over integer endpoints"]
				case "term":
				case "literal":
				case "count":
				case "fold":
					return []
			}
		})
	])

/** Whether a term is a span of dates: a variable of one, or a parameter declared at one. */
const isDates = (t: Term): boolean =>
	(t.kind === "var" && t.v.field.kind === "dateSpan") ||
	(t.kind === "param" && t.at.kind === "dateSpan")

/**
 * The variables a filter fixes: one an equality compares with a value fixed per binding, a parameter or a constant, and
 * each a conjunction's operands fix; a disjunction fixes none.
 */
const fixedBy = (p: Pred): ReadonlyArray<string> => {
	switch (p.kind) {
		case "cmp": {
			const fixedWith = (v: Term, other: Term): ReadonlyArray<string> =>
				v.kind === "var" &&
				(other.kind === "param" ||
					other.kind === "literal" ||
					other.kind === "constant" ||
					other.kind === "handle")
					? [`${scopeOf(v.v)}.${v.v.field.name}`]
					: []
			return p.op === "eq" ? [...fixedWith(p.a, p.b), ...fixedWith(p.b, p.a)] : []
		}
		case "and":
			return [...fixedBy(p.ps[0]), ...fixedBy(p.ps[1])]
		case "or":
		case "not":
		case "allen":
		case "pointIn":
			return []
	}
}

/** Whether two of a rule's filters fix one variable: to two values, which are one wherever the rule has a row. */
const fixedTwice = (arm: RuleSpec): boolean => {
	const fixed = Arr.flatMap(arm.filters, fixedBy)
	return new Set(fixed).size < fixed.length
}

/** A predicate with every conjunction's and disjunction's operands in the other order. */
const swapped = (p: Pred): Pred =>
	p.kind === "and" || p.kind === "or" ? { ...p, ps: [swapped(p.ps[1]), swapped(p.ps[0])] } : p

/** A query with each rule's filters, and every connective's operands, in the other order. */
const reordered = (spec: QuerySpec): QuerySpec => ({
	...spec,
	arms: Arr.map(spec.arms, (arm) => ({
		...arm,
		filters: Arr.reverse(Arr.map(arm.filters, swapped))
	}))
})

/** A verdict as text: whether get reads the query, and its keys as a set; a refusal as its claim. */
const verdictText = (v: Verdict): string => {
	switch (v.kind) {
		case "admitted":
			return `get ${v.proved.get ? "proved" : "refused"}, keys ${jsonText(
				Arr.map(v.proved.keys, (keys) =>
					Arr.sort(
						Arr.map(keys, (k) => jsonText(k)),
						Str.Order
					)
				)
			)}`
		case "refused":
			return `refused, ${v.refused.code} ${v.refused.claim.kind === "refusal" ? v.refused.claim.refusal : v.refused.claim.reason}`
	}
}

/** The queries the run's own stream draws. */
export const agreementCount = 240

/**
 * The faulted queries the run's own stream draws, and the floor's witnesses of them: eight per fault, so the floor's
 * draws of each fault meet it refused and, where its site may hold a valid value, admitted.
 */
export const faultCount = 8 * agreementFaults.length

/** The label both clean populations are drawn under. */
const agreementLabel = "types/evidence agreement"

/** The label both faulted populations are drawn under. */
const faultLabel = "types/evidence agreement faults"

/** One case: a drawn query and what the engine says of it. */
const caseGen: Gen<AgreementCase> = (source) => caseOf(drawnGen("clean")(source))

/** One faulted case: a fault drawn among every fault, then a query planting it. */
const faultGen: Gen<AgreementCase> = (source) =>
	caseOf(drawnGen(source.draw(element(agreementFaults)))(source))

/** What a case reached: its notes, and each required pair of them it notes together (agreementPairs). */
const reachedBy = (c: AgreementCase): ReadonlyArray<Reached<AgreementNote | FaultNote>> => [
	...c.notes,
	...Arr.filter(agreementPairs, ([a, b]) => c.notes.has(a) && c.notes.has(b))
]

/**
 * The floor's witnesses: a quarter of the run's count, drawn under the label alone, the same in every run, and the only
 * cases whose constructs and verdicts meet the required situations (test/types/evidence/agreement.test.ts).
 */
export const agreementWitnesses = () =>
	floorPopulation(agreementLabel, caseGen, agreementCount / 4, reachedBy)

/** The faulted population's witnesses: as many as its run's stream draws, the same in every run. */
export const faultWitnesses = () => floorPopulation(faultLabel, faultGen, faultCount, reachedBy)

/**
 * Every case a population's program holds: the floor's witnesses, then the stream of its label under the run's seed
 * (`TEST_SEED`, or the seed the run drew), so every process of one run draws the same cases and every run new ones.
 */
const agreementCases = (seed: number): ReadonlyArray<AgreementCase> => [
	...agreementWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(agreementLabel)), agreementCount)
]

const faultCases = (seed: number): ReadonlyArray<AgreementCase> => [
	...faultWitnesses().values,
	...sample(faultGen, rotatingSeed(seed, floorSeed(faultLabel)), faultCount)
]

/**
 * The run's cases whose verdict moves when each rule's filters are written in the other order (reordered): none, since
 * the order of a rule's filters is no part of what it means, so a value two filters fix a variable to is one value
 * whichever comes first. Each is its source with its two verdicts.
 */
export const reorderedVerdicts = (seed: number): ReadonlyArray<string> =>
	Arr.flatMap([...agreementCases(seed), ...faultCases(seed)], (c) => {
		const moved = verdictOf(reordered(c.spec), c.source)
		return verdictText(moved) === verdictText(c.verdict)
			? []
			: [`${c.source}\n  as written: ${verdictText(c.verdict)}\n  reordered: ${verdictText(moved)}`]
	})

/** The refusal db.get's type names for a query not proved at most one row per binding (adapter/types/db.ts). */
const getRefusal: TypeRefusal = "get needs a query proved at most one row per parameter binding"

/** The evidence program's prelude (test/support/programs/evidence.ts), every name its modules read. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/evidence.ts"))

/** The engine's keys as a type: each a tuple of its classes, each class the union of its columns' names. */
const keysType = (keys: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>): string =>
	Arr.isReadonlyArrayNonEmpty(keys)
		? Arr.join(
				Arr.map(
					keys,
					(k) =>
						`readonly [${Arr.join(
							Arr.map(k, (members) =>
								Arr.join(
									Arr.map(members, (c) => jsonText(c)),
									" | "
								)
							),
							", "
						)}]`
				),
				" | "
			)
		: "never"

/** The program's prelude as its directory reaches it, `entry` spelling a repository path from there. */
export const agreementEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/**
 * The program over the run's cases, as five modules:
 * - index.ts, every clean case's query in the drawn order, the get the types must accept or refuse (a refusal under its
 *   directive, which the type-test batch disarms), the assertion that every key the types claim lies over one the
 *   engine proves, and its records, parameters, cardinality and reads asserted the engine's;
 * - order.ts, the same in a second order drawn from the run's stream;
 * - invariance.ts, every query's head and keys asserted equal across the two;
 * - admission.ts, the admission agreement over every position and constant kind (./admission.ts), its constants drawn
 *   from the run's stream, and over every combinator on every shape of query;
 * - faults.ts, every faulted case: a refused one under the directive of its refusal, at its fault's site, an admitted
 *   one asserted as a clean one is.
 */
export const agreementModules = (
	entries: PreludeAt,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = agreementCases(seed)
	const indices = Arr.map(cases, (_c, i) => i)
	const order = defined(
		sample(
			shuffled(indices, { min: indices.length, max: indices.length }),
			rotatingSeed(seed, floorSeed(`${agreementLabel} order`)),
			1
		)[0],
		"the second order"
	)
	const picks = defined(
		sample(
			array(int(0, 5), { min: admissionSize, max: admissionSize }),
			rotatingSeed(seed, floorSeed(`${agreementLabel} admission`)),
			1
		)[0],
		"the admission matrix's picks"
	)
	const cells: ReadonlyArray<AdmissionCell> = admissionCells((cell) =>
		defined(picks[cell], "a pick per cell of the matrix")
	)
	const faulted = faultCases(seed)
	return [
		{ file: "index.ts", source: programOf(entries, cases, indices, true) },
		{ file: "order.ts", source: programOf(entries, cases, order, false) },
		{ file: "invariance.ts", source: invarianceOf(entries, cases) },
		{
			file: "admission.ts",
			source: admissionModule(entries, cells, combinatorCells(), scopeCells())
		},
		{ file: "arguments.ts", source: argumentModule(entries, argumentCells()) },
		{
			file: "faults.ts",
			source: programOf(
				entries,
				faulted,
				Arr.map(faulted, (_c, i) => i),
				false
			)
		}
	]
}

/** Every query's head and keys equal in the two orders' modules. */
const invarianceOf = (entries: PreludeAt, cases: ReadonlyArray<AgreementCase>): string =>
	Arr.join(
		[
			"// Generated by test/support/agreement/queries.ts: the evidence is the same whatever the statements' order.",
			...preludeImports(entries, new Set(["EvidenceOfQuery", "HeadOf"])),
			'import type * as A from "./index.ts"',
			'import type * as B from "./order.ts"',
			"type Equals<X, Y> = (<Z>() => Z extends X ? 1 : 2) extends <Z>() => Z extends Y ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
			...Arr.map(
				cases,
				(_c, i) =>
					`export type o${i} = [Expect<Equals<HeadOf<typeof A.q${i}>, HeadOf<typeof B.q${i}>>>, Expect<Equals<EvidenceOfQuery<typeof A.q${i}>["keys"], EvidenceOfQuery<typeof B.q${i}>["keys"]>>]`
			),
			""
		],
		"\n"
	)

/** The statements of one case: its query, under its fault's directive where the engine refuses it, and its verdicts. */
const blockOf = (c: AgreementCase, i: number, paged: boolean): ReadonlyArray<string> => {
	const [first, ...rest] = c.lines
	const lines = [{ text: `export const q${i} = ${first.text}`, fault: first.fault }, ...rest]
	switch (c.verdict.kind) {
		case "refused": {
			const { code, claim } = c.verdict.refused
			const directive =
				claim.kind === "refusal"
					? `// @ts-expect-error -- ${code} refusal: ${claim.refusal}`
					: `// @ts-expect-error -- ${code}: ${claim.reason}`
			const at = Arr.findFirstIndex(lines, (l) => l.fault)
			if (Option.isNone(at)) {
				throw new Error(`a refused case marks no line of its fault (${c.spec.fault})\n${c.source}`)
			}
			return [
				`/** The engine refuses the case's ${c.spec.fault}. */`,
				...Arr.flatMap(lines, (l, j) => (j === at.value ? [directive, l.text] : [l.text])),
				...keyedLines(c.keyed, i),
				""
			]
		}
		case "admitted": {
			const { get, card, readings, keys, head, facts, params, page, reads } = c.verdict.proved
			const keyed = Arr.map(keys, keysType)
			const db = `(db: DbOf<typeof ${c.spec.db}, unknown>) => (args: GetArg<typeof q${i}>) =>`
			return [
				`/** The engine ${get ? "proves" : "refuses"} get; its card: ${card}${readings === card ? "" : `, and ${readings} under each reading of its flag alone`}; its keys: ${Arr.join(keyed, "; under the other flag, ")}; ${c.spec.db}'s Db ${reads ? "reads" : "refuses"} it. */`,
				...Arr.map(lines, (l) => l.text),
				`export const g${i} = ${db}`,
				...(get && reads
					? []
					: [`\t// @ts-expect-error -- TS2345 refusal: ${get ? levelRefusal : getRefusal}`]),
				`\tdb.get(q${i}, args)`,
				`export const e${i} = ${db}`,
				...(reads ? [] : [`\t// @ts-expect-error -- TS2345 refusal: ${levelRefusal}`]),
				`\tdb.execute(q${i}, args)`,
				...Arr.map(
					keyed,
					(k, j) => `export type k${i}_${j} = Expect<Equals<Unproved<typeof q${i}, ${k}>, never>>`
				),
				`export type h${i} = Expect<Equals<HeadOf<typeof q${i}>, ${head}>>`,
				...(facts === undefined
					? []
					: [`export type f${i} = Expect<Equals<Flat<HeadingFacts<typeof q${i}>>, ${facts}>>`]),
				params === "unknown"
					? `export type p${i} = Expect<Equals<keyof ParamsOf<typeof q${i}>, never>>`
					: `export type p${i} = Expect<Equals<Flat<ParamsOf<typeof q${i}>>, ${params}>>`,
				`export type c${i} = Expect<Equals<EvidenceOfQuery<typeof q${i}>["card"], ${jsonText(card)}>>`,
				...(reads
					? [
							`export type x${i} = Expect<Equals<ReturnType<ReturnType<typeof e${i}>>, Effect.Effect<QueryResult<${head}>, ReadError>>>`,
							...(get
								? [
										`export type y${i} = Expect<Equals<ReturnType<ReturnType<typeof g${i}>>, Effect.Effect<Option.Option<${head}>, ReadError>>>`
									]
								: []),
							...(paged && page !== undefined ? pageLines(i, head, page, c.spec.db) : [])
						]
					: []),
				...keyedLines(c.keyed, i),
				""
			]
		}
	}
}

/**
 * A case's keyed get, through Reader's Db: its values as a record, under the directive of what the types refuse where
 * they miss a field of the engine's key, and otherwise its row asserted the keyed relation's decoded fact.
 */
const keyedLines = (k: KeyedVerdict | undefined, i: number): ReadonlyArray<string> => {
	if (k === undefined) {
		return []
	}
	return [
		`export const kg${i} = (db: DbOf<typeof Reader, unknown>) =>`,
		...(k.admitted ? [] : ["\t// @ts-expect-error -- TS2345: a keyed get names every key field"]),
		`\tdb.get(${k.target}, ${k.record})`,
		...(k.admitted
			? [
					`export type kr${i} = Expect<Equals<ReturnType<typeof kg${i}>, Effect.Effect<Option.Option<${k.fact}>, ReadError>>>`
				]
			: [])
	]
}

/** A page request in the program: its control properties, each a size, the module's cursor, null or undefined. */
const requestText = (request: PageRequestSpec): string =>
	Arr.isReadonlyArrayNonEmpty(request)
		? `{ ${Arr.join(
				Arr.map(request, ([k, v]) => `${k}: ${requestValueText(v)}`),
				", "
			)} }`
		: "{}"

/** A request's value in the program: a size, the module's cursor, null, undefined, or the module's plain string. */
const requestValueText = (value: RequestValue): string => {
	switch (value) {
		case "size":
			return "2"
		case "cursor":
			return "cursor"
		case "null":
			return "null"
		case "undefined":
			return "undefined"
		case "string":
			return "plainToken"
	}
}

/**
 * A case's pages: its query ordered by the page's field, a page of it whose type is the page of that very query with
 * the error channel ReadError | CursorError, and a page under the drawn request, under its refusal's directive where
 * the runtime refuses it; each read through db.page and through a handle db.compile compiled of the ordered query.
 */
const pageLines = (
	i: number,
	head: string,
	page: PageVerdict,
	role: QuerySpec["db"]
): ReadonlyArray<string> => {
	const directive =
		page.refused === undefined
			? []
			: [
					page.refused.claim.kind === "refusal"
						? `		// @ts-expect-error -- ${page.refused.code} refusal: ${page.refused.claim.refusal}`
						: `		// @ts-expect-error -- ${page.refused.code}: ${page.refused.claim.reason}`
				]
	const paged = `Effect.Effect<Page<${head}, typeof o${i}>, ReadError | CursorError>`
	return [
		`export const o${i} = q${i}.orderBy([${jsonText(page.by)}, "asc"])`,
		`export const w${i} = (db: DbOf<typeof ${role}, unknown>) => (args: GetArg<typeof q${i}>) => db.page(o${i}, args, { first: 2 })`,
		`export type s${i} = Expect<Equals<ReturnType<ReturnType<typeof w${i}>>, ${paged}>>`,
		`export const u${i} = (db: DbOf<typeof ${role}, unknown>) => (args: GetArg<typeof q${i}>) =>`,
		`	db.page(`,
		`		o${i},`,
		`		args,`,
		...directive,
		`		${requestText(page.request)}`,
		`	)`,
		`export const ch${i} = (db: DbOf<typeof ${role}, unknown>) => db.compile(o${i})`,
		`export const cp${i} = (handle: Effect.Success<ReturnType<typeof ch${i}>>) => (args: GetArg<typeof q${i}>) =>`,
		`	handle.page(`,
		`		args,`,
		...directive,
		`		${requestText(page.request)}`,
		`	)`,
		`export const cf${i} = (handle: Effect.Success<ReturnType<typeof ch${i}>>) => (args: GetArg<typeof q${i}>) => handle.page(args, { first: 2 })`,
		`export type ct${i} = Expect<Equals<ReturnType<ReturnType<typeof cf${i}>>, ${paged}>>`,
		...(page.unordered === undefined
			? []
			: [
					`export const v${i} = (db: DbOf<typeof ${role}, unknown>) => (args: GetArg<typeof q${i}>) =>`,
					`	// @ts-expect-error -- TS2345 refusal: ${page.unordered}`,
					`	db.page(q${i}, args, { first: 2 })`
				])
	]
}

/** The helpers an assertion of a case's verdicts reads. */
const assertions: ReadonlyArray<string> = [
	"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"type Expect<T extends true> = T",
	"/** A map's entries as one record, however the types join the maps its arms and terms state. */",
	"type Flat<T> = { readonly [K in keyof T]: T[K] }",
	"/** The keys the types claim of a query: none when its evidence is unknown. */",
	'type TypeKeys<Q> = EvidenceOfQuery<Q>["keys"] extends infer K',
	"\t? unknown extends K",
	"\t\t? never",
	"\t\t: K extends ReadonlyArray<infer E>",
	"\t\t\t? E",
	"\t\t\t: never",
	"\t: never",
	"/** Whether a key over the fields F lies over one of the engine's keys E: F holds a column of each of its classes. */",
	"type Over<F, E> = E extends ReadonlyArray<unknown>",
	"\t? false extends { [I in keyof E]: [Extract<E[I], F>] extends [never] ? false : true }[number]",
	"\t\t? false",
	"\t\t: true",
	"\t: false",
	"/** The keys the types claim of Q that lie over none the engine proves. */",
	"type Unproved<Q, E> = UnprovedOf<TypeKeys<Q>, E>",
	"type UnprovedOf<K, E> = K extends ReadonlyArray<infer F> ? (true extends Over<F, E> ? never : K) : never",
	"/** The facts a variable read from each column of a query's heading has. */",
	'type HeadingFacts<Q extends Headed<Carriers>> = { readonly [K in keyof VarsOf<Q, "read">]: FactsOf<VarsOf<Q, "read">[K]> }'
]

/**
 * A module of the cases in `order`: their blocks, after the declarations they read, and the imports the module names;
 * a module states only what its blocks read, since an unused one is a diagnostic of its own.
 */
const programOf = (
	entries: PreludeAt,
	cases: ReadonlyArray<AgreementCase>,
	order: ReadonlyArray<number>,
	paged: boolean
): string => {
	const blocks = Arr.flatMap(order, (i) =>
		blockOf(defined(cases[i], "a case of the drawn order"), i, paged)
	)
	const read = identifiers(Arr.join(blocks, "\n"))
	const body = Arr.join(
		[
			...(read.has("anyName")
				? [
						"/** A scope's name spelled through a string, which the types refuse. */",
						"declare const anyName: string"
					]
				: []),
			...(read.has("cursor")
				? [
						"/** A cursor of another query, which a page request takes as any query's. */",
						"declare const cursor: PageCursor<unknown>"
					]
				: []),
			...(read.has("plainToken")
				? [
						"/** A plain string no cursor codec made, which no page request takes. */",
						"declare const plainToken: string"
					]
				: []),
			...(read.has("flag")
				? [
						"/** A boolean the program does not know, which a flagged filter turns on. */",
						"declare const flag: boolean"
					]
				: []),
			...(read.has("Unproved") ? assertions : []),
			"",
			...blocks
		],
		"\n"
	)
	return preludeProgram(
		"// Generated by test/support/agreement/queries.ts: the type/engine agreement program.",
		entries,
		body
	)
}
