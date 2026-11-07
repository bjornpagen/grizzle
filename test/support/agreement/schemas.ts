import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { DerivedRefusal, RoleRule } from "#compiler/core/causes.ts"
import type { Column } from "#compiler/core/decoder.ts"
import type {
	CompileError,
	CompileReason,
	CompileReasonTag,
	PreconditionKind,
	ValueFault
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	descText,
	expandAlternatives,
	type RoleDesc,
	type FieldDecl,
	type FieldDesc,
	type SideDesc,
	type StatementDesc,
	type TermDesc
} from "#compiler/ir/desc.ts"
import type { Heading as Columns } from "#compiler/ir/rel.ts"
import { contractOf, sameScalarType, type ScalarType } from "#compiler/ir/scalar.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { bits, closedId, Decimal, Money, Vector } from "#compiler/public/fields.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { dateDescriptor } from "#compiler/scalar/date.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { floatOf, pgDescriptors } from "#compiler/scalar/pg.ts"
import { carrierSql, describeField, describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { admitEncodable } from "#compiler/scalar/values/vector.ts"
import { literalResult } from "#compiler/schema/literal.ts"
import {
	accumulatedField,
	admitClosedRelation,
	admitRoster,
	bitsOf,
	closed,
	derived,
	drawnField,
	closedRelation,
	generatedField,
	generatedRelation,
	relation,
	relationDescOf,
	slotField,
	writingOf
} from "#compiler/schema/relation.ts"
import { admitSchema, schema } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
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
	treeBuilder
} from "#compiler/schema/statements.ts"
import { rowHelpers } from "#compiler/schema/terms.ts"
import { role, roleDescOf } from "#compiler/schema/world.ts"
import { regexField, str } from "#compiler/text/field.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation, AnyRoster } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import { admitContract, spanDescriptor } from "#test/support/fixtures/descriptors.ts"
import { messageOf } from "#test/support/message.ts"
/**
 * The schema agreement: schemas drawn as data, each with the engine's verdict on it and on probe statements beside it,
 * and the one TypeScript program that states every verdict as types, which the type tier checks
 * (test/types/schema/agreement.test.ts). The engine is the oracle:
 * - a program typechecks exactly when the engine builds and compiles it: every probe the engine refuses stands under a
 *   directive naming the diagnostic its fault raises, `Refusal<"…">` where the types name the refusal, and the batch
 *   checks the program disarmed, so a probe the types refuse and the engine admits is a diagnostic no directive names,
 *   and one they admit and the engine refuses a directive whose diagnostic never comes;
 * - every fact type, addition, nested addition, key, key lookup, serial set, write list, projection head, statement,
 *   descriptor, literal, closed read and text language the types infer equals what the engine describes: the host type
 *   of each field's scalar type, the fields its writing leaves to the caller, the families its statements nest, the
 *   candidate keys its laws state, each statement's Description, each descriptor's Description and writing.
 *
 * A case is drawn as data (SchemaCase) and read twice: rendered as TypeScript, and built through the builders'
 * JavaScript cores (schema/relation.ts, schema/statements.ts, schema/world.ts, the descriptor cores of
 * test/support/fixtures/descriptors.ts) and compiled as the runtime compiles it (testArtifacts). Its base is valid by
 * construction: rosters, contracts, relations of drawn fields and keys, key, containment and mutable statements, a
 * family with its folds, an alternatives law, a closed relation with a relation whose fields PostgreSQL generates from
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
 * The draws are two populations of one generator: the floor's witnesses (floorPopulation), the same on every run, which
 * alone meet the required situations, and the run's own stream under the run's seed, new every run.
 */
/** The constructs a case may hold, each a swarm feature: a part of its base, or a probe beside it. */
const schemaConstructs = [
	"secondRoster",
	"contract",
	"nestedContract",
	"regexField",
	"numericField",
	"floatField",
	"dateField",
	"moneyField",
	"vectorField",
	"spanField",
	"closedIdField",
	"bitsField",
	"serialField",
	"keyStatement",
	"containment",
	"mutableStatement",
	"alternatives",
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
	"alternativesProbe",
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
	"serialChainProbe",
	"generatedProbe",
	"slotKeyProbe",
	"slotSideProbe",
	"slotContainmentProbe",
	"valueProbe",
	"contractNameProbe"
] as const
type SchemaConstruct = (typeof schemaConstructs)[number]

/**
 * The forms of a construct whose inferences no other form asserts, each noted where it is drawn: the slots pack's
 * mirror and selected key, each side a slot side probe writes, each law a slot containment probe states, each aggregate
 * a derived head reads, each place a law names a derived relation, each derived definition the engine admits, fin
 * over a key field and over an accumulated one, a closed relation keyed by one, two or three closed ids, its rows with
 * one stated twice, a role over a base declaring one, and a concat fold valid and over a number.
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
	"derivedSerial",
	"derivedLeft",
	"derivedRight",
	"derivedMirrors",
	"derivedOverLevels",
	"derivedBoundImport",
	"derivedDiscriminated",
	"derivedProjection",
	"derivedSkipsLevel",
	"finOfKey",
	"finOfAccumulated",
	"closedKeyOne",
	"closedKeyTwo",
	"closedKeyThree",
	"closedRepeatedRow",
	"paramTwice",
	"bindOuterVariable",
	"negationParam",
	"concatFold",
	"concatMismatch",
	"roleBesideClosed"
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
	"emptyRoster",
	"repeatedHandle",
	"foreignHandle",
	"sidesDiffer",
	"mutableClosed",
	"noArms",
	"strayArm",
	"selfArm",
	"armKeyMismatch",
	"foreignDiscriminator",
	"aliasedRelation",
	"undeclaredStatementRelation",
	"finMember",
	"entryOutsideBase",
	"writeClosed",
	"writeStranger",
	"writeDerived",
	"refreshBase",
	"parameterizedDefinition",
	"derivedAtOwnLevel",
	"derivedInRoot",
	"keyOverDerived",
	"sideOverDerived",
	"mutableDerived",
	"checkOverDerived",
	"selectOverDerived",
	"derivedParent",
	"derivedArm",
	"parameterizedCheck",
	"parameterizedSelect",
	"parameterizedContract",
	"literalKind",
	"finNotDrawn",
	"countedPair",
	"monoidMismatch",
	"endPlanes",
	"treeParentType",
	"drawnNotNatural",
	"accumulatedWriting",
	"accumulatedStart",
	"rowMissingField",
	"contractOverSerial",
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
	"serialUnderContract",
	"spanOverSerialChain",
	"setPrimaryKey",
	"setKey",
	"conflictingRow",
	"generatedReadsGenerated",
	"generatedReadsAccumulated",
	"generatedReadsDrawn",
	"generatedWrongType",
	"generatedTwiceNamed",
	"generatedKey",
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
	"finOverDerived",
	"emptyHead",
	"headingGroups",
	"derivedOverBase"
] as const
type SchemaFault = (typeof schemaFaults)[number]

/**
 * The declared classes: declarations the types accept and the engine refuses, each for the one reason it states,
 * decided at compilation from what the types do not track. A containment, or a mirror, into a side that holds no key of
 * its relation (unkeyedTarget): the law family needs a key over the side's projection. A cast its operand's bounds do
 * not prove fits its target (castFits): the engine proves the value fits from the bounds its making gives it, which
 * no type carries.
 */
const declaredClasses = ["unkeyedTarget", "castFits"] as const
type DeclaredClass = (typeof declaredClasses)[number]

/** What a probe plants: a fault the types refuse, or a declared class they accept. */
type Planted = SchemaFault | DeclaredClass

const isDeclared = (planted: Planted): planted is DeclaredClass =>
	Arr.contains<Planted>(declaredClasses, planted)

/** Each declared class's refusal by the engine. */
const declared: { readonly [C in DeclaredClass]: Expected } = {
	unkeyedTarget: { tag: "UnsupportedLawFamily" },
	castFits: { tag: "PartialOperation", precondition: "fits" }
}

/**
 * What a case reached: its constructs, the faults the engine refused, the declared classes it refused, and the
 * refusals the types named.
 */
type SchemaNote = SchemaConstruct | SchemaForm | SchemaFault | DeclaredClass | TypeRefusal

/** A diagnostic's code. */
type Code = "TS2322" | "TS2339" | "TS2345" | "TS2554" | "TS2555" | "TS2739" | "TS2741"

/** What a directive claims of its diagnostic: a structural refusal's reason, or the refusal grizzle's type names. */
type Claimed =
	| { readonly kind: "prose"; readonly why: string }
	| { readonly kind: "refusal"; readonly message: TypeRefusal }

/**
 * A fault's refusal on both sides: the engine's reason, as reasonKey reads it, and the diagnostic the types raise on
 * the probe's line, with its claim.
 */
interface Refusing {
	readonly engine: Expected
	readonly code: Code
	readonly claim: Claimed
}

const prose = (why: string): Claimed => ({ kind: "prose", why })
const named = (message: TypeRefusal): Claimed => ({ kind: "refusal", message })

