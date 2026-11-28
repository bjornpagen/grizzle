/** What the property of advice.test.ts reads: its space of plans, PostgreSQL's reading of an advice string, and the
 * advice a plan states by the contract (CARRY-CONTRACT.md §5), each its own implementation. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { IndexMethod } from "#compiler/core/identity.ts"
import { indexRef, type IndexRef } from "#compiler/physical/indexes/ref.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import type { Alias } from "#compiler/sql/naming.ts"
import type {
	JoinedMember,
	JoinMember,
	JoinMethod,
	JoinTree,
	PlanItem,
	PlanLevel,
	PlanName,
	PlanScan,
	ReadPlan
} from "#compiler/sql/plan.ts"

/** What a case of the property reaches: each arm of a scan and a join, a named level, and each identifier the advice
 * parser reads only quoted. */
export type AdviceFeature =
	| "join order"
	| "hash join"
	| "index-only scan"
	| "index scan of a covering index that returns nothing"
	| "sequential scan"
	| "tid scan"
	| "bitmap heap scan"
	| "named level"
	| "quoted name"
	| "a tag's name"
	| "an append member"
	| "a UNION ALL's append level"
	| "a member joining several items, nested"
	| "a nested member on a join's inner side, named as its set"
	| "a read of the system catalog, no atom"

export const adviceFeatures = [
	"join order",
	"hash join",
	"index-only scan",
	"index scan of a covering index that returns nothing",
	"sequential scan",
	"tid scan",
	"bitmap heap scan",
	"named level",
	"quoted name",
	"a tag's name",
	"an append member",
	"a UNION ALL's append level",
	"a member joining several items, nested",
	"a nested member on a join's inner side, named as its set",
	"a read of the system catalog, no atom"
] as const satisfies ReadonlyArray<Reached<AdviceFeature>>

/** The columns an index stores and a read needs, from one small pool, so covering is often met and often missed. */
const columns = ["doc", "f1", "f2", "v"] as const

/** Index and schema names: plain ones, one with a capital and one with a quote, which the parser reads only quoted, and
 * the names of advice tags, which a bare spelling would read as the tag. */
const indexNames = [
	"doc_pkey",
	"node_doc_f1",
	"Doc_Key",
	'we"ird',
	"seq_scan",
	"no_gather"
] as const
const schemas = ["public", "qti", "Odd"] as const
const methods = ["btree", "gist", "gin", "hnsw"] as const satisfies ReadonlyArray<IndexMethod>

const someColumns: Gen<ReadonlyArray<string>> = (source) =>
	Arr.filter(columns, () => source.draw(boolean))

const indexGen: Gen<IndexRef> = (source) =>
	indexRef({
		name: { schema: source.draw(element(schemas)), name: source.draw(element(indexNames)) },
		method: source.draw(element(methods)),
		stores: source.draw(someColumns),
		returns: source.draw(boolean)
	})

const scanGen: Gen<PlanScan<IndexRef>> = (source) => {
	switch (source.draw(int(0, 5))) {
		case 0:
			return { kind: "seq" }
		case 5:
			return { kind: "catalog" }
		case 1:
			return { kind: "tid" }
		case 2:
			return { kind: "rows" }
		case 3:
			return {
				kind: "bitmap",
				index: source.draw(indexGen),
				bound: source.draw(someColumns),
				needs: source.draw(someColumns)
			}
		default:
			return {
				kind: "index",
				index: source.draw(indexGen),
				bound: source.draw(someColumns),
				needs: source.draw(someColumns)
			}
	}
}

/** A member's items, in join order. */
const itemsOf = (member: JoinMember<IndexRef>): ReadonlyArray<PlanItem<IndexRef>> =>
	member.kind === "item"
		? [member.item]
		: [...itemsOf(member.tree.first), ...Arr.flatMap(member.tree.joined, (j) => itemsOf(j.member))]

