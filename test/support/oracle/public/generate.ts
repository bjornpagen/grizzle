import { array, constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import type { Source as Decisions } from "@grizzle/testing/source"
import {
	keep,
	type Presence,
	type Swarm,
	type SwarmWeight,
	swarm,
	swarmChoice,
	weightOf
} from "@grizzle/testing/swarm"
import { Array as Arr, Effect, Option } from "effect"
import { AllenMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { indices } from "#compiler/core/array.ts"
import {
	conversionOf,
	type DeclaredName,
	decodedColumnFits,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { nativeEqualityKey, type TypedLiteral } from "#compiler/ir/expr.ts"
import { baseOf, numericTypmodOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { noRosters, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { type AmbientSession, ambientSessionGen } from "#test/support/ambient.ts"
import { fileText, joinPath } from "#test/support/files.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { admittedNames, literalDictionary, readmeStrings } from "#test/support/kernel/dict.ts"
import {
	canonicallySpelled,
	compareParamType,
	hasCap,
	numeric as wideNumeric,
	numericPaddings,
	paddedText,
	scalarOfSpec,
	type SpelledValue,
	spelledAt,
	twinSpellings,
	twinsOf,
	valueClasses
} from "#test/support/oracle/gen/domain.ts"
import { aggregateResult, type CompareOp, compareOps } from "#test/support/oracle/gen/ops.ts"
import { type Restorage, restorageGen } from "#test/support/oracle/gen/restorage.ts"
import { type Perturbation, plannerPerturbationGen } from "#test/support/oracle/perturb.ts"
import {
	deliveryProof,
	keysOf,
	licensed,
	type Parent
} from "#test/support/oracle/public/delivery.ts"

import {
	type AggregateFn,
	type AllenAtom,
	type ArgTerm,
	type Attachment,
	aggregateFns,
	type Between,
	type Binding,
	type ProgramBound,
	type ProgramCase,
	type Closure,
	type Column,
	type Comparison,
	type ComputedTerm,
	type Connective,
	type Delivery,
	type Derived,
	endpointType,
	storedFactValues,
	type ProgramFact,
	type ProgramField,
	type FieldKind,
	fieldKinds,
	type HeadItem,
	type ImportBind,
	type Imported,
	type InSet,
	type Interior,
	isAggregate,
	keyKinds,
	type LiteralKind,
	literalKinds,
	type Match,
	type MixedRoot,
	type NameKind,
	type Negation,
	type Operand,
	type OrderKey,
	type Param,
	type Padding,
	type ParamDeclaration,
	type ParentColumn,
	type PointIn,
	type Probe,
	type Query,
	type ProgramRead,
	type RelationParam,
	type Root,
	type CaseRoster,
	type Rule,
	type ProgramSchema,
	type Source,
	type StatedDelivery,
	type Stored,
	type StoredFact,
	sourceFields,
	type Var
} from "#test/support/oracle/public/program.ts"
import { argType, computedType } from "#test/support/oracle/public/terms.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"

/**
 * The features a case's swarm turns on, off and thins.
 *
 * How a match binds a field; a fresh variable is the floor.
 *
 * A comparison, and what it compares a variable with; a literal is the floor.
 *
 * A relation's second field a double precision, whose zero has a twin spelling, -0, stored and printed apart while
 * equal by value (gen/domain.ts twinSpellings); an attachment's correlation on such a column where its parent has one.
 *
 * A head of variables finds every variable of its rule, up to four.
 *
 * An aggregate head folds the whole rule, no variable grouping it: at most one row, which db.get answers.
 *
 * An attachment states a delivery narrower than the array where its child's proof licenses one, and its child takes
 * one of the forms built to be proved (a plain child is the floor).
 *
 * A relation's last field a handle outside its primary key: the field an arm reads its parent's discriminator from.
 *
 * A root rule's later match reads an earlier read's query, its parameters bound to the rule's variables where one
 * fits ("import bound") and to fresh parameters of the read otherwise.
 *
 * A root rule's later match reads an interior stage of the rule.
 *
 * The root is named after its bound.
 *
 * A head holds Compute terms; an aggregate's groups are keyed by them.
 *
 * A rule filters by r.and or r.or over comparisons, or over none: the constant true or false.
 *
 * A root rule's later match reads a relation-valued parameter, or an acyclic closure over one relation.
 *
 * Each relation gains a Tick field, whose parameters are declared as the contract; a numeric(5,2) field, whose
 * parameters are declared with the typmod; a span field, which r.allen relates and r.pointIn tests.
 *
 * A union's arms each state one head key as a literal of one field kind, distinct across the arms.
 */
const swarmFeatures = [
	"bind fresh",
	"bind join",
	"bind existential",
	"bind literal",
	"bind param",
	"bind parent",
	"where",
	"compare literal",
	"compare var",
	"compare param",
	"negation",
	"aggregate",
	"unit head",
	"union",
	"take",
	"attached take",
	"ordered",
	"attach",
	"nested",
	"roster",
	"dense",
	"candidate key",
	"key read",
	"probe",
	"spelled",
	"full head",
	"ungrouped",
	"stated delivery",
	"plain child",
	"keyed child",
	"reflexive child",
	"arm child",
	"handle field",
	"import",
	"import bound",
	"interior",
	"named",
	"computed head",
	"computed group key",
	"between",
	"in set",
	"connective",
	"relation param",
	"recursive",
	"contract param",
	"typmod param",
	"allen",
	"point in",
	"literal head"
] as const
export type SwarmFeature = (typeof swarmFeatures)[number]

/**
 * The program forms the generator reaches beyond the language's plain rules, each named once: computed group keys,
 * contract params, typmod params, imports bound to outer vars, r.allen, r.pointIn and interiors; import, bind,
 * interior, named, compute head, between, in set, an in set of no value (a membership no row holds), r.and() and r.or()
 * of no predicate (the constants true and false), relation param and recursive.
 *
 * A root rule matches an earlier query read of the case.
 *
 * It matches one that keeps its attachments, of which it reads only the root's rows.
 *
 * Query.bind of an imported parameter to an outer variable.
 *
 * Query.bind of an imported parameter to a parameter of the read.
 *
 * A root rule matches an r.interior stage of its own.
 *
 * The root's query is Query.named after its bound.
 *
 * Compute.base, Compute.numeric(...) or Compute.cond over a numeric variable in a head.
 *
 * Such a key grouping an aggregate head.
 *
 * r.relation(name, R) matched as a source.
 *
 * An acyclic closure over two fields of one relation, matched as a source.
 *
 * A comparison of a Tick field with a parameter declared as the contract.
 *
 * A match binding of a Tick field to such a parameter.
 *
 * A match binding of a numeric(5,2) field to a parameter declared numeric(5,2).
 *
 * A comparison of such a field with such a parameter.
 *
 * r.allen(a, mask, b) over two span variables.
 *
 * r.pointIn(point, span).
 *
 * Arms of one heading whose literal head key differs between at least two of them (a JavaScript value in each arm's
 * head).
 */
export const programForms = [
	"an import",
	"an import of an attached query",
	"an import bound to an outer variable",
	"an import bound to a parameter",
	"an interior",
	"a named stage",
	"a computed head key",
	"a computed group key",
	"a between",
	"an in set",
	"an empty in set",
	"an empty conjunction",
	"an empty disjunction",
	"a relation param",
	"a recursive closure",
	"compare a contract field with a param",
	"bind a contract field to a param",
	"bind a numeric typmod field to a param",
	"compare a numeric typmod field with a param",
	"an Allen relation",
	"a point in a span",
	"arms differing in a literal head key",
	"an attached take"
] as const
export type ProgramForm = (typeof programForms)[number]

/**
 * The forms of a mixed root (program.ts MixedRoot), required by a suite that reads one.
 *
 * A heterogeneous union two of whose arms of one key set state different literals at one head key: a decoder that
 * keys the union's layouts by key set alone reads one of them as the other.
 */
export const mixedForms = [
	"a heterogeneous union whose arms of one key set differ in a literal head key"
] as const
export type MixedForm = (typeof mixedForms)[number]

/** The forms a mixed root reaches. */
export const mixedFeatures = (root: MixedRoot): ReadonlyArray<MixedForm> =>
	root.groups.length > 1 &&
	Arr.some(indices(root.groups.length), (g) =>
		literalDistinct(Arr.flatMap(root.arms, (a) => (a.group === g ? [a.rule] : [])))
	)
		? ["a heterogeneous union whose arms of one key set differ in a literal head key"]
		: []

/**
 * Every feature a read's query reaches, by the language's own terms: the plain language's shapes, an ordered delivery,
 * and the program forms.
 */
export type ProgramFeature =
	| "arms"
	| "take"
	| "attachment"
	| "nested attachment"
	| "join of matches"
	| "roster match"
	| `bind ${Operand<ParentColumn>["kind"]}`
	| `compare ${CompareOp} with ${Operand<never>["kind"]}`
	| "negation"
	| `aggregate ${AggregateFn}`
	| `aggregate ${AggregateFn} over a padding`
	| `compute ${ComputedTerm["kind"]}`
	| "zero-column head"
	| "ordered delivery"
	| ProgramForm

/** Whether a parameter is declared with a field's own descriptor of `kind`. */
const declaredAs = (p: Param, kind: FieldKind): boolean =>
	p.declaration.kind === "field" && p.declaration.field.kind === kind

/** The forms a parameter operand at a field of `kind` reaches, bound in a match or compared. */
const declaredForms = (
	o: Operand<ParentColumn>,
	kind: FieldKind,
	how: "bind" | "compare"
): ReadonlyArray<ProgramForm> => {
	if (o.kind !== "param") {
		return []
	}
	if (kind === "tick" && declaredAs(o.param, "tick")) {
		return [
			how === "bind" ? "bind a contract field to a param" : "compare a contract field with a param"
		]
	}
	if (kind === "fixed" && declaredAs(o.param, "fixed")) {
		return [
			how === "bind"
				? "bind a numeric typmod field to a param"
				: "compare a numeric typmod field with a param"
		]
	}
	return []
}

/**
 * The features of a match's source: a roster match, or the derived source's forms and those of what it holds.
 *
 * An import's attachments deliver nothing to its rows, so its features are its root's.
 */
const sourceFeatures = (source: Source): ReadonlyArray<ProgramFeature> => {
	switch (source.kind) {
		case "stored":
			return []
		case "roster":
			return ["roster match"]
		case "import":
			return [
				"an import",
				...Arr.map(source.binds, (b): ProgramFeature =>
					b.to.kind === "var"
						? "an import bound to an outer variable"
						: "an import bound to a parameter"
				),
				...(source.query.attachments.length > 0 ? ["an import of an attached query" as const] : []),
				...queryFeatures({ ...source.query, attachments: [] }, 0)
			]
		case "interior":
			return ["an interior", ...ruleFeatures(source.rule)]
		case "relation param":
			return ["a relation param"]
		case "closure":
			return ["a recursive closure"]
	}
}

/** The features of one head item of a rule that is an aggregate or not. */
const headItemFeatures = (h: HeadItem, aggregate: boolean): ReadonlyArray<ProgramFeature> => {
	switch (h.kind) {
		case "var":
			return []
		case "count":
			return ["aggregate count"]
		case "fold":
			return h.arg.kind === "padded"
				? [`aggregate ${h.fn}`, `aggregate ${h.fn} over a padding`]
				: [`aggregate ${h.fn}`]
		case "computed":
			return [
				`compute ${h.term.kind}`,
				...(aggregate
					? (["a computed head key", "a computed group key"] as const)
					: (["a computed head key"] as const))
			]
		case "literal":
			return []
	}
}

/** Whether the arms state a head key as a literal that differs between at least two of them. */
const literalDistinct = <P>(arms: ReadonlyArray<Rule<P>>): boolean => {
	const [first] = arms
	if (first === undefined) {
		return false
	}
	return Arr.some(first.head, (h) => {
		if (h.kind !== "literal") {
			return false
		}
		const values = new Set(
			Arr.flatMap(arms, (arm) =>
				Arr.flatMap(arm.head, (item) =>
					item.kind === "literal" && item.name === h.name ? [nativeEqualityKey(item.literal)] : []
				)
			)
		)
		return values.size > 1
	})
}

const headFeatures = <P>(rule: Rule<P>): ReadonlyArray<ProgramFeature> =>
	Arr.flatMap(rule.head, (h) => headItemFeatures(h, isAggregate(rule)))

const ruleFeatures = <P extends ParentColumn>(rule: Rule<P>): ReadonlyArray<ProgramFeature> => [
	...(rule.matches.length > 1 ? ["join of matches" as const] : []),
	...Arr.flatMap(rule.matches, (m) => [
		...sourceFeatures(m.source),
		...Arr.flatMap(m.bindings, (b): ReadonlyArray<ProgramFeature> => [
			`bind ${b.operand.kind}`,
			...declaredForms(b.operand, b.field.kind, "bind")
		])
	]),
	...Arr.flatMap(rule.where, (w): ReadonlyArray<ProgramFeature> => [
		`compare ${w.op} with ${w.right.kind}`,
		...declaredForms(w.right, w.left.field.kind, "compare")
	]),
	...(rule.between.length > 0 ? ["a between" as const] : []),
	...(rule.inSets.length > 0 ? ["an in set" as const] : []),
	...(Arr.some(rule.inSets, (s) => s.values.length === 0) ? ["an empty in set" as const] : []),
	...(rule.allens.length > 0 ? ["an Allen relation" as const] : []),
	...(rule.pointIns.length > 0 ? ["a point in a span" as const] : []),
	...Arr.flatMap(rule.connectives, (c): ReadonlyArray<ProgramFeature> =>
		c.args.length > 0 ? [] : [c.kind === "and" ? "an empty conjunction" : "an empty disjunction"]
	),
	...(rule.negations.length > 0 ? ["negation" as const] : []),
	...headFeatures(rule),
	...(rule.head.length === 0 ? ["zero-column head" as const] : [])
]

const queryFeatures = <P extends ParentColumn>(
	q: Query<P>,
	depth: number
): ReadonlyArray<ProgramFeature> => [
	...(q.arms.length > 1 ? ["arms" as const] : []),
	...(literalDistinct(q.arms) ? ["arms differing in a literal head key" as const] : []),
	...(q.bound.kind === "take" ? ["take" as const] : []),
	...(depth > 0 && q.bound.kind === "take" ? ["an attached take" as const] : []),
	...(q.stage.kind === "named" ? ["a named stage" as const] : []),
	...(depth > 0 ? ["attachment" as const] : []),
	...(depth > 1 ? ["nested attachment" as const] : []),
	...Arr.flatMap(q.arms, (rule) => ruleFeatures(rule)),
	...Arr.flatMap(q.attachments, (a) => queryFeatures(a.child, depth + 1))
]

/**
 * The features of a root: its rules', its attachments' children's, its imports' and its interiors', recursively, and
 * its ordered delivery.
 */
export const programFeatures = (root: Root): ReadonlyArray<ProgramFeature> => [
	...queryFeatures(root, 0),
	...(root.delivery.kind === "ordered" ? ["ordered delivery" as const] : [])
]

/**
 * The populations a case is drawn from, shrinking toward the plain swarm:
 * - the planted one, three sixteenths of the cases, is the planted case (plantedCase), whose shape is fixed and whose
 *   names and values are drawn;
 * - the spelling-directed one, three sixteenths, turns on what makes the parents of one attachment hold equal keys of
 *   different spellings with children under a pipelined statement (a nested attachment keeps its parent's pipelined),
 *   and turns off what would thin those parents out;
 * - the delivery-directed one, a quarter, turns on the child forms that are proved to deliver narrower than an array
 *   and what they read from their parent (a handle field, a head of every variable), and turns off what hides a
 *   parent's fact from its head or the parent from one rule (aggregates, unions, joins, constants, existentials);
 * - the form-directed one, a quarter, turns on every program form (programForms) and what each needs (a parameter
 *   bound in a match for an import to bind, an aggregate for a computed group key, a compared parameter for a declared
 *   one), and turns off what takes a read's place or empties a head (key reads, unit heads, ungrouped aggregates):
 *   both directed populations above turn off the parameters, comparisons, aggregates and unions those forms are built
 *   from, so the plain swarm alone, rarely holding all of one form's gates, reached each in a case or two of a hundred;
 * - the plain swarm, an eighth.
 * The spelling-directed population had half the cases before the form-directed one took a quarter; at three eighths
 * its drawn parents met two spellings of one key with children in at most five cases of a hundred, and some runs in
 * none, as the delivery-directed one met an arm's Some, so the planted case reaches both by construction.
 */
export type DrawnPopulation = "swarm" | "planted" | "delivered" | "spelled" | "forms"

/**
 * Every population a case sketch names: the drawn ones, and the two acceptance cases of issue #3, which only the
 * suite's kept cases name, each a hand-built case resolved from its sketch's plan, session and restorage alone
 * (acceptanceCollapse, acceptanceMean).
 */
export type Population = DrawnPopulation | "acceptance collapse" | "acceptance mean"

/**
 * The population of a case, in sixteenths: two plain, three planted, four delivery-, three spelling- and four
 * form-directed.
 */
const populationGen: Gen<DrawnPopulation> = weighted<DrawnPopulation>([
	[2, constant("swarm")],
	[3, constant("planted")],
	[4, constant("delivered")],
	[3, constant("spelled")],
	[4, constant("forms")]
])

const formsOn: ReadonlyArray<SwarmFeature> = [
	"import",
	"import bound",
	"bind param",
	"interior",
	"named",
	"computed head",
	"computed group key",
	"between",
	"in set",
	"connective",
	"relation param",
	"recursive",
	"where",
	"compare param",
	"contract param",
	"typmod param",
	"allen",
	"point in",
	"union",
	"literal head"
]
const formsOff: ReadonlyArray<SwarmFeature> = ["key read", "unit head", "ungrouped"]

const deliveredOn: ReadonlyArray<SwarmFeature> = [
	"attach",
	"stated delivery",
	"keyed child",
	"reflexive child",
	"arm child",
	"handle field",
	"full head"
]

const deliveredOff: ReadonlyArray<SwarmFeature> = [
	"plain child",
	"bind join",
	"bind existential",
	"bind literal",
	"bind param",
	"roster",
	"where",
	"negation",
	"aggregate",
	"unit head",
	"union",
	"key read"
]

const focusOn: ReadonlyArray<SwarmFeature> = ["attach", "spelled", "dense", "nested", "full head"]
const focusOff: ReadonlyArray<SwarmFeature> = [
	"bind join",
	"bind existential",
	"bind literal",
	"bind param",
	"roster",
	"where",
	"negation",
	"aggregate",
	"unit head",
	"union",
	"take"
]

interface ValueSketch {
	readonly cls: number
	readonly sp: number
}

interface FieldSketch {
	readonly name: number
	readonly kind: number
	/** Whether the field joins the primary key, read only for a key-capable field after the first. */
	readonly key: number
}

interface FactSketch {
	readonly values: ReadonlyArray<ValueSketch>
}

interface RelationSketch {
	readonly name: number
	readonly fields: ReadonlyArray<FieldSketch>
	readonly candidate: number
	readonly facts: ReadonlyArray<FactSketch>
}

interface BindSketch {
	readonly how: number
	readonly pick: number
	readonly value: ValueSketch
}

interface MatchSketch {
	readonly source: number
	/** Whether a root rule's later match reads a derived source, where any is offered (its upper half). */
	readonly derived: number
	/**
	 * Whether an import the match reads keeps the earlier read's attachments (its upper half), which deliver nothing to
	 * the import's rows.
	 */
	readonly attached: number
	readonly binds: ReadonlyArray<BindSketch>
}

/**
 * An operand compared with a variable: a literal (the floor), another variable of its type, or a parameter, as the
 * swarm's choice among them decides when the case resolves.
 */
interface OperandSketch {
	readonly pick: number
	readonly value: ValueSketch
}

interface CompareSketch extends OperandSketch {
	readonly left: number
	readonly op: number
}

interface BetweenSketch {
	readonly left: number
	readonly low: OperandSketch
	readonly high: OperandSketch
}

interface InSetSketch {
	readonly left: number
	readonly values: ReadonlyArray<ValueSketch>
}

interface AllenSketch {
	readonly left: number
	readonly mask: number
	readonly right: number
}

interface PointInSketch {
	readonly span: number
	readonly point: number
}

/** An r.and or r.or: which of the two, and its comparisons. */
interface ConnectiveSketch {
	readonly kind: number
	readonly args: ReadonlyArray<CompareSketch>
}

/**
 * A Compute term: its kind, the padding or display-scale reading drawn in its place (`reading`, none at the floor), its
 * variable, a conditional's comparison and constants, a padding's display scale, whether a reading reads a padding of
 * its variable (its upper half), and a quotient's divisor or a power's exponent (`op`).
 */
interface ComputedSketch {
	readonly kind: number
	readonly reading: number
	readonly arg: number
	readonly op: number
	readonly than: ValueSketch
	readonly otherwise: ValueSketch
	readonly scale: number
	readonly padded: number
}

/** An aggregate of a head: its function, its variable, whether it folds a padding of it (its upper half), and its scale. */
interface FoldSketch {
	readonly fn: number
	readonly arg: number
	readonly padded: number
	readonly scale: number
}

interface HeadSketch {
	readonly vars: ReadonlyArray<number>
	readonly names: ReadonlyArray<number>
	readonly folds: ReadonlyArray<FoldSketch>
}

interface NegationSketch {
	readonly source: number
	readonly picks: ReadonlyArray<number>
}

/**
 * An interior stage: its matches, comparisons, negation and head of variables. It reads no derived source, so the
 * sketch types do not recur.
 */
interface InteriorSketch {
	readonly matches: ReadonlyArray<MatchSketch>
	readonly where: ReadonlyArray<CompareSketch>
	readonly negation: NegationSketch
	readonly head: HeadSketch
}

interface RuleSketch {
	readonly matches: ReadonlyArray<MatchSketch>
	readonly where: ReadonlyArray<CompareSketch>
	readonly between: ReadonlyArray<BetweenSketch>
	readonly inSet: ReadonlyArray<InSetSketch>
	readonly allen: ReadonlyArray<AllenSketch>
	readonly pointIn: ReadonlyArray<PointInSketch>
	readonly connective: ReadonlyArray<ConnectiveSketch>
	readonly computed: ReadonlyArray<ComputedSketch>
	readonly negation: NegationSketch
	readonly head: HeadSketch
	readonly interior: InteriorSketch
}

interface OrderSketch {
	readonly rotate: number
	readonly dirs: ReadonlyArray<number>
	readonly size: number
}

/**
 * A root's `.orderBy(...).take(k)`: its order, and whether the stated order leaves out its last column (its upper
 * half), whose ties the take's completion breaks (program.ts takeOrder).
 */
interface TakeSketch extends OrderSketch {
	readonly ties: number
}

interface ChildSketch {
	readonly name: number
	readonly link: number
	/**
	 * The handle an arm reads, and the delivery drawn among those the child's proof licenses; the child's form is the
	 * swarm's choice when the case resolves.
	 */
	readonly handle: number
	readonly delivery: number
	readonly rule: RuleSketch
	/** The child's `.orderBy(...).take(k)`, where the swarm keeps an attached take. */
	readonly take: OrderSketch
}

interface AttachSketch extends ChildSketch {
	readonly nested: ChildSketch
}

/**
 * A union's literal head key: its name, its field kind, how many arms (two or three), and each arm's value, a pick
 * among the kind's literals not taken by an earlier arm.
 */
interface LiteralHeadSketch {
	readonly name: number
	readonly kind: number
	readonly arms: number
	readonly values: ReadonlyArray<number>
}

/**
 * The picks of the planted case (plantedCase): one name per slot of plantedNames, the value class its two parent rows
 * share at the spelled field and the first of the two spellings (the signed field's zero is the first row's 0 and the
 * second's -0), and the handle its arm reads.
 */
interface PlantedSketch {
	readonly names: ReadonlyArray<number>
	readonly value: ValueSketch
	readonly handle: number
	/** The display scale of the planted paddings (paddingOf). */
	readonly padding: number
	/**
	 * The mixed root's discriminant: its literal kind and each arm's value, a pick among the kind's literals no earlier
	 * arm took.
	 */
	readonly side: { readonly kind: number; readonly values: ReadonlyArray<number> }
}

interface ReadSketch {
	readonly rule: RuleSketch
	readonly take: TakeSketch
	readonly literalHead: LiteralHeadSketch
	/**
	 * Whether a read below the last binds its first match's first key field to a parameter, so a later read may import
	 * it bound (its upper half).
	 */
	readonly importable: number
	/**
	 * Whether the read's root rule matches an import with a parameter bound to a variable its first match bound, where
	 * one fits (its upper half).
	 */
	readonly bindImport: number
	/** The name of a named root. */
	readonly named: number
	/** A relation parameter: its relation and rows. */
	readonly relationParam: { readonly relation: number; readonly facts: ReadonlyArray<FactSketch> }
	/** A closure: its relation, the pair of its fields, and its name. */
	readonly closure: { readonly relation: number; readonly pair: number; readonly name: number }
	readonly attachments: ReadonlyArray<AttachSketch>
	readonly order: OrderSketch
	readonly probe: { readonly kind: number; readonly pick: number }
	readonly key: {
		readonly relation: number
		readonly which: number
		readonly fact: number
		readonly absent: number
		readonly roster: number
	}
}

export interface CaseSketch {
	/** The population the case is drawn from. */
	readonly population: Population
	/**
	 * The swarm the case resolves under: its own for the plain population, the directed populations' features forced on
	 * at full weight and off (populationSwarm), and none for the planted case, which reads no swarm.
	 */
	readonly swarm: Swarm<SwarmFeature>
	readonly perturbation: Perturbation
	readonly ambient: AmbientSession
	/** How the case's second reading stores its facts (program.ts ProgramCase.restorage). */
	readonly restorage: Restorage
	readonly roster: number
	/** The span field's kind, over integer or bigint, of every relation that gains one. */
	readonly span: number
	readonly relations: ReadonlyArray<RelationSketch>
	readonly reads: ReadonlyArray<ReadSketch>
	readonly planted: PlantedSketch
}

/** The fields a relation sketch draws: a relation then gains at most three gated fields. */
const drawnWidth = 4

/**
 * The widest a relation is, its drawn fields and its gated ones: a fact's values and a match's bindings cover every
 * field of any source.
 */
const width = 7

const valueGen: Gen<ValueSketch> = (decisions) => ({
	cls: decisions.draw(pickGen),
	sp: decisions.draw(pickGen)
})

const fixed = <A>(item: Gen<A>, length: number): Gen<ReadonlyArray<A>> =>
	array(item, { min: length, max: length })

const operandGen: Gen<OperandSketch> = (decisions) => ({
	pick: decisions.draw(pickGen),
	value: decisions.draw(valueGen)
})

const bindGen: Gen<BindSketch> = (decisions) => ({
	how: decisions.draw(pickGen),
	pick: decisions.draw(pickGen),
	value: decisions.draw(valueGen)
})

const matchGen: Gen<MatchSketch> = (decisions) => ({
	source: decisions.draw(pickGen),
	derived: decisions.draw(pickGen),
	attached: decisions.draw(pickGen),
	binds: decisions.draw(fixed(bindGen, width))
})

const compareGen: Gen<CompareSketch> = (decisions) => ({
	left: decisions.draw(pickGen),
	op: decisions.draw(pickGen),
	pick: decisions.draw(pickGen),
	value: decisions.draw(valueGen)
})

const negationGen: Gen<NegationSketch> = (decisions) => ({
	source: decisions.draw(pickGen),
	picks: decisions.draw(fixed(pickGen, 2))
})

/**
 * A head names at most six keys: two grouping variables, two computed keys and two folds, or four variables and two
 * computed keys.
 */
const headGen: Gen<HeadSketch> = (decisions) => ({
	vars: decisions.draw(array(pickGen, { min: 0, max: 3 })),
	names: decisions.draw(fixed(pickGen, 6)),
	folds: decisions.draw(
		array(
			(d): FoldSketch => ({
				fn: d.draw(pickGen),
				arg: d.draw(pickGen),
				padded: d.draw(pickGen),
				scale: d.draw(pickGen)
			}),
			{ min: 1, max: 2 }
		)
	)
})

const betweenGen: Gen<BetweenSketch> = (decisions) => ({
	left: decisions.draw(pickGen),
	low: decisions.draw(operandGen),
	high: decisions.draw(operandGen)
})

/** An r.inSet's values: one to three, or none, its own arm, a membership no row holds. */
const inSetGen: Gen<InSetSketch> = (decisions) => ({
	left: decisions.draw(pickGen),
	values: decisions.draw(
		weighted<ReadonlyArray<ValueSketch>>([
			[3, array(valueGen, { min: 1, max: 3 })],
			[1, constant([])]
		])
	)
})

const allenGen: Gen<AllenSketch> = (decisions) => ({
	left: decisions.draw(pickGen),
	mask: decisions.draw(pickGen),
	right: decisions.draw(pickGen)
})

const pointInGen: Gen<PointInSketch> = (decisions) => ({
	span: decisions.draw(pickGen),
	point: decisions.draw(pickGen)
})

/** An r.and or r.or over one or two comparisons, or over none, its own arm: the constant true or false. */
const connectiveGen: Gen<ConnectiveSketch> = (decisions) => ({
	kind: decisions.draw(pickGen),
	args: decisions.draw(
		weighted<ReadonlyArray<CompareSketch>>([
			[3, array(compareGen, { min: 1, max: 2 })],
			[1, constant([])]
		])
	)
})

const computedGen: Gen<ComputedSketch> = (decisions) => ({
	kind: decisions.draw(pickGen),
	reading: decisions.draw(pickGen),
	arg: decisions.draw(pickGen),
	op: decisions.draw(pickGen),
	than: decisions.draw(valueGen),
	otherwise: decisions.draw(valueGen),
	scale: decisions.draw(pickGen),
	padded: decisions.draw(pickGen)
})

const interiorGen: Gen<InteriorSketch> = (decisions) => ({
	matches: decisions.draw(array(matchGen, { min: 1, max: 2 })),
	where: decisions.draw(array(compareGen, { min: 0, max: 2 })),
	negation: decisions.draw(negationGen),
	head: decisions.draw(headGen)
})

const ruleGen: Gen<RuleSketch> = (decisions) => ({
	matches: decisions.draw(array(matchGen, { min: 1, max: 3 })),
	where: decisions.draw(array(compareGen, { min: 0, max: 2 })),
	between: decisions.draw(array(betweenGen, { min: 0, max: 1 })),
	inSet: decisions.draw(array(inSetGen, { min: 0, max: 1 })),
	allen: decisions.draw(array(allenGen, { min: 0, max: 1 })),
	pointIn: decisions.draw(array(pointInGen, { min: 0, max: 1 })),
	connective: decisions.draw(array(connectiveGen, { min: 0, max: 1 })),
	computed: decisions.draw(array(computedGen, { min: 0, max: 2 })),
	negation: decisions.draw(negationGen),
	head: decisions.draw(headGen),
	interior: decisions.draw(interiorGen)
})

const orderGen: Gen<OrderSketch> = (decisions) => ({
	rotate: decisions.draw(pickGen),
	dirs: decisions.draw(fixed(pickGen, 3)),
	size: decisions.draw(pickGen)
})

const takeGen: Gen<TakeSketch> = (decisions) => ({
	...decisions.draw(orderGen),
	ties: decisions.draw(pickGen)
})

const childGen: Gen<ChildSketch> = (decisions) => ({
	name: decisions.draw(pickGen),
	link: decisions.draw(pickGen),
	handle: decisions.draw(pickGen),
	delivery: decisions.draw(pickGen),
	rule: decisions.draw(ruleGen),
	take: decisions.draw(orderGen)
})

const attachGen: Gen<AttachSketch> = (decisions) => ({
	...decisions.draw(childGen),
	nested: decisions.draw(childGen)
})

const factGen: Gen<FactSketch> = (decisions) => ({ values: decisions.draw(fixed(valueGen, width)) })

const readGen: Gen<ReadSketch> = (decisions) => ({
	rule: decisions.draw(ruleGen),
	take: decisions.draw(takeGen),
	literalHead: {
		name: decisions.draw(pickGen),
		kind: decisions.draw(pickGen),
		arms: decisions.draw(pickGen),
		values: decisions.draw(fixed(pickGen, 3))
	},
	importable: decisions.draw(pickGen),
	bindImport: decisions.draw(pickGen),
	named: decisions.draw(pickGen),
	relationParam: {
		relation: decisions.draw(pickGen),
		facts: decisions.draw(array(factGen, { min: 0, max: 3 }))
	},
	closure: {
		relation: decisions.draw(pickGen),
		pair: decisions.draw(pickGen),
		name: decisions.draw(pickGen)
	},
	attachments: decisions.draw(array(attachGen, { min: 0, max: 2 })),
	order: decisions.draw(orderGen),
	probe: { kind: decisions.draw(pickGen), pick: decisions.draw(pickGen) },
	key: {
		relation: decisions.draw(pickGen),
		which: decisions.draw(pickGen),
		fact: decisions.draw(pickGen),
		absent: decisions.draw(pickGen),
		roster: decisions.draw(pickGen)
	}
})

const fieldGen: Gen<FieldSketch> = (decisions) => ({
	name: decisions.draw(pickGen),
	kind: decisions.draw(pickGen),
	key: decisions.draw(pickGen)
})

const relationGen: Gen<RelationSketch> = (decisions) => ({
	name: decisions.draw(pickGen),
	fields: decisions.draw(array(fieldGen, { min: 1, max: drawnWidth })),
	candidate: decisions.draw(pickGen),
	facts: decisions.draw(array(factGen, { min: 0, max: 5 }))
})

const plantedGen: Gen<PlantedSketch> = (decisions) => ({
	names: decisions.draw(fixed(pickGen, plantedNames.length)),
	value: decisions.draw(valueGen),
	handle: decisions.draw(pickGen),
	padding: decisions.draw(pickGen),
	side: { kind: decisions.draw(pickGen), values: decisions.draw(fixed(pickGen, 3)) }
})

/**
 * A feature a directed population neither forces on nor off: off one case in six, otherwise at weight 1, 2 or 3 alike,
 * shrinking toward off. It is the plain swarm's gate at its least omitting rate, so a directed case keeps most of what
 * its population does not decide.
 */
const freeWeight: Gen<SwarmWeight> = weighted<SwarmWeight>([
	[1, constant(0)],
	[5, element([1, 2, 3])]
])

/** A directed population's swarm: `on` at full weight, `off` absent, and every other feature at a free weight. */
const directedSwarm =
	(on: ReadonlyArray<SwarmFeature>, off: ReadonlyArray<SwarmFeature>): Gen<Swarm<SwarmFeature>> =>
	(decisions) => {
		const drawn: Partial<Record<SwarmFeature, Presence>> = {}
		for (const feature of swarmFeatures) {
			const weight: SwarmWeight = on.includes(feature)
				? 3
				: off.includes(feature)
					? 0
					: decisions.draw(freeWeight)
			if (weight !== 0) {
				drawn[feature] = weight
			}
		}
		return drawn
	}

/** The swarm a population's case resolves under (CaseSketch.swarm). */
const populationSwarm = (population: DrawnPopulation): Gen<Swarm<SwarmFeature>> => {
	switch (population) {
		case "swarm":
			return swarm(swarmFeatures)
		case "planted":
			return constant({})
		case "delivered":
			return directedSwarm(deliveredOn, deliveredOff)
		case "spelled":
			return directedSwarm(focusOn, focusOff)
		case "forms":
			return directedSwarm(formsOn, formsOff)
	}
}

/**
 * The names a planted case draws, one pick each: its relation and four fields, the root's head key of each field, its
 * two attachments and the signed child's nested one, and each child's head key; the import's and the mixed root's
 * head keys; the collapse's, the means' and the fused read's head keys and attachment; the vector relation, its
 * fields, its read's head keys, attachment, nested attachment and their head keys; and the ranked relation, its fields
 * and its read's head keys.
 */
const plantedNames = [
	"relation",
	"key field",
	"spelled field",
	"signed field",
	"handle field",
	"key column",
	"spelled column",
	"signed column",
	"handle column",
	"arm",
	"signed",
	"nested",
	"arm column",
	"signed child column",
	"nested column",
	"import key column",
	"import spelled column",
	"import signed column",
	"import handle column",
	"mixed key column",
	"mixed spelled column",
	"mixed side",
	"collapse column",
	"collapse padded column",
	"collapse quotient column",
	"collapse root column",
	"collapse power column",
	"mean padded column",
	"mean column",
	"fused key column",
	"fused signed column",
	"fused",
	"fused child column",
	"vector relation",
	"vector key field",
	"vector field",
	"vector key column",
	"vector column",
	"vector attachment",
	"vector child column",
	"vector nested",
	"vector nested column",
	"ranked relation",
	"ranked key field",
	"rank field",
	"ranked key column",
	"rank column",
	"tied key column",
	"tied rank column",
	"tied attachment",
	"tied child key column"
] as const
type PlantedName = (typeof plantedNames)[number]

/** How many name picks a planted sketch holds, one per slot: what a kept sketch's planted names list. */
export const plantedNameCount = plantedNames.length

/**
 * The generator of the public-boundary differential: a case drawn as a flat sketch of picks, resolved by pure functions
 * into a program the language admits (program.ts).
 *
 * Rule: every sketch resolves, and every pick shrinks toward the simplest valid form. A pick is an integer in
 * 0..0xffff that selects among the options in scope without skew (pick.ts pickFrom); a choice with nothing to choose
 * from takes the floor, a fresh variable. Each case first draws its population and a swarm over the language's
 * features, so a case with few features on is as likely as one with most of them, and every feature shrinks toward
 * off.
 *
 * What the population is for:
 *
 * - Spelling per fact. Every stored value picks its own spelling of its value class (gen/domain.ts valueClasses), so
 *   1.0, 1.00 and 1 are written to one wide numeric column, which stores them alike at its scale, and 0 and -0 to one
 *   double precision column, which prints them apart, and the "dense" feature narrows each column to two classes, so
 *   equal values of different spellings meet often: among the parent keys of an attachment above all, where the
 *   adapter must stitch children by value, not by text.
 * - Correlation by any column. An attachment's child binds a field to a parent column of the same type, chosen with
 *   the columns whose equal values print apart (double precision, a vector; twinned) first among equals, so a spelled
 *   relation's double precision second field is often the parent key.
 * - Drawn names. Relation, field, head and attachment names come from the identifier dictionary (kernel/dict.ts):
 *   aliases, digit boundaries, reserved words and names longer than an identifier holds, each scope holding names of
 *   distinct conversions, the production rule a name must pass.
 * - Stated deliveries. An attachment states a delivery its child is proved to keep (delivery.ts), drawn among those the
 *   proof licenses, the narrowest most often: an Option over a child whose one match fixes a key per parent, the one
 *   child over a reflexive aggregate of the parent's own relation, and the arm of a handle over a parent's handle
 *   field read from the fact its key names. The child forms build such children on purpose; a plain child states what
 *   its drawn shape happens to prove.
 * - The builder's further forms, each behind a gate of its own: a root rule's later matches read an earlier read's
 *   query (its parameters bound to the rule's variables or to parameters of the read), an interior stage, a relation
 *   parameter or an acyclic closure; a rule filters by r.between, r.inSet, r.allen over span fields and r.pointIn; a
 *   head holds Compute terms, grouping an aggregate among them; a root is named; a parameter of a Tick or a
 *   numeric(5,2) field is declared with the field's own descriptor; and the arms of a union each state one head key as a
 *   literal, a JavaScript value of one field kind distinct across the arms, so each arm's rows read its own.
 * - Imports bound to the reader's variables. A read below the last may bind its first match's first key field to a
 *   parameter, so a later read can import it, and a later read may match such an import with its parameter bound to a
 *   variable its first match bound.
 * - A planted case (plantedCase). What the drawn populations reach too rarely to rely on, a case of the planted
 *   population reaches by construction: two parent rows whose key holds one value in two spellings, each with
 *   children, under a pipelined attachment, an arm read Some and None, a key get of a stored fact and of a key no fact
 *   holds, a get of a roster handle, a root take whose rows its descending key orders apart and ties, and an attached
 *   take that gives a parent two children its descending key orders apart.
 * - Ties in a root take. A root take's stated order may leave out one column of its heading, so the rows its stated
 *   keys tie are ordered by the take's completion, by that column, ascending (program.ts takeOrder).
 *
 * The sketch is what a suite prints and keeps: plain picks, its population and its swarm. Resolving it (resolveCase)
 * draws from the case's decisions only where the swarm thins a feature (weight 1 or 2) or chooses among features, so a
 * sketch whose swarm holds every feature it names at full weight and chooses nowhere resolves as a pure function of
 * the sketch.
 *
 * A case reads up to three times, so a later read may import an earlier one's query.
 */
export const caseSketchGen: Gen<CaseSketch> = (decisions) => {
	const population = decisions.draw(populationGen)
	return {
		population,
		swarm: decisions.draw(populationSwarm(population)),
		perturbation: decisions.draw(plannerPerturbationGen),
		ambient: decisions.draw(ambientSessionGen),
		restorage: decisions.draw(restorageGen),
		roster: decisions.draw(pickGen),
		span: decisions.draw(pickGen),
		relations: decisions.draw(array(relationGen, { min: 1, max: 3 })),
		reads: decisions.draw(array(readGen, { min: 1, max: 3 })),
		planted: decisions.draw(plantedGen)
	}
}

const nonEmpty = <A>(items: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> | undefined => {
	const [first, ...rest] = items
	return first === undefined ? undefined : [first, ...rest]
}

const elementOf = <A>(items: ReadonlyArray<A>, i: number, what: string): A => {
	const item = items[i]
	if (item === undefined) {
		throw new Error(`the generator read ${what} ${i}, which is not there`)
	}
	return item
}

/** A pick's choice among `items`, or undefined when there is none. */
const pickAmong = <A>(items: ReadonlyArray<A>, pick: number): A | undefined => {
	const options = nonEmpty(items)
	return options === undefined ? undefined : pickFrom(options, pick)
}

/** Whether a pick says "on" for a binary choice: its upper half. */
const upper = (pick: number): boolean => pickIndex(pick, 2) === 1

const dictionary = (() => {
	const names = nonEmpty(admittedNames)
	if (names === undefined) {
		throw new Error("the identifier dictionary admits no name")
	}
	return names
})()

/**
 * The names of one scope, which must convert to distinct identifiers: a dictionary name when its conversion is free,
 * otherwise the first free `<fallback><n>`.
 */
class Names {
	readonly #taken = new Set<string>()
	/** Every kind of name drawn in the case, shared by its scopes. */
	readonly kinds: Set<NameKind>

	constructor(kinds: Set<NameKind>) {
		this.kinds = kinds
	}

	#take(declared: string, admits: (name: DeclaredName) => boolean): string | undefined {
		const parsed = parseDeclaredName(declared)
		if (!parsed.ok || !admits(parsed.value) || this.#taken.has(conversionOf(parsed.value))) {
			return undefined
		}
		this.#taken.add(conversionOf(parsed.value))
		return declared
	}

	/** Takes a name's conversion before any is drawn, so no name of the scope converts as it does. */
	reserve(declared: string): void {
		if (this.#take(declared, everyName) === undefined) {
			throw new Error(`the name ${declared} is taken before it is reserved`)
		}
	}

	draw(pick: number, fallback: string): string {
		return this.#drawAdmitted(pick, fallback, everyName)
	}

	/**
	 * A closed-id field's name: one whose decoded column `<field>_name` fits an identifier (core/identity.ts
	 * decodedColumnFits), as ownership requires of every closed-id field a role view decodes, so the dictionary's longest
	 * names fall back.
	 */
	drawClosedId(pick: number, fallback: string): string {
		return this.#drawAdmitted(pick, fallback, decodedColumnFits)
	}

	#drawAdmitted(pick: number, fallback: string, admits: (name: DeclaredName) => boolean): string {
		const drawn = pickFrom(dictionary, pick)
		const taken = this.#take(drawn.declared, admits)
		if (taken !== undefined) {
			this.kinds.add(drawn.feature)
			return taken
		}
		this.kinds.add("fallback")
		for (let n = 0; ; n++) {
			const name = this.#take(`${fallback}${n}`, admits)
			if (name !== undefined) {
				return name
			}
		}
	}
}

/** Every declared name: a field of any kind but a closed id is named by the dictionary alone. */
const everyName = (_name: DeclaredName): boolean => true

const rosterHandles: Arr.NonEmptyReadonlyArray<string> = ["Red", "Green", "Blue"]

const typeOf = (kind: FieldKind, roster: { readonly name: string }): ScalarType => {
	switch (kind) {
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "text":
			return scalarOfSpec({ carrier: kind })
		case "numeric":
			return wideNumeric
		case "fixed":
			return scalarOfSpec({ carrier: "numericTypmod", precision: 5, scale: 2 })
		case "money":
			return scalarOfSpec({ carrier: "money" })
		case "prose":
			return proseType
		case "handle":
			return scalarOfSpec({
				carrier: "code",
				roster: { closed: roster.name, handles: [...rosterHandles] }
			})
		case "span4":
			return scalarOfSpec({ carrier: "range4" })
		case "span8":
			return scalarOfSpec({ carrier: "range8" })
		case "tick":
			return scalarOfSpec({ carrier: "contract", name: "Tick" })
		case "vector":
			return scalarOfSpec({ carrier: "vector" })
	}
}

/** Unbounded prose, str.regex("^.*$", "su"), as the schema compiler types it. */
const proseType: ScalarType = (() => {
	const typed = scalarTypeOf(
		textDesc("^.*$", "su"),
		{ kind: "builder", roster: noRosters },
		SourceLoc("prose", [])
	)
	if (!typed.ok) {
		throw new Error(`the prose type: ${typed.error.message}`)
	}
	return typed.value
})()

/** The string literals of README.md's examples, harvested when this module loads (kernel/dict.ts readmeStrings). */
const readmeTexts = readmeStrings(
	await Effect.runPromise(
		fileText(joinPath(import.meta.dirname, "..", "..", "..", "..", "README.md"))
	)
)

/**
 * The values prose takes: the literal dictionary's text (kernel/dict.ts: README.md's quoted strings and the edge
 * values) and the texts array_out must quote or escape inside a fused attachment's array.
 */
const proseValues: Arr.NonEmptyReadonlyArray<TypedLiteral> = (() => {
	const quoted = ['a"b,c', "back\\slash", "{brace}", "NULL", "sp ace", "a,b", "(x)", ""]
	const texts = [
		...quoted,
		...Arr.flatMap(literalDictionary(proseType, readmeTexts), (l) =>
			l.kind === "text" ? [l.value] : []
		)
	]
	const [first, ...rest] = Arr.map([...new Set(texts)], (value): TypedLiteral => ({
		kind: "text",
		value
	}))
	if (first === undefined) {
		throw new Error("no prose value")
	}
	return [first, ...rest]
})()

/**
 * The carriers whose sums depend on their order under IEEE or int64 accumulation: their values include the edge classes
 * (gen/domain.ts), so a program's sums and means meet the groups grizzle's exact accumulation must get right.
 */
const orderSensitive = (type: ScalarType): boolean => {
	const carrier = baseOf(type).carrier
	return carrier === "float8" || carrier === "float4" || carrier === "money"
}

/** The values of a type, the first two only where the case is dense; never empty. */
const valuesOf = (type: ScalarType, dense: boolean): Arr.NonEmptyReadonlyArray<TypedLiteral> => {
	if (type === proseType) {
		return dense ? [proseValues[0], ...proseValues.slice(1, 2)] : proseValues
	}
	const all = valueClasses(type, orderSensitive(type))
	const values = nonEmpty(dense ? all.slice(0, 2) : all)
	if (values === undefined) {
		throw new Error("a generated type with no value")
	}
	return values
}

const drawValue = (type: ScalarType, sketch: ValueSketch, dense: boolean): TypedLiteral =>
	pickFrom(valuesOf(type, dense), sketch.cls)

/** The value after `literal` among its type's, cyclically: a second arm's constant. A value of none is followed by the first. */
const nextValue = (type: ScalarType, literal: TypedLiteral): TypedLiteral => {
	const values = valuesOf(type, false)
	const key = nativeEqualityKey(literal)
	return Option.match(
		Arr.findFirstIndex(values, (l) => nativeEqualityKey(l) === key),
		{
			onNone: () => values[0],
			onSome: (i) => elementOf(values, (i + 1) % values.length, "a value")
		}
	)
}

const keyable = (f: ProgramField) => Arr.some(keyKinds, (k) => k === f.kind)

/** A relation of a drawn case, its gated fields kept or left out by the swarm, drawn from the case's decisions. */
const resolveRelation = (
	sketch: RelationSketch,
	index: number,
	names: Names,
	roster: CaseRoster,
	swarm: Swarm<SwarmFeature>,
	decisions: Decisions,
	spanKind: "span4" | "span8"
): Stored => {
	const kept = (feature: SwarmFeature): boolean => decisions.draw(keep(swarm, feature))
	const fieldNames = new Names(names.kinds)
	const spelled = kept("spelled")
	const handled = kept("handle field")
	/**
	 * The first field is always one a key can hold, since every relation has a primary key; a spelled relation's
	 * second is a double precision, whose 0 and -0 are stored and printed apart, and a handled relation's last, after
	 * it, a handle outside the primary key; a relation gains the fields they need.
	 */
	const needed = 1 + (spelled ? 1 : 0) + (handled ? 1 : 0)
	const sketches: ReadonlyArray<FieldSketch> = [
		...sketch.fields,
		...Array.from({ length: Math.max(0, needed - sketch.fields.length) }, () => ({
			name: 0,
			kind: 0,
			key: 0
		}))
	]
	const last = sketches.length - 1
	const handleAt = handled ? last : -1
	const kindAt = (i: number, pick: number): FieldKind =>
		i === 0
			? pickFrom(keyKinds, pick)
			: spelled && i === 1
				? "float8"
				: i === handleAt
					? "handle"
					: pickFrom(fieldKinds, pick)
	const fields: Array<ProgramField> = Arr.map(sketches, (f, i) => {
		const kind = kindAt(i, f.kind)
		const name =
			kind === "handle"
				? fieldNames.drawClosedId(f.name, "field")
				: fieldNames.draw(f.name, "field")
		return { name, kind, type: typeOf(kind, roster) }
	})
	const [first, ...rest] = fields
	if (first === undefined) {
		throw new Error("a relation sketch with no field")
	}
	const primaryKey: Arr.NonEmptyReadonlyArray<ProgramField> = [
		first,
		...Arr.filter(
			rest,
			(f, i) =>
				keyable(f) && i + 1 !== handleAt && upper(elementOf(sketches, i + 1, "a field sketch").key)
		)
	]
	const spare = Arr.filter(rest, (f) => keyable(f) && !primaryKey.includes(f))
	const candidate = kept("candidate key") ? pickAmong(spare, sketch.candidate) : undefined
	/**
	 * The gated fields, after the drawn ones and the handle field and never in a key: a span field where Allen
	 * relations or point memberships are drawn, a Tick field and a numeric(5,2) field where their parameters are.
	 */
	const gated: Array<FieldKind> = []
	if (kept("allen") || kept("point in")) {
		gated.push(spanKind)
	}
	if (kept("contract param")) {
		gated.push("tick")
	}
	if (kept("typmod param")) {
		gated.push("fixed")
	}
	const gatedFields = Arr.map(gated, (kind): ProgramField => ({
		name: fieldNames.draw(0, kind),
		kind,
		type: typeOf(kind, roster)
	}))
	return {
		kind: "stored",
		name: names.draw(sketch.name, `Rel${index}x`),
		fields: [first, ...rest, ...gatedFields],
		primaryKey,
		candidates: candidate === undefined ? [] : [[candidate]]
	}
}

const keyOf = (fact: ProgramFact, relation: Stored, key: ReadonlyArray<ProgramField>): string =>
	Arr.join(
		Arr.map(key, (f) =>
			nativeEqualityKey(elementOf(fact, relation.fields.indexOf(f), "a fact's value"))
		),
		"\u0000"
	)

/**
 * How a case's facts are spelled: each value in the input spelling its sketch draws (gen/domain.ts spelledAt), where
 * the case directs spellings, which a direct SQL writer stores; or each in its one form.
 */
type FactSpelling = "drawn" | "canonical"

/**
 * The facts a sketch draws, every key distinct by native equality: a fact that repeats a key of an earlier one is left
 * out.
 */
const resolveFacts = (
	relation: Stored,
	sketches: ReadonlyArray<FactSketch>,
	dense: boolean,
	spelling: FactSpelling
): ReadonlyArray<StoredFact> => {
	const keys = [relation.primaryKey, ...relation.candidates]
	const seen = Arr.map(keys, () => new Set<string>())
	const out: Array<StoredFact> = []
	for (const sketch of sketches) {
		const fact = Arr.map(relation.fields, (f, i) => {
			const value = elementOf(sketch.values, i, "a value sketch")
			const literal = drawValue(f.type, value, dense)
			switch (spelling) {
				case "drawn":
					return spelledAt(f.type, literal, value.sp)
				case "canonical":
					return canonicallySpelled(literal)
			}
		})
		const identities = Arr.map(keys, (k) => keyOf(storedFactValues(fact), relation, k))
		if (Arr.some(identities, (id, k) => elementOf(seen, k, "a key's identities").has(id))) {
			continue
		}
		for (const [k, id] of identities.entries()) {
			elementOf(seen, k, "a key's identities").add(id)
		}
		out.push(fact)
	}
	return out
}

/**
 * An earlier query read a later root rule may import: its root as a query, its attachments apart with the parameters
 * they read beyond the root's, its heading as fields, and each of its parameters with the field its match binds it at.
 */
interface ImportOffer {
	readonly read: number
	readonly query: Query<never>
	readonly attachments: ReadonlyArray<Attachment>
	readonly attachedParams: ReadonlyArray<Param>
	readonly fields: Arr.NonEmptyReadonlyArray<ProgramField>
	readonly params: ReadonlyArray<{ readonly param: Param; readonly field: ProgramField }>
}

/**
 * The import an earlier read offers, or undefined where its query cannot be imported as a set of its head variables:
 * its first arm is an aggregate or finds anything but variables, a rule matches a derived source, it reads a relation
 * parameter, or a parameter of it occurs anywhere but as a match binding.
 */
const importOffer = (read: ProgramRead, index: number): ImportOffer | undefined => {
	if (read.kind !== "query" || read.relations.length > 0) {
		return undefined
	}
	const root = read.query
	const [first] = root.arms
	const heads = Arr.flatMap(first.head, (h) => (h.kind === "var" ? [h] : []))
	const [head, ...more] = heads
	if (head === undefined || heads.length !== first.head.length || isAggregate(first)) {
		return undefined
	}
	const plain = Arr.every(root.arms, (rule) =>
		Arr.every(rule.matches, (m) => m.source.kind === "stored" || m.source.kind === "roster")
	)
	const unfiltered = Arr.every(
		root.arms,
		(rule) =>
			Arr.every(rule.where, (c) => c.right.kind !== "param") &&
			Arr.every(rule.between, (b) => b.low.kind !== "param" && b.high.kind !== "param") &&
			Arr.every(rule.connectives, (j) => Arr.every(j.args, (c) => c.right.kind !== "param"))
	)
	if (!plain || !unfiltered) {
		return undefined
	}
	const params: Array<{ readonly param: Param; readonly field: ProgramField }> = []
	/** Every match of every arm: the arms are non-empty, the matches of one need not be. */
	const matches = Arr.flatMap(root.arms, (rule) => rule.matches)
	for (const b of Arr.flatMap(matches, (m) => m.bindings)) {
		const operand = b.operand
		if (operand.kind === "param" && !Arr.some(params, (p) => p.param === operand.param)) {
			params.push({ param: operand.param, field: b.field })
		}
	}
	const fieldOf = (h: (typeof heads)[number]): ProgramField => ({
		name: h.name,
		kind: h.var.field.kind,
		type: h.var.field.type
	})
	return {
		read: index,
		query: {
			heading: root.heading,
			arms: root.arms,
			bound: root.bound,
			stage: root.stage,
			attachments: []
		},
		attachments: root.attachments,
		attachedParams: Arr.filter(
			Arr.flatMap(root.attachments, (a) => queryParams(a.child)),
			(p) => !Arr.some(params, (q) => q.param === p)
		),
		fields: [fieldOf(head), ...Arr.map(more, fieldOf)],
		params
	}
}

/**
 * What one read's resolution shares: the swarm and the case's decisions it draws its thinning and choices from, the
 * schema, the read's index, its parameters, the imports earlier reads offer, and its variables' serial.
 */
class ReadScope {
	readonly swarm: Swarm<SwarmFeature>
	readonly decisions: Decisions
	readonly schema: ProgramSchema
	readonly dense: boolean
	readonly read: number
	readonly imports: ReadonlyArray<ImportOffer>
	readonly params: Array<Param> = []
	readonly kinds: Set<NameKind>
	#vars = 0

	constructor(
		swarm: Swarm<SwarmFeature>,
		decisions: Decisions,
		schema: ProgramSchema,
		dense: boolean,
		kinds: Set<NameKind>,
		read: number,
		imports: ReadonlyArray<ImportOffer>
	) {
		this.swarm = swarm
		this.decisions = decisions
		this.schema = schema
		this.dense = dense
		this.kinds = kinds
		this.read = read
		this.imports = imports
	}

	/** Whether `feature` appears at this place: the swarm's keep, drawn from the case's decisions. */
	keep(feature: SwarmFeature): boolean {
		return this.decisions.draw(keep(this.swarm, feature))
	}

	/** One of `options`, each as often as its weight, the first when every one is off: the swarm's choice, drawn. */
	choose<O extends SwarmFeature>(options: Arr.NonEmptyReadonlyArray<O>): O {
		return this.decisions.draw(swarmChoice(this.swarm, options))
	}

	mint(field: ProgramField): Var {
		return { id: this.#vars++, field }
	}

	/** A parameter of the read, named uniquely in the case. */
	param(type: ScalarType, value: TypedLiteral, declaration: ParamDeclaration): Param {
		const param: Param = { name: `p${this.read}_${this.params.length}`, type, value, declaration }
		this.params.push(param)
		return param
	}

	/**
	 * A parameter compared with or bound at `field`: declared with the field's own descriptor where the field is a Tick,
	 * whose contract never meets its base without Compute.base (scalar/compute/types.ts compatible), or a numeric(5,2)
	 * one compared with it ("compare") or bound to it where its gate keeps it ("bind"), and otherwise with its base.
	 */
	fieldParam(field: ProgramField, value: TypedLiteral, how: "bind" | "compare"): Param {
		const own =
			field.kind === "tick" ||
			(field.kind === "fixed" && (how === "compare" || this.keep("typmod param")))
		return own
			? this.param(field.type, value, { kind: "field", field })
			: this.param(compareParamType(field.type), value, { kind: "base" })
	}

	/** A fresh parameter of the read declared and typed as `param`, binding `value`. */
	again(param: Param, value: TypedLiteral): Param {
		return this.param(param.type, value, param.declaration)
	}

	sources(): Arr.NonEmptyReadonlyArray<Source> {
		const [first, ...rest] = this.schema.relations
		return this.keep("roster") ? [first, ...rest, this.schema.roster] : [first, ...rest]
	}
}

/** The variables a rule has bound so far, and the parent columns its fields may take. */
class RuleState<P> {
	readonly vars: Array<Var> = []
	readonly scope: ReadScope
	readonly parent: (field: ProgramField, pick: number) => P | undefined

	constructor(scope: ReadScope, parent: (field: ProgramField, pick: number) => P | undefined) {
		this.scope = scope
		this.parent = parent
	}

	fresh(field: ProgramField): Operand<P> {
		const v = this.scope.mint(field)
		this.vars.push(v)
		return { kind: "var", var: v }
	}

	same(type: ScalarType): ReadonlyArray<Var> {
		return Arr.filter(this.vars, (v) => sameScalarType(v.field.type, type))
	}
}

const isSpan = (v: Var): boolean => v.field.kind === "span4" || v.field.kind === "span8"

const bindModes = [
	"bind fresh",
	"bind join",
	"bind existential",
	"bind literal",
	"bind param",
	"bind parent"
] as const
const boundModes = ["bind fresh", "bind join", "bind literal", "bind param", "bind parent"] as const

/** One field's binding in a match, or undefined for an existential; a `required` binding is never existential. */
const resolveBinding = <P>(
	state: RuleState<P>,
	field: ProgramField,
	sketch: BindSketch,
	required: boolean
): Binding<P> | undefined => {
	const mode = state.scope.choose(required ? boundModes : bindModes)
	switch (mode) {
		case "bind existential":
			return undefined
		case "bind join": {
			const shared = pickAmong(state.same(field.type), sketch.pick)
			return {
				field,
				operand: shared === undefined ? state.fresh(field) : { kind: "var", var: shared }
			}
		}
		case "bind literal":
			return {
				field,
				operand: {
					kind: "literal",
					literal: drawValue(field.type, sketch.value, state.scope.dense)
				}
			}
		case "bind param":
			return {
				field,
				operand: {
					kind: "param",
					param: state.scope.fieldParam(
						field,
						drawValue(field.type, sketch.value, state.scope.dense),
						"bind"
					)
				}
			}
		case "bind parent": {
			const parent = state.parent(field, sketch.pick)
			return { field, operand: parent ?? state.fresh(field) }
		}
		case "bind fresh":
			return { field, operand: state.fresh(field) }
	}
}

/**
 * A rule's first match as a form fixes it: its source and the operands of the fields it pins, an attachment child's
 * correlation among them.
 */
interface FirstMatch<P> {
	readonly source: Source
	readonly pins: ReadonlyMap<ProgramField, Operand<P>>
}

/**
 * How a match binds the fields it does not pin: by the drawn modes, or each to a fresh variable or to nothing (`own`,
 * for the forms whose proof needs every other field bound to a variable bound nowhere else).
 */
type Unpinned = "drawn" | "own"

/**
 * One match of `source`. The last field is bound when every field before it was left existential, since a match
 * binds one field at least.
 */
const resolveMatch = <P>(
	state: RuleState<P>,
	source: Source,
	sketch: MatchSketch,
	pins: ReadonlyMap<ProgramField, Operand<P>>,
	unpinned: Unpinned
): Match<P> => {
	const fields = sourceFields(source)
	const bindings: Array<Binding<P>> = []
	for (const [i, field] of fields.entries()) {
		const pinned = pins.get(field)
		if (pinned !== undefined) {
			bindings.push({ field, operand: pinned })
			continue
		}
		const last = bindings.length === 0 && i === fields.length - 1
		const bind = elementOf(sketch.binds, i, "a bind sketch")
		const binding =
			unpinned === "drawn"
				? resolveBinding(state, field, bind, last)
				: last || !upper(bind.how)
					? { field, operand: state.fresh(field) }
					: undefined
		if (binding !== undefined) {
			bindings.push(binding)
		}
	}
	const [first, ...rest] = bindings
	if (first === undefined) {
		throw new Error("a match bound no field")
	}
	return { source, bindings: [first, ...rest] }
}

const orderedOps: Arr.NonEmptyReadonlyArray<CompareOp> = compareOps
const equalityOps: Arr.NonEmptyReadonlyArray<CompareOp> = ["eq", "ne"]

/**
 * Whether a variable's values are totally ordered by the comparison operators: neither a boolean, a handle nor a span.
 */
const ordered = (v: Var): boolean =>
	hasCap(v.field.type, "ordering") &&
	v.field.type.carrier !== "bool" &&
	v.field.type.carrier !== "code" &&
	!isSpan(v)

/**
 * The operand a variable of `type` is compared with: a literal (the floor), another variable of its type, or a
 * parameter of `field`, a comparison's left side.
 */
const resolveOperand = <P>(
	state: RuleState<P>,
	field: ProgramField,
	type: ScalarType,
	sketch: OperandSketch
): Operand<never> => {
	const how = state.scope.choose(["compare literal", "compare var", "compare param"])
	const literal = (): Operand<never> => ({
		kind: "literal",
		literal: drawValue(type, sketch.value, state.scope.dense)
	})
	switch (how) {
		case "compare var": {
			const other = pickAmong(state.same(type), sketch.pick)
			return other === undefined ? literal() : { kind: "var", var: other }
		}
		case "compare param":
			return {
				kind: "param",
				param: state.scope.fieldParam(
					field,
					drawValue(type, sketch.value, state.scope.dense),
					"compare"
				)
			}
		case "compare literal":
			return literal()
	}
}

const resolveComparison = <P>(
	state: RuleState<P>,
	sketch: CompareSketch
): Comparison | undefined => {
	const left = pickAmong(
		Arr.filter(state.vars, (v) => !isSpan(v)),
		sketch.left
	)
	if (left === undefined) {
		return undefined
	}
	const op = pickFrom(ordered(left) ? orderedOps : equalityOps, sketch.op)
	return { op, left, right: resolveOperand(state, left.field, left.field.type, sketch) }
}

const resolveBetween = <P>(state: RuleState<P>, sketch: BetweenSketch): Between | undefined => {
	const left = pickAmong(Arr.filter(state.vars, ordered), sketch.left)
	if (left === undefined) {
		return undefined
	}
	return {
		left,
		low: resolveOperand(state, left.field, left.field.type, sketch.low),
		high: resolveOperand(state, left.field, left.field.type, sketch.high)
	}
}

const resolveInSet = <P>(state: RuleState<P>, sketch: InSetSketch): InSet | undefined => {
	const left = pickAmong(
		Arr.filter(state.vars, (v) => !isSpan(v)),
		sketch.left
	)
	if (left === undefined) {
		return undefined
	}
	return {
		left,
		values: Arr.map(sketch.values, (v) => drawValue(left.field.type, v, state.scope.dense))
	}
}

const resolveAllen = <P>(state: RuleState<P>, sketch: AllenSketch): AllenAtom | undefined => {
	const left = pickAmong(Arr.filter(state.vars, isSpan), sketch.left)
	if (left === undefined) {
		return undefined
	}
	const right = pickFrom(
		[left, ...Arr.filter(state.same(left.field.type), (v) => v !== left)],
		sketch.right
	)
	return { left, mask: AllenMask((sketch.mask % fullAllenMask) + 1), right }
}

const resolvePointIn = <P>(state: RuleState<P>, sketch: PointInSketch): PointIn | undefined => {
	const span = pickAmong(Arr.filter(state.vars, isSpan), sketch.span)
	if (span === undefined) {
		return undefined
	}
	const point = pickAmong(state.same(endpointType(span)), sketch.point)
	return point === undefined ? undefined : { point, span }
}

const connectiveKinds: Arr.NonEmptyReadonlyArray<Connective["kind"]> = ["and", "or"]

/**
 * An r.and or r.or over those of its comparisons that resolve and the rule admits; of none, the constant true or false.
 */
const resolveConnective = <P>(
	state: RuleState<P>,
	sketch: ConnectiveSketch,
	admits: (c: Comparison) => boolean
): Connective => ({
	kind: pickFrom(connectiveKinds, sketch.kind),
	args: Arr.filter(
		Arr.flatMap(sketch.args, (c) =>
			Option.toArray(Option.fromUndefinedOr(resolveComparison(state, c)))
		),
		admits
	)
})

const resolveNegation = <P>(state: RuleState<P>, sketch: NegationSketch): Negation | undefined => {
	const source = pickFrom(state.scope.schema.relations, sketch.source)
	const bindings: Array<{ readonly field: ProgramField; readonly var: Var }> = []
	for (const pick of sketch.picks) {
		const pairs = Arr.flatMap(source.fields, (field) =>
			Arr.some(bindings, (b) => b.field === field)
				? []
				: Arr.map(state.same(field.type), (v) => ({ field, var: v }))
		)
		const pair = pickAmong(pairs, pick)
		if (pair !== undefined) {
			bindings.push(pair)
		}
	}
	const [first, ...rest] = bindings
	return first === undefined ? undefined : { source, bindings: [first, ...rest] }
}

/** The kinds a Compute term takes as its variable: the numeric ones. */
const computableKinds: ReadonlyArray<FieldKind> = ["int4", "int8", "numeric", "fixed", "tick"]

/** The kind a display-scale reading reads as a variable: the wide numeric. */
const readableKind: FieldKind = "numeric"

/** The largest least scale among the values a generated type holds: what a padding pads past, so it keeps each value. */
const leastScale = (type: ScalarType): number =>
	Arr.reduce(valuesOf(type, false), 0, (scale, l) =>
		l.kind === "numeric" && l.value.parts.kind === "finite"
			? Math.max(scale, l.value.parts.minScale)
			: scale
	)

/** The padding of `arg` a pick draws: a padding of numericPaddings past the least scale of every value it holds. */
const paddingOf = (arg: Var, scale: number): Padding => ({
	arg,
	scale: leastScale(arg.field.type) + pickFrom(numericPaddings, scale)
})

/**
 * The aggregate a fold sketch draws over `arg`: its function where the argument's type has it, count otherwise. Sums
 * and means over every carrier that has them, double precision and money among them, are drawn freely: grizzle's exact
 * accumulation makes their answer a function of the contributions, one per keyed row in any order, which the
 * reference states exactly.
 */
const foldOf = (fn: AggregateFn, arg: ArgTerm | undefined, name: string): HeadItem => {
	const count: HeadItem = { kind: "count", name, type: aggregateResult("count", undefined) }
	if (fn === "count" || arg === undefined) {
		return count
	}
	const type = argType(arg)
	const applies =
		fn === "sum"
			? hasCap(type, "sum")
			: fn === "mean"
				? hasCap(type, "avg")
				: hasCap(type, "minMax")
	return applies
		? { kind: "fold", name, fn, arg, type: aggregateResult(fn === "mean" ? "avg" : fn, type) }
		: count
}

/**
 * What a fold sketch folds among the rule's variables: a padding of a numeric one where its pick says so and the rule
 * binds one, the drawn variable otherwise, or nothing where the rule binds none.
 */
const foldArg = <P>(state: RuleState<P>, sketch: FoldSketch): ArgTerm | undefined => {
	const padded = upper(sketch.padded)
		? pickAmong(
				Arr.filter(state.vars, (v) => computableKinds.includes(v.field.kind)),
				sketch.arg
			)
		: undefined
	if (padded !== undefined) {
		return { kind: "padded", padding: paddingOf(padded, sketch.scale) }
	}
	const v = pickAmong(state.vars, sketch.arg)
	return v === undefined ? undefined : { kind: "var", var: v }
}

const computedKinds = ["base", "cast numeric", "cond"] as const

/** A computed head key, typed as the checker types its term (terms.ts computedType). */
const computedItem = (name: string, term: ComputedTerm): HeadItem => ({
	kind: "computed",
	name,
	term,
	type: computedType(term)
})

/**
 * What a computed sketch draws in place of its kind: none, the floor, which keeps the kind; a padding; or a
 * display-scale reading.
 */
const readingKinds = ["none", "padded", "div", "sqrt", "power"] as const

/** The divisors a quotient draws: nonzero, and ones whose quotients do not terminate, so its scale shows in its digits. */
const divisors: Arr.NonEmptyReadonlyArray<TypedLiteral> = [
	{ kind: "numeric", value: Decimal.of("3") },
	{ kind: "numeric", value: Decimal.of("7") }
]

/** The exponents a power draws: integral ones, and a half, whose power PostgreSQL computes through its logarithm. */
const exponents: Arr.NonEmptyReadonlyArray<TypedLiteral> = [
	{ kind: "numeric", value: Decimal.of("2") },
	{ kind: "numeric", value: Decimal.of("3") },
	{ kind: "numeric", value: Decimal.of("0.5") }
]

/**
 * The Compute term a sketch draws over one of the rule's numeric variables, typed as the checker types it: a base the
 * variable's base, a cast to numeric, a padding and every reading a computed numeric, a conditional the variable's own
 * type. A reading reads a padding of the variable where its pick says so or the rule binds no wide numeric, and a wide
 * numeric variable otherwise.
 */
const resolveComputed = <P>(
	state: RuleState<P>,
	sketch: ComputedSketch,
	name: string
): HeadItem | undefined => {
	const arg = pickAmong(
		Arr.filter(state.vars, (v) => computableKinds.includes(v.field.kind)),
		sketch.arg
	)
	if (arg === undefined) {
		return undefined
	}
	const operand = (): ArgTerm => {
		const own = upper(sketch.padded)
			? undefined
			: pickAmong(
					Arr.filter(state.vars, (v) => v.field.kind === readableKind),
					sketch.arg
				)
		return own === undefined
			? { kind: "padded", padding: paddingOf(arg, sketch.scale) }
			: { kind: "var", var: own }
	}
	const item = (term: ComputedTerm): HeadItem => computedItem(name, term)
	const reading = pickFrom(readingKinds, sketch.reading)
	const kind = reading === "none" ? pickFrom(computedKinds, sketch.kind) : reading
	switch (kind) {
		case "base":
		case "cast numeric":
			return item({ kind, arg })
		case "cond":
			return item({
				kind,
				arg,
				op: pickFrom(orderedOps, sketch.op),
				than: drawValue(arg.field.type, sketch.than, state.scope.dense),
				otherwise: drawValue(arg.field.type, sketch.otherwise, state.scope.dense)
			})
		case "padded":
			return item({ kind, padding: paddingOf(arg, sketch.scale) })
		case "div":
			return item({ kind, dividend: operand(), divisor: pickFrom(divisors, sketch.op) })
		case "sqrt":
			return item({ kind, radicand: operand() })
		case "power":
			return item({ kind, base: operand(), exponent: pickFrom(exponents, sketch.op) })
	}
}

/** The Compute terms a head holds after its first `from` keys, named from there on. */
const computedItems = <P>(
	state: RuleState<P>,
	sketches: ReadonlyArray<ComputedSketch>,
	name: (i: number) => string,
	from: number
): ReadonlyArray<HeadItem> => {
	const items: Array<HeadItem> = []
	for (const sketch of sketches) {
		const item = resolveComputed(state, sketch, name(from + items.length))
		if (item !== undefined) {
			items.push(item)
		}
	}
	return items
}

/**
 * The head a rule finds, its keys named by `name(i)` in order; Compute terms join it where `computed` holds sketches
 * and their gate keeps them, as keys of an aggregate's groups after its grouping variables. An aggregate head is drawn
 * where its gate keeps it, unless `aggregates` is "none" (an importable root, whose import is a set of its variables).
 */
const resolveHead = <P>(
	state: RuleState<P>,
	sketch: HeadSketch,
	computed: ReadonlyArray<ComputedSketch>,
	name: (i: number) => string,
	aggregates: "drawn" | "none"
): ReadonlyArray<HeadItem> => {
	const scope = state.scope
	const chosen: Array<Var> = []
	for (const pick of sketch.vars) {
		const v = pickAmong(state.vars, pick)
		if (v !== undefined && !chosen.includes(v)) {
			chosen.push(v)
		}
	}
	const variables = (vars: ReadonlyArray<Var>): ReadonlyArray<HeadItem> =>
		Arr.map(vars, (v, i): HeadItem => ({ kind: "var", name: name(i), var: v }))
	if (aggregates === "drawn" && scope.keep("aggregate")) {
		const ungrouped = scope.keep("ungrouped")
		const keys = variables(ungrouped ? [] : chosen.slice(0, 2))
		const terms =
			!ungrouped && computed.length > 0 && scope.keep("computed group key")
				? computedItems(state, computed, name, keys.length)
				: []
		const at = keys.length + terms.length
		const folds = Arr.map(sketch.folds, (f, i) =>
			foldOf(pickFrom(aggregateFns, f.fn), foldArg(state, f), name(at + i))
		)
		return [...keys, ...terms, ...folds]
	}
	const terms = (keys: ReadonlyArray<HeadItem>): ReadonlyArray<HeadItem> =>
		computed.length > 0 && scope.keep("computed head")
			? computedItems(state, computed, name, keys.length)
			: []
	if (scope.keep("full head")) {
		const keys = variables(state.vars.slice(0, 4))
		return [...keys, ...terms(keys)]
	}
	const first = state.vars[0]
	if (chosen.length === 0 && first !== undefined && !scope.keep("unit head")) {
		chosen.push(first)
	}
	const keys = variables(chosen)
	return [...keys, ...terms(keys)]
}

const headingOf = (head: ReadonlyArray<HeadItem>): ReadonlyArray<Column> =>
	Arr.map(head, (h) => ({ name: h.name, type: h.kind === "var" ? h.var.field.type : h.type }))

/**
 * The type the checker gives a head literal of each kind, which meets no term (check/checker.ts bareLiteralType): a
 * JavaScript number integer, a bigint bigint, a string text with the canonical wildcard, a boolean boolean.
 */
const literalTypes: Readonly<Record<LiteralKind, ScalarType>> = {
	int4: plainType("int4"),
	int8: plainType("int8"),
	text: wildcardText,
	bool: plainType("bool")
}

/** The literals a head key of each kind draws from: the literal dictionary's at its type (kernel/dict.ts). */
const headLiterals: Readonly<Record<LiteralKind, ReadonlyArray<TypedLiteral>>> = {
	int4: literalDictionary(literalTypes.int4, []),
	int8: literalDictionary(literalTypes.int8, []),
	text: literalDictionary(literalTypes.text, []),
	bool: literalDictionary(literalTypes.bool, [])
}

/**
 * Arms of one heading each stating the head key `name` as a literal of the sketch's kind, each arm's value a pick among
 * the kind's literals no earlier arm took; as many arms as the sketch asks for, two or three, and the kind holds values.
 */
const literalArms = <P extends ParentColumn>(
	arms: Arr.NonEmptyReadonlyArray<Rule<P>>,
	name: string,
	sketch: LiteralHeadSketch
): Arr.NonEmptyReadonlyArray<Rule<P>> => {
	const kind = pickFrom(literalKinds, sketch.kind)
	const type = literalTypes[kind]
	const taken = new Set<string>()
	const out: Array<Rule<P>> = []
	for (const [i, arm] of arms.entries()) {
		const free = Arr.filter(headLiterals[kind], (l) => !taken.has(nativeEqualityKey(l)))
		const literal = pickAmong(free, elementOf(sketch.values, i, "a literal head pick"))
		if (literal === undefined) {
			break
		}
		taken.add(nativeEqualityKey(literal))
		out.push({ ...arm, head: [...arm.head, { kind: "literal", name, literal, type }] })
	}
	const [first, ...rest] = out
	if (first === undefined) {
		throw new Error("a literal head kind holds no literal")
	}
	return [first, ...rest]
}

/** The head of a reflexive child: its sketch's folds over the rule, no variable grouping them. */
const ungroupedHead = <P>(state: RuleState<P>, sketch: HeadSketch, name: (i: number) => string) =>
	Arr.map(sketch.folds, (f, i) => foldOf(pickFrom(aggregateFns, f.fn), foldArg(state, f), name(i)))

/**
 * The derived sources a root rule's later matches may read: the imports earlier reads offer, the root's interior
 * stage, relation parameter and closure, where their gates keep them.
 */
interface Derivable {
	readonly imports: ReadonlyArray<ImportOffer>
	readonly relation: RelationParam | undefined
	readonly closure: Closure | undefined
}

/**
 * How a rule is resolved: the root's every drawn match, a later one of which may read a derived source, and every
 * comparison, range, set, Allen atom, point membership, negation and head with its Compute terms; a plain child's
 * alike but its first match pinned and no derived source; a keyed child's pinned first match alone, its comparisons,
 * negation and plain head; and a reflexive or arm child's pinned first match alone, every other field its own, no
 * filter or negation, under an ungrouped or a plain drawn head.
 */
type RuleForm<P> =
	| {
			readonly kind: "root"
			readonly derived: Derivable
			readonly importable: boolean
			readonly bindImport: boolean
	  }
	| { readonly kind: "drawn"; readonly first: FirstMatch<P> }
	| { readonly kind: "keyed"; readonly first: FirstMatch<P> }
	| { readonly kind: "own"; readonly first: FirstMatch<P>; readonly head: "ungrouped" | "drawn" }

const noPins: ReadonlyMap<ProgramField, never> = new Map<ProgramField, never>()

/** The root has no parent: its fields never bind a parent column. */
const noParent = (): undefined => undefined

/**
 * An interior stage: drawn matches of stored relations and the roster, comparisons and a negation, and a head of
 * variables (at least one) named in a scope of its own; undefined where its matches bind no variable.
 */
const resolveInterior = (scope: ReadScope, sketch: InteriorSketch): Interior | undefined => {
	const state = new RuleState<never>(scope, noParent)
	const [firstSketch, ...restSketches] = sketch.matches
	if (firstSketch === undefined) {
		throw new Error("an interior sketch with no match")
	}
	const match = (m: MatchSketch) =>
		resolveMatch(state, pickFrom(scope.sources(), m.source), m, noPins, "drawn")
	const matches: Arr.NonEmptyReadonlyArray<Match<never>> = [
		match(firstSketch),
		...Arr.map(restSketches, match)
	]
	const where = scope.keep("where")
		? Arr.flatMap(sketch.where, (c) =>
				Option.toArray(Option.fromUndefinedOr(resolveComparison(state, c)))
			)
		: []
	const negation = scope.keep("negation") ? resolveNegation(state, sketch.negation) : undefined
	const chosen: Array<Var> = []
	for (const pick of sketch.head.vars) {
		const v = pickAmong(state.vars, pick)
		if (v !== undefined && !chosen.includes(v)) {
			chosen.push(v)
		}
	}
	const [firstVar] = state.vars
	if (chosen.length === 0 && firstVar !== undefined) {
		chosen.push(firstVar)
	}
	const names = new Names(scope.kinds)
	const head = Arr.map(chosen, (v, i): HeadItem => ({
		kind: "var",
		name: names.draw(elementOf(sketch.head.names, i, "a head name"), "column"),
		var: v
	}))
	const fields = Arr.flatMap(head, (h): ReadonlyArray<ProgramField> =>
		h.kind === "var" ? [{ name: h.name, kind: h.var.field.kind, type: h.var.field.type }] : []
	)
	const [firstField, ...restFields] = fields
	if (firstField === undefined) {
		return undefined
	}
	return {
		kind: "interior",
		rule: {
			matches,
			where,
			between: [],
			inSets: [],
			allens: [],
			pointIns: [],
			connectives: [],
			negations: negation === undefined ? [] : [negation],
			head
		},
		fields: [firstField, ...restFields]
	}
}

/**
 * What a root rule's later match may read: an import (resolved against the rule's variables when it is read), or a
 * derived source built before the rule.
 */
type Offer =
	| { readonly kind: "import"; readonly offer: ImportOffer }
	| { readonly kind: "built"; readonly source: Derived }

/**
 * The variables the rule bound in earlier matches that an imported parameter bound at `field` may be bound to: those of
 * the field's own type, which the variable then meets (a contract's or a refinement's variable meets no other type).
 */
const fittingVars = <P>(state: RuleState<P>, field: ProgramField): ReadonlyArray<Var> =>
	Arr.filter(state.vars, (v) => sameScalarType(v.field.type, field.type))

/**
 * An import read by a match: each parameter of the imported query bound to a variable the rule bound in an earlier
 * match, of its type, where one fits and the gate keeps it ("drawn") or wherever one fits ("forced"), and otherwise to
 * a fresh parameter of the read declared as it is; the earlier read's attachments kept where the match's pick says so,
 * and then every parameter they read bound too, to a fresh parameter of the read binding the earlier value: Query.bind
 * binds an imported query's parameters completely, its attachments' among them (attach's parameters are the query's).
 */
const resolveImport = <P>(
	state: RuleState<P>,
	offer: ImportOffer,
	sketch: MatchSketch,
	binding: "drawn" | "forced"
): Source => {
	const scope = state.scope
	const binds = Arr.map(offer.params, ({ param, field }, k): ImportBind => {
		const bind = elementOf(sketch.binds, k % width, "a bind sketch")
		const fits = fittingVars(state, field)
		const bound =
			fits.length > 0 && (binding === "forced" || scope.keep("import bound"))
				? pickAmong(fits, bind.pick)
				: undefined
		return bound === undefined
			? {
					param,
					to: {
						kind: "param",
						param: scope.again(param, drawValue(field.type, bind.value, scope.dense))
					}
				}
			: { param, to: { kind: "var", var: bound } }
	})
	const kept = upper(sketch.attached)
	const attached = kept
		? Arr.map(offer.attachedParams, (param): ImportBind => ({
				param,
				to: { kind: "param", param: scope.again(param, param.value) }
			}))
		: []
	return {
		kind: "import",
		read: offer.read,
		query: { ...offer.query, attachments: kept ? offer.attachments : [] },
		fields: offer.fields,
		binds: [...binds, ...attached]
	}
}

/**
 * The keys a match's source is read by, narrowest first: a stored relation's primary key and its candidate keys, a
 * roster's id, and the whole heading of any other source, a set keyed by its heading.
 */
const matchKeys = (source: Source): Arr.NonEmptyReadonlyArray<ReadonlyArray<ProgramField>> => {
	switch (source.kind) {
		case "stored":
			return [source.primaryKey, ...source.candidates]
		case "roster":
			return [[source.id]]
		case "import":
		case "interior":
		case "relation param":
		case "closure":
			return [source.fields]
	}
}

/**
 * A match that binds a whole key of its source, as a fold over its rule requires: the match itself where some key's
 * every field is bound, otherwise the match with its first key's unbound fields bound to fresh variables, which filter
 * nothing.
 */
const keyedMatch = <P>(scope: ReadScope, m: Match<P>): Match<P> => {
	const bound = new Set(Arr.map(m.bindings, (b) => b.field.name))
	const keys = matchKeys(m.source)
	if (Arr.some(keys, (k) => Arr.every(k, (f) => bound.has(f.name)))) {
		return m
	}
	const added = Arr.flatMap(keys[0], (field: ProgramField): ReadonlyArray<Binding<P>> =>
		bound.has(field.name) ? [] : [{ field, operand: { kind: "var", var: scope.mint(field) } }]
	)
	return { source: m.source, bindings: [m.bindings[0], ...m.bindings.slice(1), ...added] }
}

/**
 * A drawn rule, its folds read over keyed rows: a rule whose head folds binds a key of every source it matches, since
 * a fold reads each fact once by its key and the language refuses one over a projection (FoldOverProjection). The
 * refused form is the invalid case of the fold suite (test/unit/check/folds.test.ts), not drawn here.
 */
const resolveRule = <P>(
	scope: ReadScope,
	sketch: RuleSketch,
	name: (i: number) => string,
	parent: (field: ProgramField, pick: number) => P | undefined,
	form: RuleForm<P>
): Rule<P> => {
	const rule = resolveDrawnRule(scope, sketch, name, parent, form)
	if (!isAggregate(rule)) {
		return rule
	}
	const [first, ...rest] = rule.matches
	return {
		...rule,
		matches: [keyedMatch(scope, first), ...Arr.map(rest, (m) => keyedMatch(scope, m))]
	}
}

const resolveDrawnRule = <P>(
	scope: ReadScope,
	sketch: RuleSketch,
	name: (i: number) => string,
	parent: (field: ProgramField, pick: number) => P | undefined,
	form: RuleForm<P>
): Rule<P> => {
	const state = new RuleState<P>(scope, parent)
	const [firstSketch, ...restSketches] = sketch.matches
	if (firstSketch === undefined) {
		throw new Error("a rule sketch with no match")
	}
	/**
	 * An importable root stays importable (importOffer): its matches read stored relations and rosters only, no
	 * comparison or range reads a parameter, so its parameters occur as match bindings alone, and its head finds its
	 * variables alone.
	 */
	const plainRoot = form.kind === "root" && form.importable
	const offers = ((): ReadonlyArray<Offer> => {
		if (form.kind !== "root" || plainRoot) {
			return []
		}
		const imports = scope.keep("import") ? form.derived.imports : []
		const interior = scope.keep("interior") ? resolveInterior(scope, sketch.interior) : undefined
		const { relation, closure } = form.derived
		return [
			...Arr.map(imports, (offer): Offer => ({ kind: "import", offer })),
			...(interior === undefined ? [] : [{ kind: "built", source: interior } satisfies Offer]),
			...(relation === undefined
				? []
				: [
						{
							kind: "built",
							source: { kind: "relation param", param: relation, fields: relation.relation.fields }
						} satisfies Offer
					]),
			...(closure === undefined ? [] : [{ kind: "built", source: closure } satisfies Offer])
		]
	})()
	/**
	 * The import a root binds: the first offered import with a parameter, its first parameter bound to a variable of the
	 * first match.
	 */
	const bound = ((): ImportOffer | undefined => {
		if (form.kind !== "root" || !form.bindImport) {
			return undefined
		}
		for (const o of offers) {
			if (o.kind === "import" && o.offer.params.length > 0) {
				return o.offer
			}
		}
		return undefined
	})()
	const plain = (m: MatchSketch) =>
		resolveMatch(state, pickFrom(scope.sources(), m.source), m, noPins, "drawn")
	/**
	 * A root binding an import matches first the source of the import's first parameter's field, that field bound to a
	 * fresh variable, which the parameter then fits.
	 */
	const binding = (offer: ImportOffer, m: MatchSketch): Match<P> => {
		const [first] = offer.params
		if (first === undefined) {
			return plain(m)
		}
		return Option.match(
			Arr.findFirst([...scope.schema.relations, scope.schema.roster], (s) =>
				sourceFields(s).includes(first.field)
			),
			{
				onNone: () => plain(m),
				onSome: (source) =>
					resolveMatch(
						state,
						source,
						m,
						new Map([[first.field, state.fresh(first.field)]]),
						"drawn"
					)
			}
		)
	}
	/**
	 * An importable root's first match binds its source's first key field to a parameter declared with the field's base.
	 */
	const importable = (m: MatchSketch): Match<P> => {
		const source = pickFrom(scope.sources(), m.source)
		const key =
			source.kind === "stored"
				? source.primaryKey[0]
				: source.kind === "roster"
					? source.id
					: undefined
		if (key === undefined) {
			return resolveMatch(state, source, m, noPins, "drawn")
		}
		const bind = elementOf(m.binds, sourceFields(source).indexOf(key), "a bind sketch")
		const operand: Operand<P> = {
			kind: "param",
			param: scope.param(compareParamType(key.type), drawValue(key.type, bind.value, scope.dense), {
				kind: "base"
			})
		}
		return resolveMatch(state, source, m, new Map([[key, operand]]), "drawn")
	}
	const first =
		form.kind === "root"
			? bound !== undefined
				? binding(bound, firstSketch)
				: form.importable
					? importable(firstSketch)
					: plain(firstSketch)
			: resolveMatch(
					state,
					form.first.source,
					firstSketch,
					form.first.pins,
					form.kind === "own" ? "own" : "drawn"
				)
	/** A later match reads a derived source where one is offered and its pick says so. */
	const later = (m: MatchSketch): Match<P> => {
		const offered = nonEmpty(offers)
		if (offered === undefined || !upper(m.derived)) {
			return plain(m)
		}
		const offer = pickFrom(offered, m.source)
		const source =
			offer.kind === "import" ? resolveImport(state, offer.offer, m, "drawn") : offer.source
		return resolveMatch(state, source, m, noPins, "drawn")
	}
	/** A root that binds an import matches it after its first match, its parameters bound to the variables they fit. */
	const boundImport: ReadonlyArray<Match<P>> =
		bound === undefined
			? []
			: [
					resolveMatch(
						state,
						resolveImport(state, bound, firstSketch, "forced"),
						firstSketch,
						noPins,
						"drawn"
					)
				]
	const matches: Arr.NonEmptyReadonlyArray<Match<P>> = [
		first,
		...boundImport,
		...(form.kind === "root" || form.kind === "drawn" ? Arr.map(restSketches, later) : [])
	]
	const noFilters = { between: [], inSets: [], allens: [], pointIns: [], connectives: [] }
	if (form.kind === "own") {
		return {
			matches,
			where: [],
			...noFilters,
			negations: [],
			head:
				form.head === "ungrouped"
					? ungroupedHead(state, sketch.head, name)
					: resolveHead(state, sketch.head, [], name, "drawn")
		}
	}
	const where = scope.keep("where")
		? Arr.filter(
				Arr.flatMap(sketch.where, (c) =>
					Option.toArray(Option.fromUndefinedOr(resolveComparison(state, c)))
				),
				(c) => !plainRoot || c.right.kind !== "param"
			)
		: []
	const negation = scope.keep("negation") ? resolveNegation(state, sketch.negation) : undefined
	const negations = negation === undefined ? [] : [negation]
	if (form.kind === "keyed") {
		return {
			matches,
			where,
			...noFilters,
			negations,
			head: resolveHead(state, sketch.head, [], name, "drawn")
		}
	}
	return {
		matches,
		where,
		between: scope.keep("between")
			? Arr.filter(
					Arr.flatMap(sketch.between, (b) =>
						Option.toArray(Option.fromUndefinedOr(resolveBetween(state, b)))
					),
					(b) => !plainRoot || (b.low.kind !== "param" && b.high.kind !== "param")
				)
			: [],
		inSets: scope.keep("in set")
			? Arr.flatMap(sketch.inSet, (s) =>
					Option.toArray(Option.fromUndefinedOr(resolveInSet(state, s)))
				)
			: [],
		allens: scope.keep("allen")
			? Arr.flatMap(sketch.allen, (a) =>
					Option.toArray(Option.fromUndefinedOr(resolveAllen(state, a)))
				)
			: [],
		pointIns: scope.keep("point in")
			? Arr.flatMap(sketch.pointIn, (p) =>
					Option.toArray(Option.fromUndefinedOr(resolvePointIn(state, p)))
				)
			: [],
		connectives: scope.keep("connective")
			? Arr.map(sketch.connective, (j) =>
					resolveConnective(state, j, (c) => !plainRoot || c.right.kind !== "param")
				)
			: [],
		negations,
		/** An importable root's head is its variables alone, which an import reads as its fields. */
		head: resolveHead(
			state,
			sketch.head,
			plainRoot ? [] : sketch.computed,
			name,
			plainRoot ? "none" : "drawn"
		)
	}
}

/**
 * The second arm of a union: the first with every constant of its matches and comparisons moved to the next value
 * class and every parameter made afresh with the next value, so its heading is the first's and its rows mostly differ.
 * Its ranges, sets, Allen atoms, point memberships, connectives, negations and head are the first's, their parameters
 * made afresh.
 */
const shiftedRule = <P extends ParentColumn>(scope: ReadScope, rule: Rule<P>): Rule<P> => {
	const again = (operand: Operand<never>, type: ScalarType): Operand<never> =>
		operand.kind === "param"
			? { kind: "param", param: scope.again(operand.param, nextValue(type, operand.param.value)) }
			: operand
	const shift = (operand: Operand<P>, type: ScalarType): Operand<P> => {
		if (operand.kind === "literal") {
			return { kind: "literal", literal: nextValue(type, operand.literal) }
		}
		if (operand.kind === "param") {
			return {
				kind: "param",
				param: scope.again(operand.param, nextValue(type, operand.param.value))
			}
		}
		return operand
	}
	const [first, ...rest] = Arr.map(rule.matches, (m): Match<P> => ({
		source: m.source,
		bindings: [
			{
				field: m.bindings[0].field,
				operand: shift(m.bindings[0].operand, m.bindings[0].field.type)
			},
			...Arr.map(m.bindings.slice(1), (b) => ({
				field: b.field,
				operand: shift(b.operand, b.field.type)
			}))
		]
	}))
	return {
		matches: [first, ...rest],
		where: Arr.map(rule.where, (c) => {
			const right = c.right
			return {
				op: c.op,
				left: c.left,
				right:
					right.kind === "literal"
						? { kind: "literal", literal: nextValue(c.left.field.type, right.literal) }
						: again(right, c.left.field.type)
			}
		}),
		between: Arr.map(rule.between, (b) => ({
			left: b.left,
			low: again(b.low, b.left.field.type),
			high: again(b.high, b.left.field.type)
		})),
		inSets: rule.inSets,
		allens: rule.allens,
		pointIns: rule.pointIns,
		connectives: Arr.map(rule.connectives, (j) => ({
			kind: j.kind,
			args: Arr.map(j.args, (c) => ({
				op: c.op,
				left: c.left,
				right: again(c.right, c.left.field.type)
			}))
		})),
		negations: rule.negations,
		head: rule.head
	}
}

/** A total order over every column of a heading, rotated and directed by the sketch. */
const orderOf = (
	heading: Arr.NonEmptyReadonlyArray<Column>,
	sketch: OrderSketch
): Arr.NonEmptyReadonlyArray<OrderKey> => {
	const start = pickIndex(sketch.rotate, heading.length)
	const keys = Arr.map(indices(heading.length), (i): OrderKey => ({
		column: elementOf(heading, (start + i) % heading.length, "a heading column"),
		dir: upper(sketch.dirs[i] ?? 0) ? "desc" : "asc"
	}))
	const [first, ...rest] = keys
	if (first === undefined) {
		throw new Error("an order over no column")
	}
	return [first, ...rest]
}

/**
 * A root take's stated order: orderOf's, less its last column where the sketch leaves it out and another stays, so the
 * rows the stated keys tie are ordered by the take's completion (program.ts takeOrder).
 */
const statedTakeOrder = (
	heading: Arr.NonEmptyReadonlyArray<Column>,
	sketch: TakeSketch
): Arr.NonEmptyReadonlyArray<OrderKey> => {
	const [first, ...rest] = orderOf(heading, sketch)
	return upper(sketch.ties) ? [first, ...Arr.dropRight(rest, 1)] : [first, ...rest]
}

/**
 * Whether equal values of a type print apart (gen/domain.ts twinSpellings), which a stitch by text misreads: a double
 * precision's 0 and -0, a vector's -0 components, a computed numeric's display scales; never a numeric(p, s)'s, which
 * stores every spelling of a value at its scale s.
 */
const twinned = (type: ScalarType): boolean => {
	const base = baseOf(type)
	return twinSpellings[base.carrier].kind === "twins" && numericTypmodOf(base) === undefined
}

/**
 * The parent columns a child may bind, those whose stored values have twin spellings first: the parent keys a stitch
 * by text instead of by the type's equality would misread.
 */
const linkable = (parent: ReadonlyArray<Column>): ReadonlyArray<Column> => [
	...Arr.filter(parent, (c) => twinned(c.type)),
	...Arr.filter(parent, (c) => !twinned(c.type))
]

/** The parent columns of a field's type. */
const columnsOfType = (parent: ReadonlyArray<Column>, field: ProgramField): ReadonlyArray<Column> =>
	Arr.filter(parent, (c) => sameScalarType(c.type, field.type))

/** The head column of a rule whose variable a match binds at `field`, or none where none is. */
const headColumnAt = <P extends ParentColumn>(
	parent: Parent<P>,
	rule: Rule<P>,
	m: Match<P>,
	field: ProgramField
): Option.Option<Column> =>
	Option.flatMap(
		Arr.findFirst(m.bindings, (b) => b.field === field),
		(binding) => {
			const operand = binding.operand
			if (operand.kind !== "var") {
				return Option.none()
			}
			return Option.flatMap(
				Arr.findFirst(rule.head, (h) => h.kind === "var" && h.var.id === operand.var.id),
				(head) => Arr.findFirst(parent.heading, (c) => c.name === head.name)
			)
		}
	)

/**
 * A plain child's first match: a parent column some stored relation has a field of the type of, and the relation and
 * field the child's first match binds to it; one whose equal values print differently where the case is spelled.
 * Undefined when no stored field can take any parent column: the language admits no uncorrelated child.
 */
const plainFirst = (
	scope: ReadScope,
	parent: ReadonlyArray<Column>,
	sketch: ChildSketch
): FirstMatch<ParentColumn> | undefined => {
	const targetsOf = (column: Column) =>
		Arr.flatMap(scope.schema.relations, (source) =>
			Arr.map(
				Arr.filter(source.fields, (f) => sameScalarType(f.type, column.type)),
				(field) => ({ source, field })
			)
		)
	const reachable = Arr.filter(linkable(parent), (c) => targetsOf(c).length > 0)
	const spelled = Arr.filter(reachable, (c) => twinned(c.type))
	const column = pickAmong(
		weightOf(scope.swarm, "spelled") > 0 && spelled.length > 0 ? spelled : reachable,
		sketch.link
	)
	if (column === undefined) {
		return undefined
	}
	const target = pickAmong(
		targetsOf(column),
		elementOf(sketch.rule.matches, 0, "a child's first match").source
	)
	return target === undefined
		? undefined
		: {
				source: target.source,
				pins: new Map<ProgramField, Operand<ParentColumn>>([
					[target.field, { kind: "parent", column }]
				])
			}
}

/**
 * A keyed child's one match: a key of a source with a field some parent column can take, each of its fields bound to a
 * parent column of its type where there is one and to a literal otherwise.
 */
const keyedFirst = (
	scope: ReadScope,
	parent: ReadonlyArray<Column>,
	sketch: ChildSketch
): FirstMatch<ParentColumn> | undefined => {
	const keys = Arr.flatMap(scope.sources(), (source) =>
		Arr.map(
			Arr.filter(keysOf(source), (key) =>
				Arr.some(key, (f) => columnsOfType(parent, f).length > 0)
			),
			(key) => ({ source, key })
		)
	)
	const chosen = pickAmong(keys, sketch.link)
	if (chosen === undefined) {
		return undefined
	}
	const binds = elementOf(sketch.rule.matches, 0, "a child's first match").binds
	const fields = sourceFields(chosen.source)
	const pins = new Map<ProgramField, Operand<ParentColumn>>()
	for (const field of chosen.key) {
		const bind = elementOf(binds, fields.indexOf(field), "a bind sketch")
		const column = pickAmong(columnsOfType(parent, field), bind.pick)
		pins.set(
			field,
			column === undefined
				? { kind: "literal", literal: drawValue(field.type, bind.value, scope.dense) }
				: { kind: "parent", column }
		)
	}
	return { source: chosen.source, pins }
}

/**
 * A reflexive child's one match: a stored relation the parent's one rule matches, bound at a field whose variable the
 * parent's head delivers, bound once in that match, to the parent column delivering it.
 */
const reflexiveFirst = <P extends ParentColumn>(
	parent: Parent<P>,
	sketch: ChildSketch
): FirstMatch<ParentColumn> | undefined => {
	const [only, ...more] = parent.arms
	if (more.length > 0) {
		return undefined
	}
	const reads = Arr.flatMap(only.matches, (m) => {
		const source = m.source
		if (source.kind !== "stored") {
			return []
		}
		return Arr.flatMap(m.bindings, (b) => {
			const column = headColumnAt(parent, only, m, b.field)
			const operand = b.operand
			const once =
				operand.kind === "var" &&
				Arr.filter(
					m.bindings,
					(o) => o.operand.kind === "var" && o.operand.var.id === operand.var.id
				).length === 1
			return Option.isNone(column) || !once
				? []
				: [{ source, field: b.field, column: column.value }]
		})
	})
	const chosen = pickAmong(reads, sketch.link)
	return chosen === undefined
		? undefined
		: {
				source: chosen.source,
				pins: new Map<ProgramField, Operand<ParentColumn>>([
					[chosen.field, { kind: "parent", column: chosen.column }]
				])
			}
}

/**
 * An arm child's one match: a stored relation one match of the parent's first rule reads a key of, and a handle field
 * outside that key, into head columns; the key bound to those parent columns and the handle field to a literal handle.
 * The parent's other rules are a union's, which match as the first does.
 */
const armFirst = <P extends ParentColumn>(
	scope: ReadScope,
	parent: Parent<P>,
	sketch: ChildSketch
): FirstMatch<ParentColumn> | undefined => {
	const [first] = parent.arms
	const arms = Arr.flatMap(first.matches, (m) => {
		const source = m.source
		if (source.kind !== "stored") {
			return []
		}
		return Arr.flatMap(keysOf(source), (key) => {
			const columns = Arr.map(key, (field) => headColumnAt(parent, first, m, field))
			const keyed = Arr.flatMap(columns, (column, i) =>
				Option.isNone(column)
					? []
					: [{ field: elementOf(key, i, "a key field"), column: column.value }]
			)
			if (keyed.length !== key.length) {
				return []
			}
			return Arr.map(
				Arr.filter(
					source.fields,
					(h) =>
						h.kind === "handle" &&
						!key.includes(h) &&
						Option.isSome(headColumnAt(parent, first, m, h))
				),
				(handleField) => ({ source, keyed, handleField })
			)
		})
	})
	const chosen = pickAmong(arms, sketch.link)
	if (chosen === undefined) {
		return undefined
	}
	const pins = new Map<ProgramField, Operand<ParentColumn>>(
		Arr.map(chosen.keyed, ({ field, column }) => [field, { kind: "parent", column }])
	)
	pins.set(chosen.handleField, {
		kind: "literal",
		literal: { kind: "handle", handle: pickFrom(scope.schema.roster.handles, sketch.handle) }
	})
	return { source: chosen.source, pins }
}

/**
 * The forms of an attachment's child: plain (its drawn matches, the floor), keyed, reflexive and arm (above). A form
 * that finds nothing to build from in the parent is the plain child.
 */
const childForms = ["plain child", "keyed child", "reflexive child", "arm child"] as const

/**
 * The delivery a child states, among those its proof licenses: the narrowest three times in four, otherwise any, the
 * array first, toward which it shrinks.
 */
const statedOf = (
	options: Arr.NonEmptyReadonlyArray<StatedDelivery>,
	pick: number
): StatedDelivery => (pickIndex(pick, 4) > 0 ? Arr.lastNonEmpty(options) : pickFrom(options, pick))

/**
 * One attachment's child over `parent`, the query it attaches to; `names` is that query's scope. A child binds a parent
 * column (an attachment correlated with nothing is refused, AttachedParentUnbound), so where no stored field can take
 * one there is no attachment. The child states the array, or where the case states deliveries one drawn among those
 * its proof licenses (delivery.ts).
 */
const resolveChild = <P extends ParentColumn>(
	scope: ReadScope,
	parent: Parent<P>,
	sketch: ChildSketch,
	names: Names,
	nested: ChildSketch | undefined
): Attachment | undefined => {
	const stated = scope.keep("stated delivery")
	const shaped = stated ? scope.choose(childForms) : "plain child"
	const plain = (): RuleForm<ParentColumn> | undefined => {
		const first = plainFirst(scope, parent.heading, sketch)
		return first === undefined ? undefined : { kind: "drawn", first }
	}
	const built = (): RuleForm<ParentColumn> | undefined => {
		switch (shaped) {
			case "plain child":
				return undefined
			case "keyed child": {
				const first = keyedFirst(scope, parent.heading, sketch)
				return first === undefined ? undefined : { kind: "keyed", first }
			}
			case "reflexive child": {
				const first = reflexiveFirst(parent, sketch)
				return first === undefined ? undefined : { kind: "own", first, head: "ungrouped" }
			}
			case "arm child": {
				const first = armFirst(scope, parent, sketch)
				return first === undefined ? undefined : { kind: "own", first, head: "drawn" }
			}
		}
	}
	const form = built() ?? plain()
	if (form === undefined) {
		return undefined
	}
	const name = names.draw(sketch.name, "attachment")
	const childNames = new Names(scope.kinds)
	const heads = new Map<number, string>()
	const headName = (i: number): string => {
		const known = heads.get(i)
		if (known !== undefined) {
			return known
		}
		const drawn = childNames.draw(elementOf(sketch.rule.head.names, i, "a head name"), "column")
		heads.set(i, drawn)
		return drawn
	}
	const parentOperand = (field: ProgramField, pick: number): ParentColumn | undefined => {
		const column = pickAmong(columnsOfType(parent.heading, field), pick)
		return column === undefined ? undefined : { kind: "parent", column }
	}
	const rule = resolveRule<ParentColumn>(scope, sketch.rule, headName, parentOperand, form)
	const heading = headingOf(rule.head)
	const grandchild =
		nested !== undefined && scope.keep("nested")
			? resolveChild(scope, { heading, arms: [rule] }, nested, childNames, undefined)
			: undefined
	const columns = nonEmpty(heading)
	const child: Query<ParentColumn> = {
		heading,
		arms: [rule],
		bound:
			columns !== undefined && scope.keep("attached take")
				? {
						kind: "take",
						order: orderOf(columns, sketch.take),
						k: 1 + pickIndex(sketch.take.size, 3)
					}
				: { kind: "set" },
		stage: { kind: "unnamed" },
		attachments: grandchild === undefined ? [] : [grandchild]
	}
	const delivery: StatedDelivery = stated
		? statedOf(licensed(deliveryProof(parent, child)), sketch.delivery)
		: { kind: "array" }
	return { name, child, delivery }
}

const endpoint = (f: ProgramField) =>
	hasCap(f.type, "hashing") &&
	hasCap(f.type, "ordering") &&
	f.kind !== "span4" &&
	f.kind !== "span8"

/**
 * The closure a read's root may match: over a relation's two distinct fields of one type whose values hash and are
 * ordered (no span, whose order is the range's), named in the root's scope; undefined where the relation has none.
 */
const resolveClosure = (
	scope: ReadScope,
	sketch: ReadSketch["closure"],
	names: Names
): Closure | undefined => {
	const edge = pickFrom(scope.schema.relations, sketch.relation)
	const pairs = Arr.flatMap(edge.fields, (from) =>
		Arr.map(
			Arr.filter(
				edge.fields,
				(to) => to !== from && endpoint(from) && endpoint(to) && sameScalarType(from.type, to.type)
			),
			(to) => ({ from, to })
		)
	)
	const pair = pickAmong(pairs, sketch.pair)
	if (pair === undefined) {
		return undefined
	}
	const end = (name: string): ProgramField => ({ name, kind: pair.from.kind, type: pair.from.type })
	return {
		kind: "closure",
		name: names.draw(sketch.name, "Closure"),
		edge,
		from: pair.from,
		to: pair.to,
		fields: [end("src"), end("dst")]
	}
}

/** A read's root, and the relation parameters its matches read. */
const resolveRoot = (
	scope: ReadScope,
	sketch: ReadSketch,
	importable: boolean
): { readonly root: Root; readonly relations: ReadonlyArray<RelationParam> } => {
	const names = new Names(scope.kinds)
	const heads = new Map<number, string>()
	const headName = (i: number): string => {
		const known = heads.get(i)
		if (known !== undefined) {
			return known
		}
		const drawn = names.draw(elementOf(sketch.rule.head.names, i, "a head name"), "column")
		heads.set(i, drawn)
		return drawn
	}
	/** An importable root reads no derived source (resolveRule), so it draws none. */
	const relation: RelationParam | undefined =
		!importable && scope.keep("relation param")
			? (() => {
					const of = pickFrom(scope.schema.relations, sketch.relationParam.relation)
					return {
						name: `rel${scope.read}_0`,
						relation: of,
						rows: Arr.map(
							resolveFacts(of, sketch.relationParam.facts, scope.dense, "canonical"),
							storedFactValues
						)
					}
				})()
			: undefined
	const closure =
		!importable && scope.keep("recursive")
			? resolveClosure(scope, sketch.closure, names)
			: undefined
	const first = resolveRule<never>(scope, sketch.rule, headName, noParent, {
		kind: "root",
		derived: { imports: scope.imports, relation, closure },
		importable,
		bindImport: scope.imports.length > 0 && upper(sketch.bindImport) && scope.keep("import bound")
	})
	/**
	 * A union's arms: the first and its shifted copy, and where the arms state a literal head key (never beside an
	 * aggregate, which a constant key would group), a third shifted once more where the sketch asks for one.
	 */
	const arms = ((): Arr.NonEmptyReadonlyArray<Rule<never>> => {
		if (!scope.keep("union")) {
			return [first]
		}
		/** An importable root's arms find variables alone (resolveRule), so it states no literal head key. */
		const literal = !isAggregate(first) && !importable && scope.keep("literal head")
		const second = shiftedRule(scope, first)
		if (!literal) {
			return [first, second]
		}
		const unioned: Arr.NonEmptyReadonlyArray<Rule<never>> = upper(sketch.literalHead.arms)
			? [first, second, shiftedRule(scope, second)]
			: [first, second]
		return literalArms(unioned, names.draw(sketch.literalHead.name, "side"), sketch.literalHead)
	})()
	const heading = headingOf(arms[0].head)
	const columns = nonEmpty(heading)
	const bound: ProgramBound =
		columns !== undefined && scope.keep("take")
			? {
					kind: "take",
					order: statedTakeOrder(columns, sketch.take),
					k: 1 + pickIndex(sketch.take.size, 3)
				}
			: { kind: "set" }
	const stage: Root["stage"] = scope.keep("named")
		? { kind: "named", name: names.draw(sketch.named, "stage") }
		: { kind: "unnamed" }
	const attachments = scope.keep("attach")
		? Arr.flatMap(sketch.attachments, (a) =>
				Option.toArray(
					Option.fromUndefinedOr(resolveChild(scope, { heading, arms }, a, names, a.nested))
				)
			)
		: []
	const delivery: Delivery =
		columns !== undefined && scope.keep("ordered")
			? {
					kind: "ordered",
					order: orderOf(columns, sketch.order),
					pageSize: 1 + pickIndex(sketch.order.size, 3)
				}
			: { kind: "set" }
	const relations = Arr.flatMap(first.matches, (m) =>
		m.source.kind === "relation param" ? [m.source.param] : []
	)
	return {
		root: { heading, arms, bound, stage, attachments, delivery },
		relations: relation !== undefined && relations.includes(relation) ? [relation] : []
	}
}

/**
 * The parameters a query reads, each once: its rules' match bindings, the parameters its imports are bound to, its
 * interiors' own, and its comparisons' and ranges' operands, then its attachments' children's. A parameter the
 * resolution minted for a part it then left out (an interior no match read) is none of them.
 */
const operandParams = <P extends ParentColumn>(operand: Operand<P>): ReadonlyArray<Param> =>
	operand.kind === "param" ? [operand.param] : []

const sourceParams = (source: Source): ReadonlyArray<Param> => {
	switch (source.kind) {
		case "import":
			return Arr.flatMap(source.binds, (b) => (b.to.kind === "param" ? [b.to.param] : []))
		case "interior":
			return ruleParams(source.rule)
		case "stored":
		case "roster":
		case "relation param":
		case "closure":
			return []
	}
}

const ruleParams = <P extends ParentColumn>(rule: Rule<P>): ReadonlyArray<Param> => [
	...Arr.flatMap(rule.matches, (m) => [
		...sourceParams(m.source),
		...Arr.flatMap(m.bindings, (b) => operandParams(b.operand))
	]),
	...Arr.flatMap(rule.where, (c) => operandParams(c.right)),
	...Arr.flatMap(rule.between, (b) => [...operandParams(b.low), ...operandParams(b.high)]),
	...Arr.flatMap(rule.connectives, (j) => Arr.flatMap(j.args, (c) => operandParams(c.right)))
]

const queryParams = <P extends ParentColumn>(q: Query<P>): ReadonlyArray<Param> => [
	...new Set([
		...Arr.flatMap(q.arms, ruleParams),
		...Arr.flatMap(q.attachments, (a) => queryParams(a.child))
	])
]

/**
 * The refusal a read provokes: one of those its query can carry (a parameter to mistype; an ordered root to page with a
 * size that is no safe integer of at least 1, zero or the first unsafe integer, or a cursor its codec cannot read), or
 * none.
 */
const resolveProbe = (
	scope: ReadScope,
	params: ReadonlyArray<Param>,
	root: Root,
	sketch: ReadSketch["probe"]
): Probe => {
	if (!scope.keep("probe")) {
		return { kind: "none" }
	}
	const param = pickAmong(params, sketch.pick)
	const orderedBy = root.delivery.kind === "ordered"
	const probes: ReadonlyArray<Probe> = [
		...(param === undefined ? [] : [{ kind: "encode", param } satisfies Probe]),
		...(orderedBy
			? [
					{
						kind: "page size",
						size: upper(sketch.pick) ? Number.MAX_SAFE_INTEGER + 1 : 0
					} satisfies Probe,
					{ kind: "cursor" } satisfies Probe
				]
			: [])
	]
	return pickAmong(probes, sketch.kind) ?? { kind: "none" }
}

/**
 * A keyed lookup: a relation's primary or candidate key, at an existing fact's key or at drawn values.
 */
const resolveKeyRead = (
	schema: ProgramSchema,
	facts: ReadonlyMap<string, ReadonlyArray<StoredFact>>,
	sketch: ReadSketch["key"],
	dense: boolean
): ProgramRead => {
	const relation = pickFrom(schema.relations, sketch.relation)
	const keys: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<ProgramField>> = [
		relation.primaryKey,
		...relation.candidates
	]
	const which = pickIndex(sketch.which, keys.length)
	const key = elementOf(keys, which, "a key")
	const fact = upper(sketch.absent)
		? undefined
		: pickAmong(facts.get(relation.name) ?? [], sketch.fact)
	const valueAt = (field: ProgramField): TypedLiteral => {
		if (fact === undefined) {
			return drawValue(field.type, { cls: sketch.fact, sp: sketch.absent }, dense)
		}
		return elementOf(fact, relation.fields.indexOf(field), "a fact's value").literal
	}
	const [firstField, ...restFields] = key
	return {
		kind: "key",
		relation,
		key,
		candidate: which > 0,
		values: [valueAt(firstField), ...Arr.map(restFields, valueAt)]
	}
}

/**
 * The case's closed roster, its name drawn in the schema's scope after the contract's, which no relation or roster
 * takes.
 */
const resolveRoster = (names: Names, pick: number): CaseRoster => {
	names.reserve("Tick")
	const name = names.draw(pick, "Roster")
	return {
		kind: "roster",
		name,
		handles: rosterHandles,
		id: { name: "id", kind: "handle", type: typeOf("handle", { name }) }
	}
}

/**
 * A rule of one match and nothing else: no comparison, range, set, Allen atom, point membership, connective or
 * negation.
 */
const soleRule = <P>(
	source: Source,
	bindings: Arr.NonEmptyReadonlyArray<Binding<P>>,
	head: ReadonlyArray<HeadItem>
): Rule<P> => ({
	matches: [{ source, bindings }],
	where: [],
	between: [],
	inSets: [],
	allens: [],
	pointIns: [],
	connectives: [],
	negations: [],
	head
})

/** A set query of one rule and no further attachment. */
const setQuery = <P>(rule: Rule<P>, attachments: ReadonlyArray<Attachment>): Query<P> => ({
	heading: headingOf(rule.head),
	arms: [rule],
	bound: { kind: "set" },
	stage: { kind: "unnamed" },
	attachments
})

const query = (q: Root): ProgramRead => ({
	kind: "query",
	query: q,
	params: [],
	relations: [],
	probe: { kind: "none" }
})

const parentOf = (field: ProgramField, column: Column): Binding<ParentColumn> => ({
	field,
	operand: { kind: "parent", column }
})

const varOf = <P>(field: ProgramField, v: Var): Binding<P> => ({
	field,
	operand: { kind: "var", var: v }
})

/**
 * The planted case: one relation P(k int4, v numeric(161, 40), d double precision, h handle) keyed by k, two of whose
 * facts hold one value of v in two input spellings, which a numeric(p, s) stores alike, the zero of d as 0 and as -0,
 * which a double precision stores and prints apart, and differ in h, beside the facts the first relation sketch draws
 * at other keys; one relation V(k int4, u vector(3)) keyed by k, whose two facts hold one vector, the second with -0
 * components; one relation T(k int4, g int4) keyed by k, whose facts (k, g) are (0, 0), (1, 0), (2, 1) and (3, 0); and
 * these reads, every padding pad(v) at the sketch's display scale:
 *
 *   q0 = P{k, v, d, h} find {k, v, d, h}
 *     attach arm:    P{k: parent k, v: w, h: H} find {v: w}, stated as the arm of H over h
 *     attach signed: P{d: parent d, k: w} find {k: w}
 *       attach nested: P{k: parent k, h: w} find {h: w}
 *   q1 = q0, its attachments kept, {k, v, d, h} find {k, v, d, h}
 *   q2 = P{k} find {k, side: x} | P{k, v} find {k, v, side: y} | P{k} find {k, side: z}, x, y and z distinct
 *   q3 = P{v} find {v, pad(v), Compute.div(v, 3), sqrt(pad(v)), power(v, 2)}
 *   q4 = P{v} find {r.mean(pad(v)), r.mean(v)}
 *   q5 = P{k, d} find {k, d}
 *     attach fused: P{d: parent d, k: w} find {k: w}
 *   q6 = V{k, u} find {k, u}
 *     attach twins: V{u: parent u, k: w} find {k: w}
 *       attach nested: V{k: parent k, u: w} find {u: w}
 *   q7 = T{k, g} find {k, g}, orderBy([g, "desc"]).take(3)
 *
 * q3 collapses the two facts' v, one value, into one row, beside its padding and its readings at the display scale;
 * q4 means it, and its padding, over P's distinct values of v. q5's child of one field is pipelined, as every
 * attachment over exact parents is, so the host stitches its children to the two rows whose d is one value stored as 0
 * and as -0; q6's child is pipelined, so the host stitches it to parents whose vector keys are one value, one stored
 * with -0 components.
 *
 * The arm delivers Some to the parent row whose h is H, one of the two, and None to the other. The signed
 * attachment's parents include the two rows whose d is one value stored as 0 and as -0, each with the children of
 * both, and it is pipelined, since a child with an attachment of its own is never fused
 * (lower/shapes/index.ts rowsStatement): the stitch by key must use the type's equality, never the cell's
 * text. q1 imports an attached query, whose attachments deliver nothing to its rows. q2 is a heterogeneous union whose
 * third arm repeats the first's key set with another literal at its discriminant, which a decoder keying its layouts by
 * key set alone cannot tell apart. q7 is a root take of three rows, ordered apart by its descending key and tied by it,
 * so its delivery is the take's order, the ties broken by k, the key its stated order leaves out.
 */
const plantedCase = (sketch: CaseSketch): ProgramCase => {
	const planted = sketch.planted
	const pick = (slot: PlantedName): number =>
		elementOf(planted.names, plantedNames.indexOf(slot), "a planted name pick")
	const kinds = new Set<NameKind>()
	const names = new Names(kinds)
	const roster = resolveRoster(names, sketch.roster)
	const fieldNames = new Names(kinds)
	/** A closed-id field is named as every one is (Names.drawClosedId), so its decoded column fits an identifier. */
	const fieldOf = (kind: FieldKind, slot: PlantedName): ProgramField => ({
		name:
			kind === "handle"
				? fieldNames.drawClosedId(pick(slot), "field")
				: fieldNames.draw(pick(slot), "field"),
		kind,
		type: typeOf(kind, roster)
	})
	const key = fieldOf("int4", "key field")
	const spelled = fieldOf("numeric", "spelled field")
	const signed = fieldOf("float8", "signed field")
	const handle = fieldOf("handle", "handle field")
	const relation: Stored = {
		kind: "stored",
		name: names.draw(pick("relation"), "Rel0x"),
		fields: [key, spelled, signed, handle],
		primaryKey: [key],
		candidates: []
	}
	const vectorFieldNames = new Names(kinds)
	const vectorKey: ProgramField = {
		name: vectorFieldNames.draw(pick("vector key field"), "field"),
		kind: "int4",
		type: typeOf("int4", roster)
	}
	const vector: ProgramField = {
		name: vectorFieldNames.draw(pick("vector field"), "field"),
		kind: "vector",
		type: typeOf("vector", roster)
	}
	const vectorRelation: Stored = {
		kind: "stored",
		name: names.draw(pick("vector relation"), "Rel1x"),
		fields: [vectorKey, vector],
		primaryKey: [vectorKey],
		candidates: []
	}
	const rankedFieldNames = new Names(kinds)
	const rankedKey: ProgramField = {
		name: rankedFieldNames.draw(pick("ranked key field"), "field"),
		kind: "int4",
		type: typeOf("int4", roster)
	}
	const rank: ProgramField = {
		name: rankedFieldNames.draw(pick("rank field"), "field"),
		kind: "int4",
		type: typeOf("int4", roster)
	}
	const rankedRelation: Stored = {
		kind: "stored",
		name: names.draw(pick("ranked relation"), "Rel2x"),
		fields: [rankedKey, rank],
		primaryKey: [rankedKey],
		candidates: []
	}
	const schema: ProgramSchema = {
		relations: [relation, vectorRelation, rankedRelation],
		roster,
		nameKinds: kinds
	}
	/** The shared value of v: a value of twin input spellings, held by both facts. */
	const twice = nonEmpty(
		Arr.filter(valuesOf(spelled.type, false), (l) => twinsOf(spelled.type, l).length > 0)
	)
	if (twice === undefined) {
		throw new Error("a wide numeric has no value of twin spellings")
	}
	const value = pickFrom(twice, planted.value.cls)
	const spellings = twinsOf(spelled.type, value).length + 1
	const at = pickIndex(planted.value.sp, spellings)
	/** The shared value of d: the zero, stored as 0 by the first fact and as -0, its twin, by the second. */
	const zero = Option.getOrThrowWith(
		Arr.findFirst(valuesOf(signed.type, false), (l) => twinsOf(signed.type, l).length > 0),
		() => new Error("no generated double precision value is a zero")
	)
	const selected = pickFrom(roster.handles, planted.handle)
	const other = elementOf(
		roster.handles,
		(roster.handles.indexOf(selected) + 1) % roster.handles.length,
		"a handle"
	)
	const plantedFacts: ReadonlyArray<StoredFact> = [
		[
			canonicallySpelled({ kind: "int", value: 0n }),
			spelledAt(spelled.type, value, at),
			spelledAt(signed.type, zero, 0),
			canonicallySpelled({ kind: "handle", handle: selected })
		],
		[
			canonicallySpelled({ kind: "int", value: 1n }),
			spelledAt(spelled.type, value, (at + 1) % spellings),
			spelledAt(signed.type, zero, 1),
			canonicallySpelled({ kind: "handle", handle: other })
		]
	]
	const keyAt = (f: StoredFact) => keyOf(storedFactValues(f), relation, relation.primaryKey)
	const taken = new Set(Arr.map(plantedFacts, keyAt))
	const drawnFacts = Arr.filter(
		resolveFacts(
			relation,
			elementOf(sketch.relations, 0, "a relation sketch").facts,
			false,
			"drawn"
		),
		(f) => !taken.has(keyAt(f))
	)
	let vars = 0
	const mint = (field: ProgramField): Var => ({ id: vars++, field })
	const headOf = (scope: Names, slot: PlantedName, v: Var): HeadItem => ({
		kind: "var",
		name: scope.draw(pick(slot), "column"),
		var: v
	})
	const rootNames = new Names(kinds)
	const [k, v, d, h] = [mint(key), mint(spelled), mint(signed), mint(handle)]
	const rootRule = soleRule<never>(
		relation,
		[varOf(key, k), varOf(spelled, v), varOf(signed, d), varOf(handle, h)],
		[
			headOf(rootNames, "key column", k),
			headOf(rootNames, "spelled column", v),
			headOf(rootNames, "signed column", d),
			headOf(rootNames, "handle column", h)
		]
	)
	const heading = headingOf(rootRule.head)
	const keyColumn = elementOf(heading, 0, "the root's key column")
	const signedColumn = elementOf(heading, 2, "the root's signed column")
	const handleOut = elementOf(heading, 3, "the root's handle column")
	const armValue = mint(spelled)
	const armChild = setQuery<ParentColumn>(
		soleRule(
			relation,
			[
				parentOf(key, keyColumn),
				varOf(spelled, armValue),
				{
					field: handle,
					operand: { kind: "literal", literal: { kind: "handle", handle: selected } }
				}
			],
			[headOf(new Names(kinds), "arm column", armValue)]
		),
		[]
	)
	const armDelivery = Option.getOrThrowWith(
		Arr.findFirst(
			licensed(deliveryProof({ heading, arms: [rootRule] }, armChild)),
			(d) => d.kind === "arm" && d.field.name === handleOut.name && d.handle === selected
		),
		() => new Error("the planted arm is not licensed")
	)
	const arm: Attachment = {
		name: rootNames.draw(pick("arm"), "attachment"),
		child: armChild,
		delivery: armDelivery
	}
	/** The signed attachment and its nested one. */
	const signedNames = new Names(kinds)
	const childKey = mint(key)
	const childRule = soleRule<ParentColumn>(
		relation,
		[parentOf(signed, signedColumn), varOf(key, childKey)],
		[headOf(signedNames, "signed child column", childKey)]
	)
	const nestedHandle = mint(handle)
	const nested: Attachment = {
		name: signedNames.draw(pick("nested"), "attachment"),
		child: setQuery(
			soleRule(
				relation,
				[
					parentOf(key, elementOf(headingOf(childRule.head), 0, "the signed child's column")),
					varOf(handle, nestedHandle)
				],
				[headOf(new Names(kinds), "nested column", nestedHandle)]
			),
			[]
		),
		delivery: { kind: "array" }
	}
	const signedAttachment: Attachment = {
		name: rootNames.draw(pick("signed"), "attachment"),
		child: setQuery(childRule, [nested]),
		delivery: { kind: "array" }
	}
	const rootQuery = setQuery(rootRule, [arm, signedAttachment])
	const root: Root = { ...rootQuery, delivery: { kind: "set" } }
	/** The second read: the root imported with its attachments, of which it reads only the root's rows (meaning.ts). */
	const importFields = Arr.map([key, spelled, signed, handle], (f, i): ProgramField => ({
		name: elementOf(heading, i, "the root's column").name,
		kind: f.kind,
		type: f.type
	}))
	const [importKey, importSpelled, importSigned, importHandle] = Arr.map(importFields, (f) => ({
		field: f,
		var: mint(f)
	}))
	if (
		importKey === undefined ||
		importSpelled === undefined ||
		importSigned === undefined ||
		importHandle === undefined
	) {
		throw new Error("the planted root's heading is no four columns")
	}
	const imported: Imported = {
		kind: "import",
		read: 0,
		query: rootQuery,
		fields: [importKey.field, importSpelled.field, importSigned.field, importHandle.field],
		binds: []
	}
	const importNames = new Names(kinds)
	const importRule = soleRule<never>(
		imported,
		[
			varOf(importKey.field, importKey.var),
			varOf(importSpelled.field, importSpelled.var),
			varOf(importSigned.field, importSigned.var),
			varOf(importHandle.field, importHandle.var)
		],
		[
			headOf(importNames, "import key column", importKey.var),
			headOf(importNames, "import spelled column", importSpelled.var),
			headOf(importNames, "import signed column", importSigned.var),
			headOf(importNames, "import handle column", importHandle.var)
		]
	)
	/**
	 * The third read: the mixed root [A, B, A'] over P, A and A' of the key set {k, side} and B of {k, v, side}, each
	 * arm's side a distinct literal of one kind, so the arms of one key set differ in it.
	 */
	const mixedNames = new Names(kinds)
	const mixedKey = mixedNames.draw(pick("mixed key column"), "column")
	const mixedSpelled = mixedNames.draw(pick("mixed spelled column"), "column")
	const side = mixedNames.draw(pick("mixed side"), "side")
	/** A kind of three literals or more, one per arm (a boolean holds two). */
	const sideKinds = nonEmpty(Arr.filter(literalKinds, (kind) => headLiterals[kind].length >= 3))
	if (sideKinds === undefined) {
		throw new Error("no head literal kind holds three values")
	}
	const sideKind = pickFrom(sideKinds, planted.side.kind)
	const sideType = literalTypes[sideKind]
	const sides: Array<TypedLiteral> = []
	for (let i = 0; i < 3; i++) {
		const free = Arr.filter(
			headLiterals[sideKind],
			(l) => !Arr.some(sides, (s) => nativeEqualityKey(s) === nativeEqualityKey(l))
		)
		const literal = pickAmong(free, elementOf(planted.side.values, i, "a side pick"))
		if (literal === undefined) {
			throw new Error(`the ${sideKind} literals hold no value for arm ${i}`)
		}
		sides.push(literal)
	}
	const [x, y, z] = sides
	if (x === undefined || y === undefined || z === undefined) {
		throw new Error("the mixed root has no three sides")
	}
	const mixedArm = (literal: TypedLiteral, withSpelled: boolean): Rule<never> => {
		const entryKey = mint(key)
		const entryValue = mint(spelled)
		const sideItem: HeadItem = { kind: "literal", name: side, literal, type: sideType }
		return withSpelled
			? soleRule<never>(
					relation,
					[varOf(key, entryKey), varOf(spelled, entryValue)],
					[
						{ kind: "var", name: mixedKey, var: entryKey },
						{ kind: "var", name: mixedSpelled, var: entryValue },
						sideItem
					]
				)
			: soleRule<never>(
					relation,
					[varOf(key, entryKey)],
					[{ kind: "var", name: mixedKey, var: entryKey }, sideItem]
				)
	}
	const [armA, armB, armA2] = [mixedArm(x, false), mixedArm(y, true), mixedArm(z, false)]
	const mixed: MixedRoot = {
		groups: [headingOf(armA.head), headingOf(armB.head)],
		arms: [
			{ group: 0, rule: armA },
			{ group: 1, rule: armB },
			{ group: 0, rule: armA2 }
		],
		discriminant: [side]
	}
	const padding = (v: Var): Padding => paddingOf(v, planted.padding)
	/**
	 * The fourth read: the value two facts hold collapsed into one row of P{v} find {v, ...}, beside its padding and its
	 * readings at the display scale: its quotient, its padding's square root and its square.
	 */
	const collapseNames = new Names(kinds)
	const collapsed = mint(spelled)
	const collapseRule = soleRule<never>(
		relation,
		[varOf(spelled, collapsed)],
		[
			headOf(collapseNames, "collapse column", collapsed),
			computedItem(collapseNames.draw(pick("collapse padded column"), "column"), {
				kind: "padded",
				padding: padding(collapsed)
			}),
			computedItem(collapseNames.draw(pick("collapse quotient column"), "column"), {
				kind: "div",
				dividend: { kind: "var", var: collapsed },
				divisor: divisors[0]
			}),
			computedItem(collapseNames.draw(pick("collapse root column"), "column"), {
				kind: "sqrt",
				radicand: { kind: "padded", padding: padding(collapsed) }
			}),
			computedItem(collapseNames.draw(pick("collapse power column"), "column"), {
				kind: "power",
				base: { kind: "var", var: collapsed },
				exponent: exponents[0]
			})
		]
	)
	/**
	 * The fifth read: the mean of every distinct value of v, and of their paddings, the two facts' v one value. A fold
	 * reads each fact it matches once, by its key, so the distinct values are a stage of their own, P{v} find {v}, a set
	 * keyed by its heading, matched whole.
	 */
	const meanNames = new Names(kinds)
	const meanValue = mint(spelled)
	const values: Interior = {
		kind: "interior",
		rule: soleRule<never>(
			relation,
			[varOf(spelled, meanValue)],
			[{ kind: "var", name: spelled.name, var: meanValue }]
		),
		fields: [{ name: spelled.name, kind: spelled.kind, type: spelled.type }]
	}
	const valueField = values.fields[0]
	const meant = mint(valueField)
	const meanRule = soleRule<never>(
		values,
		[varOf(valueField, meant)],
		[
			{
				kind: "fold",
				name: meanNames.draw(pick("mean padded column"), "column"),
				fn: "mean",
				arg: { kind: "padded", padding: padding(meant) },
				type: aggregateResult("avg", argType({ kind: "padded", padding: padding(meant) }))
			},
			{
				kind: "fold",
				name: meanNames.draw(pick("mean column"), "column"),
				fn: "mean",
				arg: { kind: "var", var: meant },
				type: aggregateResult("avg", spelled.type)
			}
		]
	)
	/**
	 * The sixth read: P{k, d} find {k, d} with a child of one field and no attachment of its own, which the optimized
	 * artifact pipelines as every attachment over exact parents (lower/shapes/index.ts rowsStatement),
	 * correlated on d: the two rows whose d is one value stored as 0 and as -0 each get the children of both.
	 */
	const fusedNames = new Names(kinds)
	const [fusedKey, fusedValue] = [mint(key), mint(signed)]
	const fusedRule = soleRule<never>(
		relation,
		[varOf(key, fusedKey), varOf(signed, fusedValue)],
		[
			headOf(fusedNames, "fused key column", fusedKey),
			headOf(fusedNames, "fused signed column", fusedValue)
		]
	)
	const fusedChildKey = mint(key)
	const fusedParent = elementOf(headingOf(fusedRule.head), 1, "the fused root's signed column")
	const fused: Attachment = {
		name: fusedNames.draw(pick("fused"), "attachment"),
		child: setQuery(
			soleRule<ParentColumn>(
				relation,
				[parentOf(signed, fusedParent), varOf(key, fusedChildKey)],
				[headOf(new Names(kinds), "fused child column", fusedChildKey)]
			),
			[]
		),
		delivery: { kind: "array" }
	}
	/**
	 * The seventh read: V{k, u} find {k, u} over V(k int4, u vector(3)), two of whose facts hold one vector, one with -0
	 * components (its twin spelling), with a child correlated on u that has a nested attachment of its own, so it is
	 * pipelined and the host stitches its children to parents by a vector key.
	 */
	const zeroed = Option.getOrThrowWith(
		Arr.findFirst(valuesOf(vector.type, false), (l) => twinsOf(vector.type, l).length > 0),
		() => new Error("no generated vector has a zero component")
	)
	const vectorFacts: ReadonlyArray<StoredFact> = [
		[canonicallySpelled({ kind: "int", value: 0n }), spelledAt(vector.type, zeroed, 0)],
		[canonicallySpelled({ kind: "int", value: 1n }), spelledAt(vector.type, zeroed, 1)]
	]
	const vectorNames = new Names(kinds)
	const [vectorId, vectorValue] = [mint(vectorKey), mint(vector)]
	const vectorRule = soleRule<never>(
		vectorRelation,
		[varOf(vectorKey, vectorId), varOf(vector, vectorValue)],
		[
			headOf(vectorNames, "vector key column", vectorId),
			headOf(vectorNames, "vector column", vectorValue)
		]
	)
	const twinNames = new Names(kinds)
	const twinKey = mint(vectorKey)
	const vectorParent = elementOf(headingOf(vectorRule.head), 1, "the vector root's vector column")
	const twinRule = soleRule<ParentColumn>(
		vectorRelation,
		[parentOf(vector, vectorParent), varOf(vectorKey, twinKey)],
		[headOf(twinNames, "vector child column", twinKey)]
	)
	const nestedVector = mint(vector)
	const twinParent = elementOf(headingOf(twinRule.head), 0, "the vector child's column")
	const vectorNested: Attachment = {
		name: twinNames.draw(pick("vector nested"), "attachment"),
		child: setQuery(
			soleRule<ParentColumn>(
				vectorRelation,
				[parentOf(vectorKey, twinParent), varOf(vector, nestedVector)],
				[headOf(new Names(kinds), "vector nested column", nestedVector)]
			),
			[]
		),
		delivery: { kind: "array" }
	}
	const vectorAttachment: Attachment = {
		name: vectorNames.draw(pick("vector attachment"), "attachment"),
		child: setQuery(twinRule, [vectorNested]),
		delivery: { kind: "array" }
	}
	/**
	 * The eighth read: T{k, g} find {k, g}, ordered by g descending, take 3, over T(k int4, g int4) keyed by k, whose
	 * facts (k, g) are (0, 0), (1, 0), (2, 1) and (3, 0): g = 1 first, then three rows its stated key ties, which the
	 * take's completion orders by k, so it keeps (0, 0) and (1, 0) in that order and leaves (3, 0).
	 */
	const rankedFacts: ReadonlyArray<StoredFact> = Arr.map(
		[
			[0n, 0n],
			[1n, 0n],
			[2n, 1n],
			[3n, 0n]
		] as const,
		([k, g]) => [
			canonicallySpelled({ kind: "int", value: k }),
			canonicallySpelled({ kind: "int", value: g })
		]
	)
	const rankedNames = new Names(kinds)
	const [rankedId, rankValue] = [mint(rankedKey), mint(rank)]
	const rankedRule = soleRule<never>(
		rankedRelation,
		[varOf(rankedKey, rankedId), varOf(rank, rankValue)],
		[
			headOf(rankedNames, "ranked key column", rankedId),
			headOf(rankedNames, "rank column", rankValue)
		]
	)
	const rankColumn = elementOf(headingOf(rankedRule.head), 1, "the ranked root's rank column")
	const ranked: Root = {
		...setQuery(rankedRule, []),
		bound: { kind: "take", order: [{ column: rankColumn, dir: "desc" }], k: 3 },
		delivery: { kind: "set" }
	}
	/**
	 * The ninth read: T{k, g} find {k, g} over the same facts, each row with its T{k', g} children by g, ordered by k'
	 * descending, take 2: each row of g = 0 receives two of its three children, 3 then 1, which their descending key
	 * orders apart, and the row of g = 1 its one.
	 */
	const tiedNames = new Names(kinds)
	const [tiedId, tiedRank] = [mint(rankedKey), mint(rank)]
	const tiedRule = soleRule<never>(
		rankedRelation,
		[varOf(rankedKey, tiedId), varOf(rank, tiedRank)],
		[headOf(tiedNames, "tied key column", tiedId), headOf(tiedNames, "tied rank column", tiedRank)]
	)
	const tiedParent = elementOf(headingOf(tiedRule.head), 1, "the tied root's rank column")
	const tiedChildKey = mint(rankedKey)
	const tiedChildRule = soleRule<ParentColumn>(
		rankedRelation,
		[parentOf(rank, tiedParent), varOf(rankedKey, tiedChildKey)],
		[headOf(new Names(kinds), "tied child key column", tiedChildKey)]
	)
	const tiedChildColumn = elementOf(headingOf(tiedChildRule.head), 0, "the tied child's key column")
	const tiedChildren: Attachment = {
		name: tiedNames.draw(pick("tied attachment"), "attachment"),
		child: {
			...setQuery(tiedChildRule, []),
			bound: { kind: "take", order: [{ column: tiedChildColumn, dir: "desc" }], k: 2 }
		},
		delivery: { kind: "array" }
	}
	/** The key reads: the first planted fact's key, a key no fact holds, and the selected handle of the roster. */
	const facts = [...plantedFacts, ...drawnFacts]
	const keys = new Set(Arr.map(facts, keyAt))
	let absent = 2n
	while (keys.has(nativeEqualityKey({ kind: "int", value: absent }))) {
		absent++
	}
	const keyRead = (value: TypedLiteral): ProgramRead => ({
		kind: "key",
		relation,
		key: relation.primaryKey,
		candidate: false,
		values: [value]
	})
	return {
		schema,
		facts: new Map<string, ReadonlyArray<StoredFact>>([
			[relation.name, facts],
			[vectorRelation.name, vectorFacts],
			[rankedRelation.name, rankedFacts]
		]),
		perturbation: sketch.perturbation,
		ambient: sketch.ambient,
		restorage: sketch.restorage,
		reads: [
			query(root),
			query({ ...setQuery(importRule, []), delivery: { kind: "set" } }),
			{ kind: "mixed", root: mixed },
			query({ ...setQuery(collapseRule, []), delivery: { kind: "set" } }),
			query({ ...setQuery(meanRule, []), delivery: { kind: "set" } }),
			query({ ...setQuery(fusedRule, [fused]), delivery: { kind: "set" } }),
			query({ ...setQuery(vectorRule, [vectorAttachment]), delivery: { kind: "set" } }),
			query(ranked),
			query({ ...setQuery(tiedRule, [tiedChildren]), delivery: { kind: "set" } }),
			keyRead({ kind: "int", value: 0n }),
			keyRead({ kind: "int", value: absent }),
			{ kind: "handle", handle: selected }
		]
	}
}

/** The roster of the acceptance cases, User [Red, Green, Blue]. */
const userRoster: CaseRoster = {
	kind: "roster",
	name: "User",
	handles: rosterHandles,
	id: { name: "id", kind: "handle", type: typeOf("handle", { name: "User" }) }
}

const acceptanceField = (name: string, kind: FieldKind): ProgramField => ({
	name,
	kind,
	type: typeOf(kind, userRoster)
})

const decimal = (text: string): TypedLiteral => ({ kind: "numeric", value: Decimal.of(text) })

/** A value stored in the input spelling `text`, a twin of its one form, which a direct writer stores as written. */
const twinSpelled = (literal: TypedLiteral, text: string): SpelledValue => ({
	literal,
	spelling: { kind: "twin", text }
})

/** The head key `name` of a variable. */
const varHead = (name: string, v: Var): HeadItem => ({ kind: "var", name, var: v })

/** The column `name` of a heading, which the case built it with. */
const columnNamed = (heading: ReadonlyArray<Column>, name: string): Column =>
	Option.getOrThrowWith(
		Arr.findFirst(heading, (c) => c.name === name),
		() => new Error(`no column ${name} in the heading`)
	)

/**
 * The first acceptance case: issue #3's shrunk case as printed, under its sketch's plan, session and restorage (its
 * kept case states the issue's perturbation).
 *
 *   closed User [Red, Green, Blue]
 *   relation Task { Payroll: handle, Task: numeric, HTTPRoute: handle, span40: span4, tick0: tick, fixed0: fixed }
 *     key [Payroll] key(HTTPRoute)
 *   facts Task: (Green, 0 stored as "0.0", Green, [1,3), 0, 1) (Red, 0, Red, [1,3), 1, 1 stored as "1.00")
 *   q0 = Task{Payroll: p0_0, Task: v0, HTTPRoute: v1, span40: v2, tick0: v3, fixed0: v4}
 *          find {Select: v0, task2note: v1, HttpRoute: v2, User: v3}, named stage0, p0_0 = Green
 *     attach Payroll (option): Task{Payroll: p.task2note, Task: p.Select, HTTPRoute: p.task2note, span40: p.HttpRoute,
 *                              tick0: p.User, fixed0: v5} find {Limit: v5}
 *       attach NOTE (array): Task{Payroll: v6, Task: v7, HTTPRoute: v8, span40: v9, tick0: v10, fixed0: p.Limit}
 *                            . Task{Payroll: v11, Task: v12, HTTPRoute: v13, span40: v14, tick0: v15, fixed0: p.Limit}
 *                            where r.allen(v9, 1273, v14)
 *                            find {Group: v6, note: v7, Task_2_Note: v8, column0: v9,
 *                                  From: Compute.cond(r.ge(v12, 0), v12, 0)}
 *
 * Its facts hold Task's 0 in two spellings, which a direct writer stores as written. NOTE's second match binds v12 to
 * both, since fixed0 is 1 in both facts, so for each binding of its first match its head collapses the two into one
 * row: the delivered From is 0 under every plan, every storage order and every spelling stored.
 */
const acceptanceCollapse = (sketch: CaseSketch): ProgramCase => {
	const payroll = acceptanceField("Payroll", "handle")
	const amount = acceptanceField("Task", "numeric")
	const route = acceptanceField("HTTPRoute", "handle")
	const span = acceptanceField("span40", "span4")
	const tick = acceptanceField("tick0", "tick")
	const scaled = acceptanceField("fixed0", "fixed")
	const task: Stored = {
		kind: "stored",
		name: "Task",
		fields: [payroll, amount, route, span, tick, scaled],
		primaryKey: [payroll],
		candidates: [[route]]
	}
	const zero = decimal("0")
	const one = decimal("1")
	const interval = canonicallySpelled({ kind: "span", start: 1n, end: 3n })
	const facts: ReadonlyArray<StoredFact> = [
		[
			canonicallySpelled({ kind: "handle", handle: "Green" }),
			twinSpelled(zero, "0.0"),
			canonicallySpelled({ kind: "handle", handle: "Green" }),
			interval,
			canonicallySpelled({ kind: "int", value: 0n }),
			canonicallySpelled(one)
		],
		[
			canonicallySpelled({ kind: "handle", handle: "Red" }),
			canonicallySpelled(zero),
			canonicallySpelled({ kind: "handle", handle: "Red" }),
			interval,
			canonicallySpelled({ kind: "int", value: 1n }),
			twinSpelled(one, "1.00")
		]
	]
	let vars = 0
	const mint = (field: ProgramField): Var => ({ id: vars++, field })
	const [v0, v1, v2, v3, v4] = [mint(amount), mint(route), mint(span), mint(tick), mint(scaled)]
	const p0: Param = {
		name: "p0_0",
		type: compareParamType(payroll.type),
		value: { kind: "handle", handle: "Green" },
		declaration: { kind: "base" }
	}
	const rootRule = soleRule<never>(
		task,
		[
			{ field: payroll, operand: { kind: "param", param: p0 } },
			varOf(amount, v0),
			varOf(route, v1),
			varOf(span, v2),
			varOf(tick, v3),
			varOf(scaled, v4)
		],
		[varHead("Select", v0), varHead("task2note", v1), varHead("HttpRoute", v2), varHead("User", v3)]
	)
	const rootHeading = headingOf(rootRule.head)
	const v5 = mint(scaled)
	const payrollRule = soleRule<ParentColumn>(
		task,
		[
			parentOf(payroll, columnNamed(rootHeading, "task2note")),
			parentOf(amount, columnNamed(rootHeading, "Select")),
			parentOf(route, columnNamed(rootHeading, "task2note")),
			parentOf(span, columnNamed(rootHeading, "HttpRoute")),
			parentOf(tick, columnNamed(rootHeading, "User")),
			varOf(scaled, v5)
		],
		[varHead("Limit", v5)]
	)
	const limit = columnNamed(headingOf(payrollRule.head), "Limit")
	const [v6, v7, v8, v9, v10] = [mint(payroll), mint(amount), mint(route), mint(span), mint(tick)]
	const [v11, v12, v13, v14, v15] = [
		mint(payroll),
		mint(amount),
		mint(route),
		mint(span),
		mint(tick)
	]
	const first = soleRule<ParentColumn>(
		task,
		[
			varOf(payroll, v6),
			varOf(amount, v7),
			varOf(route, v8),
			varOf(span, v9),
			varOf(tick, v10),
			parentOf(scaled, limit)
		],
		[
			varHead("Group", v6),
			varHead("note", v7),
			varHead("Task_2_Note", v8),
			varHead("column0", v9),
			{
				kind: "computed",
				name: "From",
				term: { kind: "cond", arg: v12, op: "ge", than: zero, otherwise: zero },
				type: amount.type
			}
		]
	)
	const noteRule: Rule<ParentColumn> = {
		...first,
		matches: [
			first.matches[0],
			{
				source: task,
				bindings: [
					varOf(payroll, v11),
					varOf(amount, v12),
					varOf(route, v13),
					varOf(span, v14),
					varOf(tick, v15),
					parentOf(scaled, limit)
				]
			}
		],
		allens: [{ left: v9, mask: AllenMask(1273), right: v14 }]
	}
	const note: Attachment = {
		name: "NOTE",
		child: setQuery(noteRule, []),
		delivery: { kind: "array" }
	}
	const payrollAttachment: Attachment = {
		name: "Payroll",
		child: setQuery(payrollRule, [note]),
		delivery: { kind: "option" }
	}
	const root: Root = {
		heading: rootHeading,
		arms: [rootRule],
		bound: { kind: "set" },
		stage: { kind: "named", name: "stage0" },
		attachments: [payrollAttachment],
		delivery: { kind: "set" }
	}
	return {
		schema: { relations: [task], roster: userRoster, nameKinds: new Set<NameKind>() },
		facts: new Map([[task.name, facts]]),
		perturbation: sketch.perturbation,
		ambient: sketch.ambient,
		restorage: sketch.restorage,
		reads: [{ kind: "query", query: root, params: [p0], relations: [], probe: { kind: "none" } }]
	}
}

/**
 * The second acceptance case: the mean over one numeric field holding 0 stored as 0.000000000000000000000000 and 0, 1
 * and 3, under its sketch's plan, session and restorage, whose second reading stores the facts in the other order.
 *
 *   relation Readings { id: int4, x: numeric } key [id]
 *   facts Readings: (0, 0 stored as "0.000000000000000000000000") (1, 0) (2, 1) (3, 3)
 *   q0 = Readings{id: v1, x: v0} find {m: r.mean(v0)}
 *
 * A fold reads keyed rows, so the rule binds the key: the mean reads each reading once, 0 twice, 1 and 3, PostgreSQL's
 * quotient of their sum by their count. A numeric field declares its scale, so the padded zero is stored as the other
 * is, and the mean's display scale is the same whichever spelling a writer gave either zero.
 */
const acceptanceMean = (sketch: CaseSketch): ProgramCase => {
	const id = acceptanceField("id", "int4")
	const x = acceptanceField("x", "numeric")
	const readings: Stored = {
		kind: "stored",
		name: "Readings",
		fields: [id, x],
		primaryKey: [id],
		candidates: []
	}
	const fact = (key: bigint, value: SpelledValue): StoredFact => [
		canonicallySpelled({ kind: "int", value: key }),
		value
	]
	const facts: ReadonlyArray<StoredFact> = [
		fact(0n, twinSpelled(decimal("0"), paddedText("0", 24))),
		fact(1n, canonicallySpelled(decimal("0"))),
		fact(2n, canonicallySpelled(decimal("1"))),
		fact(3n, canonicallySpelled(decimal("3")))
	]
	const v0: Var = { id: 0, field: x }
	const v1: Var = { id: 1, field: id }
	const rule = soleRule<never>(
		readings,
		[varOf(id, v1), varOf(x, v0)],
		[
			{
				kind: "fold",
				name: "m",
				fn: "mean",
				arg: { kind: "var", var: v0 },
				type: aggregateResult("avg", x.type)
			}
		]
	)
	return {
		schema: { relations: [readings], roster: userRoster, nameKinds: new Set<NameKind>() },
		facts: new Map([[readings.name, facts]]),
		perturbation: sketch.perturbation,
		ambient: sketch.ambient,
		restorage: sketch.restorage,
		reads: [query({ ...setQuery(rule, []), delivery: { kind: "set" } })]
	}
}

/**
 * A case of its population: the planted case, which draws nothing more; an acceptance case, which draws nothing either;
 * or one its swarm resolves, drawing the swarm's thinning and choices from the case's decisions.
 */
export const resolveCase = (sketch: CaseSketch): Gen<ProgramCase> => {
	switch (sketch.population) {
		case "planted":
			return constant(plantedCase(sketch))
		case "acceptance collapse":
			return constant(acceptanceCollapse(sketch))
		case "acceptance mean":
			return constant(acceptanceMean(sketch))
		case "swarm":
		case "delivered":
		case "spelled":
		case "forms":
			return drawnCase(sketch)
	}
}

/** A public-boundary case: its sketch drawn and resolved on the same decisions. */
export const caseGen: Gen<ProgramCase> = (decisions) =>
	decisions.draw(resolveCase(decisions.draw(caseSketchGen)))

const drawnCase =
	(sketch: CaseSketch): Gen<ProgramCase> =>
	(decisions) => {
		const swarm = sketch.swarm
		const dense = decisions.draw(keep(swarm, "dense"))
		const kinds = new Set<NameKind>()
		const names = new Names(kinds)
		const roster = resolveRoster(names, sketch.roster)
		const spanKind = upper(sketch.span) ? "span8" : "span4"
		const relations = Arr.map(sketch.relations, (r, i) =>
			resolveRelation(r, i, names, roster, swarm, decisions, spanKind)
		)
		const [first, ...rest] = relations
		if (first === undefined) {
			throw new Error("a case sketch with no relation")
		}
		const schema: ProgramSchema = { relations: [first, ...rest], roster, nameKinds: kinds }
		const spelling: FactSpelling = weightOf(swarm, "spelled") > 0 ? "drawn" : "canonical"
		const facts = new Map<string, ReadonlyArray<StoredFact>>()
		for (const [i, r] of schema.relations.entries()) {
			facts.set(
				r.name,
				resolveFacts(r, elementOf(sketch.relations, i, "a relation sketch").facts, dense, spelling)
			)
		}
		/** In order, so a read imports only an earlier one. */
		const reads: Array<ProgramRead> = []
		for (const [i, r] of sketch.reads.entries()) {
			if (decisions.draw(keep(swarm, "key read"))) {
				reads.push(
					weightOf(swarm, "roster") > 0 && upper(r.key.roster)
						? { kind: "handle", handle: pickFrom(schema.roster.handles, r.key.fact) }
						: resolveKeyRead(schema, facts, r.key, dense)
				)
				continue
			}
			const imports = Arr.flatMap(reads, (earlier, j) =>
				Option.toArray(Option.fromUndefinedOr(importOffer(earlier, j)))
			)
			const scope = new ReadScope(swarm, decisions, schema, dense, kinds, i, imports)
			/** A read below the last binds a parameter a later read's import may bind to its own variable. */
			const importable = i < sketch.reads.length - 1 && upper(r.importable) && scope.keep("import")
			const { root, relations: relationValues } = resolveRoot(scope, r, importable)
			const read = new Set(queryParams(root))
			const params = Arr.filter(scope.params, (p) => read.has(p))
			reads.push({
				kind: "query",
				query: root,
				params,
				relations: relationValues,
				probe: resolveProbe(scope, params, root, r.probe)
			})
		}
		const [firstRead, ...restReads] = reads
		if (firstRead === undefined) {
			throw new Error("a case sketch with no read")
		}
		return {
			schema,
			facts,
			perturbation: sketch.perturbation,
			ambient: sketch.ambient,
			restorage: sketch.restorage,
			reads: [firstRead, ...restReads]
		}
	}
