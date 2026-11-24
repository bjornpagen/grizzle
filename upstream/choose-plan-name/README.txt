README: choose_plan_name() names subplans in O(N^3), PostgreSQL 19, with a patch for master and REL_19_STABLE

Status: ready to send, NOT sent. Nothing in this folder has gone to any list, site or PostgreSQL remote. The owner
sends it, by hand.

1. WHAT THIS IS
   - The bug: PostgreSQL 19 names every subquery before planning it. choose_plan_name() (planner.c) checks a name
     against every name already assigned by scanning the list glob->subplanNames, and finds a numeric suffix by
     trying 1, 2, 3, ... with a scan for each try. So the k-th subplan of a kind (exists_k, array_k, expr_k, setop_k,
     unnamed_subquery_k, ...) costs about k scans of a list of all names so far, and a statement with N of them
     O(N^3) string comparisons. Planning SELECT ARRAY[EXISTS (SELECT 1), ...] with 4000 sublinks takes 47.5 s of
     backend CPU time on master, 7 to 9 times more for each doubling of N; with the fix, 0.43 s (EVIDENCE.txt 2).
     In grizzle's generated write statements it was 40-65% of planning CPU (EVIDENCE.txt 1).
   - Introduced by 8c49a484e8e "Assign each subquery a unique name prior to planning it" (Robert Haas, co-authored by
     Tom Lane, 2025-10-07), first in REL_19_BETA1; `git log -S choose_plan_name` names it alone. Affected: 19.0,
     REL_19_STABLE and master as of 2026-11-24. 18 and older are not.
   - It is already known upstream, with a patch in review: the pgsql-hackers thread "O(N^3) planning time in
     choose_plan_name() since 8c49a484e8e", started 2026-10-10 by Manuel Reyes Bravo ("Manu"), and commitfest entry
     7454 (PG20-3, Needs review, no committer). Its v6 (2026-11-04) is the design Robert Haas asked for on 11-03: a
     cstring-keyed simplehash whose entries hold a "used" flag and the lowest suffix worth trying, built only once
     there are 32 names. On 11-20 Robert asked a user with a real workload to test v6 and said he would back-patch
     (CHECKLIST.txt A has the whole thread).
   - Ours (master/, REL_19_STABLE/): the same design without the threshold. One code path: the table replaces the
     list from the first name; entries are 16 bytes and the table starts at 16 buckets, so a statement with a few
     subplans pays a few hundred bytes of planner memory and no measurable CPU (EVIDENCE.txt 4). The names chosen
     are the same as today's and v6's (EVIDENCE.txt 3).
   - ABI, REL_19_STABLE: PlannerGlobal is planner-internal and allocated only by makeNode() in planner.c, but
     extensions see it through pointers (planner_setup_hook and planner_shutdown_hook pass it), and
     optimizer/extendplan.h's static inline GetPlannerGlobalExtensionState() reads glob->extension_state and
     glob->extension_state_allocated directly. So in 19 no field may move. Our REL_19_STABLE commit keeps the list
     subplanNames, still maintained, and adds the table as a new last field, subplanNamesHash, as 52cb12240cd did
     for JoinPathExtraData on REL_18_STABLE. v6 inserts its field right after subplanNames, which moves every later
     field, extension_state among them: fine for master, an ABI break if back-patched as is. The buildfarm's ABI
     check may still flag the struct's growth; .abi-compliance-history then wants an entry, which a committer adds
     after the fact (the file says so), with the justification above.

2. WHAT TO SEND, TO WHOM
   - A reply in that thread, not a new thread and not a new commitfest entry: the problem and a patch are already on
     pgsql-hackers (https://www.postgresql.org/docs/current/bug-reporting.html 5.1,
     https://wiki.postgresql.org/wiki/Submitting_a_Patch), and Robert's last message asks for exactly what we have,
     real-workload numbers, for his back-patch decision. Plain text, bottom-posted, reply-all.
   - email.txt is that reply, to Robert Haas's message of 2026-11-20
     (CA+Tgmob=v0QHEnE9gXC4WTs34U3boy5VoN9TFLyT6ahqs2oUsw@mail.gmail.com): To Robert Haas (the code's author and
     the committer it waits on), Cc Manu, Tom Lane, Andres Freund, Ayoub Kazar, Andreas and pgsql-hackers. It
     gives our workload's numbers, the synthetic table, tests of v6 (same names, same speed), the REL_19_STABLE
     struct-placement point, and offers the threshold-free variant for comparison, without asking to replace v6.
   - To reply from a mail client: open
     https://www.postgresql.org/message-id/CA%2BTgmob%3Dv0QHEnE9gXC4WTs34U3boy5VoN9TFLyT6ahqs2oUsw%40mail.gmail.com,
     sign in with a PostgreSQL community account and use "Resend email" to have the archive mail it to you, then
     reply-all to it and paste email.txt's body. Reply-all fills in the To and Cc (email.txt writes the
     non-committers' addresses as placeholders) and the exact In-Reply-To and References (email.txt's References
     line lists the thread's root and the messages this reply answers, not necessarily the archive's whole chain).
   - Attach both patch files renamed to end in .txt, e.g. choose-plan-name-no-threshold-master.patch.txt and
     choose-plan-name-no-threshold-REL_19_STABLE.patch.txt. cfbot tests the newest .patch attachments of a
     commitfest thread, and ours must not displace v6, the entry's patch.
   - Before attaching, set the author: in a PostgreSQL clone at master (likewise for the REL_19_STABLE file on that
     branch):
         git am master/v1-0001-Choose-subplan-names-in-constant-time.patch
         git commit --amend --reset-author --no-edit    # From: is the GitHub noreply address until then
         git format-patch -v1 -1
     The sending address is deliberately not written anywhere in this public repository.
   - Afterwards, optionally: add yourself as a reviewer of https://commitfest.postgresql.org/patch/7454/ (community
     account). Don't change its status or patch: it is Manu's entry.

3. HOW TO APPLY AND TEST
       git clone https://git.postgresql.org/git/postgresql.git && cd postgresql
       git am .../master/v1-0001-*.patch
           # for 19 instead: git checkout REL_19_STABLE && git am .../REL_19_STABLE/v1-0001-*.patch
       meson setup build -Dcassert=true && ninja -C build && meson test -C build
   - The names: the new block at the end of src/test/regress/sql/subselect.sql gives the same output with and
     without the patch (EVIDENCE.txt 3); so does the whole regress suite, which prints hundreds of subplan names.
   - The time: psql -X -f repro.sql against any build, unpatched and patched (planning time at 500, 1000, 2000 and
     4000 sublinks; -v unnamed=1 adds an unnamed FROM-clause subquery to every sublink).

4. FILES
   master/v1-0001-Choose-subplan-names-in-constant-time.patch          git format-patch of the commit on master
                                                                        4931dab89d (2026-11-24)
   REL_19_STABLE/v1-0001-Choose-subplan-names-in-constant-time.patch   the same for REL_19_STABLE 4c1329da8f
                                                                        (2026-11-24, 19.0+), list kept, field last
   email.txt        the reply to send
   EVIDENCE.txt     the owner's workload numbers, the cubic-to-linear table (unpatched, ours, v6), the regression
                    output before and after, the small-statement cost, the builds and test runs
   repro.sql        the generator of the quadratic query, psql -X
   CHECKLIST.txt    the contribution policy, item by item, with what the search for prior reports found
   NOTES.txt        grizzle's side: why grizzle removes the trigger itself, and what the fix leaves
