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
    // The kernel's iowait counter can go down, which can push the raw value past 0..100.
    return Math.min(100, Math.max(0, 100 * (1 - (cur.idle - prev.idle) / dTotal)));
}

/** /proc/meminfo → { total, used, swapTotal, swapUsed } in kB; used = MemTotal − MemAvailable. */
function parseMem(text) {
    const kb = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))[1]);
    const total = kb('MemTotal'), swapTotal = kb('SwapTotal');
    return { total, used: total - kb('MemAvailable'), swapTotal, swapUsed: swapTotal - kb('SwapFree') };
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

/** /proc/stat followed by every /proc/<pid>/stat →{ total, procs: { pid: { pid, name, ticks } } }; ticks = utime + stime over all threads. */
function parseProcStats(text) {
    const procs = {};
    for (const line of text.split('\n')) {
        // comm can hold spaces and ')', so the fields start after the last ')'.
        const close = line.lastIndexOf(')');
        if (!/^\d/.test(line) || close < 0)
            continue;
        const f = line.slice(close + 2).split(' ');
        const pid = Number(line.slice(0, line.indexOf(' ')));
        procs[pid] = { pid, name: line.slice(line.indexOf('(') + 1, close), ticks: Number(f[11]) + Number(f[12]) };
    }
    return { total: parseCpu(text).total, procs };
}

/** `ps -eo pid=,rss=,comm=` → [{ pid, name, rss }], rss in kB. */
function parsePs(text) {
    return text.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
        .map(m => ({ pid: Number(m[1]), rss: Number(m[2]), name: m[3] }));
}

/** `ss -tinpH` → { 'local peer': { pid, name, tx, rx } } in bytes, for sockets with a visible owner; loopback is left out like `lo` in parseNet. */
function parseSs(text) {
    const sockets = {};
    let socket = null;
    for (const line of text.split('\n')) {
        if (/^\s/.test(line)) {
            // The indented line after each socket holds its tcp_info counters.
            const count = key => Number((line.match(new RegExp(` ${key}:(\\d+)`)) || [0, 0])[1]);
            if (socket)
                Object.assign(socket, { tx: count('bytes_sent'), rx: count('bytes_received') });
            continue;
        }
        const f = line.trim().split(/\s+/);
        const owner = line.match(/users:\(\("(.*?)",pid=(\d+)/);
        socket = owner && !/^(127\.|\[::1\]|\[::ffff:127\.)/.test(f[4])
            ? (sockets[`${f[3]} ${f[4]}`] = { pid: Number(owner[2]), name: owner[1], tx: 0, rx: 0 })
            : null;
    }
    return sockets;
}

/** Growth of each counter since `prev`, summed per pid. prev/cur map a key to { pid, name, ...counters }; a key missing from prev counts from 0. */
function growthByPid(prev, cur, counters) {
    const byPid = {};
    for (const key in cur) {
        const c = cur[key], p = prev[key];
        const row = byPid[c.pid] ??= { pid: c.pid, name: c.name };
        for (const k of counters)
            row[k] = (row[k] ?? 0) + Math.max(0, c[k] - (p ? p[k] : 0));
    }
    return Object.values(byPid);
}
