import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { EntryRole } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"

/** The list of a recursive definition an arm belongs to. */
export type RecursionArm = "base" | "rec"

/**
 * How an arm's column fails to convert exactly to its declared state column (check/recursion/state.ts conversion):
 * - `anotherType`: another identity: carrier, contract, closed roster or vector dimensions;
 * - `anotherTypmod`: another numeric typmod than the declared one: a typmod cast rounds;
 * - `unprovedRefinement`: a declared text refinement the arm does not already carry: only a checked narrowing would
 *   establish it.
 */
export type InexactConversion = "anotherType" | "anotherTypmod" | "unprovedRefinement"

type Names = ReadonlyArray<string>

/**
 * Why recursion admission refused a definition (check/recursion), at the arm or clause that causes it. These are the
 * causes of a RecursionRefused CompileError (core/errors.ts): each member names the rule that refused and the facts
 * the refusal states, and its text is the refusal's sentence. Every field holds a declared name, a type label or a
 * number the description states, never a parameter value.
 *
 * - `armHead`: an arm whose head is not exactly the declared row (scan.ts): `missing` and `extra`, not both empty.
 * - `armAttachment`: an attachment made on an arm (scan.ts).
 * - `baseSelf`: a self source in a base arm (scan.ts).
 * - `nestedSelf`: a self source inside a stage nested in an arm (scan.ts).
 * - `approximateSource`: an approximate stage below an arm (scan.ts).
 * - `nonlinearFeedback`: a recursive arm reading self `selfReads` times, at least two (scan.ts).
 * - `selfNegation`: r.not(self) in a recursive arm (scan.ts).
 * - `selfExistence`: an existence of self, which grizzle writes and no author does, in a recursive arm (scan.ts).
 * - `recursiveAggregation`: an aggregate, or r.pack, over self in a recursive arm (scan.ts).
 * - `recursiveStep`: a recursive arm that reads self and, at any depth of a source it matches or negates, the
 *   recursion `inner` (scan.ts).
 * - `unionStep`: a recursive arm that reads self and, at any depth of a source it matches or negates, a union of
 *   `rules` rules (scan.ts).
 * - `unhashableState`: a state column whose type has no hash operator class (state.ts).
 * - `stateHeading`: arms delivering another heading than the state (state.ts conform).
 * - `inexactConversion`: a state column an arm delivers at a type that converts inexactly to the declared one
 *   (state.ts conform).
 * - `unnamedOrigin`: a correlation column of an attached recursion that names no parent variable (origin.ts).
 * - `unboundedState`: a state column computed from its own component with no admitted bound (termination.ts).
 * - `carrierOverflow`: a counter whose next value, `from` + `delta`, leaves its carrier's range min..max before its
 *   bound is checked (termination.ts).
 */
export type RecursionRefusal =
	| {
			readonly kind: "armHead"
			readonly recursion: string
			readonly arm: RecursionArm
			readonly row: Names
			readonly missing: Names
			readonly extra: Names
	  }
	| {
			readonly kind: "armAttachment"
			readonly recursion: string
			readonly arm: RecursionArm
	  }
	| { readonly kind: "baseSelf"; readonly recursion: string }
	| { readonly kind: "nestedSelf"; readonly recursion: string }
	| { readonly kind: "approximateSource"; readonly recursion: string }
	| {
			readonly kind: "nonlinearFeedback"
			readonly recursion: string
			readonly selfReads: number
	  }
	| { readonly kind: "selfNegation"; readonly recursion: string }
	| { readonly kind: "selfExistence"; readonly recursion: string }
	| {
			readonly kind: "recursiveAggregation"
			readonly recursion: string
			readonly fold: "count" | "sum" | "mean" | "min" | "max" | "pack"
	  }
	| { readonly kind: "recursiveStep"; readonly recursion: string; readonly inner: string }
	| { readonly kind: "unionStep"; readonly recursion: string; readonly rules: number }
	| {
			readonly kind: "unhashableState"
			readonly recursion: string
			readonly column: string
			readonly type: string
	  }
	| {
			readonly kind: "stateHeading"
			readonly recursion: string
			readonly arm: RecursionArm
			readonly state: Names
			readonly heading: Names
	  }
	| {
			readonly kind: "inexactConversion"
			readonly recursion: string
			readonly arm: RecursionArm
			readonly column: string
			readonly delivered: string
			readonly declared: string
			readonly conversion: InexactConversion
	  }
	| {
			readonly kind: "unnamedOrigin"
			readonly recursion: string
			readonly column: string
	  }
	| {
			readonly kind: "unboundedState"
			readonly recursion: string
			readonly column: string
			readonly reads: Names
	  }
	| {
			readonly kind: "carrierOverflow"
			readonly recursion: string
			readonly column: string
			readonly type: string
			readonly from: bigint
			readonly delta: bigint
			readonly min: bigint
			readonly max: bigint
	  }

/**
 * Why a key has no representable index entry: a declared key's (schema/representability.ts keyLayout) or a derived
 * relation's inherited key's (analysis/derived/keys.ts derivedKeyLayout).
 *
 * - `columns`: more fields than PostgreSQL admits in one index, `limit` (INDEX_MAX_KEYS).
 * - `unboundedText`: a text field whose pattern proves no byte bound, the one datum with no bound.
 * - `undigestedText`: a lookup that binds such a text, `field`, by equality and binds no digest of it, so its index
 *   could only filter the text beside the columns it holds, reading every row they find (physical/indexes/engine.ts
 *   refusedUndigested): `digest` is the digest field the text's relation declares of it, none where it declares none.
 * - `storageOnly`: a bytes field, which is stored only, with no equality.
 * - `exactValue`: an exact field of any size, `type` (ir/desc.ts FieldDesc exact), numeric of no typmod at numeric's
 *   own limit, whose widest value no index entry holds: its fix is `precision`, the types of a declared precision that
 *   hold its values (schema/representability.ts exactKeyFault).
 * - `btreeEntry`: an entry that can reach `bytes` in some order of its columns, above the B-tree limit `limit`
 *   (BTMaxItemSize, schema/representability.ts btreeEntryBytes), and the bytes each of its columns' datums is counted at,
 *   in index order: a text's is the byte bound its pattern and contract prove.
 * - `orderedColumns`: a lookup's entry that can reach `bytes`, above the B-tree limit `limit`, past every equality it
 *   leaves out as a filter, for the varlenas it reads in their order or matches a prefix of, which only an index holding
 *   them serves and a byte bound or a precision shrinks: each with its role and the bytes its datum is counted at.
 * - `spans`: more than one span field, which no native lowering serves.
 * - `gistEntry`: a span key's GiST entry that can reach `bytes`, above the limit `limit` of a GiST page.
 * - `gistOperatorClass`: a span key's scalar field with no btree_gist operator class.
 * - `spanAlone`: a primary key that is the span `field` alone: a primary key WITHOUT OVERLAPS needs a scalar field
 *   beside its span, so only a candidate key can be that span alone.
 * - `foldAccumulator`: a fold whose running value, its `accumulator`, rides its family's axes as itself, where its
 *   widest value, a numeric of no precision or a text of no byte bound that fits, could carry the entry past the
 *   B-tree limit `limit` (`bytes`, none for a text of no bound): the fold is the author's declaration, so its fix is the
 *   `bound` the folded fields declare, a numeric's precision, or a text's byte bound of at most `largest`, the most
 *   bytes a text holds as itself beside the axes' other columns; or, for a text, its running values carried by their
 *   SHA-256 digests, generated fields over the fields `running` names, in their places in the fold (ir/family.ts
 *   FoldCarrier).
 */
