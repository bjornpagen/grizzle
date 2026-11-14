import {
	type ChangedColumn,
	type ClaimRule,
	claimRuleText,
	type ColumnName,
	type DerivedReader,
	type DerivedRefusal,
	derivedRefusalText,
	type FamilyName,
	type FillAxis,
	type FilledLater,
	type GeneratedRule,
	generatedRuleText,
	type KeyFault,
	keyFaultText,
	type LoginRule,
	loginRuleText,
	type RecursionRefusal,
	type RoleRule,
	recursionRefusalText,
	roleRuleText,
	type StaleCause,
	staleDerivedReadText,
	unfillableText,
	type UnwritableCause,
	unwritableRelationText
} from "#compiler/core/causes.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { regexTextMaxBytes } from "#compiler/core/limits.ts"
import { formatLoc, formatPath, prefixedLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Refused } from "#compiler/core/refusals.ts"

/** A path inside a value: object keys and array indices. */
type Path = ReadonlyArray<string | number>

/**
 * What grizzle reads back that it wrote, a MalformedArtifact's source: the snapshot (deploy/snapshot, the shell's
 * snapshot.json), the admission manifest, a migration folder's files and meta.json, the migrations ledger's rows, and
 * the canonical or fingerprinted value a digest is taken over.
 */
export type Artifact =
	| "snapshot"
	| "manifest"
	| "folder"
	| "meta"
	| "ledger"
	| "canonical"
	| "fingerprint"

/**
 * The limit of PostgreSQL's regex compiler a pattern's ARE passes (scalar/regex/space.ts pastCompileSpace), with the
 * facts it states, each bound a core/limits.ts constant:
 * - `anchorLoop`: an unbounded repetition of a body that can match zero-width through an anchor, which PostgreSQL
 *   breaks by cloning states exponentially and which is too large to rewrite as a loop of consuming matches;
 * - `colors`: `needed` colors, the classes of characters its sets hold alike, past `limit` (regexMaxColors);
 * - `depth`: a raw NFA whose longest path is `needed` arcs, past `limit` (regexMaxDepth), which PostgreSQL's
 *   recursive walks of it would descend past max_stack_depth;
 * - `states`: `needed` states held at once while it compiles, past `limit` (regexMaxHeldStates);
 * - `arcs`: more than `limit` arcs held at once while it compiles (regexMaxHeldArcs), counted only until they pass it;
 * - `matchStates`: `needed` states its optimized NFA keeps, past `limit` (regexMaxMatchStates), whose state sets
 *   PostgreSQL allocates at every match;
 * - `matchCells`: `needed` of those states times its colors, past `limit` (regexMaxMatchCells), each a cell of the
 *   arrays PostgreSQL allocates at every match;
 * - `anchors`: `needed` anchors PostgreSQL must move, past `limit` (regexMaxAnchors).
 */
export type RegexSpaceMeasure =
	| { readonly kind: "anchorLoop" }
	| { readonly kind: "colors"; readonly limit: number; readonly needed: number }
	| { readonly kind: "depth"; readonly limit: number; readonly needed: number }
	| { readonly kind: "states"; readonly limit: number; readonly needed: number }
	| { readonly kind: "arcs"; readonly limit: number }
	| { readonly kind: "matchStates"; readonly limit: number; readonly needed: number }
	| { readonly kind: "matchCells"; readonly limit: number; readonly needed: number }
	| { readonly kind: "anchors"; readonly limit: number; readonly needed: number }

const regexSpaceText = (measure: RegexSpaceMeasure): string => {
	switch (measure.kind) {
		case "anchorLoop":
			return "repeats without bound a body that can match zero-width through an anchor, too large to write as a loop of consuming matches"
		case "colors":
			return `cuts its characters into ${measure.needed} colors, more than ${measure.limit}`
		case "depth":
			return `compiles to an NFA whose longest path is ${measure.needed} arcs, more than ${measure.limit}`
		case "states":
			return `holds ${measure.needed} NFA states at once while it compiles, more than ${measure.limit}`
		case "arcs":
			return `holds more than ${measure.limit} NFA arcs at once while it compiles`
		case "matchStates":
			return `keeps ${measure.needed} NFA states to match with, more than ${measure.limit}`
		case "matchCells":
			return `keeps NFA states times colors of ${measure.needed} to match with, more than ${measure.limit}`
		case "anchors":
			return `has ${measure.needed} anchors to move, more than ${measure.limit}`
	}
}

/**
 * The bound a ResourceBound crossed, with the facts it states:
 * - `regexCompileSpace`: the pattern `pattern`, which `measure` puts past a limit of PostgreSQL's regex compiler;
 * - `stringLength`: a text grizzle builds as one string, `needed` UTF-16 code units long, past V8's longest string,
 *   `limit` (core/limits.ts maxStringLength);
 * - `tableColumns`: the table, view or materialized view `table` (a write program's carrier among them), of `needed`
 *   columns, past PostgreSQL's `limit` (core/limits.ts tableMaxColumns);
 * - `selectList`: a select list of `needed` entries, past PostgreSQL's `limit` (core/limits.ts selectMaxEntries);
 * - `statementBytes`: a statement `needed` UTF-8 bytes long, past PostgreSQL's longest protocol message, `limit`
 *   (core/limits.ts messageMaxBytes);
 * - `statementParams`: a statement of `needed` placeholders, past the `limit` a Bind message counts (core/limits.ts
 *   statementMaxParams);
 * - `numericDigits`: a numeric expression whose value may need `needed` integer digits, past numeric's `limit`
 *   (ir/carriers.ts numericMaxIntegerDigits), where PostgreSQL's numeric arithmetic would raise;
 * - `constantBits`: the constant of the closed relation or side `constant`, whose cells times their width come to
 *   `needed` bits, past PostgreSQL's longest bit string, `limit` (core/limits.ts constantMaxBits), refused before it is
 *   packed;
 * - `cellCodes`: the constant of the closed relation or side `constant`, whose payload space holds `needed` codes, past
 *   the `limit` a cell read as an integer holds (core/limits.ts cellMaxCodes), refused before it is packed;
 * - `regexInclusion`: whether every value of the language `inner` is a member of the language `outer`, which a cast's
 *   precondition rests on, undecided because comparing their automata passes the text analysis's bounds, `states` DFA
 *   states or `work` NFA-state visits (core/limits.ts regexDfaMaxStates, regexDfaMaxWork).
 */
