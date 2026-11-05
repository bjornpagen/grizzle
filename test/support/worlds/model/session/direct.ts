import { Array as Arr, Option, Record, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type HostLaw,
	type HostSelector,
	isResidual,
	isSpan,
	sameValue,
	selectorValues,
	valueText
} from "#test/pg/laws/families/model.ts"
import { nextDraw, withSerial } from "#test/support/worlds/model/draws.ts"
import {
	entryRows,
	evaluateRules,
	isMember,
	writableSupplier
} from "#test/support/worlds/model/host.ts"
import {
	holdsColumn,
	holdsTable,
	membershipOf,
	rowSecured
} from "#test/support/worlds/model/session/catalog.ts"

import {
	checkLaw,
	encodingState,
	factCells,
	installedCheck,
	type LawDomain,
	lawDomainOf,
	rowFault
} from "#test/support/worlds/model/session/domains.ts"

import {
	brokenAt,
	commitRefusals,
	type Refusal,
	statementRefusals,
	witnessFor
} from "#test/support/worlds/model/session/laws.ts"

import {
	closedDirect,
	directSessionAt,
	entryContexts,
	roleEntryOf,
	factsIn,
	loginOf,
	relationSpecOf,
	roleOf,
	seenThrough,
	withSession
} from "#test/support/worlds/model/session/state.ts"

import {
	filterReadsStored,
	keysOf,
	probeOf,
	uniqueProbeOf,
	uniqueReads,
	updatableFields,
	type Written,
	writtenAt,
	writtenNamed
} from "#test/support/worlds/model/session/writes.ts"

import type {
	BaseSpec,
	Branch,
	ContextFacts,
	DirectSessionState,
	DirectStart,
	DirectStatement,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	HostFact,
	HostState,
	InstallSpec,
	ModelState,
	RoleRef,
	RoleSpec,
	Rule,
	Source,
	SqlState,
	HostValue,
	ViewFilter,
	Witness,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
/**
 * What PostgreSQL reads from a direct writer's claims setting (packages/engine/src/sql/print.ts claimsDocument,
 * contextClaims): a claims document, holding the facts of the contexts whose member holds exactly their fields, each
 * value admitted by its field's base type, and the contexts whose member holds other keys or a value its type refuses,
 * each with the SQLSTATEs a read of it refuses with; or a text that is no claims document, which every read of a claim
 * refuses (22P02).
 */
type ClaimsRead =
	| {
			readonly kind: "document"
			readonly facts: ContextFacts
			readonly refused: ReadonlyMap<string, Arr.NonEmptyReadonlyArray<SqlState>>
	  }
	| { readonly kind: "malformed" }

/** The claims a session reads when it holds no claims document: no fact, no refused context. */
const noClaims: ClaimsRead = { kind: "document", facts: {}, refused: new Map() }

/** JSON's insignificant whitespace (RFC 8259): space, tab, line feed and carriage return. */
const isJsonSpace = (code: number): boolean =>
	code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

/** The character a two-character JSON escape stands for, by the character after the backslash; none for no escape. */
const jsonEscapes: Record.ReadonlyRecord<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t"
}

/**
 * A claims document as PostgreSQL's context source admits a setting (claimsDocument, contextClaims): a JSON object
 * without a repeated key, every member an object without a repeated key, every value of which is a string jsonb's input
 * takes (no lone surrogate, no `\u0000` escape), its members and their values by key; none for any other text, invalid
 * JSON included. A repeated key is judged after de-escaping, as PostgreSQL's unique-key check and jsonb compare keys.
 */
const claimsDocumentOf = (
	text: string
): Option.Option<ReadonlyMap<string, ReadonlyMap<string, string>>> => {
	let at = 0
	const skip = (): void => {
		while (Option.exists(Str.charCodeAt(at)(text), isJsonSpace)) {
			at += 1
		}
	}
	const take = (punctuation: string): boolean => {
		skip()
		if (text[at] !== punctuation) {
			return false
		}
		at += 1
		return true
	}
	const string = (): string | undefined => {
		if (!take('"')) {
			return undefined
		}
		let out = ""
		for (;;) {
			const code = Str.charCodeAt(at)(text)
			if (Option.isNone(code) || code.value < 0x20) {
				return undefined
			}
			if (code.value === 0x22) {
				at += 1
				return out.isWellFormed() ? out : undefined
			}
			if (code.value !== 0x5c) {
				out += String.fromCharCode(code.value)
				at += 1
				continue
			}
			const escape = text[at + 1]
			if (escape === "u") {
				const hex = Str.slice(at + 2, at + 6)(text)
				if (!regex("^[0-9a-fA-F]{4}$").test(hex) || Number.parseInt(hex, 16) === 0) {
					return undefined
				}
				out += String.fromCharCode(Number.parseInt(hex, 16))
				at += 6
				continue
			}
			const escaped = escape === undefined ? Option.none() : Record.get(jsonEscapes, escape)
			if (Option.isNone(escaped)) {
				return undefined
			}
			out += escaped.value
			at += 2
		}
	}
	const object = <V>(value: () => V | undefined): ReadonlyMap<string, V> | undefined => {
		if (!take("{")) {
			return undefined
		}
		const members = new Map<string, V>()
		if (take("}")) {
			return members
		}
		for (;;) {
			const key = string()
			if (key === undefined || members.has(key) || !take(":")) {
				return undefined
			}
			const member = value()
			if (member === undefined) {
				return undefined
			}
			members.set(key, member)
			if (take("}")) {
				return members
			}
			if (!take(",")) {
				return undefined
			}
		}
	}
	const document = object(() => object(string))
	skip()
	return document === undefined || at !== text.length ? Option.none() : Option.some(document)
}

/**
 * A hand-set claim's value, which its field's base type admits: a text field's text. The generators hand-set an
 * admitted claim of no other type (invalid/claims.ts malformedTexts), so another is a defect of the run, never read as
 * some other value.
 */
const handSetValue = (domain: FieldDomain, text: string): HostValue => {
	if (domain.kind === "text") {
		return text
	}
	throw new Error(
		`a hand-set claim ${text} of a ${domain.kind} field, which the model does not read`
	)
}

/**
 * The claims PostgreSQL reads from a setting's text: the empty text holds none (claimsDocument's first branch); a text
 * that is no claims document is malformed; a claims document holds, for each context of the installation it has a
 * member for, the context's fact where the member holds exactly the context's fields and its type admits each value
 * (literalFault), or else the SQLSTATEs a read of the context refuses with: 22P02 for other keys (contextClaims), a
 * value's own fault otherwise, any of which the read may meet first. A member of no context of the installation is
 * never read.
 */
const textRead = (base: BaseSpec, text: string): ClaimsRead => {
	if (text === "") {
		return noClaims
	}
	const document = claimsDocumentOf(text)
	if (Option.isNone(document)) {
		return { kind: "malformed" }
	}
	const facts: Array<readonly [string, HostFact]> = []
	const refused = new Map<string, Arr.NonEmptyReadonlyArray<SqlState>>()
	for (const context of base.contexts) {
		const member = document.value.get(context.name)
		if (member === undefined) {
			continue
		}
		const cells = Arr.flatMap(context.fields, (field) => {
			const claim = member.get(field.name)
			return claim === undefined ? [] : [{ field, claim }]
		})
		if (cells.length !== context.fields.length || member.size !== context.fields.length) {
			refused.set(context.name, ["22P02"])
			continue
		}
		const [fault, ...faults] = Arr.dedupe(
			Arr.flatMap(cells, ({ field, claim }) => {
				const f = literalFault(field.domain, claim)
				return f === undefined ? [] : [f]
			})
		)
		if (fault !== undefined) {
			refused.set(context.name, [fault, ...faults])
			continue
		}
		facts.push([
			context.name,
			Record.fromEntries(
				Arr.map(
					cells,
					({ field, claim }) => [field.name, handSetValue(field.domain, claim)] as const
				)
			)
		])
	}
	return { kind: "document", facts: Record.fromEntries(facts), refused }
}

