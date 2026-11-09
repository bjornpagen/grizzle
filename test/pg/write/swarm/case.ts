/**
 * The cases the family swarm search draws (test/pg/write/swarm/families.test.ts): a schema (spec.ts), then its
 * ChangeSets, each drawn from the state the ones before it leave where they are accepted: the first inserts an
 * instance of the core beside plain rows, made lawful where the case keeps no unlawful write (the pure sets every
 * immediate containment reads hold every value it needs, a referrer names a stored row or member, a member key's
 * members differ, an owner one law contains in its members holds its member's `v`); then follow-ups over the stored
 * rows (test/support/families/fill.ts `followUpGen`: an owner's put, counted members inserted, an ordered member deleted,
 * appended or moved), each beside the plain writes that keep the laws and a query's insert; a put from a query; and a
 * delete of everything. A case that keeps unlawful writes breaks a law in its last ChangeSet: a pure set's needed value
 * deleted, a referrer naming no row, two facts at one key, or a counted member naming no owner.
 */
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { keep, type Swarm } from "@grizzle/testing/swarm"
import { Array as Arr, Option } from "effect"
import {
	absentId,
	type PlainOp,
	type Placed,
	type QueryInsert,
	type Shape,
	type State,
	type Step,
	type SwarmCase
} from "#test/pg/write/swarm/oracle.ts"
import {
	familyOf,
	featuresGen,
	holderOf,
	swarmInstanceGen,
	nestedOnly,
	type PlainRow,
	samePlain,
	type SwarmFeature,
	type SwarmSpec,
	swarmSpecGen
} from "#test/pg/write/swarm/spec.ts"
import { defined } from "#test/support/assert.ts"
import {
	type FillSpec,
	followUpGen,
	followUpRows,
	type InstanceRow
} from "#test/support/families/fill.ts"
import { upTo } from "#test/support/up-to.ts"

/** Element of a non-empty list drawn uniformly. */
const pick =
	<A>(xs: Arr.NonEmptyReadonlyArray<A>): Gen<A> =>
	(source) =>
		defined(xs[source.draw(int(0, xs.length - 1))], "a drawn element")

const membership = (row: InstanceRow, f: number) =>
	Option.getOrUndefined(Arr.findFirst(row.memberOf, (m) => m.family === f))

/** The values each pure set must hold for the immediate containments into it: every `v` of the relations they read. */
const needed = (spec: SwarmSpec, rows: ReadonlyArray<InstanceRow>): ReadonlyArray<PlainRow> =>
	Arr.flatMap(spec.laws, (law): ReadonlyArray<PlainRow> => {
		const from =
			law.kind === "into set"
				? law.relation
				: law.kind === "selected"
					? holderOf(spec.fill, defined(spec.fill.copies[law.copy], "a copy"))
					: undefined
		if (from === undefined || (law.kind !== "into set" && law.kind !== "selected")) {
			return []
		}
		return Arr.map(
			Arr.dedupe(Arr.flatMap(rows, (r) => (r.relation === from ? [r.v] : []))),
			(x): PlainRow => ({ kind: "set", plain: law.plain, x })
		)
	})

/** The rows of an instance made to keep its laws where they can be: a keyed family's members, an owner's `v`, a check. */
const lawfulRows = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyArray<InstanceRow> => {
	const vs = new Map(Arr.map(rows, (r) => [r.id, r.v] as const))
	for (const law of spec.laws) {
		if (law.kind === "member key") {
			const owners = Arr.dedupe(
				Arr.flatMap(rows, (r) =>
					Option.toArray(Option.fromNullishOr(membership(r, law.family)?.owner))
				)
			)
			for (const owner of owners) {
				const siblings = Arr.filter(rows, (r) => membership(r, law.family)?.owner === owner)
				for (const [k, s] of siblings.entries()) {
					vs.set(s.id, BigInt(k) - 1n)
				}
			}
		}
	}
	for (const law of spec.laws) {
		if (law.kind === "owner into members") {
			const family = familyOf(spec, law.family)
			for (const owner of Arr.filter(rows, (r) => r.relation === family.owner)) {
				const members = Arr.filter(rows, (r) => membership(r, law.family)?.owner === owner.id)
				const first = members[0]
				if (first !== undefined && (!law.selected || members.length === 1)) {
					vs.set(owner.id, vs.get(first.id) ?? first.v)
				}
			}
		}
	}
	for (const law of spec.laws) {
		if (law.kind === "check" && law.family !== undefined) {
			const f = law.family
			for (const row of Arr.filter(rows, (r) => r.relation === law.relation)) {
				const n = Arr.filter(rows, (r) => membership(r, f)?.owner === row.id).length
				const v = vs.get(row.id) ?? row.v
				if (n >= 3 && v < 0n) {
					vs.set(row.id, -v)
				}
			}
		}
	}
	return Arr.map(rows, (r) => ({ ...r, v: vs.get(r.id) ?? r.v }))
}