export type KeyFault =
	| { readonly kind: "columns"; readonly limit: number }
	| { readonly kind: "unboundedText"; readonly field: string }
	| { readonly kind: "undigestedText"; readonly field: string; readonly digest: string | undefined }
	| { readonly kind: "storageOnly"; readonly field: string }
	| {
			readonly kind: "exactValue"
			readonly field: string
			readonly type: string
			readonly precision: string
	  }
	| {
			readonly kind: "btreeEntry"
			readonly bytes: number
			readonly limit: number
			readonly datums: ReadonlyArray<{ readonly field: string; readonly bytes: number }>
	  }
	| {
			readonly kind: "orderedColumns"
			readonly bytes: number
			readonly limit: number
			readonly columns: ReadonlyArray<{
				readonly field: string
				readonly role: Exclude<EntryRole, "equality">
				readonly bytes: number
			}>
	  }
	| { readonly kind: "spans"; readonly fields: Names }
	| { readonly kind: "gistEntry"; readonly bytes: number; readonly limit: number }
	| { readonly kind: "gistOperatorClass"; readonly field: string }
	| { readonly kind: "spanAlone"; readonly field: string }
	| {
			readonly kind: "foldAccumulator"
			readonly accumulator: string
			readonly bytes: number | undefined
			readonly limit: number
			readonly bound:
				| { readonly kind: "precision" }
				| {
						readonly kind: "byteBound"
						readonly largest: number
						readonly running: {
							readonly before: string
							readonly after: string
							readonly end: string
						}
				  }
	  }

/**
 * The conditions of unit-locality (analysis/theory/unit.ts), each a way a query's facts can leave one unit, which a
 * derived relation's definition must meet for the installation to store it (analysis/derived/storage.ts LiveReason
 * `notUnitLocal`):
 * - `inPlace`: it reads a field grizzle rewrites in place on an immutable relation's row it keeps, a fold's
 *   accumulator through its owner axis (ir/law.ts RelationInfo `inPlace`);
 * - `unitKey`: a relation it reads leads its primary key with no fields of the unit's types;
 * - `split`: a match binds a relation's unit fields to other variables than its rule's unit, or to none;
 * - `negation`: a negation, or an existence, is not correlated at the unit;
 * - `aggregate`: an aggregate's groups do not hold the unit;
 * - `recursion`: a recursion's seeds deliver no unit, or a step does not carry it from self into its head;
 * - `shape`: it orders, takes, attaches, approximates or nests a query, or reads a source no unit holds;
 * - `hidden`: its head does not deliver its unit, so its rows cannot be replaced by unit;
 * - `noUnit`: it reads no stored relation;
 * - `call`: it calls a declared function that is not immutable, or one whose body calls one that is not, or passes a
 *   call rows;
 * - `borrow`: a relation it reads sits in no declared unit, two sit in two, or the declared unit's key is wider than its
 *   own unit's, so no one exclusive borrow covers every write its rows follow;
 * - `reference`: it reads a relation of a sealed unit at a key no row of its own unit it matches reaches by a
 *   containment the schema states, so a later founding there could change its rows at a unit no write touched.
 */
export type UnitLocalityCondition =
	| "inPlace"
	| "unitKey"
	| "split"
	| "negation"
	| "aggregate"
	| "recursion"
	| "shape"
	| "hidden"
	| "noUnit"
	| "call"
	| "borrow"
	| "reference"

/**
 * Why a definition's delta form bounds no upkeep (analysis/theory/upkeep.ts deltaBoundOf), the first condition it lacks,
 * and where:
 *
 * - `arms`: the probes cannot read it as arms (analysis/theory/query.ts liveArms): it folds, recurses, attaches, orders
 *   or takes;
 * - `match`: an arm matches what no table holds, a definition of several rules or a fold's groups, read as a query;
 * - `negation`: an arm negates a query, which no probe of one relation's key reads;
 * - `unreached`: a rule is no outermost rule of it, an import's, or a read of a holder its head's variables reach by no
 *   key nor seek, an existence test of one occurrence at one index descent whose changed rows name their facts by keys
 *   (analysis/theory/unit.ts StepBy `seek`), so a fact lost cannot be checked at the fact by one probe of each;
 * - `loss`: a fact a write may withdraw leaves a field of its heading free (analysis/theory/query.ts lostFacts), and its
 *   arms negate, so a served write may withdraw it;
 * - `open`: its delta form unchecked, `unreached` or `loss`, its arms negating nothing, so a closed form would be
 *   monotone, but a relation it holds is open or stored, so a served write removes a row of it, whose facts its upkeep
 *   could find only across the unit (ledger's UnsettledSitting over its two stored imports).
 */
export interface UncheckedDelta {
	readonly reason: "arms" | "match" | "negation" | "unreached" | "loss" | "open"
	readonly detail: string
}

/** A condition of unit-locality a query lacks, and where: the first the walk met (analysis/theory/unit.ts). */
export interface UnitLocality {
	readonly condition: UnitLocalityCondition
	readonly detail: string
}

/**
 * A declaration a column's type names by its name that the schema holds none of: a contract or a variant, which a field
 * of the type holds as the schema declares it (schema/field-desc.ts declaredDescOf).
 */
export interface Undeclared {
	readonly kind: "domain" | "variant"
	readonly name: string
}

/**
 * Why derived analysis refused a derived relation (analysis/derived), the cause of a DerivedRefused CompileError
 * (core/errors.ts):
 * - `attachment`: the definition attaches a nested relation to its facts: a stored table holds flat facts.
 * - `undeclared`: a field whose type is a contract or a variant the schema declares nowhere.
 * - `inheritedKey`: an inherited key narrower than the heading whose unique index entry is unrepresentable.
 * - `wholeHeading`: the whole heading, the one key when no narrower key is proven, whose unique index entry is
 *   unrepresentable.
 * - `oneFact`: a definition of at most one fact none of whose fields is a representable one-column key; `fault` is
 *   the first field's.
 */
export type DerivedRefusal =
	| { readonly kind: "attachment"; readonly relation: string }
	| {
			readonly kind: "undeclared"
			readonly relation: string
			readonly field: string
			readonly declaration: Undeclared
	  }
	| {
			readonly kind: "inheritedKey"
			readonly relation: string
			readonly key: Names
			readonly fault: KeyFault
	  }
	| {
			readonly kind: "wholeHeading"
			readonly relation: string
			readonly key: Names
			readonly fault: KeyFault
	  }
	| {
			readonly kind: "oneFact"
			readonly relation: string
			readonly fields: readonly [string, ...Array<string>]
			readonly fault: KeyFault
	  }

