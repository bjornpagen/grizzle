import { regex } from "arkregex"
/**
 * The catalog of performance gates: R01 to R42, the compiler's performance rules, then the work-queue claim at a reference
 * load and the refresh lifetime. Each gate is stated here, as data, with the rule it measures, its owner and its gate
 * text: what a bench file must show for it. A rule with no gate text of its own is gated by the performance contract, a
 * measurement that can disprove the performance assumption. Each gate's bench file belongs to its owner: the query
 * owner's under bench/query, the write owner's (the write, law, queue and refresh gates; R40 is a refresh measurement,
 * so a write gate) under bench/write and bench/queue. The numbering keeps the gaps of the rules that are no gates.
 */
import { Array as Arr, String as Str } from "effect"
export const ruleIds = [
	"R01",
	"R02",
	"R03",
	"R04",
	"R05",
	"R06",
	"R07",
	"R08",
	"R09",
	"R11",
	"R12",
	"R13",
	"R14",
	"R17",
	"R18",
	"R19",
	"R20",
	"R21",
	"R22",
	"R23",
	"R24",
	"R25",
	"R26",
	"R27",
	"R28",
	"R29",
	"R30",
	"R31",
	"R32",
	"R33",
	"R34",
	"R35",
	"R36",
	"R37",
	"R38",
	"R39",
	"R40",
	"R41",
	"R42"
] as const

export type RuleId = (typeof ruleIds)[number]

export const extraGateIds = ["queue", "refresh-lifetime"] as const

export type ExtraGateId = (typeof extraGateIds)[number]

export type GateId = RuleId | ExtraGateId

const gateIds: ReadonlyArray<GateId> = [...ruleIds, ...extraGateIds]

export type GateOwner = "query" | "write"

/** Where each owner's bench files live. */
export const ownerDirectories: Readonly<Record<GateOwner, ReadonlyArray<string>>> = {
	query: ["bench/query"],
	write: ["bench/write", "bench/queue"]
}

/**
 * A gate's text: the performance contract's general one, or a paragraph of its own saying what its bench file must
 * measure and show.
 */
export type GateText =
	| { readonly kind: "contract" }
	| { readonly kind: "stated"; readonly text: string }

export interface GateEntry {
	readonly id: GateId
	readonly title: string
	readonly owner: GateOwner
	readonly gate: GateText
}

const contract: GateText = { kind: "contract" }

const stated = (text: string): GateText => ({ kind: "stated", text })

