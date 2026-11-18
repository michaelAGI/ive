#!/usr/bin/env python3
"""Fail the build when a HID report builder allocates fewer bits than the
report's own USB-HID descriptor specifies.

Why this exists
---------------
`makeKeyboardHIDReport` allocated 0xf8 = 248 bits against a descriptor that
specifies 312, for months, and nothing noticed: a short report is accepted by
the service and returns rc=0, and the field that fell off the end
(`remoteTimestamp`) has a setter that silently no-ops on an undersized report.
So the defect was invisible from both ends -- exactly the "silent no-op" class
this project keeps rediscovering.

The descriptors are the authority on both sides of the wire: Apple's own
encoder sizes reports from them via `HIDReportDescriptor.reportBitCount(for:)`.
Parsing them and comparing against what the code asks for turns that class of
bug into a build failure instead of a capture session.

    scripts/check_report_sizes.py            # check, exit non-zero on mismatch
    scripts/check_report_sizes.py --list     # print every parsed size

Source of truth: Experiments/hid-descriptors/descriptors.txt, dumped from
`static <T>.descriptor.getter` in UniversalHID. Regenerate it with
Experiments/hid-descriptors/dump_descriptors.swift when the Xcode seed changes.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESCRIPTORS = ROOT / "Experiments" / "hid-descriptors" / "descriptors.txt"
GLUE = ROOT / "Sources" / "universalhid_glue.swift"


def descriptor_bits(blob):
    """Total bits of one report, from its descriptor: 8 for the report ID plus
    every Input item's size*count. Mirrors reportBitCount(for:)."""
    b = bytes.fromhex(blob)
    i = 0
    size = count = 0
    total = 0
    saw_id = False
    while i < len(b):
        pre = b[i]
        sz = pre & 3
        sz = 4 if sz == 3 else sz
        typ = (pre >> 2) & 3
        tag = pre >> 4
        i += 1
        val = int.from_bytes(b[i:i + sz], "little") if sz else 0
        i += sz
        if typ == 1:          # global
            if tag == 7:
                size = val
            elif tag == 8:
                saw_id = True
            elif tag == 9:
                count = val
        elif typ == 0 and tag == 8:   # Input
            total += size * count
    return total + (8 if saw_id else 0)


def parse_descriptors():
    out = {}
    for line in DESCRIPTORS.read_text().splitlines():
        m = re.match(r"^\d+(\w+) descriptor \d+ bytes: ([0-9a-f ]+)$", line.strip())
        if not m:
            continue
        name, blob = m.group(1), m.group(2).replace(" ", "")
        try:
            out[name] = descriptor_bits(blob)
        except ValueError:
            pass
    return out


# Builders that hardcode their allocation instead of querying the framework.
# Anything that calls uhid<T>ReportInitialBitCount() is already taking Apple's
# own number and is not listed here.
HARDCODED = {
    "makeKeyboardHIDReport": "KeyboardReport",
}


def code_allocations():
    """Map builder function -> bits it passes to uhidHIDReportInit."""
    src = GLUE.read_text()
    out = {}
    for fn in HARDCODED:
        m = re.search(r"func %s\b.*?uhidHIDReportInit\(\s*(0x[0-9a-fA-F]+|\d+)" % fn,
                      src, re.S)
        if m:
            out[fn] = int(m.group(1), 0)
    return out


def main():
    specs = parse_descriptors()
    if not specs:
        print("check_report_sizes: no descriptors parsed from %s" % DESCRIPTORS,
              file=sys.stderr)
        return 2

    if "--list" in sys.argv:
        for name in sorted(specs):
            print("%-32s %4d bits / %d bytes" % (name, specs[name], specs[name] // 8))

    failures = []
    for fn, report in HARDCODED.items():
        want = specs.get(report)
        got = code_allocations().get(fn)
        if want is None:
            failures.append("%s: no descriptor named %s in %s"
                            % (fn, report, DESCRIPTORS.name))
            continue
        if got is None:
            failures.append("%s: could not read its uhidHIDReportInit bit count"
                            % fn)
            continue
        status = "ok" if got >= want else "SHORT"
        print("%-28s %s: allocates %d bits, descriptor says %d  [%s]"
              % (fn, report, got, want, status))
        if got < want:
            failures.append(
                "%s allocates %d bits but %s specifies %d -- %d bytes short. "
                "Fields above the allocation are silently dropped."
                % (fn, got, report, want, (want - got + 7) // 8))

    if failures:
        print("\ncheck_report_sizes: FAILED", file=sys.stderr)
        for f in failures:
            print("  - %s" % f, file=sys.stderr)
        return 1
    print("\ncheck_report_sizes: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