export type CompileBound =
	| {
			readonly kind: "regexCompileSpace"
			readonly pattern: string
			readonly measure: RegexSpaceMeasure
	  }
	| { readonly kind: "stringLength"; readonly limit: number; readonly needed: number }
	| {
			readonly kind: "tableColumns"
			readonly table: string
			readonly limit: number
			readonly needed: number
	  }
	| { readonly kind: "selectList"; readonly limit: number; readonly needed: number }
	| { readonly kind: "statementBytes"; readonly limit: number; readonly needed: number }
	| { readonly kind: "statementParams"; readonly limit: number; readonly needed: number }
	| { readonly kind: "numericDigits"; readonly limit: number; readonly needed: number }
	| {
			readonly kind: "constantBits"
			readonly constant: string
			readonly limit: number
			readonly needed: bigint
	  }
	| {
			readonly kind: "cellCodes"
			readonly constant: string
			readonly limit: number
			readonly needed: bigint
	  }
	| {
			readonly kind: "regexInclusion"
			readonly inner: string
			readonly outer: string
			readonly states: number
			readonly work: number
	  }

const boundText = (bound: CompileBound): string => {
	switch (bound.kind) {
		case "regexCompileSpace":
			return `${bound.pattern} ${regexSpaceText(bound.measure)}: past a limit of PostgreSQL's regex compiler (REG_MAX_COMPILE_SPACE, MAX_COLOR, max_stack_depth or MaxAllocSize), beyond which PostgreSQL refuses a pattern as "regular expression is too complex" or "too many colors", or fails each match with "invalid memory alloc request size"; write a smaller pattern, or bound the text's length with Compute.charLength or Compute.octetLength in a contract predicate`
		case "stringLength":
			return `a text of at most ${bound.limit} UTF-16 code units, V8's longest string (needed ${bound.needed})`
		case "tableColumns":
			return `a table of at most ${bound.limit} columns, PostgreSQL's limit; ${bound.table} would have ${bound.needed}`
		case "selectList":
			return `a select list of at most ${bound.limit} entries, PostgreSQL's limit (needed ${bound.needed})`
		case "statementBytes":
			return `a statement of at most ${bound.limit} UTF-8 bytes, PostgreSQL's longest protocol message (needed ${bound.needed})`
		case "statementParams":
			return `a statement of at most ${bound.limit} placeholders, what a PostgreSQL Bind message counts (needed ${bound.needed})`
		case "numericDigits":
			return `a numeric value of at most ${bound.limit} integer digits, numeric's limit (this expression's may need ${bound.needed})`
		case "constantBits":
			return `the constant of ${bound.constant} in at most ${bound.limit} bits, PostgreSQL's longest bit string, VARBITMAXLEN (needed ${bound.needed})`
		case "cellCodes":
			return `the payload of ${bound.constant} in at most ${bound.limit} codes, what one cell read as an integer holds (needed ${bound.needed}); split its payload fields into closed relations of their own`
		case "regexInclusion":
			return `a decision whether every value of ${bound.inner} is a member of ${bound.outer}, which comparing their automata cannot reach within grizzle's text analysis bounds of ${bound.states} DFA states and ${bound.work} NFA-state visits; write the operand's pattern with fewer counted repetitions, or guard the cast with Compute.when(Compute.matches(x, <the target's pattern>), (x) => Compute.cast(x, <target>), <your value>)`
	}
}

/**
 * What a partial operation needs of its operands beyond their types (scalar/compute/registry.ts Precondition, by
 * kind): a nonzero divisor, a nonnegative radicand, a finite operand, a value that fits its target, a contract that
 * holds, a text inside a refinement's language, power's base's sign and its result's range, width_bucket's domain, a
 * parse's lexical form, a regex function's subject within the bytes PostgreSQL's regex engine reads.
 */
export type PreconditionKind =
	| "nonzero"
	| "nonnegative"
	| "finite"
	| "fits"
	| "contract"
	| "language"
	| "powerDomain"
	| "powerRange"
	| "bucketDomain"
	| "lexical"
	| "bounded"

/**
 * The test a PartialOperation's guard puts in Compute.when over its operand, which fits the operand's type: over a
 * number, Compute.nonzero, Compute.nonnegative, Compute.positive, Compute.isFinite, or Compute.within between the bounds
 * the operation is defined within; over a text, Compute.matches against the target's pattern, its lexical form, the
 * decimal text of a double (doubleText) or a decimal text (decimalText), or a bound on its UTF-8 bytes at the target's
 * str.bytes bound or a form's, Compute.within(Compute.octetLength(x), 0, bytes), where octetLength stands;
 * and, where no Compute test proves the precondition of the operand's type (a contract's predicate over a text, a
 * boolean, a uuid or a date), none: a value of the target's own type, a parameter its binding checks or a literal its
 * admission judges.
 * Where a fact precondition's operand is of a contract whose predicate implies the fact but does not declare it, the
 * remedy is no guard but the declaration: the fact added to that contract's `proves`, since a contract's facts are
 * exactly the ones it declares.
 */
export type GuardTest =
	| { readonly kind: "nonzero" }
	| { readonly kind: "nonnegative" }
	| { readonly kind: "positive" }
	| { readonly kind: "isFinite" }
	| { readonly kind: "within" }
	| {
			readonly kind: "matches"
			readonly pattern: "target" | "lexicalForm" | "doubleText" | "decimalText"
	  }
	| { readonly kind: "octets"; readonly bytes: number }
	| { readonly kind: "typed" }
	| { readonly kind: "proves"; readonly contract: string }

/**
 * The remedy a PartialOperation names: its remedy over the operand, and the sentence that states it, the guard to write
 * or the declaration to add, spelled from that test.
 */
export interface Guard {
	readonly remedy: GuardTest
	readonly text: string
}

/** A remedy's sentence: a declaration to add, or a guard to write. */
const remedyText = (guard: Guard): string =>
	guard.remedy.kind === "proves" ? `declare it: ${guard.text}` : `guard it: ${guard.text}`

const preconditionText = (kind: PreconditionKind, operand: string): string => {
	switch (kind) {
		case "nonzero":
			return `${operand} is never zero`
		case "nonnegative":
			return `${operand} is never negative`
		case "finite":
			return `${operand} is never NaN or an infinity`
		case "fits":
			return `${operand} fits its target`
		case "contract":
			return `${operand} satisfies its target's contract`
		case "language":
			return `${operand}'s language lies inside its target's pattern`
		case "powerDomain":
			return `${operand} is never negative, and never zero or raised to no negative power`
		case "powerRange":
			return `power over ${operand} stays inside its result's range`
		case "bucketDomain":
			return `${operand} lies where width_bucket is defined`
		case "lexical":
			return `${operand} is a member of its target's lexical form`
		case "bounded":
			return `${operand} is at most ${regexTextMaxBytes.value} UTF-8 bytes, the longest text PostgreSQL's regex engine reads`
	}
}

/**
 * A relation access a role does not hold, an OutsideRole's: a read of a relation of the role's base the role does not
 * hold (`base` naming the base); a write of a relation outside its write list; an UPDATE or DELETE of `relation` by a
 * role that writes by its insert list, which holds neither (`insert`); a refresh of one outside its refresh list; or a
 * program over the role's base, which is one only for a role holding every relation of it whole.
 */
