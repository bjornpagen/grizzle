import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
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
	type InstantRule,
	type PlaceRule,
	instantRuleText,
	placeRuleText,
	type KeyFault,
	keyFaultText,
	type LoginRule,
	loginRuleText,
	type RecursionRefusal,
	type RoleRule,
	recursionRefusalText,
	roleRuleText,
	type ScopeRule,
	scopeRuleText,
	type StaleCause,
	staleDerivedReadText,
	unfillableText,
	type UnwritableCause,
	unwritableRelationText
} from "#compiler/core/causes.ts"
import {
	type FormattedFile,
	formatKey,
	formatOf,
	formatRefusal,
	type RecordedFormat,
	recordedFormat,
	recordedFormatText
} from "#compiler/core/format.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { formatLoc, formatPath, prefixedLoc, sitedLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"

/**
 * PostgreSQL's MaxAllocSize, the largest chunk its allocator hands out, which bounds the messages a backend reads.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one allocation of a backend
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/memutils.h#L40
 * @quote #define MaxAllocSize ((Size) 0x3fffffff)
 * @verified 2026-11-20
 */
export const maxAllocSize = 0x3fff_ffff

/**
 * The bytes of one pg_wchar, the wide character PostgreSQL's regex engine reads a text as: an unsigned int, 32 bits on
 * every platform PostgreSQL 19 builds on.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one pg_wchar, an unsigned int of the platform's C ABI, 32 bits on every platform PostgreSQL builds on
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/mb/pg_wchar.h#L28
 * @quote typedef unsigned int pg_wchar;
 * @verified 2026-11-20
 */
const pgWcharBytes = 4

/**
 * The longest text, in UTF-8 bytes, PostgreSQL's regex engine reads: before it matches, it widens the text into one
 * pg_wchar per byte and one more, and refuses an allocation past MaxAllocSize ("invalid memory alloc request size"). So
 * a query matches by ~, which Text.matches is, only an operand whose pattern bounds its bytes within this, and a
 * check or generated column that matches a longer text fails its write.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the subject text of one match by ~
 * @derivation RE_execute allocates "data = palloc_array(pg_wchar, dat_len + 1);" over its subject's dat_len bytes for
 *   ~ (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/regexp.c#L332, verified 2026-11-20),
 *   and palloc refuses a size past MaxAllocSize, so the length plus one is at most MaxAllocSize / sizeof(pg_wchar),
 *   rounded down
 * @from {@link maxAllocSize}, {@link pgWcharBytes}
 */
export const regexTextMaxBytes = Math.floor(maxAllocSize / pgWcharBytes) - 1

/** A path inside a value: object keys and array indices. */
type Path = ReadonlyArray<string | number>

/**
 * What grizzle reads back that it wrote, a MalformedArtifact's source: the snapshot (deploy/snapshot, the shell's
 * snapshot.json), the admission manifest, a migration folder's files and meta.json, the migrations ledger's rows, a
 * login's served file (served/json.ts servedFile), and the canonical or fingerprinted value a digest is taken over.
 */
export type Artifact =
	| "snapshot"
	| "served"
	| "manifest"
	| "folder"
	| "meta"
	| "ledger"
	| "canonical"
	| "fingerprint"

/**
 * The limit of PostgreSQL's regex compiler a pattern's ARE passes (ir/pattern-space.ts pastCompileSpace), with the
 * facts it states, each bound a constant:
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
 *   `limit` (maxStringLength);
 * - `stringLengthAtLeast`: a text grizzle builds piece by piece, refused at the piece where it passes V8's longest
 *   string, `limit`, so its whole length, which no writer measures, is at least `atLeast` UTF-16 code units (a canonical
 *   text encode builds, core/canonical.ts boundCanonicalText; never one a digest only hashes);
 * - `tableColumns`: the table or view `table` (a write program's carrier among them), of `needed`
 *   columns, past PostgreSQL's `limit` (tableMaxColumns);
 * - `selectList`: a select list of `needed` entries, past PostgreSQL's `limit` (selectMaxEntries);
 * - `statementBytes`: a statement `needed` UTF-8 bytes long, past PostgreSQL's longest protocol message, `limit`
 *   (messageMaxBytes);
 * - `statementParams`: a statement of `needed` placeholders, past the `limit` a Bind message counts (
 *   statementMaxParams);
 * - `numericDigits`: a numeric expression whose value may need `needed` integer digits, past numeric's `limit`
 *   (ir/carriers.ts numericMaxIntegerDigits), where PostgreSQL's numeric arithmetic would raise;
 * - `constantBits`: the constant of the closed relation or side `constant`, whose cells times their width come to
 *   `needed` bits, past PostgreSQL's longest bit string, `limit` (constantMaxBits), refused before it is
 *   packed;
 * - `cellCodes`: the constant of the closed relation or side `constant`, whose payload space holds `needed` codes, past
 *   the `limit` a cell read as an integer holds (cellMaxCodes), refused before it is packed;
 * - `regexInclusion`: whether every value of the language `inner` is a member of the language `outer`, which a cast's
 *   precondition rests on, undecided because comparing their automata passes the text analysis's bounds, `states` DFA
 *   states or `work` NFA-state visits (regexDfaMaxStates, regexDfaMaxWork).
 */
