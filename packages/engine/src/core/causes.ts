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
 * - `recursiveAggregation`: an aggregate, or r.pack, over self in a recursive arm (scan.ts).
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
	| {
			readonly kind: "recursiveAggregation"
			readonly recursion: string
			readonly fold: "count" | "sum" | "mean" | "min" | "max" | "pack"
	  }
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
 * - `btreeEntry`: an entry that can reach `bytes`, above the B-tree limit `limit` (BTMaxItemSize), and the bytes each of
 *   its columns' datums is counted at, in index order: a text's is the byte bound its pattern and contract prove.
 * - `spans`: more than one span field, which no native lowering serves.
 * - `gistEntry`: a span key's GiST entry that can reach `bytes`, above the limit `limit` of a GiST page.
 * - `gistOperatorClass`: a span key's scalar field with no btree_gist operator class.
 * - `spanAlone`: a primary key that is the span `field` alone: a primary key WITHOUT OVERLAPS needs a scalar field
 *   beside its span, so only a candidate key can be that span alone.
 */
export type KeyFault =
	| { readonly kind: "columns"; readonly limit: number }
	| { readonly kind: "unboundedText"; readonly field: string }
	| {
			readonly kind: "btreeEntry"
			readonly bytes: number
			readonly limit: number
			readonly datums: ReadonlyArray<{ readonly field: string; readonly bytes: number }>
	  }
	| { readonly kind: "spans"; readonly fields: Names }
	| { readonly kind: "gistEntry"; readonly bytes: number; readonly limit: number }
	| { readonly kind: "gistOperatorClass"; readonly field: string }
	| { readonly kind: "spanAlone"; readonly field: string }

/**
 * Why derived analysis refused a derived relation (analysis/derived), the cause of a DerivedRefused CompileError
 * (core/errors.ts):
 * - `attachment`: the definition attaches a nested relation to its facts: a materialized view stores flat facts.
 * - `headingGroups`: the definition is a union of several heading groups: a materialized view has one heading.
 * - `emptyHeading`: the definition delivers no field: the unique index REFRESH MATERIALIZED VIEW CONCURRENTLY needs
 *   has a column.
 * - `undeclaredContract`: a field whose type is a contract the schema declares nowhere.
 * - `exactField`: a field whose head term is an exact value (an exact integer or exact money), which no field's
 *   type holds: the head narrows it with Compute.cast into the field type it fits, an aggregate's result over the
 *   variable an interior stage finds it as.
 * - `inheritedKey`: an inherited key narrower than the heading whose unique index entry is unrepresentable.
 * - `wholeHeading`: the whole heading, the one key when no narrower key is proven, whose unique index entry is
 *   unrepresentable.
 * - `oneFact`: a definition of at most one fact none of whose fields is a representable one-column key; `fault` is
 *   the first field's.
 */