/** Why a query entry listed in a role's `write` is not writable (schema/entry.ts writableEntry). */
export type WritabilityReason =
	| { readonly kind: "notOneArm" }
	| { readonly kind: "headNotBareVariable"; readonly field: string }
	| { readonly kind: "noSupplyingOccurrence"; readonly candidates: number }
	| { readonly kind: "headFieldsShareAField"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "fieldNotFixed"; readonly field: string }
	| { readonly kind: "bindingNotVariableOrLiteral"; readonly field: string }
	| { readonly kind: "filterReadsFamily"; readonly field: string }
	| { readonly kind: "keyHoldsFamily"; readonly field: string }
	| { readonly kind: "keyHoldsGeneration"; readonly field: string }

/** What a role relation a write list names is: an ordinary, closed or derived whole entry, or a query entry. */
export type EntryKind = "relation" | "closed" | "derived" | "query"

/**
 * A rule of a role a description breaks (schema/world.ts admitRole at the builder, schema/own.ts ownRole at
 * ownership), the rule of a RoleRefused CompileError. A whole entry's rules and a query entry's base, which the types
 * name too, are Refused (core/refusals.ts):
 * - `entryOrdered`: a query entry that is an Ordered, not a Query.
 * - `entryParameters`: a query entry that reads the parameters `parameters`.
 * - `entryOutsideBase`: a query entry that reads `relation`, which the base lacks.
 * - `entryAttaches`: a query entry that attaches a nested relation.
 * - `entryApproximate`: a query entry that searches approximately.
 * - `entryContext`: a query entry that matches `context`, which the role does not declare: a role's Db holds facts of
 *   its declared contexts alone.
 * - `writeOutside`: an insert or write list naming `name`, no relation of the role.
 * - `writeKind`: an insert or write list naming a closed or derived whole entry.
 * - `writeUnwritable`: an insert or write list naming a query entry the writable-entry analysis refuses, for `why`.
 * - `writeTwice`: two written entries, `entries`, that both write the base relation `relation`, in one list or across
 *   the two, so each relation is written under one mode; the two by name in code point order, as a role's writes are
 *   checked (ir/desc.ts writtenNames).
 * - `writeClosed`: a write list naming `entry`, which writes `relation`, a closed relation: its facts are inserted,
 *   never changed or deleted, so a role names it under `insert`, where it holds no DELETE or UPDATE.
 */
export type RoleRule =
	| { readonly kind: "entryOrdered"; readonly entry: string }
	| { readonly kind: "entryParameters"; readonly entry: string; readonly parameters: Names }
	| { readonly kind: "entryOutsideBase"; readonly entry: string; readonly relation: string }
	| { readonly kind: "entryAttaches"; readonly entry: string }
	| { readonly kind: "entryApproximate"; readonly entry: string }
	| { readonly kind: "entryContext"; readonly entry: string; readonly context: string }
	| { readonly kind: "writeOutside"; readonly name: string }
	| { readonly kind: "writeKind"; readonly name: string; readonly entryKind: "closed" | "derived" }
	| { readonly kind: "writeUnwritable"; readonly entry: string; readonly why: WritabilityReason }
	| {
			readonly kind: "writeTwice"
			readonly relation: string
			readonly entries: readonly [string, string]
	  }
	| { readonly kind: "writeClosed"; readonly entry: string; readonly relation: string }

/**
 * A rule of a login a description breaks (schema/world.ts loginBuilder at the builder, schema/own.ts ownLogin at
 * ownership), the rule of a LoginRefused CompileError:
 * - `roleBase`: a role over another base than the login's `base`.
 * - `roleName`: a role named as its login.
 * - `roleTwice`: a role already in the login `login`.
 * - `workloadOver`: a workload over `schema`, which is neither the login's `base`, nor a level of it, nor one of its
 *   roles (program/workload/login.ts).
 * - `programTwice`: two programs named `program` across the login's workloads, which a Db reaches by name.
 */
export type LoginRule =
	| { readonly kind: "roleBase"; readonly role: string; readonly base: string }
	| { readonly kind: "roleName"; readonly role: string }
	| { readonly kind: "roleTwice"; readonly role: string; readonly login: string }
	| { readonly kind: "workloadOver"; readonly schema: string; readonly base: string }
	| { readonly kind: "programTwice"; readonly program: string }

/**
 * A rule of a role's scope a description breaks (schema/scope.ts ownerOf, schema/own.ts ownRole), the rule of a
 * ScopeRefused CompileError:
 * - `owner`: an owner that is no query reading the role's contexts and, from them, ordinary relations down an index,
 *   for `why`: `heading`, no rules stage of one head, the same fields in every arm, each a variable; `source`, a match of
 *   something but a context or an ordinary relation, a term but a variable or a literal, a filter reading a relation, or
 *   an interior or an attachment; `noContext`, an arm reading no context; `undetermined`, a relation read at no key
 *   prefix the contexts and the rows before it bind, or a head variable they do not bind.
 * - `unit`: an owner whose head `fields` is no unit's heading: an owner names keys of one unit.
 * - `unitType`: an owner whose head field `field` is bound at another type than unit `unit` keys it by.
 * - `twice`: two owners of unit `unit`: a role's claims bind a unit by one owner, whose arms are its every way.
 */
export type ScopeRule =
	| {
			readonly kind: "owner"
			readonly why: "heading" | "source" | "noContext" | "undetermined"
	  }
	| { readonly kind: "unit"; readonly fields: Names }
	| { readonly kind: "unitType"; readonly unit: string; readonly field: string }
	| { readonly kind: "twice"; readonly unit: string }

/**
 * A rule of a context's claims a description breaks (schema/world.ts contextBuilder), the rule of a ContextRefused
 * CompileError: `claimType`, a field whose descriptor is no claim type: text, uuid, boolean, an integer type, a
 * contract over one, or a closed handle.
 */
export type ClaimRule = { readonly kind: "claimType"; readonly field: string }

const list = (names: ReadonlyArray<string>): string => names.join(", ")

const conversionText = (conversion: InexactConversion, declared: string): string => {
	switch (conversion) {
		case "anotherType":
			return `another type than the declared ${declared}`
		case "anotherTypmod":
			return `another numeric typmod than the declared ${declared}, and a typmod cast rounds`
		case "unprovedRefinement":
			return `text not known to match the declared ${declared}, which only a checked narrowing would establish`
	}
}

