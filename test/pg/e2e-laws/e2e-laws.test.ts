/**
 * The law-bearing end-to-end suites: the payroll ledger's invalid ChangeSets and direct psql writers. The payroll
 * programs keep the event loop busy for seconds at a time, so the file is a CPU-bound job of its own.
 */

import { payrollDirectSuite } from "#test/pg/e2e-laws/suites/payroll-direct.ts"
import { payrollInvalidSuite } from "#test/pg/e2e-laws/suites/payroll-invalid.ts"

payrollInvalidSuite()
payrollDirectSuite()