/** A referrer's rows over a state: each names a stored row or member its law reads, or any row where it has none. */
const referrersGen =
	(
		spec: SwarmSpec,
		rows: ReadonlyArray<InstanceRow>,
		first: number
	): Gen<ReadonlyArray<PlainRow>> =>
	(source) =>
		Arr.flatMap(spec.plains, (p, plain): ReadonlyArray<PlainRow> => {
			if (p.kind !== "referrer") {
				return []
			}
			const law = Arr.findFirst(
				spec.laws,
				(l) => (l.kind === "into rows" || l.kind === "into members") && l.plain === plain
			).pipe(Option.getOrUndefined)
			const targets: ReadonlyArray<readonly [number, bigint]> =
				law?.kind === "into rows"
					? Arr.flatMap(rows, (r) =>
							r.relation === law.relation ? [[r.id, BigInt(source.draw(int(-2, 3)))] as const] : []
						)
					: law?.kind === "into members"
						? Arr.flatMap(rows, (r) => {
								const m = membership(r, law.family)
								return m === undefined ? [] : [[m.owner, r.v] as const]
							})
						: Arr.map(rows, (r) => [r.id, BigInt(source.draw(int(-2, 3)))] as const)
			if (!Arr.isReadonlyArrayNonEmpty(targets)) {
				return []
			}
			return upTo(source.draw(int(0, 3)), (i): PlainRow => {
				const [r, x] = source.draw(pick(targets))
				return { kind: "referrer", plain, id: first + plain * 100 + i, r, x }
			})
		})

/** Whether the rules admit a delete of relation `r`'s rows: no tree's, no member that owns a sequence, no member of an
 * immutable owner's family. */
const deletable = (core: FillSpec, r: number): boolean =>
	!Arr.some(core.families, (f) => f.kind === "tree" && f.member === r) &&
	!(
		Arr.some(core.families, (f) => f.member === r) &&
		Arr.some(core.families, (f) => f.owner === r && f.kind !== "counted")
	) &&
	!Arr.some(
		core.families,
		(f) =>
			f.member === r && f.kind !== "tree" && !defined(core.relations[f.owner], "an owner").mutable
	)

/** The relations a put from a query may write: no family's member, mutable where it owns a family, with a row. */
const queryPuttable = (spec: SwarmSpec, rows: ReadonlyArray<InstanceRow>): ReadonlyArray<number> =>
	Arr.filter(
		Arr.map(spec.fill.relations, (_, r) => r),
		(r) =>
			!Arr.some(spec.fill.families, (f) => f.member === r) &&
			(defined(spec.fill.relations[r], "a relation").mutable ||
				!Arr.some(spec.fill.families, (f) => f.owner === r)) &&
			Arr.some(rows, (x) => x.relation === r)
	)

/** A state's plain rows after plain writes, in order (oracle.ts states the same for its expectation). */
const plainAfter = (
	plain: ReadonlyArray<PlainRow>,
	ops: ReadonlyArray<PlainOp>
): ReadonlyArray<PlainRow> =>
	Arr.reduce(ops, plain, (rows, o) => {
		const left = Arr.filter(
			rows,
			(r) =>
				!samePlain(r, o.row) &&
				!(
					o.op === "put" &&
					o.row.kind === "referrer" &&
					r.kind === "referrer" &&
					r.plain === o.row.plain &&
					r.id === o.row.id
				)
		)
		return o.op === "delete" ? left : [...left, o.row]
	})

/**
 * The plain writes that keep a follow-up's laws over the rows it leaves: each pure set's missing needed values
 * inserted, each referrer naming a row or member the rows no longer hold deleted, and now and then another referrer, a
 * referrer put, or a set's spare value deleted; where `breaks`, one law broken instead: a needed value deleted or a
 * referrer naming no row inserted.
 */
