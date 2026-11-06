import {
	type ClaimRule,
	claimRuleText,
	type DerivedRefusal,
	derivedRefusalText,
	type GeneratedRule,
	generatedRuleText,
	type KeyFault,
	keyFaultText,
	type LoginRule,
	loginRuleText,
	type RecursionRefusal,
	type RoleRule,
	recursionRefusalText,
	roleRuleText
} from "#compiler/core/causes.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { formatLoc, formatPath, prefixedLoc, type SourceLoc } from "#compiler/core/loc.ts"

/** A path inside a value: object keys and array indices. */
type Path = ReadonlyArray<string | number>

/**
 * What grizzle reads back that it wrote, a MalformedArtifact's source: the snapshot (deploy/snapshot, the shell's
 * snapshot.json), the admission manifest, a migration folder's files and meta.json, the migrations ledger's rows, a
 * page's cursor token, and the canonical or fingerprinted value a digest is taken over.
 */
export type Artifact =
	| "snapshot"
	| "manifest"
	| "folder"
	| "meta"
	| "ledger"
	| "cursor"
	| "canonical"
	| "fingerprint"

/**
 * The measure of a pattern's automaton (text/refinement.ts analyzeText) that puts it past PostgreSQL's regex compile
 * space, with the facts it states, each bound a core/limits.ts constant:
 * - `positions`: `needed` NFA positions once counted repetitions are written out, past `limit` (regexMaxPositions);
 * - `anchors`: `needed` anchor positions written out, past `limit` (regexMaxAnchors);
 * - `anchorWeight`: `anchors` anchors over `positions` positions, a product past `limit` (regexMaxAnchorWeight);
 * - `closurePairs`: more than `limit` pairs of NFA states joined by empty paths (regexMaxClosurePairs), counted only
 *   until they pass it;
 * - `anchorLoop`: an unbounded repetition of a body that can match zero-width through an anchor, which PostgreSQL
 *   breaks by cloning states exponentially and which is too large to rewrite as a loop of consuming matches.
 */
export type RegexSpaceMeasure =
	| { readonly kind: "positions"; readonly limit: number; readonly needed: number }
	| { readonly kind: "anchors"; readonly limit: number; readonly needed: number }
	| {
			readonly kind: "anchorWeight"
			readonly limit: number
			readonly anchors: number
			readonly positions: number
	  }
	| { readonly kind: "closurePairs"; readonly limit: number }
	| { readonly kind: "anchorLoop" }

const regexSpaceText = (measure: RegexSpaceMeasure): string => {
	switch (measure.kind) {
		case "positions":
			return `writes out to ${measure.needed} NFA positions, more than ${measure.limit}`
		case "anchors":
			return `writes out ${measure.needed} anchors, more than ${measure.limit}`
		case "anchorWeight":
			return `writes out ${measure.anchors} anchors over ${measure.positions} NFA positions, a product of more than ${measure.limit}`
		case "closurePairs":
			return `joins more than ${measure.limit} pairs of NFA states by empty paths`
		case "anchorLoop":
			return "repeats without bound a body that can match zero-width through an anchor, too large to write as a loop of consuming matches"
	}
}

/**
 * The bound a ResourceBound crossed, with the facts it states:
 * - `regexCompileSpace`: the pattern `pattern`, which `measure` puts past PostgreSQL's regex compile space;
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
 *   (ir/scalar.ts numericMaxIntegerDigits), where PostgreSQL's numeric arithmetic would raise;
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
			return `${bound.pattern} ${regexSpaceText(bound.measure)}: past grizzle's measure of PostgreSQL's regex compile space (REG_MAX_COMPILE_SPACE), beyond which PostgreSQL refuses a pattern as "regular expression is too complex"; write a smaller pattern, or bound the text's length with Compute.charLength in a contract predicate`
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
 * holds, power's domain, width_bucket's domain, a parse's lexical form.
 */
export type PreconditionKind =
	| "nonzero"
	| "nonnegative"
	| "finite"
	| "fits"
	| "contract"
	| "powerDomain"
	| "bucketDomain"
	| "lexical"

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
		case "powerDomain":
			return `${operand} lies where power is defined and in range`
		case "bucketDomain":
			return `${operand} lies where width_bucket is defined`
		case "lexical":
			return `${operand} is a member of its target's lexical form`
	}
}