export type RoleAccess =
	| { readonly kind: "read"; readonly relation: string; readonly base: string }
	| { readonly kind: "write"; readonly relation: string }
	| {
			readonly kind: "insert"
			readonly relation: string
			readonly operation: "UPDATE" | "DELETE"
	  }
	| { readonly kind: "refresh"; readonly relation: string }
	| { readonly kind: "wholeBase"; readonly base: string }

const accessText = (role: string, access: RoleAccess): string => {
	switch (access.kind) {
		case "read":
			return `a relation role ${role} holds; ${access.relation} is a relation of its base ${access.base} outside it`
		case "write":
			return `a write in role ${role}'s write list; ${access.relation} is outside it`
		case "insert":
			return `an insert by role ${role}, which writes by its insert list; the program ${access.operation === "DELETE" ? "deletes from" : "updates"} ${access.relation}`
		case "refresh":
			return `a derived relation in role ${role}'s refresh list; ${access.relation} is outside it`
		case "wholeBase":
			return `a program over a level of role ${role}; its base ${access.base} is one only for a role holding every relation of it whole, and ${role} does not`
	}
}

/**
 * A name declared twice differently, a DuplicateIdentity's, with where the earlier declaration is: a relation, a
 * contract, a context matched with another descriptor, an alternatives(...) statement repeated by its manual
 * expansion `statement`, or a scope name two calls to v give in one rule, which no type tells apart.
 */
export type Duplicate =
	| { readonly kind: "relation"; readonly name: string; readonly earlier: SourceLoc }
	| { readonly kind: "scope"; readonly name: string; readonly earlier: SourceLoc }
	| { readonly kind: "contract"; readonly name: string; readonly earlier: SourceLoc }
	| { readonly kind: "context"; readonly name: string; readonly earlier: SourceLoc }
	| {
			readonly kind: "alternatives"
			readonly statement: string
			readonly relation: string
			readonly earlier: SourceLoc
	  }

const duplicateText = (duplicate: Duplicate): string => {
	switch (duplicate.kind) {
		case "relation":
			return `one declaration per relation name; ${duplicate.name} is also declared differently at ${formatLoc(duplicate.earlier)}`
		case "scope":
			return `one scope per name in a rule; scope ${JSON.stringify(duplicate.name)} is also minted at ${formatLoc(duplicate.earlier)}, so give each v call of the rule its own name`
		case "contract":
			return `one descriptor per contract name; contract ${duplicate.name} is also declared differently at ${formatLoc(duplicate.earlier)}`
		case "context":
			return `one descriptor per context name; context ${duplicate.name} is also matched differently at ${formatLoc(duplicate.earlier)}`
		case "alternatives":
			return `either alternatives(...) or its manual expansion, not both; ${duplicate.statement} repeats the alternatives over ${duplicate.relation} declared at ${formatLoc(duplicate.earlier)}`
	}
}

/**
 * Why a compilation refused, as plain data: each variant carries where it refused (`at`, a location in the user's
 * description or program; a path inside the artifact for MalformedArtifact) and exactly the facts it states, and
 * renders its own sentence (compileReasonText).
 *
 * - `Refused`: the user's schema or program value breaks a rule the types name too, `refusal`, the message of the one
 *   vocabulary (core/refusals.ts) the type's Refusal names, verbatim; `at` locates what it names.
 * - `MalformedDescription`: the user's schema or program value is malformed: `what` is the rule it breaks.
 * - `MalformedArtifact`: what grizzle reads back (Artifact) is malformed at `at`: `what` is the rule it breaks.
 * - `UnsupportedOperation`: a capability the compiler does not have, `capability`. A new diagnostic for a missing
 *   capability is one; no variant is added for it.
 * - `UnsupportedLawFamily`: a law of a family the compiler does not lower, `capability`.
 * - `UnrepresentableKey`: a key or index, `subject`, over `key`, with no representable index entry, for `fault`.
 * - `FoldOverProjection`: a fold whose rule matches `source` without binding every field of one of its keys, so the
 *   fold would read a projection of its facts; `key` is the key to bind.
 * - `QueriedOwnerAppend`: a write at `at` of `owner` from a query, its `op` an insert or a put, which may insert an
 *   owner of `family`, in a ChangeSet that appends `member` to that family.
 * - `UnstatedKey`: a put or a delete, `op`, of `relation`, whose `key` holds the fields `unstated`, which grizzle writes
 *   and no fact states: its primary key, which names no row then, or a declared key a put's same-key check compares.
 * - `MissingDiscriminant`, `AttachedParentUnbound`, `AttachedPage`, `DescribedHeadingMismatch`, `ContractLiteral`:
 *   the rule `capability` names, a sentence nothing reads the parts of.
 * - `DuplicateIdentity`: a name declared twice differently (Duplicate), with the earlier declaration's location.
 * - `OutsideRole`: a program over `role` makes an access the role does not hold (RoleAccess).
 * - `IdentifierCollision`: two declarations whose `what` names, `declaration` and `otherDeclaration`, both convert to
 *   the identifier `identifier`; the one refused is `at`, the other `other`.
 * - `DigestCollision`: two distinct objects, `display` and `otherDisplay`, whose hashed names share the stem and the
 *   digest of `identifier` (core/identity.ts digestChars): two of one installation (censusOf), or a migration's
 *   temporary and an object standing while it runs or another temporary (TemporaryCensus); renaming a declaration
 *   either is built from gives it another.
 * - `ResourceBound`: a bound crossed (CompileBound).
 * - `PartialOperation`: an operation defined only where its precondition holds, which neither the operands' facts and
 *   bounds nor a Compute.cond around it proves: `operation` names it, `operand` the operand the precondition reads, and
 *   `guard` the remedy, its test over the operand by the operand's type (GuardTest): the Compute.when to write, whose
 *   other branch is the caller's value for the undefined case, or the fact its contract's predicate implies and its
 *   `proves` leaves out.
 * - `RecursionRefused`: recursion admission refused (check/recursion), for `cause`.
 * - `DerivedRefused`: derived analysis refused a derived relation (analysis/derived), for `cause`.
 * - `ForeignLevel`: a rule over `over`, a schema or a role, matches a query or a bound import of one written over
 *   `written`, which is none of `over`'s levels: a query reads what its own schema declares, so a rule reads a query only
 *   over a level of its schema, whatever relations the two share.
 * - `LevelRefused`: `statement`, stated at the level `level`, reaches `relation`, a relation of the level `below` under
 *   it, other than as one side of a containment of fields into a key, its other side a relation of a higher level, as
 *   a row check over it, or through a rule over a query: a process over a lower level holds none of the levels above it,
 *   so no law above may change how its writes are compiled or drawn, and it meets each of those laws as one above it.
 * - `FragmentRefused`: `statement`, a statement of a schema that lists the fragment `fragment` and none of the
 *   fragment's own, decides how `relation`, a relation of the fragment, is written: a key, mutable, race, retirable, a
 *   family, a tree or a fold over it. A program over a fragment is compiled in every schema that lists it and means
 *   there what it means over the fragment, so only the fragment states how its relations are written, and a schema that
 *   lists it may add over them only what refuses: a containment, a row check, a rule over a query.
 * - `RoleRefused`, `LoginRefused`, `ContextRefused`: a role, a login or a context breaks the rule `rule`.
 * - `RoleNameTooLong`: a login's or a role's PostgreSQL role, `role` (`<schema>__<name>`), is longer than PostgreSQL's
 *   `limit` bytes.
 * - `GeneratedRefused`: generated field `field` of `relation` breaks the rule `rule`.
 * - `UnfillableField`: the column `field` of `relation`, which grizzle fills by the law `law`, reads the column
 *   `source` along the `axis` of `family`, which its row fills only after it, for `later` (FilledLater), so no write
 *   fills it.
 * - `UnwritableRelation`: no write fills `relation`'s rows, for `cause` (UnwritableCause).
 * - `CascadedCopyAppend`: a write at `at` of `member`, an `op`, edits `family`, whose copy `copy` reads `owner`'s
 *   `through`, which `owner` copies from `changed`, a relation the same stratum puts from a query: grizzle never sees
 *   the query's rows, so it cannot draw the copy the put's change reaches `owner` with.
 * - `StaleDerivedRead`: a write at `at` of `member`, an `op`, changes `changed` on rows already stored, by a put of its
 *   relation or by an edit of a family it owns or is a member of, and the cascade carries the change on into `copies`,
 *   in order; the value `reader`, which a family draws from the last of them, reads it, and grizzle cannot draw it
 *   again by refilling the family (analysis/theory/refill.ts) for `cause` (StaleCause).
 * - `UnorderableStratum`: a stratum's writes `cycle`, each of which an immediate key or foreign key between them must
 *   run before the next, and the last before the first (write/frontend/schedule.ts), so no order of the stratum's
 *   statements keeps every key at every statement: an action's insert, put or delete, or a family statement's insert,
 *   update in place or delete of a member's rows, or count of an owner's.
 * - `ReadBackCrossesStatements`: the ChangeSet's read-back `read` reads a delta no one statement of the write holds
 *   whole with the state it reads, as `crossing` says (ReadBackCrossing): a read-back is evaluated inside the statement
 *   that makes its delta, whose rows exist nowhere else (write/schedule/plan.ts placeReadBacks).
 * - `UndeclaredDrop`: a migration drops `dropped`, which the previous installation holds and the schema no longer
 *   declares, and no declaration of the draft (`--rename`, `--drop`) names it.
 * - `UnheldGroup`: the ChangeSet at `at` reads or writes `relation`, a body of the retirable unit headed by `header`, or
 *   reads that header's retirement field, at a group it does not state, as `why` says (UnheldWhy): a served call holds
 *   every group it touches before it touches it (write/hold/stated.ts), so no retirement of one commits while it runs.
 */