const plainOpsGen =
	(
		spec: SwarmSpec,
		plain: ReadonlyArray<PlainRow>,
		rows: ReadonlyArray<InstanceRow>,
		next: number,
		placed: (immediate: boolean) => Placed,
		breaks: boolean
	): Gen<ReadonlyArray<PlainOp>> =>
	(source) => {
		const need = needed(spec, rows)
		const inserts = Arr.flatMap(need, (row): ReadonlyArray<PlainOp> =>
			Arr.some(plain, (p) => samePlain(p, row)) ? [] : [{ op: "insert", row, at: placed(true) }]
		)
		const gone = Arr.flatMap(plain, (p): ReadonlyArray<PlainOp> => {
			if (p.kind !== "referrer") {
				return []
			}
			const law = Arr.findFirst(
				spec.laws,
				(l) => (l.kind === "into rows" || l.kind === "into members") && l.plain === p.plain
			).pipe(Option.getOrUndefined)
			const holds =
				law?.kind === "into members"
					? Arr.some(rows, (r) => membership(r, law.family)?.owner === p.r && r.v === p.x)
					: law?.kind === "into rows"
						? Arr.some(rows, (r) => r.id === p.r && r.relation === law.relation)
						: true
			return holds ? [] : [{ op: "delete", row: p, at: placed(false) }]
		})
		const extra: Array<PlainOp> = []
		const fresh = source.draw(referrersGen(spec, rows, next))
		const added = Arr.take(fresh, source.draw(int(0, 2)))
		for (const row of added) {
			extra.push({ op: source.draw(boolean) ? "insert" : "put", row, at: placed(false) })
		}
		const spare = Arr.filter(
			plain,
			(p) => p.kind === "set" && !Arr.some(need, (n) => samePlain(n, p))
		)
		if (Arr.isReadonlyArrayNonEmpty(spare) && source.draw(boolean)) {
			extra.push({ op: "delete", row: source.draw(pick(spare)), at: placed(false) })
		}
		if (!breaks) {
			return [...inserts, ...gone, ...extra]
		}
		const held = Arr.filter(need, (n) =>
			Arr.some([...plain, ...Arr.map(inserts, (i) => i.row)], (p) => samePlain(p, n))
		)
		const referrers = Arr.flatMap(spec.plains, (p, j) => (p.kind === "referrer" ? [j] : []))
		const broken: ReadonlyArray<PlainOp> =
			Arr.isReadonlyArrayNonEmpty(held) &&
			(source.draw(boolean) || !Arr.isReadonlyArrayNonEmpty(referrers))
				? [{ op: "delete", row: source.draw(pick(held)), at: placed(false) }]
				: Arr.isReadonlyArrayNonEmpty(referrers)
					? [
							{
								op: "insert",
								row: {
									kind: "referrer",
									plain: source.draw(pick(referrers)),
									id: next + 99,
									r: absentId,
									x: 0n
								},
								at: placed(false)
							}
						]
					: []
		return [...inserts, ...gone, ...extra, ...broken]
	}

/** The kinds of a case's later ChangeSets, in order. */
type Later = "follow" | "query put" | "delete all"

/**
 * A case's ChangeSets over `spec` under a swarm: the first insert, then up to three follow-ups where the swarm keeps
 * them, a put from a query, and a delete of everything where the rules admit one; the last breaks a law where the
 * swarm keeps unlawful writes.
 */