/** A recursion refusal's capability. */
export const recursionRefusalText = (cause: RecursionRefusal): string => {
	switch (cause.kind) {
		case "armHead": {
			const parts = [
				...(cause.missing.length > 0 ? [`it does not deliver ${list(cause.missing)}`] : []),
				...(cause.extra.length > 0
					? [`it delivers ${list(cause.extra)}, which the row does not declare`]
					: [])
			]
			return `recursion: a ${cause.arm} arm of ${cause.recursion} whose head is exactly the declared state (${list(cause.row)}); ${parts.join(" and ")}, and a recursion is never a union of different headings because feedback identity is the complete state tuple`
		}
		case "armAttachment":
			return `recursion: an attachment on a ${cause.arm} arm of ${cause.recursion}: an attachment is no part of the state the fixed point deduplicates; attach to the completed recursion instead`
		case "baseSelf":
			return `recursion: a self source in a base arm of ${cause.recursion}; the base is nonrecursive, and self is a source only of the definition's recursive arms`
		case "nestedSelf":
			return `recursion: a self source of ${cause.recursion} inside a stage nested in its arm; self is a source only of its own definition's recursive arms, so feedback never flows through another relation, and mutual recursion is not admitted`
		case "approximateSource":
			return `recursion: approximate source feeding ${cause.recursion}: approximate candidates are not a complete relation, and they never enter recursive feedback`
		case "nonlinearFeedback":
			return `recursion: nonlinear feedback: a recursive arm of ${cause.recursion} reads self ${cause.selfReads} times; PostgreSQL's recursive term admits one self-reference, and a nonlinear self-join has no admitted transformation into one`
		case "selfNegation":
			return `recursion: negation of the current relation: r.not(self) in a recursive arm of ${cause.recursion} is not monotone in the feedback; negate a fixed external relation or an earlier completed recursion instead`
		case "selfExistence":
			return `recursion: an existence of the current relation in a recursive arm of ${cause.recursion}: a recursive arm reads self through its one match, and PostgreSQL admits no recursive reference inside a subquery expression`
		case "recursiveAggregation":
			return `recursion: recursive aggregation: ${cause.fold === "pack" ? "r.pack" : cause.fold} over self in a recursive arm of ${cause.recursion} would fold one working-table batch, not the fixed point; precompute independent aggregates before feedback or aggregate the completed recursion afterward`
		case "recursiveStep":
			return `recursion: a recursive arm of ${cause.recursion} reads the recursion ${cause.inner}, which PostgreSQL computes once as a relation with no index, so the step would read all of it for every row it extends; carry ${cause.inner}'s state as columns of ${cause.recursion}'s own walk`
		case "unionStep":
			return `recursion: a recursive arm of ${cause.recursion} reads a union of ${cause.rules} rules, which PostgreSQL deduplicates before any join reaches it, so the step would read every rule whole for every row it extends; match each rule's relations in a recursive arm of its own`
		case "unhashableState":
			return `hashing: ${cause.type} state column ${cause.column} of recursive relation ${cause.recursion} has no hash operator class, and PostgreSQL deduplicates a recursive UNION only by hashing`
		case "stateHeading":
			return `recursion: ${cause.arm} arms of ${cause.recursion} delivering exactly the state (${list(cause.state)}), not (${list(cause.heading)})`
		case "inexactConversion":
			return `recursion: state column ${cause.column} of ${cause.recursion} delivered by its ${cause.arm} arm${cause.arm === "base" ? "s" : ""} as ${cause.delivered}, ${conversionText(cause.conversion, cause.declared)}; cast it to the declared representation with Type.cast, since a recursive column is never widened silently`
		case "unnamedOrigin":
			return `recursion: the attachment correlation column ${cause.column} of ${cause.recursion} names no parent variable its arms read, so the recursive arms cannot carry it in the state`
		case "unboundedState":
			return `recursion: unbounded computed state: state column ${cause.column} of ${cause.recursion} is computed from the current ${list(cause.reads)} with no admitted bound, so it can take a new value on every iteration however finite the graph is; keep the state to carrier values, or advance an integer counter by a literal step under a filter bounding its current value, such as r.lt(${cause.column}, n)`
		case "carrierOverflow":
			return `recursion: carrier overflow: state column ${cause.column} of ${cause.recursion} advances by ${cause.delta} from ${cause.from}, which the bound admits, to ${cause.from + cause.delta}, outside ${cause.type}'s range ${cause.min}..${cause.max}; the next value may not overflow before its bound is checked`
	}
}

/**
 * The fix a key past its index entry takes (docs/limits.md "Keys and indexes"): grizzle never holds a key's column by a digest of
 * its own, so the author bounds the field or keys by a digest the schema declares.
 */
const keyFix =
	"declare a byte bound (str.bytes(n)) or a precision, or key by an explicit digest field you declare (e.g. a generated Crypto.sha256(x))"

/** A foldAccumulator refusal's fix: the bound its folded fields declare, or, for a text, its digests' carriage. */
const foldBoundText = (
	bound: Extract<KeyFault, { readonly kind: "foldAccumulator" }>["bound"]
): string => {
	switch (bound.kind) {
		case "precision":
			return "declare its precision, numeric(p, s), on the fields the fold steps and ends in"
		case "byteBound": {
			const { before, after, end } = bound.running
			return `declare a byte bound of at most ${bound.largest} bytes, the most a text holds as itself beside the axes' other columns, str.bytes(${bound.largest}), on the fields the fold steps and ends in; or carry its running values by their SHA-256 digests: declare generated fields Crypto.sha256(row.${before}), Crypto.sha256(row.${after}) and Crypto.sha256(row.${end}), and name them in the fold where ${before}, ${after} and ${end} stand`
		}
	}
}

/**
 * A key fault's text after the key's name: the one text of each fault, a declared key's and an inherited one's alike,
 * an entry past its bound naming the fix (`keyFix`).
 */