const claimsRead = (base: BaseSpec, session: DirectSessionState): ClaimsRead => {
	if (session.claims.kind === "none") {
		return noClaims
	}
	const setting = session.claims.setting
	return setting.kind === "facts"
		? { kind: "document", facts: setting.facts, refused: new Map() }
		: textRead(base, setting.text)
}

/** The role a direct writer has taken on, or undefined while it acts as its login. */
const currentRole = (state: ModelState, session: DirectSessionState): RoleSpec | undefined =>
	session.current.kind === "role" ? roleOf(state.install, session.current.role) : undefined

/** Whether an entry is a closed roster held whole, which has no view: every query reads its facts as literals. */
const closedWhole = (install: InstallSpec, entry: EntrySpec): boolean =>
	entry.kind === "whole" && Arr.some(install.base.closed, (c) => c.name === entry.relation)

/** A role's relation grizzle installs a view for: an entry of an installed role, but a closed roster held whole. */
export const installedView = (
	install: InstallSpec,
	role: string,
	relation: string
): EntrySpec | undefined => {
	const installed = roleOf(install, role)
	const entry = installed === undefined ? undefined : roleEntryOf(installed, relation)
	return entry === undefined || closedWhole(install, entry) ? undefined : entry
}

/**
 * When a judgment of a row reads the claims, as PostgreSQL plans it: never (the rule reads no context); first, before
 * anything can drop the row, so every plan reads them once a row is judged; or after joins and conditions a plan may run
 * first, so a plan that drops the row before them reads no claim (checked on the dev cluster: Note's policy, whose
 * filter function joins Doc, refused malformed claims over an empty Doc at the suites' table sizes, and judged the row
 * without them, 42501, under statistics of 200000 Doc rows).
 */
type ClaimsOrder = "none" | "first" | "planned"

/**
 * The order in which a rule judging one row reads the claims (ClaimsOrder), the row read at its occurrence `row` (a
 * policy's, filter function's or key probe's VALUES of the row; a view's scan of its one stored relation): first exactly
 * when the rule reads a context and, beside the row's occurrence, matches or negates nothing but contexts, and restricts
 * that occurrence by nothing the claims take no part in (a literal or a repeated variable in it, a comparison of its own
 * terms and literals), so the row's side holds the row whatever is stored and every plan joins it to the claims.
 */
const claimsOrder = (rule: Rule, row: number): ClaimsOrder => {
	if (entryContexts({ kind: "query", rules: [rule] }).size === 0) {
		return "none"
	}
	const own = rule.matches[row]
	const others = [...Arr.remove(rule.matches, row), ...rule.negations.flat()]
	if (own === undefined || !Arr.every(others, (o) => o.source.kind === "context")) {
		return "planned"
	}
	const terms = Record.values(own.fields)
	const ownVars = Arr.flatMap(terms, (t) => (t.kind === "var" ? [t.name] : []))
	const restricted =
		Arr.some(terms, (t) => t.kind === "literal") ||
		new Set(ownVars).size < ownVars.length ||
		Arr.some(rule.comparisons, (c) =>
			Arr.every(
				[c.left, c.right],
				(t) => t.kind === "literal" || (t.kind === "var" && ownVars.includes(t.name))
			)
		)
	return restricted ? "planned" : "first"
}

/**
 * Row security as a role meets it on a table: `open` where it admits every row (the table has none enabled, since no
 * role of the installation writes it through a query entry, or the role's policy is a whole entry's); the membership of
 * the query entry the role's policy is defined by; or `none` where it is enabled and the role holds no policy on the
 * table (it writes the table through no entry, so only a tampered grant reaches it), so no row is the role's.
 */
type Policy =
	| { readonly kind: "open" }
	| {
			readonly kind: "membership"
			readonly role: string
			readonly entry: string
			readonly claims: ClaimsOrder
			/** The contexts the membership reads. */
			readonly contexts: ReadonlySet<string>
	  }
	| { readonly kind: "none" }

/**
 * How a judgment reads the claims: in an order (ClaimsOrder), and the contexts it reads, whose faults (faultsOf) it may
 * meet as it reads them.
 */
interface ClaimsJudgment {
	readonly order: ClaimsOrder
	readonly contexts: ReadonlySet<string>
}

/** The row security a role meets on a table. */
const policyOf = (state: ModelState, role: string, relation: string): Policy => {
	const spec = roleOf(state.install, role)
	const w = spec === undefined ? undefined : writtenAt(state.install.base, spec, relation)
	if (w?.kind === "whole") {
		return { kind: "open" }
	}
	if (w !== undefined) {
		const supplied = writableSupplier(state.install.base, w.rules)
		return {
			kind: "membership",
			role,
			entry: w.entry,
			claims: supplied === undefined ? "none" : claimsOrder(supplied.rule, supplied.supplier),
			contexts: entryContexts({ kind: "query", rules: w.rules })
		}
	}
	return Arr.some(
		state.install.roles,
		(r) => writtenAt(state.install.base, r, relation)?.kind === "query"
	)
		? { kind: "none" }
		: { kind: "open" }
}

/** The fields a role relation's view has: a query entry's head; a whole entry's relation's, a roster's `id`. */
const viewFields = (install: InstallSpec, entry: EntrySpec): ReadonlyArray<string> => {
	if (entry.kind === "query") {
		return Record.keys(entry.rules[0].head)
	}
	const base = install.base
	const relation = relationSpecOf(base, entry.relation)
	const derived = Option.getOrUndefined(
		Arr.findFirst(base.derived, (d) => d.name === entry.relation)
	)
	if (relation !== undefined) {
		return Arr.map(relation.fields, (f) => f.name)
	}
	return derived === undefined ? ["id"] : Record.keys(derived.rules[0].head)
}

/** Whether a fact matches a key's values at every field the key names. */
const atKey = (fact: HostFact, key: HostFact): boolean =>
	Arr.every(Record.toEntries(key), ([f, v]) => Record.has(fact, f) && sameValue(fact[f], v))

/**
 * The statements a direct writer's start sends after its BEGIN (DirectStart): SET ROLE to the role it begins as, none as
 * its login; then, when it sets claims, `grizzle.claims`.
 */
export const startStatements = (start: DirectStart): ReadonlyArray<DirectStatement> => {
	const role: ReadonlyArray<DirectStatement> =
		start.current.kind === "role"
			? [{ kind: "set-role", role: { kind: "own", role: start.current.role } }]
			: []
	const claims: ReadonlyArray<DirectStatement> =
		start.claims.kind === "set" ? [{ kind: "set-claims", setting: start.claims.setting }] : []
	return [...role, ...claims]
}

/**
 * A begun direct writer's start statements (startStatements), each as the writer's own statement at the session `id`:
 * opened once every one is ok; otherwise the first one's refusal, the transaction as that statement left it.
 */
export const startedBranches = (
	state: ModelState,
	id: number,
	statements: ReadonlyArray<DirectStatement>
): Arr.NonEmptyReadonlyArray<Branch> => {
	const [first, ...rest] = statements
	if (first === undefined) {
		return [{ observation: { kind: "opened", session: id, verifyCalls: 0 }, next: state }]
	}
	const session = directSessionAt(state, id)
	if (session === undefined) {
		throw new Error(`the direct writer begun at session ${id} is no open direct session`)
	}
	return Arr.flatMap(directBranches(state, id, session, first), (b) =>
		b.observation.kind === "ok" ? startedBranches(b.next, id, rest) : [b]
	)
}

