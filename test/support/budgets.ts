/**
 * The CPU budgets of grizzle's needs and templates (@bjornpagen/testing's Need and Template `budget`): what a need's
 * open, a template's build or the wait on another worker's build included, may spend in CPU on a worker before the
 * runner fails its property, unopened. A property's needs open at once and are judged as one group, under their budgets
 * summed, by the runner's meter (live.ts processWorkNow): the worker's CPU, its descendants' and that of every
 * PostgreSQL backend serving a socket the worker's tree holds; the runner's stall window (needStallMillis) judges their
 * waits apart from it.
 *
 * The record of both: ~/.cache/grizzle-release/handoff/NEEDBUDGET/budgets-20261126/ (README.txt). A probe of the
 * runner's pool (probe.diff, applied uncommitted to toolchain 54e53afbe) read the meter over each readying's need
 * opens, from the worker's "opening" to its "readied", its backends refreshed every 100 ms, and logged it beside the
 * run report's readyingCpu and childrenCpu, which hold no backend's CPU. replay.sh readied each property of labels.txt
 * once a run, in two runs (run1.jsonl, run2.jsonl), and each of labels-children.txt in one (run1c.jsonl), every run on
 * members made again for it, so every template open was a build; `node summary.mjs > summary.json` reads them;
 * backends-check.out shows the meter counts a busy backend's CPU (5,325 ms read for the backend's 5,320). It replaces
 * ../budgets-20261121/, which read client CPU alone, summed over a run's workers, from every run report of 2026-11-17
 * to 2026-11-21.
 */

/**
 * The CPU a fixture need may spend opening: a unit or types property's (drafts, compiled programs, a served login in a
 * child), and a pg property's need that builds no template (a cluster's services, a private cluster's member, names
 * derived from a template's digest, a fixture's data).
 *
 * @limitKind measured
 * @owner grizzle's tests (every Need of test/unit, test/types and test/support, and test/pg's fixture needs)
 * @unit milliseconds of CPU as the runner's meter reads it (live.ts processWorkNow): the worker's, its descendants' and
 *   its backends'
 * @scope each open of a fixture need on one worker, alone or in its property's group
 * @evidence the record named above: run1.jsonl and run2.jsonl (summary.json's tier `unit`), and run1c.jsonl
 * @observed 2026-11-26 21:26Z to 21:53Z (run1), 21:54Z to 22:17Z (run2) and 22:21Z to 22:33Z (run1c)
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and
 *   247 GiB, Node 26.13.1, PostgreSQL 19.0; grizzle 875c04cf2291, toolchain 54e53afbe; load 510 to 650, memory pressure
 *   (some avg10) under 10 at each run's start; four replays at once
 * @workload one readying each, a run, of test/unit/sql/audit's five properties and test/unit/deploy/rosters', in two
 *   runs; of the 17 properties of the unit modules whose needs or cases start the grizzle bin or a served login in a
 *   child, each child under strace (test/unit/cli's tamper, served, served-executes, served-live, served-carriers,
 *   check and draft-key, test/unit/served/file, deploy/variables, analysis/isolation/group-witness and test/unit/deps),
 *   in one; and of test/pg/compute/digest's and derived/stored's, whose fixture needs open beside a template, in two
 * @result the largest open, rosters' one fixture: 38.13 s (run1) and 37.24 s (run2), no backend and no child. The
 *   child-starting modules, measured once: at most 9.29 s (test/unit/deps' runtime need, 0.89 s of the worker and 8.40
 *   s of its child under strace, in 225 s of wall time), every other at most 1.69 s (tamper). unit/sql/audit's
 *   properties open no need (their 11 to 12 s readyings are their module's import); digest's and stored's opens, their
 *   templates' among them, at most 2.37 s. Backends and descendants added at most 40 ms to a unit open but for deps'
 *   child. Not measured: one need's open apart from its property's others, and the unit properties outside these
 *   modules
 * @decision 76.26 s: twice the largest open the meter read (rosters', 38.13 s). An open past it has regressed
 * @revalidate a fixture whose open does more (a larger draft, more children), another machine, a Node upgrade, a change
 *   of the runner's meter or of how a child is traced, a property reported unopened over its budget
 */
export const fixtureNeedBudget = 76_260

/**
 * The CPU a template's open may spend: its build, its first clone, or the wait on another worker's build
 * (Template.database, installTemplate and worldTemplate state it, every TemplateNeed over them takes it).
 *
 * @limitKind measured
 * @owner grizzle's tests (every template of test/support and test/pg)
 * @unit milliseconds of CPU as the runner's meter reads it (live.ts processWorkNow): the worker's, its descendants' and
 *   its backends'
 * @scope each open of a template need on one worker, alone or in its property's group
 * @evidence the record named above: run1.jsonl and run2.jsonl (summary.json's tier `pg`)
 * @observed 2026-11-26 21:26Z to 21:53Z (run1) and 21:54Z to 22:17Z (run2)
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and
 *   247 GiB, Node 26.13.1, PostgreSQL 19.0; grizzle 875c04cf2291, toolchain 54e53afbe; load 540 to 650, memory pressure
 *   (some avg10) under 10 at each run's start; four replays at once
 * @workload one readying each, a run, in two runs, of 51 properties of the heaviest current pg readyings (labels.txt):
 *   the law modules whose templates commit their stored state through the captures and judge it at COMMIT
 *   (test/pg/laws' rule-seeding, rule-whole, rule-tokens, rule-confined, rule-copies, rule-net-write, rule-binding,
 *   rule-disjoint, rule-guard, rule-unit-bound, rule-concat-probe and check-cost), test/pg/education's staff and
 *   services, lower-shapes/ready-keys, laws/curriculum, compute/digest, derived/stored and physical/plan-shape; each
 *   run made its members again, so each open built its templates
 * @result the largest readying's opens: 10.06 s (run1, education/staff's teacher suite, its one template's build) and
 *   9.97 s (run2, rule-seeding's deep shape). The backends and descendants added 20 to 560 ms a readying, median 100 ms
 *   (run2; ready-keys' stored views the most). Not measured: a template a choice opens at its first take, and one
 *   template's open apart from its property's others
 * @decision 20.12 s: twice the largest open the meter read (education/staff's teacher suite, 10.06 s). An open past it
 *   has regressed
 * @revalidate a template with many more migrations or rows, another machine, a PostgreSQL or Node upgrade, a change of
 *   the runner's meter, a property reported unopened over its budget
 */
export const templateNeedBudget = 20_120