export type CompileReason =
	| { readonly _tag: "Refused"; readonly at: SourceLoc; readonly refusal: Refused }
	| { readonly _tag: "MalformedDescription"; readonly at: SourceLoc; readonly what: string }
	| {
			readonly _tag: "MalformedArtifact"
			readonly artifact: Artifact
			readonly at: Path
			readonly what: string
	  }
	| { readonly _tag: "UnsupportedOperation"; readonly at: SourceLoc; readonly capability: string }
	| { readonly _tag: "UndeclaredDrop"; readonly at: SourceLoc; readonly dropped: Dropped }
	| { readonly _tag: "UnsupportedLawFamily"; readonly at: SourceLoc; readonly capability: string }
	| {
			readonly _tag: "UnrepresentableKey"
			readonly at: SourceLoc
			readonly subject: string
			readonly key: ReadonlyArray<string>
			readonly fault: KeyFault
	  }
	| {
			readonly _tag: "FoldOverProjection"
			readonly at: SourceLoc
			readonly source: string
			readonly key: ReadonlyArray<string>
	  }
	| {
			readonly _tag: "UnstatedKey"
			readonly at: SourceLoc
			readonly op: "put" | "delete"
			readonly relation: string
			readonly key: UnstatedKeyOf
			readonly unstated: ReadonlyArray<string>
	  }
	| {
			readonly _tag: "QueriedOwnerAppend"
			readonly at: SourceLoc
			readonly op: "insert" | "put"
			readonly owner: string
			readonly family: { readonly owner: string; readonly count: string }
			readonly member: string
	  }
	| { readonly _tag: "MissingDiscriminant"; readonly at: SourceLoc; readonly capability: string }
	| { readonly _tag: "AttachedParentUnbound"; readonly at: SourceLoc; readonly capability: string }
	| { readonly _tag: "AttachedPage"; readonly at: SourceLoc; readonly capability: string }
	| {
			readonly _tag: "DescribedHeadingMismatch"
			readonly at: SourceLoc
			readonly capability: string
	  }
	| { readonly _tag: "ContractLiteral"; readonly at: SourceLoc; readonly capability: string }
	| { readonly _tag: "DuplicateIdentity"; readonly at: SourceLoc; readonly duplicate: Duplicate }
	| {
			readonly _tag: "OutsideRole"
			readonly at: SourceLoc
			readonly role: string
			readonly access: RoleAccess
	  }
	| {
			readonly _tag: "IdentifierCollision"
			readonly at: SourceLoc
			readonly other: SourceLoc
			readonly identifier: string
			readonly what: string
			readonly declaration: string
			readonly otherDeclaration: string
	  }
	| {
			readonly _tag: "DigestCollision"
			readonly at: SourceLoc
			readonly identifier: string
			readonly display: string
			readonly otherDisplay: string
	  }
	| { readonly _tag: "ResourceBound"; readonly at: SourceLoc; readonly bound: CompileBound }
	| {
			readonly _tag: "PartialOperation"
			readonly at: SourceLoc
			readonly operation: string
			readonly precondition: PreconditionKind
			readonly operand: string
			readonly guard: Guard
	  }
	| { readonly _tag: "RecursionRefused"; readonly at: SourceLoc; readonly cause: RecursionRefusal }
	| { readonly _tag: "DerivedRefused"; readonly at: SourceLoc; readonly cause: DerivedRefusal }
	| {
			readonly _tag: "ForeignLevel"
			readonly at: SourceLoc
			readonly written: string
			readonly over: string
	  }
	| {
			readonly _tag: "LevelRefused"
			readonly at: SourceLoc
			readonly statement: string
			readonly level: string
			readonly relation: string
			readonly below: string
	  }
	| {
			readonly _tag: "FragmentRefused"
			readonly at: SourceLoc
			readonly statement: string
			readonly relation: string
			readonly fragment: string
	  }
	| {
			readonly _tag: "GeneratedRefused"
			readonly at: SourceLoc
			readonly relation: string
			readonly field: string
			readonly rule: GeneratedRule
	  }
	| {
			readonly _tag: "RoleRefused"
			readonly at: SourceLoc
			readonly role: string
			readonly rule: RoleRule
	  }
	| {
			readonly _tag: "LoginRefused"
			readonly at: SourceLoc
			readonly login: string
			readonly rule: LoginRule
	  }
	| {
			readonly _tag: "ContextRefused"
			readonly at: SourceLoc
			readonly context: string
			readonly rule: ClaimRule
	  }
	| {
			readonly _tag: "RoleNameTooLong"
			readonly at: SourceLoc
			readonly of: "login" | "role"
			readonly role: string
			readonly limit: number
	  }
	| {
			readonly _tag: "UnfillableField"
			readonly at: SourceLoc
			readonly relation: string
			readonly field: string
			readonly law: LawId
			readonly axis: FillAxis
			readonly family: FamilyName
			readonly source: { readonly relation: string; readonly column: string }
			readonly later: FilledLater
	  }
	| {
			readonly _tag: "UnwritableRelation"
			readonly at: SourceLoc
			readonly relation: string
			readonly cause: UnwritableCause
	  }
	| {
			readonly _tag: "CascadedCopyAppend"
			readonly at: SourceLoc
			readonly op: "insert" | "put" | "delete"
			readonly member: string
			readonly family: FamilyName
			readonly copy: string
			readonly owner: string
			readonly through: string
			readonly changed: string
	  }
	| {
			readonly _tag: "StaleDerivedRead"
			readonly at: SourceLoc
			readonly op: "insert" | "put" | "delete"
			readonly member: string
			readonly changed: ChangedColumn
			readonly copies: ReadonlyArray<ColumnName>
			readonly reader: DerivedReader
			readonly cause: StaleCause
	  }
	| {
			readonly _tag: "UnorderableStratum"
			readonly at: SourceLoc
			readonly cycle: NonEmptyReadonlyArray<{
				readonly relation: string
				readonly op: "insert" | "put" | "delete" | "update" | "count"
			}>
	  }
	| {
			readonly _tag: "ReadBackCrossesStatements"
			readonly at: SourceLoc
			readonly read: string
			readonly crossing: ReadBackCrossing
	  }
	| {
			readonly _tag: "UnheldGroup"
			readonly at: SourceLoc
			readonly relation: string
			readonly header: string
			readonly why: UnheldWhy
	  }