const statedGates: { readonly [K in GateId]: Omit<GateEntry, "id"> } = {
	R01: {
		title: "Fuse match regions, preserve true semantic boundaries",
		owner: "query",
		gate: contract
	},
	R02: { title: "Express existence as existence", owner: "query", gate: contract },
	R03: {
		title: "Eliminate a relation only with a complete proof",
		owner: "query",
		gate: stated(
			"compare against absent witnesses, duplicate referring facts, key changes, and deferred arm switches. This optimization cannot rely on statistics or TypeScript assertions."
		)
	},
	R04: {
		title: "Make predicates recognizable to indexes",
		owner: "query",
		gate: stated(
			"require Index Cond/Order By access conditions where the admitted fast shape needs them. An index scan followed by a huge filter is not sufficient evidence."
		)
	},
	R05: {
		title: "Use native row seeks for eligible orders",
		owner: "query",
		gate: stated(
			"keyset order is over the final distinct result. A hidden base ID cannot resurrect duplicate projected answers. Seek/limit movement across grouping, DISTINCT projection, or candidate sealing requires separate proofs."
		)
	},
	R06: {
		title: "Delay expensive payload work explicitly when legal",
		owner: "query",
		gate: stated(
			"measure intermediate width, heap/TOAST access, total serialization bytes, sort/hash memory, and identical result membership. This applies to large text and vector payload as much as expensive scalar expressions. Until an observed width threshold exists, wide payload is structural: a vector, or text with no proved byte bound; payload is fetched back only as plain stored fields of the scanned relation whose key the narrowed stage keeps."
		)
	},
	R07: { title: "Keep finite schema facts visible to PostgreSQL", owner: "query", gate: contract },
	R08: {
		title: "Expose eager aggregation without breaking contribution identity",
		owner: "query",
		gate: contract
	},
	R09: { title: "Specialize laws before emitting checkers", owner: "write", gate: contract },
	R11: { title: "Keep general containment probes key-local", owner: "write", gate: contract },
	R12: {
		title: "Treat trigger queue size as a transaction resource",
		owner: "write",
		gate: contract
	},
	R13: {
		title: "Every index is justified by a law or a workload program",
		owner: "query",
		gate: stated(
			"every installed index maps to a law id or the workload's access, which the snapshot records program by program; removing a program proposes exactly the drops nothing else justifies; a program outside the workload returns the same result."
		)
	},
	R14: { title: "Keep planning growth bounded", owner: "query", gate: contract },
	R17: {
		title: "Prove physical uniqueness before emitting duplicate elimination",
		owner: "query",
		gate: contract
	},
	R18: {
		title: "Emit single-assignment names and explicit casts",
		owner: "query",
		gate: stated(
			"a mismatch between an IR type and the PostgreSQL type of an emitted expression is a preparation error, never a coerced result. Tests diff emitted SQL structurally against the expected renamed and typed form."
		)
	},
	R19: {
		title: "Capacity checks are one indexed group aggregate per affected key",
		owner: "write",
		gate: stated(
			"the group aggregate reads the source through the reverse index, never by a sequential scan, after more than five calls in one session on statistics one wide group skews; measure commit latency for batches that touch one group many times and for wide groups, against hand-written trigger equivalents; lock-wait time and throughput of one hot group, with grizzle and direct SQL writers, against its seat-fact form; and that of two writers at the bound of one group, one commits and the other's COMMIT raises with the law's identity. Verify that the partial-unique specialization removes the law function and its triggers entirely for filtered at-most-one laws."
		)
	},
	R20: {
		title: "Choose the bounded-subset shape by the bound parent set",
		owner: "query",
		gate: stated(
			"LATERAL plans show a Limit under the nested loop with an index condition on the correlation key, and total rows read proportional to parents times `k`. Whole-relation plans read the input once. Record refresh time and workers launched for refresh-evaluated definitions, and fix the size threshold between the two families offline."
		)
	},
	R21: {
		title: "Pipeline heading groups, never pad",
		owner: "query",
		gate: stated(
			"for a delivered union, round trips equal one per union regardless of group count and each group's plan is the plan the group would have alone; for a consumed union, the result equals the merge of the per-group bounded statements."
		)
	},
	R22: {
		title: "A relation parameter is one parameter",
		owner: "query",
		gate: stated(
			"the join uses the keyed relation's index under the VALUES transport, and under the recordset transport whenever the keyed relation is large against the function scan's default row estimate, below which a hash join over a sequential scan is the plan PostgreSQL correctly prefers; plan shape is independent of input size except through estimates; the VALUES and recordset transports produce identical outcomes on the same input, including duplicate and same-key facts."
		)
	},
	R23: {
		title: "Immutability shrinks residual event lists",
		owner: "write",
		gate: stated(
			"commit latency scales with the group aggregate, not with transaction size. Measure lock-wait time and throughput for one hot group or parent, and event counts and commit latency against the same schema declared `mutable`, which differs only in event lists and `put` realization."
		)
	},
	R24: {
		title: "Lower conditional counts to FILTER and conditional sums to CASE",
		owner: "query",
		gate: stated(
			"identical results on groups where no binding, some bindings, and every binding satisfies `p`, the first being the case a filtered sum gets wrong; one aggregate node in the plan."
		)
	},
	R25: {
		title: "Share a sub-query across statements in one snapshot",
		owner: "query",
		gate: contract
	},
	R26: {
		title: "Lower inclusive self-match ordinals to ROW_NUMBER",
		owner: "query",
		gate: stated(
			"agreement with the composed self-join on ties broken by the completed order and on groups of one row."
		)
	},
	R27: {
		title: "Lower a strict successor to LEAD",
		owner: "query",
		gate: stated(
			"agreement with the LATERAL `take(1)` lowering on groups of one row, on the last row of each group, and on ties broken by the completed order."
		)
	},
	R28: { title: "Lower a share of the total to a window sum", owner: "query", gate: contract },
	R29: { title: "Lower a rank selection to PERCENTILE_DISC", owner: "query", gate: contract },
	R30: { title: "Lower the interpolated form to PERCENTILE_CONT", owner: "query", gate: contract },
	R31: { title: "Lower the count-and-take mode to MODE", owner: "query", gate: contract },
	R32: {
		title: "Lower the closed-form slope to REGR_SLOPE",
		owner: "query",
		gate: stated(
			"agreement on random double-precision groups, the disagreement rate on near-degenerate groups recorded, and no NULL delivered for any group."
		)
	},
	R33: {
		title: "Settle inserts in one DO SELECT statement",
		owner: "write",
		gate: stated(
			"an identical insert is settled by one INSERT … ON CONFLICT DO SELECT statement; exact repeats return no row"
		)
	},
	R34: {
		title: "Normalize unnormalized input before the arbiter insert",
		owner: "write",
		gate: stated(
			"two facts with one key and different payloads in one member are refused with the key law, never with PostgreSQL's error; a fact repeated in a member counts once; an elision fires only with its evidence."
		)
	},
	R35: {
		title: "Realize a described ChangeSet in one statement where one snapshot suffices",
		owner: "write",
		gate: stated(
			"the single-statement and sequential realizations produce the same final states, outcomes, and reads under the write compiler's concurrency schedules, including two concurrent appliers whose described members overlap. Measure the carrier's catalog cost per transaction against declaring the target `mutable`, which realizes a `put` as one statement outside the exceptions above, needs no carrier, and changes nothing else: the residual laws are the same either way. Under heavy contention on one row, as with eight appliers crediting one balance, a write may lose every attempt the caller's retries allow and end in a `TransientFailure` that applies nothing, so the concurrent check is conservation, not universal acceptance: in both declarations each balance equals its accepted credits, each accepted credit's read-back is its new row, and every credit ends accepted or in a TransientFailure."
		)
	},
	R36: {
		title: "Fuse single-field attachments and place parent predicates",
		owner: "query",
		gate: stated(
			"both lowerings deliver identical nested results; the fused form is selected only where the serialization and planning cost, observed, beat the extra statement."
		)
	},
	R37: {
		title: "Seed a recursive attachment from the parent keys",
		owner: "query",
		gate: stated(
			"total rows read is proportional to the closures, not to the parents times the relation."
		)
	},
	R38: {
		title: "Lower point-in-partition lookups to a bounded range scan",
		owner: "query",
		gate: contract
	},
	R39: {
		title: "Serve prefix search from the field's B-tree",
		owner: "query",
		gate: stated(
			"Index Cond on both bounds; agreement with the pattern form on random strings including supplementary-plane code points."
		)
	},
	R40: {
		title: "Refresh with REFRESH MATERIALIZED VIEW CONCURRENTLY",
		owner: "write",
		gate: stated(
			"refresh with no base change writes nothing, except where an order-dependent double-precision aggregate rounds differently on recomputation; measure refresh time, rows written, WAL, and workers launched against a hand-written materialized view of the same definition, and record the record-image churn on equal but not byte-identical values."
		)
	},
	R41: {
		title: "Lower inclusive running aggregates to a ROWS frame",
		owner: "query",
		gate: stated(
			"agreement with the composed self-join on ties broken by the completed order, groups of one row, and conditional forms where no row qualifies; one sort and one window pass per partition order; rows read proportional to the input."
		)
	},
	R42: {
		title: "Lower as-of selections to an indexed probe or one ordered pass",
		owner: "query",
		gate: stated(
			"agreement between the two forms on ties at equal prefixes, parents before the first Q row, groups with no Q rows, and the mirror; a tutoring timeline as the whole-input case; the ordered pass reads each input once."
		)
	},
	queue: {
		title: "The work-queue claim at a reference load",
		owner: "write",
		gate: stated(
			"Before this example is presented as the queue pattern, measure it against a reference production load: about 800 claims/s on one lane with 256 holders, over a `Work` relation of more than a million pending items, with a claim p95 of 54 to 109 ms at a width of 16 as the latency reference. Record claim throughput and tail latency; the transient failure rate by reason, item collision against seat collision, with fresh random and fixed start keys; the per-claim cost of the alternatives reverse check; settlement latency; reclaim behavior after worker loss; large enqueues running beside claimers; and `mutable` against immutable `Work`, which differ in write cost only. Compare against a hand-written claim using a locking scan with skipped rows on the same schema. If the transient failure rate within a lane makes the design unusable at that concurrency, record the result and reconsider row locking with numbers; the exclusion of SKIP LOCKED stands until then."
		)
	},
	"refresh-lifetime": {
		title: "Refreshes within an 800 s function lifetime",
		owner: "write",
		gate: stated("refreshes that fit an 800 s function lifetime one level per call;")
	}
}

/** Every gate, in order: R01 to R42, then the queue and refresh-lifetime gates. */
export const gateCatalog: ReadonlyArray<GateEntry> = Arr.map(gateIds, (id) => ({
	id,
	...statedGates[id]
}))

export const gateOwner = (id: GateId): GateOwner => statedGates[id].owner

/**
 * The first sentence of a gate's text, for a one-line listing: up to the first period that ends the text or is followed
 * by a space and a capital, a backtick or a parenthesis.
 */
export const firstSentence = (text: string): string => {
	const trimmed = Str.trim(text)
	const sentence = regex("^.+?\\.(?=\\s+[A-Z`(]|$)").exec(trimmed)
	return sentence === null ? trimmed : sentence[0]
}
