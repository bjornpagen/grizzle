import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { aimed, element, type Gen, int } from "@bjornpagen/testing/gen"
import { floorSeed } from "@bjornpagen/testing/random"
import { sample, type Source } from "@bjornpagen/testing/source"
import { keep, type Swarm, swarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { DerivedRefusal, RoleRule } from "#compiler/core/causes.ts"
import type { Column } from "#compiler/core/decoder.ts"
import type {
	CompileError,
	CompileReason,
	CompileReasonTag,
	Duplicate,
	PreconditionKind,
	ValueFault
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	descText,
	expandSeries,
	type MonoidName,
	type RoleDesc,
	type FieldDecl,
	type FieldDesc,
	type SideDesc,
	type StatementDesc,
	type TermDesc,
	declaredNaming,
	writtenNames
} from "#compiler/ir/desc.ts"
import type { Heading as Columns } from "#compiler/ir/rel.ts"
import {
	integerTypmodOf,
	type NumericTypmod,
	type RosterOrder,
	sameScalarType,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { type SchemaArtifacts } from "#compiler/program/schema.ts"
import { bit, closedId, Numeric, Money, Vector } from "#compiler/public/fields.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { dateDescriptor } from "#compiler/scalar/date.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import { minted, mintedRefusal, unnamedIdRefusal } from "#compiler/scalar/minted.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import {
	bool,
	cidr,
	float4,
	float8,
	inet,
	int2,
	int4,
	int8,
	money,
	numeric
} from "#compiler/scalar/pg.ts"
import {
	carrierSql,
	describeField,
	describeFieldOrThrow,
	scalarTypeOf
} from "#compiler/scalar/registry.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { admitEncodable } from "#compiler/scalar/values/vector.ts"
import { vector } from "#compiler/scalar/vector.ts"
import {
	accumulatedField,
	admitClosedRelation,
	admitRoster,
	bitsOf,
	closedBuilder as closed,
	derivedBuilder,
	drawnField,
	closedRelation,
	generatedField,
	generatedRelation,
	relationBuilder as relation,
	relationDescOf,
	slotField,
	writingOf
} from "#compiler/schema/relation.ts"
import { admitSchema, schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	keyBuilder,
	mirrorsBuilder,
	monoids,
	mutableBuilder,
	onBuilder,
	orderedBuilder,
	type ExpansionDesc,
	expansionDescOf,
	predBuilder,
	selectBuilder,
	statementDescOf,
	treeBuilder,
	unitBuilder
} from "#compiler/schema/statements.ts"
import { rowHelpers } from "#compiler/schema/terms.ts"
import { insertableNamesOf, roleBuilder as role, roleDescOf } from "#compiler/schema/world.ts"
import { regexField, str } from "#compiler/text/field.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation, AnyRoster } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { changeSetDesc, changeSetOver } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import {
	compileTemplate,
	inputArtifacts,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { admitContract, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import { Id, idKey, idName } from "#test/support/ids.ts"
import { messageOf } from "#test/support/message.ts"
import { type Leading, leadingHeadings } from "#test/support/open.ts"
import { checking } from "#test/support/policy.ts"
import {
	batchOwned,
	caseOwned,
	type Program,
	type Entry as ProgramEntry
} from "#test/support/types/batch/batch.ts"
import { upTo } from "#test/support/up-to.ts"

/** PostgreSQL's plain descriptors, by their pg_type names. */
const plainDescriptors = {
	int2,
	int4,
	int8,
	numeric,
	float4,
	float8,
	money,
	bool,
	inet,
	cidr,
	vector,
	smallserial: minted,
	serial: minted,
	bigserial: minted,
	uuidv7: minted
} as const
/**
 * The schema agreement: schemas drawn as data, each with the engine's verdict on it and on probe statements beside it,
 * and the one TypeScript program that states every verdict as types, which the type tier checks
 * (test/types/schema/agreement.test.ts). The engine is the oracle:
 * - a program typechecks exactly when the engine builds and compiles it: every probe the engine refuses stands under a
 *   directive naming the diagnostic its fault raises, `Refusal<"…">` where the types name the refusal, and the batch
 *   checks the program disarmed, so a probe the types refuse and the engine admits is a diagnostic no directive names,
 *   and one they admit and the engine refuses a directive whose diagnostic never comes;
 * - every fact type, addition, nested addition, key, key lookup, write list, projection head, statement,
 *   descriptor, literal, closed read and text language the types infer equals what the engine describes: the host type
 *   of each field's scalar type, the fields its writing leaves to the caller, the families its statements nest, the
 *   candidate keys its laws state, each statement's Description, each descriptor's Description and writing;
 * - the relations a ChangeSet over the schema, and over its extension, inserts at its top level, InsertableNameOf and
 *   insertableNamesOf in record order, are those whose insert the engine compiles (topLevelInserts), and insertAll
 *   takes InsertAllRowsOf of the schema exactly as the engine compiles an insert of every one of them at once.
 *
 * A case is drawn as data (SchemaCase) and read twice: rendered as TypeScript, and built through the builders'
 * JavaScript cores (schema/relation.ts, schema/statements.ts, schema/world.ts, the descriptor cores of
 * test/support/fixtures/descriptors.ts) and compiled as the runtime compiles it (testArtifacts). Its base is valid by
 * construction: rosters, contracts, relations of drawn fields and keys, key, containment and mutable statements, a
 * family with its folds, a closed relation with a relation whose fields PostgreSQL generates from
 * it, a derived extension and roles; the engine refusing it is a defect of the generator, which fails the run. Its
 * probes each state one declaration or host value over the base, valid or with one planted fault (SchemaFault): the
 * oracle's refusal of a probe (Verdict), the engine's CompileError, its admission of a host value or the identities it
 * would build a contract's name into, must be the reason its fault predicts (refusals, Expected), or the run fails.
 *
 * The classes of declarations the types accept and the engine refuses are declared (declaredClasses), and drawn as
 * any other probe with no directive, each refusal asserted by its reason: unkeyedTarget, a containment or a mirror into
 * a side that holds no key of its relation, which compilation refuses (UnsupportedLawFamily) because the law needs a
 * key over the side's projection; and castFits, a cast whose operand's bounds do not prove it fits its target, which
 * compilation refuses (PartialOperation, its fits test). Neither key nor bound is tracked by the types.
 *
 * The cases are drawn by one generator (schemaCases), and the kept faults no drawn probe plants are a box of their own
 * (schemaKeptBox), each alone on one base.
 */
/** The constructs a case may hold, each a swarm feature: a part of its base, or a probe beside it. */
const schemaConstructs = [
	"secondRoster",
	"contract",
	"nestedContract",
	"regexField",
	"numericField",
	"dateField",
	"moneyField",
	"vectorField",
	"spanField",
	"closedIdField",
	"bitsField",
	"keyStatement",
	"containment",
	"mutableStatement",
	"ordered",
	"counted",
	"tree",
	"derived",
	"closedRelation",
	"generated",
	"slots",
	"writer",
	"keyProbe",
	"sideProbe",
	"rosterProbe",
	"handleProbe",
	"containmentProbe",
	"mutableProbe",
	"schemaProbe",
	"roleProbe",
	"derivedProbe",
	"predicateProbe",
	"literalProbe",
	"familyProbe",
	"fieldProbe",
	"closedRelationProbe",
	"closedReadProbe",
	"castProbe",
	"ruleProbe",
	"mintedProbe",
	"unnamedIdProbe",
	"generatedProbe",
	"slotKeyProbe",
	"slotSideProbe",
	"slotContainmentProbe",
	"fixedTargetProbe",
	"valueProbe",
	"contractNameProbe"
] as const
type SchemaConstruct = (typeof schemaConstructs)[number]

/**
 * The forms of a construct whose inferences no other form asserts, each noted where it is drawn: the slots pack's
 * mirror and selected key, each side a slot side probe writes, each law a slot containment probe states, each aggregate
 * a derived head reads, each place a law names a derived relation, each derived definition the engine admits, fin
 * over a key field and over an accumulated one, a closed relation keyed by one, two or three closed ids, its rows with
 * one stated twice, a role over a base declaring one, a concat fold valid and over a number, a fold whose accumulators
 * are another refinement of its step's carrier, generated fields whose terms are another refinement of theirs, and a
 * numeric field at scale 0, whose host is a bigint where every other scale's is a Numeric.
 */
const schemaForms = [
	"slotsMirrors",
	"slotsSelectedKey",
	"predSide",
	"selectedPredSide",
	"fieldAndPredSide",
	"predTwice",
	"slotContained",
	"slotMirrors",
	"slotArity",
	"slotMirrorsArity",
	"slotSwapped",
	"slotLabel",
	"derivedSum",
	"derivedMean",
	"derivedMin",
	"derivedMax",
	"derivedLiteral",
	"derivedLeft",
	"derivedRight",
	"derivedMirrors",
	"derivedOverLevels",
	"derivedBoundImport",
	"derivedDiscriminated",
	"derivedProjection",
	"derivedSkipsLevel",
	"derivedRuled",
	"derivedNegated",
	"derivedKeyed",
	"derivedChecked",
	"derivedSelectedKey",
	"finOfKey",
	"finOfAccumulated",
	"treeParentWritten",
	"treeIndexWritten",
	"closedKeyOne",
	"closedKeyTwo",
	"closedKeyThree",
	"closedRepeatedRow",
	"paramTwice",
	"bindOuterVariable",
	"negationParam",
	"concatFold",
	"concatMismatch",
	"unorderedMax",
	"refinedFold",
	"refinedGenerated",
	"roleBesideClosed",
	"fixedByValue",
	"fixedByTerm",
	"numericAtScaleZero"
] as const
type SchemaForm = (typeof schemaForms)[number]

/** A fault a probe may plant: one mutation of a valid declaration, which the engine refuses. */
const schemaFaults = [
	"emptyKey",
	"undeclaredKeyField",
	"repeatedKeyField",
	"repeatedSideTerm",
	"emptySide",
	"undeclaredSideTerm",
	"repeatedHandle",
	"foreignHandle",
	"sidesDiffer",
	"mutableClosed",
	"clashingRelation",
	"clashingLevel",
	"reboundStatement",
	"undeclaredStatementRelation",
	"finMember",
	"entryOutsideBase",
	"writeRoster",
	"writeStranger",
	"parameterizedDefinition",
	"derivedAtOwnLevel",
	"derivedInRoot",
	"mutableDerived",
	"parameterizedCheck",
	"parameterizedSelect",
	"parameterizedContract",
	"literalKind",
	"finNotDrawn",
	"countedPair",
	"monoidMismatch",
	"endPlanes",
	"treeSideWritten",
	"drawnUndrawable",
	"accumulatedWriting",
	"accumulatedStart",
	"rowMissingField",
	"mintedId",
	"unnamedId",
	"endpointType",
	"widthType",
	"numericArity",
	"argumentKind",
	"vectorMakeBuffer",
	"vectorFromBuffer",
	"vectorDimensionArgument",
	"vectorAssign",
	"vectorFromOther",
	"uuidSpelling",
	"bitsStranger",
	"bitsRepeated",
	"contractName",
	"atShort",
	"atMissing",
	"atSwapped",
	"atKey",
	"atWrongHandle",
	"rowShort",
	"rowWhole",
	"hasShort",
	"hasField",
	"hasWrongHandle",
	"hasSwapped",
	"echoRoster",
	"predNotNatural",
	"predUndeclared",
	"predClosed",
	"predOfPred",
	"selectedUndeclared",
	"keyOverClosed",
	"lookAlikeDescriptor",
	"inSetKind",
	"partialBind",
	"strayBinding",
	"strayNegation",
	"bindingType",
	"negatedBindingType",
	"foreignAttach",
	"setPrimaryKey",
	"setKey",
	"conflictingRow",
	"generatedReadsGenerated",
	"generatedWrongType",
	"generatedContract",
	"generatedTwiceNamed",
	"finOverClosedNotNatural",
	"slotOverOrdinary",
	"slotNotClosed",
	"familyOverClosed",
	"closedKeyNotClosed",
	"closedFifthArgument",
	"crossSet",
	"countedSide",
	"concatCounted",
	"concatHidden",
	"contractEnd",
	"finOverDerived",
	"emptyHead",
	"headingGroups",
	"derivedOverBase",
	"mutableOutsideUnit"
] as const
type SchemaFault = (typeof schemaFaults)[number]

/**
 * The declared classes: declarations the types accept and the engine refuses, each for the one reason it states,
 * decided at compilation from what the types do not track. A containment, or a mirror, into a side that holds no key of
 * its relation (unkeyedTarget): the law family needs a key over the side's projection. A cast its operand's bounds do
 * not prove fits its target (castFits): the engine proves the value fits from the bounds its making gives it, which
 * no type carries. A key, a side, a check or a selection over the base's aggregate both admit where its groups lie
 * within its relation's units: a rule reads an aggregate's groups whether it is unit-local or not, judged whole where
 * it is (analysis/theory/unit.ts) and probed at the groups a write touches where it is not (analysis/theory/query.ts
 * GroupedMatch), so the derived probes state them as forms (derivedKeyed, derivedChecked, derivedSelectedKey,
 * derivedLeft, derivedRight, derivedMirrors). Where its groups span its relation's units (`aggregatesAcrossUnits`), each
 * is refused when the schema compiles (aggregateAcrossUnits): a probe at a touched group would fold again every row of
 * a group spanning the units (analysis/theory/query.ts refuseAggregatesAcrossUnits, lane NOSETTINGS's 37b7e030f2 and
 * 51aa55e1f8), a unit no type tracks.
 */
const declaredClasses = ["unkeyedTarget", "castFits", "aggregateAcrossUnits"] as const
type DeclaredClass = (typeof declaredClasses)[number]

/**
 * The kept faults, each a probe of a kept case every run states (keptFaultCase) and never drawn: a side over a
 * selection, by counted, ordered and tree.
 */
const keptFaults = ["selectedCounted", "selectedOrdered", "selectedTree"] as const
export type KeptFault = (typeof keptFaults)[number]

/** What a probe plants: a fault the types refuse, a kept one, or a declared class they accept. */
type Planted = SchemaFault | KeptFault | DeclaredClass

const isDeclared = (planted: Planted): planted is DeclaredClass =>
	Arr.contains<Planted>(declaredClasses, planted)

/** Each declared class's refusal by the engine. */
const declared: { readonly [C in DeclaredClass]: Expected } = {
	unkeyedTarget: { tag: "UnsupportedLawFamily" },
	castFits: { tag: "PartialOperation", precondition: "fits" },
	aggregateAcrossUnits: { tag: "UnsupportedLawFamily" }
}

/**
 * What a case reached: its constructs, the faults the engine refused, the declared classes it refused, and the
 * refusals the types named.
 */
type SchemaNote = SchemaConstruct | SchemaForm | SchemaFault | KeptFault | DeclaredClass | Refused

/**
 * A fault's refusal on both sides, as the probe's line states it. Named: the types name a
 * Refusal, and the engine states the same message as its reason (Refused), so the two are one vocabulary's and compared
 * by equality. Structural: the types raise no Refusal, `why` says what refuses, and the engine refuses for `engine`, as
 * reasonKey reads it.
 */
type Refusing =
	| { readonly kind: "named"; readonly refusal: Refused }
	| { readonly kind: "structural"; readonly engine: Expected; readonly why: string }
	| { readonly kind: "typed"; readonly refusal: Refused; readonly engine: Expected }

/** A fault the types refuse by the Refusal `refusal`, which the engine states as its reason. */
const named = (refusal: Refused): Refusing => ({ kind: "named", refusal })

/**
 * A fault the types refuse by the Refusal `refusal` where the engine, which reads no type, cannot state it: the oracle
 * reads what the engine builds of it, `engine`.
 */
const typed = (refusal: Refused, engine: Expected): Refusing => ({ kind: "typed", refusal, engine })

/** A fault the types refuse with no Refusal, for `why`, and the engine for `engine`. */
const structural = (engine: Expected, why: string): Refusing => ({
	kind: "structural",
	engine,
	why
})

/** A family's member side over a selection, as both sides refuse it. */
const wholeMember: Refused =
	"a family's member side is a relation, never a selection: its members are every fact of the relation"

/** Each fault's refusal: the engine's reason, and what the types claim of it. */
const refusals: { readonly [F in SchemaFault | KeptFault]: Refusing } = {
	emptyKey: structural({ tag: "MalformedDescription" }, "a primary key names at least one field"),
	undeclaredKeyField: structural(
		{ tag: "MalformedDescription" },
		"the primary key names declared fields"
	),
	repeatedKeyField: named("a key lists each field once"),
	repeatedSideTerm: named("a side lists each term once"),
	emptySide: structural({ tag: "MalformedDescription" }, "a side names at least one term"),
	undeclaredSideTerm: structural(
		{ tag: "MalformedDescription" },
		"a side's terms are fields of its source"
	),
	repeatedHandle: named("a roster lists each handle once"),
	foreignHandle: structural({ tag: "MalformedDescription" }, "a handle is a member of its roster"),
	sidesDiffer: named("the sides' field types differ"),
	mutableClosed: structural(
		{ tag: "MalformedDescription" },
		"mutable takes ordinary relations; a closed relation is immutable by nature"
	),
	clashingRelation: typed("two relations of one name across a schema's levels", {
		tag: "DuplicateIdentity",
		duplicate: "relation"
	}),
	clashingLevel: typed("two relations of one name across a schema's levels", {
		tag: "DuplicateIdentity",
		duplicate: "relation"
	}),
	reboundStatement: typed("a statement names a relation no level of the schema declares", {
		tag: "DuplicateIdentity",
		duplicate: "relation"
	}),
	undeclaredStatementRelation: named(
		"a statement names a relation no level of the schema declares"
	),
	finMember: structural(
		{ tag: "MalformedDescription" },
		"a schema's members are relations, and fin(O, n) is none"
	),
	entryOutsideBase: named("a whole entry is a relation of the base under its own name"),
	writeRoster: structural(
		{ tag: "RoleRefused", rule: "writeKind" },
		"a write list names ordinary relations and query entries only"
	),
	writeStranger: structural(
		{ tag: "RoleRefused", rule: "writeOutside" },
		"a write list names relations of the role"
	),
	parameterizedDefinition: structural(
		{ tag: "MalformedDescription" },
		"a derived definition is parameterless"
	),
	derivedAtOwnLevel: structural(
		{ refused: "a derived definition is a query over a level of the schema it extends" },
		"a derived relation is declared above the level its definition reads"
	),
	derivedInRoot: structural(
		{ tag: "MalformedDescription" },
		"a root schema declares no derived relation; schema.extend does"
	),
	mutableDerived: structural(
		{ tag: "MalformedDescription" },
		"mutable takes ordinary relations only"
	),
	mutableOutsideUnit: named(
		"mutable over a relation under a unit, whose every change is a write its unit's borrow holds alone: declare the unit its primary key leads with, unit(name, { …its leading key fields }), or keep it closed and record each change as an inserted fact"
	),
	parameterizedCheck: named("a schema predicate reads no parameter"),
	parameterizedSelect: named("a schema predicate reads no parameter"),
	parameterizedContract: named("a schema predicate reads no parameter"),
	literalKind: structural(
		{ tag: "MalformedDescription" },
		"a literal is a host value of its field's kind"
	),
	finNotDrawn: structural(
		{ tag: "MalformedDescription" },
		"fin's count is a drawn natural of its owner"
	),
	countedPair: named(
		"a fold over a counted family hides its accumulators: name the step's value alone"
	),
	monoidMismatch: named(
		"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text"
	),
	endPlanes: named("a fold's end names one accumulated field of the owner per plane"),
	treeSideWritten: named(
		"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end"
	),
	drawnUndrawable: named(
		"drawn(type): natural or a domain over an integer, the types a family's index and count are of"
	),
	accumulatedWriting: named(
		"an accumulated field is of a value type: no range, vector or field of a writing of its own"
	),
	accumulatedStart: structural(
		{ tag: "MalformedDescription" },
		"an accumulated field's start is a value of its type"
	),
	rowMissingField: structural(
		{ tag: "MalformedDescription" },
		"a closed relation's row holds every field"
	),
	mintedId: named(mintedRefusal),
	unnamedId: named(unnamedIdRefusal),
	endpointType: structural(
		{ tag: "UnsupportedOperation" },
		"a span's endpoint is an integer or a bigint, or a contract over one"
	),
	widthType: structural(
		{ tag: "MalformedDescription" },
		"a span's width is a value of its endpoint's host type"
	),
	numericArity: structural(
		{ tag: "MalformedDescription" },
		"a numeric declares its precision and its scale"
	),
	argumentKind: structural(
		{ tag: "MalformedDescription" },
		"a precision, a scale and a dimension count are numbers"
	),
	vectorMakeBuffer: structural(
		{ tag: "MalformedDescription" },
		"Vector.make takes a Float32Array, never an array of numbers"
	),
	vectorFromBuffer: structural(
		{ value: "vectorType" },
		"Vector.from takes a Float32Array or a Vector of its dimensions"
	),
	vectorDimensionArgument: structural(
		{ tag: "MalformedDescription" },
		"the dimension count is a number"
	),
	vectorAssign: structural(
		{ value: "vectorDimensions" },
		"a vector of other dimensions is another type"
	),
	vectorFromOther: structural(
		{ value: "vectorDimensions" },
		"Vector.from refuses a vector of other dimensions, which no conversion reaches"
	),
	uuidSpelling: structural(
		{ value: "uuidSyntax" },
		"a text of other than five hyphenated groups is no uuid"
	),
	bitsStranger: structural({ tag: "MalformedDescription" }, "a set lists handles of its roster"),
	bitsRepeated: named("a set lists each of its handles once"),
	predNotNatural: structural({ tag: "MalformedDescription" }, "pred reads a natural field"),
	predUndeclared: structural(
		{ tag: "MalformedDescription" },
		"pred reads a field of the side's relation"
	),
	predClosed: structural(
		{ tag: "MalformedDescription" },
		"a closed relation has no natural field for pred to read"
	),
	predOfPred: structural(
		{ tag: "MalformedDescription" },
		"pred is one level deep: its argument is a field name, never a pred term"
	),
	selectedUndeclared: structural(
		{ tag: "MalformedDescription" },
		"a selected side's terms are its relation's fields"
	),
	keyOverClosed: structural(
		{ tag: "MalformedDescription" },
		"key takes a side of an ordinary relation; a closed relation is keyed by its declaration"
	),
	inSetKind: structural({ tag: "MalformedDescription" }, "inSet lists literals of its term's type"),
	partialBind: structural(
		{ tag: "MalformedDescription" },
		"bind binds every parameter of the query it imports"
	),
	strayBinding: named("a bind map names only the imported query's parameters"),
	strayNegation: named("not a field of the arms the bindings select"),
	bindingType: structural(
		{ tag: "MalformedDescription" },
		"a variable binds a field of its own type, a contract's never its bare base's"
	),
	negatedBindingType: structural(
		{ tag: "MalformedDescription" },
		"a negation binds a variable at a field of its base carrier, an integer's never a bigint's"
	),
	foreignAttach: structural(
		{ tag: "ForeignLevel" },
		"an arm attaches a child over a level of its rule's schema"
	),
	setPrimaryKey: structural({ tag: "UnrepresentableKey" }, "a primary key lists no set"),
	setKey: named("a key lists no set: a set's bit string is too wide for an index entry"),
	conflictingRow: named(
		"two facts of one relation share a key with different values; a key names one fact"
	),
	generatedReadsGenerated: structural(
		{ tag: "MalformedDescription" },
		"the row holds the written fields only, so no generated field reads another"
	),
	generatedWrongType: structural(
		{ tag: "GeneratedRefused" },
		"a generated field's term is of its declared type but for the pattern and byte bound its column's domain checks, at its own position"
	),
	generatedContract: structural(
		{ tag: "GeneratedRefused" },
		"a contract is a type of its own, so a bigint term fills no Tally field"
	),
	generatedTwiceNamed: named("a generated field is named apart from the relation's written fields"),
	finOverClosedNotNatural: structural(
		{ tag: "MalformedDescription" },
		"fin over a closed relation names a natural field, and label is a closed id"
	),
	slotOverOrdinary: structural(
		{ tag: "MalformedDescription" },
		"a slot reads a closed relation's fin, and Owner is an ordinary relation"
	),
	slotNotClosed: structural(
		{ tag: "MalformedDescription" },
		"a slot is a closed id, and int4 lacks a closed id's roster"
	),
	familyOverClosed: named(
		"a family counts by an ordinary relation's drawn count: a closed relation's count numbers the slots of its key"
	),
	closedKeyNotClosed: structural(
		{ tag: "MalformedDescription" },
		"a closed relation's key fields are closed ids"
	),
	closedFifthArgument: structural(
		{ tag: "MalformedDescription" },
		"a closed relation takes four arguments, a fifth typed never"
	),
	crossSet: structural(
		{ tag: "MalformedDescription" },
		"a set over one roster is never a set over another"
	),
	lookAlikeDescriptor: structural(
		{ tag: "MalformedDescription" },
		"a look-alike lacks the brand of a builder's descriptor"
	),
	concatCounted: named(
		"a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree"
	),
	concatHidden: named(
		"a concat fold names its (before, after) pair after its value: its law reads each member's running value"
	),
	contractEnd: named(
		"a fold's accumulators and ends are of its plane's type: another integer width, numeric typmod or domain is another type"
	),
	countedSide: named("a family's slots are fin(owner, count), the owner's count"),
	finOverDerived: structural(
		{ tag: "MalformedDescription" },
		"fin reads a relation's drawn count or a closed relation's natural field, never a derived relation's"
	),
	derivedOverBase: named("the relation is not in this query's schema"),
	emptyHead: named("a derived definition has at least one field"),
	headingGroups: named(
		"a derived definition has one heading: a stored table holds one heading group"
	),
	atShort: structural({ tag: "MalformedDescription" }, "C.at takes one key value per key field"),
	atMissing: structural(
		{ tag: "MalformedDescription" },
		"C.at reads a payload field the closed relation declares"
	),
	atSwapped: structural(
		{ tag: "MalformedDescription" },
		"a key value is a handle of its own key field's roster, in key order"
	),
	rowShort: structural({ tag: "MalformedDescription" }, "C.row takes every key field but the last"),
	atKey: structural(
		{ tag: "MalformedDescription" },
		"C.at reads a payload field, never a key field"
	),
	atWrongHandle: structural(
		{ tag: "MalformedDescription" },
		"a key value is a handle of its field's roster"
	),
	rowWhole: structural(
		{ tag: "MalformedDescription" },
		"C.row takes every key field but the last, never the whole key"
	),
	hasShort: structural({ tag: "MalformedDescription" }, "C.has takes one key value per key field"),
	hasField: structural(
		{ tag: "MalformedDescription" },
		"C.has takes the key alone, never a payload field before it"
	),
	hasWrongHandle: structural(
		{ tag: "MalformedDescription" },
		"a key value of C.has is a handle of its field's roster"
	),
	hasSwapped: structural(
		{ tag: "MalformedDescription" },
		"a key value of C.has is of its own key field's roster, in key order"
	),
	echoRoster: structural(
		{ tag: "MalformedDescription" },
		"a key term is of its key field's roster, whatever its handles' spellings"
	),
	contractName: typed("a domain's name is one literal, the brand of its values", {
		identity: "several"
	}),
	selectedCounted: named(wholeMember),
	selectedOrdered: named(wholeMember),
	selectedTree: named(
		"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end"
	)
}

/**
 * The reason a fault's refusal is, as the oracle states it, structured data and never its prose: the engine's
 * CompileError by its tag and, for a role's refusal, the rule it names; a host value's refusal by its ValueFault; or a
 * domain name the engine would build contracts of several identities from.
 */
type Expected =
	| {
			readonly tag: Exclude<
				CompileReasonTag,
				"Refused" | "RoleRefused" | "PartialOperation" | "DerivedRefused" | "DuplicateIdentity"
			>
	  }
	| { readonly tag: "RoleRefused"; readonly rule: RoleRule["kind"] }
	| { readonly tag: "DuplicateIdentity"; readonly duplicate: Duplicate["kind"] }
	| { readonly tag: "DerivedRefused"; readonly cause: DerivedRefusal["kind"] }
	| { readonly tag: "PartialOperation"; readonly precondition: PreconditionKind }
	| { readonly value: ValueFault }
	| { readonly identity: "several" }
	| { readonly refused: Refused }

/** An expected reason as the key a verdict reads its refusal as. */
const expectedKey = (reason: Expected): string =>
	"identity" in reason
		? `identity:${reason.identity}`
		: "refused" in reason
			? `Refused:${reason.refused}`
			: "value" in reason
				? `value:${reason.value}`
				: reason.tag === "RoleRefused"
					? `${reason.tag}:${reason.rule}`
					: reason.tag === "DuplicateIdentity"
						? `${reason.tag}:${reason.duplicate}`
						: reason.tag === "PartialOperation"
							? `${reason.tag}:${reason.precondition}`
							: reason.tag === "DerivedRefused"
								? `${reason.tag}:${reason.cause}`
								: reason.tag

/** A fault's refusal as the key a verdict reads the engine's reason as. */
const refusingKey = (refusing: Refusing): string =>
	refusing.kind === "named" ? `Refused:${refusing.refusal}` : expectedKey(refusing.engine)

/** The Refusal a fault's directive names: a named or a typed fault's, none for a structural one. */
const namedOf = (refusing: Refusing): ReadonlyArray<Refused> =>
	refusing.kind === "structural" ? [] : [refusing.refusal]

/**
 * A refusal's reason as the agreement compares it: its tag, and for a refusal of a world or a derivation the rule it
 * names, or for a named refusal its message of the one vocabulary (core/refusals.ts), structured data the engine states
 * and never its prose.
 */
const reasonKey = (reason: CompileReason): string => {
	switch (reason._tag) {
		case "RoleRefused":
		case "LoginRefused":
		case "ContextRefused":
		case "ScopeRefused":
			return `${reason._tag}:${reason.rule.kind}`
		case "DerivedRefused":
		case "RecursionRefused":
			return `${reason._tag}:${reason.cause.kind}`
		case "OutsideRole":
			return `${reason._tag}:${reason.access.kind}`
		case "DuplicateIdentity":
			return `${reason._tag}:${reason.duplicate.kind}`
		case "PartialOperation":
			return `${reason._tag}:${reason.precondition}`
		case "Refused":
			return `${reason._tag}:${reason.refusal}`
		case "Misdeclared":
			return `${reason._tag}:${reason.misdeclared.kind}`
		case "MalformedDescription":
		case "MalformedArtifact":
		case "ArtifactFormat":
		case "UnsupportedOperation":
		case "UndeclaredDrop":
		case "UnsupportedLawFamily":
		case "UnrepresentableKey":
		case "FoldOverProjection":
		case "UnstatedKey":
		case "QueriedOwnerAppend":
		case "CascadedCopyAppend":
		case "StaleDerivedRead":
		case "UnorderableStratum":
		case "ReadBackCrossesStatements":
		case "NoReadCommittedForm":
		case "UninstalledDomain":
		case "UninstalledFunction":
		case "UninstalledIndex":
		case "MissingDiscriminant":
		case "AttachedParentUnbound":
		case "AttachedPage":
		case "DescribedHeadingMismatch":
		case "ContractLiteral":
		case "IdentifierCollision":
		case "IdentifierTooLong":
		case "DecodedColumnTooLong":
		case "DigestCollision":
		case "ResourceBound":
		case "GeneratedRefused":
		case "UnfillableField":
		case "UnwritableRelation":
		case "InstantRefused":
		case "PlaceRefused":
		case "ForeignLevel":
		case "LevelRefused":
		case "FragmentRefused":
			return reason._tag
	}
}
/** A pg descriptor a field may be spelled by, each type's one name. */
const pgSpellings = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"bool"
] as const
type PgSpelling = (typeof pgSpellings)[number]

/** The serial family's spellings, each a refusal of a descriptor: grizzle mints no ids (scalar/minted.ts). */
const mintedSpellings = ["smallserial", "serial", "bigserial", "uuidv7"] as const

/** The integer spellings a span's endpoint may be. */
const endpointSpellings = ["int4", "int8"] as const
type EndpointSpelling = (typeof endpointSpellings)[number]

/**
 * The typmods a numeric field is drawn under: a precision and a scale, among them the widest and a scale past the
 * precision, which PostgreSQL admits.
 */
const numericTypmods: Arr.NonEmptyReadonlyArray<readonly [number, number]> = [
	[7, 2],
	[18, 6],
	[10, 0],
	[1000, -1000],
	[1, 1000]
]

/** A text pattern and how its flags are written: stated, or left to their default, "u". */
interface Pattern {
	readonly source: string
	readonly flags: "u" | "su" | "default"
}

/**
 * The literal escapes typed authoring accepts, each a pattern of its own: the control escapes, a control letter of
 * either case, hexadecimal and Unicode escapes, an escaped solidus, and classes holding a backspace, an escaped
 * hyphen and hexadecimal members.
 */
const escapes: Arr.NonEmptyReadonlyArray<string> = [
	"\\t",
	"\\n",
	"\\v",
	"\\f",
	"\\r",
	"\\cA\\cz",
	"\\x41\\x2E\\x2a",
	"\\u{1F600}",
	"\\uD83D\\uDE00",
	"a\\/b",
	"[\\b]",
	"[\\-a]",
	"[\\x5D\\x2d\\x5c]",
	"[\\u0041-\\u{5A}]+"
]

/** Patterns a text field is drawn from: every text, a finite language, digits and a prefix, and each escape. */
const patterns: Arr.NonEmptyReadonlyArray<Pattern> = [
	{ source: "^.*$", flags: "su" },
	{ source: "^(yes|no)$", flags: "default" },
	{ source: "^[a-z]{1,8}$", flags: "u" },
	{ source: "^\\d{2}-\\d{3}$", flags: "default" },
	{ source: "^p:", flags: "su" },
	...Arr.map(escapes, (source): Pattern => ({ source: `^${source}$`, flags: "default" }))
]

/** A span's endpoint: an integer or a bigint spelling, or a contract over one. */
type Endpoint =
	| { readonly kind: "pg"; readonly spelling: EndpointSpelling }
	| { readonly kind: "contract"; readonly name: string }

/** A field's type as a case draws it, every spelling of it. */
type FieldType =
	| { readonly kind: "pg"; readonly spelling: PgSpelling }
	| { readonly kind: "uuid" }
	| { readonly kind: "date" }
	| { readonly kind: "natural" }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "vector"; readonly dims: number }
	| { readonly kind: "text"; readonly pattern: Pattern }
	| { readonly kind: "contract"; readonly name: string }
	| { readonly kind: "closedId"; readonly roster: string }
	| { readonly kind: "bits"; readonly roster: string }
	| { readonly kind: "span"; readonly endpoint: Endpoint; readonly width: Width | undefined }

/** A span's fixed width, a value of its endpoint's host type: a number over an integer, a bigint over a bigint. */
type Width =
	| { readonly host: "number"; readonly value: number }
	| { readonly host: "bigint"; readonly value: bigint }

/** An accumulated field's start, a value of its type at its axis's base: a branded contract's by its constructor. */
type Start =
	| { readonly kind: "integer"; readonly value: number }
	| { readonly kind: "bigint"; readonly value: bigint }
	| { readonly kind: "branded"; readonly contract: string; readonly value: bigint }
	| { readonly kind: "handle"; readonly roster: string; readonly handle: string }
	| { readonly kind: "noHandles"; readonly roster: string }
	| { readonly kind: "text"; readonly value: string }

/** How a field is written: by its caller, drawn by grizzle, or accumulated from its start. */
type WritingSpec =
	| { readonly kind: "caller" }
	| { readonly kind: "drawn" }
	| { readonly kind: "accumulated"; readonly start: Start }

interface FieldSpec {
	readonly name: string
	readonly type: FieldType
	readonly writing: WritingSpec
}

interface RosterSpec {
	readonly name: string
	readonly order: RosterOrder
	readonly handles: Arr.NonEmptyReadonlyArray<string>
}

/** A contract over a base type, a contract among them. */
interface ContractSpec {
	readonly name: string
	readonly base: FieldType
}

interface RelationSpec {
	readonly name: string
	readonly fields: Arr.NonEmptyReadonlyArray<FieldSpec>
	readonly key: Arr.NonEmptyReadonlyArray<string>
}

/** A side over a relation of the base, by its name, and its terms. */
interface SideSpec {
	readonly relation: string
	readonly terms: Arr.NonEmptyReadonlyArray<string>
}

/** A fold of a family into its owner, by its monoid, its step side and its end side. */
interface FoldSpec {
	readonly monoid: "count" | "sum" | "or" | "twos" | "max"
	readonly step: SideSpec
	readonly end: SideSpec
}

