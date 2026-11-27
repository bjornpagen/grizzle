/** What the properties of owner.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, option } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import type { WriteOp } from "#compiler/ir/desc.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
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
	schema,
	unit
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** Ledger(id, total, n drawn, t accumulated): the owner of the counted family of Entry. */
const Ledger = relation(
	"Ledger",
	{ id: Id, total: pg.bigint, n: drawnField(natural), t: accumulated(pg.bigint, 0n) },
	["id"]
)

const Entry = relation("Entry", { id: Id, ledger: Id, x: pg.bigint }, ["id"])

const entries = counted(on(Entry, "ledger"), fin(Ledger, "n"))

const Books = schema(
	"Books",
	[Ledger, Entry],
	[
		entries,
		fold(entries, Monoid.sum, on(Entry, "ledger", "x"), on(Ledger, "id", "t")),
		check("Balanced", Ledger, (l) => l.eq(l.t, l.total)),
		unit("Row", { id: Id }),
		mutable(Ledger),
		mutable(Entry)
	]
)

/** Ledgers read from the relation parameter `given`: facts no row need hold, so a write of them may insert each. */
const givenLedgers = query(Books).rule((r) => {
	const given = r.relation("given", { id: Id, total: pg.bigint })
	const { id, total } = v(Ledger, "ledger")
	return r.match(given, { id, total }).find({ id, total })
})

/** A stored ledger's total restated by a parameter: every fact carries a stored ledger's key, so it inserts none. */
const restatedLedger = query(Books).rule((r) => {
	const { id, total } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, total })
		.where(r.eq(id, r.param("ledger", Id)))
		.find({ id, total: r.param("total", pg.bigint) })
})

/** Where a write's ledgers come from: a query that may insert one, a query of stored ledgers alone, or stated facts. */
type OwnerSource = "given" | "restated" | "stated"

interface Stratum {
	readonly owner: Option.Option<{ readonly op: WriteOp; readonly source: OwnerSource }>
	readonly member: Option.Option<WriteOp>
}

/**
 * One or two strata, each with a write of ledgers or none, and an entry's write in at most one of them: a ChangeSet
 * writes a family's members in one stratum, since each stratum's edits are planned from what one read finds.
 */
export const strataGen: Gen<ReadonlyArray<Stratum>> = (source) => {
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
export const stratumOf = (s: Stratum): ChangeSetValue => {
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
		...installOptions(owned),
		levels: [identity.schema(parsedSchemaName("books"))]
	})
).names

const artifacts = succeeded(testArtifacts(Books, testCompile))

/** A write over Books compiled as the platform capture compiles it, or its refusal. */
export const compile = (value: unknown) =>
	compileWrite(checking(Books), descOf(value), {
		names,
		reads: names,
		claims: { kind: "facts", present: new Set<string>() },
		world: { kind: "reality" },
		laws: artifacts.laws,
		derived: artifacts.derived,
		level: "serializable",
		clock: noClock,
		source: transactionClock
	})

/** The first stratum whose owners a query may insert beside an insert or put of their members: the refusal's place,
 * the owners' write and the members'. */
export const refusalOf = (strata: ReadonlyArray<Stratum>) =>
	Arr.findFirst(strata, (s, at) =>
		Option.isSome(s.owner) &&
		s.owner.value.source === "given" &&
		s.owner.value.op !== "delete" &&
		Option.isSome(s.member) &&
		s.member.value !== "delete"
			? Option.some({ at, op: s.owner.value.op, member: s.member.value })
			: Option.none()
	)

/** The first stratum that deletes ledgers, each whole with its entries, beside a put of an entry: the put's place. */
export const wholeRefusalOf = (strata: ReadonlyArray<Stratum>) =>
	Arr.findFirst(strata, (s, at) =>
		Option.isSome(s.owner) &&
		s.owner.value.op === "delete" &&
		Option.isSome(s.member) &&
		s.member.value === "put"
			? Option.some({ at })
			: Option.none()
	)

export type OwnerFeature =
	| `${"insert" | "put"} of given ledgers beside ${"insert" | "put"} of an entry: refused`
	| "a deletion of ledgers beside a put of an entry: refused"
	| "a deletion of ledgers beside an entry's removal: compiled"
	| "given ledgers beside an entry's removal: compiled"
	| "given ledgers beside no entry: compiled"
	| "restated ledgers beside an append: compiled"
	| "stated ledgers beside an append: compiled"
	| "given ledgers sequenced before an append: compiled"
	| "a deletion of given ledgers beside an append: compiled"

/** The features of a ChangeSet that compiled, by what each stratum's write of ledgers stands beside. */
export const compiledFeatures = (strata: ReadonlyArray<Stratum>): ReadonlyArray<OwnerFeature> =>
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
			return [
				...(s.owner.value.source === "given" && appends
					? (["a deletion of given ledgers beside an append: compiled"] as const)
					: []),
				...(Option.isSome(s.member) && s.member.value === "delete"
					? (["a deletion of ledgers beside an entry's removal: compiled"] as const)
					: [])
			]
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