export type CompileBound =
	| {
			readonly kind: "regexCompileSpace"
			readonly pattern: string
			readonly measure: RegexSpaceMeasure
	  }
	| { readonly kind: "stringLength"; readonly limit: number; readonly needed: number }
	| { readonly kind: "stringLengthAtLeast"; readonly limit: number; readonly atLeast: number }
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
			return `${bound.pattern} ${regexSpaceText(bound.measure)}: past a limit of PostgreSQL's regex compiler (REG_MAX_COMPILE_SPACE, MAX_COLOR, max_stack_depth or MaxAllocSize), beyond which PostgreSQL refuses a pattern as "regular expression is too complex" or "too many colors", or fails each match with "invalid memory alloc request size"; write a smaller pattern, or bound the text's length with Text.charLength or Text.octetLength in a contract predicate`
		case "stringLength":
			return `a text of at most ${bound.limit} UTF-16 code units, V8's longest string (needed ${bound.needed})`
		case "stringLengthAtLeast":
			return `a text of at most ${bound.limit} UTF-16 code units, V8's longest string (needed at least ${bound.atLeast})`
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
			return `a decision whether every value of ${bound.inner} is a member of ${bound.outer}, which comparing their automata cannot reach within grizzle's text analysis bounds of ${bound.states} DFA states and ${bound.work} NFA-state visits; write the operand's pattern with fewer counted repetitions, or guard the cast with Logic.when(Text.matches(x, <the target's pattern>), (x) => Type.cast(x, <target>), <your value>)`
	}
}

/**
 * What a partial operation needs of its operands beyond their types (scalar/compute/registry.ts Precondition, by
 * kind): a nonzero divisor, a nonnegative radicand, a finite operand, a value that fits its target, a contract that
 * holds, a text inside a refinement's language, power's base's sign and its result's range, width_bucket's domain, a
 * parse's lexical form, a regex function's subject within the bytes PostgreSQL's regex engine reads, an instant within
 * PostgreSQL's timestamptz range.
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
	| "clock"

/**
 * The test a PartialOperation's guard puts in Logic.when over its operand, which fits the operand's type: over a
 * number, Num.nonzero, Num.nonnegative, Num.positive, Num.isFinite, or Num.within between the bounds
 * the operation is defined within; over a text, Text.matches against the target's pattern, its lexical form, the
 * decimal text of a double (doubleText) or a decimal text (decimalText), or a bound on its UTF-8 bytes at the target's
 * str.bytes bound or a form's, Num.within(Text.octetLength(x), 0, bytes), where octetLength stands;
 * and, where no scalar test proves the precondition of the operand's type (a contract's predicate over a text, a
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
			return `${operand} is at most ${regexTextMaxBytes} UTF-8 bytes, the longest text PostgreSQL's regex engine reads`
		case "clock":
			return `${operand} is an instant PostgreSQL's timestamptz holds, in milliseconds since the Unix epoch`
	}
}

/**
 * A relation access a role does not hold, an OutsideRole's: a read of a relation of the role's base the role does not
 * hold (`base` naming the base); a write of a relation outside its write list; an UPDATE or DELETE of `relation` by a
 * role that writes by its insert list, which holds neither (`insert`); a
 * match of `context`, which the role does not declare,
 * so its Db's claims hold no fact of it; a program over the role's base, which is one only for a role holding every
 * relation of it whole or scoped; or a program over the base that reads `relation`, which the role holds scoped, other
 * than row by row (`crossOwner`, program/slice.ts): its `read` decides by rows of `relation` it cannot show are all of
 * the owner's, so it would mean something else over the owner's rows than over every row.
 */
export type RoleAccess =
	| { readonly kind: "read"; readonly relation: string; readonly base: string }
	| { readonly kind: "write"; readonly relation: string }
	| {
			readonly kind: "insert"
			readonly relation: string
			readonly operation: "UPDATE" | "DELETE"
	  }
	| { readonly kind: "context"; readonly context: string; readonly declared: ReadonlyArray<string> }
	| { readonly kind: "wholeBase"; readonly base: string }
	| { readonly kind: "crossOwner"; readonly relation: string; readonly read: CrossOwnerRead }

/**
 * How a program over the base reads a scoped relation across owners (program/slice.ts): a negation, or a test of
 * existence anywhere but among its rule's filters, at rows no positive match of the rule shows are the owner's
 * (`negation`); an aggregate whose group may hold rows of several owners (`aggregate`); a take or an approximate search
 * over rows of several owners (`take`); a declared function's rows argument over rows of several owners (`call`).
 */
export type CrossOwnerRead = "negation" | "aggregate" | "take" | "call"

const crossOwnerText: { readonly [R in CrossOwnerRead]: string } = {
	negation: "decides by the absence of rows no positive match of its rule shows are the owner's",
	aggregate: "aggregates over a group whose rows may be several owners'",
	take: "takes from rows that may be several owners'",
	call: "passes a declared function rows that may be several owners'"
}

const accessText = (role: string, access: RoleAccess): string => {
	switch (access.kind) {
		case "read":
			return `a relation role ${role} holds; ${access.relation} is a relation of its base ${access.base} outside it`
		case "write":
			return `a write in role ${role}'s write list; ${access.relation} is outside it`
		case "insert":
			return `an insert by role ${role}, which writes by its insert list; the program ${access.operation === "DELETE" ? "deletes from" : "updates"} ${access.relation}`
		case "context":
			return `a context role ${role} declares, whose facts its Db's claims hold (${access.declared.length === 0 ? "it declares none" : access.declared.join(", ")}); ${access.context} is none of them`
		case "wholeBase":
			return `a program over a level of role ${role}; its base ${access.base} is one only for a role holding every relation of it whole or scoped, and ${role} does not`
		case "crossOwner":
			return `a program over role ${role}'s base that reads ${access.relation}, which ${role} holds scoped, row by row; it ${crossOwnerText[access.read]}`
	}
}