/** A family over the base's relations: an ordered or counted one with its folds, or a tree. */
type FamilySpec =
	| {
			readonly kind: "ordered" | "counted"
			readonly owner: string
			readonly count: string
			readonly member: SideSpec
			readonly folds: ReadonlyArray<FoldSpec>
	  }
	| {
			readonly kind: "tree"
			readonly relation: string
			readonly count: string
			readonly member: SideSpec
			readonly root: Arr.NonEmptyReadonlyArray<string>
	  }

/** A law side's term: a field, or pred of a natural field. */
type TermSpec =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "pred"; readonly field: string }

/** The facts of a relation a selected side reads: those whose field equals a value, a text or a handle. */
interface SelectionSpec {
	readonly field: string
	readonly value: string
}

/** A law's side: a relation, or a selection of its facts, and its terms in order. */
interface LawSide {
	readonly relation: string
	readonly selection: SelectionSpec | undefined
	readonly terms: Arr.NonEmptyReadonlyArray<TermSpec>
}

const fieldTerm = (field: string): TermSpec => ({ kind: "field", field })
const predTerm = (field: string): TermSpec => ({ kind: "pred", field })

/** A side over every fact of a relation, of field terms. */
const fieldsSide = (relation: string, fields: Arr.NonEmptyReadonlyArray<string>): LawSide => ({
	relation,
	selection: undefined,
	terms: Arr.map(fields, fieldTerm)
})

type StatementSpec =
	| { readonly kind: "key"; readonly side: LawSide }
	| { readonly kind: "contained" | "mirrors"; readonly left: LawSide; readonly right: LawSide }
	| { readonly kind: "mutable"; readonly relation: string }
	| { readonly kind: "unit"; readonly heading: Leading<FieldType> }

/**
 * A derived relation over the base, in an extension of its schema: its definition groups a relation's facts by one of
 * its fields and counts them, beside further head fields.
 */
interface DerivedSpec {
	readonly name: string
	readonly over: string
	readonly by: string
	readonly extras: ReadonlyArray<DerivedExtra>
}

/** A further head field of a derived definition: an aggregate of a numeric field of its relation, or a typed literal. */
type DerivedExtra =
	| {
			readonly name: string
			readonly kind: "sum" | "mean" | "min" | "max"
			readonly field: string
	  }
	| { readonly name: string; readonly kind: "literal" }

/** The form each extra of a derived head is noted as. */
const extraForm: { readonly [K in DerivedExtra["kind"]]: SchemaForm } = {
	sum: "derivedSum",
	mean: "derivedMean",
	min: "derivedMin",
	max: "derivedMax",
	literal: "derivedLiteral"
}

/** Where a law names the derived relation: its containment's left side, its right side, or a mirror. */
const derivedSides = ["left", "right", "mirrors"] as const
type DerivedSide = (typeof derivedSides)[number]

/** The form each place a law names the derived relation is noted as. */
const sideForm: { readonly [K in DerivedSide]: SchemaForm } = {
	left: "derivedLeft",
	right: "derivedRight",
	mirrors: "derivedMirrors"
}

/** The fields a derived definition's extras read, beside its group field. */
const extraFields = (spec: DerivedSpec): ReadonlyArray<string> =>
	Arr.flatMap(spec.extras, (x) => (x.kind === "literal" ? [] : [x.field]))

/** A role over the extension when there is one, else the base: its insert list, of closed relations, and its write
 * list, of open ones. */
interface RoleSpec {
	readonly name: string
	readonly insert: ReadonlyArray<string>
	readonly write: ReadonlyArray<string>
}

/** The names of `relations` as a role's lists name them: each closed one under insert, each open one under write. */
const listsOf = (
	relations: ReadonlyArray<{ readonly name: string }>,
	statements: ReadonlyArray<StatementSpec>
): { readonly insert: ReadonlyArray<string>; readonly write: ReadonlyArray<string> } => {
	const open = new Set(
		Arr.flatMap(statements, (st) => (st.kind === "mutable" ? [st.relation] : []))
	)
	return {
		insert: Arr.flatMap(relations, (r) => (open.has(r.name) ? [] : [r.name])),
		write: Arr.flatMap(relations, (r) => (open.has(r.name) ? [r.name] : []))
	}
}

/** A case's base: valid by construction, the engine builds and compiles it. */
interface Base {
	readonly rosters: Arr.NonEmptyReadonlyArray<RosterSpec>
	readonly contracts: ReadonlyArray<ContractSpec>
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly statements: ReadonlyArray<StatementSpec>
	readonly family: FamilySpec | undefined
	readonly derived: DerivedSpec | undefined
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSpec>
	readonly closedRelation: ClosedSpec | undefined
	readonly slots: SlotsSpec | undefined
	/** Public values asked whether they are field descriptors, and pairs of pg spellings asked whether one is the other. */
	readonly publics: ReadonlyArray<PublicValue>
	readonly spellings: ReadonlyArray<readonly [PgSpelling, PgSpelling]>
}

/** A field type's text, which tells two types apart as a unit's heading and a key field are compared. */
const fieldTypeText = (t: FieldType): string => fieldSource(t, (name) => name)

/** The headings `relations` lead with: the unit over each one's primary key's first field (test/support/open.ts). */
const headingsOver = (relations: ReadonlyArray<RelationSpec>): ReadonlyArray<Leading<FieldType>> =>
	leadingHeadings(
		Arr.map(relations, (r) => ({
			name: r.name,
			fields: Rec.fromEntries(Arr.map(r.fields, (f) => [f.name, f.type] as const)),
			primaryKey: r.key
		})),
		fieldTypeText
	)

/** The units `relations` sit in once open, each over a primary key's first field, as statements. */
const unitsOver = (relations: ReadonlyArray<RelationSpec>): ReadonlyArray<StatementSpec> =>
	Arr.map(headingsOver(relations), (heading): StatementSpec => ({ kind: "unit", heading }))

/**
 * The slots pack: Parent, whose natural children counts its slots, and Child, each at a slot of its parent, related by
 * the last-slot law over sides with a pred term and a selection, as a containment or a mirror, and a key over a
 * selected side. `roster` is Parent's kind's.
 */
interface SlotsSpec {
	readonly roster: string
	readonly law: "contained" | "mirrors"
	readonly selectedKey: boolean
}

const slotLabel: Pattern = { source: "^(open|last|shut)$", flags: "default" }

/** Parent and Child, the slots pack's relations, their naturals written by their caller. */
const slotRelations = (slots: SlotsSpec): readonly [RelationSpec, RelationSpec] => [
	{
		name: "Parent",
		fields: [
			{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "children", type: { kind: "natural" }, writing: callerWriting },
			{ name: "label", type: { kind: "text", pattern: slotLabel }, writing: callerWriting },
			{ name: "size", type: { kind: "pg", spelling: "int8" }, writing: callerWriting },
			{ name: "kind", type: { kind: "closedId", roster: slots.roster }, writing: callerWriting }
		],
		key: ["id"]
	},
	{
		name: "Child",
		fields: [
			{ name: "parent", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "at", type: { kind: "natural" }, writing: callerWriting },
			{ name: "label", type: { kind: "text", pattern: slotLabel }, writing: callerWriting }
		],
		key: ["parent", "at"]
	}
]

/** Parent's last slot: its id and pred of its children. */
const lastSlot: LawSide = {
	relation: "Parent",
	selection: undefined,
	terms: [fieldTerm("id"), predTerm("children")]
}

/** The children marked last, by their parent and slot. */
const lastChildren: LawSide = {
	relation: "Child",
	selection: { field: "label", value: "last" },
	terms: [fieldTerm("parent"), fieldTerm("at")]
}

/** The slots pack's statements: the last-slot law, and a key over Parent's open facts' size when drawn. */
const slotStatements = (slots: SlotsSpec): ReadonlyArray<StatementSpec> => [
	slots.law === "contained"
		? { kind: "contained", left: lastChildren, right: lastSlot }
		: { kind: "mirrors", left: lastSlot, right: lastChildren },
	...(slots.selectedKey
		? [
				{
					kind: "key",
					side: {
						relation: "Parent",
						selection: { field: "label", value: "open" },
						terms: [fieldTerm("size")]
					}
				} as const
			]
		: [])
]

/** A public value of the fields and text barrels: a descriptor, or a constructor that makes one. */
const publicValues = ["numeric", "vector", "int4", "str", "uuid", "natural", "date"] as const
type PublicValue = (typeof publicValues)[number]

const spellingsOf: Arr.NonEmptyReadonlyArray<PgSpelling> = pgSpellings

/** A public value as the program spells it, and as the engine holds it. */
const publicSource = (v: PublicValue): string => {
	switch (v) {
		case "numeric":
		case "vector":
		case "int4":
			return `Fi.${v}`
		case "str":
			return "Tx.str"
		case "uuid":
		case "natural":
		case "date":
			return `Fi.${v}`
	}
}

const publicValue = (v: PublicValue): unknown => {
	switch (v) {
		case "numeric":
		case "vector":
		case "int4":
			return plainDescriptors[v]
		case "str":
			return str
		case "uuid":
			return uuidDescriptor
		case "natural":
			return naturalDescriptor
		case "date":
			return dateDescriptor
	}
}

/**
 * A closed relation of the base, Rule: its key of one to three closed ids, k1 through kn, over one roster of the base
 * or both, its payload, an integer w and a drawn x, and a row for every key. When drawn beside it, Gen is a relation
 * whose generated fields PostgreSQL writes from its written ones: Rule's w at the row's own closed ids, and its depth
 * plus one as a bigint, which the engine proves fits.
 */
interface ClosedSpec {
	readonly key: Arr.NonEmptyReadonlyArray<RosterSpec>
	readonly payload: Payload
	readonly generated: boolean
}

/** The form a closed relation of each key arity is noted as. */
const closedArityForm: { readonly [A in 1 | 2 | 3]: SchemaForm } = {
	1: "closedKeyOne",
	2: "closedKeyTwo",
	3: "closedKeyThree"
}

/** The drawn payload field's type. */
type Payload = "int2" | "int8" | "text"

const payloadType = (p: Payload): FieldType =>
	p === "text"
		? { kind: "text", pattern: { source: "^.*$", flags: "su" } }
		: { kind: "pg", spelling: p }

/** A payload value of each row: its source and its host value. */
const payloadValue = (p: Payload): readonly [string, unknown] => {
	switch (p) {
		case "int2":
			return ["1", 1]
		case "int8":
			return ["1n", 1n]
		case "text":
			return ['"a"', "a"]
	}
}

/** A closed relation's key fields, k1 through kn, one per closed id of its key. */
const closedKeyNames = (c: ClosedSpec): Arr.NonEmptyReadonlyArray<string> =>
	Arr.map(c.key, (_roster, i) => `k${i + 1}`)

/** Every key of a closed relation: each tuple of its key rosters' handles, in key order. */
const closedKeys = (c: ClosedSpec): ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> =>
	Arr.reduce(
		Arr.tailNonEmpty(c.key),
		Arr.map(Arr.headNonEmpty(c.key).handles, (h): Arr.NonEmptyReadonlyArray<string> => [h]),
		(keys: ReadonlyArray<Arr.NonEmptyReadonlyArray<string>>, roster) =>
			Arr.flatMap(keys, (k) => Arr.map(roster.handles, (h) => Arr.append(k, h)))
	)
/** One case's drawing: its swarm over the constructs, the source its decisions come from, and what it reached. */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<SchemaConstruct>
	readonly reached = new Set<SchemaConstruct | SchemaForm>()

	constructor(source: Source, drawn: Swarm<SchemaConstruct>) {
		this.#source = source
		this.#swarm = drawn
	}

	/** Whether `construct` appears at this place, as the swarm keeps it; noted when it does. */
	keep(construct: SchemaConstruct): boolean {
		const kept = this.#source.draw(keep(this.#swarm, construct))
		if (kept) {
			this.reached.add(construct)
		}
		return kept
	}

	note(construct: SchemaConstruct | SchemaForm): void {
		this.reached.add(construct)
	}

	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}

	upTo(n: number): number {
		return this.#source.draw(int(0, n))
	}

	/** A nonempty subset of `options`, in their order. */
	some<A>(options: Arr.NonEmptyReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> {
		const [first, ...rest] = options
		const kept = Arr.filter(rest, () => this.upTo(1) === 1)
		return this.upTo(1) === 1 || !Arr.isReadonlyArrayNonEmpty(kept) ? [first, ...kept] : kept
	}
}

/**
 * The rosters a case declares, from two that share a handle's spelling: a roster's identity is its name. Kind is
 * ordered and Tier unordered, so a fold's max over Tier, which has no order, is refused where Kind's is admitted.
 */
const rosterPool: Arr.NonEmptyReadonlyArray<RosterSpec> = [
	{ name: "Kind", order: "ordered", handles: ["A", "M"] },
	{ name: "Tier", order: "unordered", handles: ["A", "P", "X"] }
]

/**
 * The ordered rosters of `rosters`, which a fold's max reads: Kind, the first of the pool, which every base declares,
 * is one.
 */
const orderedRosters = (
	rosters: Arr.NonEmptyReadonlyArray<RosterSpec>
): Arr.NonEmptyReadonlyArray<RosterSpec> => {
	const ordered = Arr.filter(rosters, (r) => r.order === "ordered")
	return Arr.isReadonlyArrayNonEmpty(ordered) ? ordered : [rosterPool[0]]
}

/** The contracts a case may declare, over the types a contract admits, one over another. */
const contractNames = ["Cents", "Rate", "Code", "Day", "Mode", "Outer"] as const

/** A type a contract may be over: a value domain, never a set, vector or span. */
const contractBaseOf = (
	d: Drawing,
	roster: RosterSpec,
	contracts: ReadonlyArray<ContractSpec>
): FieldType => {
	const nested = Arr.isReadonlyArrayNonEmpty(contracts) && d.upTo(1) === 1
	if (nested) {
		d.note("nestedContract")
	}
	return nested
		? { kind: "contract", name: d.from(Arr.map(contracts, (c) => c.name)) }
		: d.from<FieldType>([
				{ kind: "pg", spelling: d.from(["int8", "int4"] as const) },
				{ kind: "numeric", precision: 7, scale: 2 },
				{ kind: "text", pattern: d.from(patterns) },
				{ kind: "uuid" },
				{ kind: "date" },
				{ kind: "closedId", roster: roster.name }
			])
}

/** The contracts a case declares: up to three, each over a value domain or an earlier contract. */
const contractsOf = (
	d: Drawing,
	rosters: Arr.NonEmptyReadonlyArray<RosterSpec>
): ReadonlyArray<ContractSpec> => {
	if (!d.keep("contract")) {
		return []
	}
	const count = 1 + d.upTo(2)
	return Arr.reduce(
		upTo(count, (i) => i),
		[],
		(made: ReadonlyArray<ContractSpec>, i) => [
			...made,
			{
				name: defined(contractNames[i], "a domain name"),
				base: contractBaseOf(d, d.from(rosters), made)
			}
		]
	)
}

/** Whether a contract's chain ends at an integer or a bigint: a span's endpoint. */
const integerContract = (contracts: ReadonlyArray<ContractSpec>, name: string): boolean => {
	const found = Arr.findFirst(contracts, (c) => c.name === name)
	if (Option.isNone(found)) {
		return false
	}
	const base = found.value.base
	return base.kind === "contract"
		? integerContract(contracts, base.name)
		: base.kind === "pg" && Arr.contains(endpointSpellings, base.spelling)
}

/** A field type a relation's caller writes, drawn under the case's swarm. */
const fieldTypeOf = (
	d: Drawing,
	rosters: Arr.NonEmptyReadonlyArray<RosterSpec>,
	contracts: ReadonlyArray<ContractSpec>
): FieldType => {
	const roster = d.from(rosters).name
	const integers = Arr.filter(contracts, (c) => integerContract(contracts, c.name))
	const forms: ReadonlyArray<readonly [SchemaConstruct | "plain", () => FieldType]> = [
		["plain", () => ({ kind: "pg", spelling: d.from(pgSpellings) })],
		["plain", () => ({ kind: "uuid" })],
		["regexField", () => ({ kind: "text", pattern: d.from(patterns) })],
		[
			"numericField",
			() => {
				const [precision, scale] = d.from(numericTypmods)
				if (scale === 0) {
					d.note("numericAtScaleZero")
				}
				return {
					kind: "numeric",
					precision,
					scale
				}
			}
		],
		["dateField", () => ({ kind: "date" })],
		["moneyField", () => ({ kind: "pg", spelling: "money" })],
		["vectorField", () => ({ kind: "vector", dims: d.from([1, 3, 1536, 16000]) })],
		["closedIdField", () => ({ kind: "closedId", roster })],
		["bitsField", () => ({ kind: "bits", roster })],
		[
			"spanField",
			() => {
				const endpoint: Endpoint =
					Arr.isReadonlyArrayNonEmpty(integers) && d.upTo(1) === 1
						? { kind: "contract", name: d.from(integers).name }
						: { kind: "pg", spelling: d.from(endpointSpellings) }
				const spelling =
					endpoint.kind === "pg" ? endpoint.spelling : integerEnd(contracts, endpoint.name)
				const width: Width =
					spelling === "int8" ? { host: "bigint", value: 7n } : { host: "number", value: 7 }
				return { kind: "span", endpoint, width: d.upTo(1) === 1 ? width : undefined }
			}
		],
		...(Arr.isReadonlyArrayNonEmpty(contracts)
			? [
					[
						"contract",
						(): FieldType => ({ kind: "contract", name: d.from(contracts).name })
					] as const
				]
			: [])
	]
	const kept = Arr.filter(forms, ([construct]) => construct === "plain" || d.keep(construct))
	const [, draw] = d.from(
		Arr.isReadonlyArrayNonEmpty(kept) ? kept : [defined(forms[0], "a plain form")]
	)
	return draw()
}

/**
 * Whether a key may hold a field of this type: a value an index entry bounds, never a set, a vector, a span, a float, a
 * numeric of no typmod or a text no pattern bounds, whose widest values no B-tree entry holds.
 */
const keyable = (t: FieldType, contracts: ReadonlyArray<ContractSpec>): boolean => {
	switch (t.kind) {
		case "pg":
			return !Arr.contains(["numeric", "float4", "float8", "money"] as const, t.spelling)
		case "uuid":
		case "date":
		case "natural":
		case "numeric":
		case "closedId":
			return true
		case "text":
			return textBounded(t.pattern)
		case "contract": {
			const found = Arr.findFirst(contracts, (c) => c.name === t.name)
			return Option.isSome(found) && keyable(found.value.base, contracts)
		}
		case "vector":
		case "bits":
		case "span":
			return false
	}
}

/**
 * Whether the engine proves a pattern's language bounded in bytes, so a key's index entry holds its text: the text
 * analysis's bounds on every member (ir/scalar.ts TextInfo).
 */
const textBounded = (pattern: Pattern): boolean => {
	const desc = describeFieldOrThrow(
		regexField(pattern.source, pattern.flags === "default" ? [] : [pattern.flags]),
		SourceLoc("pattern", [])
	).desc
	return (
		desc.kind === "text" &&
		desc.language.kind === "refined" &&
		desc.language.check.bounds !== undefined
	)
}

/** The field names a relation's fields are drawn under, beside its key field id. */
const fieldNames = [
	"owner",
	"n",
	"amount",
	"label",
	"kind",
	"flags",
	"during",
	"rate",
	"day",
	"cost"
] as const

const relationNames = ["Account", "Task", "Ticket"] as const

const callerWriting: WritingSpec = { kind: "caller" }

/**
 * An ordinary relation: its key field id of a keyable type, then up to four fields of drawn types, its primary key id
 * and, sometimes, a keyable field after it.
 */
const relationOf = (
	d: Drawing,
	name: string,
	rosters: Arr.NonEmptyReadonlyArray<RosterSpec>,
	contracts: ReadonlyArray<ContractSpec>
): RelationSpec => {
	const idType = d.from<FieldType>([
		{ kind: "uuid" },
		{ kind: "pg", spelling: d.from(["int8", "int4"] as const) }
	])
	const names = Arr.take(d.some(fieldNames), 1 + d.upTo(3))
	const fields = Arr.map(names, (field): FieldSpec => ({
		name: field,
		type: fieldTypeOf(d, rosters, contracts),
		writing: callerWriting
	}))
	const keyed = Arr.filter(fields, (f) => keyable(f.type, contracts))
	const second = Arr.isReadonlyArrayNonEmpty(keyed) && d.upTo(3) === 0 ? [d.from(keyed).name] : []
	return {
		name,
		fields: [{ name: "id", type: idType, writing: callerWriting }, ...fields],
		key: ["id", ...second]
	}
}

/** Whether an aggregate's sum, mean, min and max read a field of this type: a number, through its contracts. */
const aggregatable = (t: FieldType, contracts: ReadonlyArray<ContractSpec>): boolean => {
	switch (t.kind) {
		case "pg":
			return !Arr.contains(["money", "bool"] as const, t.spelling)
		case "numeric":
			return true
		case "contract": {
			const found = Arr.findFirst(contracts, (c) => c.name === t.name)
			return Option.isSome(found) && aggregatable(found.value.base, contracts)
		}
		case "uuid":
		case "date":
		case "natural":
		case "vector":
		case "text":
		case "closedId":
		case "bits":
		case "span":
			return false
	}
}

/** A derived definition's extras: up to three aggregates of the relation's numeric caller fields, and a literal. */
const extrasOf = (
	d: Drawing,
	r: RelationSpec,
	contracts: ReadonlyArray<ContractSpec>
): ReadonlyArray<DerivedExtra> => {
	const numbers = Arr.filter(
		r.fields,
		(f) => f.writing.kind === "caller" && aggregatable(f.type, contracts)
	)
	const aggregates: ReadonlyArray<DerivedExtra> = Arr.isReadonlyArrayNonEmpty(numbers)
		? upTo(d.upTo(2) + 1, (i) => ({
				name: `x${i}`,
				kind: d.from(["sum", "mean", "min", "max"] as const),
				field: d.from(numbers).name
			}))
		: []
	return d.upTo(1) === 1 ? [...aggregates, { name: "one", kind: "literal" }] : aggregates
}

/** Key statements over the base's relations: a drawn keyable field or two, other than the primary key. */
const keyStatementsOf = (
	d: Drawing,
	relations: Arr.NonEmptyReadonlyArray<RelationSpec>,
	contracts: ReadonlyArray<ContractSpec>
): ReadonlyArray<StatementSpec> =>
	Arr.flatMap(relations, (r): ReadonlyArray<StatementSpec> => {
		const keyed = Arr.filter(
			r.fields,
			(f) => keyable(f.type, contracts) && !Arr.contains(r.key, f.name)
		)
		return Arr.isReadonlyArrayNonEmpty(keyed) && d.keep("keyStatement")
			? [
					{
						kind: "key",
						side: fieldsSide(
							r.name,
							Arr.map(d.some(keyed), (f) => f.name)
						)
					}
				]
			: []
	})

/** The relation a name declares among the base's. */
const relationNamed = (relations: ReadonlyArray<RelationSpec>, name: string): RelationSpec =>
	Option.getOrThrowWith(
		Arr.findFirst(relations, (r) => r.name === name),
		() => new Error(`no relation ${name} in the case`)
	)

const fieldOf = (r: RelationSpec, name: string): FieldSpec =>
	Option.getOrThrowWith(
		Arr.findFirst(r.fields, (f) => f.name === name),
		() => new Error(`no field ${name} of ${r.name}`)
	)

/** Whether two field types are one type: the same spelling of the same identity, written the same way. */
const sameType = (a: FieldType, b: FieldType): boolean => typeText(a) === typeText(b)

/**
 * A field type's identity as text: its carrier with what tells its values apart (a contract's or roster's name, a
 * typmod, a pattern, an endpoint).
 */
const typeText = (t: FieldType): string => {
	switch (t.kind) {
		case "pg":
			return `pg ${pgCanonical[t.spelling]}`
		case "uuid":
		case "date":
		case "natural":
			return t.kind
		case "numeric":
			return `numeric ${t.precision} ${t.scale}`
		case "vector":
			return `vector ${t.dims}`
		case "text":
			return `text ${t.pattern.source} ${t.pattern.flags === "su" ? "su" : "u"}`
		case "contract":
			return `contract ${t.name}`
		case "closedId":
			return `closedId ${t.roster}`
		case "bits":
			return `bits ${t.roster}`
		case "span":
			return `span ${t.endpoint.kind === "pg" ? pgCanonical[t.endpoint.spelling] : `contract ${t.endpoint.name}`} ${t.width === undefined ? "none" : t.width.value}`
	}
}

const pgCanonical: { readonly [S in PgSpelling]: string } = {
	int2: "int2",
	int4: "int4",
	int8: "int8",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "money",
	bool: "bool"
}

/**
 * A containment between two relations of the base: a field of one into the primary key of another, whose key is one
 * field, its source field drawn of the target key's type where one is, so the engine admits it.
 */
const containmentsOf = (
	d: Drawing,
	relations: Arr.NonEmptyReadonlyArray<RelationSpec>
): ReadonlyArray<StatementSpec> => {
	const targets = Arr.filter(relations, (r) => r.key.length === 1)
	if (!Arr.isReadonlyArrayNonEmpty(targets) || !d.keep("containment")) {
		return []
	}
	const target = d.from(targets)
	const targetField = fieldOf(target, target.key[0])
	const sources = Arr.flatMap(relations, (r) =>
		Arr.flatMap(r.fields, (f) =>
			r.name !== target.name && sameType(f.type, targetField.type) && f.writing.kind === "caller"
				? [{ relation: r.name, field: f.name }]
				: []
		)
	)
	if (!Arr.isReadonlyArrayNonEmpty(sources)) {
		return []
	}
	const source = d.from(sources)
	return [
		{
			kind: "contained",
			left: fieldsSide(source.relation, [source.field]),
			right: fieldsSide(target.name, [targetField.name])
		}
	]
}

/** The monoids an ordered family's folds draw, each with the fields it adds to the member and the owner. */
const orderedMonoids = ["sum", "count", "or", "twos", "max"] as const

/**
 * An ordered or counted family pack: its owner and member relations, and its folds, each filling its own accumulated
 * end fields, a sum over an ordered family with a (before, after) pair when drawn.
 */
const familyPackOf = (
	d: Drawing,
	kind: "ordered" | "counted",
	roster: RosterSpec
): { readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>; readonly family: FamilySpec } => {
	const [owner, member, group, value] =
		kind === "ordered"
			? (["Order", "Line", "order", "qty"] as const)
			: (["Pool", "Item", "pool", "v"] as const)
	const monoids = kind === "ordered" ? d.some(orderedMonoids) : d.some(["count", "sum"] as const)
	const sumType: FieldType = { kind: "pg", spelling: d.from(["int8", "int4"] as const) }
	const start = (t: FieldType): Start =>
		t.kind === "pg" && t.spelling === "int4"
			? { kind: "integer", value: 0 }
			: { kind: "bigint", value: 0n }
	const pair = kind === "ordered" && d.upTo(1) === 1
	const accumulated = (type: FieldType, name: string, from: Start): FieldSpec => ({
		name,
		type,
		writing: { kind: "accumulated", start: from }
	})
	const set: FieldType = { kind: "bits", roster: roster.name }
	const memberFields: ReadonlyArray<FieldSpec> = [
		...(Arr.contains(monoids, "sum") || kind === "counted"
			? [{ name: value, type: sumType, writing: callerWriting }]
			: []),
		...(Arr.contains(monoids, "sum") && pair
			? [
					accumulated(sumType, "before", start(sumType)),
					accumulated(sumType, "after", start(sumType))
				]
			: []),
		...(Arr.contains(monoids, "or") || Arr.contains(monoids, "twos")
			? [{ name: "flags", type: set, writing: callerWriting }]
			: []),
		...(Arr.contains(monoids, "max")
			? [
					{
						name: "kind",
						type: { kind: "closedId", roster: roster.name },
						writing: callerWriting
					} as const
				]
			: [])
	]
	const noHandles: Start = { kind: "noHandles", roster: roster.name }
	const ends: ReadonlyArray<
		readonly [FoldSpec["monoid"], ReadonlyArray<FieldSpec>, ReadonlyArray<string>]
	> = Arr.map(monoids, (m) => {
		switch (m) {
			case "sum":
				return [
					m,
					[accumulated(sumType, "total", start(sumType))],
					[value, ...(pair ? ["before", "after"] : [])]
				]
			case "count":
				return [m, [accumulated({ kind: "natural" }, "size", { kind: "bigint", value: 0n })], []]
			case "or":
				return [m, [accumulated(set, "seen", noHandles)], ["flags"]]
			case "twos":
				return [
					m,
					[accumulated(set, "ones", noHandles), accumulated(set, "twice", noHandles)],
					["flags"]
				]
			case "max":
				return [
					m,
					[
						accumulated({ kind: "closedId", roster: roster.name }, "top", {
							kind: "handle",
							roster: roster.name,
							handle: roster.handles[0]
						})
					],
					["kind"]
				]
		}
	})
	const ownerRelation: RelationSpec = {
		name: owner,
		fields: [
			{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "n", type: { kind: "natural" }, writing: { kind: "drawn" } },
			...Arr.flatMap(ends, ([, fields]) => fields)
		],
		key: ["id"]
	}
	const memberRelation: RelationSpec = {
		name: member,
		fields: [
			{ name: group, type: { kind: "uuid" }, writing: callerWriting },
			...(kind === "ordered"
				? [{ name: "at", type: { kind: "natural" }, writing: { kind: "drawn" } } as const]
				: []),
			...memberFields
		],
		key: kind === "ordered" ? [group, "at"] : [group, value]
	}
	return {
		relations: [ownerRelation, memberRelation],
		family: {
			kind,
			owner,
			count: "n",
			member: { relation: member, terms: kind === "ordered" ? [group, "at"] : [group] },
			folds: Arr.map(ends, ([monoid, fields, steps]) => ({
				monoid,
				step: { relation: member, terms: [group, ...steps] },
				end: { relation: owner, terms: ["id", ...Arr.map(fields, (f) => f.name)] }
			}))
		}
	}
}

/**
 * A tree pack: a document's nodes keyed by their root field doc and their start, each row's drawn parent, index,
 * children, start and end, its root field doc its tree's.
 */
const treePack = (): {
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly family: FamilySpec
} => {
	const drawn = (name: string): FieldSpec => ({
		name,
		type: { kind: "natural" },
		writing: { kind: "drawn" }
	})
	return {
		relations: [
			{
				name: "Node",
				fields: [
					{ name: "doc", type: { kind: "uuid" }, writing: callerWriting },
					drawn("parent"),
					drawn("at"),
					drawn("children"),
					drawn("start"),
					drawn("end"),
					{ name: "label", type: { kind: "pg", spelling: "int4" }, writing: callerWriting }
				],
				key: ["doc", "start"]
			}
		],
		family: {
			kind: "tree",
			relation: "Node",
			count: "children",
			member: { relation: "Node", terms: ["parent", "at"] },
			root: ["doc"]
		}
	}
}

/** The roles of a case: a reader of every relation, and a writer of drawn ordinary relations, each closed one by its
 * insert list and each open one by its write list (`statements`' mutable ones). */
const rolesOf = (
	d: Drawing,
	relations: Arr.NonEmptyReadonlyArray<RelationSpec>,
	statements: ReadonlyArray<StatementSpec>
): Arr.NonEmptyReadonlyArray<RoleSpec> => [
	{ name: "reader", insert: [], write: [] },
	...(d.keep("writer") ? [{ name: "writer", ...listsOf(d.some(relations), statements) }] : [])
]

/** A case's base: its rosters, contracts, relations, statements, family, derived relation and roles. */
const baseOf = (d: Drawing): Base => {
	const closedArity = d.upTo(2) === 0 ? undefined : d.from([1, 2, 3] as const)
	const closedApart = closedArity !== undefined && closedArity > 1 && d.upTo(1) === 1
	const rosters: Arr.NonEmptyReadonlyArray<RosterSpec> =
		closedApart || d.keep("secondRoster") ? rosterPool : [rosterPool[0]]
	const contracts = contractsOf(d, rosters)
	const own = Arr.map(Arr.take(relationNames, 1 + d.upTo(2)), (name) =>
		relationOf(d, name, rosters, contracts)
	)
	const ordinary: Arr.NonEmptyReadonlyArray<RelationSpec> = [
		relationOf(d, "Account", rosters, contracts),
		...Arr.drop(own, 1)
	]
	const pack = d.keep("ordered")
		? familyPackOf(d, "ordered", d.from(orderedRosters(rosters)))
		: d.keep("counted")
			? familyPackOf(d, "counted", d.from(rosters))
			: d.keep("tree")
				? treePack()
				: undefined
	const slots: SlotsSpec | undefined =
		d.upTo(2) === 0
			? undefined
			: {
					roster: d.from(rosters).name,
					law: d.from(["contained", "mirrors"] as const),
					selectedKey: d.upTo(1) === 1
				}
	if (slots !== undefined) {
		d.note("slots")
		if (slots.law === "mirrors") {
			d.note("slotsMirrors")
		}
		if (slots.selectedKey) {
			d.note("slotsSelectedKey")
		}
	}
	const relations: Arr.NonEmptyReadonlyArray<RelationSpec> = [
		...ordinary,
		...(pack === undefined ? [] : pack.relations),
		...(slots === undefined ? [] : slotRelations(slots))
	]
	const open = Arr.filter(ordinary, () => d.keep("mutableStatement"))
	/** Each mutable relation open: in the unit over its primary key's first field (unitsOver), then mutable. */
	const mutable: ReadonlyArray<StatementSpec> = [
		...unitsOver(open),
		...Arr.map(open, (r): StatementSpec => ({ kind: "mutable", relation: r.name }))
	]
	const groupable = Arr.flatMap(ordinary, (r) =>
		Arr.flatMap(r.fields, (f) => (keyable(f.type, contracts) ? [{ over: r.name, by: f.name }] : []))
	)
	const grouped =
		Arr.isReadonlyArrayNonEmpty(groupable) && d.upTo(3) !== 0 ? d.from(groupable) : undefined
	const derivedSpec: DerivedSpec | undefined =
		grouped === undefined
			? undefined
			: {
					name: "Counts",
					...grouped,
					extras: extrasOf(d, relationNamed(ordinary, grouped.over), contracts)
				}
	if (derivedSpec !== undefined) {
		d.note("derived")
		for (const x of derivedSpec.extras) {
			d.note(extraForm[x.kind])
		}
	}
	const sameRoster = d.from(rosters)
	const closedSpec: ClosedSpec | undefined =
		closedArity === undefined
			? undefined
			: {
					key: closedApart
						? [
								Arr.headNonEmpty(rosterPool),
								Arr.lastNonEmpty(rosterPool),
								...(closedArity === 3 ? [d.from(rosterPool)] : [])
							]
						: nonEmpty(
								upTo(closedArity, () => sameRoster),
								"a closed key holds a roster for each of its arity's places"
							),
					payload: d.from(["int2", "int8", "text"] as const),
					generated: d.keep("generated")
				}
	const roles = rolesOf(d, ordinary, mutable)
	if (closedArity !== undefined) {
		d.note("closedRelation")
		d.note(closedArityForm[closedArity])
		if (Arr.isReadonlyArrayNonEmpty(roles)) {
			d.note("roleBesideClosed")
		}
	}
	return {
		rosters,
		contracts,
		relations,
		statements: [
			...keyStatementsOf(d, ordinary, contracts),
			...containmentsOf(d, ordinary),
			...mutable,
			...(slots === undefined ? [] : slotStatements(slots))
		],
		family: pack === undefined ? undefined : pack.family,
		derived: derivedSpec,
		roles,
		closedRelation: closedSpec,
		slots,
		publics: [d.from(publicValues), d.from(publicValues)],
		spellings: Arr.map(Arr.range(0, 2), () => {
			const x = d.from(spellingsOf)
			const y = d.from(spellingsOf)
			return [x, y] as const
		})
	}
}
/** A built roster: the members a probe reads of it. */
type RosterValue = ReturnType<typeof closed<string, Arr.NonEmptyReadonlyArray<string>, RosterOrder>>

/** Rule, the base's closed relation, built as a JavaScript caller builds it: a row of every key. */
const closedValue = (c: ClosedSpec, rosters: ReadonlyMap<string, RosterValue>) => {
	const [, payload] = payloadValue(c.payload)
	const names = closedKeyNames(c)
	const fields: Readonly<Record<string, FieldBase>> = {
		...closedIdFields(c, rosters),
		w: int4,
		x: fieldValue(payloadType(c.payload), rosters, new Map())
	}
	return closedRelation(
		"Rule",
		fields,
		names,
		Arr.map(closedKeys(c), (k) => ({ ...Rec.fromEntries(Arr.zip(names, k)), w: 1, x: payload })),
		[]
	)
}