export type CompileReasonTag = CompileReason["_tag"]

/**
 * Why a ChangeSet touches a retirable unit's relation at a group it does not state (UnheldGroup), the group's fields
 * being the body's fields that name its header's key, or that key itself where it reads the header's retirement field:
 *
 * - `unbound`: a rule matches it with the group field `field` bound to no parameter: neither a parameter in the match's
 *   bindings nor a variable one conjunct of the rule's where equates to a parameter;
 * - `derived`: it reads it through `through`, a role's query entry, a derived relation or an imported query, whose rows
 *   no parameter of the ChangeSet names;
 * - `written`: a query member writes it with the group field `field` of its head bound to no parameter;
 * - `drawn`: its member's facts leave the group field `field` for its sequence to draw;
 * - `entry`: it writes it through the query entry `entry`, whose facts are stated in the entry's words;
 * - `filter`: the filter of the query entry `entry` the ChangeSet writes through reads it at the row the entry checks;
 * - `family`: a family statement reads its rows under owners of other groups: its family `family`'s owner is no body of
 *   its unit;
 * - `nested`: the ChangeSet nests its rows under facts of `owner`, which is no body of its unit.
 */
export type UnheldWhy =
	| { readonly kind: "unbound" | "written" | "drawn"; readonly field: string }
	| { readonly kind: "derived"; readonly through: string }
	| { readonly kind: "entry" | "filter"; readonly entry: string }
	| { readonly kind: "family"; readonly family: string }
	| { readonly kind: "nested"; readonly owner: string }

/**
 * A served call holds every group of a retirable unit it touches before it touches it, so it must state each: say how
 * the ChangeSet touches one it does not, and what states it.
 */
const unheldGroupText = (relation: string, header: string, why: UnheldWhy): string => {
	const touched = `${relation}, ${relation === header ? "whose retirement field states its group's state" : `a body of the retirable unit ${header}`}, is touched at a group the ChangeSet does not state, and a call holds every group of ${header} it touches before it touches it`
	switch (why.kind) {
		case "unbound":
			return `${touched}: a rule reads it with ${why.field} bound to no parameter; bind ${why.field} to a parameter in the match, or equate its variable to one in the rule's where`
		case "derived":
			return `${touched}: it is read through ${why.through}, whose rows no parameter names; match ${relation} itself, its group bound to parameters`
		case "written":
			return `${touched}: a query writes it with ${why.field} of its head bound to no parameter; state ${why.field} by a parameter, or write its rows from an array`
		case "drawn":
			return `${touched}: its facts leave ${why.field} for its sequence to draw; state ${why.field} in every fact`
		case "entry":
			return `${touched}: it is written through the query entry ${why.entry}, whose facts are the entry's; write ${relation} through a whole entry`
		case "filter":
			return `${touched}: the filter of the query entry ${why.entry} reads it at the row it checks; filter ${why.entry} by no body of ${header}`
		case "family":
			return `${touched}: the family ${why.family} reads its rows under owners of other groups; own its family by a body of ${header}`
		case "nested":
			return `${touched}: its rows are nested under facts of ${why.owner}, which state no group of ${header}; write them as a body's own facts`
	}
}

/** One side of a relation's delta a read-back names: `side` of `relation`'s, the relation a stored one, a query entry's
 * delta named by its target. */
export interface NamedSide {
	readonly relation: string
	readonly side: "added" | "removed" | "met"
}

/**
 * Why no one statement of a write holds what a read-back reads (ReadBackCrossesStatements):
 *
 * - `sideWrittenTwice`: the side is made by two statements, or netted against facts a statement of another stratum makes
 *   the other side of, so no statement's rows are the whole delta: one relation written in two strata, or an array or
 *   Stream inserted into a relation with serial fields, whose rows that state them and rows that leave them out are
 *   inserted by a statement each; an addition and a removal made in one stratum never net, since a row one stratum both
 *   adds and deletes stays;
 * - `sidesApart`: `first` and `second` are made whole by two different statements;
 * - `stateAfter`: the read-back reads `state`, which a statement at or after the one making `delta` writes, so that
 *   statement still sees `state` as it was before the change.
 */
export type ReadBackCrossing =
	| ({ readonly kind: "sideWrittenTwice" } & NamedSide)
	| { readonly kind: "sidesApart"; readonly first: NamedSide; readonly second: NamedSide }
	| { readonly kind: "stateAfter"; readonly delta: NamedSide; readonly state: string }

/** A side as a read-back names it: `delta.added(R)`. */
const namedSideText = (named: NamedSide): string => `delta.${named.side}(${named.relation})`

/**
 * A read-back is evaluated inside the one statement that makes its delta, since those rows exist nowhere else: say
 * which crossing leaves it no such statement, and the rewrites that give it one.
 */
