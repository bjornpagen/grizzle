import type { Broken, Corruption } from "@bjornpagen/testing/lsw"
import { Array as Arr, Record as Rec } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { ExprDesc, MatchDesc, QueryDesc, QueryStageDesc, RuleDesc } from "#compiler/ir/desc.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"

/**
 * Faults planted in a generated query's Description, each one a refusal the checker must give with its reason at the
 * location the fault determines: the planted declaration, or the entry of a binding or a bind map that names a
 * variable no rule declares. A read of a change, a delta source, is planted at a stored relation's match, refused
 * outside a ChangeSet read-back and admitted inside one, and at the roster's, refused in a read-back too.
 */

/** The rules a fault breaks, by the model's own names. */
export type FaultRule =
	| "an attachment binding no parent column"
	| "an undeclared variable in a binding"
	| "an undeclared variable in a bind map"
	| "a delta outside a read-back"
	| "a delta of the roster"

/** How a planted Description is read: as a query, or as a ChangeSet's read-back. */
export type Boundary = "query" | "read-back"

/**
 * A planted fault: the Description, how it is read, the reason and location of its refusal, and a reading that admits
 * the same Description, or none.
 */
export interface Planted {
	readonly desc: QueryDesc
	readonly boundary: Boundary
	readonly reason: CompileReasonTag
	readonly at: SourceLoc
	readonly admittedAs: Boundary | "none"
}

/** The live artifact: a generated query read's Description and the case's roster, which a fault reads. */
export interface Live {
	readonly desc: QueryDesc
	readonly roster: string
	readonly stored: ReadonlySet<string>
}

export const liveOf = (c: ProgramCase, desc: QueryDesc): Live => ({
	desc,
	roster: c.schema.roster.name,
	stored: new Set(Arr.map(c.schema.relations, (r) => r.name))
})

/** Where a planted declaration is located: a location no builder gives, so a refusal located there is the fault's. */
const plantedLoc = SourceLoc("the planted fault", ["planted"])

type RulesStage = Extract<QueryStageDesc, { readonly kind: "rules" }>

/**
 * `stage` with the first rules stage its inputs lead to rewritten by `edit`, or undefined where none does or the edit
 * declines: a recursive stage holds rules of its own, which no fault here reads.
 */
const withRules = (
	stage: QueryStageDesc,
	edit: (rules: RulesStage) => QueryStageDesc | undefined
): QueryStageDesc | undefined => {
	switch (stage.kind) {
		case "rules":
			return edit(stage)
		case "recursive":
			return undefined
		case "union":
		case "attach":
		case "named":
		case "order":
		case "take":
		case "approx": {
			const input = withRules(stage.input, edit)
			return input === undefined ? undefined : { ...stage, input }
		}
	}
}

/** The first rules stage `stage` leads to, or none. */
const rulesOf = (stage: QueryStageDesc): RulesStage | undefined => {
	switch (stage.kind) {
		case "rules":
			return stage
		case "recursive":
			return undefined
		case "union":
		case "attach":
		case "named":
		case "order":
		case "take":
		case "approx":
			return rulesOf(stage.input)
	}
}

/** A rules stage with arm `arm`'s match `index` replaced by `edit` of it. */
const editMatch =
	(arm: number, index: number, edit: (m: MatchDesc) => MatchDesc) =>
	(rules: RulesStage): QueryStageDesc => {
		const arms = Arr.map(rules.arms, (a, i): RuleDesc =>
			i === arm ? { ...a, matches: Arr.map(a.matches, (m, j) => (j === index ? edit(m) : m)) } : a
		)
		return { ...rules, arms }
	}

/** Every match of the first rules stage, by its arm and its index. */
const matchesOf = (
	q: QueryDesc
): ReadonlyArray<{ readonly arm: number; readonly index: number; readonly match: MatchDesc }> =>
	Arr.flatMap(rulesOf(q.stage)?.arms ?? [], (a, arm) =>
		Arr.map(a.matches, (match, index) => ({ arm, index, match }))
	)

/** A variable no rule declares. */
const ghost: ExprDesc = { kind: "var", var: "ghost" }

/** The Description with its first rules stage edited at a match, or none where the edit reaches none. */
const atMatch = (
	live: Live,
	arm: number,
	index: number,
	edit: (m: MatchDesc) => MatchDesc
): QueryDesc | undefined => {
	const stage = withRules(live.desc.stage, editMatch(arm, index, edit))
	return stage === undefined ? undefined : { stage }
}