/**
 * A direct SQL writer's statements (README "Direct SQL access", "Security model"), each meeting PostgreSQL in
 * the order it checks: privileges at executor start, then a table's below-SERIALIZABLE guard (a BEFORE statement
 * trigger), then the CHECK of each law domain as a row's values are cast (an UPDATE's for each row it changes), then
 * row security's check of each row, then the constraints as the row enters. A refused statement aborts the
 * transaction, and every later statement is refused until it ends.
 */
export const directBranches = (
	state: ModelState,
	id: number,
	session: DirectSessionState,
	statement: DirectStatement
): Arr.NonEmptyReadonlyArray<Branch> => {
	const base = state.install.base
	const seen = seenThrough(state, session.view)
	const go = (next: DirectSessionState): Branch => ({
		observation: { kind: "ok" },
		next: withSession(state, id, next)
	})
	const refused = (sqlstate: SqlState): Branch => ({
		observation: { kind: "refused", sqlstate },
		next: withSession(state, id, { ...session, transaction: "aborted" })
	})
	/**
	 * A statement refused by a law over the view it leaves: its SQLSTATE and identity, its witness the most the role may
	 * see (lawWitness).
	 */
	const lawRefused =
		(view: HostState) =>
		(r: Refusal): Branch => ({
			observation: {
				kind: "law-refused",
				sqlstate: r.meeting.sqlstate,
				law: r.violation.law,
				witness: lawWitness(state, session, view, r)
			},
			next: withSession(state, id, { ...session, transaction: "aborted" })
		})
	/**
	 * A statement refused by a law domain's CHECK as it casts a value: 23514 on the domain's CHECK law, its witness
	 * withheld, since a domain's CHECK reports no key.
	 */
	const domainRefused = (law: LawId): Branch => ({
		observation: { kind: "law-refused", sqlstate: "23514", law, witness: { kind: "withheld" } },
		next: withSession(state, id, { ...session, transaction: "aborted" })
	})
	const viewIs = (view: HostState): Branch => go({ ...session, view })
	if (session.transaction === "aborted") {
		return [{ observation: { kind: "refused", sqlstate: "other" }, next: state }]
	}
	const role = currentRole(state, session)
	const claims = claimsRead(base, session)
	const facts = claims.kind === "document" ? claims.facts : {}
	/** Whether a read of a context refuses: every one under a setting that is no claims document, else a refused one. */
	const faulty = (context: string): boolean =>
		claims.kind === "malformed" || claims.refused.has(context)
	/**
	 * The SQLSTATEs a judgment reading `contexts` may be refused with as it reads the claims: none where it reads no
	 * faulty context; 22P02 under a setting that is no claims document; each refused context's otherwise.
	 */
	const faultsOf = (contexts: ReadonlySet<string>): ReadonlyArray<SqlState> =>
		claims.kind === "malformed"
			? contexts.size === 0
				? []
				: ["22P02"]
			: Arr.dedupe(Arr.flatMap([...contexts], (c) => claims.refused.get(c) ?? []))
	/**
	 * A judgment reading `contexts` in `order`, as the claims make it: first only where every context it reads is faulty
	 * or holds a fact, since a plan that meets a context without a fact first reads no other claim of the judgment.
	 */
	const judging = (order: ClaimsOrder, contexts: ReadonlySet<string>): ClaimsJudgment => ({
		order:
			order === "first" && !Arr.every([...contexts], (c) => faulty(c) || Record.has(facts, c))
				? "planned"
				: order,
		contexts
	})
	/**
	 * Whether row security admits a row: its USING and WITH CHECK, judged over the transaction's view. A membership that
	 * reads a faulty context admits none: a judgment that reads it is refused (underClaims), and one a plan reaches
	 * without it dropped the row first.
	 */
	const member = (policy: Policy, fact: HostFact): boolean => {
		switch (policy.kind) {
			case "open":
				return true
			case "none":
				return false
			case "membership":
				return (
					!(policy.claims !== "none" && faultsOf(policy.contexts).length > 0) &&
					isMember(seen, policy.role, policy.entry, facts, fact)
				)
		}
	}
	/**
	 * A statement's answers as its judgments of rows read the claims (ClaimsJudgment): where they read a faulty context,
	 * refused with its faults where every plan reads it, which is where it is read first and the statement judges a row
	 * (`judgesRow`); refused, or answered as its judgments are without the claims (`then`, where member admits no row of a
	 * membership reading it), where a plan may read none; answered where none is read.
	 */
	const underClaims = (
		judgment: ClaimsJudgment,
		judgesRow: boolean,
		then: () => Arr.NonEmptyReadonlyArray<Branch>
	): Arr.NonEmptyReadonlyArray<Branch> => {
		const [fault, ...faults] = faultsOf(judgment.contexts)
		if (fault === undefined || judgment.order === "none") {
			return then()
		}
		const refusals: Arr.NonEmptyReadonlyArray<Branch> = [
			refused(fault),
			...Arr.map(faults, refused)
		]
		return judgment.order === "first" && judgesRow ? refusals : [...refusals, ...then()]
	}
	/** How a policy's judgment of a row reads the claims: only a membership reads any. */
	const policyJudgment = (policy: Policy): ClaimsJudgment =>
		policy.kind === "membership"
			? judging(policy.claims, policy.contexts)
			: { order: "none", contexts: new Set() }
	/** A table the role writes: what its table grants allow (the installation's), and the row security it meets. */
	const write = (
		relation: string
	): { readonly written: Written; readonly policy: Policy } | undefined => {
		const w = role === undefined ? undefined : writtenAt(base, role, relation)
		return role === undefined || w === undefined
			? undefined
			: { written: w, policy: policyOf(state, role.name, relation) }
	}
	const belowSerializable = session.isolation !== "serializable"
	/**
	 * Whether an UPDATE sets a serial field: its identity column is GENERATED ALWAYS, so PostgreSQL's rewriter refuses the
	 * value (428C9) before the executor checks any privilege. An INSERT naming one writes OVERRIDING SYSTEM VALUE, as
	 * README's writer does, so the value meets privileges, row security and the laws like any other.
	 */
	const namesSerial = (relation: string, fields: ReadonlyArray<string>): boolean =>
		Arr.some(
			relationSpecOf(base, relation)?.fields ?? [],
			(f) => f.domain.kind === "serial" && fields.includes(f.name)
		)
	/** The rows a delete or update targets at a key: only those row security admits. */
	const targeted = (relation: string, key: HostFact, policy: Policy): ReadonlyArray<HostFact> =>
		Arr.filter(factsIn(session.view, relation), (f) => atKey(f, key) && member(policy, f))
	/**
	 * A delete's or update's outcome as row security judges the rows it scans: it judges a row at the key; one at no key
	 * only where its plan scans the table rather than the key's index, so a key no row holds may read no claim.
	 */
	const scanned = (
		relation: string,
		key: HostFact,
		policy: Policy,
		then: () => Arr.NonEmptyReadonlyArray<Branch>
	): Arr.NonEmptyReadonlyArray<Branch> =>
		underClaims(
			policyJudgment(policy),
			Arr.some(factsIn(session.view, relation), (f) => atKey(f, key)),
			then
		)
	/** The CHECK laws of the law domains a statement's values break, each once. */
	const lawsOf = (domains: ReadonlyArray<LawDomain>): ReadonlyArray<LawId> => [
		...new Set(Arr.map(domains, (d) => checkLaw(state.names, d)))
	]
	/**
	 * A literal's base-type fault in the values a statement names: PostgreSQL's parser runs each literal's input function
	 * (22P02, 22003), before its rewriter refuses an UPDATE of a serial field (428C9), before the executor checks privileges
	 * (42501) and before any trigger (25000).
	 */
	const parseFault = (relation: string, fact: HostFact): Branch | undefined => {
		const fault = rowFault(factCells(base, relation, fact, Record.keys(fact)))
		return fault?.kind === "encoding" ? refused(encodingState(fault.fault)) : undefined
	}
	/** The first literal fault among the values of several facts a statement names. */
	const parseFaults = (relation: string, named: ReadonlyArray<HostFact>): Branch | undefined => {
		for (const fact of named) {
			const fault = parseFault(relation, fact)
			if (fault !== undefined) {
				return fault
			}
		}
		return undefined
	}
	/** The plain fields an INSERT leaves out: neither serial (the identity default's to draw) nor named. */
	const leftOut = (relation: string, fact: HostFact): ReadonlyArray<FieldSpec> =>
		Arr.filter(
			relationSpecOf(base, relation)?.fields ?? [],
			(f) => f.domain.kind !== "serial" && !Record.has(fact, f.name)
		)
	/**
	 * What an INSERT's row meets as PostgreSQL projects it, past its literals: the CHECK of each law domain a value breaks
	 * and of each law domain a field it leaves out has (the NULL that stands for the field is cast to its domain, and
	 * every CHECK holds only on a value), in an order the model leaves open.
	 */
	const castRefusals = (
		relation: string,
		fact: HostFact
	): Arr.NonEmptyReadonlyArray<Branch> | undefined => {
		const fault = rowFault(factCells(base, relation, fact, Record.keys(fact)))
		const nulls = Arr.flatMap(leftOut(relation, fact), (f) => {
			const domain = lawDomainOf(f.domain)
			const law = domain === undefined ? undefined : installedCheck(state.names, domain)
			return law === undefined ? [] : [law]
		})
		const [check, ...more] = [
			...new Set([...(fault?.kind === "checks" ? lawsOf(fault.domains) : []), ...nulls])
		]
		return check === undefined ? undefined : [domainRefused(check), ...Arr.map(more, domainRefused)]
	}
	/**
	 * NOT NULL on a field of no law domain an INSERT leaves out: PostgreSQL checks it among the row's constraints, after
	 * row security's WITH CHECK and before the row's CHECKs.
	 */
	const notNull = (relation: string, fact: HostFact): Branch | undefined =>
		leftOut(relation, fact).length > 0 ? refused("other") : undefined
	/**
	 * The row CHECKs a proposed row breaks by itself: PostgreSQL checks them as the row enters, after row security's
	 * check and before an ON CONFLICT arbiter looks for a fact the row conflicts with.
	 */
	const rowChecks = (relation: string, fact: HostFact): ReadonlyArray<Refusal> => {
		const alone: HostState = new Map(
			Arr.map(base.relations, (r) => [r.name, r.name === relation ? [fact] : []] as const)
		)
		return Arr.filter(
			brokenAt(state.host, alone, "statement"),
			(r) => r.meeting.sqlstate === "23514"
		)
	}
	const judged = (after: HostState): Arr.NonEmptyReadonlyArray<Branch> => {
		const [first, ...rest] = statementRefusals(state.host, after)
		return first === undefined
			? [viewIs(after)]
			: [lawRefused(after)(first), ...Arr.map(rest, lawRefused(after))]
	}
	/** Whether the transaction's view holds a fact of an occurrence's stored relation, as of a derived one's refresh. */
	const holdsFact = (source: Source): boolean =>
		(source.kind === "derived"
			? (seen.derived[source.name] ?? [])
			: factsIn(session.view, source.name)
		).length > 0
	/** The contexts an arm of a query entry reads. */
	const armContexts = (rule: Rule): ReadonlySet<string> =>
		entryContexts({ kind: "query", rules: [rule] })
	/**
	 * A view's reading of the claims (ClaimsJudgment), over the arms reading a faulty context, whose contexts it reads:
	 * first where such an arm scans one stored relation, joined to nothing but contexts and restricted by nothing else,
	 * that holds a fact, and every context it reads is faulty or holds a fact; planned where such an arm reads them
	 * otherwise; none where no arm reads a faulty context.
	 */
	const viewJudgment = (entry: EntrySpec): ClaimsJudgment => {
		const faultyArms =
			entry.kind === "whole"
				? []
				: Arr.filter(entry.rules, (rule) => faultsOf(armContexts(rule)).length > 0)
		const contexts = new Set(Arr.flatMap(faultyArms, (rule) => [...armContexts(rule)]))
		if (faultyArms.length === 0) {
			return { order: "none", contexts }
		}
		const first = Arr.some(faultyArms, (rule) => {
			const stored = Arr.filter(
				Arr.map(rule.matches, (o, i) => ({ o, i })),
				({ o }) => o.source.kind === "ordinary" || o.source.kind === "derived"
			)
			const [only, ...more] = stored
			return (
				only !== undefined &&
				more.length === 0 &&
				judging(claimsOrder(rule, only.i), armContexts(rule)).order === "first" &&
				holdsFact(only.o.source)
			)
		})
		return { order: first ? "first" : "planned", contexts }
	}
	/**
	 * The rows of a query entry's arms that read no faulty context, under the facts the claims hold: all a plan reading no
	 * faulty claim returns, since an arm's row needs every context it reads.
	 */
	const unfaultedRows = (rules: Arr.NonEmptyReadonlyArray<Rule>): ReadonlyArray<HostFact> => {
		const [arm, ...arms] = Arr.filter(rules, (r) => faultsOf(armContexts(r)).length === 0)
		return arm === undefined
			? []
			: evaluateRules(base, [arm, ...arms], seen.reality, seen.derived, facts)
	}
	/**
	 * A role's view as PostgreSQL resolves its name when a statement is analyzed, for a select and a PREPARE alike: the
	 * role's schema must exist (3F000 for a role the installation does not hold), the current role must hold USAGE on it,
	 * which only the role itself does (42501), and grizzle must install the view (installedView; 42P01 for a closed roster
	 * held whole, which has none).
	 */
	const viewNamed = (
		owner: string,
		relation: string
	):
		| { readonly kind: "refused"; readonly branch: Branch }
		| { readonly kind: "view"; readonly entry: EntrySpec } => {
		if (roleOf(state.install, owner) === undefined) {
			return { kind: "refused", branch: refused("other") }
		}
		if (role?.name !== owner) {
			return { kind: "refused", branch: refused("42501") }
		}
		const entry = installedView(state.install, owner, relation)
		return entry === undefined
			? { kind: "refused", branch: refused("other") }
			: { kind: "view", entry }
	}
	/**
	 * A read of a role's view (README "Security model"): only the role itself reads its views, in its own schema; a closed
	 * whole entry has no view; a predicate naming a field the view lacks is refused as the statement is analyzed. The view
	 * reads faulty claims as its judgment says (viewJudgment); a plan that reads none returns the rows of its arms that
	 * read no faulty context (unfaultedRows). A raising predicate the reader adds runs only on the view's own rows: a query
	 * entry's view is a security barrier, and a whole entry's hides no row.
	 */
	const viewRead = (
		owner: string,
		relation: string,
		filter: ViewFilter
	): Arr.NonEmptyReadonlyArray<Branch> => {
		const named = viewNamed(owner, relation)
		if (named.kind === "refused") {
			return [named.branch]
		}
		const entry = named.entry
		if (filter.kind === "raise-on" && !viewFields(state.install, entry).includes(filter.field)) {
			return [refused("other")]
		}
		const judgment = viewJudgment(entry)
		return underClaims(judgment, true, () => {
			const rows =
				entry.kind === "query" && judgment.order !== "none"
					? unfaultedRows(entry.rules)
					: entryRows(seen, owner, relation, facts)
			if (
				filter.kind === "raise-on" &&
				Arr.some(rows, (r) => sameValue(r[filter.field], filter.value))
			) {
				return [refused("other")]
			}
			return [{ observation: { kind: "rows", rows }, next: state }]
		})
	}
	/**
	 * A read of a base table: only one the role writes, every fact through a whole entry and its members through a query
	 * entry, as row security filters; a raising predicate the reader adds runs only on those, row security's qual first.
	 */
	const tableRead = (relation: string, filter: ViewFilter): Arr.NonEmptyReadonlyArray<Branch> => {
		const at = write(relation)
		if (at === undefined) {
			return [refused("42501")]
		}
		const spec = relationSpecOf(base, relation)
		const fields: ReadonlyArray<string> =
			spec === undefined ? [] : Arr.map(spec.fields, (f) => f.name)
		if (filter.kind === "raise-on" && !fields.includes(filter.field)) {
			return [refused("other")]
		}
		const all = factsIn(session.view, relation)
		const rows = Arr.filter(all, (f) => member(at.policy, f))
		const answer: Branch =
			filter.kind === "raise-on" && Arr.some(rows, (r) => sameValue(r[filter.field], filter.value))
				? refused("other")
				: { observation: { kind: "rows", rows }, next: state }
		return underClaims(policyJudgment(at.policy), all.length > 0, () => [answer])
	}
	/**
	 * A call's body once it executes, as it reads the claims: a filter function judges its arguments as its entry's policy
	 * judges a row, in the membership's order (claimsOrder, planned wherever a filter function exists, since it joins a
	 * stored relation); a key probe judges the membership of each row of its target at the key in the transaction's view
	 * (physical/ddl/roles.ts: equal at each field, overlapping at a span field), so it reads no claim where no row is at
	 * the key, and a unique probe of each row its index holds equal at the index's fields, where the arguments lie in
	 * the index's predicate too. A plan that reads none answers. An advance function reads no claims, and no role
	 * executes a law's.
	 */
	const executed = (
		fn: WorldFunction,
		args: ReadonlyArray<HostValue>
	): Arr.NonEmptyReadonlyArray<Branch> => {
		if (fn.kind !== "filter" && fn.kind !== "key-probe" && fn.kind !== "unique-probe") {
			return [go(session)]
		}
		const owner = roleOf(state.install, fn.role)
		const w = owner === undefined ? undefined : writtenNamed(base, owner, fn.entry)
		const supplied = w?.kind === "query" ? writableSupplier(base, w.rules) : undefined
		const order = judging(
			supplied === undefined ? "none" : claimsOrder(supplied.rule, supplied.supplier),
			w?.kind === "query" ? entryContexts({ kind: "query", rules: w.rules }) : new Set()
		)
		if (fn.kind === "filter") {
			return underClaims(order, true, () => [go(session)])
		}
		if (fn.kind === "unique-probe") {
			const probed = owner === undefined ? undefined : uniqueProbeOf(base, owner, fn)
			const reads = probed === undefined ? [] : uniqueReads(base, probed.target, probed.unique)
			/** The arguments as a fact of the index's fields, in parameter order. */
			const given: HostFact = Record.fromEntries(
				Arr.flatMap(reads, (f, i): ReadonlyArray<readonly [string, HostValue]> => {
					const arg = args[i]
					return arg === undefined ? [] : [[f, arg]]
				})
			)
			const within = (fact: HostFact): boolean =>
				probed !== undefined &&
				Arr.every(Record.toEntries(probed.unique.where), ([f, v]) => sameValue(fact[f], v))
			const atIndex =
				probed !== undefined &&
				within(given) &&
				Arr.some(
					factsIn(session.view, probed.target),
					(fact) =>
						within(fact) && Arr.every(probed.unique.fields, (f) => sameValue(fact[f], given[f]))
				)
			return atIndex ? underClaims(order, true, () => [go(session)]) : [go(session)]
		}
		const probe = owner === undefined ? undefined : probeOf(base, owner, fn)
		const fields = probe === undefined ? undefined : relationSpecOf(base, probe.target)?.fields
		const atProbe =
			probe !== undefined &&
			fields !== undefined &&
			Arr.some(factsIn(session.view, probe.target), (fact) =>
				Arr.every(probe.key, (k, i) => {
					const arg = args[i]
					return Option.getOrUndefined(Arr.findFirst(fields, (f) => f.name === k))?.domain.kind ===
						"span"
						? overlaps(fact[k], arg)
						: sameValue(fact[k], arg)
				})
			)
		return atProbe ? underClaims(order, true, () => [go(session)]) : [go(session)]
	}
	switch (statement.kind) {
		case "set-role":
			return [
				roleAnswer(
					state,
					session.login,
					statement.role,
					(taken) => go({ ...session, current: { kind: "role", role: taken } }),
					refused
				)
			]
		case "reset-role":
			return [go({ ...session, current: { kind: "login" } })]
		case "set-session-authorization":
			return [refused(exists(state, namedBy(statement.role)) ? "42501" : "other")]
		case "set-claims":
			return [go({ ...session, claims: { kind: "set", setting: statement.setting } })]
		case "select-view":
			return viewRead(statement.role, statement.relation, statement.filter)
		case "select-table":
			return tableRead(statement.relation, statement.filter)
		case "insert": {
			const parsed = parseFault(statement.relation, statement.fact)
			if (parsed !== undefined) {
				return [parsed]
			}
			const at = write(statement.relation)
			if (at === undefined) {
				return [refused("42501")]
			}
			if (belowSerializable) {
				return [refused("25000")]
			}
			const cast = castRefusals(statement.relation, statement.fact)
			if (cast !== undefined) {
				return cast
			}
			return underClaims(policyJudgment(at.policy), true, () => {
				const { fact } = withSerial(base, statement.relation, statement.fact, nextDraw(state))
				if (!member(at.policy, fact)) {
					return [refused("42501")]
				}
				const unfilled = notNull(statement.relation, statement.fact)
				if (unfilled !== undefined) {
					return [unfilled]
				}
				const after = new Map(session.view)
				after.set(statement.relation, [...factsIn(session.view, statement.relation), fact])
				return judged(after)
			})
		}
		case "delete": {
			const parsed = parseFault(statement.relation, statement.key)
			if (parsed !== undefined) {
				return [parsed]
			}
			const at = write(statement.relation)
			if (at === undefined) {
				return [refused("42501")]
			}
			if (belowSerializable) {
				return [refused("25000")]
			}
			return scanned(statement.relation, statement.key, at.policy, () => {
				const gone = targeted(statement.relation, statement.key, at.policy)
				const after = new Map(session.view)
				after.set(
					statement.relation,
					Arr.filter(factsIn(session.view, statement.relation), (f) => !gone.includes(f))
				)
				return judged(after)
			})
		}
		case "update": {
			const at = write(statement.relation)
			const fields = Record.keys(statement.set)
			if (fields.length === 0) {
				return [refused("other")]
			}
			const parsed = parseFaults(statement.relation, [statement.key, statement.set])
			if (parsed !== undefined) {
				return [parsed]
			}
			if (namesSerial(statement.relation, fields)) {
				return [refused("428C9")]
			}
			if (at === undefined) {
				return [refused("42501")]
			}
			const updatable = updatableFields(base, at.written)
			if (!Arr.every(fields, (f) => updatable.includes(f))) {
				return [refused("42501")]
			}
			if (belowSerializable) {
				return [refused("25000")]
			}
			const fault = rowFault(factCells(base, statement.relation, statement.set, fields))
			const checks = fault?.kind === "checks" ? lawsOf(fault.domains) : []
			return scanned(statement.relation, statement.key, at.policy, () => {
				const old = targeted(statement.relation, statement.key, at.policy)
				const [check, ...more] = checks
				if (old.length > 0 && check !== undefined) {
					return [domainRefused(check), ...Arr.map(more, domainRefused)]
				}
				const moved = Arr.map(old, (f) => ({ ...f, ...statement.set }))
				if (!Arr.every(moved, (f) => member(at.policy, f))) {
					return [refused("42501")]
				}
				const after = new Map(session.view)
				after.set(statement.relation, [
					...Arr.filter(factsIn(session.view, statement.relation), (f) => !old.includes(f)),
					...moved
				])
				return judged(after)
			})
		}
		case "insert-on-conflict": {
			const parsed = parseFault(statement.relation, statement.fact)
			if (parsed !== undefined) {
				return [parsed]
			}
			const at = write(statement.relation)
			const keyed = new Set(keysOf(base, statement.relation).flat())
			const payload = Arr.filter(Record.keys(statement.fact), (f) => !keyed.has(f))
			/**
			 * A fact with no field outside every key sets its primary key's fields to the proposed row's, an identity's
			 * drawn value where the fact leaves a serial key field to it.
			 */
			const sets =
				payload.length > 0 ? payload : (relationSpecOf(base, statement.relation)?.key ?? [])
			if (statement.onConflict === "update" && namesSerial(statement.relation, sets)) {
				return [refused("428C9")]
			}
			if (at === undefined) {
				return [refused("42501")]
			}
			if (statement.onConflict === "update") {
				const updatable = updatableFields(base, at.written)
				if (sets.length === 0 || !Arr.every(sets, (f) => updatable.includes(f))) {
					return [refused("42501")]
				}
			}
			if (belowSerializable) {
				return [refused("25000")]
			}
			const cast = castRefusals(statement.relation, statement.fact)
			if (cast !== undefined) {
				return cast
			}
			return underClaims(policyJudgment(at.policy), true, () => {
				const { fact } = withSerial(base, statement.relation, statement.fact, nextDraw(state))
				if (!member(at.policy, fact)) {
					return [refused("42501")]
				}
				const unfilled = notNull(statement.relation, statement.fact)
				if (unfilled !== undefined) {
					return [unfilled]
				}
				const [check, ...moreChecks] = rowChecks(statement.relation, fact)
				if (check !== undefined) {
					return [lawRefused(session.view)(check), ...Arr.map(moreChecks, lawRefused(session.view))]
				}
				const key = relationSpecOf(base, statement.relation)?.key ?? []
				const stored = factsIn(session.view, statement.relation)
				const conflict = Option.getOrUndefined(
					Arr.findFirst(stored, (f) => Arr.every(key, (k) => sameValue(f[k], fact[k])))
				)
				const inserted = (): Arr.NonEmptyReadonlyArray<Branch> => {
					const after = new Map(session.view)
					after.set(statement.relation, [...stored, fact])
					const [first, ...rest] = statementRefusals(state.host, after)
					if (first !== undefined) {
						return [lawRefused(after)(first), ...Arr.map(rest, lawRefused(after))]
					}
					const next = withSession(state, id, { ...session, view: after })
					return [
						{
							observation:
								statement.onConflict === "select" ? { kind: "rows", rows: [fact] } : { kind: "ok" },
							next
						}
					]
				}
				if (conflict === undefined) {
					return inserted()
				}
				const seenConflict = member(at.policy, conflict)
				/** How ON CONFLICT resolves a conflict with a stored fact, which row security shows the role or hides from it. */
				const resolved = (): Arr.NonEmptyReadonlyArray<Branch> => {
					switch (statement.onConflict) {
						case "nothing":
							return [{ observation: { kind: "ok" }, next: state }]
						case "select":
							return seenConflict
								? [{ observation: { kind: "rows", rows: [conflict] }, next: state }]
								: [refused("42501")]
						case "update": {
							const excluded = Arr.flatMap(sets, (f) => {
								const value = fact[f]
								return value === undefined ? [] : [[f, value] as const]
							})
							const moved: HostFact = { ...conflict, ...Record.fromEntries(excluded) }
							if (!seenConflict || !member(at.policy, moved)) {
								return [refused("42501")]
							}
							const after = new Map(session.view)
							after.set(statement.relation, [...Arr.filter(stored, (f) => f !== conflict), moved])
							return judged(after)
						}
					}
				}
				return resolved()
			})
		}
		case "merge-delete": {
			const parsed = parseFaults(statement.relation, statement.keys)
			if (parsed !== undefined) {
				return [parsed]
			}
			const at = write(statement.relation)
			if (at === undefined) {
				return [refused("42501")]
			}
			if (belowSerializable) {
				return [refused("25000")]
			}
			const stored = factsIn(session.view, statement.relation)
			const matched = Arr.filter(stored, (f) => Arr.some(statement.keys, (k) => atKey(f, k)))
			/**
			 * The rows MERGE deletes, those row security admits; a row two of its source keys match it refuses instead (21000,
			 * MERGE command cannot affect row a second time).
			 */
			const removed = (): Arr.NonEmptyReadonlyArray<Branch> => {
				const gone = Arr.filter(matched, (f) => member(at.policy, f))
				if (Arr.some(gone, (f) => Arr.filter(statement.keys, (k) => atKey(f, k)).length > 1)) {
					return [refused("other")]
				}
				const after = new Map(session.view)
				after.set(
					statement.relation,
					Arr.filter(stored, (f) => !gone.includes(f))
				)
				return judged(after)
			}
			return underClaims(policyJudgment(at.policy), stored.length > 0, removed)
		}
		case "prepare": {
			const read = statement.read
			if (read.kind === "view") {
				const named = viewNamed(read.role, read.relation)
				if (named.kind === "refused") {
					return [named.branch]
				}
			}
			return Record.has(session.prepared, statement.name)
				? [refused("other")]
				: [go({ ...session, prepared: { ...session.prepared, [statement.name]: read } })]
		}
		case "execute-prepared": {
			const read = session.prepared[statement.name]
			if (read === undefined) {
				return [refused("other")]
			}
			return read.kind === "view"
				? viewRead(read.role, read.relation, { kind: "none" })
				: tableRead(read.relation, { kind: "none" })
		}
		case "truncate":
		case "setval":
			return [refused("42501")]
		case "call":
			return callAnswer(
				state,
				role,
				statement.fn,
				statement.args,
				() => executed(statement.fn, statement.args),
				refused
			)
	}
}