/**
 * A name declared twice differently, a DuplicateIdentity's, with where the earlier declaration is: a relation, a
 * declared function, a contract, a context matched with another descriptor, an alternatives(...) statement repeated by its manual
 * expansion `statement`, or a scope name two calls to v give in one rule, which no type tells apart.
 */
export type Duplicate =
	| { readonly kind: "relation"; readonly name: string; readonly earlier: SourceLoc }
	| { readonly kind: "function"; readonly name: string; readonly earlier: SourceLoc }
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
		case "function":
			return `one declaration per function name; function ${duplicate.name} is also declared differently at ${formatLoc(duplicate.earlier)}`
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
 * A key or index, `subject`, over `key`, with no representable index entry, for `fault`, where the compile met it, `at`:
 * one of the keys an UnrepresentableKey refusal names. Each check that judges an index entry records one where the entry
 * does not fit (core/canonical.ts KeyLedger): ownership's of a declared key (schema/own.ts ownKey), the law model's of
 * an index it plans (laws/model/plan.ts), the index engine's of an index it creates (physical/indexes/engine.ts
 * createIndex), and the installation's of a UNIQUE over a set its codes size (physical/ddl/tables.ts setUniqueBound).
 */
export interface KeyRefusal {
	readonly at: SourceLoc
	readonly subject: string
	readonly key: ReadonlyArray<string>
	readonly fault: KeyFault
}

/** The refusal naming every key of `keys`, in the order the compile met them. */
export const unrepresentableKeys = (keys: NonEmptyReadonlyArray<KeyRefusal>): CompileError =>
	new CompileError({ _tag: "UnrepresentableKey", keys })

/** A key's sentence after its location. */
const keyRefusalText = (key: KeyRefusal): string => keyFaultText(key.subject, key.key, key.fault)