export const keyFaultText = (name: string, key: ReadonlyArray<string>, fault: KeyFault): string => {
	switch (fault.kind) {
		case "columns":
			return `${name}: it has ${key.length} fields, above PostgreSQL's limit of ${fault.limit} columns in one index (INDEX_MAX_KEYS)`
		case "unboundedText":
			return `${name}: field ${fault.field} is text whose pattern proves no byte bound, which no B-tree entry holds; ${keyFix}`
		case "undigestedText":
			return fault.digest === undefined
				? `${name}: field ${fault.field} is text whose pattern proves no byte bound, which no B-tree entry holds, and the read binds it by equality, so no index finds its rows by it; declare a byte bound (str.bytes(n)), or a digest of it, a generated Crypto.sha256(row.${fault.field}) field, which every read that binds ${fault.field} by equality seeks by, rechecking ${fault.field} on the rows of its digest`
				: `${name}: field ${fault.field} is text whose pattern proves no byte bound, which no B-tree entry holds, and the read binds it by equality but not its digest ${fault.digest}: grizzle states ${fault.digest}'s equality wherever a rule equates ${fault.field} with a value, a constant, a parameter, another match's column, a term of its other values or a negation's correlation, carried by lineage through every query whose head copies ${fault.field}, and this read reaches ${fault.field} where no such equality stands: through a head that computes the text rather than copying it, a union an arm of which delivers another text, or an attachment's correlation with its parent; deliver ${fault.field} as its relation stores it, or declare a byte bound (str.bytes(n))`

		case "storageOnly":
			return `${name}: field ${fault.field} is bytea, which is stored only, with no equality, so no key or index holds it`
		case "exactValue":
			return `${name}: field ${fault.field} is ${fault.type} of any size, up to numeric's own limit, whose widest value no index entry holds; declare its precision: ${fault.precision}`
		case "btreeEntry":
			return `${name}: its B-tree entry can reach ${fault.bytes} bytes in some order of its columns, above PostgreSQL's ${fault.limit}-byte limit (${fault.datums.map((d) => `${d.field} ${d.bytes} bytes`).join(", ")}); ${keyFix}`
		case "orderedColumns":
			return `${name}: its B-tree entry can reach ${fault.bytes} bytes, above PostgreSQL's ${fault.limit}-byte limit, past every equality it leaves out as a filter, for the columns it reads in their order or matches a prefix of (${fault.columns.map((c) => `${c.field} ${c.bytes} bytes, ${c.role === "order" ? "read in its order" : "a prefix matched"}`).join("; ")}); a byte bound (str.bytes(n)) or a precision on them that fits the entry admits it`
		case "spans":
			return `${name}: a key with more than one range field (${fault.fields.join(", ")}) has no native lowering`
		case "gistEntry":
			return `${name}: its GiST entry can reach ${fault.bytes} bytes, above the ${fault.limit}-byte limit of a GiST page`
		case "gistOperatorClass":
			return `${name}: field ${fault.field} has no btree_gist operator class`
		case "spanAlone":
			return `${name}: it is the range ${fault.field} alone, which a primary key WITHOUT OVERLAPS never is; only a candidate key can be`
		case "foldAccumulator":
			return `${name}: its running value ${fault.accumulator} rides the family's axes as itself, and ${fault.bytes === undefined ? "a text of no byte bound" : `its widest value, ${fault.bytes} bytes with the axes' other columns,`} could pass PostgreSQL's ${fault.limit}-byte B-tree limit there; ${foldBoundText(fault.bound)}`
	}
}

/** A derived refusal's capability. */
export const derivedRefusalText = (cause: DerivedRefusal): string => {
	switch (cause.kind) {
		case "attachment":
			return `derived relation ${cause.relation} over a definition that attaches a nested relation to its facts: a stored table holds flat facts`
		case "undeclared":
			return `a ${cause.declaration.kind} the schema declares; ${cause.declaration.name} is none`
		case "inheritedKey":
			return keyFaultText(
				`inherited key (${list(cause.key)}) of derived relation ${cause.relation}`,
				cause.key,
				cause.fault
			)
		case "wholeHeading":
			return keyFaultText(
				`the whole heading (${list(cause.key)}) of derived relation ${cause.relation}, which proves no narrower key`,
				cause.key,
				cause.fault
			)
		case "oneFact": {
			const [first] = cause.fields
			return `derived relation ${cause.relation} holds at most one fact, so any one of its fields (${list(cause.fields)}) is a key, but none has a representable unique index entry: ${keyFaultText(`inherited key (${first}) of derived relation ${cause.relation}`, [first], cause.fault)}`
		}
	}
}

/** A refused write entry's reason in words. */
const unwritableText = (reason: WritabilityReason): string => {
	switch (reason.kind) {
		case "notOneArm":
			return "its definition is not one arm of one rule"
		case "headNotBareVariable":
			return `its head field ${reason.field} is not a bare variable`
		case "noSupplyingOccurrence":
			return reason.candidates === 0
				? "no occurrence of an ordinary relation supplies every head field"
				: `${reason.candidates} occurrences of ordinary relations supply its head fields, not exactly one`
		case "headFieldsShareAField":
			return `its head fields ${reason.fields.join(", ")} share one field of the written relation`
		case "fieldNotFixed":
			return `the written relation's field ${reason.field} is neither in the head nor fixed to a literal or a context field`
		case "bindingNotVariableOrLiteral":
			return `the written relation's field ${reason.field} is bound to neither a variable nor a literal`
		case "keyHoldsFamily":
			return `a key of the written relation holds its field ${reason.field}, which its family draws: no fact through the entry states it, so no write names or probes that key`
		case "keyHoldsGeneration":
			return `the written relation's primary key holds its key generation ${reason.field}, which grizzle writes from its reads: a fact through the entry would state it, so this cut writes such a relation whole, never through an entry`
		case "filterReadsFamily":
			return `its filter reads the written relation's field ${reason.field}, which its family draws: the owner's membership would move with member writes no write through the entry states, and no policy can judge the owner at its insert`
	}
}

const entryKindText: Readonly<Record<EntryKind, string>> = {
	relation: "an ordinary relation",
	closed: "a closed relation",
	derived: "a derived relation",
	query: "a query entry"
}

/** A role rule's sentence. */
export const roleRuleText = (rule: RoleRule): string => {
	switch (rule.kind) {
		case "entryOrdered":
			return `a query entry that is a Query, not an Ordered: take closes an order into a set; ${rule.entry} is an Ordered`
		case "entryParameters":
			return `a query entry that reads no parameter; ${rule.entry} reads ${list(rule.parameters)}`
		case "entryOutsideBase":
			return `a query entry over the base; ${rule.entry} reads ${rule.relation}, which the base lacks`
		case "entryAttaches":
			return `a query entry of one flat heading; ${rule.entry} attaches`
		case "entryApproximate":
			return `a query entry that searches nothing approximately; ${rule.entry} does`
		case "entryContext":
			return `a query entry matching only the contexts the role declares; ${rule.entry} matches ${rule.context}, which it does not declare`
		case "writeOutside":
			return `insert and write lists of the role's relations; ${rule.name} is none of them`
		case "writeKind":
			return `insert and write lists of ordinary relations and query entries; ${rule.name} is ${entryKindText[rule.entryKind]}`
		case "writeUnwritable":
			return `a writable query entry ${rule.entry}; ${unwritableText(rule.why)}`
		case "writeTwice":
			return `one writable entry per base relation; ${rule.entries[0]} and ${rule.entries[1]} both write ${rule.relation}`
		case "writeClosed":
			return `a write list of open relations, each declared mutable inside a unit; ${rule.entry === rule.relation ? rule.relation : `${rule.entry} writes ${rule.relation}, which`} is closed, its facts inserted and never changed or deleted: name it under insert`
	}
}

/** A login rule's sentence. */
export const loginRuleText = (rule: LoginRule): string => {
	switch (rule.kind) {
		case "roleBase":
			return `roles over the login's base ${rule.base}; ${rule.role} is not`
		case "roleName":
			return `a role named apart from its login; ${rule.role} is not`
		case "roleTwice":
			return `a role in exactly one login; ${rule.role} is in login ${rule.login}`
		case "workloadOver":
			return `a workload over the login's base ${rule.base}, a level of it, or one of its roles; one is over ${rule.schema}`
		case "programTwice":
			return `programs of distinct names across the login's workloads; two are named ${rule.program}`
	}
}

/**
 * Why a generated field's expression is refused: it reads generated field `read` (itself among them), which no
 * generation expression reads, as PostgreSQL's never does; it reads an input beyond its own row, `input` the description
 * kind of the first in expression order; its type `expression` is not the field's declared `declared` (each a type
 * label) but for what the column's domain checks, with no implicit cast, or shares no value with it (`disjoint`); or it is
 * stable, which PostgreSQL never stores (`stable`).
 */
export type GeneratedRule =
	| { readonly kind: "readsGenerated"; readonly read: string }
	| {
			readonly kind: "notRowLocal"
			readonly input: "var" | "param" | "parent" | "value" | "absent" | "exists" | "call"
	  }
	| { readonly kind: "type"; readonly declared: string; readonly expression: string }
	| { readonly kind: "disjoint"; readonly declared: string; readonly expression: string }
	| { readonly kind: "stable" }
	| {
			readonly kind: "keyReadsUnwritten"
			readonly read: string
			readonly writing: "drawn" | "accumulated" | "place" | "instant"
	  }

/** What each input beyond a row is, in a generated field's refusal. */
const rowInputWords: {
	readonly [I in Extract<GeneratedRule, { readonly kind: "notRowLocal" }>["input"]]: string
} = {
	var: "a query variable",
	param: "a parameter",
	parent: "a parent column",
	value: "a domain's value",
	absent: "a relational negation",
	exists: "a relational existence",
	call: "a declared function's call, which PostgreSQL alone evaluates"
}