/** The role a reference names: one the installation may define, by name, or the owner, which is none of its roles. */
type Named = { readonly kind: "name"; readonly name: string } | { readonly kind: "owner" }

const namedBy = (ref: RoleRef): Named => {
	switch (ref.kind) {
		case "own":
		case "other-login":
		case "dropped":
			return { kind: "name", name: ref.role }
		case "nonexistent":
			return { kind: "name", name: ref.name }
		case "owner":
			return { kind: "owner" }
	}
}

/** Whether a reference names a PostgreSQL role that exists: an installed role or login, or the owner. */
const exists = (state: ModelState, named: Named): boolean =>
	named.kind === "owner" ||
	roleOf(state.install, named.name) !== undefined ||
	loginOf(state.install, named.name) !== undefined

/**
 * SET ROLE: a login may take on exactly its own roles, each granted to it WITH SET TRUE; any other role that exists,
 * another login's or the owner, is refused by privilege, and a role that does not exist is an error of its own.
 */
const roleAnswer = (
	state: ModelState,
	login: string,
	ref: RoleRef,
	taken: (role: string) => Branch,
	refused: (sqlstate: SqlState) => Branch
): Branch => {
	const named = namedBy(ref)
	if (
		named.kind === "name" &&
		loginOf(state.install, login)?.roles.includes(named.name) === true &&
		roleOf(state.install, named.name) !== undefined
	) {
		return taken(named.name)
	}
	return refused(exists(state, named) ? "42501" : "other")
}