export const stepsGen =
	(features: Swarm<SwarmFeature>, scale: boolean, spec: SwarmSpec): Gen<ReadonlyArray<Step>> =>
	(source) => {
		const kept = (feature: SwarmFeature): boolean => source.draw(keep(features, feature))
		const unlawful = kept("unlawful")
		const strata = kept("strata")
		const shape = (): Shape => ({ split: kept("split members"), repeat: kept("repeated fact") })
		const later: Array<Later> = [
			...upTo(kept("follow-ups") ? source.draw(int(1, 3)) : 0, (): Later => "follow"),
			...(kept("query put") ? ["query put" as const] : []),
			...(kept("delete all") ? ["delete all" as const] : [])
		]
		const placedBy =
			(breaks: boolean) =>
			(immediate: boolean): Placed =>
				!strata
					? "with"
					: source.draw(
							pick(
								immediate && !breaks
									? (["before", "with"] as const)
									: (["before", "with", "after"] as const)
							)
						)
		const drawn = source.draw(swarmInstanceGen(spec.fill, scale ? 240 : 24, 1, 0))
		const rows = unlawful ? drawn : lawfulRows(spec, drawn)
		const firstBreaks = unlawful && later.length === 0
		const sets = Arr.flatMap(spec.plains, (p, plain): ReadonlyArray<PlainRow> =>
			p.kind === "set"
				? Arr.map(
						Arr.filter(Arr.range(-3, 4), () => source.draw(boolean)),
						(x): PlainRow => ({ kind: "set", plain, x: BigInt(x) })
					)
				: []
		)
		const firstPlain: ReadonlyArray<PlainOp> = [
			...Arr.map(Arr.dedupeWith([...needed(spec, rows), ...sets], samePlain), (row): PlainOp => ({
				op: "insert",
				row,
				at: placedBy(firstBreaks)(true)
			})),
			...Arr.map(source.draw(referrersGen(spec, rows, 5000)), (row): PlainOp => ({
				op: "insert",
				row,
				at: placedBy(firstBreaks)(false)
			}))
		]
		const tops = Arr.filter(
			rows,
			(r) =>
				!nestedOnly(spec.fill, r.relation) &&
				!Arr.some(r.memberOf, (m) => familyOf(spec, m.family).kind === "tree")
		)
		const counted = Arr.filter(rows, (r) =>
			Arr.some(r.memberOf, (m) => familyOf(spec, m.family).kind === "counted")
		)
		const breakFirst = firstBreaks ? source.draw(int(0, 2)) : -1
		const conflict =
			breakFirst === 0 && Arr.isReadonlyArrayNonEmpty(tops) ? source.draw(pick(tops)).id : undefined
		const orphan =
			breakFirst === 1 && Arr.isReadonlyArrayNonEmpty(counted)
				? source.draw(pick(counted)).id
				: undefined
		const dropped =
			breakFirst === 2
				? Arr.filter(
						firstPlain,
						(o) =>
							!(
								o.row.kind === "set" &&
								Arr.some(needed(spec, rows), (n) => samePlain(n, o.row)) &&
								source.draw(boolean)
							)
					)
				: firstPlain
		const steps: Array<Step> = [
			{ kind: "insert", rows, plain: dropped, conflict, orphan, shape: shape() }
		]
		let state: State = { rows, plain: plainAfter([], dropped) }
		for (const [i, kind] of later.entries()) {
			const breaks = unlawful && i === later.length - 1
			const next = 6000 + i * 1000
			switch (kind) {
				case "follow": {
					const followUp = Option.getOrUndefined(source.draw(followUpGen(spec.fill, state.rows)))
					const after = followUp === undefined ? state.rows : followUpRows(state.rows, followUp)
					const plain = source.draw(
						plainOpsGen(spec, state.plain, after, next, placedBy(breaks), breaks)
					)
					const sets = Arr.flatMap(spec.plains, (p, j) => (p.kind === "set" ? [j] : []))
					const query: QueryInsert | undefined =
						Arr.isReadonlyArrayNonEmpty(sets) && kept("query insert")
							? {
									relation: source.draw(int(0, spec.fill.relations.length - 1)),
									plain: source.draw(pick(sets)),
									at: placedBy(breaks)(false)
								}
							: undefined
					steps.push({ kind: "follow", followUp, plain, query, shape: shape() })
					const read = (s: State): ReadonlyArray<PlainOp> =>
						query === undefined
							? []
							: Arr.map(
									Arr.dedupe(
										Arr.flatMap(s.rows, (r) => (r.relation === query.relation ? [r.v] : []))
									),
									(x): PlainOp => ({
										op: "insert",
										row: { kind: "set", plain: query.plain, x },
										at: query.at
									})
								)
					state = { rows: after, plain: plainAfter(plainAfter(state.plain, read(state)), plain) }
					break
				}
				case "query put": {
					const candidates = queryPuttable(spec, state.rows)
					if (!Arr.isReadonlyArrayNonEmpty(candidates)) {
						break
					}
					const relation = source.draw(pick(candidates))
					const own = Arr.filter(state.rows, (r) => r.relation === relation)
					const put = Arr.map(Arr.take(own, source.draw(int(1, 2))), (r) => ({
						id: r.id,
						v: r.v + BigInt(source.draw(pick([-2, -1, 1, 2] as const)))
					}))
					const after = Arr.map(state.rows, (r) => {
						const p = Arr.findFirst(put, (x) => x.id === r.id && r.relation === relation)
						return Option.isSome(p) ? { ...r, v: p.value.v } : r
					})
					const plain = source.draw(
						plainOpsGen(spec, state.plain, after, next, placedBy(breaks), breaks)
					)
					steps.push({ kind: "query put", relation, rows: put, plain })
					state = { rows: after, plain: plainAfter(state.plain, plain) }
					break
				}
				case "delete all": {
					const stored = Arr.dedupe(Arr.map(state.rows, (r) => r.relation))
					if (Arr.every(stored, (r) => deletable(spec.fill, r))) {
						steps.push({ kind: "delete all" })
						state = { rows: [], plain: [] }
					}
					break
				}
			}
		}
		return steps
	}

/** A case drawn under a swarm: its schema, then its ChangeSets. */
const caseUnder =
	(features: Swarm<SwarmFeature>): Gen<SwarmCase> =>
	(source) => {
		const scale = source.draw(keep(features, "scale"))
		const spec = source.draw(swarmSpecGen(features, scale))
		return { spec, steps: source.draw(stepsGen(features, scale, spec)) }
	}

/** A case drawn under a drawn swarm. */
export const caseGen: Gen<SwarmCase> = (source) => source.draw(caseUnder(source.draw(featuresGen)))