/**
 * Why a compilation refused, as plain data: each variant carries where it refused (`at`, a location in the user's
 * description or program; a path inside the artifact for MalformedArtifact and ArtifactFormat) and exactly the facts it
 * states, and renders its own sentence (compileReasonText).
 *
 * - `Refused`: the user's schema or program value breaks a rule the types name too, `refusal`, the message of the one
 *   vocabulary (core/refusals.ts) the type's Refusal names, verbatim; `at` locates what it names.
 * - `MalformedDescription`: the user's schema or program value is malformed: `what` is the rule it breaks.
 * - `MalformedArtifact`: what grizzle reads back (Artifact) is malformed at `at`: `what` is the rule it breaks.
 * - `ArtifactFormat`: a file grizzle reads back, a committed snapshot or a served file (core/format.ts FormattedFile),
 *   records another format than this grizzle's, `expected`, or none: `recorded`, what it records, refused at its
 *   format member before anything else of it is read, its fix the file's own (core/format.ts formatRefusal).
 * - `UnsupportedOperation`: a capability the compiler does not have, `capability`. A new diagnostic for a missing
 *   capability is one; no variant is added for it.
 * - `UnsupportedLawFamily`: a law of a family the compiler does not lower, `capability`.
 * - `UnrepresentableKey`: every key and index the compile met with no representable index entry (KeyRefusal), in the
 *   order it met them, located at the first: a compile goes on past each such key (core/canonical.ts KeyLedger), so one
 *   refusal names them all.
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
 * - `IdentifierTooLong`: a declaration, `declaration` (its kind and name), whose identifier, `identifier`, takes
 *   `bytes` bytes, past PostgreSQL's `limit` (core/identity.ts maxIdentifierBytes), which PostgreSQL would cut short:
 *   a declared name's conversion, refused where the name is written (admitDeclaredName) and where it is declared, or a
 *   login's or role's PostgreSQL role, `<schema>__<name>` (fitted), under the installation's role prefix where it
 *   has one (roleInSpace).
 * - `RecordNameTooLong`: the relation the records of the stem `records` derive for the relation at `path` (the
 *   attachment names from the root, none for the root itself), `name`, whose identifier, `identifier`, takes `bytes`
 *   bytes, past PostgreSQL's `limit` (core/identity.ts maxIdentifierBytes), which PostgreSQL would cut short
 *   (program/records.ts). Its fix is the author's: a name stated for the attachment at its path in records' names, or
 *   a shorter stem for the root, `${stem}Row`; grizzle never cuts or hashes the name.
 * - `DigestCollision`: two distinct objects, `display` and `otherDisplay`, whose hashed names share the stem and the
 *   digest of `identifier` (core/identity.ts digestChars): two of one installation (censusOf), or a migration's
 *   temporary and an object standing while it runs or another temporary (TemporaryCensus); renaming a declaration
 *   either is built from gives it another.
 * - `ResourceBound`: a bound crossed (CompileBound).
 * - `PartialOperation`: an operation defined only where its precondition holds, which neither the operands' facts and
 *   bounds nor a Logic.cond around it proves: `operation` names it, `operand` the operand the precondition reads, and
 *   `guard` the remedy, its test over the operand by the operand's type (GuardTest): the Logic.when to write, whose
 *   other branch is the caller's value for the undefined case, or the fact its contract's predicate implies and its
 *   `proves` leaves out.
 * - `RecursionRefused`: recursion admission refused (check/recursion), for `cause`.
 * - `DerivedRefused`: derived analysis refused a derived relation (analysis/derived), for `cause`.
 * - `ForeignLevel`: a rule over `over`, a schema or a role, matches a query or a bound import of one written over
 *   `written`, which is none of `over`'s levels: a query reads what its own schema declares, so a rule reads a query only
 *   over a level of its schema, whatever relations the two share.
 * - `LevelRefused`: `statement`, stated at the level `level`, reaches `relation`, a relation of the level `below` under
 *   it, other than as one side of a containment of fields, selected or not, into a key, its other side a relation of a
 *   higher level, as a row check over it, or through a rule over a query: a process over a lower level holds none of the
 *   levels above it, so no law above may change how its writes are compiled or drawn, and it meets each of those laws as
 *   one above it.
 * - `FragmentRefused`: `statement`, a statement of a schema that lists the fragment `fragment` and none of the
 *   fragment's own, decides how `relation`, a relation of the fragment, is written: a key, mutable, race, a unit or a
 *   series, a family, a tree or a fold over it. A program over a fragment is compiled in every schema that lists it and means
 *   there what it means over the fragment, so only the fragment states how its relations are written, and a schema that
 *   lists it may add over them only what refuses: a containment, a row check, a rule over a query.
 * - `RoleRefused`, `LoginRefused`, `ContextRefused`: a role, a login or a context breaks the rule `rule`.
 * - `ScopeRefused`: scoped entries over `schema` break the rule `rule` (ScopeRule).
 * - `GeneratedRefused`: generated field `field` of `relation` breaks the rule `rule`.
 * - `UnfillableField`: the column `field` of `relation`, which grizzle fills by the law `law`, reads the column
 *   `source` along the `axis` of `family`, which its row fills only after it, for `later` (FilledLater), so no write
 *   fills it, or, the source stamped, no write that stamps the source.
 * - `UnwritableRelation`: no write fills `relation`'s rows, or no delete removes them whole, for `cause`
 *   (UnwritableCause).
 * - `InstantRefused`: instant field `field` of `relation` breaks the rule `rule` (InstantRule): as the schema declares
 *   it, a clock outside its primary key, or as a ChangeSet writes it.
 * - `PlaceRefused`: place field `field` of `relation` breaks the rule `rule` (PlaceRule): as the schema declares it,
 *   outside the end of its primary key or ordered by no key, or as a ChangeSet writes it.
 * - `CascadedCopyAppend`: a write at `at` of `member`, an `op`, edits `family`, whose copy `copy` reads `owner`'s
 *   `through`, which `owner` copies from `changed`, a relation the same stratum puts from a query: grizzle never sees
 *   the query's rows, so it cannot draw the copy the put's change reaches `owner` with.
 * - `StaleDerivedRead`: a write at `at` of `member`, an `op`, changes `changed` on rows already stored, by a put of its
 *   relation or by an edit of a family it owns or is a member of, and the cascade carries the change on into `copies`,
 *   in order; the value `reader`, which a family draws from the last of them, reads it, and grizzle cannot draw it
 *   again by refilling the family (analysis/theory/refill.ts) for `cause` (StaleCause).
 * - `UnorderableStratum`: a stratum's writes `cycle`, each of which an immediate key or foreign key between them must
 *   run before the next, and the last before the first (write/frontend/schedule.ts), so no order of the stratum's
 *   statements keeps every key at every statement: an action's insert, put or delete, or a family statement's: an
 *   additions' insert of its member's rows, or its count of an owner's where it appends none, or a removals' delete.
 * - `ReadBackCrossesStatements`: the ChangeSet's read-back `read` reads `delta`, a side of a relation's delta no one
 *   statement of the write makes whole: two statements make it, or a statement of another stratum makes the side it
 *   nets against, so it is the rows of no statement, which a read-back reads inside that statement or carries to the
 *   end of the write (write/schedule/plan.ts placeReadBacks).
 * - `UndeclaredDrop`: a migration drops `dropped`, which the previous installation holds and the schema no longer
 *   declares, and no declaration of the draft (`--rename`, `--drop`) names it.
 * - `Misdeclared`: a declaration of the draft names what the previous snapshot and the target do not bear out, as
 *   `misdeclared` says (Misdeclaration): the converse of UndeclaredDrop, each declaration standing for exactly the
 *   change it names.
 * - `NoReadCommittedForm`: the write at `at` inserts into `relation` and is compiled for READ COMMITTED, where the
 *   insert has no form: its primary key holds a span, whose exclusion constraint arbitrates an INSERT by ON CONFLICT DO
 *   NOTHING alone, so no statement of the insert tells a requested fact it met from one it made, where SERIALIZABLE
 *   arbitrates every object and classifies what it met (write/insert/protocol.ts Arbitration `every`). Certification
 *   reads it as the condition `form` of the role it compiles (analysis/isolation/certify.ts), which then runs
 *   SERIALIZABLE; only a compile for a level no certificate gives meets it as a refusal.
 * - `UninstalledDomain`: a statement at `at` casts a value to `domain` (UninstalledType), a domain the installation it is
 *   compiled for installs none of: a statement is served only over the domains its installation holds, so a value cast
 *   to another is refused where it is compiled, never by PostgreSQL where it runs.
 * - `UninstalledFunction`: a statement at `at` calls `fn`, a function of grizzle's library (ir/physical.ts LibraryFn)
 *   the installation it is compiled for installs none of, since none of its artifacts and no program of its served
 *   workload calls it (physical/install/plan.ts artifactObjects, ServedTypes `library`): a statement is served only
 *   over the functions its installation holds, so a call of another is refused where it is compiled, never by
 *   PostgreSQL where it runs (42883).
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
	| {
			readonly _tag: "ArtifactFormat"
			readonly artifact: FormattedFile
			readonly at: Path
			readonly recorded: RecordedFormat
			readonly expected: string
	  }
	| { readonly _tag: "UnsupportedOperation"; readonly at: SourceLoc; readonly capability: string }
	| { readonly _tag: "UndeclaredDrop"; readonly at: SourceLoc; readonly dropped: Named }
	| { readonly _tag: "Misdeclared"; readonly at: SourceLoc; readonly misdeclared: Misdeclaration }
	| { readonly _tag: "UnsupportedLawFamily"; readonly at: SourceLoc; readonly capability: string }
	| { readonly _tag: "UnrepresentableKey"; readonly keys: NonEmptyReadonlyArray<KeyRefusal> }
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
			readonly _tag: "IdentifierTooLong"
			readonly at: SourceLoc
			readonly declaration: string
			readonly identifier: string
			readonly bytes: number
			readonly limit: number
	  }
	| {
			readonly _tag: "RecordNameTooLong"
			readonly at: SourceLoc
			readonly records: string
			readonly path: ReadonlyArray<string>
			readonly name: string
			readonly identifier: string
			readonly bytes: number
			readonly limit: number
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
			readonly _tag: "ScopeRefused"
			readonly at: SourceLoc
			readonly schema: string
			readonly rule: ScopeRule
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
			readonly _tag: "InstantRefused"
			readonly at: SourceLoc
			readonly relation: string
			readonly field: string
			readonly rule: InstantRule
	  }
	| {
			readonly _tag: "PlaceRefused"
			readonly at: SourceLoc
			readonly relation: string
			readonly field: string
			readonly rule: PlaceRule
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
				readonly op: "insert" | "put" | "delete" | "count"
			}>
	  }
	| {
			readonly _tag: "ReadBackCrossesStatements"
			readonly at: SourceLoc
			readonly read: string
			readonly delta: NamedSide
	  }
	| {
			readonly _tag: "NoReadCommittedForm"
			readonly at: SourceLoc
			readonly relation: string
	  }
	| { readonly _tag: "UninstalledDomain"; readonly at: SourceLoc; readonly domain: UninstalledType }
	| { readonly _tag: "UninstalledFunction"; readonly at: SourceLoc; readonly fn: string }
export type CompileReasonTag = CompileReason["_tag"]

/**
 * A domain a statement casts a value to that its installation does not install (UninstalledDomain): the domain of the
 * contract `contract`, or the structural text domain of `pattern`, which none of the installation's artifacts and no
 * program of its served workload types a value by; or the pattern domain of the parameter `param` over `pattern`, the
 * patterns' text, which no program of the installation's served workload declares at that place.
 */