export type DerivedRefusal =
	| { readonly kind: "attachment"; readonly relation: string }
	| { readonly kind: "headingGroups"; readonly relation: string }
	| { readonly kind: "emptyHeading"; readonly relation: string }
	| {
			readonly kind: "undeclaredContract"
			readonly relation: string
			readonly field: string
			readonly contract: string
	  }
	| {
			readonly kind: "exactField"
			readonly relation: string
			readonly field: string
			readonly type: string
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

/** What a role relation a write or refresh list names is: an ordinary, closed or derived whole entry, or a query entry. */
export type EntryKind = "relation" | "closed" | "derived" | "query"

/**
 * A rule of a role a description breaks (schema/world.ts admitRole at the builder, schema/own.ts ownRole at
 * ownership), the rule of a RoleRefused CompileError:
 * - `wholeEntryName`: a whole entry under another name than its relation's, `relation`.
 * - `wholeEntryUndeclared`: a whole entry naming no relation the base `base` declares, or one it declares differently.
 * - `entryOverAnother`: a query entry built over another schema than the base or one of its levels, or over a role.
 * - `entryOrdered`: a query entry that is an Ordered, not a Query.
 * - `entryParameters`: a query entry that reads the parameters `parameters`.
 * - `entryOutsideBase`: a query entry that reads `relation`, which the base lacks.
 * - `entryAttaches`: a query entry that attaches a nested relation.
 * - `entryApproximate`: a query entry that searches approximately.
 * - `writeOutside`, `refreshOutside`: a write or refresh list naming `name`, no relation of the role.
 * - `writeKind`: a write list naming a closed or derived whole entry.
 * - `writeUnwritable`: a write list naming a query entry the writable-entry analysis refuses, for `why`.
 * - `writeTwice`: two write entries, `entries`, that both write the base relation `relation`.
 * - `refreshKind`: a refresh list naming an entry that is no derived whole entry.
 */
export type RoleRule =
	| { readonly kind: "wholeEntryName"; readonly entry: string; readonly relation: string }
	| { readonly kind: "wholeEntryUndeclared"; readonly entry: string; readonly base: string }
	| {
			readonly kind: "entryOverAnother"
			readonly entry: string
			readonly base: string
			readonly over:
				| { readonly kind: "role" }
				| { readonly kind: "schema"; readonly schema: string }
	  }
	| { readonly kind: "entryOrdered"; readonly entry: string }
	| { readonly kind: "entryParameters"; readonly entry: string; readonly parameters: Names }
	| { readonly kind: "entryOutsideBase"; readonly entry: string; readonly relation: string }
	| { readonly kind: "entryAttaches"; readonly entry: string }
	| { readonly kind: "entryApproximate"; readonly entry: string }
	| { readonly kind: "writeOutside"; readonly name: string }
	| { readonly kind: "writeKind"; readonly name: string; readonly entryKind: "closed" | "derived" }
	| { readonly kind: "writeUnwritable"; readonly entry: string; readonly why: WritabilityReason }
	| {
			readonly kind: "writeTwice"
			readonly relation: string
			readonly entries: readonly [string, string]
	  }
	| { readonly kind: "refreshOutside"; readonly name: string }
	| {
			readonly kind: "refreshKind"
			readonly name: string
			readonly entryKind: Exclude<EntryKind, "derived">
	  }

/**
 * A rule of a login a description breaks (schema/world.ts login at the builder, schema/own.ts ownLogin at ownership),
 * the rule of a LoginRefused CompileError:
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
 * A rule of a context's claims a description breaks (schema/world.ts context), the rule of a ContextRefused
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
		case "recursiveAggregation":
			return `recursion: recursive aggregation: ${cause.fold === "pack" ? "r.pack" : cause.fold} over self in a recursive arm of ${cause.recursion} would fold one working-table batch, not the fixed point; precompute independent aggregates before feedback or aggregate the completed recursion afterward`
		case "unhashableState":
			return `hashing: ${cause.type} state column ${cause.column} of recursive relation ${cause.recursion} has no hash operator class, and PostgreSQL deduplicates a recursive UNION only by hashing`
		case "stateHeading":
			return `recursion: ${cause.arm} arms of ${cause.recursion} delivering exactly the state (${list(cause.state)}), not (${list(cause.heading)})`
		case "inexactConversion":
			return `recursion: state column ${cause.column} of ${cause.recursion} delivered by its ${cause.arm} arm${cause.arm === "base" ? "s" : ""} as ${cause.delivered}, ${conversionText(cause.conversion, cause.declared)}; cast it to the declared representation with Compute.cast, since a recursive column is never widened silently`
		case "unnamedOrigin":
			return `recursion: the attachment correlation column ${cause.column} of ${cause.recursion} names no parent variable its arms read, so the recursive arms cannot carry it in the state`
		case "unboundedState":
			return `recursion: unbounded computed state: state column ${cause.column} of ${cause.recursion} is computed from the current ${list(cause.reads)} with no admitted bound, so it can take a new value on every iteration however finite the graph is; keep the state to carrier values, or advance an integer counter by a literal step under a filter bounding its current value, such as r.lt(${cause.column}, n)`
		case "carrierOverflow":
			return `recursion: carrier overflow: state column ${cause.column} of ${cause.recursion} advances by ${cause.delta} from ${cause.from}, which the bound admits, to ${cause.from + cause.delta}, outside ${cause.type}'s range ${cause.min}..${cause.max}; the next value may not overflow before its bound is checked`
	}
}

/**
 * A key fault's text after the key's name: the one text of each fault, a declared key's and an inherited one's alike.
 */
export const keyFaultText = (name: string, key: ReadonlyArray<string>, fault: KeyFault): string => {
	switch (fault.kind) {
		case "columns":
			return `${name}: it has ${key.length} fields, above PostgreSQL's limit of ${fault.limit} columns in one index (INDEX_MAX_KEYS)`
		case "unboundedText":
			return `${name}: field ${fault.field} is text whose pattern proves no byte bound; a bounded anchored pattern, or a contract bounding its charLength or octetLength, does`
		case "btreeEntry":
			return `${name}: its B-tree entry can reach ${fault.bytes} bytes, above PostgreSQL's ${fault.limit}-byte limit (${fault.datums.map((d) => `${d.field} ${d.bytes} bytes`).join(", ")})`
		case "spans":
			return `${name}: a key with more than one span field (${fault.fields.join(", ")}) has no native lowering`
		case "gistEntry":
			return `${name}: its GiST entry can reach ${fault.bytes} bytes, above the ${fault.limit}-byte limit of a GiST page`
		case "gistOperatorClass":
			return `${name}: field ${fault.field} has no btree_gist operator class`
		case "spanAlone":
			return `${name}: it is the span ${fault.field} alone, which a primary key WITHOUT OVERLAPS never is; only a candidate key can be`
	}
}

/** A derived refusal's capability. */
export const derivedRefusalText = (cause: DerivedRefusal): string => {
	switch (cause.kind) {
		case "attachment":
			return `derived relation ${cause.relation} over a definition that attaches a nested relation to its facts: a materialized view stores flat facts`
		case "headingGroups":
			return `derived relation ${cause.relation} over a union of several headings: a materialized view has one heading`
		case "emptyHeading":
			return `derived relation ${cause.relation} with at least one field: a definition with an empty head is the unit relation, and the unique index REFRESH MATERIALIZED VIEW CONCURRENTLY needs has a column`
		case "undeclaredContract":
			return `a contract the schema declares; ${cause.contract} is none`
		case "exactField":
			return `field ${cause.field} of derived relation ${cause.relation} of a field's type: its head is an ${cause.type}, which no stored field holds; narrow it with Compute.cast into the type it fits, under Compute.when where the cast narrows, and an aggregate's result over the variable an interior stage (r.interior) finds it as`
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
		case "wholeEntryName":
			return `a whole entry under its own name; ${rule.entry} names the relation ${rule.relation}`
		case "wholeEntryUndeclared":
			return `a whole entry naming a relation the base ${rule.base} declares; ${rule.entry} is none`
		case "entryOverAnother":
			return `a query over the base ${rule.base} or one of its levels; ${rule.entry} is built over ${rule.over.kind === "role" ? "a role" : `schema ${rule.over.schema}, which is none of them`}`
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
		case "writeOutside":
			return `a write list of the role's relations; ${rule.name} is none of them`
		case "writeKind":
			return `a write list of ordinary relations and query entries; ${rule.name} is ${entryKindText[rule.entryKind]}`
		case "writeUnwritable":
			return `a writable query entry ${rule.entry}; ${unwritableText(rule.why)}`
		case "writeTwice":
			return `one writable entry per base relation; ${rule.entries[0]} and ${rule.entries[1]} both write ${rule.relation}`
		case "refreshOutside":
			return `a refresh list of the role's relations; ${rule.name} is none of them`
		case "refreshKind":
			return `a refresh list of derived whole entries; ${rule.name} is ${entryKindText[rule.entryKind]}`
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
 * generation expression reads, as PostgreSQL's never does; it reads `read`, a field grizzle draws or accumulates on
 * the host (`writing`), which no generation expression reads either; it reads an input beyond its own row, `input` the
 * description kind of the first in expression order; or its type `expression` is not the field's declared `declared`
 * (each a type label), with no implicit cast.
 */
export type GeneratedRule =
	| { readonly kind: "readsGenerated"; readonly read: string }
	| {
			readonly kind: "readsUnwritten"
			readonly read: string
			readonly writing: "drawn" | "accumulated"
	  }
	| {
			readonly kind: "notRowLocal"
			readonly input: "var" | "param" | "parent" | "value" | "absent"
	  }
	| { readonly kind: "type"; readonly declared: string; readonly expression: string }

/** What each input beyond a row is, in a generated field's refusal. */
const rowInputWords: {
	readonly [I in Extract<GeneratedRule, { readonly kind: "notRowLocal" }>["input"]]: string
} = {
	var: "a query variable",
	param: "a parameter",
	parent: "a parent column",
	value: "a contract's value",
	absent: "a relational negation"
}

/** A generated field rule's sentence. */
export const generatedRuleText = (rule: GeneratedRule): string => {
	switch (rule.kind) {
		case "readsGenerated":
			return `reads ${rule.read}, a generated field; a generation expression reads its row's written fields only`
		case "readsUnwritten":
			return `reads ${rule.read}, a field grizzle ${rule.writing === "drawn" ? "draws" : "accumulates"} on the host; a generation expression reads only the fields its caller writes, so derive the value from those, or read ${rule.read} in a query or a row check`
		case "notRowLocal":
			return `reads ${rowInputWords[rule.input]}; a generation expression reads its own row and closed relations only`
		case "type":
			return `its expression is ${rule.expression}, not its declared ${rule.declared}: PostgreSQL types a generation expression by its column, with no implicit cast`
	}
}

/** A claim rule's sentence. */
export const claimRuleText = (rule: ClaimRule): string =>
	`a claim of text, uuid, boolean, an integer type, a contract over one, or a closed handle; field ${rule.field} is none`

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
 * selection, or a tree root's copy of itself).
 */
export type FillAxis = "owner" | "predecessor" | "last" | "row"

/**
 * Why a column's source is filled only after the column, so no write can fill the column (ir/fill.ts):
 * - `afterMembers`: its owner fills the source only after its members: a fold's end, a copy along a last axis, or a
 *   column read from one;
 * - `countedFill`: the counted family `family` fills the source on its own, after the nested write that writes the row
 *   and apart from every other family, so only that family's own members and ends may read it;
 * - `cycle`: the source reads the column back through its row's own columns, so no order fills either;
 * - `unreached`: no fill that writes the column writes the source: a column of another family the row belongs to.
 */
export type FilledLater =
	| { readonly kind: "afterMembers" }
	| { readonly kind: "countedFill"; readonly family: FamilyName }
	| { readonly kind: "cycle" }
	| { readonly kind: "unreached" }

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
 * Why no write fills a relation's rows (ir/fill.ts):
 * - `nestingCycle`: the sequences `families` nest each other in a cycle, an ordered family over its own relation among
 *   them, so every row of the cycle is nested under another and none is written first;
 * - `generatedKey`: a unique object of the law `law` reads `field`, which PostgreSQL generates and no fact carries, so
 *   no addition's same-key check or probe can meet it.
 */
export type UnwritableCause =
	| { readonly kind: "nestingCycle"; readonly families: ReadonlyArray<FamilyName> }
	| { readonly kind: "generatedKey"; readonly law: LawId; readonly field: string }

/** An UnwritableRelation's sentence. */
export const unwritableRelationText = (relation: string, cause: UnwritableCause): string => {
	switch (cause.kind) {
		case "nestingCycle":
			return `no write fills ${relation}: the sequences ${cause.families.map(familyNameText).join(", ")} nest each other in a cycle, so every row of them is nested under another and none is written first`
		case "generatedKey":
			return `no addition to ${relation} compiles: the unique object of law ${cause.law} reads ${cause.field}, which PostgreSQL generates and no fact carries, so no same-key check or probe meets it; key fields its caller writes`
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
 * (`fold`), a predecessor copy (`predecessor`), a last copy on its owner (`last`), or a tree node's copy of its
 * parent's (`tree`). `column` is the column the value is drawn into, on `relation`.
 */
export interface DerivedReader extends ColumnName {
	readonly kind: "fold" | "predecessor" | "last" | "tree"
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
	}
}

/** A StaleDerivedRead's sentence: the change, the cascade that carries it on, and the value that reads it. */
export const staleDerivedReadText = (read: {
	readonly op: "insert" | "put" | "delete"
	readonly member: string
	readonly changed: ChangedColumn
	readonly copies: ReadonlyArray<ColumnName>
	readonly reader: DerivedReader
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
	return `${how}${carried}; ${derivedReaderText(read.reader)} reads it, a value grizzle draws when its row is written and never again when a column it reads changes, so the change would leave it stale`
}