/** A generated field rule's sentence. */
export const generatedRuleText = (rule: GeneratedRule): string => {
	switch (rule.kind) {
		case "readsGenerated":
			return `reads ${rule.read}, a generated field; a generation expression reads its row's other fields, never a generated one`
		case "notRowLocal":
			return `reads ${rowInputWords[rule.input]}; a generation expression reads its own row and closed relations only`
		case "type":
			return `its expression is ${rule.expression}, not its declared ${rule.declared}: a generation expression is of its column's type, but for the pattern and byte bound its column's domain checks, with no implicit cast`
		case "disjoint":
			return `its expression is ${rule.expression}, of which no value is its declared ${rule.declared}: its column's domain would refuse every row, so none could ever be written`
		case "stable":
			return "its expression is stable, reading a setting of its session, as a conversion to money reads lc_monetary; PostgreSQL stores a generated column only by an immutable expression"
		case "keyReadsUnwritten":
			return `is in its relation's primary key and reads ${rule.read}, a ${rule.writing} field; a key generation reads its row's caller fields alone, the heads a put, a delete or a get states its key by`
	}
}

/**
 * Why an instant is refused (ir/instant.ts): a clock, an instant no containment carries, outside its relation's primary
 * key, where no child orders it (`clockOutsideKey`), or first in it, its child no field (`childless`); an insert that
 * stamps a clock at a child holding an instant `stamped` it also stamps (`childStamped`); a write that adds rows states a clock, which the database's clock
 * alone stamps (`clockStated`); a put or a delete leaves an instant of its rows out, which only an insert stamps, where it
 * states every instant from a stored one, a term of instant's type (`unstated`); an insert leaves out a reference that no one clock stamps (`unstampable`), or one
 * whose clock `clock` its statement does not stamp (`clockUnstamped`); or one call would stamp the clock `clock` in more
 * than one statement, each reading its own head, in two strata or in a stratum of several statements (`stampedApart`);
 * or a migration adds a clock to a table that holds rows under a primary key, `key`, that does not hold the old one,
 * `held`, beside the clock, so the one instant every stored row takes would not keep them apart (`addedOverRows`).
 */
export type InstantRule =
	| { readonly kind: "clockOutsideKey" }
	| { readonly kind: "childless" }
	| { readonly kind: "childStamped"; readonly stamped: string }
	| { readonly kind: "clockStated"; readonly op: "insert" | "put" }
	| { readonly kind: "unstated"; readonly op: "put" | "delete" }
	| { readonly kind: "unstampable" }
	| { readonly kind: "clockUnstamped"; readonly clock: string }
	| {
			readonly kind: "stampedApart"
			readonly clock: string
			readonly apart: "strata" | "statements"
	  }
	| {
			readonly kind: "addedOverRows"
			readonly key: NonEmptyReadonlyArray<string>
			readonly held: NonEmptyReadonlyArray<string>
	  }

/**
 * Why a place is refused (ir/instant.ts PlaceHead): as the schema declares it, outside its relation's primary key
 * (`outsideKey`), first in it, its group no field (`groupless`), or before another of its fields (`notLast`); ordered by
 * a field, no field of its relation (`byUnknown`) or the place itself (`byItself`), or no key of its relation within its
 * group and that field, `key` the one that would order each group's stored rows (`byUnkeyed`). As a write writes it: a
 * put or a delete writes its relation's rows (`written`); its group holds a field the same insert stamps, `stamped`
 * (`groupStamped`); or one call would stamp it in more than one statement, each reading its own head, in two strata or
 * in a stratum of several statements (`stampedApart`). As a migration adds it to a table holding rows, unordered, where
 * the new primary key `key` does not hold the old one, `held`, so 0 on every stored row would meet at it
 * (`addedOverRows`).
 */
export type PlaceRule =
	| { readonly kind: "outsideKey" }
	| { readonly kind: "groupless" }
	| { readonly kind: "notLast" }
	| { readonly kind: "byUnknown"; readonly by: string }
	| { readonly kind: "byItself" }
	| { readonly kind: "byUnkeyed"; readonly key: NonEmptyReadonlyArray<string> }
	| { readonly kind: "written"; readonly op: "put" | "delete" }
	| { readonly kind: "groupStamped"; readonly stamped: string }
	| { readonly kind: "stampedApart"; readonly apart: "strata" | "statements" }
	| {
			readonly kind: "addedOverRows"
			readonly key: NonEmptyReadonlyArray<string>
			readonly held: NonEmptyReadonlyArray<string>
	  }

/** When a stratum is one statement, as the refusal of a stamp its statements would read apart says
 * (write/schedule/plan.ts realizationOf). */
const oneStatement =
	"a stratum is one statement only where each table it writes takes one operation of one statement and none is written through a query entry, so write a put or a delete of a table it inserts, and any write of statements of its own, in another stratum (ChangeSet.sequence)"

/** A place rule's sentence. */
export const placeRuleText = (rule: PlaceRule): string => {
	switch (rule.kind) {
		case "outsideKey":
			return "a place stands last in its relation's primary key, whose fields before it are the group it numbers"
		case "groupless":
			return "a place stands in its relation's primary key after its group, at least one field: a place first in its key would number every row of its relation as one group, which every writer meets"
		case "notLast":
			return "a place stands last in its relation's primary key, so the key is its group and its place, one row at each place"
		case "byUnknown":
			return `a place.by(field) names a field of its relation, the one that orders the rows a migration that adds the place finds stored, and its relation has no field ${rule.by}`
		case "byItself":
			return "a place.by(field) names another field of its relation, the one that orders the rows a migration that adds the place finds stored"
		case "byUnkeyed":
			return `a place.by(field)'s group and field hold a key of its relation, so a migration that adds the place orders each group's stored rows totally, and none is within (${rule.key.join(", ")}): declare that key, or declare the place unordered`
		case "written":
			return `a place's relation is written by inserts alone, which keep each group's places gapless from 0, and ${rule.op === "put" ? "a put would state a place" : "a delete would leave a gap"}: write the relation by insert`
		case "groupStamped":
			return `a place's group is stated, never stamped by the same insert, and ${rule.stamped} is: state it from a stored value, or stamp it in an earlier stratum`
		case "stampedApart":
			return `one call stamps a place in one statement, whose every row in a group shares one place, and this one would stamp it ${rule.apart === "strata" ? "in two strata: stamp it in one stratum" : `in a stratum of several statements: ${oneStatement}`}`
		case "addedOverRows":
			return `an unordered place a migration adds to a table that holds rows is 0 on every stored row, which keeps them apart at the new primary key only where it holds the old one, and (${rule.key.join(", ")}) does not hold (${rule.held.join(", ")}): declare it place.by(field), a field that orders each group's stored rows, or add it under the old key's fields`
	}
}

