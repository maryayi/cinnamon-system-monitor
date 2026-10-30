// Pure /proc parsers and math. No Cinnamon or GI imports, so this runs under
// plain gjs (see test/stats-test.js). Top-level `function`s only: plain gjs
// `imports.stats` exports nothing declared with const/let/class.

/** First `cpu` line of /proc/stat → { total, idle } in jiffies. */
function parseCpu(text) {
    // user nice system idle iowait irq softirq steal; guest/guest_nice are already in user/nice.
    const f = text.split('\n', 1)[0].trim().split(/\s+/).slice(1, 9).map(Number);
    return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4] };
}

/** CPU busy % between two parseCpu() samples; 0 when no time passed. */
function cpuPercent(prev, cur) {
    const dTotal = cur.total - prev.total;
    if (dTotal <= 0)
        return 0;
    return 100 * (1 - (cur.idle - prev.idle) / dTotal);
}

/** /proc/meminfo → { total, available } in kB. */
function parseMem(text) {
    const kb = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))[1]);
    return { total: kb('MemTotal'), available: kb('MemAvailable') };
}

/** /proc/net/dev → { rx, tx } bytes summed over every interface but `lo`. */
function parseNet(text) {
    // shortcut: sums every non-lo interface, so traffic through docker/veth/bridges is counted twice; add an interface setting if that matters.
    let rx = 0, tx = 0;
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0 || line.slice(0, colon).trim() === 'lo')
            continue;
        const f = line.slice(colon + 1).trim().split(/\s+/);
        rx += Number(f[0]);
        tx += Number(f[8]);
    }
    return { rx, tx };
}

/** Bytes per second between two counters; a counter that went down counts as 0. */
function rate(prev, cur, seconds) {
    return seconds > 0 ? Math.max(0, cur - prev) / seconds : 0;
}