/** A closed relation's key fields as fields of a relation: k1 through kn, each a closed id of its roster. */
const closedIdFields = (
	c: ClosedSpec,
	rosters: ReadonlyMap<string, RosterValue>
): Readonly<Record<string, FieldBase>> =>
	Rec.fromEntries(
		Arr.zip(
			closedKeyNames(c),
			Arr.map(c.key, (r) => closedId(got(rosters, r.name)))
		)
	)

/** Rule's value, with its closed reads. */
type ClosedValue = ReturnType<typeof closedValue>

/**
 * A call of a closed read as a JavaScript caller makes it, each of its at most four arguments in its place: a field and
 * a key of up to three closed ids.
 */
const closedCall = (
	read: Parameters<typeof Reflect.apply>[0],
	rule: unknown,
	args: ReadonlyArray<unknown>
): unknown => {
	const [a, b, c, e] = args
	switch (args.length) {
		case 0:
			return Reflect.apply(read, rule, [])
		case 1:
			return Reflect.apply(read, rule, [a])
		case 2:
			return Reflect.apply(read, rule, [a, b])
		case 3:
			return Reflect.apply(read, rule, [a, b, c])
		case 4:
			return Reflect.apply(read, rule, [a, b, c, e])
		default:
			throw new Error(`a closed read of ${args.length} arguments, more than a key of three holds`)
	}
}

/** C.at(field, k…) as a JavaScript caller calls it: the key values whatever they are, which the read admits. */
const closedRead = (rule: ClosedValue, field: string, key: ReadonlyArray<unknown>): unknown =>
	closedCall(rule.at, rule, Arr.prepend(key, field))

/** C.row(k…) as a JavaScript caller calls it. */
const closedRow = (rule: ClosedValue, prefix: ReadonlyArray<unknown>): unknown =>
	closedCall(rule.row, rule, prefix)

/** C.has(k…) as a JavaScript caller calls it. */
const closedHas = (rule: ClosedValue, key: ReadonlyArray<unknown>): unknown =>
	closedCall(rule.has, rule, key)

/**
 * Gen, its generated fields read off its row: Rule's w at its closed ids, the set of Rule's last key field its other
 * closed ids complete, and its depth plus one.
 */
const generatedValue = (
	c: ClosedSpec,
	rule: ClosedValue,
	rosters: ReadonlyMap<string, RosterValue>
): AnyRelation =>
	generatedRelation(
		"Gen",
		{ id: Id, ...closedIdFields(c, rosters), depth: int4 },
		["id"],
		(row: Readonly<Record<string, unknown>>) => ({
			weight: generatedField(
				int4,
				closedRead(
					rule,
					"w",
					Arr.map(closedKeyNames(c), (k) => row[k])
				),
				[]
			),
			flags: generatedField(
				bit(got(rosters, Arr.lastNonEmpty(c.key).name)),
				closedRow(
					rule,
					Arr.map(Arr.initNonEmpty(closedKeyNames(c)), (k) => row[k])
				),
				[]
			),
			next: generatedField(int8, computeCore.cast(computeCore.add(row["depth"], 1), int8), [])
		}),
		[]
	)

/** A case's base as the engine built it: each value by its declared name. */
interface Env {
	readonly rosters: ReadonlyMap<string, RosterValue>
	readonly contracts: ReadonlyMap<string, FieldBase>
	readonly relations: ReadonlyMap<string, AnyRelation>
	/** The schema's members, its rosters, relations and closed relation, each under its own name. */
	readonly members: Readonly<Record<string, AnyRelation | AnyClosed>>
	readonly closedRelation: ClosedValue | undefined
	readonly statements: ReadonlyArray<Statement>
	readonly schema: AnySchema
	/** The extension that declares the derived relation, or the schema. */
	readonly level: AnySchema
	/** The level's rosters and ordinary relations, each a whole entry a role may hold: a live derived relation is none. */
	readonly entries: Readonly<Record<string, AnyRelation | AnyRoster>>
	readonly derived: AnyDerived | undefined
	/** Each role's write list, as the engine described the role. */
	readonly writes: ReadonlyMap<string, ReadonlyArray<string>>
}

const got = <A>(map: ReadonlyMap<string, A>, name: string): A =>
	Option.getOrThrowWith(
		Option.fromUndefinedOr(map.get(name)),
		() => new Error(`no ${name} in the case`)
	)

/** The descriptor of an endpoint spelling or of a contract, as the engine's span core reads it. */
const endpointValue = (e: Endpoint, contracts: ReadonlyMap<string, FieldBase>): FieldBase =>
	e.kind === "pg" ? plainDescriptors[e.spelling] : got(contracts, e.name)

/** A field type's descriptor, built as a JavaScript caller builds it. */
const fieldValue = (
	t: FieldType,
	rosters: ReadonlyMap<string, RosterValue>,
	contracts: ReadonlyMap<string, FieldBase>
): FieldBase => {
	switch (t.kind) {
		case "pg":
			return plainDescriptors[t.spelling]
		case "uuid":
			return Id
		case "date":
			return dateDescriptor
		case "natural":
			return naturalDescriptor
		case "numeric":
			return numeric(t.precision, t.scale)
		case "vector":
			return vector(t.dims)
		case "text":
			return regexField(t.pattern.source, t.pattern.flags === "default" ? [] : [t.pattern.flags])
		case "contract":
			return got(contracts, t.name)
		case "closedId":
			return closedId(got(rosters, t.roster))
		case "bits":
			return bit(got(rosters, t.roster))
		case "span":
			return t.width === undefined
				? spanDescriptor(endpointValue(t.endpoint, contracts))
				: spanDescriptor(endpointValue(t.endpoint, contracts), t.width.value)
	}
}

/** An accumulated field's start as its host value. */
const startValue = (s: Start, rosters: ReadonlyMap<string, RosterValue>): unknown => {
	switch (s.kind) {
		case "integer":
		case "bigint":
		case "branded":
			return s.value
		case "handle":
			return s.handle
		case "noHandles":
			return bitsOf(got(rosters, s.roster), [], [])
		case "text":
			return s.value
	}
}

const fieldDescriptor = (
	f: FieldSpec,
	rosters: ReadonlyMap<string, RosterValue>,
	contracts: ReadonlyMap<string, FieldBase>
): FieldBase => {
	const type = fieldValue(f.type, rosters, contracts)
	switch (f.writing.kind) {
		case "caller":
			return type
		case "drawn":
			return drawnField(naturalDescriptor, [])
		case "accumulated":
			return accumulatedField(type, startValue(f.writing.start, rosters), mintKeyValue(f.type))
	}
}

const relationValue = (
	r: RelationSpec,
	rosters: ReadonlyMap<string, RosterValue>,
	contracts: ReadonlyMap<string, FieldBase>
): AnyRelation =>
	relation(
		r.name,
		Rec.fromEntries(
			Arr.map(r.fields, (f) => [f.name, fieldDescriptor(f, rosters, contracts)] as const)
		),
		r.key,
		[]
	)

/** A law side as a JavaScript caller builds it: its source, a relation or a selection of it, then its terms. */
const lawSideValue = (s: LawSide, relations: ReadonlyMap<string, AnyRelation>) => {
	const relationValue = got(relations, s.relation)
	const selection = s.selection
	const source =
		selection === undefined
			? relationValue
			: selectBuilder(relationValue, (row: Readonly<Record<string, unknown>>) =>
					rowHelpers.eq(row[selection.field], selection.value)
				)
	return onBuilder(
		source,
		Arr.map(s.terms, (t) => (t.kind === "field" ? t.field : predBuilder(t.field)))
	)
}

const sideValue = (s: SideSpec, relations: ReadonlyMap<string, AnyRelation>) =>
	onBuilder(got(relations, s.relation), s.terms)

const statementValue = (
	s: StatementSpec,
	{ relations, rosters, contracts }: Pick<Env, "relations" | "rosters" | "contracts">
): Statement => {
	switch (s.kind) {
		case "key":
			return keyBuilder(lawSideValue(s.side, relations))
		case "contained":
			return containedBuilder(lawSideValue(s.left, relations), lawSideValue(s.right, relations))
		case "mirrors":
			return mirrorsBuilder(lawSideValue(s.left, relations), lawSideValue(s.right, relations))
		case "mutable":
			return mutableBuilder(got(relations, s.relation))
		case "unit":
			return unitBuilder(
				s.heading.name,
				{ [s.heading.field]: fieldValue(s.heading.type, rosters, contracts) },
				[]
			)
	}
}

/** A family's statements: the family, then its folds in order. */
const familyValues = (
	f: FamilySpec,
	relations: ReadonlyMap<string, AnyRelation>
): ReadonlyArray<Statement> => {
	switch (f.kind) {
		case "tree": {
			const node = got(relations, f.relation)
			return [
				treeBuilder(sideValue(f.member, relations), finBuilder(node, f.count), { root: f.root })
			]
		}
		case "ordered":
		case "counted": {
			const slots = finBuilder(got(relations, f.owner), f.count)
			const family =
				f.kind === "ordered"
					? orderedBuilder(sideValue(f.member, relations), slots)
					: countedBuilder(sideValue(f.member, relations), slots)
			return [
				family,
				...Arr.map(f.folds, (fold) =>
					foldBuilder(
						family,
						monoids[fold.monoid],
						sideValue(fold.step, relations),
						sideValue(fold.end, relations)
					)
				)
			]
		}
	}
}

/** A derived relation's definition: its relation's facts grouped by `by`, counted, every key field bound. */
const definitionOf = (
	spec: DerivedSpec,
	base: Base,
	schemaValue: AnySchema,
	relations: ReadonlyMap<string, AnyRelation>
) => {
	const r = relationNamed(base.relations, spec.over)
	const bound = Arr.dedupe([...r.key, spec.by, ...extraFields(spec)])
	return queryOver(schemaValue).rule((rule: RuleValue) => {
		const vars = varsOver(got(relations, spec.over), "fact")
		const extra = (x: DerivedExtra): unknown => {
			switch (x.kind) {
				case "sum":
					return rule.sum(vars[x.field])
				case "mean":
					return rule.mean(vars[x.field])
				case "min":
					return rule.min(vars[x.field])
				case "max":
					return rule.max(vars[x.field])
				case "literal":
					return computeCore.literal(int4, 1)
			}
		}
		return rule
			.match(
				got(relations, spec.over),
				Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const))
			)
			.find({
				[spec.by]: vars[spec.by],
				total: rule.count(),
				...Rec.fromEntries(Arr.map(spec.extras, (x) => [x.name, extra(x)] as const))
			})
	})
}

/** The base built through the engine's builder cores, every value by its name. */
const envOf = (base: Base): Env => {
	const rosters = new Map(
		Arr.map(base.rosters, (r) => [r.name, closed(r.name, r.handles, r.order, [])] as const)
	)
	const contracts = new Map<string, FieldBase>()
	for (const c of base.contracts) {
		contracts.set(c.name, admitContract(c.name, fieldValue(c.base, rosters, contracts), []))
	}
	const rule =
		base.closedRelation === undefined ? undefined : closedValue(base.closedRelation, rosters)
	const relations = new Map([
		...Arr.map(base.relations, (r) => [r.name, relationValue(r, rosters, contracts)] as const),
		...(base.closedRelation === undefined || rule === undefined || !base.closedRelation.generated
			? []
			: [["Gen", generatedValue(base.closedRelation, rule, rosters)] as const])
	])
	const statements: ReadonlyArray<Statement> = [
		...Arr.map(base.statements, (s) => statementValue(s, { relations, rosters, contracts })),
		...(base.family === undefined ? [] : familyValues(base.family, relations))
	]
	const members: Readonly<Record<string, AnyRelation | AnyClosed>> = {
		...Rec.fromEntries([...rosters]),
		...Rec.fromEntries([...relations]),
		...(rule === undefined ? {} : { Rule: rule })
	}
	const schemaValue = schema("S", Rec.values(members), statements, [])
	const counts =
		base.derived === undefined
			? undefined
			: derivedBuilder(
					base.derived.name,
					definitionOf(base.derived, base, schemaValue, relations),
					[]
				)
	const level =
		counts === undefined ? schemaValue : schema.extend([schemaValue], "Level", [counts], [], [])
	const entries = { ...Rec.fromEntries([...rosters]), ...Rec.fromEntries([...relations]) }
	const described = new Map(
		Arr.map(base.roles, (r) => {
			const value = role(level, r.name, entries, { insert: r.insert, write: r.write })
			return [r.name, roleDescOf(value)] as const
		})
	)
	const listed = (list: (desc: RoleDesc) => ReadonlyArray<string>) =>
		new Map(
			Arr.map(
				[...described],
				([name, desc]) => [name, desc === undefined ? [] : list(desc)] as const
			)
		)
	return {
		rosters,
		contracts,
		relations,
		members,
		closedRelation: rule,
		statements,
		schema: schemaValue,
		level,
		entries,
		derived: counts,
		writes: listed((desc) => Arr.map(writtenNames(desc), (w) => w.name))
	}
}
/** A case's TypeScript identifier for a value it declares under `name`. */
type Ids = (name: string) => string

/** A union of literal texts, each a TypeScript string literal type, never where there are none. */
const literalUnion = (values: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(values) ? Arr.join(Arr.map(values, jsonText), " | ") : "never"

/** A numeric(p, s) field's host, its scale's: a bigint at scale 0, whose values are integers, a Numeric at any other. */
const numericHost = (typmod: NumericTypmod): string =>
	typmod.scale === 0 ? "bigint" : "Fi.Numeric"

/**
 * The host type of a field as the engine describes it (ir/desc.ts FieldDesc), as TypeScript: what its column delivers,
 * a domain's values its base's branded with its name, a closed id one of its roster's handles, a set the roster's
 * Bits, natural an unbranded bigint.
 */
const hostOfDesc = (desc: FieldDesc, base: Base, ids: Ids): string => {
	switch (desc.kind) {
		case "pg":
			return pgHost[desc.type]
		case "numeric":
			return numericHost(desc)
		case "exact":
			return desc.carrier === "exactInteger" ? "bigint" : "Fi.Money"
		case "computedNumeric":
			return "Fi.Numeric"
		case "uuid":
			return "Fi.Uuid"
		case "sha256":
		case "bytes":
			return "Uint8Array<ArrayBuffer>"
		case "pattern":
			return "string"
		case "text":
			return Arr.join(
				Arr.map(desc.patterns, (p) => `Tx.RegexInfer<${jsonText(p.source)}, ${jsonText(p.flags)}>`),
				" & "
			)
		case "domain":
			return builtinDesc(desc)
				? hostOfDesc(desc.base, base, ids)
				: `Fi.Marked<${hostOfDesc(desc.base, base, ids)}, ${keyText(desc.name)}>`
		case "span":
			return `Cp.Range<${hostOfDesc(desc.endpoint, base, ids)}>`
		case "closedId":
			return literalUnion(rosterNamed(base, desc.roster).handles)
		case "bits":
			return `Ff.Bits<typeof ${ids(desc.roster)}>`
		case "vector":
			return `Fi.Vector<${desc.dimensions}>`
		case "search":
			return `Fi.SearchDocument<${jsonText(desc.configuration)}>`
		case "variant":
			throw new Error("no agreement schema declares a variant field")
	}
}

/**
 * The engine's builtin contracts, natural and date: contracts whose column is their base's, so their values carry no
 * brand. A descriptor is one when its Description is one's (descText, the descriptor's canonical identity).
 */
const builtins: ReadonlyArray<FieldBase> = [naturalDescriptor, dateDescriptor]

const builtinDesc = (desc: FieldDesc): boolean => {
	const text = descText(desc)
	return Arr.some(builtins, (b) => {
		const builtin = descText(describeFieldOrThrow(b, SourceLoc("builtin", [])).desc)
		return text.ok && builtin.ok && text.value === builtin.value
	})
}

const builtinScalar = (t: ScalarType): boolean =>
	Arr.some(builtins, (b) =>
		sameScalarType(t, describeFieldOrThrow(b, SourceLoc("builtin", [])).scalar)
	)

/** The host type of each PostgreSQL scalar type a pg descriptor declares. */
const pgHost: { readonly [T in Extract<FieldDesc, { readonly kind: "pg" }>["type"]]: string } = {
	int2: "number",
	int4: "number",
	float4: "number",
	float8: "number",
	int8: "bigint",
	numeric: "Fi.Numeric",
	money: "Fi.Money",
	bool: "boolean",
	date: "Fi.CalendarDate",
	inet: "Fi.Inet",
	cidr: "Fi.Cidr"
}

const rosterNamed = (base: Base, name: string): RosterSpec =>
	Option.getOrThrowWith(
		Arr.findFirst(base.rosters, (r) => r.name === name),
		() => new Error(`no roster ${name} in the case`)
	)

/** An object type of `fields`, each `readonly name: type`. */
const objectType = (fields: ReadonlyArray<readonly [string, string]>): string =>
	Arr.isReadonlyArrayNonEmpty(fields)
		? `{ ${Arr.join(
				Arr.map(fields, ([name, type]) => `readonly ${jsonText(name)}: ${type}`),
				"; "
			)} }`
		: "{}"

/** A key as a readonly tuple type of its field names. */
const tupleType = (fields: ReadonlyArray<string>): string =>
	`readonly [${Arr.join(Arr.map(fields, jsonText), ", ")}]`

/** The fields of a relation as the engine describes them, by name, in declared order. */
const declsOf = (value: AnyRelation): ReadonlyArray<readonly [string, FieldDecl]> => {
	const desc = relationDescOf(value, "agreement relation")
	return desc.kind === "relation" ? Rec.toEntries(desc.fields) : []
}

/**
 * What the engine says of a relation's facts and additions: each field's host type, and the fields its caller writes.
 */
interface Heading {
	readonly fact: ReadonlyArray<readonly [string, string]>
	readonly written: ReadonlyArray<string>
}

const headingOf = (value: AnyRelation, base: Base, ids: Ids): Heading => {
	const decls = declsOf(value)
	return {
		fact: Arr.map(decls, ([name, decl]) => [name, hostOfDesc(decl.type, base, ids)] as const),
		written: Arr.flatMap(decls, ([name, decl]) => (decl.writing.kind === "caller" ? [name] : []))
	}
}

/** An addition as the engine admits one: the fields its caller writes, less `without`. */
const additionType = (h: Heading, without: ReadonlyArray<string>): string =>
	objectType(
		Arr.filter(h.fact, ([name]) => Arr.contains(h.written, name) && !Arr.contains(without, name))
	)

/**
 * The candidate keys over a relation's heading the engine compiles the schema to: its owned keys, the primary key and
 * each key statement's, and each ordered family's that keys its members by heading fields, its group and index; a
 * tree's root fields and start are its relation's primary key, and a counted family's index is a law column, in no
 * heading.
 */
const keysOf = (artifacts: SchemaArtifacts, name: string): ReadonlyArray<ReadonlyArray<string>> => {
	const owned = artifacts.owned.relations[name]
	return [
		...(owned === undefined ? [] : Arr.map(owned.keys, (k) => k.fields)),
		...Arr.flatMap(artifacts.laws.families, (f) => {
			if (f.member.name !== name) {
				return []
			}
			return f.shape.index.kind === "field" && f.shape.kind !== "tree"
				? [[...Arr.map(f.group, (g) => g.member.name), f.shape.index.field.name]]
				: []
		})
	]
}
/** The pool's domain names (`contractNames`), each declared under a key of its own (`keyName`). */
const poolNames: ReadonlySet<string> = new Set(contractNames)

/**
 * The key a contract the program declares is under, as the program names it (schemaProgram's header): each of the
 * pool's under one of its own, `<name>Key`, so a contract over another, Code over Cents, is under a key apart from its
 * base's, as BRAND's KeyApart requires of it (types/fields/constructors.ts), where every contract was under the one
 * `Key` and each nested one was refused by the types the engine admits it by; and a probe's under the program's `Key`.
 */
const keyName = (name: string): string => (poolNames.has(name) ? `${name}Key` : "Key")

/** The type of a contract's key, as the program states it: the tests' Id's (test/support/ids.ts IdKey), else `keyName`'s. */
const keyText = (name: string): string => (name === idName ? "Fi.IdKey" : `typeof ${keyName(name)}`)

/** The host type of a scalar type as the engine compiles it (ir/scalar.ts ScalarType), as TypeScript. */
const hostOfScalar = (t: ScalarType, ids: Ids): string => {
	const { contract } = t
	if (contract !== undefined) {
		return builtinScalar(t)
			? hostOfScalar(contract.base, ids)
			: `Fi.Marked<${hostOfScalar(contract.base, ids)}, ${keyText(contract.name)}>`
	}
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "float4":
		case "float8":
			return "number"
		case "int8":
		case "exactInteger":
			return "bigint"
		case "numeric": {
			const typmod = integerTypmodOf(t)
			return typmod === undefined ? "Fi.Numeric" : numericHost(typmod)
		}
		case "money":
		case "exactMoney":
			return "Fi.Money"
		case "bool":
			return "boolean"
		case "uuid":
			return "Fi.Uuid"
		case "date":
			return "Fi.CalendarDate"
		case "inet":
			return "Fi.Inet"
		case "cidr":
			return "Fi.Cidr"
		case "text":
			return typeof t.text === "string"
				? "string"
				: Arr.join(
						Arr.map(
							t.text.patterns,
							(p) => `Tx.RegexInfer<${jsonText(p.source)}, ${jsonText(p.flags)}>`
						),
						" & "
					)
		case "sha256":
		case "bytes":
			return "Uint8Array<ArrayBuffer>"
		case "code":
			return literalUnion(t.roster.handles)
		case "bits":
			return `Ff.Bits<typeof ${ids(t.roster.closed)}>`
		case "range4":
		case "range8":
		case "rangeDate":
			return `Cp.Range<${hostOfScalar(t.span.endpoint, ids)}>`
		case "vector":
			return `Fi.Vector<${t.typmod.dims}>`
		case "tsvector":
			return `Fi.SearchDocument<${jsonText(t.configuration)}>`
		case "variant":
			throw new Error("no agreement schema declares a variant field")
	}
}

/** A head literal's TypeScript literal type. */
const literalTypeOf = (value: unknown): string => {
	switch (typeof value) {
		case "string":
			return jsonText(value)
		case "bigint":
			return `${value}n`
		case "number":
		case "boolean":
			return String(value)
		case "function":
		case "object":
		case "symbol":
		case "undefined":
			throw new Error(`no head literal of a drawn query is a ${typeof value}`)
	}
}

/** A closed id's handles under the key of each contract its type is, innermost first, as hostOfScalar marks them. */
const brandedHandles = (type: ScalarType, handles: string): string => {
	const { contract } = type
	return contract === undefined
		? handles
		: `Fi.Marked<${brandedHandles(contract.base, handles)}, ${keyText(contract.name)}>`
}

/**
 * The host type of a column the engine types `type` and decodes by `column` (core/decoder.ts Column): a constant's
 * column delivers its literals, a closed id's the handles it may deliver, under its contract's brand, and every other
 * column its scalar type's host values.
 */
const columnHost = (type: ScalarType, column: Column<unknown>, ids: Ids): string => {
	switch (column.kind) {
		case "constant":
			return Arr.join(Arr.dedupe(Arr.map(column.values, literalTypeOf)), " | ")
		case "code":
			return brandedHandles(
				type,
				Arr.join(Arr.dedupe(Arr.map(column.handles, literalTypeOf)), " | ")
			)
		case "variant":
		case "convert":
		case "text":
		case "bits":
		case "bytes":
			return hostOfScalar(type, ids)
	}
}

/**
 * The heading the engine compiles a query to: each column's host type, by name, as its scalar type and its carrier's
 * column describe it. A query the engine refuses is a defect of the generator, which draws only queries over a valid
 * base.
 */
const compiledHeading = (query: QueryValue, ids: Ids): ReadonlyArray<readonly [string, string]> =>
	Arr.map(compiledColumns(query), (c) => {
		const carrier = query.heading[c.name]
		if (carrier === undefined) {
			throw new Error(`the query's carriers have no field ${c.name}`)
		}
		return [c.name, columnHost(c.type, carrier.column, ids)] as const
	})

/** The columns the engine compiles a query to, each with its scalar type. */
const compiledColumns = (query: unknown): Columns => {
	const template = compileTemplate(query, undefined, testCompile)
	if (!template.ok) {
		throw new Error(
			`the engine refuses a drawn query, a defect of the generator: ${messageOf(template.error)}`
		)
	}
	return template.value.heading
}

/** A projection of every field of a relation: what its query's head delivers, which is its fact. */
const projectionOf = (schemaValue: AnySchema, value: unknown, fields: ReadonlyArray<string>) =>
	queryOver(schemaValue).rule((rule: RuleValue) => {
		const vars = varsOver(value, "fact")
		const bound = Rec.fromEntries(Arr.map(fields, (f) => [f, vars[f]] as const))
		return rule.match(value, bound).find(bound)
	})
/** A probe's TypeScript: lines before its statement, the statement a fault's diagnostic stands on, lines after. */
interface ProbeText {
	readonly head: ReadonlyArray<string>
	readonly line: string
	readonly tail: ReadonlyArray<string>
}

const oneLine = (line: string): ProbeText => ({ head: [], line, tail: [] })

/**
 * A probe: one declaration over the base. `refused` is the fault a refusal by the engine is, if any may be: the fault
 * it plants, or, for a probe whose verdict the engine decides by itself (a containment of drawn sides), the one
 * fault a refusal can be. `text` writes it under the identifiers of its case, `judge` builds and compiles it as the
 * runtime does.
 */
interface Probe {
	readonly construct: SchemaConstruct
	readonly refused: Planted | undefined
	readonly text: (ids: Ids, own: string, env: Env) => ProbeText
	readonly judge: (env: Env) => Verdict
}

/**
 * What the oracle says of a probe: admitted, or refused for a reason, the key its fault's refusal predicts: reasonKey
 * of the engine's CompileError, or `value:<fault>` of a host value's ValueFault.
 */
type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly key: string; readonly message: string }

const admitted: Verdict = { kind: "admitted" }

const engineVerdict = (r: Result.Result<unknown, CompileError>): Verdict =>
	r.ok ? admitted : { kind: "refused", key: reasonKey(r.error.reason), message: messageOf(r.error) }

/** A host value the engine admits or refuses: its ValueFault the refusal. */
const valueVerdict = (r: Result.Result<unknown, ValueFault>): Verdict =>
	r.ok ? admitted : { kind: "refused", key: `value:${r.error}`, message: r.error }

/** A build, its CompileError as its refusal. */
const building = (build: () => unknown): Verdict => engineVerdict(catchCompileError(build))

/** A build, then a compilation of what it built: the first refusal of either. */
const compiling = (build: () => unknown): Verdict =>
	engineVerdict(
		Result.flatMap(catchCompileError(build), (built) =>
			Result.flatMap(parseSchemaInput(built), (input) => inputArtifacts(input, testCompile))
		)
	)

/**
 * A schema of every relation of the base, under its own name, with the base's statements and `statements`: a probe's
 * statement in context.
 */
const probeSchema = (env: Env, statements: ReadonlyArray<Statement>): AnySchema =>
	schema("P", Rec.values(env.members), [...env.statements, ...statements], [])

const quoted = (names: ReadonlyArray<string>): string => Arr.join(Arr.map(names, jsonText), ", ")

/** A field's descriptor as the program spells it. */
const fieldSource = (t: FieldType, ids: Ids): string => {
	switch (t.kind) {
		case "pg":
			return `Fi.${t.spelling}`
		case "uuid":
			return "Fi.Id"
		case "date":
			return "Fi.date"
		case "natural":
			return "Fi.natural"
		case "numeric":
			return `Fi.numeric(${t.precision}, ${t.scale})`
		case "vector":
			return `Fi.vector(${t.dims})`
		case "text":
			return `Tx.str.regex(${jsonText(t.pattern.source)}${t.pattern.flags === "default" ? "" : `, ${jsonText(t.pattern.flags)}`})`
		case "contract":
			return ids(t.name)
		case "closedId":
			return `Fi.closedId(${ids(t.roster)})`
		case "bits":
			return `Fi.bit(${ids(t.roster)})`
		case "span": {
			const endpoint = t.endpoint.kind === "pg" ? `Fi.${t.endpoint.spelling}` : ids(t.endpoint.name)
			return `Fi.range(${endpoint}${t.width === undefined ? "" : t.width.host === "bigint" ? `, ${t.width.value}n` : `, ${t.width.value}`})`
		}
	}
}

/**
 * The key the engine's reading passes for the program's own contracts, which its admission builds keyless as a
 * JavaScript caller does (scalar/contract.ts admitMintKey reads a key's kind, never whose it is).
 */
const programKey = Symbol("Domain")

/**
 * What a field grizzle fills of type `t` takes after its own arguments, as the program spells it (types/fields
 * MintKey): a contract's key (`keyName`), the tests' `idKey` for Id, and nothing for any other type. A field grizzle
 * fills is of a probe's contract over a base type alone (the fold's Tally), never of a pool's contract over another,
 * which would take its chain's keys.
 */
const mintKeySource = (t: FieldType): string =>
	t.kind === "contract" ? `, ${keyName(t.name)}` : t.kind === "uuid" ? ", Fi.idKey" : ""

/** What a field grizzle fills of type `t` takes after its own arguments, as the engine's reading passes it (mintKeySource). */
const mintKeyValue = (t: FieldType): ReadonlyArray<symbol> =>
	t.kind === "contract" ? [programKey] : t.kind === "uuid" ? [idKey] : []

const startSource = (s: Start, ids: Ids): string => {
	switch (s.kind) {
		case "integer":
			return `${s.value}`
		case "bigint":
			return `${s.value}n`
		case "branded":
			return `toKey(${s.value}n)`
		case "handle":
			return jsonText(s.handle)
		case "noHandles":
			return `Fi.Bit.of(${ids(s.roster)}, [])`
		case "text":
			return jsonText(s.value)
	}
}

const fieldDeclSource = (f: FieldSpec, ids: Ids): string => {
	switch (f.writing.kind) {
		case "caller":
			return fieldSource(f.type, ids)
		case "drawn":
			return "Fi.drawn(Fi.natural)"
		case "accumulated":
			return `Fi.accumulated(${fieldSource(f.type, ids)}, ${startSource(f.writing.start, ids)}${mintKeySource(f.type)})`
	}
}

const relationSource = (r: RelationSpec, ids: Ids, key: string): string =>
	`Sc.relation(${jsonText(r.name)}, { ${Arr.join(
		Arr.map(r.fields, (f) => `${f.name}: ${fieldDeclSource(f, ids)}`),
		", "
	)} }, [${key}])`

/** A law side as the program writes it. */
const lawSideSource = (s: LawSide, ids: Ids): string => {
	const selection = s.selection
	const source =
		selection === undefined
			? ids(s.relation)
			: `Sc.select(${ids(s.relation)}, (t) => t.eq(t.${selection.field}, ${jsonText(selection.value)}))`
	return `Sc.on(${source}, ${Arr.join(
		Arr.map(s.terms, (t) =>
			t.kind === "field" ? jsonText(t.field) : `Sc.pred(${jsonText(t.field)})`
		),
		", "
	)})`
}

/** A law side as its type: its source, a relation or a selection of one, and its terms in order. */
const lawSideType = (s: LawSide, ids: Ids): string => {
	const source =
		s.selection === undefined
			? `typeof ${ids(s.relation)}`
			: `St.Selection<typeof ${ids(s.relation)}>`
	return `St.Side<${source}, readonly [${Arr.join(
		Arr.map(s.terms, (t) =>
			t.kind === "field" ? jsonText(t.field) : `St.Pred<${jsonText(t.field)}>`
		),
		", "
	)}]>`
}

const sideSource = (s: SideSpec, ids: Ids): string =>
	`Sc.on(${ids(s.relation)}, ${quoted(s.terms)})`
/** The integer spelling at the bottom of a contract's chain, if it is one. */
const integerEnd = (
	contracts: ReadonlyArray<ContractSpec>,
	name: string
): EndpointSpelling | undefined => {
	const found = Arr.findFirst(contracts, (c) => c.name === name)
	if (Option.isNone(found)) {
		return undefined
	}
	const base = found.value.base
	return base.kind === "contract"
		? integerEnd(contracts, base.name)
		: base.kind === "pg" && Arr.contains(endpointSpellings, base.spelling)
			? Option.getOrUndefined(Arr.findFirst(endpointSpellings, (s) => s === base.spelling))
			: undefined
}

/** The ordinary relations a case declares beside its packs: the ones the base drew first. */
const ordinaryOf = (base: Base): Arr.NonEmptyReadonlyArray<RelationSpec> => {
	const own = Arr.filter(
		base.relations,
		(r) => Arr.contains(relationNames, r.name) || r.name === "Account"
	)
	return Arr.isReadonlyArrayNonEmpty(own) ? own : [base.relations[0]]
}

/**
 * A relation's primary key, as the program writes it: drawn whole, or with one planted fault, among them a set field
 * beside the drawn ones as the primary key, or as a key statement's side.
 */
const keyProbe = (d: Drawing, base: Base): Probe => {
	const spec = relationOf(d, "Probe", base.rosters, base.contracts)
	const fault = d.from<SchemaFault | undefined>([
		undefined,
		"emptyKey",
		"undeclaredKeyField",
		"repeatedKeyField",
		"setPrimaryKey",
		"setKey"
	])
	const roster = d.from(base.rosters)
	const declared: RelationSpec =
		fault === "setPrimaryKey" || fault === "setKey"
			? {
					...spec,
					fields: [
						...spec.fields,
						{ name: "set", type: { kind: "bits", roster: roster.name }, writing: callerWriting }
					]
				}
			: spec
	const key: ReadonlyArray<string> =
		fault === "emptyKey"
			? []
			: fault === "undeclaredKeyField"
				? ["nope"]
				: fault === "repeatedKeyField"
					? [...spec.key, spec.key[0]]
					: fault === "setPrimaryKey"
						? ["set"]
						: spec.key
	const relationValueOf = (env: Env) =>
		relation(
			declared.name,
			Rec.fromEntries(
				Arr.map(
					declared.fields,
					(f) => [f.name, fieldDescriptor(f, env.rosters, env.contracts)] as const
				)
			),
			key,
			[]
		)
	return {
		construct: "keyProbe",
		refused: fault,
		text: (ids, own) =>
			fault === "setKey"
				? {
						head: [`export const ${own}_Probe = ${relationSource(declared, ids, quoted(key))}`],
						line: `export const ${own} = Sc.key(Sc.on(${own}_Probe, "set"))`,
						tail: []
					}
				: oneLine(relationSource(declared, ids, quoted(key))),
		judge: (env) => {
			if (fault === "setKey") {
				return compiling(() => {
					const probe = relationValueOf(env)
					return schema(
						"P",
						[...Rec.values(Rec.fromEntries([...env.rosters])), probe],
						[keyBuilder(onBuilder(probe, ["set"]))],
						[]
					)
				})
			}
			return fault === "setPrimaryKey"
				? compiling(() =>
						schema(
							"P",
							[...Rec.values(Rec.fromEntries([...env.rosters])), relationValueOf(env)],
							[],
							[]
						)
					)
				: building(() => relationValueOf(env))
		}
	}
}

/** A side over a relation of the base: drawn terms, or one planted fault. */
const sideProbe = (d: Drawing, base: Base): Probe => {
	const r = d.from(ordinaryOf(base))
	const terms = Arr.map(d.some(r.fields), (f) => f.name)
	const fault = d.from<SchemaFault | undefined>([
		undefined,
		"repeatedSideTerm",
		"emptySide",
		"undeclaredSideTerm"
	])
	const written: ReadonlyArray<string> =
		fault === "repeatedSideTerm"
			? [...terms, terms[0]]
			: fault === "emptySide"
				? []
				: fault === "undeclaredSideTerm"
					? [...terms, "nope"]
					: terms
	return {
		construct: "sideProbe",
		refused: fault,
		text: (ids) =>
			oneLine(
				`Sc.on(${ids(r.name)}${Arr.isReadonlyArrayNonEmpty(written) ? `, ${quoted(written)}` : ""})`
			),
		judge: (env) => building(() => onBuilder(got(env.relations, r.name), written))
	}
}

/** A roster of drawn handles, none among them, the empty domain both admit, or one planted fault. */
const rosterProbe = (d: Drawing): Probe => {
	const handles = d.some(["a", "b", "c"] as const)
	const shape = d.from(["drawn", "empty", "repeated"] as const)
	const fault: SchemaFault | undefined = shape === "repeated" ? "repeatedHandle" : undefined
	const written: ReadonlyArray<string> =
		shape === "empty" ? [] : shape === "repeated" ? [...handles, handles[0]] : handles
	return {
		construct: "rosterProbe",
		refused: fault,
		text: () => oneLine(`Sc.closed.ordered("Probe", [${quoted(written)}])`),
		judge: () => building(() => admitRoster("Probe", written, "ordered", declaredNaming, []))
	}
}

