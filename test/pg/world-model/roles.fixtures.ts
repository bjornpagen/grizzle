/** What the properties of roles.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { type Branch, enumerated, firstBranch } from "@bjornpagen/testing/enumerate"
import { element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { recorder } from "@bjornpagen/testing/source"
import { Array as Arr, Option, Record as Rec } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { worldTemplate } from "#test/support/worlds/execute/template.ts"
import { classifyEntry } from "#test/support/worlds/model/host.ts"
import type {
	Action,
	BaseSpec,
	EntryClass,
	EntrySpec,
	HeadField,
	HostState,
	InstallSpec,
	Occurrence,
	RoleSpec,
	Rule,
	Term,
	WritableRefusal
} from "#test/support/worlds/model/types.ts"
import type { PrivilegeFact, PrivilegeHolder } from "#test/support/worlds/privileges.ts"

/**
 * Every role entry of a small space, installed, holds exactly the privileges its classification gives it, and a Db of
 * its role opens: the writable-entry rule of README "Writing through a role", as the worlds model restates it
 * (model/host.ts classifyEntry), and what the migration installed, agree.
 *
 * The space is every entry over a two-relation base with one context: P(id, v) and Q(id, w), each keyed by id, and the
 * context C { x }, read from the token's top level. An entry's rule matches its would-be target T (P or Q), T's two
 * fields each written by a head variable, by the same head variable as the field before, fixed by a literal, a context
 * term or a variable a context match binds, unnamed, or bound to a variable nothing else reads; its head adds nothing, a
 * literal, a context term or a second field naming a head variable; one further member joins the other relation,
 * rivals T as a supplier, negates the other relation or the context, compares a head variable, or matches the context;
 * and the entry is that rule, or two arms of it.
 *
 * Every entry of the space is installed at once, each in a role of one login: a role writes at most one entry per
 * relation, so each writable entry takes a role whose writes do not yet reach its target, and the read-only ones fill
 * the roles in turn. A role writes exactly its entries the rule finds writable. For each entry, its role's privileges
 * (every privilege, membership and attribute it holds, as PostgreSQL judges them), its login's, and row security on its
 * target are exactly the ones README "Security model" derives from the classification (worlds/privileges.ts
 * expectedPrivileges), and Db.open of its role, with a token whose claims it reads, opens as the worlds model says.
 */

const integer = { kind: "integer", bits: 32 } as const

export const pairBase: BaseSpec = {
	name: "RolePair",
	closed: [],
	relations: [
		{
			name: "P",
			fields: [
				{ name: "id", domain: integer },
				{ name: "v", domain: integer }
			],
			key: ["id"],
			mutability: "immutable"
		},
		{
			name: "Q",
			fields: [
				{ name: "id", domain: integer },
				{ name: "w", domain: integer }
			],
			key: ["id"],
			mutability: "mutable"
		}
	],
	laws: [],
	contexts: [{ name: "C", claim: { kind: "top-level" }, fields: [{ name: "x", domain: integer }] }],
	derived: []
}

type Target = "P" | "Q"

type FieldUse = "head" | "head-again" | "literal" | "claim-term" | "claim-var" | "unnamed" | "free"

type HeadExtra = "none" | "literal" | "claim" | "duplicate"

type Member =
	| "none"
	| "join"
	| "rival"
	| "negation"
	| "negated-claim"
	| "comparison"
	| "claim-match"

interface Shape {
	readonly target: Target
	readonly uses: readonly [FieldUse, FieldUse]
	readonly extra: HeadExtra
	readonly member: Member
	readonly arms: 1 | 2
}

const targets: Readonly<
	Record<Target, { readonly fields: readonly [string, string]; readonly other: Target }>
> = {
	P: { fields: ["id", "v"], other: "Q" },
	Q: { fields: ["id", "w"], other: "P" }
}

const secondOf: Readonly<Record<Target, string>> = { P: "v", Q: "w" }

const variable = (name: string): Term => ({ kind: "var", name })

const one: Term = { kind: "literal", value: 1 }

const claim: Term = { kind: "context", context: "C", field: "x" }

const claimed: Term = variable("cx")

const claimMatch = (term: Term): Occurrence => ({
	source: { kind: "context", name: "C" },
	fields: { x: term }
})

/** What a shape's further member adds to its rule. */
interface MemberParts {
	readonly matches: ReadonlyArray<Occurrence>
	readonly negations: Rule["negations"]
	readonly comparisons: Rule["comparisons"]
}

