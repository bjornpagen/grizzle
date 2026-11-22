README: ExecUpdateLockMode's key-column bitmap, allocated once per row in ExecutorState, PostgreSQL 9.3 to master, with
a patch for master that applies as is to REL_15_STABLE through REL_19_STABLE

Status: ready to send, NOT sent. Nothing in this folder has gone to any list, site or PostgreSQL remote. The owner
sends it, by hand.

1. WHAT THIS IS
   - The bug: ExecUpdateLockMode() reads the relation's key columns with RelationGetIndexAttrBitmap(), which returns a
     fresh bms_copy() in CurrentMemoryContext, and its callers run it once per row with ExecutorState current, so
     ExecutorState grows by about 41 bytes for every row of an UPDATE of a table with any BEFORE ROW UPDATE trigger,
     even a disabled one, and of an INSERT ... ON CONFLICT DO UPDATE for each row it updates, trigger or none: 400 MB
     for an upsert that updates 10 million rows (EVIDENCE.txt 1, 3).
   - Since 0ac5ad5134f (9.3) for UPDATE under a BEFORE ROW trigger, and 168d5805e4c (9.5) for ON CONFLICT DO UPDATE.
     Affected: every supported branch, master 892cfb4cbfe and the 19.0 release (EVIDENCE.txt 2).
   - It is half known upstream. The pgsql-hackers thread "memory leak in trigger handling (since PG12)", Tomas Vondra,
     2023-05-23 (https://postgr.es/m/222a3442-7f7d-246c-ed9b-a76209d19239@enterprisedb.com), fixed the other per-row
     bitmap of the same function, ExecGetAllUpdatedCols()'s union, by moving it to the per-tuple context (f24523672de,
     back-patched to 12). Jakub Wartak's profile in that thread showed this copy as the other half of the allocations;
     nobody took it up, and no commit since has.
   - v1, ours: build the key-column copy in the per-tuple context too, the shape Tom Lane and Andres Freund preferred in
     that thread (a shorter-lived context, not a pfree), and the one f24523672de took. Nothing uses the bitmap past
     the function. With it, ExecutorState stays flat on master, REL_19_STABLE and REL_18_STABLE (EVIDENCE.txt 3).

2. WHAT TO SEND, TO WHOM
   - A reply in that pgsql-hackers thread, not a new report: PostgreSQL's bug reporting guidelines ask first whether a
     bug is known (https://www.postgresql.org/docs/current/bug-reporting.html 5.1), patches go to pgsql-hackers
     (https://wiki.postgresql.org/wiki/Submitting_a_Patch), and the reply sits under the profile that shows the
     allocation, beside the commit (f24523672de) whose Discussion link names the thread. Plain text, bottom-posted,
     reply-all.
   - email.txt is that reply: To Tomas Vondra (who fixed the sibling), Cc Andres Freund, Tom Lane, Jakub Wartak and
     pgsql-hackers, In-Reply-To Jakub's profile, with References. The addresses are the ones the 2023 archive shows;
     check each against the archive's recent messages before sending, since some people have moved. To reply from a
     mail client: open https://www.postgresql.org/message-id/CAKZiRmxadz_2UT02yVGvzJ3hp%3Dv27K8kNuHxahV1O9gJR17j5w%40mail.gmail.com,
     sign in with a PostgreSQL community account and use "Resend email" to have the archive mail it to you, then
     reply-all to it and paste email.txt's body below the headers.
   - Attach v1-0001-Use-per-tuple-context-for-the-key-columns-in-Exec.patch, the one file: it applies as is to
     master and REL_15_STABLE through REL_19_STABLE (EVIDENCE.txt 4). Attach, don't paste.
   - Before sending, in a PostgreSQL clone at master:
         git am v1-0001-*.patch
         git commit --amend --reset-author    # sets your sending address as the author; From: is the GitHub noreply
                                              # address. Edit "Reported-by: REPLACE-ME <REPLACE-ME>" to your name and
                                              # address, or delete that line
         git format-patch -v1 -1
     The sending address is deliberately not written anywhere in this public repository.
   - Afterwards, once the reply is in the archive: add it to the open commitfest (https://commitfest.postgresql.org/,
     community account) as a bug fix.

3. HOW TO APPLY AND TEST
       git clone https://git.postgresql.org/git/postgresql.git && cd postgresql
       git am .../v1-0001-*.patch                                # or: git checkout REL_17_STABLE && git am ...
       meson setup build -Dcassert=true -Dtap_tests=enabled      # TAP needs Perl's IPC::Run
       ninja -C build && meson test -C build                     # every suite; REL_15_STABLE: ./configure && make check
   - The memory, against any build, unpatched and patched: psql -X -v n=100000 -f repro.sql (then n=200000, 400000),
     which reports ExecutorState for an upsert, an UPDATE under a BEFORE ROW trigger and a plain UPDATE as the control.

4. FILES
   v1-0001-...patch   the patch, git format-patch of the commit on master 892cfb4cbfe
   email.txt          the reply to send
   EVIDENCE.txt       the cause in the source, its history, before and after numbers, the tests
   repro.sql          the reproduction the email inlines, with the control
   NOTES.txt          grizzle's side

5. CHECKLIST: PostgreSQL contribution policy, applied
  A. GATES BEFORE REPORTING
  [x] Check whether the problem is already known (bug-reporting.html 5.1): the 2023 thread fixed the sibling and showed
      this one without taking it up (section 1). A web search for ExecUpdateLockMode, RelationGetIndexAttrBitmap and
      "memory leak" finds that thread alone.
  [x] Check the current development branch: master 892cfb4cbfe, built and measured (EVIDENCE.txt 3).
  [x] A released version is affected: 19.0 measured; every supported branch carries the code.
  [x] Don't duplicate a discussion (https://wiki.postgresql.org/wiki/Guide_to_reporting_problems): a reply in the
      thread, not a new one.
  B. REPORT CONTENT
  [x] A self-contained reproduction runnable with psql -X, inline in email.txt (repro.sql, with a control).
  [x] Observed and expected behaviour, versions and platform: email.txt, EVIDENCE.txt.
  [x] Plain text, bottom-posted, quoting what it answers, no confidentiality footer.
  C. PATCH
  [x] Against current master, one patch, git format-patch.
  [x] Commit message in the project's style: summary line, cause, fix, effect, Reported-by, Discussion,
      Backpatch-through: 15.
  [x] No regression test, and the commit message and email say why: the memory needs a size threshold, and
      f24523672de, the sibling fix, added none.
  [x] Builds with assertions; meson test, every suite including TAP, passes on master, REL_19_STABLE and REL_18_STABLE;
      regress and isolation pass on REL_17_STABLE, REL_16_STABLE and REL_15_STABLE.
  [x] pgindent clean, git diff --check clean.
  [x] Back branches: the master patch applies to all five as is, checked with git apply --check.
  [ ] The author and Reported-by lines: the owner sets them before sending (section 2).
  [ ] The commitfest entry, after the reply reaches the archive.