/** An instant rule's sentence. */
export const instantRuleText = (rule: InstantRule): string => {
	switch (rule.kind) {
		case "clockOutsideKey":
			return "a clock, an instant no containment carries into another relation's, stands in its relation's primary key, whose fields before it are the child it orders"
		case "childless":
			return "a clock stands in its relation's primary key after its child, at least one field: an instant first in its key would order every row of its relation as one child, which every writer meets and no shard splits"
		case "childStamped":
			return `a clock's child is stated, never stamped by the same insert, and ${rule.stamped} is: state it from a stored instant, or stamp it in an earlier stratum`
		case "clockStated":
			return `a clock is stamped by the database's clock alone, and ${rule.op === "insert" ? "an insert" : "a put"} states it: leave it out of the insert's rows, which stamps it`
		case "unstated":
			return `${rule.op === "put" ? "a put" : "a delete"} states every instant of its rows from a stored instant, which only a query's term of an instant field holds, never a row a caller passes: write it from a query`
		case "unstampable":
			return "a reference an insert leaves out is stamped by the one clock its containments reach, at a child they carry its row to, and this one's reach none, or two: state it from a stored instant"
		case "clockUnstamped":
			return `a reference an insert leaves out takes the instant its statement stamps ${rule.clock} with, and no insert of that stratum stamps ${rule.clock}: insert it in the same stratum, or state the reference from a stored instant`
		case "stampedApart":
			return `one call stamps ${rule.clock} in one statement, whose every row at a child shares one instant, and this one would stamp it ${rule.apart === "strata" ? "in two strata: stamp it in one stratum, and read it back as a stored instant after" : `in a stratum of several statements: ${oneStatement}, and read the stamp back there as a stored instant`}`
		case "addedOverRows":
			return `a clock a migration adds to a table that holds rows takes the migration's one instant on every stored row, which keeps them apart at the new primary key only where it holds the old one beside the clock, and (${rule.key.join(", ")}) does not hold (${rule.held.join(", ")}): add the clock under the old key's fields, or re-key the table in a migration of its own`
	}
}

/** Why an owner is refused, in a scope rule's sentence. */
const ownerBreakText: {
	readonly [W in Extract<ScopeRule, { readonly kind: "owner" }>["why"]]: string
} = {
	heading: "its rules find no one head, the same fields in every arm, each by a variable",
	source:
		"it matches something but a context or an ordinary relation, binds a term but a variable or a literal, filters by a relation, or nests an interior or an attachment",
	noContext: "an arm of it reads no context",
	undetermined:
		"it reads a relation at no key prefix the contexts and the rows before it bind, or finds a value they do not bind"
}

/** A scope rule's sentence. */
export const scopeRuleText = (rule: ScopeRule): string => {
	switch (rule.kind) {
		case "owner":
			return `an owner read from the role's contexts and, from them, down an index; ${ownerBreakText[rule.why]}`
		case "unit":
			return `an owner whose head is a unit's heading, the keys it names; (${rule.fields.join(", ")}) is no unit's`
		case "unitType":
			return `an owner whose head holds unit ${rule.unit}'s keys; its field ${rule.field} is bound at another type than ${rule.unit} keys by`
		case "twice":
			return `one owner of each unit the role's claims bind, its arms every way they bind it; unit ${rule.unit} has two`
	}
}

/** A claim rule's sentence. */
export const claimRuleText = (rule: ClaimRule): string =>
	`a claim of text, uuid, bool, int2, int4 or int8, a domain over one, or a closed handle; field ${rule.field} is none`

/** A family as a refusal names it: its owner and its count, fin(owner, count). */
export interface FamilyName {
	readonly owner: string
	readonly count: string
}

/** fin(O, n), as a refusal spells a family. */
const familyNameText = (f: FamilyName): string => `${f.owner}.${f.count}`

/**
 * Where an UnfillableField's column reads its source: along a family's owner axis (its owner's column), its predecessor
 * axis (the member before it), its last axis (its owner's last member's), or its own row (a fold's step value or
 * selection, or a generated field it reads).
 */
export type FillAxis = "owner" | "predecessor" | "last" | "row"

/**
 * Why a column's source is filled only after the column, so no write can fill the column (ir/fill.ts):
 * - `afterMembers`: its owner fills the source only after its members: a fold's end, a copy along a last axis, or a
 *   column read from one;
 * - `countedFill`: the counted family `family` fills the source on its own, after the nested write that writes the row
 *   and apart from every other family, so only that family's own members and ends may read it;
 * - `cycle`: the source reads the column back through its row's own columns, so no order fills either;
 * - `unreached`: no fill that writes the column writes the source: a column of another family the row belongs to;
 * - `stamped`: the write's statement stamps the source, as it writes the row, after the host fills the column: a place
 *   or a clock its insert leaves out, a member's field its group carries from one, or a generated field over one, which
 *   no row the host fills holds.
 */
export type FilledLater =
	| { readonly kind: "afterMembers" }
	| { readonly kind: "countedFill"; readonly family: FamilyName }
	| { readonly kind: "cycle" }
	| { readonly kind: "unreached" }
	| { readonly kind: "stamped" }

/** Why a column's source is filled after it, as its refusal's clause. */
const filledLaterText = (later: FilledLater): string => {
	switch (later.kind) {
		case "afterMembers":
			return "a column its owner fills only after its members, a fold's end, a copy along a last axis or one read from them: copy a column the owner fills before its members"
		case "countedFill":
			return `a column the counted family ${familyNameText(later.family)} fills on its own, after the nested write and apart from every other family's fill: read it only from that family's own members and ends`
		case "cycle":
			return "a column that reads it back through the row's own columns, so no order fills either"
		case "unreached":
			return "a column no fill that writes it reaches, another family's: read a column of this family or of the row's caller"
		case "stamped":
			return "a column the write's statement stamps as it writes the row, after the host fills this one, which no row the host fills holds: read a column the caller states, or write the row from a stored one"
	}
}

/** An UnfillableField's sentence: the column, the source it reads along its axis of its family, and why it is later. */
export const unfillableText = (fill: {
	readonly relation: string
	readonly field: string
	readonly law: LawId
	readonly axis: FillAxis
	readonly family: FamilyName
	readonly source: { readonly relation: string; readonly column: string }
	readonly later: FilledLater
}): string =>
	`${fill.relation}.${fill.field}, filled by law ${fill.law}, reads ${fill.source.relation}'s ${fill.source.column} ${fill.axis === "row" ? "on its own row" : `along the ${fill.axis} axis`} of ${familyNameText(fill.family)}, ${filledLaterText(fill.later)}`

/**
 * Why no write fills a relation's rows, or removes them whole (analysis/theory/fill.ts):
 * - `nestingCycle`: the sequences `families` nest each other in a cycle, an ordered family over its own relation among
 *   them, so every row of the cycle is nested under another and none is written first;
 * - `unitCycle`: the families `families`, ordered or counted, nest relations in a cycle below `root`, a relation that
 *   owns a family and is no family's member, whose delete removes every row nested under its rows through every family:
 *   a row the cycle nests may be nested again under a row the delete reaches, or under another unit's, so the rows
 *   below a deleted row are no set of whole groups, and no owner-by-owner removal takes them.
 */
export type UnwritableCause =
	| { readonly kind: "nestingCycle"; readonly families: ReadonlyArray<FamilyName> }
	| {
			readonly kind: "unitCycle"
			readonly root: string
			readonly families: ReadonlyArray<FamilyName>
	  }

