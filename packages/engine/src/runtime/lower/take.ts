/**
 * Whether one execution runs a per-execution choice's large form: "LATERAL when the
 * distinct parent count times the other parents' bound is at most lateralParentMax, the whole-relation form
 * otherwise". The threshold is lateralParentMax divided by that bound, rounded down, so for a whole count n,
 * n * factor <= lateralParentMax exactly when n <= threshold.
 */
export const runsLargeForm = (
	choice: { readonly threshold: number },
	distinctCount: number
): boolean => distinctCount > choice.threshold
