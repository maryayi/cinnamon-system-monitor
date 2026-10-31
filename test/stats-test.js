// Run with `make test` (gjs -I applet test/stats-test.js). Any failed check throws.
const { parseCpu, cpuPercent, parseMem, parseNet, rate } = imports.stats;

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

// RAM
const mem = parseMem(MEMINFO);
assertEq(mem.total, 23768576, 'MemTotal');
assertEq(mem.available, 15207760, 'MemAvailable');
assertEq(mem.swapTotal, 12000252, 'SwapTotal');
assertEq(mem.swapFree, 12000252, 'SwapFree');
assertEq(100 * (mem.total - mem.available) / mem.total, 100 * 8560816 / 23768576, 'ram %');

// Net: lo is left out.
const net = parseNet(NET_DEV);
assertEq(net.rx, 458178240 + 710929 + 84, 'rx sum without lo');
assertEq(net.tx, 36530006 + 705727 + 33424, 'tx sum without lo');

// Rates
assertEq(rate(1000, 3000, 2), 1000, 'rate');
assertEq(rate(5000, 1000, 1), 0, 'negative delta → 0');

print('stats-test: all checks passed');