/** The integer types' ranges, by their bits. */
const integerRange: Readonly<Record<16 | 32 | 64, readonly [bigint, bigint]>> = {
	16: [-32768n, 32767n],
	32: [-2147483648n, 2147483647n],
	64: [-9223372036854775808n, 9223372036854775807n]
}

/** The spellings PostgreSQL's boolean input admits, each a prefix of true, false, yes, no, on or off, or a digit. */
const BOOLEAN_SPELLINGS: ReadonlyArray<string> = [
	"t",
	"tr",
	"tru",
	"true",
	"f",
	"fa",
	"fal",
	"fals",
	"false",
	"y",
	"ye",
	"yes",
	"n",
	"no",
	"on",
	"of",
	"off",
	"1",
	"0"
]

/** A text folded as a case-insensitive Unicode regular expression compares ASCII letters: lower case, with the long s
 * (U+017F), the one other letter that folds into those spellings' letters, read as s. */
const caseFolded = (text: string): string => Str.replaceAll("\u017f", "s")(Str.toLowerCase(text))

/**
 * Whether a literal's text is a value of a parameter's base type as PostgreSQL's input function reads it: 22P02 for
 * text that is no such value (a uuid's form, an integer's digits, a roster's member, a boolean's spelling, a range's
 * brackets), 22003 for an integer past its type's range, none for a value.
 */
