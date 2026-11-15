/**
 * The generated refresh oracle (suite.ts) over seeds A: every refreshed view equals its definition, in one commit,
 * writing nothing it need not (property.ts derivedCase), against the definition evaluated by the conservative lowering
 * on the same snapshot.
 *
 * @plant test/plants/pg/derived/derived-refresh-always-plain.patch The refresh block refreshes a populated view
 * plainly rather than CONCURRENTLY (adapter/refresh/statements.ts refreshBlock), so a refresh with no base change
 * writes every row again.
 * @plant test/plants/pg/derived/derived-refresh-level-order.patch A refresh call's targets keep the order its member
 * names them in rather than level then declared order (adapter/refresh/targets.ts refreshTargets).
 * @plant test/plants/pg/derived/oracle/derived-sum-integer-int8.patch The oracle's generator types an integer's sum as
 * int8 rather than the exact numeric it is (test/pg/derived/oracle/gen.ts sumKind).
 */
import { suite } from "#test/pg/derived/oracle/suite.ts"

suite(
	"generated derived relations refresh to their definitions, seeds A",
	[0x6d39_c001, 0x6d39_c002]
)