/** Each fault's refusal: the engine's reason, and the diagnostic the types raise with its claim. */
const refusals: { readonly [F in SchemaFault]: Refusing } = {
	emptyKey: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a primary key names at least one field")
	},
	undeclaredKeyField: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("the primary key names declared fields")
	},
	repeatedKeyField: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a key lists each field once")
	},
	repeatedSideTerm: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a side lists each term once")
	},
	emptySide: {
		engine: { tag: "MalformedDescription" },
		code: "TS2555",
		claim: prose("a side names at least one term")
	},
	undeclaredSideTerm: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a side's terms are fields of its source")
	},
	emptyRoster: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a roster holds at least one handle")
	},
	repeatedHandle: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a roster lists each handle once")
	},
	foreignHandle: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a handle is a member of its roster")
	},
	sidesDiffer: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("the sides' field types differ")
	},
	mutableClosed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2739",
		claim: prose("mutable takes ordinary relations; a closed relation is immutable by nature")
	},
	noArms: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("alternatives takes at least one arm")
	},
	strayArm: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("an arm is keyed by a handle of its roster")
	},
	selfArm: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("an arm is a relation other than its parent")
	},
	armKeyMismatch: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("the arm's key does not match the parent key")
	},
	foreignDiscriminator: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("the discriminator is a closed id of the roster")
	},
	aliasedRelation: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("a schema holds each relation under its own name")
	},
	undeclaredStatementRelation: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a statement names a relation no level of the schema declares")
	},
	finMember: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a schema's members are relations, and fin(O, n) is none")
	},
	entryOutsideBase: {
		engine: { tag: "RoleRefused", rule: "wholeEntryUndeclared" },
		code: "TS2322",
		claim: named("a whole entry is a relation of the base under its own name")
	},
	writeClosed: {
		engine: { tag: "RoleRefused", rule: "writeKind" },
		code: "TS2345",
		claim: prose("a write list names ordinary relations and query entries only")
	},
	writeStranger: {
		engine: { tag: "RoleRefused", rule: "writeOutside" },
		code: "TS2345",
		claim: prose("a write list names relations of the role")
	},
	writeDerived: {
		engine: { tag: "RoleRefused", rule: "writeKind" },
		code: "TS2345",
		claim: prose("a write list never names a derived relation")
	},
	refreshBase: {
		engine: { tag: "RoleRefused", rule: "refreshKind" },
		code: "TS2345",
		claim: prose("a refresh list names derived relations only")
	},
	parameterizedDefinition: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a derived definition is parameterless")
	},
	derivedAtOwnLevel: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a derived relation is declared above the level its definition reads")
	},
	derivedInRoot: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a root schema declares no derived relation; schema.extend does")
	},
	keyOverDerived: {
		engine: { tag: "LawOnDerived" },
		code: "TS2345",
		claim: prose("a key's side is never over a derived relation")
	},
	sideOverDerived: {
		engine: { tag: "LawOnDerived" },
		code: "TS2345",
		claim: named("the sides' field types differ")
	},
	mutableDerived: {
		engine: { tag: "LawOnDerived" },
		code: "TS2739",
		claim: prose("mutable takes ordinary relations only")
	},
	checkOverDerived: {
		engine: { tag: "LawOnDerived" },
		code: "TS2739",
		claim: prose("check takes ordinary relations only")
	},
	selectOverDerived: {
		engine: { tag: "LawOnDerived" },
		code: "TS2345",
		claim: prose("a selection is never over a derived relation")
	},
	derivedParent: {
		engine: { tag: "LawOnDerived" },
		code: "TS2345",
		claim: prose("alternatives takes no derived parent")
	},
	derivedArm: {
		engine: { tag: "LawOnDerived" },
		code: "TS2322",
		claim: named("the arm's key does not match the parent key")
	},
	parameterizedCheck: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("a schema predicate reads no parameter")
	},
	parameterizedSelect: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("a schema predicate reads no parameter")
	},
	parameterizedContract: {
		engine: { tag: "UnsupportedOperation" },
		code: "TS2345",
		claim: named("a schema predicate reads no parameter")
	},
	literalKind: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a literal is a host value of its field's kind")
	},
	finNotDrawn: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("fin's count is a drawn natural of its owner")
	},
	countedPair: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a fold over a counted family hides its accumulators: name the step's value alone")
	},
	monoidMismatch: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named(
			"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text"
		)
	},
	endPlanes: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a fold's end names one accumulated field of the owner per plane")
	},
	treeParentType: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a tree is a family of T over itself, on(T, parent, at), with drawn start and end")
	},
	drawnNotNatural: {
		engine: { tag: "MalformedDescription" },
		code: "TS2741",
		claim: prose("a drawn field is a natural")
	},
	accumulatedWriting: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named(
			"an accumulated field is of a value type: no span, vector or field of a writing of its own"
		)
	},
	accumulatedStart: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("an accumulated field's start is a value of its type")
	},
	rowMissingField: {
		engine: { tag: "MalformedDescription" },
		code: "TS2741",
		claim: prose("a closed relation's row holds every field")
	},
	contractOverSerial: {
		engine: { tag: "UnsupportedOperation" },
		code: "TS2345",
		claim: named(
			"a contract is a value domain; a serial is a generation declaration, so use its integer type"
		)
	},
	endpointType: {
		engine: { tag: "UnsupportedOperation" },
		code: "TS2345",
		claim: prose("a span's endpoint is an integer or a bigint, or a contract over one")
	},
	widthType: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a span's width is a value of its endpoint's host type")
	},
	numericArity: {
		engine: { tag: "MalformedDescription" },
		code: "TS2554",
		claim: prose("a numeric declares its precision and its scale")
	},
	argumentKind: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a precision, a scale and a dimension count are numbers")
	},
	vectorMakeBuffer: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("Vector.make takes a Float32Array, never an array of numbers")
	},
	vectorFromBuffer: {
		engine: { value: "vectorType" },
		code: "TS2345",
		claim: prose("Vector.from takes a Float32Array or a Vector of its dimensions")
	},
	vectorDimensionArgument: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("the dimension count is a number")
	},
	vectorAssign: {
		engine: { value: "vectorDimensions" },
		code: "TS2322",
		claim: prose("a vector of other dimensions is another type")
	},
	vectorFromOther: {
		engine: { value: "vectorDimensions" },
		code: "TS2345",
		claim: prose("Vector.from refuses a vector of other dimensions, which no conversion reaches")
	},
	uuidSpelling: {
		engine: { value: "uuidSyntax" },
		code: "TS2322",
		claim: prose("a text of other than five hyphenated groups is no uuid")
	},
	bitsStranger: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a set lists handles of its roster")
	},
	bitsRepeated: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a set lists each of its handles once")
	},
	predNotNatural: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("pred reads a natural field")
	},
	predUndeclared: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("pred reads a field of the side's relation")
	},
	predClosed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a closed relation has no natural field for pred to read")
	},
	predOfPred: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("pred is one level deep: its argument is a field name, never a pred term")
	},
	selectedUndeclared: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a selected side's terms are its relation's fields")
	},
	keyOverClosed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose(
			"key takes a side of an ordinary relation; a closed relation is keyed by its declaration"
		)
	},
	inSetKind: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("inSet lists literals of its term's type")
	},
	partialBind: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("bind binds every parameter of the query it imports")
	},
	strayBinding: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("not a field of the arms the bindings select")
	},
	strayNegation: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("not a field of the arms the bindings select")
	},
	bindingType: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a variable binds a field of its own type, a contract's never its bare base's")
	},
	negatedBindingType: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a variable binds a field of its own type, a contract's never its bare base's")
	},
	foreignAttach: {
		engine: { tag: "ForeignLevel" },
		code: "TS2322",
		claim: prose("an arm attaches a child over a level of its rule's schema")
	},
	serialUnderContract: {
		engine: { tag: "UnsupportedOperation" },
		code: "TS2345",
		claim: named(
			"a contract is a value domain; a serial is a generation declaration, so use its integer type"
		)
	},
	spanOverSerialChain: {
		engine: { tag: "UnsupportedOperation" },
		code: "TS2345",
		claim: prose("a span endpoint's contract chain holds no serial")
	},
	setPrimaryKey: {
		engine: { tag: "UnrepresentableKey" },
		code: "TS2322",
		claim: prose("a primary key lists no set")
	},
	setKey: {
		engine: { tag: "UnrepresentableKey" },
		code: "TS2345",
		claim: named("a key lists no set: a set's bit string is too wide for an index entry")
	},
	conflictingRow: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named(
			"two facts of one relation share a key with different values; a key names one fact"
		)
	},
	generatedReadsGenerated: {
		engine: { tag: "MalformedDescription" },
		code: "TS2339",
		claim: prose("the row holds the written fields only, so no generated field reads another")
	},
	generatedReadsAccumulated: {
		engine: { tag: "GeneratedRefused" },
		code: "TS2339",
		claim: prose("the row holds the fields its caller writes, never one grizzle accumulates")
	},
	generatedReadsDrawn: {
		engine: { tag: "GeneratedRefused" },
		code: "TS2339",
		claim: prose("the row holds the fields its caller writes, never one grizzle draws")
	},
	generatedWrongType: {
		engine: { tag: "GeneratedRefused" },
		code: "TS2345",
		claim: prose("a generated field's term is of its declared type exactly, at its own position")
	},
	generatedTwiceNamed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: named("a generated field is named apart from the relation's written fields")
	},
	generatedKey: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("the primary key names written fields")
	},
	finOverClosedNotNatural: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("fin over a closed relation names a natural field, and label is a closed id")
	},
	slotOverOrdinary: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a slot reads a closed relation's fin, and Owner is an ordinary relation")
	},
	slotNotClosed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2741",
		claim: prose("a slot is a closed id, and pg.integer lacks a closed id's roster")
	},
	familyOverClosed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("an ordered family's side is its owner's key, then its drawn index")
	},
	closedKeyNotClosed: {
		engine: { tag: "MalformedDescription" },
		code: "TS2322",
		claim: prose("a closed relation's key fields are closed ids")
	},
	closedFifthArgument: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a closed relation takes four arguments, a fifth typed never")
	},
	crossSet: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a set over one roster is never a set over another")
	},
	lookAlikeDescriptor: {
		engine: { tag: "MalformedDescription" },
		code: "TS2741",
		claim: prose("a look-alike lacks the brand of a builder's descriptor")
	},
	concatCounted: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named(
			"a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree"
		)
	},
	concatHidden: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named(
			"a concat fold names its (before, after) pair after its value: its law reads each member's running value"
		)
	},
	countedSide: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("a counted family's side is its owner's key")
	},
	finOverDerived: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose(
			"fin reads a relation's drawn count or a closed relation's natural field, never a derived relation's"
		)
	},
	derivedOverBase: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: named("the relation is not in this query's schema")
	},
	emptyHead: {
		engine: { tag: "DerivedRefused", cause: "emptyHeading" },
		code: "TS2345",
		claim: named("a derived definition has at least one field")
	},
	headingGroups: {
		engine: { tag: "DerivedRefused", cause: "headingGroups" },
		code: "TS2345",
		claim: named(
			"a derived definition has one heading: a materialized view stores one heading group"
		)
	},
	atShort: {
		engine: { tag: "MalformedDescription" },
		code: "TS2554",
		claim: prose("C.at takes one key value per key field")
	},
	atMissing: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("C.at reads a payload field the closed relation declares")
	},
	atSwapped: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a key value is a handle of its own key field's roster, in key order")
	},
	rowShort: {
		engine: { tag: "MalformedDescription" },
		code: "TS2554",
		claim: prose("C.row takes every key field but the last")
	},
	atKey: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("C.at reads a payload field, never a key field")
	},
	atWrongHandle: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a key value is a handle of its field's roster")
	},
	rowWhole: {
		engine: { tag: "MalformedDescription" },
		code: "TS2554",
		claim: prose("C.row takes every key field but the last, never the whole key")
	},
	echoRoster: {
		engine: { tag: "MalformedDescription" },
		code: "TS2345",
		claim: prose("a key term is of its key field's roster, whatever its handles' spellings")
	},
	contractName: {
		engine: { identity: "several" },
		code: "TS2345",
		claim: named("a contract's name is one literal, the brand of its values")
	}
}

/**
 * The reason a fault's refusal is, as the oracle states it, structured data and never its prose: the engine's
 * CompileError by its tag and, for a role's refusal, the rule it names; a host value's refusal by its ValueFault; or a
 * contract name the engine would build contracts of several identities from.
 */
type Expected =
	| {
			readonly tag: Exclude<CompileReasonTag, "RoleRefused" | "PartialOperation" | "DerivedRefused">
	  }
	| { readonly tag: "RoleRefused"; readonly rule: RoleRule["kind"] }
	| { readonly tag: "DerivedRefused"; readonly cause: DerivedRefusal["kind"] }
	| { readonly tag: "PartialOperation"; readonly precondition: PreconditionKind }
	| { readonly value: ValueFault }
	| { readonly identity: "several" }

/** An expected reason as the key a verdict reads its refusal as. */
const expectedKey = (reason: Expected): string =>
	"identity" in reason
		? `identity:${reason.identity}`
		: "value" in reason
			? `value:${reason.value}`
			: reason.tag === "RoleRefused"
				? `${reason.tag}:${reason.rule}`
				: reason.tag === "PartialOperation"
					? `${reason.tag}:${reason.precondition}`
					: reason.tag === "DerivedRefused"
						? `${reason.tag}:${reason.cause}`
						: reason.tag

/**
 * A refusal's reason as the agreement compares it: its tag, and for a refusal of a world or a derivation the rule it
 * names, structured data the engine states and never its prose.
 */
const reasonKey = (reason: CompileReason): string => {
	switch (reason._tag) {
		case "RoleRefused":
		case "LoginRefused":
		case "ContextRefused":
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
		case "MalformedDescription":
		case "MalformedArtifact":
		case "UnsupportedOperation":
		case "UndeclaredDrop":
		case "UnsupportedLawFamily":
		case "LawOnDerived":
		case "UnrepresentableKey":
		case "FoldOverProjection":
		case "UnstatedKey":
		case "QueriedOwnerAppend":
		case "CascadedCopyAppend":
		case "StaleDerivedRead":
		case "UnorderableStratum":
		case "MissingDiscriminant":
		case "AttachedParentUnbound":
		case "AttachedPage":
		case "DescribedHeadingMismatch":
		case "ContractLiteral":
		case "IdentifierCollision":
		case "DigestCollision":
		case "ResourceBound":
		case "GeneratedRefused":
		case "RoleNameTooLong":
		case "UnfillableField":
		case "UnwritableRelation":
		case "ForeignLevel":
			return reason._tag
	}
}
/** A pg descriptor a field may be spelled by, every alias among them. */
const pgSpellings = [
	"smallint",
	"int2",
	"integer",
	"int",
	"int4",
	"bigint",
	"int8",
	"real",
	"float4",
	"double precision",
	"float8",
	"money",
	"boolean",
	"bool"
] as const
type PgSpelling = (typeof pgSpellings)[number]

const serialSpellings = [
	"smallserial",
	"serial2",
	"serial",
	"serial4",
	"bigserial",
	"serial8"
] as const
type SerialSpelling = (typeof serialSpellings)[number]

/** The integer spellings a span's endpoint may be. */
const endpointSpellings = ["integer", "int", "int4", "bigint", "int8"] as const
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
	| { readonly kind: "serial"; readonly spelling: SerialSpelling }
	| { readonly kind: "uuid" }
	| { readonly kind: "date" }
	| { readonly kind: "natural" }
	| {
			readonly kind: "numeric"
			readonly spelling: "numeric" | "decimal"
			readonly precision: number
			readonly scale: number
	  }
	| { readonly kind: "floatOf"; readonly precision: number }
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

/** An accumulated field's start, a value of its type at its axis's base. */
type Start =
	| { readonly kind: "integer"; readonly value: number }
	| { readonly kind: "bigint"; readonly value: bigint }
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
			readonly root: string
	  }