const literalFault = (domain: FieldDomain, text: string): "22P02" | "22003" | undefined => {
	const trimmed = Str.trim(text)
	const integer = (bits: 16 | 32 | 64): "22P02" | "22003" | undefined => {
		if (!regex("^[+-]?\\d+$", "u").test(trimmed)) {
			return "22P02"
		}
		const [low, high] = integerRange[bits]
		const n = BigInt(trimmed)
		return n < low || n > high ? "22003" : undefined
	}
	switch (domain.kind) {
		case "text":
			return undefined
		case "uuid":
			return regex("^\\{?[0-9a-f]{4}(-?[0-9a-f]{4}){7}\\}?$", "iu").test(trimmed)
				? undefined
				: "22P02"
		case "integer":
		case "contract":
		case "serial":
			return integer(domain.bits)
		case "boolean":
			return Arr.contains(BOOLEAN_SPELLINGS, caseFolded(trimmed)) ? undefined : "22P02"
		case "handle":
			return domain.members.includes(text) ? undefined : "22P02"
		case "span": {
			if (Str.toLowerCase(trimmed) === "empty") {
				return undefined
			}
			const m = regex("^[[(]\\s*([+-]?\\d*)\\s*,\\s*([+-]?\\d*)\\s*[\\])]$", "u").exec(trimmed)
			if (m === null) {
				return "22P02"
			}
			const [low, high] = integerRange[domain.bits]
			const outside = Arr.some(
				[m[1], m[2]],
				(b) => b !== "" && (BigInt(b) < low || BigInt(b) > high)
			)
			return outside ? "22003" : undefined
		}
	}
}

