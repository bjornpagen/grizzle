/**
 * The CPU budgets of grizzle's needs and templates (@bjornpagen/testing's Need and Template `budget`): what a need's
 * open, a template's build or the wait on another worker's build included, may spend in CPU on a worker before the
 * runner fails its property, unopened. A property's needs open at once and are judged as one group, under their budgets
 * summed; the runner's stall window (needStallMillis) judges their waits apart from it.
 *
 * The record of all three: ~/.cache/grizzle-release/handoff/NEEDBUDGET/budgets-20261121/ (README.txt, distribution.mjs
 * and distribution.json, modules.mjs and modules.json, tiers.mjs and tiers.json), written by `node distribution.mjs`,
 * `node modules.mjs` and `node tiers.mjs` over every run report toolchain-test wrote under ~/.cache/toolchain-test/runs
 * for a grizzle checkout. A property's readyingCpu there is its readyings' own CPU summed over every worker that readied
 * it in one run (its module's import and its needs' opens, a choice's members excepted, which open at their first take),
 * so it bounds any one readying, and any one need's open, from above; readyingCpu with childrenCpu (the children its
 * readyings and its cases ran) bounds a readying's process tree from above. Each property counts by its largest value in
 * any run. Not measured: one readying's CPU apart from its property's other readyings and its cases' children.
 */

/**
 * The CPU a fixture need may spend opening: a unit or types property's (drafts, compiled programs, a served login in a
 * child), and a pg property's need that builds no template (a cluster's services, a private cluster's member, names
 * derived from a template's digest, a fixture's data).
 *
 * @limitKind measured
 * @owner grizzle's tests (every Need of test/unit, test/types and test/support, and test/pg's fixture needs)
 * @unit milliseconds of CPU, the need's children's among them
 * @scope each open of a fixture need on one worker, alone or in its property's group
 * @evidence the record named above (distribution.json `unit`, modules.json)
 * @observed 2026-11-17 10:11Z to 2026-11-21 14:19Z (3,369 runs of grizzle's root)
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and
 *   247 GiB, Node 26.13.1; every grizzle lane's runs of those days, at load 100 to 1,100
 * @workload every unit and types property those runs ran (1,278), and the pg properties of the fixture needs
 *   (test/pg/compute/digest, transactions/apply, derived/stored)
 * @result unit and types properties' readyingCpu: median 0.49 s, 90th percentile 3.35 s, 99th 15.0 s, largest 54.5 s
 *   (test/unit/sql/audit.test.ts); of the modules whose needs start children (test/unit/cli's served, tamper, derived and
 *   check fixtures, test/unit/deps), readyingCpu with childrenCpu at most 60.9 s (tamper, its cases' children among it);
 *   the pg fixture needs' properties' readyingCpu at most 1.6 s (digest), their templates' opens among it
 * @decision 120 s: twice the largest bound measured, so no open measured would have failed; the bounds are sums over
 *   workers and the largest single open is a fraction of them. An open past it has run away
 * @revalidate a fixture whose open does more (a larger draft, more children), another machine, a Node upgrade, a
 *   property reported unopened over its budget
 */
export const fixtureNeedBudget = 120_000

/**
 * The CPU a template's open may spend: its build, its first clone, or the wait on another worker's build
 * (Template.database, installTemplate and worldTemplate state it, every TemplateNeed over them takes it).
 *
 * @limitKind measured
 * @owner grizzle's tests (every template of test/support and test/pg)
 * @unit milliseconds of CPU, the build's children's among them
 * @scope each open of a template need on one worker, alone or in its property's group
 * @evidence the record named above (distribution.json `pg`, modules.json); beside it, the record toolchain's
 *   runner/limits.ts needStallMillis cites (TESTSYS CORE-2's packages/testing/out/need-open/: each readying of grizzle's
 *   six template forms timed alone)
 * @observed 2026-11-17 10:11Z to 2026-11-21 14:19Z (3,369 runs); CORE-2's forms 2026-11-16 10:30Z to 10:32Z
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and
 *   247 GiB, Node 26.13.1, PostgreSQL 19; every grizzle lane's runs of those days, at load 100 to 1,100
 * @workload every pg property those runs ran (760), each readied on as many workers as its cases spread over; CORE-2's
 *   forms at 64 workers, unbuilt and built
 * @result pg properties' readyingCpu: median 1.17 s, 90th percentile 9.10 s, 99th 27.8 s; the largest 513.4 s
 *   (test/pg/world-model/roles.test.ts's pair world, a property since deleted), then 170.6 s
 *   (test/pg/laws/families/generated.test.ts, whose templates are a choice's, opened at first take, so its readyings are
 *   its module's import and its oracle's), then 38.9 s (world-model/exhaustive.test.ts); with childrenCpu the same to
 *   0.2 s. CORE-2's slowest single readying 34.7 s of wall time, which bounds its CPU
 * @decision 300 s: above every pg property's readyings but the pair world's, so none of them would have failed, 7.7
 *   times the largest of a property that opens templates at readying (38.9 s) and 8.6 times CORE-2's slowest single
 *   readying. An open past it has run away
 * @revalidate a template with many more migrations or rows, another machine, a PostgreSQL or Node upgrade, a property
 *   reported unopened over its budget
 */
export const templateNeedBudget = 300_000
