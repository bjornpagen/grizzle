"""slot-staging experiment: runs one command and samples its process every 20 ms until it exits: its CPU (utime + stime
of /proc/<pid>/stat) and the bytes it has written by syscall (wchar of /proc/<pid>/io), which for a publish process is the
TLS stream of its PostgreSQL session (one connection; the package is only read). Writes the timeline as TSV and prints
one JSON summary: total CPU and wchar; the write flight, from the first sample interval where wchar grows by more than
1 MB (grizzle writes a flight corked and flushes it at once, adapter/wire/session.ts send, after every statement of it is
built and serialised) to the sample where wchar is within 1 MB of its final total, its bytes, its wall time and the
process's CPU just before and after it; and the command's exit code.

Usage: python3 -I procio.py <timeline.tsv> <command> [args...]"""
import json, os, subprocess, sys, time

timeline, command = sys.argv[1], sys.argv[2:]
tick = os.sysconf("SC_CLK_TCK")
child = subprocess.Popen(command)
pid = child.pid


def sample():
    try:
        stat = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        io = dict(line.split(": ") for line in open(f"/proc/{pid}/io").read().splitlines())
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
    return (time.monotonic(), (int(stat[11]) + int(stat[12])) / tick, int(io["wchar"]), int(io["rchar"]))


samples = []
start = time.monotonic()
while child.poll() is None:
    s = sample()
    if s is not None and (len(samples) == 0 or s[1:] != samples[-1][1:]):
        samples.append(s)
    time.sleep(0.02)
code = child.returncode
with open(timeline, "w") as f:
    f.write("t_s\tcpu_s\twchar\trchar\n")
    for t, cpu, wchar, rchar in samples:
        f.write(f"{t - start:.3f}\t{cpu:.2f}\t{wchar}\t{rchar}\n")
summary = {"exit": code, "samples": len(samples)}
if samples:
    last = samples[-1]
    summary.update({"cpuS": round(last[1], 2), "wcharBytes": last[2], "rcharBytes": last[3]})
    begins = [i for i, (a, b) in enumerate(zip(samples, samples[1:])) if b[2] - a[2] > 1_000_000]
    if begins:
        first = samples[begins[0]]
        done = next(s for s in samples if s[2] >= last[2] - 1_000_000)
        summary.update(
            {
                "flightAtS": round(first[0] - start, 2),
                "flightBytes": done[2] - first[2],
                "cpuBeforeFlightS": round(first[1], 2),
                "cpuAfterFlightS": round(done[1], 2),
                "flightWallS": round(done[0] - first[0], 2),
            }
        )
print(json.dumps(summary), flush=True)
sys.exit(code)
