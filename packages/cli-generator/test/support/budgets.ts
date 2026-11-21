/**
 * The CPU a need of the CLI generator's tests may spend opening (@bjornpagen/testing's Need and Template `budget`):
 * the grizzle tier's twins, their login drafted by `grizzle generate` and their CLI generated and built; a suite's
 * fixture, a capture server and a package generated and built against it; a digest service.
 *
 * @limitKind measured
 * @owner the CLI generator's tests (every Need and Template.database of packages/cli-generator/test)
 * @unit milliseconds of CPU, the need's children's among them
 * @scope each open of one of its needs on one worker, alone or in its property's group
 * @evidence ~/.cache/grizzle-release/handoff/NEEDBUDGET/budgets-20261121/ (README.txt, distribution.mjs and
 *   distribution.json `cli`, modules.mjs and modules.json): `node distribution.mjs` and `node modules.mjs` over every
 *   run report toolchain-test wrote under ~/.cache/toolchain-test/runs for the generator's package, as grizzle's
 *   packages/cli-generator and as effect-openapi-cli-generator's packages/generator it came from. A property's
 *   readyingCpu there is its readyings' own CPU summed over every worker that readied it, and readyingCpu with
 *   childrenCpu (its readyings' and its cases' children) bounds a readying's process tree from above
 * @observed 2026-11-17 to 2026-11-21 14:19Z (590 runs of the generator's package)
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and
 *   247 GiB, Node 26.13.1; every lane's runs of those days, at load 100 to 1,100
 * @workload every property of the generator's tests those runs ran (236)
 * @result readyingCpu: median 0.37 s, 90th percentile 2.17 s, 99th 10.7 s, largest 137.3 s (the grizzle tier,
 *   test/grizzle/once.test.ts, as packages/generator); with childrenCpu: median 0.57 s, 90th 18.2 s, 99th 80.4 s,
 *   largest 711.4 s (test/emit/emitted-package.test.ts, whose one need is the digest service, its children the
 *   packages its cases emit), then 168.5 s (the grizzle tier) and 142.0 s (test/generated/redirect-chains.test.ts, its
 *   cases' children among it)
 * @decision 300 s: above every property's readyings with their children but emitted-package's, whose children are its
 *   cases', 1.8 times the largest bound of a property whose need starts children (168.5 s). An open past it has run
 *   away
 * @revalidate a twin or a generated package that does more, another machine, a Node upgrade, a property reported
 *   unopened over its budget
 */
export const cliNeedBudget = 300_000