const readBackCrossingText = (read: string, crossing: ReadBackCrossing): string => {
	const evaluated = `read-back ${read} is evaluated inside the one statement that makes the delta it reads, whose rows exist nowhere else`
	switch (crossing.kind) {
		case "sideWrittenTwice":
			return `${evaluated}, and ${namedSideText(crossing)} is made by more than one statement of the write, or netted against a statement's of another stratum: write ${crossing.relation} in one action of one stratum, inserting it from a query whose rows leave out its serial fields where it has any (an array or a Stream inserts the rows that state them and the rows that leave them out by a statement each), or read ${crossing.relation} back by its key after the change`
		case "sidesApart":
			return `${evaluated}, and ${namedSideText(crossing.first)} and ${namedSideText(crossing.second)} are made by two statements: read each in a read-back of its own`
		case "stateAfter":
			return `${evaluated}, and it reads ${crossing.state}, which the write changes at or after the statement making ${namedSideText(crossing.delta)}, so that statement sees ${crossing.state} as it was before: read delta.added(${crossing.state}) in its place, or write ${crossing.state} in an earlier stratum (ChangeSet.sequence)`
	}
}

/** The reasons whose one fact is a sentence: built by prose (a check's or builder's refusal helper). */
export type ProseTag =
	| Extract<CompileReason, { readonly capability: string }>["_tag"]
	| "MalformedDescription"

/**
 * What a migration may drop, as `--drop` spells it: a relation (`R`), a field of one (`R.f`), a roster's handle
 * (`R#h`), or a login (`@L`).
 */
export type Dropped =
	| { readonly kind: "relation"; readonly relation: DeclaredName }
	| { readonly kind: "field"; readonly relation: DeclaredName; readonly field: DeclaredName }
	| { readonly kind: "handle"; readonly roster: DeclaredName; readonly handle: string }
	| { readonly kind: "login"; readonly login: DeclaredName }

/** A dropped name as `--drop` spells it. */
const droppedText = (d: Dropped): string => {
	switch (d.kind) {
		case "relation":
			return d.relation
		case "field":
			return `${d.relation}.${d.field}`
		case "handle":
			return `${d.roster}#${d.handle}`
		case "login":
			return `@${d.login}`
	}
}

/**
 * A fold reads each fact its rule matches once, by a key, so a match that binds no key of its source would fold a
 * projection of its facts: name the key to bind, and the form that folds distinct values.
 */
const foldOverProjectionText = (source: string, key: ReadonlyArray<string>): string =>
	`a fold reads each fact it matches once, by its key, and this match of ${source} binds none of its keys: bind (${key.join(", ")}) in the match, or, to fold distinct values, match a query of them as the source`

/**
 * An owner inserted in the ChangeSet that appends to its family holds its final count and ends in its own row, since
 * PostgreSQL checks a row's CHECKs as it inserts the row, and grizzle fills them on the host from the facts the
 * ChangeSet states; a query's facts are the statement's alone, so its owner would be inserted at its starts: name the
 * two ways to state the owner first.
 */
const queriedOwnerAppendText = (
	op: "insert" | "put",
	owner: string,
	family: { readonly owner: string; readonly count: string },
	member: string
): string =>
	`${op === "put" ? "a put of" : "an insert into"} ${owner} from a query, which may insert an owner of the family ${family.owner}.${family.count}, in a ChangeSet that appends ${member} to that family: an inserted owner holds its final count and ends in its own row, which grizzle fills only from the facts a ChangeSet states, so state ${owner}'s facts in this ChangeSet from an array or a Stream, or ${op} ${owner} in a ChangeSet that ChangeSet.sequence runs before the one that appends`

/** The key an UnstatedKey names, by its fields: the relation's primary key, or a key a `key` statement declares. */
interface UnstatedKeyOf {
	readonly kind: "primary" | "declared"
	readonly fields: ReadonlyArray<string>
}

/**
 * A put names each row by its primary key, and a family's edit names each member by it, so a primary key holding a field
 * grizzle writes, which no fact states (a sequence's index), names no row: name the key to declare instead. A put's
 * same-key check compares its facts at every declared key too, so a declared key holding one is compared by no fact.
 */
const unstatedKeyText = (
	op: "put" | "delete",
	relation: string,
	key: UnstatedKeyOf,
	unstated: ReadonlyArray<string>
): string => {
	const fields = `(${key.fields.join(", ")})`
	const missing = `no fact of ${relation} states ${unstated.join(" or ")}, which grizzle writes itself`
	switch (key.kind) {
		case "primary":
			return `a ${op} of ${relation} names each row by its primary key ${fields}, and ${missing}: give ${relation} a primary key of fields its caller writes, such as an id, to ${op} a row by it`
		case "declared":
			return `a ${op} of ${relation} checks its facts at its key ${fields} before it is sent, and ${missing}: declare that key over fields ${relation}'s caller writes, or drop it where a family's own key already holds it`
	}
}

/**
 * What a rule finds broken, before where: a rule the types name too, `refusal` (Refused), or one in the rule's own
 * words, `what` (MalformedDescription).
 */
export type RuleBreach =
	| { readonly kind: "named"; readonly refusal: Refused }
	| { readonly kind: "prose"; readonly what: string }

/** A breach of a rule the types name too. */
export const namedBreach = (refusal: Refused): RuleBreach => ({ kind: "named", refusal })

/** A breach of a rule in its own words. */
export const proseBreach = (what: string): RuleBreach => ({ kind: "prose", what })

/** The reason a breach found at `at` is. */
export const breachReason = (at: SourceLoc, breach: RuleBreach): CompileReason =>
	breach.kind === "named"
		? { _tag: "Refused", at, refusal: breach.refusal }
		: { _tag: "MalformedDescription", at, what: breach.what }

/** A reason whose one fact is the sentence `text`, at `at`. */
export const prose = (tag: ProseTag, at: SourceLoc, text: string): CompileReason =>
	tag === "MalformedDescription"
		? { _tag: tag, at, what: text }
		: { _tag: tag, at, capability: text }

