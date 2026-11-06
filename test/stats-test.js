// Run with `make test` (gjs -I applet test/stats-test.js). Any failed check throws.
const { parseCpu, cpuPercent, parseMem, parseNet, rate, parseProcStats, parsePs, parseSs, growthByPid } = imports.stats;

function assertEq(actual, expected, what) {
    if (Math.abs(actual - expected) > 1e-9)
        throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

// Real /proc text from the dev machine.
const STAT_A = `cpu  374381 60719 89462 2917673 35007 0 2151 0 0 0
cpu0 23101 3792 5543 182400 2180 0 410 0 0 0
intr 12345`;
const STAT_B = `cpu  374481 60719 89562 2917973 35007 0 2151 0 0 0
cpu0 23101 3792 5543 182400 2180 0 410 0 0 0`;

const MEMINFO = `MemTotal:       23768576 kB
MemFree:         5123456 kB
MemAvailable:   15207760 kB
Buffers:          123456 kB
SwapTotal:      12000252 kB
SwapFree:       12000252 kB`;

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  607494    4598    0    0    0     0          0         0   607494    4598    0    0    0     0       0          0
  wlo1: 458178240  529968    0  146    0     0          0         0 36530006  175300    0    0    0     0       0          0
tailscale0:  710929    4816    0    0    0     0          0         0   705727    9452    0    0    0     0       0          0
br-b0f68d29095d:      84       3    0    0    0     0          0         0    33424     226    0    8    0     0       0          0
`;

// CPU: Δtotal = 100 + 100 + 300 = 500, Δidle = 300 → 40 % busy.
const a = parseCpu(STAT_A), b = parseCpu(STAT_B);
assertEq(a.total, 374381 + 60719 + 89462 + 2917673 + 35007 + 0 + 2151 + 0, 'cpu total');
assertEq(a.idle, 2917673 + 35007, 'cpu idle includes iowait');
assertEq(cpuPercent(a, b), 40, 'cpu %');
assertEq(cpuPercent(a, a), 0, 'cpu % with Δtotal = 0');
// iowait dropped by 5 during a fully busy second: Δidle = -5, Δtotal = 395 → raw 101 %.
assertEq(cpuPercent({ total: 1000, idle: 500 }, { total: 1395, idle: 495 }), 100, 'cpu % clamped to 100');

// RAM
const mem = parseMem(MEMINFO);
assertEq(mem.total, 23768576, 'MemTotal');
assertEq(mem.used, 23768576 - 15207760, 'used = MemTotal - MemAvailable');
assertEq(mem.swapTotal, 12000252, 'SwapTotal');
assertEq(mem.swapUsed, 0, 'swapUsed = SwapTotal - SwapFree');

// Net: lo is left out.
const net = parseNet(NET_DEV);
assertEq(net.rx, 458178240 + 710929 + 84, 'rx sum without lo');
assertEq(net.tx, 36530006 + 705727 + 33424, 'tx sum without lo');

// Rates
assertEq(rate(1000, 3000, 2), 1000, 'rate');
assertEq(rate(5000, 1000, 1), 0, 'negative delta → 0');

// Per-process CPU: /proc/stat then /proc/<pid>/stat lines, as `cat /proc/stat /proc/[0-9]*/stat` prints them.
const PID_A = `1556 (mt76-tx phy0) S 2 0 0 0 -1 2129984 0 0 0 0 0 281 0 0 -2 0 1 0 632 0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 0 0 0 17 3 1 1 0 0 0 0 0 0 0 0 0 0 0
18537 (npm exec next-d) S 18396 18396 9881 34820 18396 4194304 16385 0 19 0 172 20 0 0 20 0 11 0 75451 1772023808 21489 18446744073709551615 7655424 52430497 140730424863456 0 0 0 0 4096 1937894967 0 0 0 17 7 0 0 0 0 0 112727472 112899296 435056640 140730424867113 140730424867191 140730424867191 140730424872903 0`;
// Second sample: 18537 used 8 more ticks (utime 172 → 180), 1556 is idle, 18618 is new.
const PID_B = `1556 (mt76-tx phy0) S 2 0 0 0 -1 2129984 0 0 0 0 0 281 0 0 -2 0 1 0 632 0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 0 0 0 17 3 1 1 0 0 0 0 0 0 0 0 0 0 0
18537 (npm exec next-d) S 18396 18396 9881 34820 18396 4194304 16385 0 19 0 180 20 0 0 20 0 11 0 75451 1772023808 21489 18446744073709551615 7655424 52430497 140730424863456 0 0 0 0 4096 1937894967 0 0 0 17 7 0 0 0 0 0 112727472 112899296 435056640 140730424867113 140730424867191 140730424867191 140730424872903 0
18618 (npm exec trigge) S 18396 18396 9881 34820 18396 4194304 19180 0 0 0 3 2 0 0 20 0 11 0 75748 1771786240 22455 18446744073709551615 7655424 52430497 140732521205152 0 0 0 0 4096 1937894967 0 0 0 17 3 0 0 0 0 0 112727472 112899296 486047744 140732521208108 140732521208183 140732521208183 140732521213895 0`;
const procA = parseProcStats(`${STAT_A}\n${PID_A}\n`), procB = parseProcStats(`${STAT_B}\n${PID_B}\n`);
assertEq(procA.total, a.total, 'proc stats total = /proc/stat total');
assertEq(Object.keys(procA.procs).length, 2, 'only pid lines become processes');
if (procA.procs[18537].name !== 'npm exec next-d')
    throw new Error(`comm with spaces: got ${procA.procs[18537].name}`);
assertEq(procA.procs[18537].ticks, 172 + 20, 'ticks = utime + stime');
assertEq(procA.procs[1556].ticks, 281, 'kernel thread ticks');
const cpuRows = growthByPid(procA.procs, procB.procs, ['ticks']);
const ticksOf = pid => cpuRows.find(r => r.pid === pid).ticks;
assertEq(ticksOf(18537), 8, 'Δticks');
assertEq(ticksOf(1556), 0, 'idle process');
assertEq(ticksOf(18618), 5, 'new process counts from 0');

// Per-process memory
const ps = parsePs(`      1 19372 systemd
      2     0 kthreadd
  18537 86836 npm exec next-d
`);
assertEq(ps.length, 3, 'ps rows');
if (ps[2].name !== 'npm exec next-d' || ps[2].pid !== 18537)
    throw new Error(`ps row: got ${JSON.stringify(ps[2])}`);
assertEq(ps[2].rss, 86836, 'ps rss');

// Per-process network: real `ss -tinpH` text with an ownerless socket and a loopback one.
const SS_A = `ESTAB 0      0      192.168.88.254:50408   140.82.112.26:443  users:(("chrome",pid=10216,fd=239))
	 cubic wscale:12,10 rto:264 rtt:63.418/7.261 ato:40 mss:1368 pmtu:1500 rcvmss:1368 advmss:1448 cwnd:10 bytes_sent:3976 bytes_acked:3977 bytes_received:4079 segs_out:92 segs_in:99 data_segs_out:11 data_segs_in:14 send 1725693bps lastsnd:13704 lastrcv:13704 lastack:13634 pacing_rate 3451344bps delivery_rate 326296bps delivered:12 app_limited busy:597ms rcv_space:14480 rcv_ssthresh:75032 minrtt:53.781 snd_wnd:45056 rcv_wnd:75776
ESTAB 0      0      192.168.88.254:44324   142.251.155.7:443  users:(("chrome",pid=10216,fd=181))
	 cubic wscale:12,10 rto:280 rtt:79.557/13.736 ato:40 mss:1368 pmtu:1500 rcvmss:1300 advmss:1448 cwnd:19 bytes_sent:22447 bytes_acked:22448 bytes_received:4859 segs_out:46 segs_in:39 data_segs_out:24 data_segs_in:11 send 2613673bps lastsnd:51724 lastrcv:51725 lastack:6276 pacing_rate 5227304bps delivery_rate 1311616bps delivered:25 app_limited busy:401ms rcv_space:14480 rcv_ssthresh:72432 minrtt:63.593 snd_wnd:36864 rcv_wnd:72704
ESTAB      0      0      192.168.88.254:47882  185.40.234.219:443
	 cubic wscale:12,10 rto:263 rtt:62.756/5.439 ato:40 mss:1368 pmtu:1500 rcvmss:1368 advmss:1448 cwnd:10 bytes_sent:4063 bytes_acked:4064 bytes_received:4154 segs_out:136 segs_in:146 data_segs_out:14 data_segs_in:17 send 1743897bps lastsnd:38452 lastrcv:38453 lastack:38393 pacing_rate 3487752bps delivery_rate 326296bps delivered:15 app_limited busy:783ms rcv_space:14480 rcv_ssthresh:75032 minrtt:53.781 snd_wnd:45056 rcv_wnd:75776
ESTAB 0      0      127.0.0.1:58526 127.0.0.1:42773 users:(("python3",pid=23985,fd=4))
	 cubic wscale:10,10 rto:201 rtt:0.071/0.039 mss:52736 pmtu:65535 rcvmss:536 advmss:65483 cwnd:10 bytes_sent:5000 bytes_acked:5001 segs_out:3 segs_in:2 data_segs_out:1 send 59420845070bps lastsnd:59 lastrcv:59 lastack:59 pacing_rate 118841690136bps delivery_rate 19176727272bps delivered:2 app_limited rcv_space:65495 rcv_ssthresh:65495 minrtt:0.022 snd_wnd:105472 rcv_wnd:65536
`;
const sockA = parseSs(SS_A);
assertEq(Object.keys(sockA).length, 2, 'ss drops ownerless and loopback sockets');
const chrome = sockA['192.168.88.254:44324 142.251.155.7:443'];
assertEq(chrome.pid, 10216, 'ss pid');
assertEq(chrome.tx, 22447, 'ss bytes_sent');
assertEq(chrome.rx, 4859, 'ss bytes_received');
// One second later the first chrome socket sent 1000 and got 2000 more bytes; the second one closed.
const sockB = { '192.168.88.254:50408 140.82.112.26:443': { pid: 10216, name: 'chrome', tx: 4976, rx: 6079 } };
const netRows = growthByPid(sockA, sockB, ['tx', 'rx']);
assertEq(netRows.length, 1, 'one row per pid');
assertEq(netRows[0].tx, 1000, 'Δtx');
assertEq(netRows[0].rx, 2000, 'Δrx');
const twoSockets = growthByPid({}, sockA, ['tx', 'rx']).find(r => r.pid === 10216);
assertEq(twoSockets.tx, 3976 + 22447, 'sockets of one pid are summed');

print('stats-test: all checks passed');