/** An UnwritableRelation's sentence. */
export const unwritableRelationText = (relation: string, cause: UnwritableCause): string => {
	const families = cause.families.map(familyNameText).join(", ")
	switch (cause.kind) {
		case "nestingCycle":
			return `no write fills ${relation}: the sequences ${families} nest each other in a cycle, so every row of them is nested under another and none is written first`
		case "unitCycle":
			return `no delete removes ${relation}'s rows whole: the families ${families} nest relations below ${cause.root} in a cycle, so a row a delete of ${cause.root} reaches may be nested again under another of its rows or another unit's, and the rows below are no set of whole groups`
	}
}

/** A column of a relation, as a refusal names it. */
export interface ColumnName {
	readonly relation: string
	readonly column: string
}

/**
 * A column a write changes on rows already stored: a field of a relation it puts, one its caller writes or one
 * generated from them (`put`); a column an edit of a family the relation owns draws on the owner, the family's count or
 * a column its last axis carries, a fold's end or a last copy (`owner`); or a column an edit of a family the relation is
 * a member of draws again on its members, an index or a copy along the owner or the predecessor axis (`member`).
 */
export interface ChangedColumn extends ColumnName {
	readonly by: "put" | "owner" | "member"
}

/**
 * A value a family draws from a column of its member's row only when that row is written: a fold's step or selection
 * (`fold`), a predecessor copy (`predecessor`), a last copy on its owner (`last`), a tree node's copy of its parent's
 * (`tree`), or a member's copy of its owner's column where an ordered edit re-places the owner's row, which no cascade
 * follows (`owner`). `column` is the column the value is drawn into, on `relation`.
 */
export interface DerivedReader extends ColumnName {
	readonly kind: "fold" | "predecessor" | "last" | "tree" | "owner"
	readonly family: FamilyName
}

/** A derived value, as a refusal names it. */
const derivedReaderText = (reader: DerivedReader): string => {
	const at = `${reader.relation}.${reader.column}`
	const family = familyNameText(reader.family)
	switch (reader.kind) {
		case "fold":
			return `the fold over ${family}, whose end is ${at},`
		case "predecessor":
			return `the predecessor copy ${at} of ${family}`
		case "last":
			return `the last copy ${at} of ${family}`
		case "tree":
			return `the copy ${at} of each node's parent along the tree ${family}`
		case "owner":
			return `the copy ${at} of its owner's along ${family}, whose owner an ordered edit deletes and inserts again,`
	}
}

/**
 * Why grizzle cannot draw again a value a change leaves stale: the change is a put whose rows a query states, which the
 * host never sees (`query`); the refills the change needs reach a family they refill again, `refills` in the order
 * each reaches the next, so no order of them draws every value once (`cycle`); the refill would change the rows of
 * `relation`, which is immutable: the family's members, which it updates in place, or its owner, whose family is fixed
 * when it is inserted (`immutable`); or the value is one of the tree `tree`'s, a node's copy of its parent's, a
 * sibling's predecessor copy or fold, or a parent's end or last copy, which grizzle draws only when the node is written
 * (`tree`); the value reads what the refill of `refill` itself changes, an owner's end or last copy or a member's
 * predecessor copy or fold, which grizzle does not refill again in turn (`chained`); or the value is one of `family`'s,
 * which a family member's put or delete reaches through an owner axis, or an edit's or an append's recount of its owner
 * reaches beyond its own family's members' copies (`edit`). Or no statement of the stratum draws it: a plain relation's
 * put reaches it by a cascade through the rows of `relation`, a member the stratum puts or deletes too (`passed`); a
 * member's write reaches it on rows of `relation`, which the stratum puts or deletes too (`rewritten`); or it is reached
 * from the edits of both `relations`, and a member is refilled in the statement of one edited relation (`edits`).
 */
export type StaleCause =
	| { readonly kind: "query" }
	| { readonly kind: "cycle"; readonly refills: NonEmptyReadonlyArray<FamilyName> }
	| { readonly kind: "immutable"; readonly relation: string }
	| { readonly kind: "tree"; readonly tree: FamilyName }
	| { readonly kind: "chained"; readonly refill: FamilyName }
	| { readonly kind: "edit"; readonly family: FamilyName }
	| { readonly kind: "passed"; readonly relation: string }
	| { readonly kind: "rewritten"; readonly relation: string }
	| { readonly kind: "edits"; readonly relations: readonly [string, string] }

/** Why a StaleDerivedRead's value cannot be drawn again, of a write of `member`. */
const staleCauseText = (member: string, cause: StaleCause): string => {
	switch (cause.kind) {
		case "query":
			return `a query states the put's rows, which grizzle never sees, so it cannot draw that value again: put ${member} from an array`
		case "cycle":
			return `refilling it reaches the families ${cause.refills.map(familyNameText).join(", then ")} and the first again, so no order of the refills draws each value once`
		case "immutable":
			return `refilling it would update rows of the immutable ${cause.relation} in place: declare mutable(${cause.relation}), or change the column in a schema whose family reads it from a column fixed once its row is written`
		case "tree":
			return `it is a value of the tree ${familyNameText(cause.tree)}, which grizzle draws only when the node is written and never again on a stored tree`
		case "chained":
			return `it reads what the refill of ${familyNameText(cause.refill)} itself changes, which grizzle does not refill again in turn`
		case "edit":
			return `it is a value of ${familyNameText(cause.family)}, which a family member's own write reaches through an owner axis or its owner's recount, and grizzle refills only a plain relation's put that way`
		case "passed":
			return `the cascade passes the rows of ${cause.relation}, which the stratum also puts or deletes, and grizzle refills a value along members its stratum neither puts nor deletes: put or delete ${cause.relation} in a ChangeSet of its own`
		case "rewritten":
			return `the refill rewrites rows of ${cause.relation}, which the stratum also puts or deletes, and grizzle refills a member's rows only where its stratum neither puts nor deletes them: put or delete ${cause.relation} in a ChangeSet of its own`
		case "edits":
			return `an edit of ${cause.relations[1]} reaches it as well as one of ${cause.relations[0]}, and grizzle refills a member in the statement of one edited relation: write the edits of ${cause.relations[0]} and ${cause.relations[1]} in ChangeSets of their own`
	}
}

/** A StaleDerivedRead's sentence: the change, the cascade that carries it on, the value that reads it, and its cause. */
export const staleDerivedReadText = (read: {
	readonly op: "insert" | "put" | "delete"
	readonly member: string
	readonly changed: ChangedColumn
	readonly copies: ReadonlyArray<ColumnName>
	readonly reader: DerivedReader
	readonly cause: StaleCause
}): string => {
	const write =
		read.op === "insert"
			? `an insert into ${read.member}`
			: read.op === "put"
				? `a put of ${read.member}`
				: `a delete of ${read.member}`
	const changed = `${read.changed.relation}.${read.changed.column}`
	const how =
		read.changed.by === "put"
			? `${write} changes ${changed} on rows already stored`
			: read.changed.by === "owner"
				? `${write} edits a family ${read.changed.relation} owns, which changes ${changed} on rows already stored`
				: `${write} edits a family ${read.changed.relation} is a member of, which draws ${changed} again on rows already stored`
	const carried = read.copies
		.map((c) => `, which ${c.relation}.${c.column} copies by cascade`)
		.join("")
	const why = staleCauseText(read.member, read.cause)
	return `${how}${carried}; ${derivedReaderText(read.reader)} reads it, a value grizzle draws again by refilling its family's groups, and ${why}`
}