/**
 * A relation access a role does not hold, an OutsideRole's: a read of a relation of the role's base the role does not
 * hold (`base` naming the base); a write of a relation outside its write list; a refresh of one outside its refresh
 * list; or a program over the role's base, which is one only for a role holding every relation of it whole.
 */
export type RoleAccess =
	| { readonly kind: "read"; readonly relation: string; readonly base: string }
	| { readonly kind: "write"; readonly relation: string }
	| { readonly kind: "refresh"; readonly relation: string }
	| { readonly kind: "wholeBase"; readonly base: string }

const accessText = (role: string, access: RoleAccess): string => {
	switch (access.kind) {
		case "read":
			return `a relation role ${role} holds; ${access.relation} is a relation of its base ${access.base} outside it`
		case "write":
			return `a write in role ${role}'s write list; ${access.relation} is outside it`
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
 * - `MalformedDescription`: the user's schema or program value is malformed: `what` is the rule it breaks.
 * - `MalformedArtifact`: what grizzle reads back (Artifact) is malformed at `at`: `what` is the rule it breaks.
 * - `UnsupportedOperation`: a capability the compiler does not have, `capability`. A new diagnostic for a missing
 *   capability is one; no variant is added for it.
 * - `UnsupportedLawFamily`: a law of a family the compiler does not lower, `capability`.
 * - `LawOnDerived`: a law that names the derived relation `relation`.
 * - `UnrepresentableKey`: a key or index, `subject`, over `key`, with no representable index entry, for `fault`.
 * - `FoldOverProjection`: a fold whose rule matches `source` without binding every field of one of its keys, so the
 *   fold would read a projection of its facts; `key` is the key to bind.
 * - `QueriedOwnerAppend`: a put at `at` of `owner` from a query, which may insert an owner of `family`, in a ChangeSet
 *   that appends `member` to that family.
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
 * - `PartialOperation`: an operation defined only where its precondition holds, which neither the operands' bounds nor
 *   a Compute.cond around it proves: `operation` names it, `operand` the operand the precondition reads, and `guard`
 *   the Compute.cond to write, whose other branch is the caller's value for the undefined case.
 * - `RecursionRefused`: recursion admission refused (check/recursion), for `cause`.
 * - `DerivedRefused`: derived analysis refused a derived relation (analysis/derived), for `cause`.
 * - `RoleRefused`, `LoginRefused`, `ContextRefused`: a role, a login or a context breaks the rule `rule`.
 * - `RoleNameTooLong`: a login's or a role's PostgreSQL role, `role` (`<schema>__<name>`), is longer than PostgreSQL's
 *   `limit` bytes.
 * - `GeneratedRefused`: generated field `field` of `relation` breaks the rule `rule`.
 * - `UndeclaredDrop`: a migration drops `dropped`, which the previous installation holds and the schema no longer
 *   declares, and no declaration of the draft (`--rename`, `--drop`) names it.
 */
export type CompileReason =
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
	| { readonly _tag: "LawOnDerived"; readonly at: SourceLoc; readonly relation: string }
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
			readonly _tag: "QueriedOwnerAppend"
			readonly at: SourceLoc
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
			readonly guard: string
	  }
	| { readonly _tag: "RecursionRefused"; readonly at: SourceLoc; readonly cause: RecursionRefusal }
	| { readonly _tag: "DerivedRefused"; readonly at: SourceLoc; readonly cause: DerivedRefusal }
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
export type CompileReasonTag = CompileReason["_tag"]

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
export const foldOverProjectionText = (source: string, key: ReadonlyArray<string>): string =>
	`a fold reads each fact it matches once, by its key, and this match of ${source} binds none of its keys: bind (${key.join(", ")}) in the match, or, to fold distinct values, match a query of them as the source`

/**
 * An owner inserted in the ChangeSet that appends to its family holds its final count and ends in its own row, since
 * PostgreSQL checks a row's CHECKs as it inserts the row, and grizzle fills them on the host from the facts the
 * ChangeSet states; a query's facts are the statement's alone, so its owner would be inserted at its starts: name the
 * two ways to state the owner first.
 */
const queriedOwnerAppendText = (
	owner: string,
	family: { readonly owner: string; readonly count: string },
	member: string
): string =>
	`a put of ${owner} from a query, which may insert an owner of the family ${family.owner}.${family.count}, in a ChangeSet that appends ${member} to that family: an inserted owner holds its final count and ends in its own row, which grizzle fills only from the facts a ChangeSet states, so state ${owner}'s facts in this ChangeSet from an array or a Stream, or put ${owner} in a ChangeSet that ChangeSet.sequence runs before the one that appends`

/** A reason whose one fact is the sentence `text`, at `at`. */
export const prose = (tag: ProseTag, at: SourceLoc, text: string): CompileReason =>
	tag === "MalformedDescription"
		? { _tag: tag, at, what: text }
		: { _tag: tag, at, capability: text }

/** The sentence a reason states after its tag and location. */
export const compileReasonText = (reason: CompileReason): string => {
	switch (reason._tag) {
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
		case "LawOnDerived":
			return `a law names derived relation ${reason.relation}; no law names a derived relation in either direction`
		case "UnrepresentableKey":
			return keyFaultText(reason.subject, reason.key, reason.fault)
		case "FoldOverProjection":
			return foldOverProjectionText(reason.source, reason.key)
		case "QueriedOwnerAppend":
			return queriedOwnerAppendText(reason.owner, reason.family, reason.member)
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
			return `${reason.operation} is defined only where ${preconditionText(reason.precondition, reason.operand)}, which nothing here proves; guard it: ${reason.guard}`
		case "RecursionRefused":
			return recursionRefusalText(reason.cause)
		case "DerivedRefused":
			return derivedRefusalText(reason.cause)
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
	"numericOverflow",
	"numericInfinity",
	"moneyType",
	"moneyRange",
	"moneySpecial",
	"integerType",
	"integerRange",
	"floatType",
	"realOverflow",
	"realUnderflow",
	"boolType",
	"uuidSyntax",
	"dateSyntax",
	"textType",
	"textNul",
	"textSurrogate",
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
export type CodecFault = ValueFault | "nullValue" | "refinedValue"
/** A cursor token's refusal words, in the order validation checks them (codec/cursor/fault.ts). */
const cursorFaultWords = [
	"cursorType",
	"cursorOversized",
	"cursorEncoding",
	"cursorMalformed",
	"cursorGeneration",
	"cursorQuery",
	"cursorComparator",
	"cursorValue",
	"cursorTupleOversized"
] as const
export type CursorFault = (typeof cursorFaultWords)[number]
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
 * - `StaleStatement`: a server statement the session had named no longer held on its backend (26000, or 0A000 when
 *   the cached plan changed its result type after a migration). The session has forgotten the name, so the next
 *   attempt parses the statement afresh.
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
	| { readonly _tag: "StaleStatement" }
export type TransientTag = TransientReason["_tag"]

/**
 * A codec's refusal as a reason: its fault word as its tag, which is all it states (never the value), so
 * Effect.catchReason reaches each word.
 */
export interface CodecReason {
	readonly _tag: CodecFault
}

/** A cursor's refusal as a reason: its fault word as its tag, which is all it states (never the token). */
export interface CursorReason {
	readonly _tag: CursorFault
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

/**
 * A malformed, oversized, or mismatched cursor, checked on the host before any SQL: `reason` is the cursor's fault
 * (CursorReason), and its message names it.
 */
export class CursorError extends Error {
	readonly _tag = "CursorError" as const
	readonly reason: CursorReason

	constructor(reason: CursorReason) {
		super(`the cursor was refused: ${reason._tag}`)
		this.reason = reason
	}

	static {
		Object.defineProperty(this.prototype, "name", {
			value: "CursorError",
			writable: true,
			configurable: true
		})
	}

	static make(reason: CursorReason): CursorError {
		return new CursorError(reason)
	}
}

/**
 * Two facts of one relation-valued input share a key but differ in payload (the same-key refusal of host
 * normalization). It is internal, never public: the write path turns it into `invariant-rejected` with the key law and
 * a witness of the key values, so it carries the key values positionally beside the key field names.
 */
export class KeyConflict extends Error {
	readonly _tag = "KeyConflict" as const
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly values: ReadonlyArray<unknown>

	constructor(conflict: {
		readonly relation: string
		readonly fields: ReadonlyArray<string>
		readonly values: ReadonlyArray<unknown>
	}) {
		super()
		this.relation = conflict.relation
		this.fields = conflict.fields
		this.values = conflict.values
	}

	static {
		Object.defineProperty(this.prototype, "name", {
			value: "KeyConflict",
			writable: true,
			configurable: true
		})
	}

	static make(conflict: {
		readonly relation: string
		readonly fields: ReadonlyArray<string>
		readonly values: ReadonlyArray<unknown>
	}): KeyConflict {
		return new KeyConflict(conflict)
	}
}