/** A roster's handle: one of its members, or a stranger. */
const handleProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const foreign = d.upTo(1) === 1
	const handle = foreign ? "Z" : d.from(roster.handles)
	return {
		construct: "handleProbe",
		refused: foreign ? "foreignHandle" : undefined,
		text: (ids) => oneLine(`${ids(roster.name)}.handle(${jsonText(handle)})`),
		judge: (env) => building(() => got(env.rosters, roster.name).handle(handle))
	}
}
/**
 * A containment or a mirror of a field of one relation of the base into a field of another: into its single-field
 * primary key, the field drawn of the key's type or not, where the engine alone decides it and a refusal is its sides'
 * types differing; or into a field no key holds alone, of the field's type, the declared class unkeyedTarget, which the
 * types accept and the engine refuses.
 */
const containmentProbe = (d: Drawing, base: Base): Probe | undefined => {
	const ordinary = ordinaryOf(base)
	const targets = Arr.filter(ordinary, (r) => r.key.length === 1)
	if (!Arr.isReadonlyArrayNonEmpty(targets)) {
		return undefined
	}
	const target = d.from(targets)
	const mirrored = d.upTo(2) === 0
	const source = d.from(mirrored ? targets : ordinary)
	const fields = mirrored
		? [fieldOf(source, source.key[0])]
		: Arr.filter(source.fields, (f) => f.writing.kind === "caller")
	const unkeyed = Arr.filter(
		target.fields,
		(f) =>
			f.writing.kind === "caller" &&
			!keyedAlone(base, target, f.name) &&
			Arr.some(fields, (g) => sameType(g.type, f.type))
	)
	const into =
		Arr.isReadonlyArrayNonEmpty(unkeyed) && d.upTo(2) === 0
			? d.from(unkeyed)
			: fieldOf(target, target.key[0])
	const declaredClass = !keyedAlone(base, target, into.name)
	const alike = Arr.filter(fields, (f) => sameType(f.type, into.type))
	const field =
		Arr.isReadonlyArrayNonEmpty(alike) && (declaredClass || d.upTo(1) === 1)
			? d.from(alike)
			: d.from(Arr.isReadonlyArrayNonEmpty(fields) ? fields : source.fields)
	const key = into
	const callee = mirrored ? "Sc.mirrors" : "Sc.contained"
	return {
		construct: "containmentProbe",
		refused: declaredClass ? "unkeyedTarget" : "sidesDiffer",
		text: (ids) =>
			oneLine(
				`${callee}(Sc.on(${ids(source.name)}, ${jsonText(field.name)}), Sc.on(${ids(target.name)}, ${jsonText(key.name)}))`
			),
		judge: (env) =>
			compiling(() => {
				const left = onBuilder(got(env.relations, source.name), [field.name])
				const right = onBuilder(got(env.relations, target.name), [key.name])
				return probeSchema(env, [
					mirrored ? mirrorsBuilder(left, right) : containedBuilder(left, right)
				])
			})
	}
}

/** Whether a field alone is a key of its relation: its primary key, or a key statement's side over it alone. */
const keyedAlone = (base: Base, r: RelationSpec, field: string): boolean =>
	(r.key.length === 1 && r.key[0] === field) ||
	Arr.some(
		base.statements,
		(s) =>
			s.kind === "key" &&
			s.side.relation === r.name &&
			s.side.selection === undefined &&
			s.side.terms.length === 1 &&
			s.side.terms[0].kind === "field" &&
			s.side.terms[0].field === field
	)

/** Whether the base states `relation` mutable. */
const statesMutable = (base: Base, relation: string): boolean =>
	Arr.some(base.statements, (s) => s.kind === "mutable" && s.relation === relation)

/**
 * The unit an ordinary relation the base leaves closed sits in once open, where the base states none it leads with: the
 * heading over its primary key's first field, beside the base's own units (unitsOver), so it nests none of them.
 */
const unitToOpen = (base: Base, relation: RelationSpec): ReadonlyArray<Leading<FieldType>> => {
	const open = Arr.filter(ordinaryOf(base), (r) => statesMutable(base, r.name))
	const stated = headingsOver(open)
	return Arr.filter(
		headingsOver([...open, relation]),
		(h) => !Arr.some(stated, (u) => u.name === h.name)
	)
}

/**
 * mutable over an ordinary relation, a roster, or the derived relation. Over an ordinary relation it opens the
 * relation: its unit beside it where the base states none its key leads with (unitToOpen), the unit the type tier never
 * reads.
 */
const mutableProbe = (d: Drawing, base: Base): Probe => {
	const target = d.from<
		| { readonly kind: "relation"; readonly relation: RelationSpec; readonly name: string }
		| { readonly kind: "roster"; readonly name: string }
		| { readonly kind: "derived"; readonly name: string }
	>([
		{ kind: "roster", name: d.from(base.rosters).name },
		...Arr.flatMap(ordinaryOf(base), (r) =>
			statesMutable(base, r.name) ? [] : [{ kind: "relation", relation: r, name: r.name } as const]
		),
		...(base.derived === undefined ? [] : [{ kind: "derived", name: base.derived.name } as const])
	])
	return {
		construct: "mutableProbe",
		refused:
			target.kind === "roster"
				? "mutableClosed"
				: target.kind === "derived"
					? "mutableDerived"
					: undefined,
		text: (ids) => oneLine(`Sc.mutable(${ids(target.name)})`),
		judge: (env) => {
			switch (target.kind) {
				case "relation":
					return compiling(() =>
						probeSchema(env, [
							...Arr.map(unitToOpen(base, target.relation), (heading) =>
								statementValue({ kind: "unit", heading }, env)
							),
							mutableBuilder(got(env.relations, target.name))
						])
					)
				case "roster":
					return compiling(() => probeSchema(env, [mutableBuilder(got(env.rosters, target.name))]))
				case "derived":
					return compiling(() =>
						schema.extend(
							[env.schema],
							"Level",
							Rec.values(derivedRecord(env)),
							[mutableBuilder(derivedOf(env))],
							[]
						)
					)
			}
		}
	}
}

/** A relation or roster of the base, by its name. */
const memberOf = (env: Env, name: string): AnyRelation | AnyRoster =>
	env.rosters.get(name) ?? got(env.relations, name)

const derivedOf = (env: Env): AnyDerived =>
	Option.getOrThrowWith(
		Option.fromUndefinedOr(env.derived),
		() => new Error("the case has no derived relation")
	)

/** The extension's record of the derived relation, under its own name. */
const derivedRecord = (env: Env): Readonly<Record<string, AnyDerived>> => {
	const counts = derivedOf(env)
	return { [counts.name]: counts }
}
/**
 * A schema over relations of the base, a list with a mutable statement over one of them, a copy of one of them listed
 * beside it, or one planted fault: a relation of a declared name that differs from it, in the list or at a level above
 * it; a statement over a relation of a declared name that is not the one declared, a structural widening of it by one
 * field; a statement over a relation it does not declare; fin as a member.
 */
const schemaProbe = (d: Drawing, base: Base): Probe => {
	const declared = d.some(ordinaryOf(base))
	const other = Arr.filter(
		ordinaryOf(base),
		(r) =>
			!Arr.contains(
				Arr.map(declared, (x) => x.name),
				r.name
			)
	)
	const owner =
		base.family !== undefined && base.family.kind !== "tree" ? base.family.owner : undefined
	type Planted = {
		readonly fault: SchemaFault | undefined
		readonly members: ReadonlyArray<string>
		readonly copy: string | undefined
		readonly clash: string | undefined
		readonly above: boolean
		readonly rebound: string | undefined
		readonly mutable: string
		/** Whether the statements state the unit the mutable relation's key leads with, which opens it. */
		readonly unit: boolean
		readonly fin: string | undefined
	}
	const own = Arr.map(declared, (r) => r.name)
	const rosters = Arr.map(base.rosters, (r) => r.name)
	const first = declared[0].name
	const valid: Planted = {
		fault: undefined,
		members: [...rosters, ...own],
		copy: undefined,
		clash: undefined,
		above: false,
		rebound: undefined,
		mutable: first,
		unit: true,
		fin: undefined
	}
	/** The unit the mutable relation's key leads with: the heading over its first key field (unitsOver). */
	const heading = Option.getOrThrowWith(
		Arr.head(headingsOver([declared[0]])),
		() => new Error(`the heading ${declared[0].name}'s key leads with`)
	)
	const forms: Arr.NonEmptyReadonlyArray<Planted> = [
		valid,
		{ ...valid, fault: "mutableOutsideUnit", unit: false },
		{ ...valid, copy: first },
		{ ...valid, fault: "clashingRelation", clash: first },
		{ ...valid, fault: "clashingLevel", clash: first, above: true },
		{ ...valid, fault: "reboundStatement", rebound: first },
		...(Arr.isReadonlyArrayNonEmpty(other)
			? [{ ...valid, fault: "undeclaredStatementRelation", mutable: d.from(other).name } as const]
			: []),
		...(owner === undefined ? [] : [{ ...valid, fault: "finMember", fin: owner } as const])
	]
	const planted = d.from(forms)
	const clashText = (name: string) => `Sc.relation(${jsonText(name)}, { clash: Fi.Id }, ["clash"])`
	return {
		construct: "schemaProbe",
		refused: planted.fault,
		text: (ids) => {
			const listed = Arr.join(
				[
					...Arr.map(planted.members, ids),
					...(planted.copy === undefined
						? []
						: [
								`Sc.relation(${jsonText(planted.copy)}, ${ids(planted.copy)}.fields, ${ids(planted.copy)}.primaryKey)`
							]),
					...(planted.clash === undefined || planted.above ? [] : [clashText(planted.clash)]),
					...(planted.fin === undefined ? [] : [`Sc.fin(${ids(planted.fin)}, "n")`])
				],
				", "
			)
			const mutable =
				planted.rebound === undefined
					? ids(planted.mutable)
					: `Sc.relation(${jsonText(planted.rebound)}, { ...${ids(planted.rebound)}.fields, clash: Fi.Id }, ${ids(planted.rebound)}.primaryKey)`
			const unit = planted.unit ? `${statementSource({ kind: "unit", heading }, ids)}, ` : ""
			const root = `Sc.schema("P", [${listed}], [${unit}Sc.mutable(${mutable})])`
			return oneLine(
				planted.clash !== undefined && planted.above
					? `Sc.schema.extend([${root}], "Up", [${clashText(planted.clash)}], [])`
					: root
			)
		},
		judge: (env) => {
			const clashOf = (name: string) => relation(name, { clash: Id }, ["clash"], [])
			const descriptors = Rec.fromEntries(
				Arr.map(
					declared[0].fields,
					(f) => [f.name, fieldDescriptor(f, env.rosters, env.contracts)] as const
				)
			)
			const widened: Readonly<Record<string, FieldBase>> = { ...descriptors, clash: Id }
			const members = [
				...Arr.map(planted.members, (name) => memberOf(env, name)),
				...(planted.copy === undefined
					? []
					: [relationValue(declared[0], env.rosters, env.contracts)]),
				...(planted.clash === undefined || planted.above ? [] : [clashOf(planted.clash)])
			]
			const statements = [
				...(planted.unit ? [statementValue({ kind: "unit", heading }, env)] : []),
				mutableBuilder(
					planted.rebound === undefined
						? got(env.relations, planted.mutable)
						: relation(planted.rebound, widened, declared[0].key, [])
				)
			]
			const fin = planted.fin
			const clash = planted.clash
			return fin !== undefined
				? building(() =>
						admitSchema("P", [...members, finBuilder(got(env.relations, fin), "n")], statements, [])
					)
				: clash !== undefined && planted.above
					? compiling(() =>
							schema.extend([schema("P", members, statements, [])], "Up", [clashOf(clash)], [], [])
						)
					: compiling(() => schema("P", members, statements, []))
		}
	}
}

/**
 * A role over the base's top level: insert and write lists of ordinary relations, each closed one under insert and each
 * open one under write, or one planted fault: a whole entry outside the base, an insert list naming a roster or a
 * stranger.
 */
const roleProbe = (d: Drawing, base: Base): Probe => {
	const ordinary = ordinaryOf(base)
	type Planted = {
		readonly fault: SchemaFault | undefined
		readonly outside: boolean
		readonly insert: ReadonlyArray<string>
		readonly write: ReadonlyArray<string>
	}
	const valid: Planted = {
		fault: undefined,
		outside: false,
		...listsOf(d.some(ordinary), base.statements)
	}
	const forms: Arr.NonEmptyReadonlyArray<Planted> = [
		valid,
		{ ...valid, fault: "entryOutsideBase", outside: true, insert: [], write: [] },
		{ ...valid, fault: "writeRoster", insert: [d.from(base.rosters).name], write: [] },
		{ ...valid, fault: "writeStranger", insert: ["Nobody"], write: [] }
	]
	const planted = d.from(forms)
	const level = base.derived === undefined ? "S" : "Level"
	const lists = `{ insert: [${quoted(planted.insert)}], write: [${quoted(planted.write)}] }`
	return {
		construct: "roleProbe",
		refused: planted.fault,
		text: (ids) =>
			oneLine(
				planted.outside
					? `Sc.role(${ids("S")}, "probe", { ${ordinary[0].name}: ${ids(ordinary[0].name)}, Outside: Sc.relation("Outside", { id: Fi.Id }, ["id"]) })`
					: `Sc.role(${ids(level)}, "probe", { ${Arr.join(
							Arr.map(wholeEntries(base), (name) => `${name}: ${ids(name)}`),
							", "
						)} }, ${lists})`
			),
		judge: (env) =>
			building(() =>
				planted.outside
					? role(env.schema, "probe", {
							[ordinary[0].name]: got(env.relations, ordinary[0].name),
							Outside: relation("Outside", { id: Id }, ["id"], [])
						})
					: role(env.level, "probe", env.entries, {
							insert: planted.insert,
							write: planted.write
						})
			)
	}
}
/** What a derived probe plants: a definition's, a level's or a fin's fault. */
type DerivedFault = Extract<
	SchemaFault,
	| "parameterizedDefinition"
	| "derivedAtOwnLevel"
	| "derivedInRoot"
	| "finOverDerived"
	| "emptyHead"
	| "headingGroups"
	| "derivedOverBase"
>

/** A law a derived probe states over the base's aggregate, which both admit, each noted as its form (`lawForm`). */
type DerivedLaw = "keyOverDerived" | "checkOverDerived" | "selectOverDerived"

const derivedLaws: ReadonlyArray<DerivedLaw> = [
	"keyOverDerived",
	"checkOverDerived",
	"selectOverDerived"
]

const isDerivedLaw = (planted: DerivedFault | DerivedLaw): planted is DerivedLaw =>
	Arr.contains<DerivedFault | DerivedLaw>(derivedLaws, planted)

/** The form each law over the base's aggregate is noted as. */
const lawForm: { readonly [K in DerivedLaw]: SchemaForm } = {
	keyOverDerived: "derivedKeyed",
	checkOverDerived: "derivedChecked",
	selectOverDerived: "derivedSelectedKey"
}

/** The derived definitions a derived probe states that the engine admits, each noted as its form. */
type DerivedValid =
	| "overLevels"
	| "boundImport"
	| "discriminated"
	| "projection"
	| "skipsLevel"
	| "ruled"
	| "negated"

const validForm: { readonly [K in DerivedValid]: SchemaForm } = {
	overLevels: "derivedOverLevels",
	boundImport: "derivedBoundImport",
	discriminated: "derivedDiscriminated",
	projection: "derivedProjection",
	skipsLevel: "derivedSkipsLevel",
	ruled: "derivedRuled",
	negated: "derivedNegated"
}

/** The definition the derived relation's probes draw over: the base's derived spec's relation and field. */
const definitionSource = (
	spec: DerivedSpec,
	base: Base,
	ids: Ids,
	schemaId: string,
	parameter: boolean
): string => {
	const r = relationNamed(base.relations, spec.over)
	const extras = parameter ? [] : spec.extras
	const bound = Arr.dedupe([
		...r.key,
		spec.by,
		...Arr.flatMap(extras, (x) => (x.kind === "literal" ? [] : [x.field]))
	])
	const where = parameter
		? `.where(r.eq(${spec.by}, r.param("p", ${ids(spec.over)}.fields.${spec.by})))`
		: ""
	const head = Arr.join(
		[
			spec.by,
			"total: r.count()",
			...Arr.map(extras, (x) =>
				x.kind === "literal"
					? `${x.name}: Cp.Type.literal(Fi.int4, 1)`
					: `${x.name}: r.${x.kind}(${x.field})`
			)
		],
		", "
	)
	return `Q.query(${schemaId}).rule((r) => { const { ${Arr.join(bound, ", ")} } = Q.v(${ids(spec.over)}, "fact"); return r.match(${ids(spec.over)}, { ${Arr.join(bound, ", ")} })${where}.find({ ${head} }) })`
}

/**
 * Whether the base's derived relation, `spec`, aggregates across its relation's units: its relation in a declared unit,
 * the one over its key's first field that an open relation of that leading field and type declares (unitsOver, which
 * holds a closed relation leading alike too), and its groups by another field, so they do not hold the unit's. A probed
 * law over it is refused when its schema compiles, UnsupportedLawFamily, its remedy to group within a unit
 * (analysis/theory/query.ts refuseAggregatesAcrossUnits, lane NOSETTINGS's 37b7e030f2 and 51aa55e1f8), a rule no type
 * states.
 */
const aggregatesAcrossUnits = (base: Base, spec: DerivedSpec): boolean => {
	const r = relationNamed(base.relations, spec.over)
	const [unit] = headingsOver([r])
	return (
		unit !== undefined &&
		Arr.headNonEmpty(r.key) !== spec.by &&
		Arr.some(base.statements, (s) => s.kind === "unit" && s.heading.name === unit.name)
	)
}

/**
 * The derived relation's laws and levels: a definition reading a parameter, of no field, or of several heading groups;
 * a derived relation declared at the level its definition reads, or in a root schema; a key, check or selection over
 * the base's aggregate, which no rule reads; fin over it; each a planted fault. The admitted forms: a further derived
 * relation over the extension, declared above it, whose schema's levels are its own, the extension's and the root's; a
 * definition matching a query that reads a parameter, bound at each group value; a definition of two arms of one
 * heading, apart only in the handle a discriminant holds; a projection of its relation's key fields and group field,
 * which keeps the keys it inherits; rules over such a projection, a key, a check, a containment from a selection of
 * it and a mirrors with its relation, which both sides admit; and the same rules over a projection that negates, inside
 * a conjunction, a query of two rules, its relation joined with itself on the group field and its relation alone, which
 * both sides admit too. Each admitted definition's fact is the heading the engine compiles it to.
 */
const derivedProbe = (d: Drawing, base: Base): Probe | undefined => {
	const spec = base.derived
	if (spec === undefined) {
		return undefined
	}
	const r = relationNamed(base.relations, spec.over)
	const valid = d.from<DerivedValid>([
		"overLevels",
		"boundImport",
		"discriminated",
		"projection",
		"skipsLevel",
		"ruled",
		"negated"
	])
	const fault =
		d.upTo(3) === 0
			? undefined
			: d.from<DerivedFault | DerivedLaw>([
					"parameterizedDefinition",
					"derivedAtOwnLevel",
					"derivedInRoot",
					"keyOverDerived",
					"checkOverDerived",
					"selectOverDerived",
					"finOverDerived",
					"emptyHead",
					"headingGroups",
					"derivedOverBase"
				])
	if (fault === undefined) {
		d.note(validForm[valid])
	} else if (isDerivedLaw(fault)) {
		d.note(lawForm[fault])
	}
	const roster = d.from(base.rosters)
	const discriminants = [
		Arr.headNonEmpty(roster.handles),
		Arr.lastNonEmpty(roster.handles)
	] as const
	const bound = Arr.dedupe([...r.key, spec.by])
	const over = (ids: Ids) =>
		`Sc.derived("Over", Q.query(${ids("Level")}).rule((r) => { const { ${spec.by}, total } = Q.v(${ids(spec.name)}, "counted"); return r.match(${ids(spec.name)}, { ${spec.by}, total }).find({ ${spec.by}, total }) }))`
	const matched = (ids: Ids) =>
		`const { ${Arr.join(bound, ", ")} } = Q.v(${ids(r.name)}, "fact"); return r.match(${ids(r.name)}, { ${Arr.join(bound, ", ")} })`
	const keys = r.key
	const admittedText = (ids: Ids, own: string, env: Env): ProbeText => {
		const fact = (definition: QueryValue) =>
			`export type ${own}_fact = Expect<Equals<Sc.Fact<typeof ${own}>, ${objectType(compiledHeading(definition, ids))}>>`
		switch (valid) {
			case "overLevels":
				return {
					head: [],
					line: `export const ${own} = Sc.schema.extend([${ids("Level")}], "Over", [${over(ids)}], [])`,
					tail: [
						`export type ${own}_levels = Expect<Equals<Sc.LevelsOf<typeof ${own}>, typeof ${own} | typeof ${ids("Level")} | typeof ${ids("S")}>>`
					]
				}
			case "boundImport": {
				const renamed = Arr.join(
					Arr.map(keys, (k) => `${k}: ${k}_in`),
					", "
				)
				return {
					head: [
						`export const ${own}_imported = Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.where(r.eq(${spec.by}, r.param("p", ${ids(r.name)}.fields.${spec.by}))).find({ ${Arr.join(keys, ", ")} }) })`
					],
					line: `export const ${own} = Sc.derived("Probe", Q.query(${ids("S")}).rule((r) => { const { ${spec.by}: outer } = Q.v(${ids(r.name)}, "outer"); const source = ${own}_imported.bind({ p: outer }); const { ${renamed} } = Q.v(source, "inner"); return r.match(${ids(r.name)}, { ${spec.by}: outer }).match(source, { ${renamed} }).find({ ${spec.by}: outer, ${Arr.join(
						Arr.map(keys, (k) => `${k}_in`),
						", "
					)} }) }))`,
					tail: [fact(boundImportValue(env))]
				}
			}
			case "discriminated": {
				const armText = (handle: string) =>
					`.rule((r) => { ${matched(ids)}.find({ ${spec.by}, arm: ${ids(roster.name)}.handle(${jsonText(handle)}) }) })`
				return {
					head: [],
					line: `export const ${own} = Sc.derived("Probe", Q.query(${ids("S")})${armText(discriminants[0])}${armText(discriminants[1])})`,
					tail: [fact(discriminatedValue(env))]
				}
			}
			case "projection": {
				const level = `${own}_level`
				return {
					head: [],
					line: `export const ${own} = Sc.derived("Probe", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.find({ ${Arr.join(bound, ", ")} }) }))`,
					tail: [
						fact(projectionValue(env)),
						`export const ${level} = Sc.schema.extend([${ids("S")}], "ProbeLevel", [${own}], [])`,
						`export type ${own}_keys = Expect<Equals<Sc.KeysOf<typeof ${level}, typeof ${own}>, ${projectionKeys(env)}>>`
					]
				}
			}
			case "ruled": {
				const rel = `${own}_rel`
				const by = jsonText(spec.by)
				return {
					head: [
						`export const ${rel} = Sc.derived("Probe", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.find({ ${Arr.join(bound, ", ")} }) }))`
					],
					line: `export const ${own} = Sc.schema.extend([${ids("S")}], "Ruled", [${rel}], [Sc.key(Sc.on(${rel}, ${by})), Sc.check("Probe", ${rel}, (w) => w.and([])), Sc.contained(Sc.on(Sc.select(${rel}, (w) => w.and([])), ${by}), Sc.on(${ids(r.name)}, ${by})), Sc.mirrors(Sc.on(${ids(r.name)}, ${by}), Sc.on(${rel}, ${by}))])`,
					tail: []
				}
			}
			case "negated": {
				const rel = `${own}_rel`
				const negated = `${own}_negated`
				const by = jsonText(spec.by)
				const grouped = `const { ${spec.by} } = Q.v(${ids(r.name)}, "fact")`
				return {
					head: [
						`export const ${negated} = Q.query(${ids("S")}).rule((r) => { ${grouped}; return r.match(${ids(r.name)}, { ${spec.by} }).match(${ids(r.name)}, { ${spec.by} }).find({ ${spec.by} }) }).rule((r) => { ${grouped}; return r.match(${ids(r.name)}, { ${spec.by} }).find({ ${spec.by} }) })`,
						`export const ${rel} = Sc.derived("Probe", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.where(r.and([r.not(${negated}, { ${spec.by} })])).find({ ${Arr.join(bound, ", ")} }) }))`
					],
					line: `export const ${own} = Sc.schema.extend([${ids("S")}], "Ruled", [${rel}], [Sc.key(Sc.on(${rel}, ${by})), Sc.check("Probe", ${rel}, (w) => w.and([])), Sc.contained(Sc.on(Sc.select(${rel}, (w) => w.and([])), ${by}), Sc.on(${ids(r.name)}, ${by})), Sc.mirrors(Sc.on(${ids(r.name)}, ${by}), Sc.on(${rel}, ${by}))])`,
					tail: []
				}
			}
			case "skipsLevel":
				return {
					head: [],
					line: `export const ${own} = Sc.derived("Skip", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.find({ ${Arr.join(bound, ", ")} }) }))`,
					tail: [
						`export const ${own}_level = Sc.schema.extend([${ids("Level")}], "Skipping", [${own}], [])`,
						`export type ${own}_levels = Expect<Equals<Sc.LevelsOf<typeof ${own}_level>, typeof ${own}_level | typeof ${ids("Level")} | typeof ${ids("S")}>>`
					]
				}
		}
	}
	const text = (ids: Ids, own: string, env: Env): ProbeText => {
		switch (fault) {
			case undefined:
				return admittedText(ids, own, env)
			case "parameterizedDefinition":
				return oneLine(`Sc.derived("Probe", ${definitionSource(spec, base, ids, ids("S"), true)})`)
			case "derivedAtOwnLevel":
				return oneLine(`Sc.schema.extend([${ids("S")}], "Over", [${over(ids)}], [])`)
			case "derivedInRoot":
				return oneLine(`Sc.schema("Root", [${ids(spec.name)}], [])`)
			case "keyOverDerived":
				return oneLine(`Sc.key(Sc.on(${ids(spec.name)}, ${jsonText(spec.by)}))`)
			case "checkOverDerived":
				return oneLine(`Sc.check("Probe", ${ids(spec.name)}, (w) => w.and([]))`)
			case "selectOverDerived":
				return oneLine(
					`Sc.key(Sc.on(Sc.select(${ids(spec.name)}, (w) => w.and([])), ${jsonText(spec.by)}))`
				)
			case "finOverDerived":
				return oneLine(`Sc.fin(${ids(spec.name)}, "total")`)
			case "emptyHead":
				return oneLine(
					`Sc.derived("Probe", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.find({}) }))`
				)
			case "headingGroups":
				return oneLine(
					`Sc.derived("Probe", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.find({ ${spec.by}, arm: "one" }) }).rule((r) => { ${matched(ids)}.find({ ${spec.by}, arm: "two", flag: true }) }))`
				)
			case "derivedOverBase":
				return {
					head: [
						`export const ${own}_base = Q.query(${ids("S")}).rule((r) => {`,
						`	const { ${spec.by}, total } = Q.v(${ids(spec.name)}, "counted")`
					],
					line: `	return r.match(${ids(spec.name)}, { ${spec.by}, total }).find({ ${spec.by} })`,
					tail: ["})"]
				}
		}
	}
	const overValue = (env: Env, level: AnySchema) =>
		derivedBuilder(
			"Over",
			queryOver(level).rule((rule: RuleValue) => {
				const vars = varsOver(derivedOf(env), "counted")
				const head = { [spec.by]: vars[spec.by], total: vars["total"] }
				return rule.match(derivedOf(env), head).find(head)
			}),
			[]
		)
	/** A rule over the derived spec's relation, every key field and the group field bound, finding `head`. */
	const arm =
		(
			env: Env,
			head: (vars: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
		) =>
		(rule: RuleValue) => {
			const vars = varsOver(got(env.relations, r.name), "fact")
			return rule
				.match(
					got(env.relations, r.name),
					Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const))
				)
				.find(head(vars))
		}
	/** R's key fields where its group field is the parameter p: the query a bound import imports. */
	const importedValue = (env: Env): QueryValue =>
		queryOver(env.schema).rule((rule: RuleValue) => {
			const vars = varsOver(got(env.relations, r.name), "fact")
			return rule
				.match(
					got(env.relations, r.name),
					Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const))
				)
				.where(
					rule.eq(
						vars[spec.by],
						rule.param("p", fieldValue(fieldOf(r, spec.by).type, env.rosters, env.contracts))
					)
				)
				.find(Rec.fromEntries(Arr.map(keys, (k) => [k, vars[k]] as const)))
		})
	/** A definition matching the imported query bound at each group value R delivers: its parameter supplied. */
	const boundImportValue = (env: Env): QueryValue => {
		const imported = importedValue(env)
		return queryOver(env.schema).rule((rule: RuleValue) => {
			const outer = varsOver(got(env.relations, r.name), "outer")
			const source = imported.bind({ p: outer[spec.by] })
			const inner = varsOver(source, "inner")
			return rule
				.match(got(env.relations, r.name), { [spec.by]: outer[spec.by] })
				.match(source, Rec.fromEntries(Arr.map(keys, (k) => [k, inner[k]] as const)))
				.find({
					[spec.by]: outer[spec.by],
					...Rec.fromEntries(Arr.map(keys, (k) => [`${k}_in`, inner[k]] as const))
				})
		})
	}
	/** A projection of R's key fields and its group field: no aggregate, its keys the ones it inherits from R. */
	const projectionValue = (env: Env): QueryValue =>
		queryOver(env.schema).rule(
			arm(env, (vars) => Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const)))
		)
	/**
	 * The keys the projection inherits, as KeysOf states them: each minimal key of R the engine compiles the schema to
	 * (keysOf) that the projection delivers whole, so a fact of R is one row of it. A live derived relation stores
	 * nothing, so no derived analysis keys it; its type reads the keys its definition proves.
	 */
	const projectionKeys = (env: Env): string => {
		const compiled = Result.flatMap(
			catchCompileError(() =>
				schema.extend(
					[env.schema],
					"ProbeLevel",
					[derivedBuilder("Probe", projectionValue(env), [])],
					[],
					[]
				)
			),
			(level) => testArtifacts(level, testCompile)
		)
		if (!compiled.ok) {
			throw new Error(
				`the engine refuses a drawn projection, a defect of the generator: ${messageOf(compiled.error)}`
			)
		}
		const delivered = Arr.filter(keysOf(compiled.value, r.name), (k) =>
			Arr.every(k, (f) => Arr.contains(bound, f))
		)
		const minimal = Arr.filter(
			delivered,
			(k) =>
				!Arr.some(
					delivered,
					(other) => other.length < k.length && Arr.every(other, (f) => Arr.contains(k, f))
				)
		)
		const keys = Arr.map(minimal, (k) => `ReadonlyArray<${literalUnion(k)}>`)
		return Arr.isReadonlyArrayNonEmpty(keys) ? Arr.join(keys, " | ") : "never"
	}
	/**
	 * The projection of R's key fields and its group field whose group value no fact of a query of two rules holds,
	 * inside a conjunction: R joined with itself on the group field, and R alone.
	 */
	const negatedValue = (env: Env): QueryValue => {
		const own = got(env.relations, r.name)
		const grouped = (rule: RuleValue, vars: Readonly<Record<string, unknown>>) =>
			rule.match(own, { [spec.by]: vars[spec.by] })
		const negated = queryOver(env.schema)
			.rule((rule: RuleValue) => {
				const vars = varsOver(own, "fact")
				return grouped(rule, vars)
					.match(own, { [spec.by]: vars[spec.by] })
					.find({ [spec.by]: vars[spec.by] })
			})
			.rule((rule: RuleValue) => {
				const vars = varsOver(own, "fact")
				return grouped(rule, vars).find({ [spec.by]: vars[spec.by] })
			})
		return queryOver(env.schema).rule((rule: RuleValue) => {
			const vars = varsOver(own, "fact")
			return rule
				.match(own, Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const)))
				.where(rule.and([rule.not(negated, { [spec.by]: vars[spec.by] })]))
				.find(Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const)))
		})
	}
	/** Two arms of one heading, apart only in the handle their discriminant arm holds. */
	const discriminatedValue = (env: Env): QueryValue => {
		const handles = got(env.rosters, roster.name)
		return queryOver(env.schema)
			.rule(
				arm(env, (vars) => ({ [spec.by]: vars[spec.by], arm: handles.handle(discriminants[0]) }))
			)
			.rule(
				arm(env, (vars) => ({ [spec.by]: vars[spec.by], arm: handles.handle(discriminants[1]) }))
			)
	}
	const judge = (env: Env): Verdict => {
		const counts = derivedOf(env)
		const extended = (statement: Statement) =>
			compiling(() =>
				schema.extend([env.schema], "Level", Rec.values(derivedRecord(env)), [statement], [])
			)
		const probing = (definition: () => QueryValue) =>
			compiling(() =>
				schema.extend(
					[env.schema],
					"ProbeLevel",
					[derivedBuilder("Probe", definition(), [])],
					[],
					[]
				)
			)
		switch (fault) {
			case undefined:
				switch (valid) {
					case "overLevels":
						return compiling(() =>
							schema.extend([env.level], "Over", [overValue(env, env.level)], [], [])
						)
					case "boundImport":
						return probing(() => boundImportValue(env))
					case "discriminated":
						return probing(() => discriminatedValue(env))
					case "projection":
						return probing(() => projectionValue(env))
					case "skipsLevel":
						return compiling(() =>
							schema.extend(
								[env.level],
								"Skipping",
								[derivedBuilder("Skip", projectionValue(env), [])],
								[],
								[]
							)
						)
					case "ruled":
					case "negated": {
						const rel = derivedBuilder(
							"Probe",
							valid === "ruled" ? projectionValue(env) : negatedValue(env),
							[]
						)
						const own = got(env.relations, r.name)
						const row = (w: typeof rowHelpers) => w.and([])
						return compiling(() =>
							schema.extend(
								[env.schema],
								"Ruled",
								[rel],
								[
									keyBuilder(onBuilder(rel, [spec.by])),
									checkBuilder("Probe", rel, row),
									containedBuilder(
										onBuilder(selectBuilder(rel, row), [spec.by]),
										onBuilder(own, [spec.by])
									),
									mirrorsBuilder(onBuilder(own, [spec.by]), onBuilder(rel, [spec.by]))
								],
								[]
							)
						)
					}
				}
			case "parameterizedDefinition":
				return building(() => derivedBuilder("Probe", parameterizedDefinition(spec, base, env), []))
			case "derivedAtOwnLevel":
				return building(() =>
					schema.extend([env.schema], "Over", [overValue(env, env.level)], [], [])
				)
			case "derivedInRoot":
				return building(() => admitSchema("Root", { [spec.name]: counts }, [], []))
			case "keyOverDerived":
				return extended(keyBuilder(onBuilder(counts, [spec.by])))
			case "checkOverDerived":
				return extended(checkBuilder("Probe", counts, (w: typeof rowHelpers) => w.and([])))
			case "selectOverDerived":
				return extended(
					keyBuilder(
						onBuilder(
							selectBuilder(counts, (w: typeof rowHelpers) => w.and([])),
							[spec.by]
						)
					)
				)
			case "finOverDerived":
				return building(() => finBuilder(counts, "total"))
			case "emptyHead":
				return probing(() => queryOver(env.schema).rule(arm(env, () => ({}))))
			case "headingGroups":
				return probing(() =>
					queryOver(env.schema)
						.rule(arm(env, (vars) => ({ [spec.by]: vars[spec.by], arm: "one" })))
						.rule(arm(env, (vars) => ({ [spec.by]: vars[spec.by], arm: "two", flag: true })))
				)
			case "derivedOverBase":
				return querying(() =>
					queryOver(env.schema).rule((rule: RuleValue) => {
						const vars = varsOver(counts, "counted")
						return rule
							.match(counts, { [spec.by]: vars[spec.by], total: vars["total"] })
							.find({ [spec.by]: vars[spec.by] })
					})
				)
		}
	}
	return {
		construct: "derivedProbe",
		refused:
			fault === undefined
				? undefined
				: isDerivedLaw(fault)
					? aggregatesAcrossUnits(base, spec)
						? "aggregateAcrossUnits"
						: undefined
					: fault,
		text,
		judge
	}
}