/** `list` in an order `source` draws: each next element drawn from those left. */
const shuffled =
	<A>(list: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(source) => {
		const left = [...list]
		const out: Array<A> = []
		while (left.length > 0) {
			const [taken] = left.splice(source.draw(int(0, left.length - 1)), 1)
			if (taken !== undefined) {
				out.push(taken)
			}
		}
		return out
	}

/**
 * A plan of one to three levels, each a join problem of one item or a tree of them, nested to two levels (a tree's
 * first a tree of its own, a joined member a tree) with up to two append members, or a UNION ALL's append level of one
 * to three, every alias minted by one scope (sql/naming.ts AdviceScope), each tree's range-table order its items in an
 * order drawn apart from its join order, and each level the statement's top or one named by an alias of the scope.
 */
export const planGen: Gen<ReadPlan<IndexRef>> = (source) => {
	const scope = new AdviceScope()
	const alias = () => scope.alias({ kind: "internal", purpose: "a planned item" })
	const item = (): PlanItem<IndexRef> => ({ alias: alias(), scan: source.draw(scanGen) })
	const method = element(["nestedLoop", "hash"] as const satisfies ReadonlyArray<JoinMethod>)
	const memberGen = (depth: number): JoinMember<IndexRef> => {
		if (depth > 1 || source.draw(int(0, 2)) > 0) {
			return { kind: "item", item: item() }
		}
		const first = memberGen(depth + 1)
		const [j0, ...js] = source.draw(
			array(
				(s): JoinedMember<IndexRef> => ({ member: memberGen(depth + 1), join: s.draw(method) }),
				{ min: 1, max: 3 }
			)
		)
		if (j0 === undefined) {
			return first
		}
		const tree: JoinTree<IndexRef> = { first, joined: [j0, ...js] }
		const [r0, ...rs] = source.draw(
			shuffled(
				Arr.map(
					[...itemsOf(first), ...Arr.flatMap(tree.joined, (j) => itemsOf(j.member))],
					(i): Alias => i.alias
				)
			)
		)
		return r0 === undefined ? first : { kind: "tree", tree, range: [r0, ...rs] }
	}
	const level = (): PlanLevel<IndexRef> => {
		const name: PlanName = source.draw(boolean) ? { kind: "top" } : { kind: "named", name: alias() }
		const member = (): PlanItem<IndexRef> => ({ alias: alias(), scan: { kind: "rows" } })
		if (source.draw(int(0, 3)) === 0) {
			return {
				kind: "append",
				name,
				members: [member(), ...source.draw(array(member, { min: 0, max: 2 }))]
			}
		}
		const problem = memberGen(0)
		const appended = source.draw(array(member, { min: 0, max: 2 }))
		return { kind: "joins", name, problem, appended }
	}
	return { levels: source.draw(array(level, { min: 1, max: 3 })) }
}

/** One atom of advice as PostgreSQL reads it: its tag, its targets, each `alias` or `alias@level`, and its index for a
 * scan through one, each identifier as its parser reads it. */
export interface Atom {
	readonly tag: string
	readonly targets: ReadonlyArray<string>
	readonly index: string | undefined
}

/** An atom's identity, for comparing two lists of them as multisets. */
export const atomText = (a: Atom): string =>
	`${a.tag}(${Arr.join(a.targets, " ")}${a.index === undefined ? "" : ` ${a.index}`})`

/** Whether a code unit stands in a bare word of the advice scanner's (pgpa_scanner.l identifier): a letter or `_`, and
 * past its first a digit or `$` too. */
const wordUnit = (unit: number, first: boolean): boolean =>
	(unit >= 0x41 && unit <= 0x5a) ||
	(unit >= 0x61 && unit <= 0x7a) ||
	unit === 0x5f ||
	(!first && ((unit >= 0x30 && unit <= 0x39) || unit === 0x24))

/** A one-unit text's code unit. */
const unitOf = (ch: string): number => Option.getOrElse(Str.charCodeAt(ch, 0), () => 0)

/** Whether the advice scanner reads a name bare as itself: a word of no capital (`wordUnit`). */
export const readsBare = (name: string): boolean =>
	name.length > 0 &&
	name === Str.toLowerCase(name) &&
	Arr.every(Str.split(name, ""), (ch, i) => wordUnit(unitOf(ch), i === 0))

/** Every tag pg_plan_advice's scanner reads a bare word as, wherever it stands (pgpa_ast.c pgpa_parse_advice_tag). */
const tags: ReadonlySet<string> = new Set([
	"bitmap_heap_scan",
	"do_not_scan",
	"foreign_join",
	"gather",
	"gather_merge",
	"hash_join",
	"index_only_scan",
	"index_scan",
	"join_order",
	"merge_join_materialize",
	"merge_join_plain",
	"nested_loop_materialize",
	"nested_loop_memoize",
	"nested_loop_plain",
	"no_gather",
	"partitionwise",
	"semijoin_non_unique",
	"semijoin_unique",
	"seq_scan",
	"tid_scan"
])

/**
 * An advice string's atoms as pg_plan_advice's scanner and grammar read it (contrib/pg_plan_advice pgpa_scanner.l,
 * pgpa_parser.y): items separated by whitespace, each a tag and a parenthesized list; a bare word downcased, and read
 * as a tag wherever it spells one, a double-quoted identifier as it is, a doubled quote one quote; a target an identifier or `identifier@identifier`; an index
 * scan's targets in pairs with their indexes, `schema.name`. A string it cannot read is a failure of the printer's.
 */
export const parsedAtoms = (advice: string): ReadonlyArray<Atom> => {
	const chars = advice === "" ? [] : Str.split(advice, "")
	const at = (k: number): string => chars[k] ?? ""
	const tokens: Array<string> = []
	let i = 0
	while (i < chars.length) {
		const ch = at(i)
		if (ch === " " || ch === "\t" || ch === "\n") {
			i += 1
		} else if (ch === '"') {
			let name = ""
			i += 1
			for (;;) {
				if (i >= chars.length) {
					throw new Error(`an unterminated quoted identifier in ${advice}`)
				}
				if (at(i) === '"' && at(i + 1) === '"') {
					name += '"'
					i += 2
				} else if (at(i) === '"') {
					i += 1
					break
				} else {
					name += at(i)
					i += 1
				}
			}
			tokens.push(`=${name}`)
		} else if (ch === "(" || ch === ")" || ch === "@" || ch === ".") {
			tokens.push(ch)
			i += 1
		} else {
			let word = ""
			while (i < chars.length && wordUnit(unitOf(at(i)), word === "")) {
				word += at(i)
				i += 1
			}
			if (word === "") {
				throw new Error(`an unreadable character ${ch} in ${advice}`)
			}
			const lower = Str.toLowerCase(word)
			tokens.push(tags.has(lower) ? `#${lower}` : `=${lower}`)
		}
	}
	const atoms: Array<Atom> = []
	let t = 0
	const ident = (): string => {
		const tok = tokens[t]
		if (tok === undefined || !Str.startsWith("=")(tok)) {
			throw new Error(`an identifier where ${tok ?? "the end"} stands in ${advice}`)
		}
		t += 1
		return Str.slice(1)(tok)
	}
	const expect = (punct: string): void => {
		if (tokens[t] !== punct) {
			throw new Error(`${punct} where ${tokens[t] ?? "the end"} stands in ${advice}`)
		}
		t += 1
	}
	const targetOf = (): string => {
		const alias = ident()
		if (tokens[t] !== "@") {
			return alias
		}
		t += 1
		return `${alias}@${ident()}`
	}
	while (t < tokens.length) {
		const word = tokens[t]
		if (word === undefined || !Str.startsWith("#")(word)) {
			throw new Error(`a tag where ${word ?? "the end"} stands in ${advice}`)
		}
		t += 1
		const tag = Str.toUpperCase(Str.slice(1)(word))
		expect("(")
		if (tag === "JOIN_ORDER") {
			/** The members of one problem up to its closing parenthesis, a nested one bracketed, flattened. */
			const members = (): ReadonlyArray<string> => {
				const read: Array<string> = []
				while (tokens[t] !== ")") {
					if (tokens[t] === "(") {
						t += 1
						const nested = members()
						expect(")")
						read.push("(")
						for (const m of nested) {
							read.push(m)
						}
						read.push(")")
					} else {
						read.push(targetOf())
					}
				}
				return read
			}
			const targets = members()
			expect(")")
			atoms.push({ tag, targets, index: undefined })
			continue
		}
		const indexed = tag === "INDEX_SCAN" || tag === "INDEX_ONLY_SCAN"
		const targets: Array<string> = []
		while (tokens[t] !== ")") {
			if (!indexed && tokens[t] === "(") {
				t += 1
				const set: Array<string> = []
				while (tokens[t] !== ")") {
					set.push(targetOf())
				}
				expect(")")
				atoms.push({ tag, targets: ["(", ...set, ")"], index: undefined })
				continue
			}
			const target = targetOf()
			if (indexed) {
				const schema = ident()
				expect(".")
				atoms.push({ tag, targets: [target], index: `${schema}.${ident()}` })
			} else {
				targets.push(target)
			}
		}
		expect(")")
		if (!indexed) {
			for (const target of targets) {
				atoms.push({ tag, targets: [target], index: undefined })
			}
		}
	}
	return atoms
}

/**
 * The atoms a plan states (CARRY-CONTRACT.md §5), the specification the printer is held to: for each level, its join
 * order where its problem joins two items or more, each join's members in order, a member joining several items its
 * own order bracketed by parentheses; for each member after a join's first, the method that puts it inner, a nested
 * loop's plain one or a hash join, named as its item or, joining several, as the set of them in its range-table order,
 * bracketed; for each stored relation its scan, an index-only scan only where its index returns what it stores and
 * stores every column the read needs; and for every item, an append relation's members among them, no Gather.
 */
export const statedAtoms = (plan: ReadPlan<IndexRef>): ReadonlyArray<Atom> =>
	Arr.flatMap(plan.levels, (level) => {
		const named = (a: Alias): string => (level.name.kind === "top" ? a : `${a}@${level.name.name}`)
		const targetOf = (item: PlanItem<IndexRef>): string => named(item.alias)
		const one = (tag: string, item: PlanItem<IndexRef>): Atom => ({
			tag,
			targets: [targetOf(item)],
			index: undefined
		})
		const order = (member: JoinMember<IndexRef>): ReadonlyArray<string> =>
			member.kind === "item"
				? [targetOf(member.item)]
				: [
						"(",
						...order(member.tree.first),
						...Arr.flatMap(member.tree.joined, (j) => order(j.member)),
						")"
					]
		const methods = (member: JoinMember<IndexRef>): ReadonlyArray<Atom> =>
			member.kind === "item"
				? []
				: [
						...methods(member.tree.first),
						...Arr.flatMap(member.tree.joined, (j) => [
							{
								tag: j.join === "hash" ? "HASH_JOIN" : "NESTED_LOOP_PLAIN",
								targets:
									j.member.kind === "item"
										? [targetOf(j.member.item)]
										: ["(", ...Arr.map(j.member.range, named), ")"],
								index: undefined
							},
							...methods(j.member)
						])
					]
		const scanOf = (item: PlanItem<IndexRef>): ReadonlyArray<Atom> => {
			const scan = item.scan
			switch (scan.kind) {
				case "seq":
					return [one("SEQ_SCAN", item)]
				case "tid":
					return [one("TID_SCAN", item)]
				case "bitmap":
					return [one("BITMAP_HEAP_SCAN", item)]
				case "rows":
				case "catalog":
					return []
				case "index": {
					const covered = Arr.every(scan.needs, (c) => Arr.contains(scan.index.stores, c))
					return [
						{
							tag: scan.index.returns && covered ? "INDEX_ONLY_SCAN" : "INDEX_SCAN",
							targets: [targetOf(item)],
							index: `${scan.index.name.schema}.${scan.index.name.name}`
						}
					]
				}
			}
		}
		const items = level.kind === "joins" ? itemsOf(level.problem) : []
		const scanned = level.kind === "joins" ? [...items, ...level.appended] : level.members
		const scans = Arr.flatMap(scanned, scanOf)
		const problem = level.kind === "joins" ? level.problem : undefined
		return [
			...(problem?.kind === "tree"
				? [
						{ tag: "JOIN_ORDER", targets: order(problem).slice(1, -1), index: undefined },
						...methods(problem)
					]
				: []),
			...scans,
			...Arr.flatMap(scanned, (item) =>
				item.scan.kind === "catalog" ? [] : [one("NO_GATHER", item)]
			)
		]
	})
