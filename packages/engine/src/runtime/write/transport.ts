import { maxStringLength } from "#compiler/core/canonical.ts"
import { messageMaxBytes } from "#compiler/core/wire.ts"

/**
 * The bytes of a Bind message beside its parameters' texts, as the wire writes it: `statement`, its own fields and its
 * statement's name; `parameter`, the fields each parameter adds.
 */
export interface BindFrame {
	readonly statement: number
	readonly parameter: number
}

/**
 * How many of a call's facts one execution of a statement of member inserts carries (runtime/write/bind.ts
 * batchedExecutions): `whole`, every fact in one execution, as an insertion preview, an explanation and a write's
 * second run after a batched one's refusal send them; or `bounded`, executions whose facts' bytes, as their identity
 * texts count them, stay within `bytes`, so every sort, hash and CTE of one execution holds a bounded share of them,
 * not every fact of the call.
 */
export type Batching =
	| { readonly kind: "whole" }
	| { readonly kind: "bounded"; readonly bytes: number }

/** Every fact of a call in one execution (Batching `whole`). */
const wholeBatching: Batching = { kind: "whole" }

/**
 * What one statement carries, one array per column: a Bind message of at most `messageBytes` bytes, as its length
 * word counts it, around `frame`, and array literals of at most `literalUnits` UTF-16 code units each; and how many of
 * a call's facts one execution carries (`batching`).
 */
export interface Transport {
	readonly messageBytes: number
	readonly literalUnits: number
	readonly frame: BindFrame
	readonly batching: Batching
}

/**
 * The transport in force over the wire's frame: PostgreSQL's longest message and V8's longest string, every fact in
 * one execution.
 */
export const inForce = (frame: BindFrame): Transport => ({
	messageBytes: messageMaxBytes,
	literalUnits: maxStringLength,
	frame,
	batching: wholeBatching
})

/**
 * The parts of work_mem one execution's facts may take, by their bytes as their identity texts count
 * them: an insert statement holds each fact as its input row and its RETURNING row, both in the met rows' window
 * (sql/ast.ts FromSource `metRows`) that sorts them, each as a tuple with its header, beside the CTEs that keep them.
 *
 * @limitKind measured
 * @owner grizzle's batched write executions (runtime/write/bind.ts batchedExecutions)
 * @unit parts of work_mem
 * @scope one execution of one statement of member inserts, on the session that sends it
 * @evidence ~/.cache/grizzle-release/PERFIO-work/evidence/workmem-parts/ on cassowary: measure-1.log, measure-2.log,
 *   measure-4.log and measure-8.log, each the run of measure.sh's scratch probe spill.test.ts (uncommitted; a wide
 *   insert under explainedChange, every execution's EXPLAIN (ANALYZE, BUFFERS) reported per plan) at that divisor, with
 *   the machine's uptime before and after
 * @observed 2026-11-20 16:26:41 to 16:29:16 UTC, one run at each divisor
 * @environment cassowary, Ubuntu 26.04 on an AWS Graviton3 (arm64) instance with 64 logical CPUs and 247 GiB, load
 *   average 238 to 272 from other sessions; PostgreSQL 19.0 unpatched, the shared test family on 5491 at its default
 *   work_mem 4MB and hash_mem_multiplier 2; Node 26.13.1; grizzle b48ce6cfb with this change, toolchain a90f4de
 * @workload one call inserting 20,000 facts of about 470 bytes (a 130-byte path and a 300-byte body) into a relation
 *   of two keys, (doc, path, at) and seq, so its insert arbitrates every key and sorts its met window, one insert member
 * @result temporary blocks written per execution: divisor 1, 3 executions, 3,343, 3,355 and 0 (the met window's sort
 *   of 18,526 rows an 8.9 MB external merge, the input sort 4.4 MB, CTE tuplestores); divisor 2, 5 executions, 559,
 *   559, 560, 561 and 0 (the met window's 9,262 rows a 4.4 MB external merge, just past 4 MB); divisor 4, 9 executions,
 *   none; divisor 8, 18 executions, none. The window sorts about 480 bytes a row of these facts' 470. Not measured:
 *   wall time per execution, and facts much narrower than a row's own header
 * @decision 4 is the smallest measured divisor at which no execution writes a temporary block: the window sorts each
 *   fact twice, at about 1.1 times its bytes, so it holds about 2.2 shares of its facts' bytes, which at 2 is past
 *   work_mem by a tenth and at 4 is about 55% of it; 3 is unmeasured
 * @revalidate a PostgreSQL repin; a change to an insert statement's shape (write/insert/protocol.ts), its met window
 *   or its CTEs; facts whose bytes their identity texts count far from their tuples' (very narrow facts, wide binary
 *   carriers); another machine
 */
const workMemParts = 4

/**
 * PostgreSQL's work_mem a session runs under where nothing sets it: the memory each sort, hash and CTE of a statement
 * takes before it writes a temporary file. grizzle sets no setting, so its writes' executions are cut for it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope each sort, hash table and CTE tuplestore of one statement, under the setting's default
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L3643-L3651
 * @quote { name => 'work_mem', type => 'int', context => 'PGC_USERSET', [...] flags => 'GUC_UNIT_KB | GUC_EXPLAIN', [...]
 *   boot_val => '4096',
 * @verified 2026-11-20
 */
const workMemDefault = 4096 * 1024

/**
 * The batching of a write's executions (Batching `bounded`): each execution's facts within work_mem's default over
 * the parts its met window and CTEs hold of them, so no execution writes a temporary file at PostgreSQL's default.
 * A server that raises work_mem runs more executions than it needs; one that lowers it below the default is its
 * owner's choice.
 *
 * @limitKind derived
 * @owner grizzle's batched write executions (runtime/write/bind.ts batchedExecutions)
 * @unit bytes of an execution's facts, as their identity texts count them
 * @scope one execution of one statement of member inserts
 * @derivation an execution's facts take at most a workMemParts'th of the memory each of its sorts, hashes and CTEs
 *   takes before it spills, measured as no temporary block at that share (workMemParts)
 * @from {@link workMemDefault}, {@link workMemParts}
 */
export const writeBatching: Extract<Batching, { readonly kind: "bounded" }> = {
	kind: "bounded",
	bytes: Math.floor(workMemDefault / workMemParts)
}