/**
 * A law naming the derived relation on a drawn side, a containment's left side, its right side or a mirror, over its
 * group field and its relation's, which both admit: the base's derived relation aggregates, whose groups a rule reads
 * whether it is unit-local or not (analysis/theory/query.ts GroupedMatch), where they lie within its relation's units;
 * where they span them (`aggregatesAcrossUnits`) the declared class aggregateAcrossUnits, which the types accept and
 * the engine refuses. A rule over a derived relation that joins, selects and projects is the derived probe's admitted
 * `ruled` form.
 */
const derivedSideProbe = (d: Drawing, base: Base): Probe | undefined => {
	const spec = base.derived
	if (spec === undefined) {
		return undefined
	}
	const r = relationNamed(base.relations, spec.over)
	const side = d.from(derivedSides)
	d.note(sideForm[side])
	const text = (ids: Ids): ProbeText => {
		const counted = `Sc.on(${ids(spec.name)}, ${jsonText(spec.by)})`
		const own = `Sc.on(${ids(r.name)}, ${jsonText(spec.by)})`
		switch (side) {
			case "left":
				return oneLine(`Sc.contained(${counted}, ${own})`)
			case "right":
				return oneLine(`Sc.contained(${own}, ${counted})`)
			case "mirrors":
				return oneLine(`Sc.mirrors(${counted}, ${own})`)
		}
	}
	const statement = (env: Env): Statement => {
		const counted = onBuilder(derivedOf(env), [spec.by])
		const own = onBuilder(got(env.relations, r.name), [spec.by])
		switch (side) {
			case "left":
				return containedBuilder(counted, own)
			case "right":
				return containedBuilder(own, counted)
			case "mirrors":
				return mirrorsBuilder(counted, own)
		}
	}
	return {
		construct: "derivedProbe",
		refused: aggregatesAcrossUnits(base, spec) ? "aggregateAcrossUnits" : undefined,
		text,
		judge: (env) =>
			compiling(() =>
				schema.extend([env.schema], "Level", Rec.values(derivedRecord(env)), [statement(env)], [])
			)
	}
}

/** The derived definition with a filter reading a parameter, built as the engine reads it. */
const parameterizedDefinition = (spec: DerivedSpec, base: Base, env: Env) => {
	const r = relationNamed(base.relations, spec.over)
	const bound = Arr.dedupe([...r.key, spec.by])
	const field = fieldOf(r, spec.by)
	return queryOver(env.schema).rule((rule: RuleValue) => {
		const vars = varsOver(got(env.relations, spec.over), "fact")
		return rule
			.match(
				got(env.relations, spec.over),
				Rec.fromEntries(Arr.map(bound, (f) => [f, vars[f]] as const))
			)
			.where(
				rule.eq(vars[spec.by], rule.param("p", fieldValue(field.type, env.rosters, env.contracts)))
			)
			.find({ [spec.by]: vars[spec.by], total: rule.count() })
	})
}
/** Where a predicate reading a parameter stands: a row check, a selection, a contract's predicate. */
type PredicateSite = "check" | "select" | "contract"

/**
 * A row check, a selection or a domain predicate inside a rule, reading the rule's parameter, a planted fault, or
 * reading its row alone. The predicate compares the relation's key field.
 */
const predicateProbe = (d: Drawing, base: Base): Probe => {
	const r = d.from(ordinaryOf(base))
	const field = fieldOf(r, r.key[0])
	const site = d.from<PredicateSite>(["check", "select", "contract"])
	const parameter = d.upTo(1) === 1
	const faults: { readonly [P in PredicateSite]: SchemaFault } = {
		check: "parameterizedCheck",
		select: "parameterizedSelect",
		contract: "parameterizedContract"
	}
	const operand = (ids: Ids, self: string): string =>
		parameter ? `r.param("p", ${ids(r.name)}.fields.${field.name})` : self
	const statement = (ids: Ids): string => {
		switch (site) {
			case "check":
				return `Sc.check("Probe", ${ids(r.name)}, (row) => row.eq(row.${field.name}, ${operand(ids, `row.${field.name}`)}))`
			case "select":
				return `Sc.select(${ids(r.name)}, (row) => row.eq(row.${field.name}, ${operand(ids, `row.${field.name}`)}))`
			case "contract":
				return `Fi.domain<typeof Key>()("Probe", ${ids(r.name)}.fields.${field.name}, (x) => Cp.Logic.eq(x, ${operand(ids, "x")}))`
		}
	}
	return {
		construct: "predicateProbe",
		refused: parameter ? faults[site] : undefined,
		text: (ids) => ({
			head: [
				`Q.query(${ids("S")}).rule((r) => {`,
				`\tconst { ${field.name} } = Q.v(${ids(r.name)}, "fact")`
			],
			line: `\t${statement(ids)}`,
			tail: [`\treturn r.match(${ids(r.name)}, { ${field.name} }).find({ ${field.name} })`, "})"]
		}),
		judge: (env) => {
			const relationValue = got(env.relations, r.name)
			const descriptor = fieldValue(field.type, env.rosters, env.contracts)
			const made: Array<FieldBase> = []
			const built = building(() =>
				queryOver(env.schema).rule((rule: RuleValue) => {
					const vars = varsOver(relationValue, "fact")
					const other = (self: unknown) => (parameter ? rule.param("p", descriptor) : self)
					switch (site) {
						case "check":
							checkBuilder("Probe", relationValue, (row: Readonly<Record<string, unknown>>) =>
								rowHelpers.eq(row[field.name], other(row[field.name]))
							)
							break
						case "select":
							selectBuilder(relationValue, (row: Readonly<Record<string, unknown>>) =>
								rowHelpers.eq(row[field.name], other(row[field.name]))
							)
							break
						case "contract":
							made.push(
								admitContract("Probe", descriptor, [(x: unknown) => rowHelpers.eq(x, other(x))])
							)
							break
					}
					return rule
						.match(relationValue, { [field.name]: vars[field.name] })
						.find({ [field.name]: vars[field.name] })
				})
			)
			const [contract] = made
			return contract === undefined || built.kind === "refused"
				? built
				: compiling(() =>
						schema("P", [relation("Holder", { id: Id, x: contract }, ["id"], [])], [], [])
					)
		}
	}
}
/** A field type a literal probe's target may be, and its descriptor's spelling. */
const literalTargets = [
	"int4",
	"int8",
	"numeric",
	"bool",
	"closedId",
	"uuid",
	"text",
	"money"
] as const
type LiteralTarget = (typeof literalTargets)[number]

/** A JavaScript value a literal probe writes, by the kind its host type is. */
const literalValues = [
	"number",
	"bigint",
	"decimal",
	"boolean",
	"handle",
	"stranger",
	"uuid",
	"decimalValue",
	"moneyValue"
] as const
type LiteralValue = (typeof literalValues)[number]

/**
 * The literal values a probe draws at a target: every one, but at a numeric field no string other than an exact
 * decimal, since the types take every string to be one, a widening they keep and the engine's parse decides.
 */
const literalsAt = (t: LiteralTarget): Arr.NonEmptyReadonlyArray<LiteralValue> =>
	t === "numeric"
		? ["number", "bigint", "decimal", "boolean", "decimalValue", "moneyValue"]
		: literalValues

const targetType = (t: LiteralTarget, roster: string): FieldType => {
	switch (t) {
		case "int4":
		case "int8":
		case "bool":
		case "money":
			return { kind: "pg", spelling: t }
		case "numeric":
			return { kind: "numeric", precision: 7, scale: 2 }
		case "closedId":
			return { kind: "closedId", roster }
		case "uuid":
			return { kind: "uuid" }
		case "text":
			return { kind: "text", pattern: { source: "^.*$", flags: "su" } }
	}
}

/** A literal's source and its host value. */
const literalOf = (
	v: LiteralValue,
	roster: RosterSpec
): { readonly source: string; readonly value: unknown } => {
	switch (v) {
		case "number":
			return { source: "1", value: 1 }
		case "bigint":
			return { source: "1n", value: 1n }
		case "decimal":
			return { source: '"1.5"', value: "1.5" }
		case "boolean":
			return { source: "true", value: true }
		case "handle":
			return { source: jsonText(roster.handles[0]), value: roster.handles[0] }
		case "stranger":
			return { source: '"Z"', value: "Z" }
		case "uuid":
			return {
				source: '"00000000-0000-4000-8000-000000000001"',
				value: "00000000-0000-4000-8000-000000000001"
			}
		case "decimalValue":
			return { source: 'Fi.Numeric.of("1.5")', value: Numeric.of("1.5") }
		case "moneyValue":
			return { source: "Fi.Money.of(150n)", value: Money.of(150n) }
	}
}

/**
 * A literal compared with a field in a row check, a selection or a contract's predicate: a value of every host kind
 * at every field kind (literalsAt), the engine admitting it exactly where it is a literal of the field's type.
 */
const literalProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const target = d.from(literalTargets)
	const literal = literalOf(d.from(literalsAt(target)), roster)
	const type = targetType(target, roster.name)
	const site = d.from(["check", "select", "contract"] as const)
	return {
		construct: "literalProbe",
		refused: "literalKind",
		text: (ids, own) => {
			const field = fieldSource(type, ids)
			switch (site) {
				case "check":
				case "select":
					return {
						head: [
							`export const ${own}_lit = Sc.relation("Lit", { id: Fi.Id, f: ${field} }, ["id"])`
						],
						line:
							site === "check"
								? `export const ${own} = Sc.check("Probe", ${own}_lit, (row) => row.eq(row.f, ${literal.source}))`
								: `export const ${own} = Sc.select(${own}_lit, (row) => row.eq(row.f, ${literal.source}))`,
						tail: []
					}
				case "contract":
					return oneLine(
						`export const ${own} = Fi.domain<typeof Key>()("Probe", ${field}, (x) => Cp.Logic.eq(x, ${literal.source}))`
					)
			}
		},
		judge: (env) =>
			compiling(() => {
				const descriptor = fieldValue(type, env.rosters, env.contracts)
				const rosters = Rec.fromEntries([...env.rosters])
				const predicate = (row: Readonly<Record<string, unknown>>) =>
					rowHelpers.eq(row["f"], literal.value)
				switch (site) {
					case "check": {
						const lit = relation("Lit", { id: Id, f: descriptor }, ["id"], [])
						return schema(
							"P",
							[...Rec.values(rosters), lit],
							[checkBuilder("Probe", lit, predicate)],
							[]
						)
					}
					case "select": {
						const lit = relation("Lit", { id: Id, f: descriptor }, ["id"], [])
						return schema(
							"P",
							[...Rec.values(rosters), lit],
							[keyBuilder(onBuilder(selectBuilder(lit, predicate), ["id"]))],
							[]
						)
					}
					case "contract": {
						const probe = admitContract("Probe", descriptor, [
							(x: unknown) => rowHelpers.eq(x, literal.value)
						])
						const holder = relation("Holder", { id: Id, f: probe }, ["id"], [])
						return schema("P", [...Rec.values(rosters), holder], [], [])
					}
				}
			})
	}
}
/** A fold a family probe states: its monoid, the member's value type, its ends, a pair, and the fault it plants. */
type FoldFault =
	| "countedPair"
	| "monoidMismatch"
	| "endPlanes"
	| "finNotDrawn"
	| "concatCounted"
	| "concatHidden"
	| "contractEnd"

/** The contract a fold's end is declared at where it plants contractEnd: one over bigint, of its own name. */
const tallyName = "Tally"

/**
 * A family of its own with one fold: an owner O with its drawn count and the fold's ends, a member M with its group,
 * an ordered member's drawn index, the step's value and, over an ordered family, sometimes a (before, after) pair.
 * Valid, or with one planted fault: a counted family's fold naming the pair, a monoid over a value it does not combine,
 * an end of the wrong planes, a count field that is not drawn: the owner's key, or an accumulated natural; a concat
 * fold of text over its named (before, after) pair, over a counted family or with its pair hidden a planted fault.
 * A refined fold is a concat whose accumulators are of another pattern than its step's, which their domains judge;
 * contractEnd plants a sum's end of a contract over its bigint step, a type of its own.
 */
const familyProbe = (d: Drawing, base: Base): Probe => {
	const unordered = Arr.filter(base.rosters, (r) => r.order === "unordered")
	const drawn = d.from<
		FoldFault | "treeSideWritten" | "countedSide" | "concatFold" | "refinedFold" | undefined
	>([
		undefined,
		undefined,
		"concatFold",
		"refinedFold",
		"countedPair",
		"monoidMismatch",
		"endPlanes",
		"finNotDrawn",
		"concatCounted",
		"concatHidden",
		"contractEnd",
		"treeSideWritten",
		"countedSide"
	])
	const fault = drawn === "concatFold" || drawn === "refinedFold" ? undefined : drawn
	const refined = drawn === "refinedFold"
	if (fault === "treeSideWritten") {
		return treeProbe(d)
	}
	if (fault === "countedSide") {
		return countedSideProbe()
	}
	const order =
		fault === "countedPair" || fault === "concatCounted" || fault === "contractEnd"
			? "counted"
			: fault === "concatHidden" || drawn === "concatFold" || refined
				? "ordered"
				: d.from(["ordered", "counted"] as const)
	const monoid =
		fault === "countedPair" || fault === "contractEnd"
			? "sum"
			: fault === "concatCounted" || fault === "concatHidden" || drawn === "concatFold" || refined
				? "concat"
				: fault === "monoidMismatch"
					? Arr.isReadonlyArrayNonEmpty(unordered)
						? d.from(["sum", "or", "concat", "max"] as const)
						: d.from(["sum", "or", "concat"] as const)
					: fault === "endPlanes"
						? d.from(["sum", "twos"] as const)
						: order === "counted"
							? d.from(["count", "sum"] as const)
							: d.from(orderedMonoids)
	return foldProbe(d, base, { fault, refined, order, monoid })
}

/**
 * A family probe's fold: the fault it plants, none for a valid fold, whether its accumulators are of another pattern
 * than its step's, its family's order and its monoid.
 */
interface FoldPlan {
	readonly fault: FoldFault | undefined
	readonly refined: boolean
	readonly order: "ordered" | "counted"
	readonly monoid: MonoidName
}

/** The family probe of a fold as `plan` states it, over `base`'s rosters (familyProbe). */
const foldProbe = (d: Drawing, base: Base, { fault, refined, order, monoid }: FoldPlan): Probe => {
	const unordered = Arr.filter(base.rosters, (r) => r.order === "unordered")
	if (monoid === "concat" && fault === undefined && !refined) {
		d.note("concatFold")
	}
	if (refined) {
		d.note("refinedFold")
	}
	if (monoid === "concat" && fault === "monoidMismatch") {
		d.note("concatMismatch")
	}
	if (monoid === "max" && fault === "monoidMismatch") {
		d.note("unorderedMax")
	}
	/**
	 * The roster the fold's sets and closed ids are over: for a max, an unordered one where the fold plants the monoid's
	 * mismatch, since it has no order, and an ordered one otherwise.
	 */
	const roster =
		monoid === "max"
			? fault === "monoidMismatch" && Arr.isReadonlyArrayNonEmpty(unordered)
				? d.from(unordered)
				: d.from(orderedRosters(base.rosters))
			: d.from(base.rosters)
	const text: FieldType = { kind: "text", pattern: { source: "^[a-z]{0,16}$", flags: "u" } }
	const set: FieldType = { kind: "bits", roster: roster.name }
	const closedType: FieldType = { kind: "closedId", roster: roster.name }
	const sumType: FieldType = {
		kind: "pg",
		spelling:
			fault === "contractEnd"
				? "int8"
				: order === "counted"
					? "int4"
					: d.from(["int8", "int4"] as const)
	}
	/** An accumulator's type: the step's, a text of another pattern, or the planted contract. */
	const accumulatorOf = (t: FieldType): FieldType =>
		fault === "contractEnd"
			? { kind: "contract", name: tallyName }
			: refined && t.kind === "text"
				? { kind: "text", pattern: { source: "^[a-c]{0,32}$", flags: "u" } }
				: t
	/** An accumulator's start, the identity at its type: a branded contract's through its constructor. */
	const startOf = (t: FieldType, identity: Start): Start =>
		t.kind === "contract" && identity.kind === "bigint"
			? { kind: "branded", contract: t.name, value: identity.value }
			: identity
	const zero = (t: FieldType): Start =>
		t.kind === "text"
			? { kind: "text", value: "" }
			: t.kind === "pg" && t.spelling === "int4"
				? { kind: "integer", value: 0 }
				: { kind: "bigint", value: 0n }
	const noHandles: Start = { kind: "noHandles", roster: roster.name }
	const value: FieldType | undefined = (() => {
		switch (monoid) {
			case "concat":
				return fault === "monoidMismatch" ? { kind: "pg", spelling: "int8" } : text
			case "sum":
				return fault === "monoidMismatch" ? { kind: "pg", spelling: "float8" } : sumType
			case "count":
				return undefined
			case "or":
				return fault === "monoidMismatch" ? { kind: "pg", spelling: "int8" } : set
			case "twos":
				return set
			case "max":
				return closedType
		}
	})()
	const finOfAccumulated = fault === "finNotDrawn" && d.upTo(1) === 1
	if (fault === "finNotDrawn") {
		d.note(finOfAccumulated ? "finOfAccumulated" : "finOfKey")
	}
	const stepEnds: ReadonlyArray<readonly [FieldType, Start]> = (() => {
		if (fault === "finNotDrawn") {
			return finOfAccumulated ? [[{ kind: "natural" }, { kind: "bigint", value: 0n }]] : []
		}
		switch (monoid) {
			case "sum":
				return fault === "monoidMismatch"
					? [
							[
								{ kind: "pg", spelling: "float8" },
								{ kind: "integer", value: 0 }
							]
						]
					: fault === "endPlanes"
						? [
								[sumType, zero(sumType)],
								[sumType, zero(sumType)]
							]
						: [[sumType, zero(sumType)]]
			case "count":
				return [[{ kind: "natural" }, { kind: "bigint", value: 0n }]]
			case "or":
				return fault === "monoidMismatch"
					? [
							[
								{ kind: "pg", spelling: "int8" },
								{ kind: "bigint", value: 0n }
							]
						]
					: [[set, noHandles]]
			case "twos":
				return fault === "endPlanes"
					? [[set, noHandles]]
					: [
							[set, noHandles],
							[set, noHandles]
						]
			case "max":
				return [[closedType, { kind: "handle", roster: roster.name, handle: roster.handles[0] }]]
			case "concat":
				return [[text, { kind: "text", value: "" }]]
		}
	})()
	const ends = Arr.map(stepEnds, ([type, start]): readonly [FieldType, Start] => {
		const accumulator = accumulatorOf(type)
		return [accumulator, startOf(accumulator, start)]
	})
	const pair =
		value !== undefined &&
		((monoid === "sum" &&
			(fault === "countedPair" ||
				(fault === undefined && order === "ordered" && d.upTo(1) === 1))) ||
			(monoid === "concat" && fault !== "concatHidden" && fault !== "concatCounted"))
	const valueField: ReadonlyArray<FieldSpec> =
		value === undefined ? [] : [{ name: "v", type: value, writing: callerWriting }]
	const pairType = value === undefined ? undefined : accumulatorOf(value)
	const pairFields: ReadonlyArray<FieldSpec> =
		pair && pairType !== undefined
			? [
					{
						name: "before",
						type: pairType,
						writing: { kind: "accumulated", start: startOf(pairType, zero(value)) }
					},
					{
						name: "after",
						type: pairType,
						writing: { kind: "accumulated", start: startOf(pairType, zero(value)) }
					}
				]
			: []
	const endNames = Arr.map(ends, (_end, i) => `e${i}`)
	const owner: RelationSpec = {
		name: "O",
		fields: [
			{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "n", type: { kind: "natural" }, writing: { kind: "drawn" } },
			...Arr.map(ends, ([type, start], i) => ({
				name: `e${i}`,
				type,
				writing: { kind: "accumulated", start } as const
			}))
		],
		key: ["id"]
	}
	const member: RelationSpec = {
		name: "M",
		fields: [
			{ name: "g", type: { kind: "uuid" }, writing: callerWriting },
			order === "ordered"
				? { name: "at", type: { kind: "natural" }, writing: { kind: "drawn" } }
				: { name: "k", type: { kind: "pg", spelling: "int4" }, writing: callerWriting },
			...valueField,
			...pairFields
		],
		key: order === "ordered" ? ["g", "at"] : ["g", "k"]
	}
	const count = fault === "finNotDrawn" ? (finOfAccumulated ? "e0" : "id") : "n"
	const memberSide: SideSpec = { relation: "M", terms: order === "ordered" ? ["g", "at"] : ["g"] }
	const step: SideSpec = {
		relation: "M",
		terms: ["g", ...(value === undefined ? [] : ["v"]), ...(pair ? ["before", "after"] : [])]
	}
	const end: SideSpec = { relation: "O", terms: ["id", ...endNames] }
	const familySource = (mine: Ids) =>
		`Sc.${order}(${sideSource(memberSide, mine)}, Sc.fin(${mine("O")}, ${jsonText(count)}))`
	return {
		construct: "familyProbe",
		refused: fault,
		text: (ids, own) => {
			const mine = (name: string) =>
				name === "O" || name === "M" || name === tallyName ? `${own}_${name}` : ids(name)
			const declarations = [
				...(fault === "contractEnd"
					? [
							`export const ${own}_${tallyName} = Fi.domain<typeof Key>()(${jsonText(tallyName)}, Fi.int8)`
						]
					: []),
				`export const ${own}_O = ${relationSource(owner, mine, quoted(owner.key))}`,
				`export const ${own}_M = ${relationSource(member, mine, quoted(member.key))}`
			]
			return fault === "finNotDrawn"
				? { head: declarations, line: `export const ${own} = ${familySource(mine)}`, tail: [] }
				: {
						head: [...declarations, `export const ${own}_family = ${familySource(mine)}`],
						line: `export const ${own} = Sc.fold(${own}_family, Sc.Monoid.${monoid}, ${sideSource(step, mine)}, ${sideSource(end, mine)})`,
						tail: []
					}
		},
		judge: (env) =>
			compiling(() => {
				const contracts: ReadonlyMap<string, FieldBase> =
					fault === "contractEnd"
						? new Map<string, FieldBase>([
								...env.contracts,
								[tallyName, admitContract(tallyName, int8, [])]
							])
						: env.contracts
				const relations = new Map([
					["O", relationValue(owner, env.rosters, contracts)],
					["M", relationValue(member, env.rosters, contracts)]
				])
				const slots = finBuilder(got(relations, "O"), count)
				const family =
					order === "ordered"
						? orderedBuilder(sideValue(memberSide, relations), slots)
						: countedBuilder(sideValue(memberSide, relations), slots)
				const fold = foldBuilder(
					family,
					monoids[monoid],
					sideValue(step, relations),
					sideValue(end, relations)
				)
				return schema(
					"F",
					[
						...Rec.values(Rec.fromEntries([...env.rosters])),
						got(relations, "O"),
						got(relations, "M")
					],
					fault === "finNotDrawn" ? [family] : [family, fold],
					[]
				)
			})
	}
}
/**
 * A counted family whose second argument is its owner's key side, a planted fault: a family counts its members by its
 * owner's slots, fin(O, n), which the engine's counted core requires.
 */
const countedSideProbe = (): Probe => {
	const owner: RelationSpec = {
		name: "O",
		fields: [
			{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "n", type: { kind: "natural" }, writing: { kind: "drawn" } }
		],
		key: ["id"]
	}
	const member: RelationSpec = {
		name: "M",
		fields: [
			{ name: "g", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "k", type: { kind: "pg", spelling: "int4" }, writing: callerWriting }
		],
		key: ["g", "k"]
	}
	return {
		construct: "familyProbe",
		refused: "countedSide",
		text: (ids, own) => {
			const mine = (name: string) => (name === "O" || name === "M" ? `${own}_${name}` : ids(name))
			return {
				head: [
					`export const ${own}_O = ${relationSource(owner, mine, quoted(owner.key))}`,
					`export const ${own}_M = ${relationSource(member, mine, quoted(member.key))}`
				],
				line: `export const ${own} = Sc.counted(Sc.on(${own}_M, "g"), Sc.on(${own}_O, "id"))`,
				tail: []
			}
		},
		judge: (env) =>
			building(() =>
				countedBuilder(
					onBuilder(relationValue(member, env.rosters, env.contracts), ["g"]),
					onBuilder(relationValue(owner, env.rosters, env.contracts), ["id"])
				)
			)
	}
}

/**
 * A family whose member side is a selection of its member relation, a kept fault: counted and ordered of M's members in
 * fin(O, n), refused as a family's member side, every fact of its relation, before the side's terms are read; or the
 * tree of T over itself, whose side over a selection breaks the tree's own shape, on(T, parent, at).
 */
const selectedMemberProbe = (fault: KeptFault): Probe => {
	const drawnNatural = (name: string): FieldSpec => ({
		name,
		type: { kind: "natural" },
		writing: { kind: "drawn" }
	})
	const flag: FieldSpec = {
		name: "flag",
		type: { kind: "pg", spelling: "bool" },
		writing: callerWriting
	}
	const owner: RelationSpec = {
		name: "O",
		fields: [{ name: "id", type: { kind: "uuid" }, writing: callerWriting }, drawnNatural("n")],
		key: ["id"]
	}
	const member: RelationSpec = {
		name: "M",
		fields: [
			{ name: "g", type: { kind: "uuid" }, writing: callerWriting },
			{ name: "k", type: { kind: "pg", spelling: "int4" }, writing: callerWriting },
			drawnNatural("i"),
			flag
		],
		key: ["g", "k"]
	}
	const node: RelationSpec = {
		name: "T",
		fields: [
			{ name: "doc", type: { kind: "uuid" }, writing: callerWriting },
			drawnNatural("parent"),
			drawnNatural("at"),
			drawnNatural("children"),
			drawnNatural("start"),
			drawnNatural("end"),
			flag
		],
		key: ["doc", "start"]
	}
	const selected = (r: string): string => `Sc.select(${r}, (t) => t.eq(t.flag, true))`
	return {
		construct: "familyProbe",
		refused: fault,
		text: (ids, own) => {
			const mine = (name: string) =>
				name === "O" || name === "M" || name === "T" ? `${own}_${name}` : ids(name)
			const relations = fault === "selectedTree" ? [node] : [owner, member]
			return {
				head: Arr.map(
					relations,
					(r) => `export const ${own}_${r.name} = ${relationSource(r, mine, quoted(r.key))}`
				),
				line:
					fault === "selectedCounted"
						? `export const ${own} = Sc.counted(Sc.on(${selected(`${own}_M`)}, "g"), Sc.fin(${own}_O, "n"))`
						: fault === "selectedOrdered"
							? `export const ${own} = Sc.ordered(Sc.on(${selected(`${own}_M`)}, "g", "i"), Sc.fin(${own}_O, "n"))`
							: `export const ${own} = Sc.tree(Sc.on(${selected(`${own}_T`)}, "parent", "at"), Sc.fin(${own}_T, "children"), { root: ["doc"] })`,
				tail: []
			}
		},
		judge: (env) =>
			building(() => {
				const selection = (r: AnyRelation) =>
					selectBuilder(r, (row: Readonly<Record<string, unknown>>) =>
						rowHelpers.eq(row["flag"], true)
					)
				const o = relationValue(owner, env.rosters, env.contracts)
				const m = relationValue(member, env.rosters, env.contracts)
				const t = relationValue(node, env.rosters, env.contracts)
				switch (fault) {
					case "selectedCounted":
						return countedBuilder(onBuilder(selection(m), ["g"]), finBuilder(o, "n"))
					case "selectedOrdered":
						return orderedBuilder(onBuilder(selection(m), ["g", "i"]), finBuilder(o, "n"))
					case "selectedTree":
						return treeBuilder(
							onBuilder(selection(t), ["parent", "at"]),
							finBuilder(t, "children"),
							{ root: ["doc"] }
						)
				}
			})
	}
}

/**
 * A tree of its own: a node relation over itself keyed by its root field and its start, its side's parent and index
 * drawn, or, a planted fault, one of them its caller's integer.
 */
const treeProbe = (d: Drawing): Probe => {
	const written = d.from([undefined, "parent", "at"] as const)
	if (written !== undefined) {
		d.note(written === "parent" ? "treeParentWritten" : "treeIndexWritten")
	}
	const drawnField = (name: string): FieldSpec => ({
		name,
		type: { kind: "natural" },
		writing: { kind: "drawn" }
	})
	const sideField = (name: "parent" | "at"): FieldSpec =>
		name === written
			? { name, type: { kind: "pg", spelling: "int4" }, writing: callerWriting }
			: drawnField(name)
	const node: RelationSpec = {
		name: "T",
		fields: [
			{ name: "doc", type: { kind: "uuid" }, writing: callerWriting },
			sideField("parent"),
			sideField("at"),
			drawnField("children"),
			drawnField("start"),
			drawnField("end")
		],
		key: ["doc", "start"]
	}
	return {
		construct: "familyProbe",
		refused: written === undefined ? undefined : "treeSideWritten",
		text: (ids, own) => {
			const mine = (name: string) => (name === "T" ? `${own}_T` : ids(name))
			return {
				head: [`export const ${own}_T = ${relationSource(node, mine, quoted(node.key))}`],
				line: `export const ${own} = Sc.tree(Sc.on(${own}_T, "parent", "at"), Sc.fin(${own}_T, "children"), { root: ["doc"] })`,
				tail: []
			}
		},
		judge: (env) =>
			compiling(() => {
				const t = relationValue(node, env.rosters, env.contracts)
				return schema(
					"F",
					[t],
					[
						treeBuilder(onBuilder(t, ["parent", "at"]), finBuilder(t, "children"), {
							root: ["doc"]
						})
					],
					[]
				)
			})
	}
}

/** The field constructor a field probe calls, valid or with one planted fault. */
type FieldCall =
	| { readonly kind: "drawn"; readonly type: FieldType }
	| { readonly kind: "accumulated"; readonly type: FieldType | "drawn"; readonly start: Start }
	| { readonly kind: "contract"; readonly base: FieldType }
	| {
			readonly kind: "span"
			readonly endpoint: FieldType
			readonly width: "none" | "number" | "bigint"
	  }
	| { readonly kind: "numeric"; readonly arguments: 1 | 2 }
	| { readonly kind: "typmod"; readonly of: "numeric" | "vector"; readonly text: boolean }
	| { readonly kind: "lookAlike" }
	| { readonly kind: "crossSet"; readonly roster: RosterSpec }

/**
 * A plain object holding a uuid descriptor's own sql and column, which no builder made: every member a built descriptor
 * has but its brand, so the types refuse it and the engine refuses the value it never built.
 */
const lookAlikeSource = "{ sql: Fi.uuid.sql, column: Fi.uuid.column }"

const fieldCallSource = (call: FieldCall, ids: Ids): string => {
	switch (call.kind) {
		case "drawn":
			return `Fi.drawn(${fieldSource(call.type, ids)}${mintKeySource(call.type)})`
		case "accumulated":
			return call.type === "drawn"
				? `Fi.accumulated(Fi.drawn(Fi.natural), ${startSource(call.start, ids)})`
				: `Fi.accumulated(${fieldSource(call.type, ids)}, ${startSource(call.start, ids)}${mintKeySource(call.type)})`
		case "contract":
			return `Fi.domain<typeof Key>()("Probe", ${fieldSource(call.base, ids)})`
		case "span":
			return `Fi.range(${fieldSource(call.endpoint, ids)}${call.width === "none" ? "" : call.width === "number" ? ", 7" : ", 7n"})`
		case "numeric":
			return call.arguments === 1 ? "Fi.numeric(5)" : "Fi.numeric(5, 2)"
		case "typmod": {
			const first = (value: number) => (call.text ? jsonText(String(value)) : String(value))
			switch (call.of) {
				case "numeric":
					return `Fi.numeric(${first(18)}, 0)`
				case "vector":
					return `Fi.vector(${first(3)})`
			}
		}
		case "lookAlike":
			return `Sc.relation("LookAlike", { id: ${lookAlikeSource} }, ["id"])`
		case "crossSet":
			return `Fi.accumulated(Fi.bit(${ids(call.roster.name)}), Fi.Bit.of(Sc.closed.ordered("Other", [${quoted(call.roster.handles)}]), []))`
	}
}

const fieldCallValue = (call: FieldCall, env: Env): unknown => {
	switch (call.kind) {
		case "drawn": {
			const drawnOf: unknown = Reflect.apply(drawnField, undefined, [
				fieldValue(call.type, env.rosters, env.contracts),
				mintKeyValue(call.type)
			])
			return drawnOf
		}
		case "accumulated":
			return call.type === "drawn"
				? accumulatedField(
						drawnField(naturalDescriptor, []),
						startValue(call.start, env.rosters),
						[]
					)
				: accumulatedField(
						fieldValue(call.type, env.rosters, env.contracts),
						startValue(call.start, env.rosters),
						mintKeyValue(call.type)
					)
		case "contract":
			return admitContract("Probe", fieldValue(call.base, env.rosters, env.contracts), [])
		case "span":
			return call.width === "none"
				? spanDescriptor(fieldValue(call.endpoint, env.rosters, env.contracts))
				: spanDescriptor(
						fieldValue(call.endpoint, env.rosters, env.contracts),
						call.width === "number" ? 7 : 7n
					)
		case "numeric":
			return call.arguments === 1 ? Reflect.apply(numeric, undefined, [5]) : numeric(5, 2)
		case "typmod": {
			const first = (value: number): number | string => (call.text ? String(value) : value)
			switch (call.of) {
				case "numeric": {
					const typmodded: unknown = Reflect.apply(numeric, undefined, [first(18), 0])
					return typmodded
				}
				case "vector": {
					const dimensioned: unknown = Reflect.apply(vector, undefined, [first(3)])
					return dimensioned
				}
			}
		}
		case "crossSet":
			return accumulatedField(
				bit(got(env.rosters, call.roster.name)),
				bitsOf(closed("Other", call.roster.handles, "ordered", []), [], []),
				[]
			)
		case "lookAlike": {
			const made: unknown = Reflect.apply(relation, undefined, [
				"LookAlike",
				{ id: { sql: uuidDescriptor.sql, column: uuidDescriptor.column } },
				["id"],
				[]
			])
			return made
		}
	}
}

/**
 * A field constructor: drawn over a natural or another type, accumulated over a value type or a field of a writing of
 * its own, its start of its type or not, a contract over a value domain, a span over an integer endpoint
 * or another, its width of its endpoint's host type or not, numeric with its scale or without, a typmod of its type or
 * a text, a relation over a plain object shaped like a descriptor, which no builder made, and an accumulated set
 * starting at a set over another roster of the same spellings.
 */
const fieldProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	type Planted = { readonly fault: SchemaFault | undefined; readonly call: FieldCall }
	const forms: Arr.NonEmptyReadonlyArray<Planted> = [
		{ fault: undefined, call: { kind: "drawn", type: { kind: "natural" } } },
		{
			fault: "drawnUndrawable",
			call: {
				kind: "drawn",
				type: { kind: "pg", spelling: d.from(["int4", "int8"] as const) }
			}
		},
		{
			fault: undefined,
			call: {
				kind: "accumulated",
				type: { kind: "pg", spelling: "int8" },
				start: { kind: "bigint", value: 0n }
			}
		},
		{
			fault: undefined,
			call: {
				kind: "accumulated",
				type: { kind: "closedId", roster: roster.name },
				start: { kind: "handle", roster: roster.name, handle: roster.handles[0] }
			}
		},
		{
			fault: "accumulatedWriting",
			call: { kind: "accumulated", type: "drawn", start: { kind: "bigint", value: 0n } }
		},
		{
			fault: "accumulatedStart",
			call: {
				kind: "accumulated",
				type: { kind: "pg", spelling: "int8" },
				start: { kind: "integer", value: 0 }
			}
		},
		{
			fault: "accumulatedStart",
			call: {
				kind: "accumulated",
				type: { kind: "pg", spelling: "int4" },
				start: { kind: "bigint", value: 0n }
			}
		},
		{
			fault: undefined,
			call: {
				kind: "contract",
				base: d.from<FieldType>([
					{ kind: "pg", spelling: "int8" },
					{ kind: "uuid" },
					{ kind: "closedId", roster: roster.name }
				])
			}
		},
		{
			fault: undefined,
			call: {
				kind: "span",
				endpoint: { kind: "pg", spelling: d.from(endpointSpellings) },
				width: "none"
			}
		},
		{
			fault: undefined,
			call: { kind: "span", endpoint: { kind: "pg", spelling: "int4" }, width: "number" }
		},
		{
			fault: undefined,
			call: { kind: "span", endpoint: { kind: "pg", spelling: "int8" }, width: "bigint" }
		},
		{
			fault: "endpointType",
			call: {
				kind: "span",
				endpoint: d.from<FieldType>([
					{ kind: "pg", spelling: "int2" },
					{ kind: "pg", spelling: "money" },
					{ kind: "numeric", precision: 10, scale: 0 }
				]),
				width: "none"
			}
		},
		{
			fault: "widthType",
			call: { kind: "span", endpoint: { kind: "pg", spelling: "int4" }, width: "bigint" }
		},
		{
			fault: "widthType",
			call: { kind: "span", endpoint: { kind: "pg", spelling: "int8" }, width: "number" }
		},
		{ fault: undefined, call: { kind: "numeric", arguments: 2 } },
		{ fault: "numericArity", call: { kind: "numeric", arguments: 1 } },
		{
			fault: undefined,
			call: { kind: "typmod", of: d.from(["numeric", "vector"] as const), text: false }
		},
		{
			fault: "argumentKind",
			call: { kind: "typmod", of: d.from(["numeric", "vector"] as const), text: true }
		},
		{ fault: "lookAlikeDescriptor", call: { kind: "lookAlike" } },
		{ fault: "crossSet", call: { kind: "crossSet", roster } }
	]
	const fault = d.from(Arr.dedupe(Arr.map(forms, (f) => f.fault)))
	const ofFault = Arr.filter(forms, (f) => f.fault === fault)
	const planted = d.from(Arr.isReadonlyArrayNonEmpty(ofFault) ? ofFault : forms)
	return {
		construct: "fieldProbe",
		refused: planted.fault,
		text: (ids, own) => oneLine(`export const ${own} = ${fieldCallSource(planted.call, ids)}`),
		judge: (env) => building(() => fieldCallValue(planted.call, env))
	}
}