const ruleOfShape = (s: Shape): Rule => {
	const target = targets[s.target]
	const [first, second] = target.fields
	const [u0, u1] = s.uses
	const termFor = (use: FieldUse, field: string): Term | undefined => {
		switch (use) {
			case "head":
				return variable(`t_${field}`)
			case "free":
				return variable(`f_${field}`)
			case "head-again":
				return u0 === "head" ? variable(`t_${first}`) : variable(`t_${field}`)
			case "literal":
				return one
			case "claim-term":
				return claim
			case "claim-var":
				return claimed
			case "unnamed":
				return undefined
		}
	}
	const bindings = [[first, termFor(u0, first)] as const, [second, termFor(u1, second)] as const]
	const headFields = [
		...(u0 === "head" ? [first] : []),
		...(u1 === "head" || (u1 === "head-again" && u0 !== "head") ? [second] : [])
	]
	const [hv0, hv1] = Arr.map(headFields, (f) => variable(`t_${f}`))
	const head: Readonly<Record<string, Term>> = Rec.fromEntries(
		Arr.map(headFields, (f) => [f, variable(`t_${f}`)] as const)
	)
	const extras: Readonly<Record<HeadExtra, Readonly<Record<string, Term>>>> = {
		none: {},
		literal: { lit: one },
		claim: { cl: claim },
		duplicate: hv0 === undefined ? {} : { dup: hv0 }
	}
	const matched: Occurrence = {
		source: { kind: "ordinary", name: s.target },
		fields: Rec.fromEntries(
			Arr.flatMap(bindings, ([f, t]) => (t === undefined ? [] : [[f, t] as const]))
		)
	}
	const anchor = hv0 ?? one
	const other = (fields: Readonly<Record<string, Term>>): Occurrence => ({
		source: { kind: "ordinary", name: target.other },
		fields
	})
	const parts: Readonly<Record<Member, MemberParts>> = {
		none: { matches: [], negations: [], comparisons: [] },
		join: { matches: [other({ id: anchor })], negations: [], comparisons: [] },
		rival: {
			matches: [
				other({
					...(hv0 === undefined ? {} : { id: hv0 }),
					...(hv1 === undefined ? {} : { [secondOf[target.other]]: hv1 })
				})
			],
			negations: [],
			comparisons: []
		},
		negation: { matches: [], negations: [[other({ id: anchor })]], comparisons: [] },
		"negated-claim": { matches: [], negations: [[claimMatch(anchor)]], comparisons: [] },
		comparison: {
			matches: [],
			negations: [],
			comparisons: [{ left: hv0 ?? claim, op: "<", right: one }]
		},
		"claim-match": { matches: [claimMatch(anchor)], negations: [], comparisons: [] }
	}
	const member = parts[s.member]
	return {
		matches: [
			matched,
			...(Arr.contains(s.uses, "claim-var") ? [claimMatch(claimed)] : []),
			...member.matches
		],
		negations: member.negations,
		comparisons: member.comparisons,
		head: { ...head, ...extras[s.extra] }
	}
}

export const entryOfShape = (s: Shape): EntrySpec => {
	const rule = ruleOfShape(s)
	return { kind: "query", rules: s.arms === 1 ? [rule] : [rule, rule] }
}

/** Each vocabulary member's letter in an entry's name, which spells its shape. */
const useLetters: Readonly<Record<FieldUse, string>> = {
	head: "H",
	"head-again": "A",
	literal: "L",
	"claim-term": "T",
	"claim-var": "V",
	unnamed: "U",
	free: "F"
}

const extraLetters: Readonly<Record<HeadExtra, string>> = {
	none: "N",
	literal: "L",
	claim: "C",
	duplicate: "D"
}

const memberLetters: Readonly<Record<Member, string>> = {
	none: "N",
	join: "J",
	rival: "R",
	negation: "G",
	"negated-claim": "X",
	comparison: "O",
	"claim-match": "M"
}

/** An entry's name, which its shape spells, so every shape names one entry. */
export const entryName = (s: Shape): string =>
	`E${s.target}${useLetters[s.uses[0]]}${useLetters[s.uses[1]]}${extraLetters[s.extra]}${memberLetters[s.member]}${s.arms}`

const firstUses: Arr.NonEmptyReadonlyArray<FieldUse> = [
	"head",
	"literal",
	"claim-term",
	"claim-var",
	"unnamed",
	"free"
]

const allUses: Arr.NonEmptyReadonlyArray<FieldUse> = [...firstUses, "head-again"]

