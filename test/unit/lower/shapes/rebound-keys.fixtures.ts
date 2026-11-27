/** What rebound-keys.test.ts reads: its schema, its box, and the columns each case's program reads its fold at. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelNode, ValidDag } from "#compiler/ir/rel.ts"
import {
	KeyAnalysis,
	Lookups,
	noPagedReads,
	restrictionWalk,
	whole
} from "#compiler/lower/shapes/share/keys.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/** A learner's id as the ledger keys it, a text of a byte bound, as metis's LearnerId. */
const Learner = str.bytes(69, str.regex("^.+$", "su"))

/** A learner's id as another relation holds it, a text of another refinement, as metis's TimebackUser. */
const Person = str.bytes(1020, str.regex("^.{1,255}$", "su"))

const Name = str.bytes(200, str.regex("^.+$", "su"))

/**
 * A ledger shaped as metis's: each learner's sitting of a test by its stage, each presentation of an item in it, the
 * sitting's moments, the test's items, and the outcomes a write records, each keyed by the learner first; and the
 * claims of sittings an attachment's head reads, its learner as the ledger keys it or as a person's.
 */
const Session = relation(
	"Session",
	{ child: Learner, stage: pg.bigint, package: Name, path: Name },
	["child", "stage"]
)
const Presented = relation(
	"Presented",
	{ child: Learner, stage: pg.bigint, at: pg.bigint, k: pg.bigint, package: Name, path: Name },
	["child", "stage", "at"]
)
const Moment = relation("Moment", { child: Learner, stage: pg.bigint, at: pg.bigint }, [
	"child",
	"stage",
	"at"
])
const Member = relation("Member", { package: Name, path: Name, item: Name }, [
	"package",
	"path",
	"item"
])
const Outcome = relation(
	"Outcome",
	{ child: Learner, stage: pg.bigint, package: Name, path: Name, until: pg.bigint },
	["child", "stage", "package", "path"]
)
const LearnerClaim = relation(
	"LearnerClaim",
	{ claim: pg.bigint, child: Learner, stage: pg.bigint },
	["claim"]
)
const PersonClaim = relation("PersonClaim", { claim: pg.bigint, child: Person, stage: pg.bigint }, [
	"claim"
])

const Ledger = schema(
	"ReboundKeys",
	[Session, Presented, Moment, Member, Outcome, LearnerClaim, PersonClaim],
	[]
)

/**
 * Each presentation with the sitting's next moment after it, a fold of every learner's presentations and moments, as
 * metis's presentedSpans (delivery.ts): its grouping keys the presentation's, the learner among them.
 */
const spans = query(Ledger).rule((r) => {
	const { child, stage, at, k, package: pkg, path } = v(Presented, "presented")
	const { at: next } = v(Moment, "next")
	return r
		.match(Presented, { at, child, k, package: pkg, path, stage })
		.match(Moment, { at: next, child, stage })
		.where(r.gt(next, at))
		.find({ at, child, end: r.min(next), k, package: pkg, path, stage })
})

/** Each learner's item's last span end, a fold over the spans, as metis's ItemDuration over presentedSpans. */
const until = query(Ledger).rule((r) => {
	const { child, stage, at, k, package: pkg, path, end } = v(spans, "span")
	return r
		.match(spans, { at, child, end, k, package: pkg, path, stage })
		.find({ child, package: pkg, path, stage, until: r.max(end) })
})

/** How the learner the program reads at is typed: as the ledger keys it, or at another refinement. */
export type Heading = "the ledger's refinement" | "another refinement"

/**
 * How the program reads the folds: a read or a write's member binding the call's sittings' learner to the ledger's
 * column, as metis's submit records each item's duration; or an attachment's child stating the fold's learner equal to
 * its head's, as metis's review reads each question's latest attempt at its member's learner.
 */
export type Program = "a read" | "a write" | "an attachment"

export interface Box {
	readonly heading: Heading
	readonly program: Program
}

export type Feature = `${Heading}, ${Program}`

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap(["the ledger's refinement", "another refinement"] as const, (heading) =>
		Arr.map(["a read", "a write", "an attachment"] as const, (program) => ({ heading, program }))
	)
)

/**
 * The call's sittings' items' last span ends: the `sittings` relation parameter's learner and stage (its learner
 * typed as `heading` says), each sitting's test's items, and each item's fold read at them, as metis's test-run-call
 * `durations` reads ItemDuration at the sitting the call names, its learner of the type its guards deliver.
 */