/** How a closed relation probe states its relation: valid, its first row repeated, or with one planted fault. */
type ClosedRelationForm =
	| "valid"
	| "repeatedRow"
	| "rowMissingField"
	| "conflictingRow"
	| "closedKeyNotClosed"
	| "closedFifthArgument"

/**
 * A closed relation over a roster's handles, a row for each, keyed by its closed id k and holding a payload v; valid,
 * its first row stated twice, which is one row; or a planted fault: a row leaving v out, a second row at the first's
 * key with another v, a key naming v, a fifth argument.
 */
const closedRelationProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const form = d.from<ClosedRelationForm>([
		"valid",
		"repeatedRow",
		"rowMissingField",
		"conflictingRow",
		"closedKeyNotClosed",
		"closedFifthArgument"
	])
	if (form === "repeatedRow") {
		d.note("closedRepeatedRow")
	}
	const value = d.from<readonly [FieldType, string, unknown, string, unknown]>([
		[{ kind: "pg", spelling: "int4" }, "1", 1, "2", 2],
		[{ kind: "pg", spelling: "int8" }, "1n", 1n, "2n", 2n],
		[{ kind: "text", pattern: { source: "^.*$", flags: "su" } }, '"a"', "a", '"b"', "b"]
	])
	const [payload, source, host, otherSource, otherHost] = value
	const type = payload
	const first = Arr.headNonEmpty(roster.handles)
	type Row = readonly [string, "missing" | "value" | "other"]
	const rows: ReadonlyArray<Row> = [
		...Arr.map(roster.handles, (h, i): Row => [
			h,
			form === "rowMissingField" && i === 0 ? "missing" : "value"
		]),
		...(form === "repeatedRow" ? [[first, "value"] as const] : []),
		...(form === "conflictingRow" ? [[first, "other"] as const] : [])
	]
	const fault: SchemaFault | undefined =
		form === "valid" || form === "repeatedRow" ? undefined : form
	return {
		construct: "closedRelationProbe",
		refused: fault,
		text: (ids, own) => {
			const cell = (state: Row[1]): string => {
				switch (state) {
					case "missing":
						return ""
					case "value":
						return `, v: ${source}`
					case "other":
						return `, v: ${otherSource}`
				}
			}
			const stated = Arr.join(
				Arr.map(rows, ([h, state]) => `{ k: ${jsonText(h)}${cell(state)} }`),
				", "
			)
			const key = form === "closedKeyNotClosed" ? '["v"]' : '["k"]'
			const fifth = form === "closedFifthArgument" ? ', { pack: "hex" } as const' : ""
			return {
				head: [],
				line: `export const ${own} = Sc.closed.relation("Probe", { k: Fi.closedId(${ids(roster.name)}), v: ${fieldSource(type, ids)} }, ${key}, [${stated}]${fifth})`,
				tail: []
			}
		},
		judge: (env) =>
			building(() => {
				const valueOf = (state: Row[1]) => {
					switch (state) {
						case "missing":
							return {}
						case "value":
							return { v: host }
						case "other":
							return { v: otherHost }
					}
				}
				return admitClosedRelation(
					"Probe",
					{
						k: closedId(got(env.rosters, roster.name)),
						v: fieldValue(type, env.rosters, env.contracts)
					},
					form === "closedKeyNotClosed" ? ["v"] : ["k"],
					Arr.map(rows, ([h, state]) => ({ k: h, ...valueOf(state) })),
					form === "closedFifthArgument" ? [{ pack: "hex" }] : []
				)
			})
	}
}

/** The names a base's TypeScript declares beside its relations: its schema, its extension, its statements. */
const statementId = (i: number): string => `s${i}`

/** A base's statements as the program writes them, each its own export so a type may name it. */
const statementSource = (s: StatementSpec, ids: Ids): string => {
	switch (s.kind) {
		case "key":
			return `Sc.key(${lawSideSource(s.side, ids)})`
		case "contained":
		case "mirrors":
			return `Sc.${s.kind}(${lawSideSource(s.left, ids)}, ${lawSideSource(s.right, ids)})`
		case "mutable":
			return `Sc.mutable(${ids(s.relation)})`
		case "unit":
			return `Sc.unit(${jsonText(s.heading.name)}, { ${s.heading.field}: ${fieldSource(s.heading.type, ids)} })`
	}
}

const familySources = (f: FamilySpec, ids: Ids): ReadonlyArray<readonly [string, string]> => {
	switch (f.kind) {
		case "tree":
			return [
				[
					"family",
					`Sc.tree(${sideSource(f.member, ids)}, ${ids("slots")}, { root: ${jsonText(f.root)} })`
				]
			]
		case "ordered":
		case "counted":
			return [
				["family", `Sc.${f.kind}(${sideSource(f.member, ids)}, ${ids("slots")})`],
				...Arr.map(
					f.folds,
					(fold, i) =>
						[
							`fold${i}`,
							`Sc.fold(${ids("family")}, Sc.Monoid.${fold.monoid}, ${sideSource(fold.step, ids)}, ${sideSource(fold.end, ids)})`
						] as const
				)
			]
	}
}

/**
 * Rule, the base's closed relation, a row at every key; Gen beside it when drawn; and a read of each kind, C.at at a
 * full key and C.row at a key prefix, declared so their types may be named.
 */
const closedDeclarations = (c: ClosedSpec, ids: Ids): ReadonlyArray<readonly [string, string]> => {
	const names = closedKeyNames(c)
	const [payload] = payloadValue(c.payload)
	const rows = Arr.map(
		closedKeys(c),
		(k) =>
			`{ ${Arr.join(
				Arr.zipWith(names, k, (name, h) => `${name}: ${jsonText(h)}`),
				", "
			)}, w: 1, x: ${payload} }`
	)
	const idFields = Arr.join(
		Arr.zipWith(names, c.key, (name, r) => `${name}: Fi.closedId(${ids(r.name)})`),
		", "
	)
	const first = Arr.map(c.key, (r) => jsonText(Arr.headNonEmpty(r.handles)))
	return [
		[
			"Rule",
			`Sc.closed.relation("Rule", { ${idFields}, w: Fi.int4, x: ${fieldSource(payloadType(c.payload), ids)} }, [${quoted(names)}], [${Arr.join(rows, ", ")}])`
		],
		...(c.generated
			? [
					[
						"Gen",
						`Sc.relation.generated("Gen", { id: Fi.Id, ${idFields}, depth: Fi.int4 }, ["id"], (r) => ({ weight: Fi.generated(Fi.int4, ${ids("Rule")}.at("w", ${Arr.join(
							Arr.map(names, (name) => `r.${name}`),
							", "
						)})), flags: Fi.generated(Fi.bit(${ids(Arr.lastNonEmpty(c.key).name)}), ${ids("Rule")}.row(${Arr.join(
							Arr.map(Arr.initNonEmpty(names), (name) => `r.${name}`),
							", "
						)})), next: Fi.generated(Fi.int8, Cp.Type.cast(Cp.Num.add(r.depth, 1), Fi.int8)) }))`
					] as const
				]
			: []),
		["at", `${ids("Rule")}.at("w", ${Arr.join(first, ", ")})`],
		["xat", `${ids("Rule")}.at("x", ${Arr.join(first, ", ")})`],
		["row", `${ids("Rule")}.row(${Arr.join(Arr.initNonEmpty(first), ", ")})`]
	]
}

/** The fin a family's statement reads, declared on its own so its type may be named. */
const slotsSource = (f: FamilySpec, ids: Ids): string =>
	`Sc.fin(${ids(f.kind === "tree" ? f.relation : f.owner)}, ${jsonText(f.count)})`

/** A base's statements, each under its name, in the order its schema states them. */
const baseStatements = (base: Base, ids: Ids): ReadonlyArray<readonly [string, string]> => [
	...Arr.map(base.statements, (s, i) => [statementId(i), statementSource(s, ids)] as const),
	...(base.family === undefined ? [] : familySources(base.family, ids))
]

/** Every declaration of a base, in order: rosters, contracts, relations, statements, the schema, its extension and roles. */
const baseDeclarations = (base: Base, ids: Ids): ReadonlyArray<readonly [string, string]> => {
	const statements = baseStatements(base, ids)
	const members = [
		...Arr.map(base.rosters, (r) => r.name),
		...Arr.map(base.relations, (r) => r.name),
		...(base.closedRelation === undefined
			? []
			: ["Rule", ...(base.closedRelation.generated ? ["Gen"] : [])])
	]
	const level = base.derived === undefined ? "S" : "Level"
	return [
		...Arr.map(
			base.rosters,
			(r) => [r.name, `Sc.closed.${r.order}(${jsonText(r.name)}, [${quoted(r.handles)}])`] as const
		),
		...Arr.map(
			base.contracts,
			(c) =>
				[
					c.name,
					`Fi.domain<${keyText(c.name)}>()(${jsonText(c.name)}, ${fieldSource(c.base, ids)})`
				] as const
		),
		...Arr.map(base.relations, (r) => [r.name, relationSource(r, ids, quoted(r.key))] as const),
		...(base.closedRelation === undefined ? [] : closedDeclarations(base.closedRelation, ids)),
		...(base.family === undefined ? [] : [["slots", slotsSource(base.family, ids)] as const]),
		...statements,
		[
			"S",
			`Sc.schema("S", [${Arr.join(Arr.map(members, ids), ", ")}], [${Arr.join(
				Arr.map(statements, ([name]) => ids(name)),
				", "
			)}])`
		],
		...(base.derived === undefined
			? []
			: [
					[
						base.derived.name,
						`Sc.derived(${jsonText(base.derived.name)}, ${definitionSource(base.derived, base, ids, ids("S"), false)})`
					] as const,
					[
						"Level",
						`Sc.schema.extend([${ids("S")}], "Level", [${ids(base.derived.name)}], [])`
					] as const
				]),
		...Arr.map(base.roles, (r) => {
			const entries = `{ ${Arr.join(
				Arr.map(wholeEntries(base), (name) => `${name}: ${ids(name)}`),
				", "
			)} }`
			return [
				`role_${r.name}`,
				Arr.isReadonlyArrayNonEmpty(r.insert) || Arr.isReadonlyArrayNonEmpty(r.write)
					? `Sc.role(${ids(level)}, ${jsonText(r.name)}, ${entries}, { insert: [${quoted(r.insert)}], write: [${quoted(r.write)}] })`
					: `Sc.role(${ids(level)}, ${jsonText(r.name)}, ${entries})`
			] as const
		})
	]
}

/**
 * The whole entries a role holds: every roster and ordinary relation of the level, each under its own name; a closed
 * relation is no role's entry, and a live derived relation none, which a role reads through what its definition reads.
 */
const wholeEntries = (base: Base): ReadonlyArray<string> => [
	...Arr.map(base.rosters, (r) => r.name),
	...Arr.map(base.relations, (r) => r.name),
	...(base.closedRelation?.generated === true ? ["Gen"] : [])
]
/** A term of a law side as a side's tuple type writes it: a field's name, or pred of a natural field. */
const termType = (t: TermDesc): string =>
	t.kind === "field" ? jsonText(t.field) : `St.Pred<${jsonText(t.field)}>`

/** A law side as its type: its source, a relation or a selection of one, and its terms in order. */
const sideType = (side: SideDesc, ids: Ids): string =>
	`St.Side<${side.selection.conjuncts.length === 0 ? `typeof ${ids(side.relation)}` : `St.Selection<typeof ${ids(side.relation)}>`}, readonly [${Arr.join(Arr.map(side.terms, termType), ", ")}]>`

/**
 * A statement as its type, read off the engine's Description of it (ir/desc.ts StatementDesc): what it names, each
 * as the value the case declares under that name, so the schema's captured tuple reads back as the engine states it.
 * A fold names its family by `family`, the one family a case declares.
 */
const statementType = (desc: StatementDesc, base: Base, ids: Ids): string => {
	switch (desc.kind) {
		case "key":
			return `St.Key<${sideType(desc.side, ids)}>`
		case "mutable":
			return `St.Mutable<typeof ${ids(desc.relation)}>`
		case "race":
			return `St.Race<typeof ${ids(desc.relation)}>`
		case "check":
			return `St.Check<${jsonText(desc.name)}, typeof ${ids(desc.relation)}>`
		case "contained":
			return `St.Containment<${sideType(desc.left, ids)}, ${sideType(desc.right, ids)}>`
		case "family": {
			const fin = `St.Fin<typeof ${ids(desc.slots.owner)}, ${jsonText(desc.slots.count)}>`
			return `St.${desc.order === "ordered" ? "OrderedFamily" : "Counted"}<${sideType(desc.member, ids)}, ${fin}>`
		}
		case "tree":
			return `St.Tree<${sideType(desc.member, ids)}, St.Fin<typeof ${ids(desc.slots.owner)}, ${jsonText(desc.slots.count)}>, readonly [${Arr.join(Arr.map(desc.root, jsonText), ", ")}]>`
		case "fold":
			return `St.Fold<typeof ${ids("family")}, typeof Sc.Monoid.${desc.monoid}, ${sideType(desc.step, ids)}, ${sideType(desc.end, ids)}>`
		case "unit":
			return `St.Unit<${jsonText(desc.name)}, ${objectType(
				Arr.map(desc.heading, (f) => [f.field, valueDescriptorType(f.type, base, ids)] as const)
			)}, ${desc.sealed ? "true" : "false"}>`
		case "series":
			return `St.Series<typeof ${ids(desc.relation)}>`
	}
}

/**
 * A statement as the engine describes it: its Description, or, for a mirrors, the two containments it is sugar for
 * (schema/statements.ts ExpansionDesc), which no Description of its own states.
 */
type StatementView =
	| { readonly kind: "statement"; readonly desc: StatementDesc }
	| { readonly kind: "mirrors"; readonly expansion: ExpansionDesc }

const statementView = (value: Statement): StatementView => {
	const desc = statementDescOf(value)
	if (desc !== undefined) {
		return { kind: "statement", desc }
	}
	return {
		kind: "mirrors",
		expansion: Option.getOrThrowWith(
			Option.fromUndefinedOr(expansionDescOf(value)),
			() => new Error("a statement the engine owns, or a mirrors it expands")
		)
	}
}

/** A statement view as its type: a mirrors over its first containment's two sides. */
const viewType = (view: StatementView, base: Base, ids: Ids): string => {
	switch (view.kind) {
		case "statement":
			return statementType(view.desc, base, ids)
		case "mirrors": {
			const [forward] = view.expansion.statements
			return `St.Mirrors<${sideType(forward.left, ids)}, ${sideType(forward.right, ids)}>`
		}
	}
}

/**
 * The containments a schema states, as the engine reads them: each containment, each mirrors' two, and each series'.
 */
const containmentTypes = (
	views: ReadonlyArray<StatementView>,
	base: Base,
	ids: Ids
): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(views, (view) => {
			if (view.kind === "mirrors") {
				return Arr.map(view.expansion.statements, (c) => statementType(c, base, ids))
			}
			const s = view.desc
			switch (s.kind) {
				case "contained":
					return [statementType(s, base, ids)]
				case "series":
					return [statementType(expandSeries(s), base, ids)]
				case "key":
				case "mutable":
				case "race":
				case "check":
				case "family":
				case "tree":
				case "fold":
				case "unit":
					return []
			}
		})
	)

/** A field's descriptor as its type: what the engine's Description of it (desc, writing) makes it. */
const descriptorType = (decl: FieldDecl, base: Base, ids: Ids): string => {
	switch (decl.writing.kind) {
		case "drawn":
			return "Fi.DrawnField"
		case "place":
			return "Fi.PlaceField"
		case "accumulated":
			return `Fi.AccumulatedField<${valueDescriptorType(decl.type, base, ids)}>`
		case "instant":
			return "Fi.InstantField"
		case "caller":
		case "generated":
			return valueDescriptorType(decl.type, base, ids)
	}
}

/** The SQL type a pg descriptor's Description names. */
const sqlOfDesc = (desc: FieldDesc): string => (desc.kind === "pg" ? desc.type : desc.kind)

const valueDescriptorType = (desc: FieldDesc, base: Base, ids: Ids): string => {
	switch (desc.kind) {
		case "pg":
			return pgDescriptorType[desc.type]
		case "numeric":
			return `Fi.NumericTypmodField<${numericHost(desc)}>`
		case "exact":
			return desc.carrier === "exactInteger" ? "Fi.ExactIntegerField" : "Fi.ExactMoneyField"
		case "computedNumeric":
			return "Fi.NumericBoundField"
		case "uuid":
			return 'Fi.Field<Fi.Uuid, "uuid">'
		case "sha256":
		case "bytes":
			return "Fi.ByteaField"
		case "text":
			return `Tx.RegexText<${hostOfDesc(desc, base, ids)}>`
		case "pattern":
			return "Fi.PatternField"
		case "domain": {
			if (builtinDesc(desc)) {
				return desc.base.kind === "pg" && desc.base.type === "date"
					? "Fi.DateField"
					: "Fi.NaturalField"
			}
			return `Fi.Domain<${jsonText(desc.name)}, ${valueDescriptorType(desc.base, base, ids)}, ${keyText(desc.name)}>`
		}
		case "span":
			return `Fi.RangeField<${hostOfDesc(desc.endpoint, base, ids)}, Ph.DomainOf<${valueDescriptorType(desc.endpoint, base, ids)}>>`
		case "closedId":
			return `Fi.ClosedIdField<typeof ${ids(desc.roster)}>`
		case "bits":
			return `Fi.BitField<typeof ${ids(desc.roster)}>`
		case "vector":
			return `Fi.VectorField<${desc.dimensions}>`
		case "search":
			return `Fi.SearchDocumentField<${jsonText(desc.configuration)}>`
		case "variant":
			throw new Error("no agreement schema declares a variant field")
	}
}

/**
 * The literal a field's comparison takes, as the engine admits one (scalar/literal.ts literalDescFor): its base's host
 * value, a contract's literal its base's, and a numeric's a Numeric, a bigint or an exact decimal string, at scale 0 a
 * bigint alone, its host (types/fields LiteralOf). A vector's, a buffer of its dimensions, has a type the public
 * barrels do not name, so a vector field's is not asserted.
 */
const literalType = (
	desc: Exclude<FieldDesc, { readonly kind: "vector" }>,
	base: Base,
	ids: Ids
): string => {
	switch (desc.kind) {
		case "domain":
			return desc.base.kind === "vector"
				? hostOfDesc(desc, base, ids)
				: literalType(desc.base, base, ids)
		case "numeric":
			return desc.scale === 0 ? "bigint" : "Fi.Numeric | bigint | string"
		case "computedNumeric":
			return "Fi.Numeric | bigint | string"
		case "bits":
			return `ReadonlySet<${literalUnion(rosterNamed(base, desc.roster).handles)}>`
		case "pg":
			return pgLiteral[desc.type]
		case "variant":
		case "exact":
		case "bytes":
		case "sha256":
		case "uuid":
		case "text":
		case "pattern":
		case "span":
		case "closedId":
		case "search":
			return hostOfDesc(desc, base, ids)
	}
}

/** The literal a pg type's comparison takes: its host value, and numeric's a Numeric, a bigint or an exact decimal string. */
const pgLiteral: { readonly [T in Extract<FieldDesc, { readonly kind: "pg" }>["type"]]: string } = {
	int2: "number",
	int4: "number",
	float4: "number",
	float8: "number",
	int8: "bigint",
	numeric: "Fi.Numeric | bigint | string",
	money: "Fi.Money",
	bool: "boolean",
	date: "Fi.CalendarDate",
	inet: "Fi.Inet",
	cidr: "Fi.Cidr"
}

/**
 * The descriptor type of each pg type: a Field of its host and its SQL tag, and numeric of no typmod's NumericField,
 * the descriptor that is also numeric(p, s)'s call.
 */
const pgDescriptorType: {
	readonly [T in Extract<FieldDesc, { readonly kind: "pg" }>["type"]]: string
} = {
	int2: 'Fi.Field<number, "int2">',
	int4: 'Fi.Field<number, "int4">',
	float4: 'Fi.Field<number, "float4">',
	float8: 'Fi.Field<number, "float8">',
	int8: 'Fi.Field<bigint, "int8">',
	numeric: "Fi.NumericField",
	money: 'Fi.Field<Fi.Money, "money">',
	bool: 'Fi.Field<boolean, "bool">',
	date: 'Fi.Field<Fi.CalendarDate, "date">',
	inet: 'Fi.Field<Fi.Inet, "inet">',
	cidr: 'Fi.Field<Fi.Cidr, "cidr">'
}

/** The type assertions of a base: every inference the types make, equal to what the engine describes. */
const baseAssertions = (
	base: Base,
	env: Env,
	artifacts: SchemaArtifacts,
	ids: Ids
): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const relations = Arr.flatMap([...env.relations], ([name, value]) => {
		const r = { name }
		const h = headingOf(value, base, ids)
		const keys = keysOf(artifacts, r.name)
		return [
			expect(`fact_${r.name}`, `Sc.Fact<typeof ${ids(r.name)}>`, objectType(h.fact)),
			expect(`addition_${r.name}`, `Cs.Addition<typeof ${ids(r.name)}>`, additionType(h, [])),
			expect(
				`keys_${r.name}`,
				`Sc.KeysOf<typeof ${ids("S")}, typeof ${ids(r.name)}>`,
				Arr.join(Arr.map(keys, tupleType), " | ")
			),
			expect(
				`lookup_${r.name}`,
				`Sc.KeyValues<typeof ${ids(r.name)}>`,
				objectType(Arr.filter(h.fact, ([field]) => Arr.contains(value.primaryKey, field)))
			)
		]
	})
	const closedFacts =
		base.closedRelation === undefined || env.closedRelation === undefined
			? []
			: closedAssertions(base.closedRelation, env.closedRelation, base, ids)
	const rosterFacts = Arr.flatMap(base.rosters, (r) => [
		expect(
			`fact_${r.name}`,
			`Sc.Fact<typeof ${ids(r.name)}>`,
			objectType([["id", literalUnion(r.handles)]])
		),
		expect(
			`keys_${r.name}`,
			`Sc.KeysOf<typeof ${ids("S")}, typeof ${ids(r.name)}>`,
			tupleType(["id"])
		)
	])
	const keyValues = Arr.flatMap(base.statements, (s, i) => {
		if (
			s.kind !== "key" ||
			s.side.selection !== undefined ||
			!Arr.every(s.side.terms, (t) => t.kind === "field")
		) {
			return []
		}
		const h = headingOf(got(env.relations, s.side.relation), base, ids)
		return [
			expect(
				`keyvalues_${i}`,
				`Sc.KeyValues<typeof ${ids(statementId(i))}>`,
				objectType(
					Arr.filter(h.fact, ([name]) =>
						Arr.some(s.side.terms, (t) => t.kind === "field" && t.field === name)
					)
				)
			)
		]
	})
	const roles = Arr.flatMap(base.roles, (r) => [
		expect(
			`writes_${r.name}`,
			`Sc.WriteListOf<typeof ${ids(`role_${r.name}`)}>`,
			literalUnion(got(env.writes, r.name))
		)
	])
	const projected = projectionAssertion(base, env, ids)
	const derivedFacts =
		base.derived === undefined
			? []
			: [
					expect(
						`fact_${base.derived.name}`,
						`Sc.Fact<typeof ${ids(base.derived.name)}>`,
						objectType(
							compiledHeading(definitionOf(base.derived, base, env.schema, env.relations), ids)
						)
					),
					expect(
						"levels",
						`Sc.LevelsOf<typeof ${ids("Level")}>`,
						`typeof ${ids("Level")} | typeof ${ids("S")}`
					),
					...derivedAssertions(base.derived, base, env, ids)
				]
	const root =
		base.derived === undefined
			? [expect("levels", `Sc.LevelsOf<typeof ${ids("S")}>`, `typeof ${ids("S")}`)]
			: []
	const writable = expect(
		"writable",
		`WritableNames<typeof ${ids("S")}>`,
		literalUnion(
			Arr.flatMap([...env.relations], ([name, value]) =>
				relationDescOf(value, "agreement relation").kind === "relation" ? [name] : []
			)
		)
	)
	return [
		...rosterFacts,
		...closedFacts,
		...relations,
		writable,
		...keyValues,
		...roles,
		...projected,
		...derivedFacts,
		...root,
		...nestedAssertions(base, env, ids),
		...statementAssertions(base, env, ids),
		...descriptorAssertions(base, env, ids)
	]
}

/**
 * Rule's fact, each of its fields' host types as the engine describes them; and its reads: C.at of a payload field is
 * of that field's type, C.row a set over the last key field's roster.
 */
const closedAssertions = (
	c: ClosedSpec,
	rule: ClosedValue,
	base: Base,
	ids: Ids
): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const desc = relationDescOf(rule, "agreement closed relation")
	if (desc.kind !== "closedRelation") {
		throw new Error("Rule is a closed relation")
	}
	const fields = Rec.toEntries(desc.fields)
	const fieldDesc = (name: string): FieldDesc =>
		Option.getOrThrowWith(
			Option.fromUndefinedOr(desc.fields[name]),
			() => new Error(`no field ${name} of Rule`)
		)
	return [
		expect(
			"fact_Rule",
			`Sc.Fact<typeof ${ids("Rule")}>`,
			objectType(Arr.map(fields, ([name, f]) => [name, hostOfDesc(f, base, ids)] as const))
		),
		expect(
			"keys_Rule",
			`Sc.KeysOf<typeof ${ids("S")}, typeof ${ids("Rule")}>`,
			tupleType(desc.key)
		),
		expect("at", `Ph.TypeOfTerm<typeof ${ids("at")}>`, hostOfDesc(fieldDesc("w"), base, ids)),
		expect("at_sql", `Ph.SqlOfTerm<typeof ${ids("at")}>`, jsonText(sqlOfDesc(fieldDesc("w")))),
		expect("xat", `Ph.TypeOfTerm<typeof ${ids("xat")}>`, hostOfDesc(fieldDesc("x"), base, ids)),
		expect(
			"row",
			`Ph.TypeOfTerm<typeof ${ids("row")}>`,
			`Ff.Bits<typeof ${ids(Arr.lastNonEmpty(c.key).name)}>`
		)
	]
}

/**
 * A derived relation's fields' SQL types, each its head term's as the engine compiles the definition (a sum of a real
 * a real, a count a bigint), and its keys, the one its definition proves: it groups its relation's facts by `by`, so
 * `by` is its one key. A live derived relation stores nothing, so no derived analysis keys it; its type reads the key
 * its definition proves.
 */
const derivedAssertions = (
	spec: DerivedSpec,
	base: Base,
	env: Env,
	ids: Ids
): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const columns = compiledColumns(definitionOf(spec, base, env.schema, env.relations))
	return [
		...Arr.map(columns, (c) =>
			expect(
				`derived_sql_${c.name}`,
				`Ph.SqlOfCarrier<Rf.RelationFieldsOf<typeof ${ids(spec.name)}>[${jsonText(c.name)}]>`,
				jsonText(carrierSql[c.type.carrier])
			)
		),
		expect(
			"derived_keys",
			`Sc.KeysOf<typeof ${ids("Level")}, typeof ${ids(spec.name)}>`,
			`ReadonlyArray<${literalUnion([spec.by])}>`
		)
	]
}

/**
 * The statements' types, each the engine's Description of it as a type; the schema's captured tuple, its statements in
 * order; its containments, each containment and each mirrors' two; and a family's fin.
 */
const statementAssertions = (base: Base, env: Env, ids: Ids): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const named = Arr.zip(
		Arr.map(baseStatements(base, ids), ([name]) => name),
		Arr.map(env.statements, statementView)
	)
	const slots =
		base.family === undefined
			? []
			: Arr.flatMap(named, ([, view]) =>
					view.kind === "statement" && (view.desc.kind === "family" || view.desc.kind === "tree")
						? [
								expect(
									"slots",
									`typeof ${ids("slots")}`,
									`St.Fin<typeof ${ids(view.desc.slots.owner)}, ${jsonText(view.desc.slots.count)}>`
								)
							]
						: []
				)
	const containments = containmentTypes(
		Arr.map(named, ([, view]) => view),
		base,
		ids
	)
	return [
		...Arr.map(named, ([name, view]) =>
			expect(`statement_${name}`, `typeof ${ids(name)}`, viewType(view, base, ids))
		),
		expect(
			"statements",
			`Sc.StatementsOf<typeof ${ids("S")}>`,
			`readonly [${Arr.join(
				Arr.map(named, ([name]) => `typeof ${ids(name)}`),
				", "
			)}]`
		),
		expect(
			"containments",
			`Sc.ContainmentsOf<typeof ${ids("S")}>`,
			Arr.isReadonlyArrayNonEmpty(containments) ? Arr.join(containments, " | ") : "never"
		),
		...slots
	]
}

/**
 * What a text field's types read: its domain, text, the identity every pattern meets text at; its language, its host
 * type; and its host exactly where the language is small and finite, its members, or string where its source has a
 * \\u escape, which typed authoring widens.
 */
const textAssertions = (
	desc: FieldDesc,
	field: string,
	name: string,
	base: Base,
	ids: Ids
): ReadonlyArray<string> => {
	if (desc.kind !== "text") {
		return []
	}
	const expect = (label: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${label}_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const check = desc.language.kind === "refined" ? desc.language.check : undefined
	const exact = Arr.some(desc.patterns, (p) => Str.includes("\\u")(p.source))
		? ["string"]
		: check?.kind === "finite" && check.members.length <= 8
			? [literalUnion(check.members)]
			: []
	return [
		expect("domain", `Ph.DomainOf<${field}>`, "string"),
		expect("language", `Ph.LanguageOf<${field}>`, hostOfDesc(desc, base, ids)),
		...Arr.map(exact, (host) => expect("exact", `Fi.Infer<${field}>`, host))
	]
}

/**
 * Each relation's type, its fields' descriptors' types as the engine describes them under its name and primary key;
 * each caller field's host as a range endpoint, whether the engine's span core admits it, and its literal; each
 * contract's descriptor type and host.
 */
const descriptorAssertions = (base: Base, env: Env, ids: Ids): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const relations = Arr.flatMap(base.relations, (r) => {
		const value = got(env.relations, r.name)
		const decls = declsOf(value)
		const fieldTypes = Arr.map(
			decls,
			([name, decl]) => [name, descriptorType(decl, base, ids)] as const
		)
		const fieldOfR = (f: string) => `(typeof ${ids(r.name)})["fields"][${jsonText(f)}]`
		return [
			expect(
				`relation_${r.name}`,
				`typeof ${ids(r.name)}`,
				`Sc.Relation<${jsonText(r.name)}, ${objectType(fieldTypes)}, ${tupleType(value.primaryKey)}>`
			),
			...Arr.flatMap(decls, ([name, decl]) => {
				if (decl.writing.kind !== "caller") {
					return []
				}
				const descriptor = fieldValue(fieldOf(r, name).type, env.rosters, env.contracts)
				const endpoint = catchCompileError(() => spanDescriptor(descriptor)).ok
				const described = describeFieldOrThrow(descriptor, SourceLoc("field", [r.name, name]))
				return [
					...textAssertions(decl.type, fieldOfR(name), `${r.name}_${name}`, base, ids),
					expect(`sql_${r.name}_${name}`, `${fieldOfR(name)}["sql"]`, jsonText(described.sql)),
					expect(
						`column_${r.name}_${name}`,
						`${fieldOfR(name)}["column"]`,
						`Cd.Column<${hostOfDesc(decl.type, base, ids)}>`
					),
					expect(
						`endpoint_${r.name}_${name}`,
						`[${fieldOfR(name)}] extends [Fi.RangeEndpointLike] ? true : false`,
						endpoint ? "true" : "false"
					),
					...(decl.type.kind === "vector"
						? []
						: [
								expect(
									`literal_${r.name}_${name}`,
									`Fi.LiteralOf<Fi.Infer<${fieldOfR(name)}>>`,
									literalType(decl.type, base, ids)
								)
							])
				]
			})
		]
	})
	const contracts = Arr.flatMap(base.contracts, (c) => {
		const desc = describeFieldOrThrow(got(env.contracts, c.name), SourceLoc("contract", [])).desc
		return [
			expect(`contract_${c.name}`, `typeof ${ids(c.name)}`, valueDescriptorType(desc, base, ids)),
			expect(`host_${c.name}`, `Fi.Infer<typeof ${ids(c.name)}>`, hostOfDesc(desc, base, ids)),
			expect(
				`column_${c.name}`,
				`(typeof ${ids(c.name)})["column"]`,
				`Cd.Column<${hostOfDesc(desc, base, ids)}>`
			)
		]
	})
	return [...relations, ...contracts, ...publicAssertions(base, ids)]
}

/**
 * Whether a public value is a field descriptor, as the engine's descriptor registry admits one (scalar/registry.ts
 * describeField): a constructor such as numeric or str is none; and whether one pg spelling's descriptor is another's,
 * as the engine describes them: the same Description, written the same way or by its caller where the other is.
 */
const publicAssertions = (base: Base, ids: Ids): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const describedAs = (value: unknown) => {
		const described = describeField(value, SourceLoc("public", []))
		return described.ok ? descText(described.value.desc) : undefined
	}
	const fieldhood = Arr.map(base.publics, (v, i) => {
		const described = describeField(publicValue(v), SourceLoc("public", [])).ok
		return expect(
			`public_${i}`,
			`[typeof ${publicSource(v)}] extends [Fi.FieldBase] ? true : false`,
			described ? "true" : "false"
		)
	})
	const pairs = Arr.map(base.spellings, ([x, y], i) => {
		const [dx, dy] = [describedAs(plainDescriptors[x]), describedAs(plainDescriptors[y])]
		const same = dx !== undefined && dy !== undefined && dx.ok && dy.ok && dx.value === dy.value
		const wy = writingOf(plainDescriptors[y]).kind
		const assignable = same && (wy === "caller" || writingOf(plainDescriptors[x]).kind === wy)
		const spelled = (s: PgSpelling) => `Fi.${s}`
		return expect(
			`spelling_${i}`,
			`[typeof ${spelled(x)}] extends [typeof ${spelled(y)}] ? true : false`,
			assignable ? "true" : "false"
		)
	})
	return [...fieldhood, ...pairs, ...uuidAssertions(ids)]
}

/**
 * The uuid's host type, the language of uuid_out's spelling as the types keep it: one `${string}` per hyphenated group
 * of the engine's canonical spelling (scalar/values/uuid.ts toUuid), which a hexadecimal group widens to; and its one
 * typed way in from a plain value, Uuid.parse, which reads anything and answers a Uuid or the fault refusing it.
 */
const uuidAssertions = (ids: Ids): ReadonlyArray<string> => {
	const canonical = toUuid("0193D8F2-7C1E-7000-8000-00000000002A")
	const groups = canonical.ok ? Str.split(canonical.value, "-").length : 0
	const template = `\`${Arr.join(
		upTo(groups, () => `\${string}`),
		"-"
	)}\``
	return [
		`export type ${ids("t_uuid")} = Expect<Equals<Fi.Uuid, ${template}>>`,
		`export type ${ids("t_uuid_parse")} = Expect<Equals<typeof Fi.Uuid.parse, (input: unknown) => Rs.Result<Fi.Uuid, Er.ValueFault>>>`
	]
}