/**
 * A call of a function the installation defines (README "Direct SQL access", "Security model"): a role executes exactly its own
 * filter functions and key probes, and the advance function of each serial field of a relation it writes; no role
 * executes a law function, a residual law's trigger function of no parameters (`__law_<id>()`), which its trigger alone
 * runs. A function the installation does not define, or called with another number of arguments, is an error of its
 * own, before any privilege is checked.
 */
const callAnswer = (
	state: ModelState,
	role: RoleSpec | undefined,
	fn: WorldFunction,
	args: ReadonlyArray<HostValue>,
	called: () => Arr.NonEmptyReadonlyArray<Branch>,
	refused: (sqlstate: SqlState) => Branch
): Arr.NonEmptyReadonlyArray<Branch> => {
	const params = parametersOf(state, fn)
	if (params === undefined || params.length !== args.length) {
		return [refused("other")]
	}
	for (const [i, domain] of params.entries()) {
		const arg = args[i]
		const fault = arg === undefined ? undefined : literalFault(domain, valueText(arg))
		if (fault !== undefined) {
			return [refused(fault)]
		}
	}
	return executes(state, role, fn) ? called() : [refused("42501")]
}

/** The parameters of an entry's filter function, key probe or unique probe, by their domains (parametersOf). */
const entryFunctionParameters = (
	state: ModelState,
	fn: Extract<WorldFunction, { readonly kind: "filter" | "key-probe" | "unique-probe" }>
): ReadonlyArray<FieldDomain> | undefined => {
	const base = state.install.base
	const owner = roleOf(state.install, fn.role)
	const w = owner === undefined ? undefined : writtenNamed(base, owner, fn.entry)
	const target = w === undefined ? undefined : relationSpecOf(base, w.target)
	if (owner === undefined || w?.kind !== "query" || target === undefined) {
		return undefined
	}
	const typed = (fields: ReadonlyArray<string>): ReadonlyArray<FieldDomain> =>
		Arr.flatMap(fields, (f) => {
			const field = Option.getOrUndefined(Arr.findFirst(target.fields, (x) => x.name === f))
			return field === undefined ? [] : [field.domain]
		})
	switch (fn.kind) {
		case "filter": {
			const membership = membershipOf(base, w.rules, target)
			return membership !== undefined && filterReadsStored(w.rules) ? typed(membership) : undefined
		}
		case "key-probe": {
			const key = probeOf(base, owner, fn)?.key
			return key === undefined ? undefined : typed(key)
		}
		case "unique-probe": {
			const probed = uniqueProbeOf(base, owner, fn)
			return probed === undefined
				? undefined
				: typed(uniqueReads(base, probed.target, probed.unique))
		}
	}
}

/**
 * The parameters of a function the installation defines, by their domains: a filter function's, its entry's membership
 * fields (defined only where the entry's rule reads a stored relation besides its target's row); a key probe's, its
 * key's fields; a unique probe's, the fields its index reads (uniqueReads); an advance function's, one bigint; a
 * residual law's trigger function's, none. Undefined for one the installation does not define.
 */
export const parametersOf = (
	state: ModelState,
	fn: WorldFunction
): ReadonlyArray<FieldDomain> | undefined => {
	const base = state.install.base
	switch (fn.kind) {
		case "filter":
		case "key-probe":
		case "unique-probe":
			return entryFunctionParameters(state, fn)
		case "advance": {
			const field = Option.getOrUndefined(
				Arr.findFirst(relationSpecOf(base, fn.relation)?.fields ?? [], (f) => f.name === fn.field)
			)
			return field?.domain.kind === "serial" ? [{ kind: "integer", bits: 64 }] : undefined
		}
		case "law": {
			const law = Option.getOrUndefined(Arr.findFirst(state.host.laws, (l) => l.law === fn.law))
			return law !== undefined && isResidual(law) ? [] : undefined
		}
	}
}

/**
 * Whether a role holds EXECUTE on a function the installation defines: its own filter functions, key probes and unique
 * probes, and the advance function of each serial field of a relation it writes; no role a law function's, which its
 * trigger alone runs; nothing while the writer is still its login.
 */
const executes = (state: ModelState, role: RoleSpec | undefined, fn: WorldFunction): boolean => {
	switch (fn.kind) {
		case "filter":
		case "key-probe":
		case "unique-probe":
			return role?.name === fn.role
		case "advance":
			return role !== undefined && writtenAt(state.install.base, role, fn.relation) !== undefined
		case "law":
			return false
	}
}

/**
 * The end of a direct writer's transaction: ROLLBACK discards its view; COMMIT judges the laws PostgreSQL defers to it
 * (a deferred foreign key's 23503, a residual law's 23000) and makes the view reality when none is broken; COMMIT of an
 * aborted transaction rolls it back. The session ends either way, and with it the role and claims it set.
 */