/** The sentence a reason states after its tag and location. */
export const compileReasonText = (reason: CompileReason): string => {
	switch (reason._tag) {
		case "Refused":
			return reason.refusal
		case "MalformedDescription":
		case "MalformedArtifact":
			return reason.what
		case "UnsupportedOperation":
		case "UnsupportedLawFamily":
		case "MissingDiscriminant":
		case "AttachedParentUnbound":
		case "AttachedPage":
		case "DescribedHeadingMismatch":
		case "ContractLiteral":
			return reason.capability
		case "UnrepresentableKey":
			return keyFaultText(reason.subject, reason.key, reason.fault)
		case "FoldOverProjection":
			return foldOverProjectionText(reason.source, reason.key)
		case "UnstatedKey":
			return unstatedKeyText(reason.op, reason.relation, reason.key, reason.unstated)
		case "QueriedOwnerAppend":
			return queriedOwnerAppendText(reason.op, reason.owner, reason.family, reason.member)
		case "DuplicateIdentity":
			return duplicateText(reason.duplicate)
		case "OutsideRole":
			return accessText(reason.role, reason.access)
		case "IdentifierCollision":
			return `${reason.what} names that convert apart; ${reason.declaration} and ${reason.otherDeclaration} both convert to ${reason.identifier}`
		case "DigestCollision":
			return `distinct hashed names for distinct objects; ${reason.display} and ${reason.otherDisplay} are both ${reason.identifier}: rename a declaration either is built from`
		case "ResourceBound":
			return boundText(reason.bound)
		case "PartialOperation":
			return `${reason.operation} is defined only where ${preconditionText(reason.precondition, reason.operand)}, which nothing here proves; ${remedyText(reason.guard)}`
		case "RecursionRefused":
			return recursionRefusalText(reason.cause)
		case "DerivedRefused":
			return derivedRefusalText(reason.cause)
		case "ForeignLevel":
			return `a query over a level of ${reason.over}; it is written over ${reason.written}, which is none of its levels`
		case "LevelRefused":
			return `${reason.statement}, stated at level ${reason.level}, reaches ${reason.relation} only as one side of a containment of fields into a key, the other side its own, as a row check over it, or through a rule over a query: ${reason.relation} is a relation of ${reason.below}, a level below it, whose writes no law above may change`
		case "FragmentRefused":
			return `${reason.statement} decides how ${reason.relation} is written, which only ${reason.fragment}, the fragment that declares it, states: state it in the fragment, or state over ${reason.relation} only what refuses, a containment, a row check or a rule over a query`
		case "GeneratedRefused":
			return `generated field ${reason.relation}.${reason.field}: ${generatedRuleText(reason.rule)}`
		case "RoleRefused":
			return `role ${reason.role}: ${roleRuleText(reason.rule)}`
		case "LoginRefused":
			return `login ${reason.login}: ${loginRuleText(reason.rule)}`
		case "ContextRefused":
			return `context ${reason.context}: ${claimRuleText(reason.rule)}`
		case "RoleNameTooLong":
			return `a ${reason.of} name whose role ${reason.role} fits ${reason.limit} bytes with its schema's name`
		case "UnfillableField":
			return unfillableText(reason)
		case "UnwritableRelation":
			return unwritableRelationText(reason.relation, reason.cause)
		case "CascadedCopyAppend":
			return `${reason.op === "put" ? "a put of" : reason.op === "insert" ? "an insert into" : "a delete of"} ${reason.member} edits the family ${reason.family.owner}.${reason.family.count}, whose copy ${reason.copy} reads ${reason.owner}'s ${reason.through}, which ${reason.owner} copies from ${reason.changed}; the same stratum puts ${reason.changed} from a query, whose rows grizzle never sees, so it cannot draw the copy the change reaches ${reason.owner} with: put ${reason.changed} from an array or a Stream, or in a ChangeSet applied before this one`
		case "StaleDerivedRead":
			return staleDerivedReadText(reason)
		case "UnorderableStratum":
			return `the stratum's ${reason.cycle.map((w) => `${w.op} of ${w.relation}`).join(", then ")} must each run before the next, and the last before the first, by the immediate keys and foreign keys between them, so no order of its statements keeps them all: write one of them in another stratum (ChangeSet.sequence)`
		case "ReadBackCrossesStatements":
			return readBackCrossingText(reason.read, reason.crossing)
		case "UnheldGroup":
			return unheldGroupText(reason.relation, reason.header, reason.why)
		case "UndeclaredDrop": {
			const spelled = droppedText(reason.dropped)
			return `${spelled} is dropped but not declared: declare it with --drop ${spelled}, or --rename it`
		}
	}
}

/** The text a CompileError prints: its reason's tag, where it refused and its sentence, and a collision's other location. */
const compileErrorMessage = (reason: CompileReason): string => {
	if (reason._tag === "MalformedArtifact") {
		return `MalformedArtifact in the ${reason.artifact}${reason.at.length === 0 ? "" : ` at ${formatPath(reason.at)}`}: ${reason.what}`
	}
	const text = `${reason._tag} at ${formatLoc(reason.at)}: ${compileReasonText(reason)}`
	return reason._tag === "IdentifierCollision"
		? `${text} (colliding with ${formatLoc(reason.other)})`
		: text
}

/**
 * A compilation's refusal: its `reason` says why, as plain tagged data (CompileReason), so Effect.catchReason,
 * catchReasons and unwrapReason reach it as they reach the shell's errors; its message is the reason's tag, where it
 * refused and its sentence. within(path) is the same refusal found inside the value at `path`.
 *
 * It is a plain class with no runtime dependency, an Error so a thrown one keeps its stack, told apart by its `_tag`.
 * Compiler passes return it in a Result (core/result.ts) and never throw it for an expected refusal; the public
 * builders throw it at the user's call, and the shell carries the same value in Effect's error channel. A defect stays
 * a defect (core/invariant.ts).
 */
export class CompileError extends Error {
	readonly _tag = "CompileError" as const
	readonly reason: CompileReason

	constructor(reason: CompileReason) {
		super(compileErrorMessage(reason))
		this.reason = reason
	}

	static {
		Object.defineProperty(this.prototype, "name", {
			value: "CompileError",
			writable: true,
			configurable: true
		})
	}

	static make(reason: CompileReason): CompileError {
		return new CompileError(reason)
	}
}

/** The same reason found inside the value at `path`: its location's path prefixed by `path`. */
const relocated = (reason: CompileReason, path: Path): CompileReason =>
	reason._tag === "MalformedArtifact"
		? { ...reason, at: [...path, ...reason.at] }
		: { ...reason, at: prefixedLoc(path, reason.at) }

/** The user's schema or program value, refused at `at` for `refusal`, a rule the types name too. */
export const ruleRefused = (at: SourceLoc, refusal: Refused): CompileError =>
	new CompileError({ _tag: "Refused", at, refusal })

/** The user's schema or program value, malformed at `at`: `what` is the rule it breaks. */
export const malformedDescription = (at: SourceLoc, what: string): CompileError =>
	new CompileError({ _tag: "MalformedDescription", at, what })

/** What grizzle reads back, `artifact`, malformed at the path `at`: `what` is the rule it breaks. */
export const malformedArtifact = (artifact: Artifact, at: Path, what: string): CompileError =>
	new CompileError({ _tag: "MalformedArtifact", artifact, at, what })

/** A capability the compiler does not have, refused at `at`. */
export const unsupported = (at: SourceLoc, capability: string): CompileError =>
	new CompileError({ _tag: "UnsupportedOperation", at, capability })

/** A drop no declaration names, at `at`. */
export const undeclaredDrop = (at: SourceLoc, dropped: Dropped): CompileError =>
	new CompileError({ _tag: "UndeclaredDrop", at, dropped })

