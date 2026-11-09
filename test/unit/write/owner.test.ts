import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, option } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	type MemberOp
} from "#compiler/write/changeset/value.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * An owner of counted families read from a query may be inserted at its starts, its count 0 and its ends at their
 * starts, which a row check reading an end against a written field refuses; so a ChangeSet that inserts or puts owners
 * read from a query that may insert one, and in the same stratum inserts or puts a member of its family, is refused
 * when it compiles (QueriedOwnerAppend), naming the write, the owner, the family and the member, at the owner's write.
 * Every other write of owners from a query compiles: one whose facts carry a stored owner's key alone, which inserts no
 * owner; one beside no member write, or beside a member's removal; one sequenced before the append; and a deletion of
 * owners a query reads, which inserts none. An owner stated
 * by facts is inserted at its final count and end with its members, which the families swarm
 * (test/pg/write/swarm/families.test.ts) runs.
 *
 * The oracle is that rule over generated ChangeSets of one or two strata over a ledger whose entries sum to its total.
 */
const Ledger = relation(
	"Ledger",
	{ id: uuid, total: pg.bigint, n: drawnField(natural), t: accumulated(pg.bigint, 0n) },
	["id"]
)
const Entry = relation("Entry", { id: uuid, ledger: uuid, x: pg.bigint }, ["id"])
const entries = counted(on(Entry, "ledger"), fin(Ledger, "n"))
const Books = schema("Books", { Ledger, Entry }, [
	entries,
	fold(entries, Monoid.sum, on(Entry, "ledger", "x"), on(Ledger, "id", "t")),
	check("Balanced", Ledger, (l) => l.eq(l.t, l.total)),
	mutable(Ledger),
	mutable(Entry)
])

/** Ledgers read from the relation parameter `given`: facts no row need hold, so a write of them may insert each. */
const givenLedgers = query(Books).rule((r) => {
	const given = r.relation("given", { id: uuid, total: pg.bigint })
	const { id, total } = v(Ledger, "ledger")
	return r.match(given, { id, total }).find({ id, total })
})

/** A stored ledger's total restated by a parameter: every fact carries a stored ledger's key, so it inserts none. */
const restatedLedger = query(Books).rule((r) => {
	const { id, total } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, total })
		.where(r.eq(id, r.param("ledger", uuid)))
		.find({ id, total: r.param("total", pg.bigint) })
})

/** Where a write's ledgers come from: a query that may insert one, a query of stored ledgers alone, or stated facts. */
type OwnerSource = "given" | "restated" | "stated"

interface Stratum {
	readonly owner: Option.Option<{ readonly op: MemberOp; readonly source: OwnerSource }>
	readonly member: Option.Option<MemberOp>
}

/**
 * One or two strata, each with a write of ledgers or none, and an entry's write in at most one of them: a ChangeSet
 * writes a family's members in one stratum, since each stratum's edits are planned from what one read finds.
 */
const strataGen: Gen<ReadonlyArray<Stratum>> = (source) => {
	const owners = source.draw(
		array(
			option((s) => ({
				op: s.draw(element(["insert", "put", "delete"] as const)),
				source: s.draw(element(["given", "restated", "stated"] as const))
			})),
			{ min: 1, max: 2 }
		)
	)
	const member = source.draw(
		option((s) => ({
			at: s.draw(int(0, owners.length - 1)),
			op: s.draw(element(["insert", "put", "delete"] as const))
		}))
	)
	return Arr.map(owners, (owner, i) => ({
		owner,
		member: Option.flatMap(member, (m) => (m.at === i ? Option.some(m.op) : Option.none()))
	}))
}

const ownersOf = (source: OwnerSource) => {
	switch (source) {
		case "given":
			return givenLedgers
		case "restated":
			return restatedLedger
		case "stated":
			return [{ id: uuidOf(1), total: 5n }]
	}
}

/** One stratum's ChangeSet: its ledgers' write, then its entry's. */
const stratumOf = (s: Stratum): ChangeSetValue => {
	const owners = Option.match(s.owner, {
		onNone: () => ChangeSet.empty(Books),
		onSome: (o) => ChangeSet.empty(Books)[o.op](Ledger, ownersOf(o.source))
	})
	return Option.match(s.member, {
		onNone: () => owners,
		onSome: (op) => owners[op](Entry, [{ id: uuidOf(2), ledger: uuidOf(1), x: 5n }])
	})
}

const owned = owning(Books)
const names: WriteNames = succeeded(
	compileInstallation(owned, {
		...installOptions(owned, "owner"),
		levels: [identity.schema(parsedSchemaName("books"))]
	})
).names
const artifacts = succeeded(testArtifacts(Books, testCompile))