export const directEndBranches = (
	state: ModelState,
	id: number,
	session: DirectSessionState,
	end: "commit" | "rollback"
): Arr.NonEmptyReadonlyArray<Branch> => {
	const ended = withSession(state, id, closedDirect)
	if (end === "rollback" || session.transaction === "aborted") {
		return [{ observation: { kind: "ok" }, next: ended }]
	}
	const [first, ...rest] = commitRefusals(state.host, session.view)
	if (first === undefined) {
		return [{ observation: { kind: "ok" }, next: { ...ended, reality: session.view } }]
	}
	const refusal = (r: Refusal): Branch => ({
		observation: {
			kind: "law-refused",
			sqlstate: r.meeting.sqlstate,
			law: r.violation.law,
			witness: lawWitness(state, session, session.view, r)
		},
		next: ended
	})
	return [refusal(first), ...Arr.map(rest, refusal)]
}

/** A fact's values at some fields, renamed: `to[i]` holds the fact's value at `from[i]`. */
const projected = (
	fact: HostFact,
	from: ReadonlyArray<string>,
	to: ReadonlyArray<string>
): HostFact | undefined => {
	const entries = Arr.flatMap(from, (f, i) => {
		const value = fact[f]
		const name = to[i]
		return value === undefined || name === undefined ? [] : [[name, value] as const]
	})
	return entries.length === from.length ? Record.fromEntries(entries) : undefined
}

/** Whether a fact holds a side's selector values: at each field, the value or one of the values it admits. */
const selected = (fact: HostFact, where: Readonly<Record<string, HostSelector>>): boolean =>
	Arr.every(
		Record.toEntries(where),
		([f, s]) => Record.has(fact, f) && Arr.some(selectorValues(s), (v) => sameValue(fact[f], v))
	)

/** Whether two span values overlap, as half-open ranges; an empty one overlaps none. */
const overlaps = (a: HostValue | undefined, b: HostValue | undefined): boolean =>
	a !== undefined &&
	b !== undefined &&
	isSpan(a) &&
	isSpan(b) &&
	a.start < a.end &&
	b.start < b.end &&
	a.start < b.end &&
	b.start < a.end

/** A key a refusal's DETAIL may name, with the relation whose rows it names. */
interface KeyOf {
	readonly relation: string
	readonly key: HostFact
}

/**
 * The keys PostgreSQL's DETAIL may name for a native constraint a view breaks, each with the relation whose rows it
 * names: a key's, a unique index's (over the facts its predicate admits) or a span key's fields of every fact sharing
 * them with another (`Key (...)=(...) already exists`, `conflicts with`); a containment's source fields of a source fact
 * no target fact holds (`is not present in table`), and the same values under the target's fields (`is still referenced
 * from table`, when a target fact went). A check names no key (`Failing row contains`).
 */
const nativeKeys = (law: HostLaw, view: HostState): ReadonlyArray<KeyOf> => {
	switch (law.kind) {
		case "key":
		case "unique": {
			const facts = Arr.filter(
				factsIn(view, law.relation),
				(f) => law.kind === "key" || selected(f, law.where)
			)
			return Arr.flatMap(facts, (f, i): ReadonlyArray<KeyOf> => {
				const key = projected(f, law.fields, law.fields)
				return key !== undefined &&
					Arr.some(facts, (g, j) => j !== i && Arr.every(law.fields, (k) => sameValue(f[k], g[k])))
					? [{ relation: law.relation, key }]
					: []
			})
		}
		case "spanKey": {
			const fields = [...law.scalars, law.span]
			const facts = factsIn(view, law.relation)
			return Arr.flatMap(facts, (f, i): ReadonlyArray<KeyOf> => {
				const key = projected(f, fields, fields)
				return key !== undefined &&
					Arr.some(
						facts,
						(g, j) =>
							j !== i &&
							Arr.every(law.scalars, (k) => sameValue(f[k], g[k])) &&
							overlaps(f[law.span], g[law.span])
					)
					? [{ relation: law.relation, key }]
					: []
			})
		}
		case "contained": {
			const targets = Arr.filter(factsIn(view, law.target.relation), (t) =>
				selected(t, law.target.where)
			)
			const sources = Arr.filter(factsIn(view, law.source.relation), (f) =>
				selected(f, law.source.where)
			)
			return Arr.flatMap(sources, (f: HostFact): ReadonlyArray<KeyOf> => {
				const source = projected(f, law.source.fields, law.source.fields)
				const target = projected(f, law.source.fields, law.target.fields)
				const held = Arr.some(targets, (t) =>
					Arr.every(law.source.fields, (sf, i) => {
						const tf = law.target.fields[i]
						return tf !== undefined && sameValue(f[sf], t[tf])
					})
				)
				return held || source === undefined || target === undefined
					? []
					: [
							{ relation: law.source.relation, key: source },
							{ relation: law.target.relation, key: target }
						]
			})
		}
		case "check":
		case "covered":
		case "obliged":
		case "capacity":
			return []
	}
}

/**
 * A direct writer's law refusal, its witness as PostgreSQL's message shows it. A native constraint's DETAIL names the
 * keys nativeKeys finds of a relation the role can read the rows of, and none of any other: PostgreSQL omits key detail
 * where row security is on and where the role holds SELECT neither on the table nor on every key column
 * (ri_ReportViolation, BuildIndexValueDescription), as the privilege model grants them (catalog.ts holdsTable,
 * holdsColumn). A residual law's function shows its witness keys only to a role that holds the witness relation whole.
 * Either is judged as the identity in force where the law is checked, a residual law's at COMMIT (README "Direct SQL access",
 * Direct SQL writers): the role the transaction took on, or else its login, which holds nothing, a login after RESET
 * ROLE too, so it is shown no key.
 */
const lawWitness = (
	state: ModelState,
	session: DirectSessionState,
	view: HostState,
	r: Refusal
): Witness => {
	const role = currentRole(state, session)
	const law = Option.getOrUndefined(
		Arr.findFirst(state.host.laws, (l) => l.law === r.violation.law)
	)
	if (role === undefined || law === undefined) {
		return { kind: "withheld" }
	}
	if (isResidual(law)) {
		return witnessFor(state.host, role, r.violation, [])
	}
	/** Whether PostgreSQL shows a key of a relation: no row security on it, and SELECT on it or on every key column. */
	const readable = (relation: string, key: HostFact): boolean =>
		!rowSecured(state.install, relation) &&
		(holdsTable(state.install, role.name, relation, "SELECT") ||
			Arr.every(Record.keys(key), (field) =>
				holdsColumn(state.install, role.name, relation, field, "SELECT")
			))
	const keys = Arr.map(
		Arr.filter(nativeKeys(law, view), (k) => readable(k.relation, k.key)),
		(k) => k.key
	)
	return keys.length === 0 ? { kind: "withheld" } : { kind: "shown", keys }
}

/**
 * An interruption of a direct writer's session (README "Transactions and concurrency": interruption is the only cancellation; treat an
 * interrupted write like CommitUnknown). With no call in flight nothing changes. A COMMIT the interruption meets may
 * have finished first, with its own outcome; or it is lost, the caller seeing the interruption or CommitUnknown, and the
 * change committed or not, committed only when COMMIT would have succeeded.
 */
export const directInterruptBranches = (
	state: ModelState,
	id: number,
	session: DirectSessionState
): Arr.NonEmptyReadonlyArray<Branch> => {
	const ended = withSession(state, id, closedDirect)
	const commits =
		session.transaction === "open" && commitRefusals(state.host, session.view).length === 0
	const applied: ModelState = { ...ended, reality: session.view }
	const committed: ReadonlyArray<Branch> = commits
		? [
				{ observation: { kind: "interrupted" }, next: applied },
				{ observation: { kind: "commit-unknown" }, next: applied }
			]
		: []
	return [
		{ observation: { kind: "ok" }, next: state },
		{ observation: { kind: "interrupted" }, next: ended },
		{ observation: { kind: "commit-unknown" }, next: ended },
		...committed,
		...directEndBranches(state, id, session, "commit")
	]
}