/** A bound crossed at `at`. */
export const resourceBound = (at: SourceLoc, bound: CompileBound): CompileError =>
	new CompileError({ _tag: "ResourceBound", at, bound })

/** A recursion that admission refused at `at`, for `cause`. */
export const recursionRefused = (at: SourceLoc, cause: RecursionRefusal): CompileError =>
	new CompileError({ _tag: "RecursionRefused", at, cause })

/** A derived relation that derived analysis refused at `at`, for `cause`. */
export const derivedRefused = (at: SourceLoc, cause: DerivedRefusal): CompileError =>
	new CompileError({ _tag: "DerivedRefused", at, cause })

/**
 * The same refusal reported at `at`: a refusal of the user's description or program found where `at` names it. An
 * artifact's refusal names no source location, so it stays as it is.
 */
export const reportedAt = (e: CompileError, at: SourceLoc): CompileError => {
	const reason = e.reason
	return reason._tag === "MalformedArtifact" ? e : new CompileError({ ...reason, at })
}

/** Whether `value` is a CompileError, told by its tag. */
export const isCompileError = (value: unknown): value is CompileError =>
	Error.isError(value) && "_tag" in value && value._tag === "CompileError"

/** The same refusal found inside the value at `path`: its location's path prefixed by `path`. */
export const within = (e: CompileError, path: Path): CompileError =>
	new CompileError(relocated(e.reason, path))

/** The exact value carriers' refusal words (scalar/values/fault.ts). */
export const valueFaultWords = [
	"decimalNumber",
	"decimalType",
	"decimalSyntax",
	"decimalRange",
	"numericTypmod",
	"numericScale",
	"numericOverflow",
	"numericInfinity",
	"moneyType",
	"moneyRange",
	"moneySpecial",
	"integerType",
	"integerRange",
	"floatType",
	"realInexact",
	"realOverflow",
	"realUnderflow",
	"boolType",
	"uuidSyntax",
	"dateSyntax",
	"textType",
	"textNul",
	"textSurrogate",
	"bytesType",
	"bytesLength",
	"bytesCollision",
	"bytesChanged",
	"bytesLiteral",
	"codeHandle",
	"bitsType",
	"bitsMember",
	"spanType",
	"spanEndpoint",
	"spanOrder",
	"spanWidth",
	"vectorType",
	"vectorDimensions",
	"vectorNonFinite",
	"vectorNorm",
	"factShape"
] as const
export type ValueFault = (typeof valueFaultWords)[number]
/** A codec's refusal words: the value faults and the null ban (codec/fault.ts). */
export type CodecFault = ValueFault | "nullValue"
/**
 * The engine's classification of a transient refusal, which the shell turns into the reason class of its
 * TransientFailure (adapter/errors/execution.ts transientReason): a concurrent transaction's work met the attempt, or a
 * server statement the session had named went stale. Each carries the facts every occurrence of it has: the relation and
 * the constraint involved.
 * - `SerializationFailure`: SQLSTATE 40001 at a statement or raised by COMMIT: PostgreSQL found no serial order of this
 *   transaction and a concurrent one.
 * - `Deadlock`: SQLSTATE 40P01: this transaction and a concurrent one each waited for a lock the other held.
 * - `PutTargetConflict`: a put into `relation` deleted the fact at its key, and a concurrent transaction then committed
 *   a fact at that key: met as a conflict on the put's insert, or as the unique violation a MERGE raised there.
 * - `GeneratedSerialUnique`: a generated addition's own insert into `relation` raised a unique violation on
 *   `constraint`, a key holding the serial field it generates: a concurrent writer stored a value the sequence had not
 *   yet passed.
 * - `SpanKeyChange`: an insert into a span primary key of `relation` met an occupant at the key that a concurrent
 *   transaction changed: it has since gone, or on a put's insert it was committed after the put deleted the fact at
 *   the key.
 * - `UnseenOccupant`: an insert into `relation` raised a unique violation on `constraint`, a unique object besides its
 *   primary key, from an occupant this transaction's snapshot did not see: a concurrent transaction's, committed or in
 *   flight.
 * - `ConcurrentRefresh`: a refresh of the derived relation `relation`: another refresh of it committed after this
 *   transaction's snapshot.
 */
export type TransientReason =
	| { readonly _tag: "SerializationFailure" }
	| { readonly _tag: "Deadlock" }
	| { readonly _tag: "PutTargetConflict"; readonly relation: string }
	| {
			readonly _tag: "GeneratedSerialUnique"
			readonly relation: string
			readonly constraint: ConstraintName
	  }
	| { readonly _tag: "SpanKeyChange"; readonly relation: string }
	| {
			readonly _tag: "UnseenOccupant"
			readonly relation: string
			readonly constraint: ConstraintName
	  }
	| { readonly _tag: "ConcurrentRefresh"; readonly relation: string }
export type TransientTag = TransientReason["_tag"]

/** Each transient refusal's tag, under itself: the roster is complete by its type. */
const transientTagRoster: { readonly [T in TransientTag]: T } = {
	SerializationFailure: "SerializationFailure",
	Deadlock: "Deadlock",
	PutTargetConflict: "PutTargetConflict",
	GeneratedSerialUnique: "GeneratedSerialUnique",
	SpanKeyChange: "SpanKeyChange",
	UnseenOccupant: "UnseenOccupant",
	ConcurrentRefresh: "ConcurrentRefresh"
}

/** Every transient refusal's tag: the closed vocabulary a transient CallError names (live/events.ts). */
export const transientTags: ReadonlyArray<TransientTag> = Object.values(transientTagRoster)

/**
 * A codec's refusal as a reason: its fault word as its tag, which is all it states (never the value), so
 * Effect.catchReason reaches each word.
 */
export interface CodecReason {
	readonly _tag: CodecFault
}

/**
 * Where a value an encoder refused sits: the parameter or member slot `name` (`parameter.field` for a member's field),
 * or a whole fact, whose shape belongs to no slot.
 */
export type EncodingPlace =
	| { readonly _tag: "Slot"; readonly name: string }
	| { readonly _tag: "Fact" }

/**
 * A fact or parameter that fails its codec. `reason` is the codec's fault (CodecReason), never the value, and `place`
 * where the refused value sits. Its message names both, never the value.
 */
export class EncodingFailure extends Error {
	readonly _tag = "EncodingFailure" as const
	readonly reason: CodecReason
	readonly place: EncodingPlace

	constructor(fields: { readonly reason: CodecReason; readonly place: EncodingPlace }) {
		super(
			`${fields.place._tag === "Slot" ? `the value of ${fields.place.name}` : "a value"} was refused: ${fields.reason._tag}`
		)
		this.reason = fields.reason
		this.place = fields.place
	}

	static {
		Object.defineProperty(this.prototype, "name", {
			value: "EncodingFailure",
			writable: true,
			configurable: true
		})
	}

	static make(fields: {
		readonly reason: CodecReason
		readonly place: EncodingPlace
	}): EncodingFailure {
		return new EncodingFailure(fields)
	}
}