/** The projection of one relation of the base, drawn as the case's last: its head is what the engine compiles. */
const projectionAssertion = (base: Base, env: Env, ids: Ids): ReadonlyArray<string> => {
	const [name, value] = Option.getOrElse(
		Arr.findFirst([...env.relations], ([n]) => n === "Gen"),
		() => {
			const last = Arr.lastNonEmpty(base.relations)
			return [last.name, got(env.relations, last.name)] as const
		}
	)
	const r = { name }
	const fields = Arr.map(declsOf(value), ([field]) => field)
	const heading = compiledHeading(projectionOf(env.schema, value, fields), ids)
	return [
		...projectionLines("projection", r.name, fields, heading, ids),
		...(base.closedRelation === undefined || env.closedRelation === undefined
			? []
			: closedProjection(base.closedRelation, env.closedRelation, env, ids))
	]
}

/** A query projecting a source's fields, and its head asserted equal to the heading the engine compiles it to. */
const projectionLines = (
	name: string,
	source: string,
	fields: ReadonlyArray<string>,
	heading: ReadonlyArray<readonly [string, string]>,
	ids: Ids
): ReadonlyArray<string> => [
	`export const ${ids(name)} = Q.query(${ids("S")}).rule((r) => { const { ${Arr.join(fields, ", ")} } = Q.v(${ids(source)}, "fact"); return r.match(${ids(source)}, { ${Arr.join(fields, ", ")} }).find({ ${Arr.join(fields, ", ")} }) })`,
	`export type ${ids(`t_${name}`)} = Expect<Equals<Q.HeadOf<typeof ${ids(name)}>, ${objectType(heading)}>>`
]

/** A query over the base matching its closed relation Rule, a closed read among a rule's matches. */
const closedProjection = (
	c: ClosedSpec,
	rule: ClosedValue,
	env: Env,
	ids: Ids
): ReadonlyArray<string> => {
	const fields = [...closedKeyNames(c), "w", "x"]
	return projectionLines(
		"closedProjection",
		"Rule",
		fields,
		compiledHeading(projectionOf(env.schema, rule, fields), ids),
		ids
	)
}

/**
 * The nested additions of the base's family as the engine nests an insert (write/family/nesting.ts): an ordered
 * owner's members at its count field, each less its group; a counted family's owner and member their own rows; a tree
 * node's children at its count field, with no parent, and below the root no root field either, at every depth.
 */
const nestedAssertions = (base: Base, env: Env, ids: Ids): ReadonlyArray<string> => {
	const family = base.family
	if (family === undefined) {
		return []
	}
	const heading = (name: string) => headingOf(got(env.relations, name), base, ids)
	const additionIn = (name: string) => `Cs.AdditionIn<typeof ${ids("S")}, typeof ${ids(name)}>`
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const alike = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Alike<${actual}, ${expected}>>`
	switch (family.kind) {
		case "ordered": {
			const group = Arr.take(family.member.terms, family.member.terms.length - 1)
			return [
				alike(
					"nested_owner",
					additionIn(family.owner),
					`(${additionType(heading(family.owner), [])}) & { readonly ${jsonText(family.count)}: ReadonlyArray<${additionType(heading(family.member.relation), group)}> }`
				),
				alike(
					"nested_member",
					additionIn(family.member.relation),
					additionType(heading(family.member.relation), [])
				)
			]
		}
		case "counted":
			return [
				alike("nested_owner", additionIn(family.owner), additionType(heading(family.owner), [])),
				alike(
					"nested_member",
					additionIn(family.member.relation),
					additionType(heading(family.member.relation), [])
				)
			]
		case "tree": {
			const h = heading(family.relation)
			const [parent] = family.member.terms
			const keysAt = (omitted: ReadonlyArray<string>) =>
				literalUnion([...Arr.filter(h.written, (f) => !Arr.contains(omitted, f)), family.count])
			const top = additionIn(family.relation)
			return [
				expect("nested_root", `keyof ${top}`, keysAt([parent])),
				expect(
					"nested_child",
					`keyof ${top}[${jsonText(family.count)}][number]`,
					keysAt([parent, ...family.root])
				),
				expect(
					"nested_grandchild",
					`keyof ${top}[${jsonText(family.count)}][number][${jsonText(family.count)}][number]`,
					keysAt([parent, ...family.root])
				)
			]
		}
	}
}
/** How a vector probe makes its value: Vector.make or Vector.from, over which buffer, its dimensions spelled how. */
type VectorForm =
	| {
			readonly fault: "vectorMakeBuffer" | "vectorDimensionArgument" | "vectorAssign" | undefined
			readonly call: "make"
			readonly buffer: "f32" | "array"
			readonly dims: "number" | "text"
			readonly target: "same" | "other"
	  }
	| {
			readonly fault: "vectorFromBuffer" | "vectorFromOther" | undefined
			readonly call: "from"
			readonly buffer: "f32" | "f64" | "array" | "vector"
	  }

/**
 * A vector host value: Vector.make or Vector.from over a buffer of the dimensions it names, valid or with one planted
 * fault: a buffer that is no Float32Array, dimensions that are no number, a Vector of other dimensions to from, a value
 * held at a type of other dimensions. The engine's admission of the buffer (scalar/values/vector.ts admit and
 * admitEncodable) and of the value at a vector field's type (scalar/literal.ts literalDescFor) is the oracle.
 */
const vectorProbe = (d: Drawing): Probe => {
	const n = d.from([1, 3, 4])
	const other = n === 3 ? 4 : 3
	const form = d.from<VectorForm>([
		{ fault: undefined, call: "make", buffer: "f32", dims: "number", target: "same" },
		{ fault: "vectorAssign", call: "make", buffer: "f32", dims: "number", target: "other" },
		{ fault: "vectorMakeBuffer", call: "make", buffer: "array", dims: "number", target: "same" },
		{ fault: "vectorDimensionArgument", call: "make", buffer: "f32", dims: "text", target: "same" },
		{ fault: undefined, call: "from", buffer: "f32" },
		{ fault: "vectorFromBuffer", call: "from", buffer: d.from(["f64", "array"] as const) },
		{ fault: "vectorFromOther", call: "from", buffer: "vector" }
	])
	const components = (k: number) =>
		Arr.map(
			upTo(k, (i) => i + 1),
			(i) => i % 2
		)
	const bufferSource = (buffer: "f32" | "f64" | "array" | "vector"): string => {
		switch (buffer) {
			case "f32":
				return `Float32Array.of(${Arr.join(Arr.map(components(n), String), ", ")})`
			case "f64":
				return `new Float64Array(${n})`
			case "array":
				return `[${Arr.join(Arr.map(components(n), String), ", ")}]`
			case "vector":
				return `Fi.Vector.make(Float32Array.of(${Arr.join(Arr.map(components(other), String), ", ")}), ${other})`
		}
	}
	const bufferValue = (buffer: "f32" | "f64" | "array" | "vector"): unknown => {
		switch (buffer) {
			case "f32":
				return Float32Array.from(components(n))
			case "f64":
				return new Float64Array(n)
			case "array":
				return components(n)
			case "vector":
				return Vector.make(Float32Array.from(components(other)), other)
		}
	}
	return {
		construct: "valueProbe",
		refused: form.fault,
		text: (_ids, own) => {
			switch (form.call) {
				case "make":
					return oneLine(
						`export const ${own}${form.fault === "vectorMakeBuffer" || form.fault === "vectorDimensionArgument" ? "" : `: Fi.Vector<${form.target === "same" ? n : other}>`} = Fi.Vector.make(${bufferSource(form.buffer)}, ${form.dims === "number" ? n : jsonText(String(n))})`
					)
				case "from":
					return oneLine(`export const ${own} = Fi.Vector.from(${bufferSource(form.buffer)}, ${n})`)
			}
		},
		judge: () => {
			switch (form.call) {
				case "make": {
					const made = catchCompileError(() => {
						const vector: unknown = Reflect.apply(Vector.make, undefined, [
							bufferValue(form.buffer),
							form.dims === "number" ? n : String(n)
						])
						return vector
					})
					const type = scalarTypeOf(
						{ kind: "vector", dimensions: form.target === "same" ? n : other },
						{ kind: "builder", roster: () => undefined },
						SourceLoc("the vector's field", [])
					)
					return !made.ok
						? engineVerdict(made)
						: type.ok
							? valueVerdict(literalDescFor(type.value, made.value))
							: engineVerdict(type)
				}
				case "from":
					return valueVerdict(admitEncodable(bufferValue(form.buffer), n))
			}
		}
	}
}

/**
 * A uuid host value: a text of uuid_out's spelling in either case, or a value of crypto.randomUUID's type, which the
 * engine's uuid admission (scalar/values/uuid.ts toUuid) judges by a version 4 uuid of its spelling; or, a planted
 * fault, a text of fewer groups, which it refuses. The types' language is the five hyphenated groups, so a text of five
 * groups that is no uuid is the boundary's to refuse, and is not drawn.
 */
const uuidProbe = (d: Drawing): Probe => {
	const canonical = "0193d8f2-7c1e-7000-8000-00000000002a"
	const form = d.from<readonly [SchemaFault | undefined, string, "literal" | "random"]>([
		[undefined, canonical, "literal"],
		[undefined, "0193D8F2-7C1E-7000-8000-00000000002A", "literal"],
		[undefined, "7d444840-9dc0-41c3-a2f2-55b3f4ffd5d4", "random"],
		["uuidSpelling", "0193d8f2-7c1e-7000-800000000000002a", "literal"],
		["uuidSpelling", "0193d8f27c1e7000800000000000002a", "literal"]
	])
	const [fault, text, spelled] = form
	return {
		construct: "valueProbe",
		refused: fault,
		text: (_ids, own) =>
			spelled === "literal"
				? oneLine(`export const ${own}: Fi.Uuid = ${jsonText(text)}`)
				: {
						head: [`export declare const ${own}_random: ReturnType<typeof crypto.randomUUID>`],
						line: `export const ${own}: Fi.Uuid = ${own}_random`,
						tail: []
					},
		judge: () => valueVerdict(toUuid(text))
	}
}

/**
 * A set over a roster, Bits.of of its handles, each once, or, a planted fault, a handle of no roster or one twice, which
 * the engine's Bits.of refuses.
 */
const bitsProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const handles = d.some(roster.handles)
	const form = d.from<readonly [SchemaFault | undefined, ReadonlyArray<string>]>([
		[undefined, handles],
		[undefined, []],
		["bitsStranger", [...handles, "Z"]],
		["bitsRepeated", [...handles, handles[0]]]
	])
	const [fault, written] = form
	return {
		construct: "valueProbe",
		refused: fault,
		text: (ids, own) =>
			oneLine(`export const ${own} = Fi.Bit.of(${ids(roster.name)}, [${quoted(written)}])`),
		judge: (env) => building(() => bitsOf(got(env.rosters, roster.name), written, []))
	}
}

/**
 * A domain named by a constant whose type is one literal, or, a planted fault, a union of literals, a string or a
 * template. The engine names a contract's identity by its name (ir/scalar.ts sameScalarType): every literal the
 * name's type admits builds a contract of its own identity, so a name of more than one literal names no one
 * contract, and its descriptor no one type.
 */
const contractNameProbe = (d: Drawing): Probe => {
	const form = d.from<readonly [string, ReadonlyArray<string> | "unbounded"]>([
		['"Cents"', ["Cents"]],
		['"Cents" | "Dollars"', ["Cents", "Dollars"]],
		["string", "unbounded"],
		[`\`\${string}Cents\``, "unbounded"]
	])
	const [type, names] = form
	const several = names === "unbounded" || names.length > 1
	return {
		construct: "contractNameProbe",
		refused: several ? "contractName" : undefined,
		text: (_ids, own) => ({
			head: [`export declare const ${own}_name: ${type}`],
			line: `export const ${own} = Fi.domain<typeof Key>()(${own}_name, Fi.int8)`,
			tail: []
		}),
		judge: () => {
			if (names === "unbounded") {
				return {
					kind: "refused",
					key: "identity:several",
					message: "a name of every string names unboundedly many contracts"
				}
			}
			const types = Arr.map(
				names,
				(name) =>
					describeFieldOrThrow(admitContract(name, int8, []), SourceLoc("domain name", [])).scalar
			)
			const [first, ...rest] = types
			return first !== undefined && Arr.every(rest, (t) => sameScalarType(first, t))
				? admitted
				: {
						kind: "refused",
						key: "identity:several",
						message: `the names ${Arr.join(names, ", ")} are contracts of ${types.length} identities`
					}
		}
	}
}

/** How a closed-read probe reads Rule, valid or with one planted fault: the key or prefix it passes. */
type ClosedReadForm =
	| {
			readonly fault: "atShort" | "atMissing" | "atSwapped" | "atKey" | "atWrongHandle" | undefined
			readonly read: "at"
			readonly key: ReadonlyArray<string>
	  }
	| {
			readonly fault: "rowShort" | "rowWhole" | undefined
			readonly read: "row"
			readonly prefix: ReadonlyArray<string>
	  }
	| {
			readonly fault: "hasShort" | "hasField" | "hasWrongHandle" | "hasSwapped" | undefined
			readonly read: "has"
			readonly key: ReadonlyArray<string>
	  }
	| { readonly fault: "echoRoster" | undefined; readonly read: "generated" }

/**
 * A read of the base's closed relation, at its key of one to three closed ids: C.at of a payload field at a full key,
 * C.row at a key prefix, C.has at a full key, or a generated field reading C.at at its row's closed ids; valid, or with
 * one planted fault: a key short of a field, a payload field Rule does not declare, a key field read as a payload, a
 * key value of no handle, its first two key values swapped, a row's prefix short of a field or the whole key, a
 * presence's key short of a field, led by a payload field, holding a value of no handle or its first two values
 * swapped, a closed id of another roster whose handles have Rule's first key roster's spellings. The engine's closed
 * reads and generated relations are the oracle.
 */
const closedReadProbe = (d: Drawing, base: Base): Probe | undefined => {
	const c = base.closedRelation
	if (c === undefined) {
		return undefined
	}
	const names = closedKeyNames(c)
	const [k1, ...rest] = c.key
	const second = Arr.isReadonlyArrayNonEmpty(rest) ? Arr.headNonEmpty(rest) : undefined
	const apart =
		second === undefined ? [] : Arr.filter(k1.handles, (h) => !Arr.contains(second.handles, h))
	const h1 = d.from(Arr.isReadonlyArrayNonEmpty(apart) ? apart : k1.handles)
	const others = Arr.map(rest, (r) => d.from(r.handles))
	const full: Arr.NonEmptyReadonlyArray<string> = [h1, ...others]
	const swapped: ReadonlyArray<ClosedReadForm> = Arr.match(Arr.zip(rest, others), {
		onEmpty: () => [],
		onNonEmpty: ([[r2, h2], ...tail]) => {
			const key = [h2, h1, ...Arr.map(tail, ([, h]) => h)]
			return !Arr.contains(k1.handles, h2) || !Arr.contains(r2.handles, h1)
				? [
						{ fault: "atSwapped", read: "at", key },
						{ fault: "hasSwapped", read: "has", key }
					]
				: []
		}
	})
	const prefix = Arr.initNonEmpty(full)
	const form = d.from<ClosedReadForm>([
		{ fault: undefined, read: "at", key: full },
		{ fault: "atShort", read: "at", key: prefix },
		{ fault: "atMissing", read: "at", key: full },
		{ fault: "atKey", read: "at", key: full },
		{ fault: "atWrongHandle", read: "at", key: Arr.prepend(Arr.tailNonEmpty(full), "Nope") },
		...swapped,
		{ fault: undefined, read: "row", prefix },
		{ fault: "rowWhole", read: "row", prefix: full },
		...(Arr.isReadonlyArrayNonEmpty(prefix)
			? [{ fault: "rowShort", read: "row", prefix: Arr.initNonEmpty(prefix) } as const]
			: []),
		{ fault: undefined, read: "has", key: full },
		{ fault: "hasShort", read: "has", key: prefix },
		{ fault: "hasField", read: "has", key: Arr.prepend(full, "w") },
		{ fault: "hasWrongHandle", read: "has", key: Arr.prepend(Arr.tailNonEmpty(full), "Nope") },
		{ fault: undefined, read: "generated" },
		{ fault: "echoRoster", read: "generated" }
	])
	const field = d.from(["w", "x"] as const)
	const read = form.fault === "atMissing" ? "nope" : form.fault === "atKey" ? "k1" : field
	const echoNames = Arr.tailNonEmpty(names)
	return {
		construct: "closedReadProbe",
		refused: form.fault,
		text: (ids, own) => {
			switch (form.read) {
				case "at":
					return oneLine(`export const ${own} = ${ids("Rule")}.at(${quoted([read, ...form.key])})`)
				case "row":
					return oneLine(`export const ${own} = ${ids("Rule")}.row(${quoted(form.prefix)})`)
				case "has":
					return oneLine(`export const ${own} = ${ids("Rule")}.has(${quoted(form.key)})`)
				case "generated": {
					const roster = form.fault === "echoRoster" ? `${own}_Echo` : ids(k1.name)
					const restFields = Arr.zipWith(
						echoNames,
						rest,
						(name, r) => `, ${name}: Fi.closedId(${ids(r.name)})`
					)
					const reads = Arr.map(echoNames, (name) => `, r.${name}`)
					return {
						head: [`export const ${own}_Echo = Sc.closed.ordered("Echo", [${quoted(k1.handles)}])`],
						line: `export const ${own} = Sc.relation.generated("Echoed", { id: Fi.Id, echo: Fi.closedId(${roster})${Arr.join(restFields, "")} }, ["id"], (r) => ({ w: Fi.generated(Fi.int4, ${ids("Rule")}.at("w", r.echo${Arr.join(reads, "")})) }))`,
						tail: []
					}
				}
			}
		},
		judge: (env) => {
			const rule = Option.getOrThrowWith(
				Option.fromUndefinedOr(env.closedRelation),
				() => new Error("the case has Rule")
			)
			switch (form.read) {
				case "at":
					return building(() => closedRead(rule, read, form.key))
				case "row":
					return building(() => closedRow(rule, form.prefix))
				case "has":
					return building(() => closedHas(rule, form.key))
				case "generated":
					return compiling(() => {
						const echo = closed("Echo", k1.handles, "ordered", [])
						const echoed = generatedRelation(
							"Echoed",
							{
								id: Id,
								echo: closedId(form.fault === "echoRoster" ? echo : got(env.rosters, k1.name)),
								...Rec.fromEntries(
									Arr.zipWith(echoNames, rest, (name, r) => [
										name,
										closedId(got(env.rosters, r.name))
									])
								)
							},
							["id"],
							(row: Readonly<Record<string, unknown>>) => ({
								w: generatedField(
									int4,
									closedRead(
										rule,
										"w",
										Arr.prepend(
											Arr.map(echoNames, (name) => row[name]),
											row["echo"]
										)
									),
									[]
								)
							}),
							[]
						)
						return schema("P", [...Rec.values(env.members), echo, echoed], [...env.statements], [])
					})
			}
		}
	}
}

/** How a generated probe states its generated fields: reading its caller's fields, or with one planted fault. */
type GeneratedForm =
	| "readsCaller"
	| "refinedGenerated"
	| "generatedReadsGenerated"
	| "generatedWrongType"
	| "generatedContract"
	| "generatedTwiceNamed"

/** The caller's text a refined generated field concatenates, and the refinement of its carrier the field declares. */
const wordPattern = "^[a-z]{0,4}$"
const doubledPattern = "^[a-c]{0,8}$"

/**
 * A relation with generated fields over its caller's id, depth and set w. Valid, a generated set reading w, or a
 * concatenation of the caller's word, a text of no pattern, into a field of a pattern, which the field's domain judges;
 * or a planted fault: a generated field reading another, a term of a type other than its field's, a bigint term into a
 * contract over bigint, a generated field named as a written one. A primary key naming a generated field is no fault
 * since 55fce798e, a key generation, which test/types/evidence/generated-keys agrees over every shape of. The engine's
 * compilation of a schema holding it is the oracle.
 */
const generatedProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const form = d.from<GeneratedForm>([
		"readsCaller",
		"refinedGenerated",
		"generatedReadsGenerated",
		"generatedWrongType",
		"generatedContract",
		"generatedTwiceNamed"
	])
	if (form === "refinedGenerated") {
		d.note("refinedGenerated")
	}
	const successorSource = "Cp.Type.cast(Cp.Num.add(r.depth, 1), Fi.int8)"
	const nextSource = `Fi.generated(Fi.int8, ${successorSource})`
	const callbackSource = (set: string, tally: string): string => {
		switch (form) {
			case "readsCaller":
				return `{ g: Fi.generated(${set}, Fi.Bit.union(r.w, r.w)) }`
			case "refinedGenerated":
				return `{ t: Fi.generated(Tx.str.regex(${jsonText(doubledPattern)}), Cp.Text.concat(r.word, r.word)) }`
			case "generatedContract":
				return `{ c: Fi.generated(${tally}, ${successorSource}) }`
			case "generatedReadsGenerated":
				return `{ next: ${nextSource}, twice: Fi.generated(Fi.int8, r.next) }`
			case "generatedWrongType":
				return "{ label: Fi.generated(Fi.int8, r.depth) }"
			case "generatedTwiceNamed":
				return "{ depth: Fi.generated(Fi.int4, r.depth) }"
		}
	}
	return {
		construct: "generatedProbe",
		refused: form === "readsCaller" || form === "refinedGenerated" ? undefined : form,
		text: (ids, own) => {
			const set = `Fi.bit(${ids(roster.name)})`
			const tally = `${own}_${tallyName}`
			return {
				head:
					form === "generatedContract"
						? [`export const ${tally} = Fi.domain<typeof Key>()(${jsonText(tallyName)}, Fi.int8)`]
						: [],
				line: `export const ${own} = Sc.relation.generated("Generated", { id: Fi.Id, depth: Fi.int4, w: ${set}${form === "refinedGenerated" ? `, word: Tx.str.regex(${jsonText(wordPattern)})` : ""} }, ["id"], (r) => (${callbackSource(set, tally)}))`,
				tail: []
			}
		},
		judge: (env) =>
			compiling(() => {
				const set = fieldValue({ kind: "bits", roster: roster.name }, env.rosters, env.contracts)
				const successor = (row: Readonly<Record<string, unknown>>) =>
					computeCore.cast(computeCore.add(row["depth"], 1), int8)
				const next = (row: Readonly<Record<string, unknown>>) =>
					generatedField(int8, successor(row), [])
				const callback = (
					row: Readonly<Record<string, unknown>>
				): Readonly<Record<string, unknown>> => {
					switch (form) {
						case "readsCaller":
							return { g: generatedField(set, computeCore.union(row["w"], row["w"]), []) }
						case "refinedGenerated":
							return {
								t: generatedField(
									regexField(doubledPattern, []),
									computeCore.concat(row["word"], row["word"]),
									[]
								)
							}
						case "generatedContract":
							return {
								c: generatedField(admitContract(tallyName, int8, []), successor(row), [])
							}
						case "generatedReadsGenerated":
							return {
								next: next(row),
								twice: generatedField(int8, row["next"], [])
							}
						case "generatedWrongType":
							return { label: generatedField(int8, row["depth"], []) }
						case "generatedTwiceNamed":
							return { depth: generatedField(int4, row["depth"], []) }
					}
				}
				const made: unknown = Reflect.apply(generatedRelation, undefined, [
					"Generated",
					{
						id: Id,
						depth: int4,
						w: set,
						...(form === "refinedGenerated" ? { word: regexField(wordPattern, []) } : {})
					},
					["id"],
					callback,
					[]
				])
				const built: unknown = Reflect.apply(schema, undefined, [
					"P",
					[...Rec.values(Rec.fromEntries([...env.rosters])), made],
					[],
					[]
				])
				return built
			})
	}
}

/** How a slot key probe states its laws: a closed relation keyed by slots, or with one planted fault. */
type SlotKeyForm =
	| "slotted"
	| "finOverClosedNotNatural"
	| "slotOverOrdinary"
	| "slotNotClosed"
	| "familyOverClosed"

/**
 * A closed relation Model over a roster of versions, each version's count of positions drawn, and Follow, a closed
 * relation keyed by a version and two slots of its count, slot(closedId(Position), fin(Model, "positions")), a row at
 * the first and last position of every version; Step reads Follow's row of a version and a from slot, a set over
 * Position. Or a planted fault: fin over Model's closed id label, a slot over an ordinary relation's count, a slot of no
 * closed id, an ordered family counted by Model's fin. The engine's builders and compilation are the oracle.
 */
const slotKeyProbe = (d: Drawing): Probe => {
	const form = d.from<SlotKeyForm>([
		"slotted",
		"finOverClosedNotNatural",
		"slotOverOrdinary",
		"slotNotClosed",
		"familyOverClosed"
	])
	const positions = ["p0", "p1", "p2"] as const
	const versions = [
		["v0", d.from([1, 2, 3] as const)],
		["v1", d.from([1, 2, 3] as const)]
	] as const
	const lastOf: { readonly [C in 1 | 2 | 3]: (typeof positions)[number] } = {
		1: "p0",
		2: "p1",
		3: "p2"
	}
	return {
		construct: "slotKeyProbe",
		refused: form === "slotted" ? undefined : form,
		text: (_ids, own) => {
			const head = [
				`export const ${own}_Version = Sc.closed.ordered("Version", ["v0", "v1"])`,
				`export const ${own}_Position = Sc.closed.ordered("Position", [${quoted(positions)}])`,
				`export const ${own}_Model = Sc.closed.relation("Model", { version: Fi.closedId(${own}_Version), positions: Fi.natural, label: Fi.closedId(${own}_Version) }, ["version"], [${Arr.join(
					Arr.map(
						versions,
						([v, n]) => `{ version: ${jsonText(v)}, positions: ${n}n, label: "v0" }`
					),
					", "
				)}])`
			]
			const slot = `Fi.slot(Fi.closedId(${own}_Position), Sc.fin(${own}_Model, "positions"))`
			switch (form) {
				case "slotted":
					return {
						head,
						line: `export const ${own} = Sc.closed.relation("Follow", { version: Fi.closedId(${own}_Version), from: ${slot}, to: ${slot} }, ["version", "from", "to"], [${Arr.join(
							Arr.map(
								versions,
								([v, n]) => `{ version: ${jsonText(v)}, from: "p0", to: ${jsonText(lastOf[n])} }`
							),
							", "
						)}])`,
						tail: [
							`export const ${own}_Step = Sc.relation.generated("Step", { id: Fi.int4, version: Fi.closedId(${own}_Version), from: Fi.closedId(${own}_Position) }, ["id"], (r) => ({ next: Fi.generated(Fi.bit(${own}_Position), ${own}.row(r.version, r.from)) }))`,
							`export const ${own}_Slotted = Sc.schema("Slotted", [${own}_Version, ${own}_Position, ${own}_Model, ${own}, ${own}_Step], [])`,
							`export type ${own}_key = Expect<Equals<(typeof ${own})["key"], readonly ["version", "from", "to"]>>`,
							`export type ${own}_next = Expect<Equals<Sc.Fact<typeof ${own}_Step>["next"], Ff.Bits<typeof ${own}_Position>>>`
						]
					}
				case "finOverClosedNotNatural":
					return { head, line: `export const ${own} = Sc.fin(${own}_Model, "label")`, tail: [] }
				case "slotOverOrdinary":
					return {
						head: [
							...head,
							`export const ${own}_Owner = Sc.relation("Owner", { id: Fi.int4, n: Fi.drawn(Fi.natural) }, ["id"])`
						],
						line: `export const ${own} = Fi.slot(Fi.closedId(${own}_Position), Sc.fin(${own}_Owner, "n"))`,
						tail: []
					}
				case "slotNotClosed":
					return {
						head,
						line: `export const ${own} = Fi.slot(Fi.int4, Sc.fin(${own}_Model, "positions"))`,
						tail: []
					}
				case "familyOverClosed":
					return {
						head: [
							...head,
							`export const ${own}_Member = Sc.relation("Member", { version: Fi.closedId(${own}_Version), at: Fi.drawn(Fi.natural) }, ["version", "at"])`
						],
						line: `export const ${own} = Sc.ordered(Sc.on(${own}_Member, "version", "at"), Sc.fin(${own}_Model, "positions"))`,
						tail: []
					}
			}
		},
		judge: () => {
			const version = closed("Version", ["v0", "v1"], "ordered", [])
			const position = closed("Position", positions, "ordered", [])
			const model = closedRelation(
				"Model",
				{
					version: closedId(version),
					positions: naturalDescriptor,
					label: closedId(version)
				},
				["version"],
				Arr.map(versions, ([v, n]) => ({ version: v, positions: BigInt(n), label: "v0" as const })),
				[]
			)
			/** Follow keyed by two slots of Model's count `count`, and Step reading its rows, compiled. */
			const slotted = (count: "positions" | "label") =>
				compiling(() => {
					const slot = () => slotField(closedId(position), finBuilder(model, count), [])
					const follow = closedRelation(
						"Follow",
						{ version: closedId(version), from: slot(), to: slot() },
						["version", "from", "to"],
						Arr.map(versions, ([v, n]) => ({ version: v, from: "p0" as const, to: lastOf[n] })),
						[]
					)
					const step = generatedRelation(
						"Step",
						{ id: int4, version: closedId(version), from: closedId(position) },
						["id"],
						(row: Readonly<Record<string, unknown>>) => ({
							next: generatedField(
								bit(position),
								closedCall(follow.row, follow, [row["version"], row["from"]]),
								[]
							)
						}),
						[]
					)
					return schema("Slotted", [version, position, model, follow, step], [], [])
				})
			switch (form) {
				case "slotted":
					return slotted("positions")
				case "finOverClosedNotNatural":
					return slotted("label")
				case "slotOverOrdinary":
					return building(() => {
						const owner = relation(
							"Owner",
							{ id: int4, n: drawnField(naturalDescriptor, []) },
							["id"],
							[]
						)
						return slotField(closedId(position), finBuilder(owner, "n"), [])
					})
				case "slotNotClosed":
					return building(() => {
						const made: unknown = Reflect.apply(slotField, undefined, [
							int4,
							finBuilder(model, "positions"),
							[]
						])
						return made
					})
				case "familyOverClosed":
					return building(() => {
						const member = relation(
							"Member",
							{ version: closedId(version), at: drawnField(naturalDescriptor, []) },
							["version", "at"],
							[]
						)
						return orderedBuilder(
							onBuilder(member, ["version", "at"]),
							finBuilder(model, "positions")
						)
					})
			}
		}
	}
}

/**
 * A spelling of the serial family read where a descriptor is: a relation's field, a contract's base or a span's
 * endpoint. Each is a planted fault, refused by the model's message, grizzle mints no ids, by the types where the
 * spelling is written and by the engine where it reads the descriptor (scalar/registry.ts refusedField). The probe is
 * never admitted, so its construct is noted where drawn.
 */
const mintedProbe = (d: Drawing): Probe => {
	d.note("mintedProbe")
	const spelling = d.from(mintedSpellings)
	const site = d.from(["field", "contract", "span"] as const)
	const refusal = plainDescriptors[spelling]
	return {
		construct: "mintedProbe",
		refused: "mintedId",
		text: (_ids, own) =>
			oneLine(
				site === "field"
					? `export const ${own} = Sc.relation("Minted", { id: Fi.${spelling} }, ["id"])`
					: site === "contract"
						? `export const ${own} = Fi.domain<typeof Key>()("Minted", Fi.${spelling})`
						: `export const ${own} = Fi.range(Fi.${spelling})`
			),
		judge: () =>
			building((): unknown =>
				site === "field"
					? Reflect.apply(relation, undefined, ["Minted", { id: refusal }, ["id"], []])
					: site === "contract"
						? admitContract("Minted", refusal, [])
						: spanDescriptor(refusal)
			)
	}
}

/**
 * A bare uuid where a column is declared: a relation's key field or a field beside its key. Each is a planted fault, refused by the model's message, say whose id this is, by the types where the column is
 * written (types/fields/field.ts NamedIds) and by the builders where they describe it (schema/relation.ts
 * namedColumn), while a contract over uuid, the program's Id, is the column it names. The probe is never admitted, so
 * its construct is noted where drawn.
 */
const unnamedIdProbe = (d: Drawing): Probe => {
	d.note("unnamedIdProbe")
	const site = d.from(["key", "payload"] as const)
	return {
		construct: "unnamedIdProbe",
		refused: "unnamedId",
		text: (_ids, own) =>
			oneLine(
				site === "key"
					? `export const ${own} = Sc.relation("Unnamed", { id: Fi.uuid }, ["id"])`
					: `export const ${own} = Sc.relation("Unnamed", { id: Fi.Id, of: Fi.uuid }, ["id"])`
			),
		judge: () =>
			building((): unknown =>
				site === "key"
					? Reflect.apply(relation, undefined, ["Unnamed", { id: uuidDescriptor }, ["id"], []])
					: Reflect.apply(relation, undefined, [
							"Unnamed",
							{ id: Id, of: uuidDescriptor },
							["id"],
							[]
						])
			)
	}
}

/** How a rule probe writes its query, valid or with one planted fault. */
type RuleForm =
	| "inSet"
	| "inSetKind"
	| "bind"
	| "partialBind"
	| "strayBinding"
	| "strayNegation"
	| "bindingType"
	| "negatedBindingType"
	| "negationParam"
	| "paramTwice"
	| "attach"
	| "foreignAttach"

/** A query's verdict: built, then compiled as a read, the first refusal of either. */
const querying = (build: () => unknown): Verdict =>
	engineVerdict(
		Result.flatMap(catchCompileError(build), (built) =>
			compileTemplate(built, undefined, testCompile)
		)
	)

/**
 * A rule over a schema of its own, Lit with a field f of a drawn type, a bigint n and a contract over it c: inSet
 * of literals, valid where they are literals of f's type and a planted fault where not; an import of a query reading
 * a parameter, bound at an outer variable, and with its binding left out or beside a stray name; a variable bound
 * to a field of another type, a contract's to its base's or its base's to the contract's, in a match, or one of another
 * base carrier, an integer's to a bigint's or a bigint's to an integer's, in a negation, which pairs by base carrier; a
 * negation naming a stray field, and one reading a parameter, which joins the rule's at its field's type as an
 * equality's does; one parameter named in two places, which is one parameter; an attachment of a query over the schema, and of one over another schema. The
 * engine's query builders and compilation are the oracle.
 */
const ruleProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const form = d.from<RuleForm>([
		"inSet",
		"inSetKind",
		"bind",
		"partialBind",
		"strayBinding",
		"strayNegation",
		"bindingType",
		"negatedBindingType",
		"negationParam",
		"paramTwice",
		"attach",
		"foreignAttach"
	])
	const target = d.from(literalTargets)
	const type = targetType(target, roster.name)
	const kinds: Arr.NonEmptyReadonlyArray<LiteralValue> =
		form === "inSet" ? literalsOfTarget(target) : literalsAt(target)
	const literal = literalOf(d.from(kinds), roster)
	const contractWay = d.from(["contract var at base", "base var at contract"] as const)
	if (form === "paramTwice" || form === "negationParam") {
		d.note(form)
	}
	if (form === "bind") {
		d.note("bindOuterVariable")
	}
	const refused: SchemaFault | undefined =
		form === "inSetKind" ||
		form === "partialBind" ||
		form === "strayBinding" ||
		form === "strayNegation" ||
		form === "bindingType" ||
		form === "negatedBindingType" ||
		form === "foreignAttach"
			? form
			: undefined
	return {
		construct: "ruleProbe",
		refused,
		text: (ids, own) => {
			const lit = `${own}_Lit`
			const head = [
				`export const ${own}_Cents = Fi.domain<${keyText("Cents")}>()("Cents", Fi.int8)`,
				`export const ${lit} = Sc.relation("Lit", { id: Fi.Id, f: ${fieldSource(type, ids)}, n: Fi.int8, c: ${own}_Cents, i: Fi.int4 }, ["id"])`,
				`export const ${own}_P = Sc.schema("P", [${Arr.join(
					[...Arr.map(base.rosters, (r) => ids(r.name)), lit],
					", "
				)}], [])`
			]
			const imported = `${own}_q`
			const importedLine = `export const ${imported} = Q.query(${own}_P).rule((r) => { const { id, f } = Q.v(${lit}, "inner"); return r.match(${lit}, { id, f }).where(r.eq(f, r.param("p", ${lit}.fields.f))).find({ id }) })`
			const rule = (body: string) =>
				`export const ${own} = Q.query(${own}_P).rule((r) => { ${body} })`
			switch (form) {
				case "inSet":
				case "inSetKind":
					return {
						head,
						line: rule(
							`const { id, f } = Q.v(${lit}, "lit"); return r.match(${lit}, { id, f }).where(r.in(f, [${literal.source}])).find({ id })`
						),
						tail: []
					}
				case "bind":
				case "partialBind":
				case "strayBinding": {
					const bindings =
						form === "bind" ? "{ p: f }" : form === "partialBind" ? "{}" : "{ p: f, stray: f }"
					return {
						head: [...head, importedLine],
						line: rule(
							`const { f } = Q.v(${lit}, "outer"); const bound = ${imported}.bind(${bindings}); const { id } = Q.v(bound, "bound"); return r.match(${lit}, { f }).match(bound, { id }).find({ id })`
						),
						tail:
							form === "bind"
								? [
										`export type ${own}_params = Expect<Equals<keyof Q.ParamsOf<typeof ${own}>, never>>`
									]
								: []
					}
				}
				case "bindingType": {
					const [bound, binding] =
						contractWay === "contract var at base" ? ["c", "{ id, n: c }"] : ["n", "{ id, c: n }"]
					return {
						head,
						line: rule(
							`const { id, ${bound} } = Q.v(${lit}, "lit"); return r.match(${lit}, ${binding}).find({ id })`
						),
						tail: []
					}
				}
				case "negatedBindingType": {
					const binding = contractWay === "contract var at base" ? "{ id, n: i }" : "{ id, i: n }"
					return {
						head,
						line: rule(
							`const { id, i, n } = Q.v(${lit}, "lit"); return r.match(${lit}, { id, i, n }).where(r.not(${lit}, ${binding})).find({ id })`
						),
						tail: []
					}
				}
				case "strayNegation":
					return {
						head,
						line: rule(
							`const { id, f } = Q.v(${lit}, "lit"); return r.match(${lit}, { id, f }).where(r.not(${lit}, { id, stray: f })).find({ id })`
						),
						tail: []
					}
				case "negationParam":
					return {
						head: [...head, importedLine],
						line: rule(
							`const { id } = Q.v(${lit}, "lit"); return r.match(${lit}, { id }).where(r.not(${lit}, { id, f: r.param("p", ${lit}.fields.f) })).find({ id })`
						),
						tail: [
							`export type ${own}_params = Expect<Equals<Q.ParamsOf<typeof ${own}>, Q.ParamsOf<typeof ${imported}>>>`
						]
					}
				case "paramTwice":
					return {
						head,
						line: rule(
							`const { id, f } = Q.v(${lit}, "lit"); return r.match(${lit}, { id, f }).match(${lit}, { id, f: r.param("p", ${lit}.fields.f) }).where(r.eq(f, r.param("p", ${lit}.fields.f))).find({ id })`
						),
						tail: [
							`export type ${own}_params = Expect<Equals<keyof Q.ParamsOf<typeof ${own}>, "p">>`
						]
					}
				case "attach":
				case "foreignAttach": {
					const childSchema = form === "attach" ? `${own}_P` : `${own}_Other`
					const childSource = form === "attach" ? lit : `${own}_Elsewhere`
					return {
						head: [
							...head,
							`export const ${own}_Elsewhere = Sc.relation("Elsewhere", { id: Fi.Id }, ["id"])`,
							`export const ${own}_Other = Sc.schema("Other", [${own}_Elsewhere], [])`
						],
						line: rule(
							`const { id } = Q.v(${lit}, "lit"); return r.match(${lit}, { id }).find({ id }).attach("children", (p) => Q.query(${childSchema}).rule((c) => { const { id: child } = Q.v(${childSource}, "child"); return c.match(${childSource}, { id: p.id }).match(${childSource}, { id: child }).find({ child }) }), "array")`
						),
						tail: []
					}
				}
			}
		},
		judge: (env) => {
			const cents = admitContract("Cents", int8, [])
			const lit = relation(
				"Lit",
				{
					id: Id,
					f: fieldValue(type, env.rosters, env.contracts),
					n: int8,
					c: cents,
					i: int4
				},
				["id"],
				[]
			)
			const p = schema("P", [...Rec.values(Rec.fromEntries([...env.rosters])), lit], [], [])
			const imported = () =>
				queryOver(p).rule((rule: RuleValue) => {
					const vars = varsOver(lit, "inner")
					return rule
						.match(lit, { id: vars["id"], f: vars["f"] })
						.where(
							rule.eq(vars["f"], rule.param("p", fieldValue(type, env.rosters, env.contracts)))
						)
						.find({ id: vars["id"] })
				})
			switch (form) {
				case "inSet":
				case "inSetKind":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							return rule
								.match(lit, { id: vars["id"], f: vars["f"] })
								.where(rule.in(vars["f"], [literal.value]))
								.find({ id: vars["id"] })
						})
					)
				case "bind":
				case "partialBind":
				case "strayBinding": {
					const q = imported()
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const outer = varsOver(lit, "outer")
							const bindings =
								form === "bind"
									? { p: outer["f"] }
									: form === "partialBind"
										? {}
										: { p: outer["f"], stray: outer["f"] }
							const bound = q.bind(bindings)
							const inner = varsOver(bound, "bound")
							return rule
								.match(lit, { f: outer["f"] })
								.match(bound, { id: inner["id"] })
								.find({ id: inner["id"] })
						})
					)
				}
				case "bindingType":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							const binding =
								contractWay === "contract var at base"
									? { id: vars["id"], n: vars["c"] }
									: { id: vars["id"], c: vars["n"] }
							return rule.match(lit, binding).find({ id: vars["id"] })
						})
					)
				case "negatedBindingType":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							const binding =
								contractWay === "contract var at base"
									? { id: vars["id"], n: vars["i"] }
									: { id: vars["id"], i: vars["n"] }
							return rule
								.match(lit, { id: vars["id"], i: vars["i"], n: vars["n"] })
								.where(rule.not(lit, binding))
								.find({ id: vars["id"] })
						})
					)
				case "strayNegation":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							return rule
								.match(lit, { id: vars["id"], f: vars["f"] })
								.where(rule.not(lit, { id: vars["id"], stray: vars["f"] }))
								.find({ id: vars["id"] })
						})
					)
				case "negationParam":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							return rule
								.match(lit, { id: vars["id"] })
								.where(
									rule.not(lit, {
										id: vars["id"],
										f: rule.param("p", fieldValue(type, env.rosters, env.contracts))
									})
								)
								.find({ id: vars["id"] })
						})
					)
				case "paramTwice":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							const param = () => rule.param("p", fieldValue(type, env.rosters, env.contracts))
							return rule
								.match(lit, { id: vars["id"], f: vars["f"] })
								.match(lit, { id: vars["id"], f: param() })
								.where(rule.eq(vars["f"], param()))
								.find({ id: vars["id"] })
						})
					)
				case "attach":
				case "foreignAttach": {
					const elsewhere = relation("Elsewhere", { id: Id }, ["id"], [])
					const other = schema("Other", [elsewhere], [], [])
					const child = (parent: Readonly<Record<string, unknown>>) => {
						const source = form === "attach" ? lit : elsewhere
						return queryOver(form === "attach" ? p : other).rule((rule: RuleValue) => {
							const vars = varsOver(source, "child")
							return rule
								.match(source, { id: parent["id"] })
								.match(source, { id: vars["id"] })
								.find({ child: vars["id"] })
						})
					}
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							return rule
								.match(lit, { id: vars["id"] })
								.find({ id: vars["id"] })
								.attach("children", child, "array")
						})
					)
				}
			}
		}
	}
}

/** The literal values of a literal target's own type: those a literal probe's engine admits at it. */
const literalsOfTarget = (t: LiteralTarget): Arr.NonEmptyReadonlyArray<LiteralValue> => {
	switch (t) {
		case "int4":
			return ["number"]
		case "int8":
			return ["bigint"]
		case "numeric":
			return ["bigint", "decimal", "decimalValue"]
		case "bool":
			return ["boolean"]
		case "closedId":
			return ["handle"]
		case "uuid":
			return ["uuid"]
		case "text":
			return ["handle", "stranger", "uuid", "decimal"]
		case "money":
			return ["moneyValue"]
	}
}

/** The integer types a cast probe's operand and target are drawn from. */
const castTypes = ["int2", "int4", "int8"] as const

/**
 * A generated field of an integer type whose value is its row's integer plus one, cast to the field's type: the engine
 * admits the cast where its bounds prove the sum fits the target and refuses it otherwise, the declared class castFits,
 * which the types accept.
 */
const castProbe = (d: Drawing): Probe => {
	const from = d.from(castTypes)
	const to = d.from(castTypes)
	return {
		construct: "castProbe",
		refused: "castFits",
		text: (_ids, own) =>
			oneLine(
				`export const ${own} = Sc.relation.generated("Cast", { id: Fi.Id, depth: Fi.${from} }, ["id"], (r) => ({ next: Fi.generated(Fi.${to}, Cp.Type.cast(Cp.Num.add(r.depth, ${from === "int8" ? "1n" : "1"}), Fi.${to})) }))`
			),
		judge: () =>
			compiling(() => {
				const cast = generatedRelation(
					"Cast",
					{ id: Id, depth: plainDescriptors[from] },
					["id"],
					(row: Readonly<Record<string, unknown>>) => ({
						next: generatedField(
							plainDescriptors[to],
							computeCore.cast(
								computeCore.add(row["depth"], from === "int8" ? 1n : 1),
								plainDescriptors[to]
							),
							[]
						)
					}),
					[]
				)
				return schema("P", [cast], [], [])
			})
	}
}

/** The forms a fixed-target probe writes: valid, each noted, a source reading a field twice, or an unkeyed target. */
type FixedTargetForm =
	| { readonly kind: "valid"; readonly form: "fixedByValue" | "fixedByTerm" }
	| { readonly kind: "planted"; readonly planted: "repeatedSideTerm" | "unkeyedTarget" }

/** A fixed-target probe's statement as the program writes it, and the type it states of a valid one. */
interface FixedTargetText {
	readonly line: string
	readonly type: string | undefined
}

/** A fixed-target form's statement over the probe's relations `src` and `tgt`, as the program writes it. */
const fixedTargetText = (form: FixedTargetForm, src: string, tgt: string): FixedTargetText => {
	const type = `St.Containment<St.Side<typeof ${src}, readonly ["t"]>, St.Side<St.Selection<typeof ${tgt}>, readonly ["id"]>>`
	switch (form.kind === "valid" ? form.form : form.planted) {
		case "fixedByValue":
			return {
				line: `Sc.contained(Sc.on(${src}, "t"), Sc.on(Sc.select(${tgt}, (r) => r.eq(r.flag, true)), "id"))`,
				type
			}
		case "fixedByTerm":
			return {
				line: `Sc.contained(Sc.on(${src}, "t"), Sc.on(Sc.select(${tgt}, (r) => r.eq(r.ref, r.id)), "id"))`,
				type
			}
		case "repeatedSideTerm":
			return {
				line: `Sc.contained(Sc.on(${src}, "t", "t"), Sc.on(${tgt}, "id", "ref"))`,
				type: undefined
			}
		case "unkeyedTarget":
			return {
				line: `Sc.contained(Sc.on(${src}, "m"), Sc.on(Sc.select(${tgt}, (r) => r.eq(r.flag, true)), "n"))`,
				type: undefined
			}
	}
}

/** A fixed-target form's statement over the relations `src` and `tgt`, built through the engine's cores. */
const fixedTargetValue = (form: FixedTargetForm, src: AnyRelation, tgt: AnyRelation): Statement => {
	const flagged = () =>
		selectBuilder(tgt, (row: Readonly<Record<string, unknown>>) => rowHelpers.eq(row["flag"], true))
	switch (form.kind === "valid" ? form.form : form.planted) {
		case "fixedByValue":
			return containedBuilder(onBuilder(src, ["t"]), onBuilder(flagged(), ["id"]))
		case "fixedByTerm":
			return containedBuilder(
				onBuilder(src, ["t"]),
				onBuilder(
					selectBuilder(tgt, (row: Readonly<Record<string, unknown>>) =>
						rowHelpers.eq(row["ref"], row["id"])
					),
					["id"]
				)
			)
		case "repeatedSideTerm":
			return containedBuilder(onBuilder(src, ["t", "t"]), onBuilder(tgt, ["id", "ref"]))
		case "unkeyedTarget":
			return containedBuilder(onBuilder(src, ["m"]), onBuilder(flagged(), ["n"]))
	}
}

/**
 * A containment over two relations the probe declares, Src(t, m) and Tgt(id, ref, flag, n) keyed by id, into a target
 * whose selection fixes a field beyond its term: to a value, `flag = true`, or to its term, `ref = id`, each keyed by
 * Tgt's id; or a source reading a field twice, refused as a side lists each term once; or a target fixed beyond `n`,
 * which no key holds, the declared class unkeyedTarget. The engine's builders and its compilation are the oracle.
 */
const fixedTargetProbe = (d: Drawing): Probe => {
	const form = d.from<FixedTargetForm>([
		{ kind: "valid", form: "fixedByValue" },
		{ kind: "valid", form: "fixedByTerm" },
		{ kind: "planted", planted: "repeatedSideTerm" },
		{ kind: "planted", planted: "unkeyedTarget" }
	])
	if (form.kind === "valid") {
		d.note(form.form)
	}
	return {
		construct: "fixedTargetProbe",
		refused: form.kind === "planted" ? form.planted : undefined,
		text: (_ids, own) => {
			const src = `${own}_Src`
			const tgt = `${own}_Tgt`
			const statement = fixedTargetText(form, src, tgt)
			return {
				head: [
					`export const ${tgt} = Sc.relation("Tgt", { id: Fi.Id, ref: Fi.Id, flag: Fi.bool, n: Fi.natural }, ["id"])`,
					`export const ${src} = Sc.relation("Src", { t: Fi.Id, m: Fi.natural }, ["t"])`
				],
				line: `export const ${own} = ${statement.line}`,
				tail:
					statement.type === undefined
						? []
						: [`export type ${own}_type = Expect<Equals<typeof ${own}, ${statement.type}>>`]
			}
		},
		judge: () =>
			compiling(() => {
				const tgt = relation(
					"Tgt",
					{
						id: Id,
						ref: Id,
						flag: bool,
						n: naturalDescriptor
					},
					["id"],
					[]
				)
				const src = relation("Src", { t: Id, m: naturalDescriptor }, ["t"], [])
				return schema("P", [src, tgt], [fixedTargetValue(form, src, tgt)], [])
			})
	}
}

/** How a slot side probe writes its side, valid or with one planted fault. */
type SlotSideForm =
	| { readonly fault: undefined; readonly side: LawSide }
	| {
			readonly fault:
				| "predNotNatural"
				| "predUndeclared"
				| "repeatedSideTerm"
				| "selectedUndeclared"
			readonly side: LawSide
	  }
	| { readonly fault: "predClosed" | "keyOverClosed"; readonly roster: string }
	| { readonly fault: "predOfPred" }

/**
 * A side over the slots pack's Parent: field and pred terms over the relation or a selection of it; or a planted fault:
 * pred of a field that is no natural or no field, pred of a closed relation's id, pred of a pred, a pred term twice, a
 * selected side's stranger term, a key over a closed relation's side. The engine's side, pred and key cores and its
 * compilation are the oracle.
 */
const slotSideProbe = (d: Drawing, base: Base): Probe | undefined => {
	const slots = base.slots
	if (slots === undefined) {
		return undefined
	}
	const open: SelectionSpec = { field: "label", value: "open" }
	const parent = (
		selection: SelectionSpec | undefined,
		terms: Arr.NonEmptyReadonlyArray<TermSpec>
	): LawSide => ({
		relation: "Parent",
		selection,
		terms
	})
	const [noted, form] = d.from<readonly [SchemaForm | undefined, SlotSideForm]>([
		["predSide", { fault: undefined, side: lastSlot }],
		[
			"selectedPredSide",
			{ fault: undefined, side: parent(open, [fieldTerm("id"), predTerm("children")]) }
		],
		[
			"fieldAndPredSide",
			{ fault: undefined, side: parent(undefined, [fieldTerm("children"), predTerm("children")]) }
		],
		[
			undefined,
			{
				fault: "predNotNatural",
				side: parent(undefined, [predTerm(d.from(["label", "size", "kind"] as const))])
			}
		],
		[undefined, { fault: "predUndeclared", side: parent(undefined, [predTerm("nope")]) }],
		[
			"predTwice",
			{
				fault: "repeatedSideTerm",
				side: parent(undefined, [predTerm("children"), predTerm("children")])
			}
		],
		[undefined, { fault: "selectedUndeclared", side: parent(open, [fieldTerm("nope")]) }],
		[undefined, { fault: "predClosed", roster: slots.roster }],
		[undefined, { fault: "keyOverClosed", roster: slots.roster }],
		[undefined, { fault: "predOfPred" }]
	])
	if (noted !== undefined) {
		d.note(noted)
	}
	return {
		construct: "slotSideProbe",
		refused: form.fault,
		text: (ids, own) => {
			switch (form.fault) {
				case undefined:
					return {
						head: [],
						line: `export const ${own} = ${lawSideSource(form.side, ids)}`,
						tail: [
							`export type ${own}_side = Expect<Equals<typeof ${own}, ${lawSideType(form.side, ids)}>>`
						]
					}
				case "predNotNatural":
				case "predUndeclared":
				case "repeatedSideTerm":
				case "selectedUndeclared":
					return oneLine(`export const ${own} = ${lawSideSource(form.side, ids)}`)
				case "predClosed":
					return oneLine(`export const ${own} = Sc.on(${ids(form.roster)}, Sc.pred("id"))`)
				case "keyOverClosed":
					return oneLine(`export const ${own} = Sc.key(Sc.on(${ids(form.roster)}, "id"))`)
				case "predOfPred":
					return oneLine(
						`export const ${own} = Sc.on(${ids("Parent")}, Sc.pred(Sc.pred("children")))`
					)
			}
		},
		judge: (env) => {
			switch (form.fault) {
				case undefined:
				case "predNotNatural":
				case "predUndeclared":
				case "repeatedSideTerm":
				case "selectedUndeclared":
					return building(() => lawSideValue(form.side, env.relations))
				case "predClosed":
					return building(() => onBuilder(got(env.rosters, form.roster), [predBuilder("id")]))
				case "keyOverClosed":
					return compiling(() =>
						probeSchema(env, [keyBuilder(onBuilder(got(env.rosters, form.roster), ["id"]))])
					)
				case "predOfPred":
					return building(() => Reflect.apply(predBuilder, undefined, [predBuilder("children")]))
			}
		}
	}
}

/**
 * A containment or a mirror over the slots pack's sides of several terms: the last-slot law either way, valid; or, a
 * planted fault whose refusal is the sides' types differing, sides of two widths, a child's slot and parent swapped,
 * a text against a pred term.
 */
const slotContainmentProbe = (d: Drawing, base: Base): Probe | undefined => {
	if (base.slots === undefined) {
		return undefined
	}
	const children = (
		selection: SelectionSpec | undefined,
		fields: Arr.NonEmptyReadonlyArray<string>
	): LawSide => ({
		relation: "Child",
		selection,
		terms: Arr.map(fields, fieldTerm)
	})
	const lastOnly: LawSide = {
		relation: "Parent",
		selection: undefined,
		terms: [predTerm("children")]
	}
	const marked: SelectionSpec = { field: "label", value: "last" }
	const [noted, fault, statement] = d.from<
		readonly [SchemaForm, SchemaFault | undefined, StatementSpec]
	>([
		["slotContained", undefined, { kind: "contained", left: lastChildren, right: lastSlot }],
		["slotMirrors", undefined, { kind: "mirrors", left: lastSlot, right: lastChildren }],
		[
			"slotArity",
			"sidesDiffer",
			{ kind: "contained", left: children(undefined, ["parent", "at"]), right: lastOnly }
		],
		[
			"slotMirrorsArity",
			"sidesDiffer",
			{ kind: "mirrors", left: children(undefined, ["parent", "at"]), right: lastOnly }
		],
		[
			"slotSwapped",
			"sidesDiffer",
			{ kind: "contained", left: children(marked, ["at", "parent"]), right: lastSlot }
		],
		[
			"slotLabel",
			"sidesDiffer",
			{ kind: "contained", left: children(undefined, ["label"]), right: lastOnly }
		]
	])
	d.note(noted)
	return {
		construct: "slotContainmentProbe",
		refused: fault,
		text: (ids, own) => ({
			head: [],
			line: `export const ${own} = ${statementSource(statement, ids)}`,
			tail:
				fault === undefined && (statement.kind === "contained" || statement.kind === "mirrors")
					? [
							`export type ${own}_law = Expect<Equals<typeof ${own}, St.${statement.kind === "contained" ? "Containment" : "Mirrors"}<${lawSideType(statement.left, ids)}, ${lawSideType(statement.right, ids)}>>>`
						]
					: []
		}),
		judge: (env) => compiling(() => probeSchema(env, [statementValue(statement, env)]))
	}
}

/** The probes a case draws: for each probe construct its swarm keeps, one or two of it. */
const probeMakers: ReadonlyArray<
	readonly [SchemaConstruct, (d: Drawing, base: Base) => Probe | undefined]
> = [
	["keyProbe", keyProbe],
	["sideProbe", sideProbe],
	["rosterProbe", (d) => rosterProbe(d)],
	["handleProbe", handleProbe],
	["containmentProbe", containmentProbe],
	["mutableProbe", mutableProbe],
	["schemaProbe", schemaProbe],
	["roleProbe", roleProbe],
	["derivedProbe", derivedProbe],
	["predicateProbe", predicateProbe],
	["literalProbe", literalProbe],
	["familyProbe", familyProbe],
	["fieldProbe", fieldProbe],
	["closedRelationProbe", closedRelationProbe],
	["valueProbe", (d) => vectorProbe(d)],
	["valueProbe", (d) => uuidProbe(d)],
	["valueProbe", bitsProbe],
	["contractNameProbe", (d) => contractNameProbe(d)],
	["closedReadProbe", closedReadProbe],
	["castProbe", (d) => castProbe(d)],
	["generatedProbe", generatedProbe],
	["mintedProbe", (d) => mintedProbe(d)],
	["unnamedIdProbe", (d) => unnamedIdProbe(d)],
	["ruleProbe", ruleProbe],
	["slotKeyProbe", (d) => slotKeyProbe(d)],
	["slotSideProbe", slotSideProbe],
	["slotContainmentProbe", slotContainmentProbe],
	["fixedTargetProbe", (d) => fixedTargetProbe(d)],
	["derivedProbe", derivedSideProbe]
]

/** A drawn case: its base, its probes, and the constructs its drawing reached. */
interface Drawn {
	readonly base: Base
	readonly probes: ReadonlyArray<Probe>
	readonly reached: ReadonlySet<SchemaConstruct | SchemaForm>
}

const drawnGen: Gen<Drawn> = (source) => {
	const d = new Drawing(source, source.draw(swarm(schemaConstructs)))
	const base = baseOf(d)
	const probes = Arr.flatMap(probeMakers, ([, make]) =>
		Arr.flatMap(
			upTo(d.upTo(1) + 2, (i) => i),
			() => {
				const probe = make(d, base)
				return probe === undefined ? [] : [probe]
			}
		)
	)
	return { base, probes, reached: d.reached }
}

/** A probe as the program states it: its lines, the directive above its statement where the engine refuses it. */
interface Stated {
	readonly lines: (ids: Ids, own: string) => ReadonlyArray<string>
	readonly notes: ReadonlyArray<SchemaNote>
}

/**
 * A probe's verdict: admitted, its construct noted and no directive; or refused, which must be the fault the probe
 * may be refused for, with the reason that fault predicts, under the directive of the diagnostic the types raise for
 * it. A refusal of a probe that plants no fault, or for another reason, is a defect of the generator or a disagreement
 * of the engine with itself, and fails the run.
 */
const statedOf = (probe: Probe, env: Env): Stated => {
	const judged = probe.judge(env)
	if (judged.kind === "admitted") {
		return {
			lines: (ids, own) => {
				const text = probe.text(ids, own, env)
				return [...text.head, text.line, ...text.tail]
			},
			notes: [probe.construct]
		}
	}
	if (probe.refused === undefined) {
		throw new Error(
			`the oracle refuses a ${probe.construct} with no fault, a defect of the generator: ${judged.message}`
		)
	}
	const planted = probe.refused
	if (isDeclared(planted)) {
		if (judged.key !== expectedKey(declared[planted])) {
			throw new Error(
				`the engine refuses a declared ${planted} for ${judged.key}, not ${expectedKey(declared[planted])}: ${judged.message}`
			)
		}
		return {
			lines: (ids, own) => {
				const text = probe.text(ids, own, env)
				return [...text.head, text.line, ...text.tail]
			},
			notes: [planted]
		}
	}
	const refusing = refusals[planted]
	if (judged.key !== refusingKey(refusing)) {
		throw new Error(
			`the oracle refuses a probe planting ${probe.refused} for ${judged.key}, not ${refusingKey(refusing)}: ${judged.message}`
		)
	}
	const directive =
		refusing.kind === "structural"
			? `// @ts-expect-error -- refused: ${refusing.why}`
			: `// @ts-expect-error -- refusal: ${refusing.refusal}`
	return {
		lines: (ids, own) => {
			const text = probe.text(ids, own, env)
			return [...text.head, directive, text.line, ...text.tail]
		},
		notes: [planted, ...namedOf(refusing)]
	}
}

/**
 * The relations of `level` a ChangeSet over it inserts at its top level, in its record's order, as the engine reads
 * them: each whose insert from an array it builds and compiles over reality, beside an insert of the owner of the base's
 * ordered or counted family when the relation is its member, since an append to an immutable owner's family needs its
 * owner inserted in its stratum. insertableNamesOf(level) must name exactly these, in this order, and the engine must
 * compile an insert of all of them at once, as insertAll of InsertAllRowsOf does.
 */
const topLevelInserts = (
	level: AnySchema,
	family: FamilySpec | undefined
): ReadonlyArray<string> => {
	const artifacts = testArtifacts(level, testCompile)
	if (!artifacts.ok) {
		throw new Error(
			`the engine refuses a drawn schema, a defect of the generator: ${messageOf(artifacts.error)}`
		)
	}
	const checked = checking(level)
	const options = realityWrite(artifacts.value)
	const compiles = (names: ReadonlyArray<string>): boolean => {
		const built = catchCompileError(() =>
			changeSetOver.empty(level).insertAll(Rec.fromEntries(Arr.map(names, (n) => [n, []] as const)))
		)
		if (!built.ok) {
			return false
		}
		const desc = changeSetDesc(built.value)
		if (desc === undefined) {
			throw new Error("a ChangeSet the facade built has no Description")
		}
		return compileWrite(checked, desc, options).ok
	}
	const ownerOf = (name: string): ReadonlyArray<string> =>
		family !== undefined && family.kind !== "tree" && family.member.relation === name
			? [family.owner]
			: []
	const inserts = Arr.filter(Rec.keys(level.relations), (name) =>
		compiles([name, ...ownerOf(name)])
	)
	assert.deepEqual(
		insertableNamesOf(level),
		inserts,
		"insertableNamesOf names the relations the engine inserts at the top level, in record order"
	)
	if (!compiles(inserts)) {
		throw new Error(
			`the engine refuses an insert of every top-level relation at once: ${Arr.join(inserts, ", ")}`
		)
	}
	return inserts
}

/**
 * The top-level inserts of a level of the case, stated as types: InsertableNameOf is the engine's names, InsertAllRowsOf
 * is keyed by them, and insertAll takes it.
 */
const insertableLines = (
	level: "S" | "Level",
	inserts: ReadonlyArray<string>,
	ids: Ids
): ReadonlyArray<string> => [
	`export type ${ids(`t_insertable_${level}`)} = Expect<Equals<Cs.InsertableNameOf<typeof ${ids(level)}>, ${literalUnion(inserts)}>>`,
	`export type ${ids(`t_rows_${level}`)} = Expect<Equals<keyof Cs.InsertAllRowsOf<typeof ${ids(level)}>, ${literalUnion(inserts)}>>`,
	`declare const ${ids(`rows_${level}`)}: Cs.InsertAllRowsOf<typeof ${ids(level)}>`,
	`export const ${ids(`insertAll_${level}`)} = Cs.ChangeSet.empty(${ids(level)}).insertAll(${ids(`rows_${level}`)})`
]

/** One case: its base's declarations and assertions, its probes' statements, and what it reached. */
export interface SchemaCase {
	readonly lines: (prefix: string) => ReadonlyArray<string>
	readonly notes: ReadonlySet<SchemaNote>
}

const caseOf = ({ base, probes, reached }: Drawn): SchemaCase => {
	const built = catchCompileError(() => envOf(base))
	if (!built.ok) {
		throw new Error(
			`the engine refuses a drawn base, a defect of the generator: ${messageOf(built.error)}`
		)
	}
	const env = built.value
	const compiled = testArtifacts(env.level, testCompile)
	if (!compiled.ok) {
		throw new Error(
			`the engine refuses a drawn schema, a defect of the generator: ${messageOf(compiled.error)}`
		)
	}
	const stated = Arr.map(probes, (p) => statedOf(p, env))
	const assertions = (ids: Ids) => baseAssertions(base, env, compiled.value, ids)
	const levels: ReadonlyArray<readonly ["S" | "Level", ReadonlyArray<string>]> = [
		["S", topLevelInserts(env.schema, base.family)],
		...(base.derived === undefined
			? []
			: [["Level", topLevelInserts(env.level, base.family)] as const])
	]
	return {
		lines: (prefix) => {
			const ids: Ids = (name) => `${prefix}_${name}`
			return [
				...Arr.map(
					baseDeclarations(base, ids),
					([name, source]) => `export const ${ids(name)} = ${source}`
				),
				...assertions(ids),
				...Arr.flatMap(levels, ([level, inserts]) => insertableLines(level, inserts, ids)),
				...Arr.flatMap(stated, (s, i) => s.lines(ids, `${prefix}_p${i}`))
			]
		},
		notes: new Set<SchemaNote>([...reached, ...Arr.flatMap(stated, (s) => s.notes)])
	}
}

/** The label the kept faults' base is drawn under: the old floor stream's first base. */
const schemaLabel = "types/schema agreement"

/** A drawn schema with its probes, the engine's description of it, and what it reached. */
const schemaCases: Gen<SchemaCase> = (source) => caseOf(drawnGen(source))

/**
 * A case reaching unorderedMax, a fold's max over a closed id of an unordered roster, which the engine and the types
 * refuse: a drawn case reaches it only where a family probe plants a monoid's mismatch over a base declaring Tier and
 * draws max among its four monoids, which no witness of the merged tree did (the agreement's floor and steered cases
 * are fixed by its identity). A drawn base declaring both rosters of the pool, and one fold over it planting max's
 * mismatch, its family of either order.
 */
const unorderedMaxCases: Gen<SchemaCase> = (source) => {
	const d = new Drawing(source, source.draw(swarm(schemaConstructs)))
	const base: Base = { ...baseOf(d), rosters: rosterPool }
	const fold = foldProbe(d, base, {
		fault: "monoidMismatch",
		refined: false,
		order: d.from(["ordered", "counted"] as const),
		monoid: "max"
	})
	return caseOf({ base, probes: [fold], reached: d.reached })
}

/** The drawn schemas and probes, aimed at the situation no witness of theirs reaches (unorderedMaxCases). */
export const schemaAimed = aimed(schemaCases, [["unorderedMax", unorderedMaxCases]])

/** The cells of schemaKeptBox, minted as a dictionary in its door (test/types/schema/agreement.dictionary.ts). */
export const schemaKeptBoxItems = keptFaults

/**
 * A kept fault's case: the base the floor stream of the agreement's label drew first, under that fault's probe alone
 * (selectedMemberProbe).
 */
export const keptFaultCase = (fault: KeptFault): SchemaCase =>
	caseOf({
		base: defined(sample(drawnGen, floorSeed(schemaLabel), 1)[0], "the floor stream's first draw")
			.base,
		probes: [selectedMemberProbe(fault)],
		reached: new Set()
	})

/** Every Refusal message a fault's directive names. */
const namedRefusals: ReadonlyArray<Refused> = Arr.dedupe(
	Arr.flatMap(schemaFaults, (f) => namedOf(refusals[f]))
)

/**
 * What the floor's witnesses must reach: every construct, every fault refused by the engine, and every Refusal
 * message the faults' directives name.
 */
export const schemaRequired: Arr.NonEmptyReadonlyArray<SchemaNote> = [
	...schemaConstructs,
	...schemaForms,
	...schemaFaults,
	...declaredClasses,
	...namedRefusals
]

/** The modules the program imports, each spelled as an import specifier relative to the program's directory. */
interface SchemaEntries {
	readonly schema: string
	readonly fields: string
	readonly text: string
	readonly query: string
	readonly changeset: string
	readonly fieldTypes: string
	readonly statementTypes: string
	readonly decoder: string
	readonly compute: string
	readonly phantom: string
	readonly relationTypes: string
	readonly result: string
	readonly errors: string
}

/**
 * Each namespace's prelude (test/support/programs/schemas, test/support/prelude.ts) as the program's directory reaches
 * it: the program reads every repository name through these, each a module of the names it reads of one module.
 */
const schemaEntriesFrom = (entry: (path: string) => string): SchemaEntries => {
	const prelude = (name: string): string => entry(`test/support/programs/schemas/${name}.ts`)
	return {
		schema: prelude("schema"),
		fields: prelude("fields"),
		text: prelude("text"),
		query: prelude("query"),
		changeset: prelude("changeset"),
		fieldTypes: prelude("field"),
		statementTypes: prelude("statements"),
		decoder: prelude("decoder"),
		compute: prelude("compute"),
		phantom: prelude("phantom"),
		relationTypes: prelude("relation"),
		result: prelude("result"),
		errors: prelude("errors")
	}
}

/**
 * The program of a batch of cases, each a module of its own, `case-<i>.ts`, its names prefixed `c<i>_`, so tsgo's
 * checkers, which take a program's files round robin, spread the cases over every checker. Every module opens with the
 * same imports and helper types, the batch's own, the helpers exported and the imports exported again as types, so a
 * case that reads only some of them leaves none unused; the rest of the module is the case's.
 */
export const schemaProgram = (
	cases: Arr.NonEmptyReadonlyArray<SchemaCase>,
	entry: ProgramEntry
): Program => {
	const entries = schemaEntriesFrom(entry)
	const header = [
		"// Generated by test/support/agreement/schemas.ts: the schema agreement program, one module per case.",
		'import type { Brand } from "effect"',
		`import type * as Cd from ${jsonText(entries.decoder)}`,
		`import * as Cp from ${jsonText(entries.compute)}`,
		`import type * as Ph from ${jsonText(entries.phantom)}`,
		`import type * as Rf from ${jsonText(entries.relationTypes)}`,
		`import type * as Er from ${jsonText(entries.errors)}`,
		`import type * as Rs from ${jsonText(entries.result)}`,
		`import * as Cs from ${jsonText(entries.changeset)}`,
		`import type * as Ff from ${jsonText(entries.fieldTypes)}`,
		`import * as Fi from ${jsonText(entries.fields)}`,
		`import * as Q from ${jsonText(entries.query)}`,
		`import * as Sc from ${jsonText(entries.schema)}`,
		`import type * as St from ${jsonText(entries.statementTypes)}`,
		`import * as Tx from ${jsonText(entries.text)}`,
		"",
		"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
		"export type Expect<T extends true> = T",
		"/** Mutual assignability: a nested addition's intersections and omissions are no object type to compare exactly. */",
		"export type Alike<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false",
		"/** The names of the relations a ChangeSet over S may write: ordinary, never closed or derived. */",
		"export type WritableNames<S> = Cs.WritableOf<S> extends infer R ? (R extends { readonly name: infer N } ? N : never) : never",
		"export type { Brand, Cd, Cp, Ph, Rf, Er, Rs, Cs, Ff, Fi, Q, Sc, St, Tx }",
		"/** The key every probe's contract is under, and its mint, which makes their values. */",
		'export const Key = Symbol("Domain")',
		"export const toKey = Fi.mintOf(Key)",
		"/** The key each contract of the pool is under, its own (types/fields KeyApart). */",
		...Arr.map(contractNames, (n) => `export const ${keyName(n)} = Symbol(${jsonText(n)})`),
		""
	]
	return Arr.map(cases, (c, i) => ({
		file: `case-${i}.ts`,
		parts: [
			{ owner: batchOwned, lines: header },
			{ owner: caseOwned(i), lines: [...c.lines(`c${i}`), ""] }
		]
	}))
}