/** The first uses that bind no head variable. */
const unheadedFirsts: Arr.NonEmptyReadonlyArray<FieldUse> = [
	"literal",
	"claim-term",
	"claim-var",
	"unnamed",
	"free"
]

/** The second uses that make the second field a head variable after a first use that bound none. */
const headedSeconds: Arr.NonEmptyReadonlyArray<FieldUse> = ["head", "head-again"]

/** The second uses that bind no head variable. */
const unheadedSeconds: Arr.NonEmptyReadonlyArray<FieldUse> = unheadedFirsts

const extras: Arr.NonEmptyReadonlyArray<HeadExtra> = ["none", "literal", "claim", "duplicate"]

/** The extras that add a field of their own, which a head with no head variable holds. */
const fieldExtras: Arr.NonEmptyReadonlyArray<HeadExtra> = ["literal", "claim"]

const members: Arr.NonEmptyReadonlyArray<Member> = [
	"none",
	"join",
	"rival",
	"negation",
	"negated-claim",
	"comparison",
	"claim-match"
]

const targetNames: Arr.NonEmptyReadonlyArray<Target> = ["P", "Q"]

/**
 * The field uses and head extra of a shape whose head holds a field, every such pair once: T's first field written by a
 * head variable, with any second use; its second field the first head variable (a head or a head-again use after a
 * first that is none); or no head variable, with an extra that is a field of its own (a literal or a context term). A
 * duplicate extra repeats the first head variable, so it stands only beside one; a shape whose head holds no field is
 * no entry, and none is drawn.
 */
const headed = (
	extrasDrawn: Gen<HeadExtra>,
	bare: Gen<HeadExtra>
): Gen<Pick<Shape, "uses" | "extra">> =>
	oneOf([
		(source) => ({
			uses: ["head", source.draw(element(allUses))],
			extra: source.draw(extrasDrawn)
		}),
		(source) => ({
			uses: [source.draw(element(unheadedFirsts)), source.draw(element(headedSeconds))],
			extra: source.draw(extrasDrawn)
		}),
		(source) => ({
			uses: [source.draw(element(unheadedFirsts)), source.draw(element(unheadedSeconds))],
			extra: source.draw(bare)
		})
	])

/** One arm's shapes, every combination of target, headed field uses and extra, and further member. */
const oneArm: Gen<Shape> = (source) => ({
	target: source.draw(element(targetNames)),
	...source.draw(headed(element(extras), element(fieldExtras))),
	member: source.draw(element(members)),
	arms: 1
})

/** Two arms' shapes, of each target's headed field uses, their head adding nothing. */
const twoArms: Gen<Shape> = oneOf([
	(source): Shape => ({
		target: source.draw(element(targetNames)),
		uses: ["head", source.draw(element(allUses))],
		extra: "none",
		member: "none",
		arms: 2
	}),
	(source): Shape => ({
		target: source.draw(element(targetNames)),
		uses: [source.draw(element(unheadedFirsts)), source.draw(element(headedSeconds))],
		extra: "none",
		member: "none",
		arms: 2
	})
])

/** Every shape whose head holds a field: each one an entry. */
export const shapes: Gen<Shape> = oneOf([oneArm, twoArms])

/** Every case of a bounded generator, in the order an exhaustion meets them, every case on one recorder's buffers. */
const boxOf = <A>(generator: Gen<A>): ReadonlyArray<A> => {
	const recorded = recorder()
	const box: Array<A> = []
	let branch: Option.Option<Branch> = Option.some(firstBranch)
	while (Option.isSome(branch)) {
		const step = enumerated(recorded, generator, branch.value)
		box.push(step.generated.value)
		branch = step.next
	}
	return box
}

/** The most read-only entries a role holds beside its writes, so no role's views crowd one installation's catalog read. */
const readOnlyPerRole = 24

/** A role being filled: its entries, the ones it writes, and the relations they write. */
interface Filling {
	readonly name: string
	readonly entries: Array<readonly [string, EntrySpec]>
	readonly write: Array<string>
	readonly writes: Set<string>
}

/**
 * The installation of every shape: each writable entry in the first role whose writes do not yet reach its target,
 * each read-only one in the first role with room, a new role where none has; all in one login. Each entry's role, by
 * the entry's name.
 */