export type UninstalledType =
	| { readonly kind: "contract"; readonly contract: string }
	| { readonly kind: "param"; readonly param: string; readonly pattern: string }
	| { readonly kind: "text"; readonly pattern: string }

/** What an installation would need to install `domain`, and what installs it (UninstalledDomain). */
const uninstalledText = (domain: UninstalledType): string => {
	switch (domain.kind) {
		case "contract":
			return `the installation installs no domain of contract ${domain.contract}, which none of its artifacts and no program of its served workload types a value by: serve the program from a workload of a login of the installation and run grizzle generate`
		case "param":
			return `the installation installs no pattern domain of parameter ${domain.param} over ${domain.pattern}, which no program of its served workload declares: serve the program from a workload of a login of the installation and run grizzle generate`
		case "text":
			return `the installation installs no text domain of ${domain.pattern}, which none of its artifacts and no program of its served workload types a value by: serve the program from a workload of a login of the installation and run grizzle generate`
	}
}

/** One side of a relation's delta a read-back names: `side` of `relation`'s, the relation a stored one, a query entry's
 * delta named by its target. */
export interface NamedSide {
	readonly relation: string
	readonly side: "added" | "removed" | "met"
}

/** A side as a read-back names it: `delta.added(R)`. */
const namedSideText = (named: NamedSide): string => `delta.${named.side}(${named.relation})`

/**
 * A read-back reads a delta side inside the one statement that makes it whole, or carries it from there to the end of
 * the write: say that no one statement makes `delta` whole, and the rewrites that give it one.
 */
const readBackCrossingText = (read: string, delta: NamedSide): string =>
	`read-back ${read} reads ${namedSideText(delta)}, which more than one statement of the write makes, or which a statement of another stratum nets against, so it is the rows of no one statement, inside which the read-back would read it or out of which it would carry it: write ${delta.relation} in one action of one stratum, or read ${delta.relation} back by its key after the change`

/** The reasons whose one fact is a sentence: built by prose (a check's or builder's refusal helper). */
export type ProseTag =
	| Extract<CompileReason, { readonly capability: string }>["_tag"]
	| "MalformedDescription"

/**
 * A name a draft's declarations speak of, as `--rename` and `--drop` spell it (namedSpelling): a relation
 * (`Relation`), a field of one (`Relation.field`), a roster's handle (`Roster#handle`), or a login (`@login`). What a
 * declaration names, what a migration drops (UndeclaredDrop) and what a refused declaration names (Misdeclared) are
 * each one.
 */
export type Named =
	| { readonly kind: "relation"; readonly relation: DeclaredName }
	| { readonly kind: "field"; readonly relation: DeclaredName; readonly field: DeclaredName }
	| { readonly kind: "handle"; readonly roster: DeclaredName; readonly handle: string }
	| { readonly kind: "login"; readonly login: DeclaredName }