const durationsOf = (heading: Heading) => {
	const sittings = { child: heading === "another refinement" ? Person : Learner, stage: pg.bigint }
	return query(Ledger).rule((r) => {
		const given = r.relation("sittings", sittings)
		const { child, stage } = v(given, "sitting")
		const { package: pkg, path: test } = v(Session, "session")
		const { item } = v(Member, "member")
		const { until: end } = v(until, "until")
		return r
			.match(given, { child, stage })
			.match(Session, { child, package: pkg, path: test, stage })
			.match(Member, { package: pkg, path: test, item })
			.match(until, { child, package: pkg, path: item, stage, until: end })
			.find({ child, stage, package: pkg, path: item, until: end })
	})
}

/**
 * A claimed sitting with its items' last span ends attached: the head the claim's learner (typed as `heading` says)
 * and stage, the child each fold's row whose learner and stage its where states equal to the head's, as metis's review
 * attaches each question's latest attempt by `r.eq(child, member.child)`.
 */
const attachedOf = (heading: Heading) => {
	const head =
		heading === "another refinement"
			? query(Ledger).rule((r) => {
					const { child, stage } = v(PersonClaim, "claim")
					return r
						.match(PersonClaim, { claim: r.param("claim", pg.bigint), child, stage })
						.find({ child, stage })
				})
			: query(Ledger).rule((r) => {
					const { child, stage } = v(LearnerClaim, "claim")
					return r
						.match(LearnerClaim, { claim: r.param("claim", pg.bigint), child, stage })
						.find({ child, stage })
				})
	return head.attach(
		"durations",
		(sitting) =>
			query(Ledger).rule((r) => {
				const { child, stage, package: pkg, path, until: end } = v(until, "until")
				return r
					.match(until, { child, package: pkg, path, stage, until: end })
					.where(r.eq(child, sitting.child), r.eq(stage, sitting.stage))
					.find({ path, until: end })
			}),
		"array"
	)
}

const reality = realityWrite(succeeded(testArtifacts(Ledger, testCompile)))

/** The checked DAG of a case's program: its read's, the write's recording each duration, or the attaching read's. */
const dagOf = (box: Box): ValidDag => {
	switch (box.program) {
		case "a read":
			return succeeded(
				compileTemplate(durationsOf(box.heading), undefined, testCompile),
				"the read compiles"
			).programs.checked.dag
		case "a write":
			return succeeded(
				compileWrite(
					checking(Ledger),
					descOf(ChangeSet.empty(Ledger).insert(Outcome, durationsOf(box.heading))),
					reality
				),
				"the write compiles"
			).frontend.ir.dag
		case "an attachment":
			return succeeded(
				compileTemplate(attachedOf(box.heading), undefined, testCompile),
				"the attaching read compiles"
			).programs.checked.dag
	}
}

/** The spans fold: the fold grouped by the presentation's at and k, which the durations fold reads. */
const isSpans = (node: RelNode): boolean =>
	node.kind === "Group" && node.keys.includes("at") && node.keys.includes("k")

/**
 * The columns each read of the spans fold reads it at: for a read or a write, every key set its reads read it at
 * (keys.ts KeyAnalysis over the case's checked DAG, its roots whole), none for one read whole; for an attachment, the
 * columns its child's restriction at its correlation reaches the fold at, per parent row (keys.ts restrictionWalk), none
 * where it reaches the fold at none.
 */
export const spanReadsOf = (box: Box): ReadonlyArray<ReadonlyArray<string>> => {
	const dag = dagOf(box)
	const nodes = topoOrder(dag)
	if (box.program === "an attachment") {
		return Arr.flatMap(nodes, (node) => {
			if (node.kind !== "Attach") {
				return []
			}
			const reached = restrictionWalk(
				node.child,
				Arr.map(node.correlation, (c) => ({ column: c.child, value: c.parent })),
				"held"
			)
			return [
				Option.match(
					Arr.findFirst(reached, (r) => isSpans(r.node)),
					{ onNone: () => [], onSome: (fold) => Arr.map(fold.equalities, (e) => e.column) }
				)
			]
		})
	}
	const analysis = new KeyAnalysis(
		nodes,
		new Map(Arr.map(dag.roots, (r) => [r, whole] as const)),
		() => new Map(),
		new Lookups(() => false),
		noPagedReads
	)
	return Arr.flatMap(nodes, (node) => {
		if (!isSpans(node)) {
			return []
		}
		const keys = analysis.keysOf(node)
		return [keys.kind === "keys" ? keys.columns : []]
	})
}

/** The columns a case's every read of the spans fold must read it at: the learner and the stage, and the item's. */
export const requiredOf = (box: Box): ReadonlyArray<string> =>
	box.program === "an attachment" ? ["child", "stage"] : ["child", "package", "path", "stage"]