const installationOf = (
	all: ReadonlyArray<Shape>
): { readonly install: InstallSpec; readonly roleOf: ReadonlyMap<string, string> } => {
	const filling: Array<Filling> = []
	const roleOf = new Map<string, string>()
	const fresh = (): Filling => {
		const role: Filling = { name: `r${filling.length}`, entries: [], write: [], writes: new Set() }
		filling.push(role)
		return role
	}
	for (const s of all) {
		const name = entryName(s)
		const entry = entryOfShape(s)
		const c = classifyEntry(pairBase, entry)
		const role =
			c.kind === "writable"
				? (Arr.findFirst(filling, (r) => !r.writes.has(c.target)).pipe(Option.getOrUndefined) ??
					fresh())
				: (Arr.findFirst(filling, (r) => r.entries.length - r.write.length < readOnlyPerRole).pipe(
						Option.getOrUndefined
					) ?? fresh())
		role.entries.push([name, entry])
		if (c.kind === "writable") {
			role.write.push(name)
			role.writes.add(c.target)
		}
		roleOf.set(name, role.name)
	}
	const roles = nonEmpty(
		Arr.map(filling, (r): RoleSpec => ({
			name: r.name,
			entries: Rec.fromEntries(r.entries),
			write: [...r.write],
			refresh: []
		})),
		"the roles of the box"
	)
	return {
		install: {
			base: pairBase,
			roles,
			logins: [{ name: "web", roles: Arr.map(roles, (r) => r.name) }]
		},
		roleOf
	}
}

type RoleFeature =
	| `refused: ${WritableRefusal}`
	| `writable over ${Target}`
	| `writable beside ${Member}`
	| "a fill from a literal"
	| "a fill from a claim"
	| `a ${HeadField["kind"]} head field`

/** What a classification reaches: its refusal, or its target, fills, head standings and member beside it. */
export const verdictFeatures = (s: Shape, c: EntryClass): ReadonlyArray<RoleFeature> => {
	if (c.kind === "read-only") {
		return [`refused: ${c.reason}`]
	}
	const fills = Rec.values(c.fills)
	return [
		...(c.target === "P" || c.target === "Q" ? [`writable over ${c.target}` as const] : []),
		`writable beside ${s.member}`,
		...(Arr.some(fills, (f) => f.kind === "literal") ? ["a fill from a literal" as const] : []),
		...(Arr.some(fills, (f) => f.kind === "context") ? ["a fill from a claim" as const] : []),
		...Arr.map(Rec.values(c.head), (h): RoleFeature => `a ${h.kind} head field`)
	]
}

export const situations: Arr.NonEmptyReadonlyArray<RoleFeature> = [
	"refused: several-rules",
	"refused: no-supplier",
	"refused: head-term-not-own-field",
	"refused: field-not-fixed",
	"refused: key-not-determined",
	"writable over P",
	"writable over Q",
	...Arr.map(
		Arr.filter(members, (m) => m !== "rival"),
		(m): RoleFeature => `writable beside ${m}`
	),
	"a fill from a literal",
	"a fill from a claim",
	"a keyed head field",
	"a claimFixed head field",
	"a free head field"
]

/** Whether a grantee is the role named. */
const isRole = (g: PrivilegeHolder, role: string): boolean => g.kind === "role" && g.name === role

/** Whether a privilege fact concerns a role, its login, or row security on a table. */
export const concerns = (f: PrivilegeFact, role: string, table: string): boolean => {
	switch (f.kind) {
		case "privilege":
		case "attribute":
			return isRole(f.grantee, role) || f.grantee.kind === "login"
		case "membership":
			return isRole(f.member, role) || isRole(f.role, role)
		case "row-security":
			return f.table === table
	}
}

/** The empty reality: neither relation holds a fact, so Db.open meets the catalog alone. */
export const empty: HostState = new Map([
	["P", []],
	["Q", []]
])

/** The Db.open the model's box takes for a role first: its own, at the current snapshot, with its first live token. */
export const openOf = (actions: ReadonlyArray<Action>, role: string): Action =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				actions,
				(a) =>
					a.kind === "open-db" &&
					a.role.kind === "own" &&
					a.role.role === role &&
					a.snapshot === "current" &&
					a.token.kind !== "stale" &&
					a.token.kind !== "wild"
			)
		),
		`the box's live Db.open of ${role}`
	)

const box = boxOf(shapes)

export const { install, roleOf } = installationOf(box)

/** The box's installation as a world installed once per member (worlds/execute/template.ts worldTemplate), which each case's seat holds. */
export const pairWorld = worldTemplate({
	declaredIn: import.meta,
	name: "roles",
	install,
	ambient: ordinarySession
})
