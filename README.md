# System Monitor (Cinnamon applet)

A lightweight [Cinnamon](https://github.com/linuxmint/cinnamon) panel applet
that draws three small live charts: **CPU**, **RAM**, and **network**
(upload and download). No dependencies beyond Cinnamon itself.

## Features

- **CPU chart**: total CPU usage across all cores, in percent.
- **RAM chart**: memory in use (total minus available), in percent.
- **Network chart**: upload grows up from the middle line, download grows
  down. Auto-scales to the busiest second on screen (minimum 16 KiB/s).
- **Tooltip** on hover with exact numbers, e.g.
  `CPU 12%`, `RAM 41% (9.7 GB of 23.8 GB)`, `↑ 3.1 kB/s ↓ 120 kB/s`.
- **Click menu**: left-click the applet for bigger charts (last 5 minutes, 10 on HiDPI)
  with details: load average, swap use, and total traffic since boot, plus
  **Settings** and **About** entries.
- **Configurable**: pick a color for each chart and turn each one on or off.
- Updates once per second; each chart shows the last 40 seconds.
- Follows panel height and HiDPI scaling.

## Requirements

- Linux with the Cinnamon desktop (developed on Cinnamon 6.4).
- `git` and `make` to install.
- `gjs` only if you want to run the tests.

## Installation

```sh
git clone https://github.com/maryayi/cinnamon-system-monitor.git
cd cinnamon-system-monitor
make install
```

`make install` symlinks the `applet/` folder to
`~/.local/share/cinnamon/applets/system-monitor@maryayi.github.io`, so keep
the cloned folder where it is.

Then add it to the panel:

1. Right-click the panel → **Applets**.
2. Find **System Monitor** and click **+** (or drag it onto the panel).

If it does not show up in the list, restart Cinnamon (`Ctrl+Alt+Esc`) and
try again.

### Install without make

```sh
cp -r applet ~/.local/share/cinnamon/applets/system-monitor@maryayi.github.io
```

### Update

```sh
git pull
make reload
```

### Uninstall

Remove the applet from the panel, then:

```sh
rm -rf ~/.local/share/cinnamon/applets/system-monitor@maryayi.github.io
```

## Configuration

Right-click the applet → **Configure…**

| Section | Option | Default |
|---------|--------|---------|
| CPU | Show CPU chart | on |
| CPU | Color | blue `rgb(98,160,234)` |
| RAM | Show RAM chart | on |
| RAM | Color | green `rgb(87,227,137)` |
| Network | Show network chart | on |
| Network | Upload color | purple `rgb(192,97,203)` |
| Network | Download color | orange `rgb(255,163,72)` |

If you turn every chart off, a small system-monitor icon stays in the panel
so you can still right-click it.

## How it works

Every second the applet reads three kernel files and compares them with the
previous reading:

| Chart | Source | Value |
|-------|--------|-------|
| CPU | `/proc/stat` | busy time ÷ total time (iowait counts as idle) |
| RAM | `/proc/meminfo` | `(MemTotal − MemAvailable) ÷ MemTotal` |
| Network | `/proc/net/dev` | bytes per second, summed over all interfaces except `lo` |

## Development

```
applet/
  applet.js             panel UI, drawing, timer
  stats.js              pure /proc parsers and math (no Cinnamon imports)
  metadata.json         applet id, name, version
  settings-schema.json  Configure dialog
test/
  stats-test.js         checks for stats.js, runs under plain gjs
Makefile
```

| Command | What it does |
|---------|--------------|
| `make install` | symlink the applet into `~/.local/share/cinnamon/applets` |
| `make reload` | reload the applet in the running Cinnamon after a code change |
| `make test` | run the parser tests with `gjs` |

Errors from the applet show up in Looking Glass (`Alt+F2`, type `lg`, Enter)
or in `~/.xsession-errors`.

## Known limitations

- Network traffic is summed over every interface except `lo`, so traffic that
  goes through Docker, VPN, or bridge interfaces can be counted twice.
- Only one instance of the applet can be added.

## License

[MIT](LICENSE) © 2026 Mahdi Aryayi