/** A name a declaration speaks of, spelled as `--rename` and `--drop` spell it. */
export const namedSpelling = (n: Named): string => {
	switch (n.kind) {
		case "relation":
			return n.relation
		case "field":
			return `${n.relation}.${n.field}`
		case "handle":
			return `${n.roster}#${n.handle}`
		case "login":
			return `@${n.login}`
	}
}

/**
 * What makes a draft's declaration one the previous snapshot and the target do not bear out (Misdeclared), each naming
 * what it declares as `--rename` and `--drop` spell it:
 * - `dropUnheld`: a drop of `dropped`, which the previous snapshot does not hold: no such relation, field or login, or
 *   a handle whose code it holds as a hole, as it does once a migration of the chain dropped the handle, so a draft
 *   run again over the folder it wrote meets it;
 * - `dropKept`: a drop of `dropped`, which the target keeps: it declares it still, under its name or the one a
 *   declared rename gives it;
 * - `renameUnheld`: a rename of `from`, which the previous snapshot does not hold, a handle live;
 * - `renameUndeclared`: a rename of `from` to `to`, which the target does not declare, a handle live;
 * - `renameAcross`: a rename of `from` to `to` where the two do not correspond: a stored relation and a roster, a
 *   field onto a relation, or a handle into a roster, other than the one its own continues as;
 * - `renamedTwice`: two renames of `from`;
 * - `renamedOnto`: two renames to `to`.
 */
export type Misdeclaration =
	| { readonly kind: "dropUnheld"; readonly dropped: Named }
	| { readonly kind: "dropKept"; readonly dropped: Named }
	| { readonly kind: "renameUnheld"; readonly from: Named; readonly to: Named }
	| { readonly kind: "renameUndeclared"; readonly from: Named; readonly to: Named }
	| { readonly kind: "renameAcross"; readonly from: Corresponding; readonly to: Named }
	| { readonly kind: "renamedTwice"; readonly from: Named }
	| { readonly kind: "renamedOnto"; readonly to: Named }

/** A name whose rename may name what does not correspond to it (renameAcross): every kind but a login, which is one
 * kind of its own. */
type Corresponding = Exclude<Named, { readonly kind: "login" }>

/** Why a rename of `from` to a name that does not correspond is refused (Misdeclaration renameAcross), and its repair. */
const acrossText = (from: Corresponding): string => {
	switch (from.kind) {
		case "relation":
			return "a stored relation and a roster are each renamed to one of their own kind"
		case "field":
			return `a field is renamed on the relation ${from.relation} continues as, under its declared rename or its own name`
		case "handle":
			return `a handle is renamed in the roster ${from.roster} continues as, under its declared rename or its own name`
	}
}