const broken = (planted: Planted, at: string): Broken<Planted> => ({
	value: planted.desc,
	refusal: planted,
	at
})

/** The faults, each with every site of the live Description where it applies. */
export const faults: Arr.NonEmptyReadonlyArray<Corruption<Live, Planted, FaultRule>> = [
	{
		rule: "an attachment binding no parent column",
		from: "wild",
		weight: 1,
		sites: (live) => {
			const rules = rulesOf(live.desc.stage)
			if (rules === undefined) {
				return []
			}
			const attached = (input: QueryStageDesc): QueryStageDesc => ({
				kind: "attach",
				input,
				attach: { name: "planted", child: { stage: rules }, loc: plantedLoc }
			})
			const stage = live.desc.stage
			const desc: QueryDesc = {
				stage: stage.kind === "order" ? { ...stage, input: attached(stage.input) } : attached(stage)
			}
			return [
				broken(
					{
						desc,
						boundary: "query",
						reason: "AttachedParentUnbound",
						at: plantedLoc,
						admittedAs: "none"
					},
					"the root"
				)
			]
		}
	},
	{
		rule: "an undeclared variable in a binding",
		from: "stale",
		weight: 1,
		sites: (live) =>
			Arr.flatMap(matchesOf(live.desc), ({ arm, index, match }) =>
				Arr.flatMap(Rec.keys(match.bindings).slice(0, 1), (field) => {
					const desc = atMatch(live, arm, index, (m) => ({
						...m,
						bindings: { ...m.bindings, [field]: ghost }
					}))
					return desc === undefined
						? []
						: [
								broken(
									{
										desc,
										boundary: "query",
										reason: "MalformedDescription",
										at: childLoc(match.loc, "bindings", field),
										admittedAs: "none"
									},
									`arm ${arm} match ${index} binding ${field}`
								)
							]
				})
			)
	},
	{
		rule: "an undeclared variable in a bind map",
		from: "stale",
		weight: 1,
		sites: (live) =>
			Arr.flatMap(matchesOf(live.desc), ({ arm, index, match }) => {
				const source = match.source
				if (source.kind !== "query") {
					return []
				}
				return Arr.flatMap(Rec.keys(source.bind).slice(0, 1), (param) => {
					const desc = atMatch(live, arm, index, (m) =>
						m.source.kind === "query"
							? { ...m, source: { ...m.source, bind: { ...m.source.bind, [param]: ghost } } }
							: m
					)
					return desc === undefined
						? []
						: [
								broken(
									{
										desc,
										boundary: "query",
										reason: "MalformedDescription",
										at: childLoc(match.loc, "bind", param),
										admittedAs: "none"
									},
									`arm ${arm} match ${index} bind ${param}`
								)
							]
				})
			})
	},
	{
		rule: "a delta outside a read-back",
		from: "stale",
		weight: 1,
		sites: (live) =>
			Arr.flatMap(matchesOf(live.desc), ({ arm, index, match }) => {
				const source = match.source
				if (source.kind !== "relation" || !live.stored.has(source.name)) {
					return []
				}
				const desc = atMatch(live, arm, index, (m) => ({
					...m,
					source: {
						kind: "delta",
						side: index % 2 === 0 ? "added" : "removed",
						relation: source.name
					}
				}))
				return desc === undefined
					? []
					: [
							broken(
								{
									desc,
									boundary: "query",
									reason: "MalformedDescription",
									at: match.loc,
									admittedAs: "read-back"
								},
								`arm ${arm} match ${index} of ${source.name}`
							)
						]
			})
	},
	{
		rule: "a delta of the roster",
		from: "wild",
		weight: 1,
		sites: (live) =>
			Arr.flatMap(matchesOf(live.desc), ({ arm, index, match }) => {
				const source = match.source
				if (source.kind !== "relation" || source.name !== live.roster) {
					return []
				}
				const desc = atMatch(live, arm, index, (m) => ({
					...m,
					source: { kind: "delta", side: "added", relation: source.name }
				}))
				return desc === undefined
					? []
					: [
							broken(
								{
									desc,
									boundary: "read-back",
									reason: "MalformedDescription",
									at: match.loc,
									admittedAs: "none"
								},
								`arm ${arm} match ${index} of the roster`
							)
						]
			})
	}
]