/** An alternatives law: its parent, its discriminator over a roster, and its arms by handle. */
interface AlternativesSpec {
	readonly parent: string
	readonly discriminator: string
	readonly roster: string
	readonly arms: Arr.NonEmptyReadonlyArray<readonly [string, string]>
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
type DerivedSide = "left" | "right" | "mirrors"

/** The form each place a law names the derived relation is noted as. */
const sideForm: { readonly [K in DerivedSide]: SchemaForm } = {
	left: "derivedLeft",
	right: "derivedRight",
	mirrors: "derivedMirrors"
}

/** The fields a derived definition's extras read, beside its group field. */
const extraFields = (spec: DerivedSpec): ReadonlyArray<string> =>
	Arr.flatMap(spec.extras, (x) => (x.kind === "literal" ? [] : [x.field]))

/** A role over the extension when there is one, else the base: its write list and refresh list. */
interface RoleSpec {
	readonly name: string
	readonly write: ReadonlyArray<string>
	readonly refresh: ReadonlyArray<string>
}

/** A case's base: valid by construction, the engine builds and compiles it. */
interface Base {
	readonly rosters: Arr.NonEmptyReadonlyArray<RosterSpec>
	readonly contracts: ReadonlyArray<ContractSpec>
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly statements: ReadonlyArray<StatementSpec>
	readonly family: FamilySpec | undefined
	readonly alternatives: AlternativesSpec | undefined
	readonly derived: DerivedSpec | undefined
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSpec>
	readonly closedRelation: ClosedSpec | undefined
	readonly slots: SlotsSpec | undefined
	/** Public values asked whether they are field descriptors, and pairs of pg spellings asked whether one is the other. */
	readonly publics: ReadonlyArray<PublicValue>
	readonly spellings: ReadonlyArray<readonly [Spelling, Exclude<Spelling, "float">]>
}

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
			{ name: "size", type: { kind: "pg", spelling: "bigint" }, writing: callerWriting },
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
const publicValues = [
	"numeric",
	"decimal",
	"vector",
	"float",
	"integer",
	"str",
	"uuid",
	"natural",
	"date"
] as const
type PublicValue = (typeof publicValues)[number]

/** A pg member that is a descriptor: every scalar and serial spelling, and float, also float(p)'s constructor. */
type Spelling = PgSpelling | SerialSpelling | "float"
const spellingsOf: Arr.NonEmptyReadonlyArray<Spelling> = [
	...pgSpellings,
	...serialSpellings,
	"float"
]

/** A public value as the program spells it, and as the engine holds it. */
const publicSource = (v: PublicValue): string => {
	switch (v) {
		case "numeric":
		case "decimal":
		case "vector":
		case "float":
		case "integer":
			return `Fi.pg.${v}`
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
		case "decimal":
		case "vector":
		case "float":
		case "integer":
			return pgDescriptors[v]
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
type Payload = "smallint" | "bigint" | "text"

const payloadType = (p: Payload): FieldType =>
	p === "text"
		? { kind: "text", pattern: { source: "^.*$", flags: "su" } }
		: { kind: "pg", spelling: p }

/** A payload value of each row: its source and its host value. */
const payloadValue = (p: Payload): readonly [string, unknown] => {
	switch (p) {
		case "smallint":
			return ["1", 1]
		case "bigint":
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

/** The rosters a case declares, from two that share a handle's spelling: a roster's identity is its name. */
const rosterPool: Arr.NonEmptyReadonlyArray<RosterSpec> = [
	{ name: "Kind", handles: ["A", "M"] },
	{ name: "Tier", handles: ["A", "P", "X"] }
]

/** The contracts a case may declare, over the types a contract admits, one over another. */
const contractNames = ["Cents", "Rate", "Code", "Day", "Mode", "Outer"] as const

/** A type a contract may be over: a value domain, never a serial, set, vector or span. */
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
				{ kind: "pg", spelling: d.from(["bigint", "int8", "integer", "int4"] as const) },
				{ kind: "numeric", spelling: "numeric", precision: 7, scale: 2 },
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
	return Arr.reduce(Arr.range(0, count - 1), [], (made: ReadonlyArray<ContractSpec>, i) => [
		...made,
		{
			name: defined(contractNames[i], "a contract name"),
			base: contractBaseOf(d, d.from(rosters), made)
		}
	])
}

/** Whether a contract's chain ends at an integer or a bigint: a span's endpoint, never a serial. */
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
				return {
					kind: "numeric",
					spelling: d.from(["numeric", "decimal"] as const),
					precision,
					scale
				}
			}
		],
		["floatField", () => ({ kind: "floatOf", precision: d.from([1, 24, 25, 53]) })],
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
					spelling === "bigint" || spelling === "int8"
						? { host: "bigint", value: 7n }
						: { host: "number", value: 7 }
				return { kind: "span", endpoint, width: d.upTo(1) === 1 ? width : undefined }
			}
		],
		["serialField", () => ({ kind: "serial", spelling: d.from(serialSpellings) })],
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
/** Whether a key may hold a field of this type: a value an index entry bounds, never a set, a vector, a span or a float. */
const keyable = (t: FieldType, contracts: ReadonlyArray<ContractSpec>): boolean => {
	switch (t.kind) {
		case "pg":
			return !Arr.contains(
				["real", "float4", "double precision", "float8", "money"] as const,
				t.spelling
			)
		case "serial":
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
		case "floatOf":
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
 * An ordinary relation: its key field id of a keyable type, then up to four fields of drawn types, at most one serial,
 * its primary key id and, sometimes, a keyable field after it.
 */
const relationOf = (
	d: Drawing,
	name: string,
	rosters: Arr.NonEmptyReadonlyArray<RosterSpec>,
	contracts: ReadonlyArray<ContractSpec>
): RelationSpec => {
	const idType = d.from<FieldType>([
		{ kind: "uuid" },
		{ kind: "pg", spelling: d.from(["bigint", "integer", "int8"] as const) },
		...(d.keep("serialField")
			? [{ kind: "serial", spelling: d.from(serialSpellings) } as const]
			: [])
	])
	const names = Arr.take(d.some(fieldNames), 1 + d.upTo(3))
	const fields = Arr.reduce(
		names,
		[],
		(made: ReadonlyArray<FieldSpec>, field): ReadonlyArray<FieldSpec> => {
			const drawn = fieldTypeOf(d, rosters, contracts)
			const serials = Arr.filter([{ type: idType }, ...made], (f) => f.type.kind === "serial")
			return drawn.kind === "serial" && Arr.isReadonlyArrayNonEmpty(serials)
				? made
				: [...made, { name: field, type: drawn, writing: callerWriting }]
		}
	)
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
			return !Arr.contains(["money", "boolean", "bool"] as const, t.spelling)
		case "serial":
		case "numeric":
		case "floatOf":
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
		? Arr.map(Arr.range(0, d.upTo(2)), (i) => ({
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
 * typmod, a pattern, an endpoint), every alias of one carrier one text.
 */
const typeText = (t: FieldType): string => {
	switch (t.kind) {
		case "pg":
			return `pg ${pgCanonical[t.spelling]}`
		case "serial":
			return `pg ${serialCanonical[t.spelling]}`
		case "uuid":
		case "date":
		case "natural":
			return t.kind
		case "numeric":
			return `numeric ${t.precision} ${t.scale}`
		case "floatOf":
			return t.precision <= 24 ? "pg real" : "pg double precision"
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
	smallint: "smallint",
	int2: "smallint",
	integer: "integer",
	int: "integer",
	int4: "integer",
	bigint: "bigint",
	int8: "bigint",
	real: "real",
	float4: "real",
	"double precision": "double precision",
	float8: "double precision",
	money: "money",
	boolean: "boolean",
	bool: "boolean"
}

const serialCanonical: { readonly [S in SerialSpelling]: string } = {
	smallserial: "smallint",
	serial2: "smallint",
	serial: "integer",
	serial4: "integer",
	bigserial: "bigint",
	serial8: "bigint"
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
	const sumType: FieldType = { kind: "pg", spelling: d.from(["bigint", "integer"] as const) }
	const start = (t: FieldType): Start =>
		t.kind === "pg" && t.spelling === "integer"
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

/** A tree pack: a document's nodes, each row's drawn index, children, start and end, its root field doc its tree's. */
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
					{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
					{ name: "parent", type: { kind: "uuid" }, writing: callerWriting },
					drawn("at"),
					drawn("children"),
					drawn("start"),
					drawn("end"),
					{ name: "doc", type: { kind: "uuid" }, writing: callerWriting },
					{ name: "label", type: { kind: "pg", spelling: "integer" }, writing: callerWriting }
				],
				key: ["id"]
			}
		],
		family: {
			kind: "tree",
			relation: "Node",
			count: "children",
			member: { relation: "Node", terms: ["parent", "at"] },
			root: "doc"
		}
	}
}

/**
 * An alternatives pack: a parent keyed by a uuid with a closed id of the roster, and an arm relation for one or more
 * of its handles, two handles sharing one arm when drawn, each arm keyed by a uuid named after the parent.
 */
const alternativesPack = (
	d: Drawing,
	roster: RosterSpec
): {
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly alternatives: AlternativesSpec
} => {
	const handles = d.some(roster.handles)
	const shared = d.upTo(2) === 0
	const armName = (i: number): string => (shared ? "JobArm" : `JobArm${i}`)
	const arms = Arr.map(handles, (h, i) => [h, armName(i)] as const)
	const armRelations = Arr.dedupeWith(
		Arr.map(arms, ([, name]): RelationSpec => ({
			name,
			fields: [
				{ name: "job", type: { kind: "uuid" }, writing: callerWriting },
				{ name: "cost", type: { kind: "pg", spelling: "bigint" }, writing: callerWriting }
			],
			key: ["job"]
		})),
		(a, b) => a.name === b.name
	)
	return {
		relations: [
			{
				name: "Job",
				fields: [
					{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
					{ name: "kind", type: { kind: "closedId", roster: roster.name }, writing: callerWriting },
					{ name: "owner", type: { kind: "uuid" }, writing: callerWriting }
				],
				key: ["id"]
			},
			...armRelations
		],
		alternatives: { parent: "Job", discriminator: "kind", roster: roster.name, arms }
	}
}

/** The roles of a case: a reader of every relation, and a writer of drawn ordinary relations, refreshing derived ones. */
const rolesOf = (
	d: Drawing,
	relations: Arr.NonEmptyReadonlyArray<RelationSpec>,
	derivedSpec: DerivedSpec | undefined
): Arr.NonEmptyReadonlyArray<RoleSpec> => [
	{ name: "reader", write: [], refresh: [] },
	...(d.keep("writer")
		? [
				{
					name: "writer",
					write: Arr.map(d.some(relations), (r) => r.name),
					refresh: derivedSpec === undefined ? [] : [derivedSpec.name]
				}
			]
		: [])
]

/** A case's base: its rosters, contracts, relations, statements, family, alternatives, derived relation and roles. */
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
		? familyPackOf(d, "ordered", d.from(rosters))
		: d.keep("counted")
			? familyPackOf(d, "counted", d.from(rosters))
			: d.keep("tree")
				? treePack()
				: undefined
	const alternation = d.upTo(3) === 0 ? undefined : alternativesPack(d, d.from(rosters))
	if (alternation !== undefined) {
		d.note("alternatives")
	}
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
		...(alternation === undefined ? [] : alternation.relations),
		...(slots === undefined ? [] : slotRelations(slots))
	]
	const mutable = Arr.flatMap(ordinary, (r): ReadonlyArray<StatementSpec> =>
		d.keep("mutableStatement") ? [{ kind: "mutable", relation: r.name }] : []
	)
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
		const counted = relationNamed(ordinary, derivedSpec.over)
		for (const x of derivedSpec.extras) {
			d.note(extraForm[x.kind])
			if (x.kind !== "literal" && fieldOf(counted, x.field).type.kind === "serial") {
				d.note("derivedSerial")
			}
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
						: Arr.map(Arr.range(1, closedArity), () => sameRoster),
					payload: d.from(["smallint", "bigint", "text"] as const),
					generated: d.keep("generated")
				}
	const roles = rolesOf(d, ordinary, derivedSpec)
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
		alternatives: alternation === undefined ? undefined : alternation.alternatives,
		derived: derivedSpec,
		roles,
		closedRelation: closedSpec,
		slots,
		publics: [d.from(publicValues), d.from(publicValues)],
		spellings: Arr.map(Arr.range(0, 2), () => {
			const x = d.from(spellingsOf)
			const ys = Arr.filter(spellingsOf, (y): y is Exclude<Spelling, "float"> => y !== "float")
			const y = d.from(Arr.isReadonlyArrayNonEmpty(ys) ? ys : [pgSpellings[0]])
			return [x, y] as const
		})
	}
}
/** A built roster: the members a probe reads of it. */
type RosterValue = ReturnType<typeof closed<string, Arr.NonEmptyReadonlyArray<string>>>

/** Rule, the base's closed relation, built as a JavaScript caller builds it: a row of every key. */
const closedValue = (c: ClosedSpec, rosters: ReadonlyMap<string, RosterValue>) => {
	const [, payload] = payloadValue(c.payload)
	const names = closedKeyNames(c)
	const fields: Readonly<Record<string, FieldBase>> = {
		...closedIdFields(c, rosters),
		w: pgDescriptors.integer,
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
		{ id: uuidDescriptor, ...closedIdFields(c, rosters), depth: pgDescriptors.integer },
		["id"],
		(row: Readonly<Record<string, unknown>>) => ({
			weight: generatedField(
				pgDescriptors.integer,
				closedRead(
					rule,
					"w",
					Arr.map(closedKeyNames(c), (k) => row[k])
				),
				[]
			),
			flags: generatedField(
				bits(got(rosters, Arr.lastNonEmpty(c.key).name)),
				closedRow(
					rule,
					Arr.map(Arr.initNonEmpty(closedKeyNames(c)), (k) => row[k])
				),
				[]
			),
			next: generatedField(
				pgDescriptors.bigint,
				computeCore.cast(computeCore.add(row["depth"], 1), pgDescriptors.bigint),
				[]
			)
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
	/** The statements but the alternatives law: what a probe's schema states beside its own statement. */
	readonly core: ReadonlyArray<Statement>
	readonly schema: AnySchema
	/** The extension that declares the derived relation, or the schema. */
	readonly level: AnySchema
	/** The level's relations, each a whole entry a role may hold. */
	readonly entries: Readonly<Record<string, AnyRelation | AnyRoster | AnyDerived>>
	readonly derived: AnyDerived | undefined
	/** Each role's write list and refresh list, as the engine described the role. */
	readonly writes: ReadonlyMap<string, ReadonlyArray<string>>
	readonly refreshes: ReadonlyMap<string, ReadonlyArray<string>>
}

const got = <A>(map: ReadonlyMap<string, A>, name: string): A =>
	Option.getOrThrowWith(
		Option.fromUndefinedOr(map.get(name)),
		() => new Error(`no ${name} in the case`)
	)

/** The descriptor of an endpoint spelling or of a contract, as the engine's span core reads it. */
const endpointValue = (e: Endpoint, contracts: ReadonlyMap<string, FieldBase>): FieldBase =>
	e.kind === "pg" ? pgDescriptors[e.spelling] : got(contracts, e.name)

/** A field type's descriptor, built as a JavaScript caller builds it. */
const fieldValue = (
	t: FieldType,
	rosters: ReadonlyMap<string, RosterValue>,
	contracts: ReadonlyMap<string, FieldBase>
): FieldBase => {
	switch (t.kind) {
		case "pg":
		case "serial":
			return pgDescriptors[t.spelling]
		case "uuid":
			return uuidDescriptor
		case "date":
			return dateDescriptor
		case "natural":
			return naturalDescriptor
		case "numeric":
			return pgDescriptors[t.spelling](t.precision, t.scale)
		case "floatOf":
			return floatOf(t.precision)
		case "vector":
			return pgDescriptors.vector(t.dims)
		case "text":
			return regexField(t.pattern.source, t.pattern.flags === "default" ? [] : [t.pattern.flags])
		case "contract":
			return got(contracts, t.name)
		case "closedId":
			return closedId(got(rosters, t.roster))
		case "bits":
			return bits(got(rosters, t.roster))
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
			return accumulatedField(type, startValue(f.writing.start, rosters), [])
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
	relations: ReadonlyMap<string, AnyRelation>
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

const alternativesValue = (
	a: AlternativesSpec,
	rosters: ReadonlyMap<string, RosterValue>,
	relations: ReadonlyMap<string, AnyRelation>
): Statement =>
	alternativesBuilder(
		got(relations, a.parent),
		a.discriminator,
		got(rosters, a.roster),
		Rec.fromEntries(Arr.map(a.arms, ([h, arm]) => [h, got(relations, arm)] as const))
	)

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
					return computeCore.literal(pgDescriptors.integer, 1)
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
		Arr.map(base.rosters, (r) => [r.name, closed(r.name, r.handles, [])] as const)
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
	const core: ReadonlyArray<Statement> = [
		...Arr.map(base.statements, (s) => statementValue(s, relations)),
		...(base.family === undefined ? [] : familyValues(base.family, relations))
	]
	const statements: ReadonlyArray<Statement> = [
		...core,
		...(base.alternatives === undefined
			? []
			: [alternativesValue(base.alternatives, rosters, relations)])
	]
	const members: Readonly<Record<string, AnyRelation | AnyClosed>> = {
		...Rec.fromEntries([...rosters]),
		...Rec.fromEntries([...relations]),
		...(rule === undefined ? {} : { Rule: rule })
	}
	const schemaValue = schema("S", members, statements, [])
	const counts =
		base.derived === undefined
			? undefined
			: derived(base.derived.name, definitionOf(base.derived, base, schemaValue, relations), [])
	const level =
		counts === undefined
			? schemaValue
			: schema.extend(schemaValue, { [counts.name]: counts }, [], [])
	const wholes = { ...Rec.fromEntries([...rosters]), ...Rec.fromEntries([...relations]) }
	const entries = counts === undefined ? wholes : { ...wholes, [counts.name]: counts }
	const described = new Map(
		Arr.map(base.roles, (r) => {
			const value = role(level, r.name, entries, { write: r.write, refresh: r.refresh })
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
		core,
		schema: schemaValue,
		level,
		entries,
		derived: counts,
		writes: listed((desc) => desc.write),
		refreshes: listed((desc) => desc.refresh)
	}
}
/** A case's TypeScript identifier for a value it declares under `name`. */
type Ids = (name: string) => string

/** A union of literal texts, each a TypeScript string literal type. */
/** A union of types, never where there are none. */
const typeUnion = (types: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(types) ? Arr.join(types, " | ") : "never"

const literalUnion = (values: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(values) ? Arr.join(Arr.map(values, jsonText), " | ") : "never"

/**
 * The host type of a field as the engine describes it (ir/desc.ts FieldDesc), as TypeScript: what its column delivers,
 * a contract's values its base's branded with its name, a closed id one of its roster's handles, a set the roster's
 * Bits, natural an unbranded bigint.
 */
const hostOfDesc = (desc: FieldDesc, base: Base, ids: Ids): string => {
	switch (desc.kind) {
		case "pg":
			return pgHost[desc.type]
		case "numeric":
			return "Fi.Decimal"
		case "uuid":
			return "Fi.Uuid"
		case "text":
			return `Tx.RegexInfer<${jsonText(desc.source)}, ${jsonText(desc.flags)}>`
		case "contract":
			return builtinDesc(desc)
				? hostOfDesc(desc.base, base, ids)
				: `(${hostOfDesc(desc.base, base, ids)}) & Brand.Brand<${jsonText(desc.name)}>`
		case "span":
			return `Fi.Span<${hostOfDesc(desc.endpoint, base, ids)}>`
		case "closedId":
			return literalUnion(rosterNamed(base, desc.roster).handles)
		case "bits":
			return `Ff.Bits<typeof ${ids(desc.roster)}>`
		case "vector":
			return `Fi.Vector<${desc.dimensions}>`
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
	smallint: "number",
	integer: "number",
	real: "number",
	"double precision": "number",
	bigint: "bigint",
	money: "Fi.Money",
	boolean: "boolean",
	date: "Fi.CalendarDate"
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
 * What the engine says of a relation's facts and additions: each field's host type, the fields its caller writes
 * (caller and serial), and its serial fields.
 */
interface Heading {
	readonly fact: ReadonlyArray<readonly [string, string]>
	readonly written: ReadonlyArray<string>
	readonly serial: ReadonlyArray<string>
}

const headingOf = (value: AnyRelation, base: Base, ids: Ids): Heading => {
	const decls = declsOf(value)
	return {
		fact: Arr.map(decls, ([name, decl]) => [name, hostOfDesc(decl.type, base, ids)] as const),
		written: Arr.flatMap(decls, ([name, decl]) =>
			decl.writing.kind === "caller" || decl.writing.kind === "serial" ? [name] : []
		),
		serial: Arr.flatMap(decls, ([name, decl]) => (decl.writing.kind === "serial" ? [name] : []))
	}
}

/**
 * An addition as the engine admits one: the written fields, or those less every serial field, all or none; two arms,
 * one type where the relation has no serial field.
 */
const additionType = (h: Heading, without: ReadonlyArray<string>): string => {
	const row = (omitted: ReadonlyArray<string>) =>
		objectType(
			Arr.filter(h.fact, ([name]) => Arr.contains(h.written, name) && !Arr.contains(omitted, name))
		)
	return `${row(without)} | ${row([...without, ...h.serial])}`
}

/**
 * The candidate keys over a relation's heading the engine compiles the schema to: its owned keys, the primary key and
 * each key statement's, and each family's that keys its members by heading fields, an ordered family's group and index
 * and a tree's root and start; a counted family's index is a law column, in no heading.
 */
const keysOf = (artifacts: SchemaArtifacts, name: string): ReadonlyArray<ReadonlyArray<string>> => {
	const owned = artifacts.owned.relations[name]
	return [
		...(owned === undefined ? [] : Arr.map(owned.keys, (k) => k.fields)),
		...Arr.flatMap(artifacts.laws.families, (f) => {
			if (f.member.name !== name) {
				return []
			}
			if (f.members.kind === "tree") {
				return [[f.members.root.name, f.members.start.name]]
			}
			return f.index.kind === "field"
				? [[...Arr.map(f.group, (g) => g.member.name), f.index.field.name]]
				: []
		})
	]
}
/** The host type of a scalar type as the engine compiles it (ir/scalar.ts ScalarType), as TypeScript. */
const hostOfScalar = (t: ScalarType, ids: Ids): string => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		return builtinScalar(t)
			? hostOfScalar(contract.base, ids)
			: `(${hostOfScalar(contract.base, ids)}) & Brand.Brand<${jsonText(contract.name)}>`
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
		case "numeric":
			return "Fi.Decimal"
		case "money":
		case "exactMoney":
			return "Fi.Money"
		case "bool":
			return "boolean"
		case "uuid":
			return "Fi.Uuid"
		case "date":
			return "Fi.CalendarDate"
		case "text":
			return t.text.regex === "wildcard"
				? "string"
				: `Tx.RegexInfer<${jsonText(t.text.regex.source)}, ${jsonText(t.text.regex.flags)}>`
		case "code":
			return literalUnion(t.roster.handles)
		case "bits":
			return `Ff.Bits<typeof ${ids(t.roster.closed)}>`
		case "range4":
		case "range8":
		case "rangeDate":
			return `Fi.Span<${hostOfScalar(t.span.endpoint, ids)}>`
		case "vector":
			return `Fi.Vector<${t.typmod.dims}>`
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

/** A closed id's handles under the brand of each contract its type is, innermost first, as hostOfScalar brands. */
const brandedHandles = (type: ScalarType, handles: string): string => {
	const contract = contractOf(type)
	return contract === undefined
		? handles
		: `(${brandedHandles(contract.base, handles)}) & Brand.Brand<${jsonText(contract.name)}>`
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
		case "convert":
		case "text":
		case "bits":
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
		Result.flatMap(catchCompileError(build), (built) => testArtifacts(built, testCompile))
	)

/**
 * A schema of every relation of the base, under its own name, with the base's statements but its alternatives law, and
 * `statements`: a probe's statement in context.
 */
const probeSchema = (env: Env, statements: ReadonlyArray<Statement>): AnySchema =>
	schema("P", env.members, [...env.core, ...statements], [])

const quoted = (names: ReadonlyArray<string>): string => Arr.join(Arr.map(names, jsonText), ", ")

/** A field's descriptor as the program spells it. */
const fieldSource = (t: FieldType, ids: Ids): string => {
	switch (t.kind) {
		case "pg":
		case "serial":
			return t.spelling === "double precision" ? 'Fi.pg["double precision"]' : `Fi.pg.${t.spelling}`
		case "uuid":
			return "Fi.uuid"
		case "date":
			return "Fi.date"
		case "natural":
			return "Fi.natural"
		case "numeric":
			return `Fi.pg.${t.spelling}(${t.precision}, ${t.scale})`
		case "floatOf":
			return `Fi.pg.float(${t.precision})`
		case "vector":
			return `Fi.pg.vector(${t.dims})`
		case "text":
			return `Tx.str.regex(${jsonText(t.pattern.source)}${t.pattern.flags === "default" ? "" : `, ${jsonText(t.pattern.flags)}`})`
		case "contract":
			return ids(t.name)
		case "closedId":
			return `Fi.closedId(${ids(t.roster)})`
		case "bits":
			return `Fi.bits(${ids(t.roster)})`
		case "span": {
			const endpoint =
				t.endpoint.kind === "pg" ? `Fi.pg.${t.endpoint.spelling}` : ids(t.endpoint.name)
			return `Fi.span(${endpoint}${t.width === undefined ? "" : t.width.host === "bigint" ? `, ${t.width.value}n` : `, ${t.width.value}`})`
		}
	}
}

const startSource = (s: Start, ids: Ids): string => {
	switch (s.kind) {
		case "integer":
			return `${s.value}`
		case "bigint":
			return `${s.value}n`
		case "handle":
			return jsonText(s.handle)
		case "noHandles":
			return `Fi.Bits.of(${ids(s.roster)}, [])`
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
			return `Fi.accumulated(${fieldSource(f.type, ids)}, ${startSource(f.writing.start, ids)})`
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
						{ ...Rec.fromEntries([...env.rosters]), Probe: probe },
						[keyBuilder(onBuilder(probe, ["set"]))],
						[]
					)
				})
			}
			return fault === "setPrimaryKey"
				? compiling(() =>
						schema(
							"P",
							{ ...Rec.fromEntries([...env.rosters]), Probe: relationValueOf(env) },
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

/** A roster of drawn handles, or one planted fault. */
const rosterProbe = (d: Drawing): Probe => {
	const handles = d.some(["a", "b", "c"] as const)
	const fault = d.from<SchemaFault | undefined>([undefined, "emptyRoster", "repeatedHandle"])
	const written: ReadonlyArray<string> =
		fault === "emptyRoster" ? [] : fault === "repeatedHandle" ? [...handles, handles[0]] : handles
	return {
		construct: "rosterProbe",
		refused: fault,
		text: () => oneLine(`Sc.closed("Probe", [${quoted(written)}])`),
		judge: () => building(() => admitRoster("Probe", written, []))
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

/** mutable over an ordinary relation, a roster, or the derived relation. */
const mutableProbe = (d: Drawing, base: Base): Probe => {
	const target = d.from<
		| { readonly kind: "relation"; readonly name: string }
		| { readonly kind: "roster"; readonly name: string }
		| { readonly kind: "derived"; readonly name: string }
	>([
		{ kind: "roster", name: d.from(base.rosters).name },
		...Arr.flatMap(ordinaryOf(base), (r) =>
			Arr.some(base.statements, (s) => s.kind === "mutable" && s.relation === r.name)
				? []
				: [{ kind: "relation", name: r.name } as const]
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
						probeSchema(env, [mutableBuilder(got(env.relations, target.name))])
					)
				case "roster":
					return compiling(() => probeSchema(env, [mutableBuilder(got(env.rosters, target.name))]))
				case "derived":
					return compiling(() =>
						schema.extend(env.schema, derivedRecord(env), [mutableBuilder(derivedOf(env))], [])
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
 * An alternatives law over the base's pack: drawn arms, or one planted fault: no arm, an arm under a stranger, the
 * parent as its own arm, an arm keyed apart from the parent, a discriminator that is no closed id of the roster, the
 * derived relation as parent or arm.
 */
const alternativesProbe = (d: Drawing, base: Base): Probe | undefined => {
	const alt = base.alternatives
	if (alt === undefined) {
		return undefined
	}
	const roster = rosterNamed(base, alt.roster)
	const apart = Arr.filter(
		ordinaryOf(base),
		(r) => r.key.length === 1 && !sameType(fieldOf(r, r.key[0]).type, { kind: "uuid" })
	)
	type Planted = {
		readonly fault: SchemaFault | undefined
		readonly parent: string
		readonly discriminator: string
		readonly arms: ReadonlyArray<readonly [string, string]>
	}
	const valid: Planted = { fault: undefined, ...alt }
	const forms: Arr.NonEmptyReadonlyArray<Planted> = [
		valid,
		{ ...valid, fault: "noArms", arms: [] },
		{ ...valid, fault: "strayArm", arms: [...alt.arms, ["Z", alt.arms[0][1]]] },
		{ ...valid, fault: "selfArm", arms: [[alt.arms[0][0], alt.parent]] },
		{ ...valid, fault: "foreignDiscriminator", discriminator: "owner" },
		...(Arr.isReadonlyArrayNonEmpty(apart)
			? [
					{
						...valid,
						fault: "armKeyMismatch",
						arms: [[roster.handles[0], d.from(apart).name]]
					} as const
				]
			: []),
		...(base.derived === undefined
			? []
			: [
					{
						...valid,
						fault: "derivedArm",
						arms: [[roster.handles[0], base.derived.name]]
					} as const,
					{
						...valid,
						fault: "derivedParent",
						parent: base.derived.name,
						discriminator: base.derived.by,
						arms: []
					} as const
				])
	]
	const planted = d.from(forms)
	return {
		construct: "alternativesProbe",
		refused: planted.fault,
		text: (ids) =>
			oneLine(
				`Sc.alternatives(${ids(planted.parent)}, ${jsonText(planted.discriminator)}, ${ids(alt.roster)}, { ${Arr.join(
					Arr.map(planted.arms, ([h, arm]) => `${jsonText(h)}: ${ids(arm)}`),
					", "
				)} })`
			),
		judge: (env) =>
			compiling(() => {
				const p = probeSchema(env, [])
				const spec = base.derived
				const counts =
					spec === undefined
						? undefined
						: derived(spec.name, definitionOf(spec, base, p, env.relations), [])
				const valueOf = (name: string): AnyRelation | AnyDerived =>
					counts?.name === name ? counts : got(env.relations, name)
				const statement = alternativesBuilder(
					valueOf(planted.parent),
					planted.discriminator,
					got(env.rosters, alt.roster),
					Rec.fromEntries(Arr.map(planted.arms, ([h, arm]) => [h, valueOf(arm)] as const))
				)
				return counts === undefined
					? probeSchema(env, [statement])
					: schema.extend(p, { [counts.name]: counts }, [statement], [])
			})
	}
}

/**
 * A schema over relations of the base: each under its own name with a mutable statement over one of them, or one
 * planted fault: a relation under another's name, a statement over a relation it does not declare, fin as a member.
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
		readonly members: ReadonlyArray<readonly [string, string]>
		readonly mutable: string
		readonly fin: string | undefined
	}
	const own = Arr.map(declared, (r) => [r.name, r.name] as const)
	const rosters = Arr.map(base.rosters, (r) => [r.name, r.name] as const)
	const valid: Planted = {
		fault: undefined,
		members: [...rosters, ...own],
		mutable: declared[0].name,
		fin: undefined
	}
	const forms: Arr.NonEmptyReadonlyArray<Planted> = [
		valid,
		{
			...valid,
			fault: "aliasedRelation",
			members: [...rosters, [`${declared[0].name}s`, declared[0].name], ...Arr.drop(own, 1)]
		},
		...(Arr.isReadonlyArrayNonEmpty(other)
			? [{ ...valid, fault: "undeclaredStatementRelation", mutable: d.from(other).name } as const]
			: []),
		...(owner === undefined ? [] : [{ ...valid, fault: "finMember", fin: owner } as const])
	]
	const planted = d.from(forms)
	return {
		construct: "schemaProbe",
		refused: planted.fault,
		text: (ids) =>
			oneLine(
				`Sc.schema("P", { ${Arr.join(
					[
						...Arr.map(planted.members, ([name, value]) => `${name}: ${ids(value)}`),
						...(planted.fin === undefined ? [] : [`slots: Sc.fin(${ids(planted.fin)}, "n")`])
					],
					", "
				)} }, [Sc.mutable(${ids(planted.mutable)})])`
			),
		judge: (env) => {
			const members = Rec.fromEntries(
				Arr.map(planted.members, ([name, value]) => [name, memberOf(env, value)] as const)
			)
			const statements = [mutableBuilder(got(env.relations, planted.mutable))]
			const fin = planted.fin
			return fin === undefined
				? compiling(() => schema("P", members, statements, []))
				: building(() =>
						admitSchema(
							"P",
							{ ...members, slots: finBuilder(got(env.relations, fin), "n") },
							statements,
							[]
						)
					)
		}
	}
}

/**
 * A role over the base's top level: a write list of ordinary relations and a refresh list of the derived one, or one
 * planted fault: a whole entry outside the base, a write list naming a roster, a stranger or the derived relation, a
 * refresh list naming a base relation.
 */
const roleProbe = (d: Drawing, base: Base): Probe => {
	const ordinary = ordinaryOf(base)
	type Planted = {
		readonly fault: SchemaFault | undefined
		readonly outside: boolean
		readonly write: ReadonlyArray<string>
		readonly refresh: ReadonlyArray<string>
	}
	const valid: Planted = {
		fault: undefined,
		outside: false,
		write: Arr.map(d.some(ordinary), (r) => r.name),
		refresh: base.derived === undefined ? [] : [base.derived.name]
	}
	const forms: Arr.NonEmptyReadonlyArray<Planted> = [
		valid,
		{ ...valid, fault: "entryOutsideBase", outside: true, write: [], refresh: [] },
		{ ...valid, fault: "writeClosed", write: [d.from(base.rosters).name] },
		{ ...valid, fault: "writeStranger", write: ["Nobody"] },
		...(base.derived === undefined
			? []
			: [
					{ ...valid, fault: "writeDerived", write: [base.derived.name] } as const,
					{ ...valid, fault: "refreshBase", refresh: [d.from(ordinary).name] } as const
				])
	]
	const planted = d.from(forms)
	const level = base.derived === undefined ? "S" : "Level"
	const lists = `{ write: [${quoted(planted.write)}], refresh: [${quoted(planted.refresh)}] }`
	return {
		construct: "roleProbe",
		refused: planted.fault,
		text: (ids) =>
			oneLine(
				planted.outside
					? `Sc.role(${ids("S")}, "probe", { ${ordinary[0].name}: ${ids(ordinary[0].name)}, Outside: Sc.relation("Outside", { id: Fi.uuid }, ["id"]) })`
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
							Outside: relation("Outside", { id: uuidDescriptor }, ["id"], [])
						})
					: role(env.level, "probe", env.entries, {
							write: planted.write,
							refresh: planted.refresh
						})
			)
	}
}
/** The faults a derived probe plants: a definition's, a level's, a law's or a fin's over the derived relation. */
type DerivedFault = Extract<
	SchemaFault,
	| "parameterizedDefinition"
	| "derivedAtOwnLevel"
	| "derivedInRoot"
	| "keyOverDerived"
	| "sideOverDerived"
	| "checkOverDerived"
	| "selectOverDerived"
	| "finOverDerived"
	| "emptyHead"
	| "headingGroups"
	| "derivedOverBase"
>

/** The derived definitions a derived probe states that the engine admits, each noted as its form. */
type DerivedValid = "overLevels" | "boundImport" | "discriminated" | "projection" | "skipsLevel"

const validForm: { readonly [K in DerivedValid]: SchemaForm } = {
	overLevels: "derivedOverLevels",
	boundImport: "derivedBoundImport",
	discriminated: "derivedDiscriminated",
	projection: "derivedProjection",
	skipsLevel: "derivedSkipsLevel"
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
					? `${x.name}: Cp.Compute.literal(Fi.pg.integer, 1)`
					: `${x.name}: r.${x.kind}(${x.field})`
			)
		],
		", "
	)
	return `Q.query(${schemaId}).rule((r) => { const { ${Arr.join(bound, ", ")} } = Q.v(${ids(spec.over)}, "fact"); return r.match(${ids(spec.over)}, { ${Arr.join(bound, ", ")} })${where}.find({ ${head} }) })`
}

/**
 * The derived relation's laws and levels: a definition reading a parameter, of no field, or of several heading groups;
 * a derived relation declared at the level its definition reads, or in a root schema; every law that names it, a
 * containment's left side, its right side or a mirror; fin over it; each a planted fault. The admitted forms: a further
 * derived relation over the extension, declared above it, whose schema's levels are its own, the extension's and the
 * root's; a definition matching a query that reads a parameter, bound at each group value; a definition of two arms of
 * one heading, apart only in the handle a discriminant holds; a projection of its relation's key fields and group
 * field, which keeps the keys it inherits. Each admitted definition's fact is the heading the engine
 * compiles it to.
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
		"skipsLevel"
	])
	const [fault, side] =
		d.upTo(3) === 0
			? ([undefined, "left"] as const)
			: d.from<readonly [DerivedFault, DerivedSide]>([
					["parameterizedDefinition", "left"],
					["derivedAtOwnLevel", "left"],
					["derivedInRoot", "left"],
					["keyOverDerived", "left"],
					["sideOverDerived", "left"],
					["sideOverDerived", "right"],
					["sideOverDerived", "mirrors"],
					["checkOverDerived", "left"],
					["selectOverDerived", "left"],
					["finOverDerived", "left"],
					["emptyHead", "left"],
					["headingGroups", "left"],
					["derivedOverBase", "left"]
				])
	if (fault === "sideOverDerived") {
		d.note(sideForm[side])
	}
	if (fault === undefined) {
		d.note(validForm[valid])
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
	const sideText = (ids: Ids): string => {
		const counted = `Sc.on(${ids(spec.name)}, ${jsonText(spec.by)})`
		const own = `Sc.on(${ids(r.name)}, ${jsonText(spec.by)})`
		switch (side) {
			case "left":
				return `Sc.contained(${counted}, ${own})`
			case "right":
				return `Sc.contained(${own}, ${counted})`
			case "mirrors":
				return `Sc.mirrors(${counted}, ${own})`
		}
	}
	const keys = r.key
	const admittedText = (ids: Ids, own: string, env: Env): ProbeText => {
		const fact = (definition: QueryValue) =>
			`export type ${own}_fact = Expect<Equals<Sc.Fact<typeof ${own}>, ${objectType(compiledHeading(definition, ids))}>>`
		switch (valid) {
			case "overLevels":
				return {
					head: [],
					line: `export const ${own} = Sc.schema.extend(${ids("Level")}, { Over: ${over(ids)} }, [])`,
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
						`export const ${level} = Sc.schema.extend(${ids("S")}, { Probe: ${own} }, [])`,
						`export type ${own}_keys = Expect<Equals<Sc.KeysOf<typeof ${level}, typeof ${own}>, ${projectionKeys(env)}>>`
					]
				}
			}
			case "skipsLevel":
				return {
					head: [],
					line: `export const ${own} = Sc.derived("Skip", Q.query(${ids("S")}).rule((r) => { ${matched(ids)}.find({ ${Arr.join(bound, ", ")} }) }))`,
					tail: [
						`export const ${own}_level = Sc.schema.extend(${ids("Level")}, { Skip: ${own} }, [])`,
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
				return oneLine(`Sc.schema.extend(${ids("S")}, { Over: ${over(ids)} }, [])`)
			case "derivedInRoot":
				return oneLine(`Sc.schema("Root", { ${spec.name}: ${ids(spec.name)} }, [])`)
			case "keyOverDerived":
				return oneLine(`Sc.key(Sc.on(${ids(spec.name)}, ${jsonText(spec.by)}))`)
			case "sideOverDerived":
				return oneLine(sideText(ids))
			case "checkOverDerived":
				return oneLine(`Sc.check("Probe", ${ids(spec.name)}, (w) => w.and())`)
			case "selectOverDerived":
				return oneLine(`Sc.select(${ids(spec.name)}, (w) => w.and())`)
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
		derived(
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
	/** The law over the derived relation a sideOverDerived probe states, on the side it draws. */
	const sideStatement = (env: Env): Statement => {
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
	/** The keys the engine infers the projection inherits, as KeysOf states them, from its compiled extension. */
	const projectionKeys = (env: Env): string => {
		const compiled = Result.flatMap(
			catchCompileError(() =>
				schema.extend(env.schema, { Probe: derived("Probe", projectionValue(env), []) }, [], [])
			),
			(level) => testArtifacts(level, testCompile)
		)
		if (!compiled.ok) {
			throw new Error(
				`the engine refuses a drawn projection, a defect of the generator: ${messageOf(compiled.error)}`
			)
		}
		const analysis = compiled.value.derived.relations["Probe"]
		const keys =
			analysis === undefined
				? []
				: Arr.map(analysis.keys, (k) => `ReadonlyArray<${literalUnion(k.fields)}>`)
		return Arr.isReadonlyArrayNonEmpty(keys) ? Arr.join(keys, " | ") : "never"
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
			compiling(() => schema.extend(env.schema, derivedRecord(env), [statement], []))
		const probing = (definition: () => QueryValue) =>
			compiling(() =>
				schema.extend(env.schema, { Probe: derived("Probe", definition(), []) }, [], [])
			)
		switch (fault) {
			case undefined:
				switch (valid) {
					case "overLevels":
						return compiling(() =>
							schema.extend(env.level, { Over: overValue(env, env.level) }, [], [])
						)
					case "boundImport":
						return probing(() => boundImportValue(env))
					case "discriminated":
						return probing(() => discriminatedValue(env))
					case "projection":
						return probing(() => projectionValue(env))
					case "skipsLevel":
						return compiling(() =>
							schema.extend(env.level, { Skip: derived("Skip", projectionValue(env), []) }, [], [])
						)
				}
			case "parameterizedDefinition":
				return building(() => derived("Probe", parameterizedDefinition(spec, base, env), []))
			case "derivedAtOwnLevel":
				return building(() =>
					schema.extend(env.schema, { Over: overValue(env, env.level) }, [], [])
				)
			case "derivedInRoot":
				return building(() => admitSchema("Root", { [spec.name]: counts }, [], []))
			case "keyOverDerived":
				return extended(keyBuilder(onBuilder(counts, [spec.by])))
			case "sideOverDerived":
				return extended(sideStatement(env))
			case "checkOverDerived":
				return building(() => checkBuilder("Probe", counts, (w: typeof rowHelpers) => w.and()))
			case "selectOverDerived":
				return building(() => selectBuilder(counts, (w: typeof rowHelpers) => w.and()))
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
		refused: fault,
		text,
		judge
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
 * A row check, a selection or a contract predicate inside a rule, reading the rule's parameter, a planted fault, or
 * reading its row alone. The predicate compares the relation's key field.
 */
const predicateProbe = (d: Drawing, base: Base): Probe => {
	const r = d.from(ordinaryOf(base))
	const field = fieldOf(r, r.key[0])
	const site = d.from<PredicateSite>(
		field.type.kind === "serial" ? ["check", "select"] : ["check", "select", "contract"]
	)
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
				return `Fi.contract("Probe", ${ids(r.name)}.fields.${field.name}, (x) => x.eq(${operand(ids, "x")}))`
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
						schema(
							"P",
							{ Holder: relation("Holder", { id: uuidDescriptor, x: contract }, ["id"], []) },
							[],
							[]
						)
					)
		}
	}
}
/** A field type a literal probe's target may be, and its descriptor's spelling. */
const literalTargets = [
	"integer",
	"bigint",
	"numeric",
	"boolean",
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
		case "integer":
		case "bigint":
		case "boolean":
		case "money":
			return { kind: "pg", spelling: t }
		case "numeric":
			return { kind: "numeric", spelling: "numeric", precision: 7, scale: 2 }
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
			return { source: 'Fi.Decimal.of("1.5")', value: Decimal.of("1.5") }
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
							`export const ${own}_lit = Sc.relation("Lit", { id: Fi.uuid, f: ${field} }, ["id"])`
						],
						line:
							site === "check"
								? `export const ${own} = Sc.check("Probe", ${own}_lit, (row) => row.eq(row.f, ${literal.source}))`
								: `export const ${own} = Sc.select(${own}_lit, (row) => row.eq(row.f, ${literal.source}))`,
						tail: []
					}
				case "contract":
					return oneLine(
						`export const ${own} = Fi.contract("Probe", ${field}, (x) => x.eq(${literal.source}))`
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
						const lit = relation("Lit", { id: uuidDescriptor, f: descriptor }, ["id"], [])
						return schema(
							"P",
							{ ...rosters, Lit: lit },
							[checkBuilder("Probe", lit, predicate)],
							[]
						)
					}
					case "select": {
						const lit = relation("Lit", { id: uuidDescriptor, f: descriptor }, ["id"], [])
						return schema(
							"P",
							{ ...rosters, Lit: lit },
							[keyBuilder(onBuilder(selectBuilder(lit, predicate), ["id"]))],
							[]
						)
					}
					case "contract": {
						const probe = admitContract("Probe", descriptor, [
							(x: unknown) => rowHelpers.eq(x, literal.value)
						])
						const holder = relation("Holder", { id: uuidDescriptor, f: probe }, ["id"], [])
						return schema("P", { ...rosters, Holder: holder }, [], [])
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

/**
 * A family of its own with one fold: an owner O with its drawn count and the fold's ends, a member M with its group,
 * an ordered member's drawn index, the step's value and, over an ordered family, sometimes a (before, after) pair.
 * Valid, or with one planted fault: a counted family's fold naming the pair, a monoid over a value it does not combine,
 * an end of the wrong planes, a count field that is not drawn: the owner's key, or an accumulated natural; a concat
 * fold of text over its named (before, after) pair, over a counted family or with its pair hidden a planted fault.
 */
const familyProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const drawn = d.from<FoldFault | "treeParentType" | "countedSide" | "concatFold" | undefined>([
		undefined,
		undefined,
		"concatFold",
		"countedPair",
		"monoidMismatch",
		"endPlanes",
		"finNotDrawn",
		"concatCounted",
		"concatHidden",
		"treeParentType",
		"countedSide"
	])
	const fault = drawn === "concatFold" ? undefined : drawn
	if (fault === "treeParentType") {
		return treeProbe(d)
	}
	if (fault === "countedSide") {
		return countedSideProbe()
	}
	const order =
		fault === "countedPair" || fault === "concatCounted"
			? "counted"
			: fault === "concatHidden" || drawn === "concatFold"
				? "ordered"
				: d.from(["ordered", "counted"] as const)
	const monoid =
		fault === "countedPair"
			? "sum"
			: fault === "concatCounted" || fault === "concatHidden" || drawn === "concatFold"
				? "concat"
				: fault === "monoidMismatch"
					? d.from(["sum", "or", "concat"] as const)
					: fault === "endPlanes"
						? d.from(["sum", "twos"] as const)
						: order === "counted"
							? d.from(["count", "sum"] as const)
							: d.from(orderedMonoids)
	if (monoid === "concat" && fault === undefined) {
		d.note("concatFold")
	}
	if (monoid === "concat" && fault === "monoidMismatch") {
		d.note("concatMismatch")
	}
	const text: FieldType = { kind: "text", pattern: { source: "^[a-z]{0,16}$", flags: "u" } }
	const set: FieldType = { kind: "bits", roster: roster.name }
	const closedType: FieldType = { kind: "closedId", roster: roster.name }
	const sumType: FieldType = {
		kind: "pg",
		spelling: order === "counted" ? "integer" : d.from(["bigint", "integer"] as const)
	}
	const zero = (t: FieldType): Start =>
		t.kind === "text"
			? { kind: "text", value: "" }
			: t.kind === "pg" && t.spelling === "integer"
				? { kind: "integer", value: 0 }
				: { kind: "bigint", value: 0n }
	const noHandles: Start = { kind: "noHandles", roster: roster.name }
	const value: FieldType | undefined = (() => {
		switch (monoid) {
			case "concat":
				return fault === "monoidMismatch" ? { kind: "pg", spelling: "bigint" } : text
			case "sum":
				return fault === "monoidMismatch" ? { kind: "pg", spelling: "double precision" } : sumType
			case "count":
				return undefined
			case "or":
				return fault === "monoidMismatch" ? { kind: "pg", spelling: "bigint" } : set
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
	const ends: ReadonlyArray<readonly [FieldType, Start]> = (() => {
		if (fault === "finNotDrawn") {
			return finOfAccumulated ? [[{ kind: "natural" }, { kind: "bigint", value: 0n }]] : []
		}
		switch (monoid) {
			case "sum":
				return fault === "monoidMismatch"
					? [
							[
								{ kind: "pg", spelling: "double precision" },
								{ kind: "integer", value: 0 }
							]
						]
					: fault === "endPlanes"
						? [[set, noHandles]]
						: [[sumType, zero(sumType)]]
			case "count":
				return [[{ kind: "natural" }, { kind: "bigint", value: 0n }]]
			case "or":
				return fault === "monoidMismatch"
					? [
							[
								{ kind: "pg", spelling: "bigint" },
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
	const pair =
		value !== undefined &&
		((monoid === "sum" &&
			(fault === "countedPair" ||
				(fault === undefined && order === "ordered" && d.upTo(1) === 1))) ||
			(monoid === "concat" && fault !== "concatHidden" && fault !== "concatCounted"))
	const valueField: ReadonlyArray<FieldSpec> =
		value === undefined ? [] : [{ name: "v", type: value, writing: callerWriting }]
	const pairFields: ReadonlyArray<FieldSpec> = pair
		? [
				{ name: "before", type: value, writing: { kind: "accumulated", start: zero(value) } },
				{ name: "after", type: value, writing: { kind: "accumulated", start: zero(value) } }
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
				: { name: "k", type: { kind: "pg", spelling: "integer" }, writing: callerWriting },
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
			const mine = (name: string) => (name === "O" || name === "M" ? `${own}_${name}` : ids(name))
			const declarations = [
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
				const relations = new Map([
					["O", relationValue(owner, env.rosters, env.contracts)],
					["M", relationValue(member, env.rosters, env.contracts)]
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
					{ ...Rec.fromEntries([...env.rosters]), O: got(relations, "O"), M: got(relations, "M") },
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
			{ name: "k", type: { kind: "pg", spelling: "integer" }, writing: callerWriting }
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

/** A tree of its own: a node relation over itself, its parent of its key's type, or, a planted fault, of another. */
const treeProbe = (d: Drawing): Probe => {
	const loose = d.upTo(1) === 1
	const drawnField = (name: string): FieldSpec => ({
		name,
		type: { kind: "natural" },
		writing: { kind: "drawn" }
	})
	const node: RelationSpec = {
		name: "T",
		fields: [
			{ name: "id", type: { kind: "uuid" }, writing: callerWriting },
			{
				name: "parent",
				type: loose ? { kind: "pg", spelling: "integer" } : { kind: "uuid" },
				writing: callerWriting
			},
			drawnField("at"),
			drawnField("children"),
			drawnField("start"),
			drawnField("end"),
			{ name: "doc", type: { kind: "uuid" }, writing: callerWriting }
		],
		key: ["id"]
	}
	return {
		construct: "familyProbe",
		refused: loose ? "treeParentType" : undefined,
		text: (ids, own) => {
			const mine = (name: string) => (name === "T" ? `${own}_T` : ids(name))
			return {
				head: [`export const ${own}_T = ${relationSource(node, mine, quoted(node.key))}`],
				line: `export const ${own} = Sc.tree(Sc.on(${own}_T, "parent", "at"), Sc.fin(${own}_T, "children"), { root: "doc" })`,
				tail: []
			}
		},
		judge: (env) =>
			compiling(() => {
				const t = relationValue(node, env.rosters, env.contracts)
				return schema(
					"F",
					{ T: t },
					[treeBuilder(onBuilder(t, ["parent", "at"]), finBuilder(t, "children"), { root: "doc" })],
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
	| { readonly kind: "typmod"; readonly of: "float" | "numeric" | "vector"; readonly text: boolean }
	| { readonly kind: "lookAlike" }
	| { readonly kind: "crossSet"; readonly roster: RosterSpec }

/** A plain object with a uuid descriptor's sql and column, which no builder made. */
const lookAlikeSource =
	'{ sql: "uuid", column: { kind: "convert", convert: (text: string) => text } } as const'

const fieldCallSource = (call: FieldCall, ids: Ids): string => {
	switch (call.kind) {
		case "drawn":
			return `Fi.drawn(${fieldSource(call.type, ids)})`
		case "accumulated":
			return `Fi.accumulated(${call.type === "drawn" ? "Fi.drawn(Fi.natural)" : fieldSource(call.type, ids)}, ${startSource(call.start, ids)})`
		case "contract":
			return `Fi.contract("Probe", ${fieldSource(call.base, ids)})`
		case "span":
			return `Fi.span(${fieldSource(call.endpoint, ids)}${call.width === "none" ? "" : call.width === "number" ? ", 7" : ", 7n"})`
		case "numeric":
			return call.arguments === 1 ? "Fi.pg.numeric(5)" : "Fi.pg.numeric(5, 2)"
		case "typmod": {
			const first = (value: number) => (call.text ? jsonText(String(value)) : String(value))
			switch (call.of) {
				case "float":
					return `Fi.pg.float(${first(24)})`
				case "numeric":
					return `Fi.pg.numeric(${first(18)}, 0)`
				case "vector":
					return `Fi.pg.vector(${first(3)})`
			}
		}
		case "lookAlike":
			return `Sc.relation("LookAlike", { id: ${lookAlikeSource} }, ["id"])`
		case "crossSet":
			return `Fi.accumulated(Fi.bits(${ids(call.roster.name)}), Fi.Bits.of(Sc.closed("Other", [${quoted(call.roster.handles)}]), []))`
	}
}

const fieldCallValue = (call: FieldCall, env: Env): unknown => {
	switch (call.kind) {
		case "drawn": {
			const drawnOf: unknown = Reflect.apply(drawnField, undefined, [
				fieldValue(call.type, env.rosters, env.contracts),
				[]
			])
			return drawnOf
		}
		case "accumulated":
			return accumulatedField(
				call.type === "drawn"
					? drawnField(naturalDescriptor, [])
					: fieldValue(call.type, env.rosters, env.contracts),
				startValue(call.start, env.rosters),
				[]
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
			return call.arguments === 1 ? pgDescriptors.numeric(5) : pgDescriptors.numeric(5, 2)
		case "typmod": {
			const first = (value: number): number | string => (call.text ? String(value) : value)
			switch (call.of) {
				case "float":
					return floatOf(first(24))
				case "numeric":
					return pgDescriptors.numeric(first(18), 0)
				case "vector": {
					const vector: unknown = Reflect.apply(pgDescriptors.vector, undefined, [first(3)])
					return vector
				}
			}
		}
		case "crossSet":
			return accumulatedField(
				bits(got(env.rosters, call.roster.name)),
				bitsOf(closed("Other", call.roster.handles, []), [], []),
				[]
			)
		case "lookAlike": {
			const made: unknown = Reflect.apply(relation, undefined, [
				"LookAlike",
				{ id: { sql: "uuid", column: { kind: "convert", convert: (text: string) => text } } },
				["id"],
				[]
			])
			return made
		}
	}
}

/**
 * A field constructor: drawn over a natural or another type, accumulated over a value type or a field of a writing of
 * its own, its start of its type or not, a contract over a value domain or a serial, a span over an integer endpoint
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
			fault: "drawnNotNatural",
			call: {
				kind: "drawn",
				type: { kind: "pg", spelling: d.from(["integer", "bigint"] as const) }
			}
		},
		{
			fault: undefined,
			call: {
				kind: "accumulated",
				type: { kind: "pg", spelling: "bigint" },
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
				type: { kind: "pg", spelling: "bigint" },
				start: { kind: "integer", value: 0 }
			}
		},
		{
			fault: "accumulatedStart",
			call: {
				kind: "accumulated",
				type: { kind: "pg", spelling: "integer" },
				start: { kind: "bigint", value: 0n }
			}
		},
		{
			fault: undefined,
			call: {
				kind: "contract",
				base: d.from<FieldType>([
					{ kind: "pg", spelling: "bigint" },
					{ kind: "uuid" },
					{ kind: "closedId", roster: roster.name }
				])
			}
		},
		{
			fault: "contractOverSerial",
			call: { kind: "contract", base: { kind: "serial", spelling: d.from(serialSpellings) } }
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
			call: { kind: "span", endpoint: { kind: "pg", spelling: "integer" }, width: "number" }
		},
		{
			fault: undefined,
			call: { kind: "span", endpoint: { kind: "pg", spelling: "bigint" }, width: "bigint" }
		},
		{
			fault: "endpointType",
			call: {
				kind: "span",
				endpoint: d.from<FieldType>([
					{ kind: "pg", spelling: "smallint" },
					{ kind: "serial", spelling: d.from(serialSpellings) },
					{ kind: "pg", spelling: "money" },
					{ kind: "numeric", spelling: "numeric", precision: 10, scale: 0 }
				]),
				width: "none"
			}
		},
		{
			fault: "widthType",
			call: { kind: "span", endpoint: { kind: "pg", spelling: "integer" }, width: "bigint" }
		},
		{
			fault: "widthType",
			call: { kind: "span", endpoint: { kind: "pg", spelling: "bigint" }, width: "number" }
		},
		{ fault: undefined, call: { kind: "numeric", arguments: 2 } },
		{ fault: "numericArity", call: { kind: "numeric", arguments: 1 } },
		{
			fault: undefined,
			call: { kind: "typmod", of: d.from(["float", "numeric", "vector"] as const), text: false }
		},
		{
			fault: "argumentKind",
			call: { kind: "typmod", of: d.from(["float", "numeric", "vector"] as const), text: true }
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
		[{ kind: "pg", spelling: "integer" }, "1", 1, "2", 2],
		[{ kind: "pg", spelling: "bigint" }, "1n", 1n, "2n", 2n],
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
			`Sc.closed.relation("Rule", { ${idFields}, w: Fi.pg.integer, x: ${fieldSource(payloadType(c.payload), ids)} }, [${quoted(names)}], [${Arr.join(rows, ", ")}])`
		],
		...(c.generated
			? [
					[
						"Gen",
						`Sc.relation.generated("Gen", { id: Fi.uuid, ${idFields}, depth: Fi.pg.integer }, ["id"], (r) => ({ weight: Fi.generated(Fi.pg.integer, ${ids("Rule")}.at("w", ${Arr.join(
							Arr.map(names, (name) => `r.${name}`),
							", "
						)})), flags: Fi.generated(Fi.bits(${ids(Arr.lastNonEmpty(c.key).name)}), ${ids("Rule")}.row(${Arr.join(
							Arr.map(Arr.initNonEmpty(names), (name) => `r.${name}`),
							", "
						)})), next: Fi.generated(Fi.pg.bigint, Cp.Compute.cast(Cp.Compute.add(r.depth, 1), Fi.pg.bigint)) }))`
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
	...(base.family === undefined ? [] : familySources(base.family, ids)),
	...(base.alternatives === undefined
		? []
		: [
				[
					"alt",
					`Sc.alternatives(${ids(base.alternatives.parent)}, ${jsonText(base.alternatives.discriminator)}, ${ids(base.alternatives.roster)}, { ${Arr.join(
						Arr.map(base.alternatives.arms, ([h, arm]) => `${jsonText(h)}: ${ids(arm)}`),
						", "
					)} })`
				] as const
			])
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
			(r) => [r.name, `Sc.closed(${jsonText(r.name)}, [${quoted(r.handles)}])`] as const
		),
		...Arr.map(
			base.contracts,
			(c) => [c.name, `Fi.contract(${jsonText(c.name)}, ${fieldSource(c.base, ids)})`] as const
		),
		...Arr.map(base.relations, (r) => [r.name, relationSource(r, ids, quoted(r.key))] as const),
		...(base.closedRelation === undefined ? [] : closedDeclarations(base.closedRelation, ids)),
		...(base.family === undefined ? [] : [["slots", slotsSource(base.family, ids)] as const]),
		...statements,
		[
			"S",
			`Sc.schema("S", { ${Arr.join(
				Arr.map(members, (m) => `${m}: ${ids(m)}`),
				", "
			)} }, [${Arr.join(
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
						`Sc.schema.extend(${ids("S")}, { ${base.derived.name}: ${ids(base.derived.name)} }, [])`
					] as const
				]),
		...Arr.map(base.roles, (r) => {
			const entries = `{ ${Arr.join(
				Arr.map(wholeEntries(base), (name) => `${name}: ${ids(name)}`),
				", "
			)} }`
			return [
				`role_${r.name}`,
				Arr.isReadonlyArrayNonEmpty(r.write) || Arr.isReadonlyArrayNonEmpty(r.refresh)
					? `Sc.role(${ids(level)}, ${jsonText(r.name)}, ${entries}, { write: [${quoted(r.write)}], refresh: [${quoted(r.refresh)}] })`
					: `Sc.role(${ids(level)}, ${jsonText(r.name)}, ${entries})`
			] as const
		})
	]
}

/**
 * The whole entries a role holds: every roster, ordinary relation and derived relation of the level, each under its
 * own name; a closed relation is no role's entry.
 */
const wholeEntries = (base: Base): ReadonlyArray<string> => [
	...Arr.map(base.rosters, (r) => r.name),
	...Arr.map(base.relations, (r) => r.name),
	...(base.closedRelation?.generated === true ? ["Gen"] : []),
	...(base.derived === undefined ? [] : [base.derived.name])
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
const statementType = (desc: StatementDesc, ids: Ids): string => {
	switch (desc.kind) {
		case "key":
			return `St.Key<${sideType(desc.side, ids)}>`
		case "mutable":
			return `St.Mutable<typeof ${ids(desc.relation)}>`
		case "check":
			return `St.Check<${jsonText(desc.name)}, typeof ${ids(desc.relation)}>`
		case "contained":
			return `St.Containment<${sideType(desc.left, ids)}, ${sideType(desc.right, ids)}>`
		case "family": {
			const fin = `St.Fin<typeof ${ids(desc.slots.owner)}, ${jsonText(desc.slots.count)}>`
			return `St.${desc.order === "ordered" ? "Ordered" : "Counted"}<${sideType(desc.member, ids)}, ${fin}>`
		}
		case "tree":
			return `St.Tree<${sideType(desc.member, ids)}, St.Fin<typeof ${ids(desc.slots.owner)}, ${jsonText(desc.slots.count)}>, ${jsonText(desc.root)}>`
		case "fold":
			return `St.Fold<typeof ${ids("family")}, typeof Sc.Monoid.${desc.monoid}, ${sideType(desc.step, ids)}, ${sideType(desc.end, ids)}>`
		case "alternatives":
			return `St.Alternatives<typeof ${ids(desc.parent.relation)}, ${jsonText(desc.discriminator)}, typeof ${ids(desc.roster)}, ${objectType(Arr.map(desc.arms, (a) => [a.handle, `typeof ${ids(a.arm.relation)}`] as const))}>`
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
const viewType = (view: StatementView, ids: Ids): string => {
	switch (view.kind) {
		case "statement":
			return statementType(view.desc, ids)
		case "mirrors": {
			const [forward] = view.expansion.statements
			return `St.Mirrors<${sideType(forward.left, ids)}, ${sideType(forward.right, ids)}>`
		}
	}
}

/**
 * The containments a schema states, as the engine reads them: each containment, each mirrors' two, each alternatives
 * law's expansion.
 */
const containmentTypes = (views: ReadonlyArray<StatementView>, ids: Ids): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(views, (view) => {
			if (view.kind === "mirrors") {
				return Arr.map(view.expansion.statements, (c) => statementType(c, ids))
			}
			const s = view.desc
			switch (s.kind) {
				case "contained":
					return [statementType(s, ids)]
				case "alternatives":
					return Arr.map(expandAlternatives(s), (c) => statementType(c, ids))
				case "key":
				case "mutable":
				case "check":
				case "family":
				case "tree":
				case "fold":
					return []
			}
		})
	)

/** A field's descriptor as its type: what the engine's Description of it (desc, writing) makes it. */
const descriptorType = (decl: FieldDecl, base: Base, ids: Ids): string => {
	switch (decl.writing.kind) {
		case "drawn":
			return "Fi.DrawnField"
		case "accumulated":
			return `Fi.AccumulatedField<${valueDescriptorType(decl.type, base, ids)}>`
		case "serial":
			return `Fi.SerialField<${hostOfDesc(decl.type, base, ids)}, ${jsonText(sqlOfDesc(decl.type))}>`
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
			return `Fi.Field<${pgHost[desc.type]}, ${jsonText(desc.type)}>`
		case "numeric":
			return "Fi.NumericTypmodField"
		case "uuid":
			return 'Fi.Field<Fi.Uuid, "uuid">'
		case "text":
			return `Tx.RegexText<${hostOfDesc(desc, base, ids)}, ${jsonText(desc.source)}, ${jsonText(desc.flags)}>`
		case "contract": {
			if (builtinDesc(desc)) {
				return desc.base.kind === "pg" && desc.base.type === "date"
					? "Fi.DateField"
					: "Fi.NaturalField"
			}
			return `Fi.Contract<${jsonText(desc.name)}, ${valueDescriptorType(desc.base, base, ids)}>`
		}
		case "span":
			return `Fi.SpanField<${hostOfDesc(desc.endpoint, base, ids)}, Ph.DomainOf<${valueDescriptorType(desc.endpoint, base, ids)}>>`
		case "closedId":
			return `Fi.ClosedIdField<typeof ${ids(desc.roster)}>`
		case "bits":
			return `Fi.BitsField<typeof ${ids(desc.roster)}>`
		case "vector":
			return `Fi.VectorField<${desc.dimensions}>`
	}
}

/**
 * The literal a field's comparison takes, as the engine admits one (schema/literal.ts literalResult): its base's host
 * value, a contract's literal its base's, and a numeric's a Decimal, a bigint or an exact decimal string. A vector's,
 * a buffer of its dimensions, has a type the public barrels do not name, so a vector field's is not asserted.
 */
const literalType = (
	desc: Exclude<FieldDesc, { readonly kind: "vector" }>,
	base: Base,
	ids: Ids
): string => {
	switch (desc.kind) {
		case "contract":
			return desc.base.kind === "vector"
				? hostOfDesc(desc, base, ids)
				: literalType(desc.base, base, ids)
		case "numeric":
			return "Fi.Decimal | bigint | string"
		case "bits":
			return `ReadonlySet<${literalUnion(rosterNamed(base, desc.roster).handles)}>`
		case "pg":
		case "uuid":
		case "text":
		case "span":
		case "closedId":
			return hostOfDesc(desc, base, ids)
	}
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
			expect(
				`written_${r.name}`,
				`Cs.Written<typeof ${ids(r.name)}>`,
				objectType(Arr.filter(h.fact, ([name]) => Arr.contains(h.written, name)))
			),
			expect(`addition_${r.name}`, `Cs.Addition<typeof ${ids(r.name)}>`, additionType(h, [])),
			expect(
				`serial_${r.name}`,
				`Sc.SerialFieldsOf<typeof ${ids(r.name)}>`,
				literalUnion(h.serial)
			),
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
		),
		expect(
			`refreshes_${r.name}`,
			`Sc.RefreshListOf<typeof ${ids(`role_${r.name}`)}>`,
			typeUnion(Arr.map(got(env.refreshes, r.name), (name) => `typeof ${ids(name)}`))
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
					...derivedAssertions(base.derived, base, env, artifacts, ids)
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
 * a real, a count a bigint), and its keys, those the engine infers it inherits, each an unordered set of its fields.
 */
const derivedAssertions = (
	spec: DerivedSpec,
	base: Base,
	env: Env,
	artifacts: SchemaArtifacts,
	ids: Ids
): ReadonlyArray<string> => {
	const expect = (name: string, actual: string, expected: string): string =>
		`export type ${ids(`t_${name}`)} = Expect<Equals<${actual}, ${expected}>>`
	const columns = compiledColumns(definitionOf(spec, base, env.schema, env.relations))
	const analysis = artifacts.derived.relations[spec.name]
	const keys =
		analysis === undefined
			? []
			: Arr.map(analysis.keys, (k) => `ReadonlyArray<${literalUnion(k.fields)}>`)
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
			Arr.isReadonlyArrayNonEmpty(keys) ? Arr.join(keys, " | ") : "never"
		)
	]
}

/**
 * The statements' types, each the engine's Description of it as a type; the schema's captured tuple, its statements in
 * order; its containments, each containment and each alternatives law's expansion; and a family's fin.
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
		ids
	)
	return [
		...Arr.map(named, ([name, view]) =>
			expect(`statement_${name}`, `typeof ${ids(name)}`, viewType(view, ids))
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
	const exact = Str.includes("\\u")(desc.source)
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
 * each caller field's host as a span endpoint, whether the engine's span core admits it, and its literal; each
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
						`[${fieldOfR(name)}] extends [Fi.SpanEndpointLike] ? true : false`,
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
 * describeField): a constructor such as pg.numeric or str is none; and whether one pg spelling's descriptor is another's,
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
		const [dx, dy] = [describedAs(pgDescriptors[x]), describedAs(pgDescriptors[y])]
		const same = dx !== undefined && dy !== undefined && dx.ok && dy.ok && dx.value === dy.value
		const wy = writingOf(pgDescriptors[y]).kind
		const assignable = same && (wy === "caller" || writingOf(pgDescriptors[x]).kind === wy)
		const spelled = (s: Spelling) =>
			s === "double precision" ? 'Fi.pg["double precision"]' : `Fi.pg.${s}`
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
		Arr.makeBy(groups, () => `\${string}`),
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
					keysAt([parent, family.root])
				),
				expect(
					"nested_grandchild",
					`keyof ${top}[${jsonText(family.count)}][number][${jsonText(family.count)}][number]`,
					keysAt([parent, family.root])
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
 * admitEncodable) and of the value at a vector field's type (schema/literal.ts literalResult) is the oracle.
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
	const components = (k: number) => Arr.map(Arr.range(1, k), (i) => i % 2)
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
						`export const ${own}: Fi.Vector<${form.target === "same" ? n : other}> = Fi.Vector.make(${bufferSource(form.buffer)}, ${form.dims === "number" ? n : jsonText(String(n))})`
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
					return made.ok
						? valueVerdict(
								literalResult(
									{ kind: "vector", dimensions: form.target === "same" ? n : other },
									made.value,
									undefined
								)
							)
						: engineVerdict(made)
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
			oneLine(`export const ${own} = Fi.Bits.of(${ids(roster.name)}, [${quoted(written)}])`),
		judge: (env) => building(() => bitsOf(got(env.rosters, roster.name), written, []))
	}
}

/**
 * A contract named by a constant whose type is one literal, or, a planted fault, a union of literals, a string or a
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
			line: `export const ${own} = Fi.contract(${own}_name, Fi.pg.bigint)`,
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
					describeFieldOrThrow(
						admitContract(name, pgDescriptors.bigint, []),
						SourceLoc("contract name", [])
					).scalar
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
	| { readonly fault: "echoRoster" | undefined; readonly read: "generated" }

/**
 * A read of the base's closed relation, at its key of one to three closed ids: C.at of a payload field at a full key,
 * C.row at a key prefix, or a generated field reading C.at at its row's closed ids; valid, or with one planted fault: a
 * key short of a field, a payload field Rule does not declare, a key field read as a payload, a key value of no handle,
 * its first two key values swapped, a row's prefix short of a field or the whole key, a closed id of another roster whose handles have Rule's first key roster's spellings. The engine's closed
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
		onNonEmpty: ([[r2, h2], ...tail]) =>
			!Arr.contains(k1.handles, h2) || !Arr.contains(r2.handles, h1)
				? [{ fault: "atSwapped", read: "at", key: [h2, h1, ...Arr.map(tail, ([, h]) => h)] }]
				: []
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
				case "generated": {
					const roster = form.fault === "echoRoster" ? `${own}_Echo` : ids(k1.name)
					const restFields = Arr.zipWith(
						echoNames,
						rest,
						(name, r) => `, ${name}: Fi.closedId(${ids(r.name)})`
					)
					const reads = Arr.map(echoNames, (name) => `, r.${name}`)
					return {
						head: [`export const ${own}_Echo = Sc.closed("Echo", [${quoted(k1.handles)}])`],
						line: `export const ${own} = Sc.relation.generated("Echoed", { id: Fi.uuid, echo: Fi.closedId(${roster})${Arr.join(restFields, "")} }, ["id"], (r) => ({ w: Fi.generated(Fi.pg.integer, ${ids("Rule")}.at("w", r.echo${Arr.join(reads, "")})) }))`,
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
				case "generated":
					return compiling(() => {
						const echo = closed("Echo", k1.handles, [])
						const echoed = generatedRelation(
							"Echoed",
							{
								id: uuidDescriptor,
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
									pgDescriptors.integer,
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
						return schema("P", { ...env.members, Echo: echo, Echoed: echoed }, [...env.core], [])
					})
			}
		}
	}
}

/** How a generated probe states its generated fields: reading its caller's fields, or with one planted fault. */
type GeneratedForm =
	| "readsCaller"
	| "generatedReadsGenerated"
	| "generatedReadsAccumulated"
	| "generatedReadsDrawn"
	| "generatedWrongType"
	| "generatedTwiceNamed"
	| "generatedKey"

/**
 * A relation with generated fields over its caller's id, depth and set w. Valid, a generated set reading w; or a
 * planted fault: a generated field reading another, an accumulated set or a drawn count declared beside w, a term of a
 * type other than its field's, a generated field named as a written one, a primary key naming a generated field. The engine's compilation of a schema holding it is the oracle.
 */
const generatedProbe = (d: Drawing, base: Base): Probe => {
	const roster = d.from(base.rosters)
	const form = d.from<GeneratedForm>([
		"readsCaller",
		"generatedReadsGenerated",
		"generatedReadsAccumulated",
		"generatedReadsDrawn",
		"generatedWrongType",
		"generatedTwiceNamed",
		"generatedKey"
	])
	const nextSource =
		"Fi.generated(Fi.pg.bigint, Cp.Compute.cast(Cp.Compute.add(r.depth, 1), Fi.pg.bigint))"
	const callbackSource = (set: string): string => {
		switch (form) {
			case "readsCaller":
				return `{ g: Fi.generated(${set}, Cp.Compute.union(r.w, r.w)) }`
			case "generatedReadsGenerated":
				return `{ next: ${nextSource}, twice: Fi.generated(Fi.pg.bigint, Cp.Compute.add(r.next, 1n)) }`
			case "generatedReadsAccumulated":
				return `{ g: Fi.generated(${set}, r.acc) }`
			case "generatedReadsDrawn":
				return "{ m: Fi.generated(Fi.pg.bigint, Cp.Compute.add(r.n, 1n)) }"
			case "generatedWrongType":
				return "{ label: Fi.generated(Fi.pg.bigint, r.depth) }"
			case "generatedTwiceNamed":
				return "{ depth: Fi.generated(Fi.pg.integer, r.depth) }"
			case "generatedKey":
				return `{ next: ${nextSource} }`
		}
	}
	return {
		construct: "generatedProbe",
		refused: form === "readsCaller" ? undefined : form,
		text: (ids, own) => {
			const set = `Fi.bits(${ids(roster.name)})`
			return oneLine(
				`export const ${own} = Sc.relation.generated("Generated", { id: Fi.uuid, depth: Fi.pg.integer, w: ${set}${form === "generatedReadsAccumulated" ? `, acc: Fi.accumulated(${set}, Fi.Bits.of(${ids(roster.name)}, []))` : ""}${form === "generatedReadsDrawn" ? ", n: Fi.drawn(Fi.natural)" : ""} }, [${form === "generatedKey" ? '"next"' : '"id"'}], (r) => (${callbackSource(set)}))`
			)
		},
		judge: (env) =>
			compiling(() => {
				const rosterValue = got(env.rosters, roster.name)
				const set = fieldValue({ kind: "bits", roster: roster.name }, env.rosters, env.contracts)
				const next = (row: Readonly<Record<string, unknown>>) =>
					generatedField(
						pgDescriptors.bigint,
						computeCore.cast(computeCore.add(row["depth"], 1), pgDescriptors.bigint),
						[]
					)
				const callback = (
					row: Readonly<Record<string, unknown>>
				): Readonly<Record<string, unknown>> => {
					switch (form) {
						case "readsCaller":
							return { g: generatedField(set, computeCore.union(row["w"], row["w"]), []) }
						case "generatedReadsGenerated":
							return {
								next: next(row),
								twice: generatedField(pgDescriptors.bigint, computeCore.add(row["next"], 1n), [])
							}
						case "generatedReadsAccumulated":
							return { g: generatedField(set, row["acc"], []) }
						case "generatedReadsDrawn":
							return { m: generatedField(pgDescriptors.bigint, computeCore.add(row["n"], 1n), []) }
						case "generatedWrongType":
							return { label: generatedField(pgDescriptors.bigint, row["depth"], []) }
						case "generatedTwiceNamed":
							return { depth: generatedField(pgDescriptors.integer, row["depth"], []) }
						case "generatedKey":
							return { next: next(row) }
					}
				}
				const made: unknown = Reflect.apply(generatedRelation, undefined, [
					"Generated",
					{
						id: uuidDescriptor,
						depth: pgDescriptors.integer,
						w: set,
						...(form === "generatedReadsAccumulated"
							? { acc: accumulatedField(set, bitsOf(rosterValue, [], []), []) }
							: {}),
						...(form === "generatedReadsDrawn" ? { n: drawnField(naturalDescriptor, []) } : {})
					},
					[form === "generatedKey" ? "next" : "id"],
					callback,
					[]
				])
				const built: unknown = Reflect.apply(schema, undefined, [
					"P",
					{ ...Rec.fromEntries([...env.rosters]), Generated: made },
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
				`export const ${own}_Version = Sc.closed("Version", ["v0", "v1"])`,
				`export const ${own}_Position = Sc.closed("Position", [${quoted(positions)}])`,
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
							`export const ${own}_Step = Sc.relation.generated("Step", { id: Fi.pg.integer, version: Fi.closedId(${own}_Version), from: Fi.closedId(${own}_Position) }, ["id"], (r) => ({ next: Fi.generated(Fi.bits(${own}_Position), ${own}.row(r.version, r.from)) }))`,
							`export const ${own}_Slotted = Sc.schema("Slotted", { Version: ${own}_Version, Position: ${own}_Position, Model: ${own}_Model, Follow: ${own}, Step: ${own}_Step }, [])`,
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
							`export const ${own}_Owner = Sc.relation("Owner", { id: Fi.pg.integer, n: Fi.drawn(Fi.natural) }, ["id"])`
						],
						line: `export const ${own} = Fi.slot(Fi.closedId(${own}_Position), Sc.fin(${own}_Owner, "n"))`,
						tail: []
					}
				case "slotNotClosed":
					return {
						head,
						line: `export const ${own} = Fi.slot(Fi.pg.integer, Sc.fin(${own}_Model, "positions"))`,
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
			const version = closed("Version", ["v0", "v1"], [])
			const position = closed("Position", positions, [])
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
						{ id: pgDescriptors.integer, version: closedId(version), from: closedId(position) },
						["id"],
						(row: Readonly<Record<string, unknown>>) => ({
							next: generatedField(
								bits(position),
								closedCall(follow.row, follow, [row["version"], row["from"]]),
								[]
							)
						}),
						[]
					)
					return schema(
						"Slotted",
						{ Version: version, Position: position, Model: model, Follow: follow, Step: step },
						[],
						[]
					)
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
							{ id: pgDescriptors.integer, n: drawnField(naturalDescriptor, []) },
							["id"],
							[]
						)
						return slotField(closedId(position), finBuilder(owner, "n"), [])
					})
				case "slotNotClosed":
					return building(() => {
						const made: unknown = Reflect.apply(slotField, undefined, [
							pgDescriptors.integer,
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
 * A contract over a serial, refused where it is declared, then read where a descriptor is admitted: as the base of a
 * further contract, the serial at depth two of its chain, or as a span's endpoint. Each is a planted fault, the
 * serial anywhere down the chain refused as at depth one; the engine refuses the inner contract, so the chain is never
 * built. The probe is never admitted, so its construct is noted where drawn.
 */
const serialChainProbe = (d: Drawing): Probe => {
	d.note("serialChainProbe")
	const serial = d.from(serialSpellings)
	const fault = d.from(["serialUnderContract", "spanOverSerialChain"] as const)
	const inner = () => admitContract("Inner", pgDescriptors[serial], [])
	return {
		construct: "serialChainProbe",
		refused: fault,
		text: (_ids, own) => ({
			head: [
				"// @ts-expect-error -- TS2345 refusal: a contract is a value domain; a serial is a generation declaration, so use its integer type",
				`export const ${own}_inner = Fi.contract("Inner", Fi.pg.${serial})`
			],
			line:
				fault === "serialUnderContract"
					? `export const ${own} = Fi.contract("Outer", ${own}_inner)`
					: `export const ${own} = Fi.span(${own}_inner)`,
			tail: []
		}),
		judge: () =>
			building(() =>
				fault === "serialUnderContract"
					? admitContract("Outer", inner(), [])
					: spanDescriptor(inner())
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
 * to a field of another type, a contract's to its base's or its base's to the contract's, in a match or a negation; a
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
				`export const ${own}_Cents = Fi.contract("Cents", Fi.pg.bigint)`,
				`export const ${lit} = Sc.relation("Lit", { id: Fi.uuid, f: ${fieldSource(type, ids)}, n: Fi.pg.bigint, c: ${own}_Cents }, ["id"])`,
				`export const ${own}_P = Sc.schema("P", { ${Arr.join(
					Arr.map(base.rosters, (r) => `${r.name}: ${ids(r.name)}`),
					", "
				)}, Lit: ${lit} }, [])`
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
							`const { id, f } = Q.v(${lit}, "lit"); return r.match(${lit}, { id, f }).where(r.inSet(f, [${literal.source}])).find({ id })`
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
				case "bindingType":
				case "negatedBindingType": {
					const binding = contractWay === "contract var at base" ? "{ id, n: c }" : "{ id, c: n }"
					return {
						head,
						line: rule(
							form === "bindingType"
								? `const { id, c, n } = Q.v(${lit}, "lit"); return r.match(${lit}, ${binding}).find({ id })`
								: `const { id, c, n } = Q.v(${lit}, "lit"); return r.match(${lit}, { id, c, n }).where(r.not(${lit}, ${binding})).find({ id })`
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
							`export const ${own}_Elsewhere = Sc.relation("Elsewhere", { id: Fi.uuid }, ["id"])`,
							`export const ${own}_Other = Sc.schema("Other", { Elsewhere: ${own}_Elsewhere }, [])`
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
			const cents = admitContract("Cents", pgDescriptors.bigint, [])
			const lit = relation(
				"Lit",
				{
					id: uuidDescriptor,
					f: fieldValue(type, env.rosters, env.contracts),
					n: pgDescriptors.bigint,
					c: cents
				},
				["id"],
				[]
			)
			const p = schema("P", { ...Rec.fromEntries([...env.rosters]), Lit: lit }, [], [])
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
								.where(rule.inSet(vars["f"], [literal.value]))
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
				case "negatedBindingType":
					return querying(() =>
						queryOver(p).rule((rule: RuleValue) => {
							const vars = varsOver(lit, "lit")
							const binding =
								contractWay === "contract var at base"
									? { id: vars["id"], n: vars["c"] }
									: { id: vars["id"], c: vars["n"] }
							return form === "bindingType"
								? rule.match(lit, binding).find({ id: vars["id"] })
								: rule
										.match(lit, { id: vars["id"], c: vars["c"], n: vars["n"] })
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
					const elsewhere = relation("Elsewhere", { id: uuidDescriptor }, ["id"], [])
					const other = schema("Other", { Elsewhere: elsewhere }, [], [])
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
		case "integer":
			return ["number"]
		case "bigint":
			return ["bigint"]
		case "numeric":
			return ["bigint", "decimal", "decimalValue"]
		case "boolean":
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
const castTypes = ["smallint", "integer", "bigint"] as const

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
				`export const ${own} = Sc.relation.generated("Cast", { id: Fi.uuid, depth: Fi.pg.${from} }, ["id"], (r) => ({ next: Fi.generated(Fi.pg.${to}, Cp.Compute.cast(Cp.Compute.add(r.depth, ${from === "bigint" ? "1n" : "1"}), Fi.pg.${to})) }))`
			),
		judge: () =>
			compiling(() => {
				const cast = generatedRelation(
					"Cast",
					{ id: uuidDescriptor, depth: pgDescriptors[from] },
					["id"],
					(row: Readonly<Record<string, unknown>>) => ({
						next: generatedField(
							pgDescriptors[to],
							computeCore.cast(
								computeCore.add(row["depth"], from === "bigint" ? 1n : 1),
								pgDescriptors[to]
							),
							[]
						)
					}),
					[]
				)
				return schema("P", { Cast: cast }, [], [])
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
				fault === undefined && statement.kind !== "key" && statement.kind !== "mutable"
					? [
							`export type ${own}_law = Expect<Equals<typeof ${own}, St.${statement.kind === "contained" ? "Containment" : "Mirrors"}<${lawSideType(statement.left, ids)}, ${lawSideType(statement.right, ids)}>>>`
						]
					: []
		}),
		judge: (env) => compiling(() => probeSchema(env, [statementValue(statement, env.relations)]))
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
	["alternativesProbe", alternativesProbe],
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
	["serialChainProbe", (d) => serialChainProbe(d)],
	["ruleProbe", ruleProbe],
	["slotKeyProbe", (d) => slotKeyProbe(d)],
	["slotSideProbe", slotSideProbe],
	["slotContainmentProbe", slotContainmentProbe]
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
		Arr.flatMap(Arr.range(0, 1 + d.upTo(1)), () => {
			const probe = make(d, base)
			return probe === undefined ? [] : [probe]
		})
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
	if (judged.key !== expectedKey(refusing.engine)) {
		throw new Error(
			`the oracle refuses a probe planting ${probe.refused} for ${judged.key}, not ${expectedKey(refusing.engine)}: ${judged.message}`
		)
	}
	const claim = refusing.claim
	const directive =
		claim.kind === "refusal"
			? `// @ts-expect-error -- ${refusing.code} refusal: ${claim.message}`
			: `// @ts-expect-error -- ${refusing.code}: ${claim.why}`
	return {
		lines: (ids, own) => {
			const text = probe.text(ids, own, env)
			return [...text.head, directive, text.line, ...text.tail]
		},
		notes: [planted, ...(claim.kind === "refusal" ? [claim.message] : [])]
	}
}

/** One case: its base's declarations and assertions, its probes' statements, and what it reached. */
interface SchemaCase {
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
	return {
		lines: (prefix) => {
			const ids: Ids = (name) => `${prefix}_${name}`
			return [
				...Arr.map(
					baseDeclarations(base, ids),
					([name, source]) => `export const ${ids(name)} = ${source}`
				),
				...assertions(ids),
				...Arr.flatMap(stated, (s, i) => s.lines(ids, `${prefix}_p${i}`))
			]
		},
		notes: new Set<SchemaNote>([...reached, ...Arr.flatMap(stated, (s) => s.notes)])
	}
}

/** The cases the run's own stream draws. */
const schemaCount = 48

/** The label both populations are drawn under. */
const schemaLabel = "types/schema agreement"

const caseGen: Gen<SchemaCase> = (source) => caseOf(drawnGen(source))

/**
 * The floor's witnesses: drawn under the label alone, the same on every run, and the only cases whose notes meet the
 * required situations (test/types/schema/agreement.test.ts).
 */
export const schemaWitnesses = () =>
	floorPopulation(schemaLabel, caseGen, schemaCount, (c): ReadonlyArray<Reached<SchemaNote>> => [
		...c.notes
	])

/** Every Refusal message a fault's directive names. */
const namedRefusals: ReadonlyArray<TypeRefusal> = Arr.dedupe(
	Arr.flatMap(schemaFaults, (f) => {
		const claim = refusals[f].claim
		return claim.kind === "refusal" ? [claim.message] : []
	})
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

export const schemaEntriesFrom = (entry: (path: string) => string): SchemaEntries => ({
	schema: entry("packages/engine/src/public/schema.ts"),
	fields: entry("packages/engine/src/public/fields.ts"),
	text: entry("packages/engine/src/public/text.ts"),
	query: entry("packages/engine/src/public/query.ts"),
	changeset: entry("packages/engine/src/types/changeset/changeset.ts"),
	fieldTypes: entry("packages/engine/src/types/fields/field.ts"),
	statementTypes: entry("packages/engine/src/types/schema/statements.ts"),
	decoder: entry("packages/engine/src/core/decoder.ts"),
	compute: entry("packages/engine/src/public/compute.ts"),
	phantom: entry("packages/engine/src/types/core/phantom.ts"),
	relationTypes: entry("packages/engine/src/types/schema/relation.ts"),
	result: entry("packages/engine/src/core/result.ts"),
	errors: entry("packages/engine/src/core/errors.ts")
})

/**
 * The program over the run's cases: the floor's witnesses, then the stream of the agreement's label under the run's
 * seed, so every process of one run draws the same cases and every run new ones.
 */
export const schemaModules = (
	entries: SchemaEntries,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = [
		...schemaWitnesses().values,
		...sample(caseGen, rotatingSeed(seed, floorSeed(schemaLabel)), schemaCount)
	]
	return [
		{
			file: "index.ts",
			source: Arr.join(
				[
					"// Generated by test/support/agreement/schemas.ts: the schema agreement program.",
					'import type { Brand } from "effect"',
					`import type * as Cd from ${jsonText(entries.decoder)}`,
					`import * as Cp from ${jsonText(entries.compute)}`,
					`import type * as Ph from ${jsonText(entries.phantom)}`,
					`import type * as Rf from ${jsonText(entries.relationTypes)}`,
					`import type * as Er from ${jsonText(entries.errors)}`,
					`import type * as Rs from ${jsonText(entries.result)}`,
					`import type * as Cs from ${jsonText(entries.changeset)}`,
					`import type * as Ff from ${jsonText(entries.fieldTypes)}`,
					`import * as Fi from ${jsonText(entries.fields)}`,
					`import * as Q from ${jsonText(entries.query)}`,
					`import * as Sc from ${jsonText(entries.schema)}`,
					`import type * as St from ${jsonText(entries.statementTypes)}`,
					`import * as Tx from ${jsonText(entries.text)}`,
					"",
					"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
					"type Expect<T extends true> = T",
					"/** Mutual assignability: a nested addition's intersections and omissions are no object type to compare exactly. */",
					"type Alike<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false",
					"/** The names of the relations a ChangeSet over S may write: ordinary, never closed or derived. */",
					"type WritableNames<S> = Cs.WritableOf<S> extends infer R ? (R extends { readonly name: infer N } ? N : never) : never",
					"",
					...Arr.flatMap(cases, (c, i) => c.lines(`c${i}`)),
					""
				],
				"\n"
			)
		}
	]
}