/** A misdeclaration's sentence: what the declaration names, what the snapshots hold of it, and its repair. */
const misdeclaredText = (m: Misdeclaration): string => {
	switch (m.kind) {
		case "dropUnheld":
			return `--drop ${namedSpelling(m.dropped)} drops nothing: the previous snapshot holds no ${namedSpelling(m.dropped)}${m.dropped.kind === "handle" ? " live" : ""}: a migration of the chain dropped it already, as a draft run again over the folder it wrote finds, or the chain never held it; remove the --drop`
		case "dropKept":
			return `--drop ${namedSpelling(m.dropped)} drops what the schema keeps: it still declares ${namedSpelling(m.dropped)}, under its name or the one a declared rename gives it; remove the --drop, or remove it from the schema`
		case "renameUnheld":
			return `--rename ${namedSpelling(m.from)}=${namedSpelling(m.to)} renames nothing: the previous snapshot holds no ${namedSpelling(m.from)}${m.from.kind === "handle" ? " live" : ""}; remove the --rename`
		case "renameUndeclared":
			return `--rename ${namedSpelling(m.from)}=${namedSpelling(m.to)} renames to what the schema does not declare: it declares no ${namedSpelling(m.to)}; name the new side as the schema declares it`
		case "renameAcross":
			return `--rename ${namedSpelling(m.from)}=${namedSpelling(m.to)} renames across: ${acrossText(m.from)}`
		case "renamedTwice":
			return `${namedSpelling(m.from)} is renamed twice: a declaration renames a name once`
		case "renamedOnto":
			return `two names are renamed to ${namedSpelling(m.to)}: a rename gives each name its own`
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

/** Why an insert into `relation`, whose primary key holds a span, has no READ COMMITTED form (NoReadCommittedForm). */
export const noReadCommittedFormText = (relation: string): string =>
	`an insert into ${relation}, whose primary key holds a span, has no READ COMMITTED form: its exclusion constraint arbitrates by ON CONFLICT DO NOTHING alone, so no statement tells a requested fact it met from one it made, and it runs SERIALIZABLE`

/**
 * A RecordNameTooLong's sentence: the relation, its name's identifier and bytes past the bound, and its fix, a name
 * stated at the attachment's path in records' options, or a shorter stem for the root.
 */
const recordNameTooLongText = (
	reason: Extract<CompileReason, { readonly _tag: "RecordNameTooLong" }>
): string => {
	const key = reason.path.join(".")
	const [relation, fix] =
		reason.path.length === 0
			? [`the root of records ${reason.records}`, `a shorter stem than ${reason.records}`]
			: [
					`the relation of records ${reason.records}' attachment ${key}`,
					`state its name in records' options, { names: { ${JSON.stringify(key)}: <a name whose identifier fits ${reason.limit} bytes> } }`
				]
	return `a records relation name whose identifier fits PostgreSQL's ${reason.limit} bytes; ${relation}, ${reason.name}, has the identifier ${reason.identifier}, which takes ${reason.bytes}: ${fix}`
}

/** The sentence a reason states after its tag and location. */
export const compileReasonText = (reason: CompileReason): string => {
	switch (reason._tag) {
		case "Refused":
			return reason.refusal
		case "MalformedDescription":
		case "MalformedArtifact":
			return reason.what
		case "ArtifactFormat": {
			const { problem, fix } = formatRefusal[reason.artifact]
			return `${problem}: ${recordedFormatText(reason.recorded, reason.expected)}: ${fix}`
		}
		case "UnsupportedOperation":
		case "UnsupportedLawFamily":
		case "MissingDiscriminant":
		case "AttachedParentUnbound":
		case "AttachedPage":
		case "DescribedHeadingMismatch":
		case "ContractLiteral":
			return reason.capability
		case "UnrepresentableKey": {
			const [first, ...rest] = reason.keys
			return [
				keyRefusalText(first),
				...rest.map((k) => `${reason._tag} at ${formatLoc(k.at)}: ${keyRefusalText(k)}`)
			].join("\n")
		}
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
		case "IdentifierTooLong":
			return `a name whose identifier fits PostgreSQL's ${reason.limit} bytes; the ${reason.declaration}'s identifier ${reason.identifier} takes ${reason.bytes}`
		case "RecordNameTooLong":
			return recordNameTooLongText(reason)
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
			return `${reason.statement}, stated at level ${reason.level}, reaches ${reason.relation} only as one side of a containment of fields, selected or not, into a key, the other side its own, as a row check over it, or through a rule over a query: ${reason.relation} is a relation of ${reason.below}, a level below it, whose writes no law above may change`
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
		case "ScopeRefused":
			return `scoped entries of ${reason.schema}: ${scopeRuleText(reason.rule)}`
		case "UnfillableField":
			return unfillableText(reason)
		case "InstantRefused":
			return `instant ${reason.relation}.${reason.field}: ${instantRuleText(reason.rule)}`
		case "PlaceRefused":
			return `place ${reason.relation}.${reason.field}: ${placeRuleText(reason.rule)}`
		case "UnwritableRelation":
			return unwritableRelationText(reason.relation, reason.cause)
		case "CascadedCopyAppend":
			return `${reason.op === "put" ? "a put of" : reason.op === "insert" ? "an insert into" : "a delete of"} ${reason.member} edits the family ${reason.family.owner}.${reason.family.count}, whose copy ${reason.copy} reads ${reason.owner}'s ${reason.through}, which ${reason.owner} copies from ${reason.changed}; the same stratum puts ${reason.changed} from a query, whose rows grizzle never sees, so it cannot draw the copy the change reaches ${reason.owner} with: put ${reason.changed} from an array or a Stream, or in a ChangeSet applied before this one`
		case "StaleDerivedRead":
			return staleDerivedReadText(reason)
		case "UnorderableStratum":
			return `the stratum's ${reason.cycle.map((w) => `${w.op} of ${w.relation}`).join(", then ")} must each run before the next, and the last before the first, by the immediate keys and foreign keys between them, so no order of its statements keeps them all: write one of them in another stratum (ChangeSet.sequence)`
		case "ReadBackCrossesStatements":
			return readBackCrossingText(reason.read, reason.delta)
		case "NoReadCommittedForm":
			return noReadCommittedFormText(reason.relation)
		case "UninstalledDomain":
			return uninstalledText(reason.domain)
		case "UninstalledFunction":
			return `the installation installs no library function ${reason.fn}, which none of its artifacts and no program of its served workload calls: serve the program from a workload of a login of the installation and run grizzle generate`
		case "Misdeclared":
			return misdeclaredText(reason.misdeclared)
		case "UndeclaredDrop": {
			const spelled = namedSpelling(reason.dropped)
			return `${spelled} is dropped but not declared: declare it with --drop ${spelled}, or --rename it`
		}
	}
}

/** A refusal of a file grizzle reads back, located by a path inside the file, never by a source location. */
type ArtifactReason = Extract<
	CompileReason,
	{ readonly _tag: "MalformedArtifact" | "ArtifactFormat" }
>

/** The one site of the fact "this reason is located inside an artifact": its tag is an artifact's refusal. */
const isArtifactReason = (reason: CompileReason): reason is ArtifactReason =>
	reason._tag === "MalformedArtifact" || reason._tag === "ArtifactFormat"

/** A refusal of several keys, each at its own location (KeyRefusal). */
type KeysReason = Extract<CompileReason, { readonly _tag: "UnrepresentableKey" }>

/** A refusal located at one place in the user's description or program. */
type SourcedReason = Exclude<CompileReason, ArtifactReason | KeysReason>

/**
 * How a reason is located: inside an artifact by a path, at each of its keys' locations, or at one location in the
 * user's description or program.
 */
type Located =
	| { readonly kind: "artifact"; readonly reason: ArtifactReason }
	| { readonly kind: "keys"; readonly reason: KeysReason }
	| { readonly kind: "sourced"; readonly reason: SourcedReason }

const located = (reason: CompileReason): Located =>
	isArtifactReason(reason)
		? { kind: "artifact", reason }
		: reason._tag === "UnrepresentableKey"
			? { kind: "keys", reason }
			: { kind: "sourced", reason }

/**
 * The text a CompileError prints: its reason's tag, where it refused and its sentence, and a collision's other location;
 * a refusal of several keys, one such line for each, in the order the compile met them.
 */
const compileErrorMessage = (reason: CompileReason): string => {
	const at = located(reason)
	switch (at.kind) {
		case "artifact":
			return `${reason._tag} in the ${at.reason.artifact}${at.reason.at.length === 0 ? "" : ` at ${formatPath(at.reason.at)}`}: ${compileReasonText(reason)}`
		case "keys":
			return `${reason._tag} at ${formatLoc(at.reason.keys[0].at)}: ${compileReasonText(reason)}`
		case "sourced": {
			const text = `${reason._tag} at ${formatLoc(at.reason.at)}: ${compileReasonText(reason)}`
			return at.reason._tag === "IdentifierCollision"
				? `${text} (colliding with ${formatLoc(at.reason.other)})`
				: text
		}
	}
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

/** The same reason found inside the value at `path`: its location's path, each key's of a refusal of keys, prefixed by
 * `path`. */
const relocated = (reason: CompileReason, path: Path): CompileReason => {
	const at = located(reason)
	switch (at.kind) {
		case "artifact":
			return { ...at.reason, at: [...path, ...at.reason.at] }
		case "keys":
			return {
				...at.reason,
				keys: mapNonEmpty(at.reason.keys, (k) => ({ ...k, at: prefixedLoc(path, k.at) }))
			}
		case "sourced":
			return { ...at.reason, at: prefixedLoc(path, at.reason.at) }
	}
}

/** The user's schema or program value, refused at `at` for `refusal`, a rule the types name too. */
export const ruleRefused = (at: SourceLoc, refusal: Refused): CompileError =>
	new CompileError({ _tag: "Refused", at, refusal })

/**
 * The refusal of a statement at `at` that names the relation `name`, which no level of the schema declares: located at
 * the statement, under a label that names the relation, so a statement over several relations says which one it is.
 */
export const undeclaredRelation = (at: SourceLoc, name: string): CompileReason => ({
	_tag: "Refused",
	at: sitedLoc(`the relation ${name} of ${at.label}`, at.path, at.site),
	refusal: "a statement names a relation no level of the schema declares"
})

/** The user's schema or program value, malformed at `at`: `what` is the rule it breaks. */
export const malformedDescription = (at: SourceLoc, what: string): CompileError =>
	new CompileError({ _tag: "MalformedDescription", at, what })

/** What grizzle reads back, `artifact`, malformed at the path `at`: `what` is the rule it breaks. */
export const malformedArtifact = (artifact: Artifact, at: Path, what: string): CompileError =>
	new CompileError({ _tag: "MalformedArtifact", artifact, at, what })

/**
 * A file grizzle reads back, `file`, refused for the format its format member records, `value` as read (undefined
 * where it records none): ArtifactFormat at that member.
 */
export const formatRefused = (file: FormattedFile, value: unknown): CompileError =>
	new CompileError({
		_tag: "ArtifactFormat",
		artifact: file,
		at: [formatKey],
		recorded: recordedFormat(value),
		expected: formatOf[file]
	})

/** A capability the compiler does not have, refused at `at`. */
export const unsupported = (at: SourceLoc, capability: string): CompileError =>
	new CompileError({ _tag: "UnsupportedOperation", at, capability })

/** A drop no declaration names, at `at`. */
export const undeclaredDrop = (at: SourceLoc, dropped: Named): CompileError =>
	new CompileError({ _tag: "UndeclaredDrop", at, dropped })

/** A declaration the previous snapshot and the target do not bear out, at `at`. */
export const misdeclared = (at: SourceLoc, misdeclaration: Misdeclaration): CompileError =>
	new CompileError({ _tag: "Misdeclared", at, misdeclared: misdeclaration })

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
	const reason = located(e.reason)
	switch (reason.kind) {
		case "artifact":
			return e
		case "keys":
			return new CompileError({
				...reason.reason,
				keys: mapNonEmpty(reason.reason.keys, (k) => ({ ...k, at }))
			})
		case "sourced":
			return new CompileError({ ...reason.reason, at })
	}
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
	"numericNaN",
	"numericBound",
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
	"inetSyntax",
	"cidrSyntax",
	"cidrHostBits",
	"textType",
	"textNul",
	"textSurrogate",
	"bytesType",
	"bytesLength",
	"bytesCollision",
	"bytesChanged",
	"bytesLiteral",
	"sha256Value",
	"sha256Syntax",
	"codeHandle",
	"codeSubset",
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
	"searchDocumentForm",
	"searchDocumentSize",
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
 * - `SpanKeyChange`: a put's insert into a span primary key of `relation` met an occupant at the key a concurrent
 *   transaction committed after the put deleted the fact at the key.
 * - `UnseenOccupant`: an insert into `relation` raised a unique violation on `constraint`, a unique object besides its
 *   primary key, from an occupant this transaction's snapshot did not see: a concurrent transaction's, committed or in
 *   flight.
 */
export type TransientReason =
	| { readonly _tag: "SerializationFailure" }
	| { readonly _tag: "Deadlock" }
	| { readonly _tag: "PutTargetConflict"; readonly relation: string }
	| { readonly _tag: "SpanKeyChange"; readonly relation: string }
	| {
			readonly _tag: "UnseenOccupant"
			readonly relation: string
			readonly constraint: ConstraintName
	  }
export type TransientTag = TransientReason["_tag"]

/** Each transient refusal's tag, under itself: the roster is complete by its type. */
const transientTagRoster: { readonly [T in TransientTag]: T } = {
	SerializationFailure: "SerializationFailure",
	Deadlock: "Deadlock",
	PutTargetConflict: "PutTargetConflict",
	SpanKeyChange: "SpanKeyChange",
	UnseenOccupant: "UnseenOccupant"
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