/** A write over Books compiled as the platform capture compiles it, or its refusal. */
const compile = (value: unknown) =>
	compileWrite(checking(Books), descOf(value), {
		names,
		reads: names,
		claims: { kind: "facts", present: new Set<string>() },
		world: { kind: "reality" },
		laws: artifacts.laws,
		derived: artifacts.derived
	})

/** The first stratum whose owners a query may insert beside an insert or put of their members: the refusal's place,
 * the owners' write and the members'. */
const refusalOf = (strata: ReadonlyArray<Stratum>) =>
	Arr.findFirst(strata, (s, at) =>
		Option.isSome(s.owner) &&
		s.owner.value.source === "given" &&
		s.owner.value.op !== "delete" &&
		Option.isSome(s.member) &&
		s.member.value !== "delete"
			? Option.some({ at, op: s.owner.value.op, member: s.member.value })
			: Option.none()
	)

type OwnerFeature =
	| `${"insert" | "put"} of given ledgers beside ${"insert" | "put"} of an entry: refused`
	| "given ledgers beside an entry's removal: compiled"
	| "given ledgers beside no entry: compiled"
	| "restated ledgers beside an append: compiled"
	| "stated ledgers beside an append: compiled"
	| "given ledgers sequenced before an append: compiled"
	| "a deletion of given ledgers beside an append: compiled"

/** The features of a ChangeSet that compiled, by what each stratum's write of ledgers stands beside. */
const compiledFeatures = (strata: ReadonlyArray<Stratum>): ReadonlyArray<OwnerFeature> =>
	Arr.flatMap(strata, (s, i): ReadonlyArray<OwnerFeature> => {
		if (Option.isNone(s.owner)) {
			return []
		}
		const appends = Option.isSome(s.member) && s.member.value !== "delete"
		const later = Arr.some(
			strata.slice(i + 1),
			(t) => Option.isSome(t.member) && t.member.value !== "delete"
		)
		if (s.owner.value.op === "delete") {
			return s.owner.value.source === "given" && appends
				? ["a deletion of given ledgers beside an append: compiled"]
				: []
		}
		switch (s.owner.value.source) {
			case "given":
				return [
					...(Option.isSome(s.member)
						? (["given ledgers beside an entry's removal: compiled"] as const)
						: (["given ledgers beside no entry: compiled"] as const)),
					...(later ? (["given ledgers sequenced before an append: compiled"] as const) : [])
				]
			case "restated":
				return appends ? ["restated ledgers beside an append: compiled"] : []
			case "stated":
				return appends ? ["stated ledgers beside an append: compiled"] : []
		}
	})

describe("an owner of counted families read from a query", () => {
	it.effect(
		"is refused beside an insert or put of its members in its stratum exactly when the query may insert it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/queried-owner",
						draw: drawn(strataGen),
						literal: Formatter.format,
						coverage: required<OwnerFeature>(
							[
								"insert of given ledgers beside insert of an entry: refused",
								"insert of given ledgers beside put of an entry: refused",
								"put of given ledgers beside insert of an entry: refused",
								"put of given ledgers beside put of an entry: refused",
								"given ledgers beside an entry's removal: compiled",
								"given ledgers beside no entry: compiled",
								"restated ledgers beside an append: compiled",
								"stated ledgers beside an append: compiled",
								"given ledgers sequenced before an append: compiled",
								"a deletion of given ledgers beside an append: compiled"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "the queried owner's append rule" }
					},
					(strata, c) =>
						Effect.sync(() => {
							const [first, ...rest] = Arr.map(strata, stratumOf)
							const value = Arr.reduce(rest, defined(first, "a first stratum"), (a, b) =>
								ChangeSet.sequence(a, b)
							)
							const refusal = refusalOf(strata)
							if (Option.isNone(refusal)) {
								succeeded(compile(value), "a write that inserts no owner it appends to compiles")
								c.noteAll(compiledFeatures(strata))
								return
							}
							const { at, op, member } = refusal.value
							c.note(`${op} of given ledgers beside ${member} of an entry: refused`)
							const reason = refused(
								compile(value),
								"QueriedOwnerAppend",
								"an owner a query states may be inserted at its starts, which the check refuses"
							).reason
							if (reason._tag !== "QueriedOwnerAppend") {
								return assert.fail("a QueriedOwnerAppend")
							}
							const write = Arr.findFirst(
								defined(descOf(value).strata[at], "the refused stratum").members,
								(m) => m.op === op && m.relation === "Ledger"
							)
							assert.deepEqual(
								{
									op: reason.op,
									owner: reason.owner,
									family: reason.family,
									member: reason.member,
									at: reason.at
								},
								{
									op,
									owner: "Ledger",
									family: { owner: "Ledger", count: "n" },
									member: "Entry",
									at: defined(Option.getOrUndefined(write), "the owners' write").loc
								},
								"the refusal names the write, the owner, its family and the member, at the owner's write"
							)
						})
				)
			)
	)
})
