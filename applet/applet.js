const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Util = imports.misc.util;

const { parseCpu, cpuPercent, parseMem, parseNet, rate, parseProcStats, parsePs, parseSs, growthByPid } = require('./stats');

const CHART_WIDTH = 40;
const NET_MIN_SCALE = 16 * 1024;
const POPUP_CHART_WIDTH = 300;
const POPUP_CHART_HEIGHT = 60;
// Enough 1-px columns to fill the popup chart at ui_scale 2.
const MAX_SAMPLES = 600;
const DETAILS_ROWS = 10;

function readProc(name) {
    const [, bytes] = GLib.file_get_contents(`/proc/${name}`);
    return new TextDecoder().decode(bytes);
}

const size = n => GLib.format_size(Math.round(n));

// One monospace row of a details menu; comm names are at most 15 chars, except some kernel threads.
function detailsLine(name, pid, ...values) {
    return [name.slice(0, 15).padEnd(15), String(pid).padStart(7), ...values.map(v => v.padStart(12))].join(' ');
}

function parseColor(str) {
    const [, c] = Clutter.Color.from_string(str);
    return [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255];
}

// Tints the band from baseY up (or down) by `span`, then draws one 1-px
// column per sample, newest on the right, all in one path.
function drawColumns(cr, w, samples, max, color, baseY, span, up) {
    const [r, g, b, a] = color;
    cr.setSourceRGBA(r, g, b, a * 0.2);
    cr.rectangle(0, up ? baseY - span : baseY, w, span);
    cr.fill();

    const visible = samples.slice(-w);
    const x0 = w - visible.length;
    visible.forEach((v, i) => {
        const len = Math.min(1, v / max) * span;
        cr.rectangle(x0 + i, up ? baseY - len : baseY, 1, len);
    });
    cr.setSourceRGBA(r, g, b, a);
    cr.fill();
}

class SystemMonitorApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._history = { cpu: [], mem: [], rx: [], tx: [] };
        this._last = null;

        const box = new St.BoxLayout({ style: 'spacing: 2px', y_align: Clutter.ActorAlign.CENTER });
        this.actor.add_child(box);

        const addArea = (parent, draw) => {
            const area = new St.DrawingArea();
            area.connect('repaint', () => {
                const [w, h] = area.get_surface_size();
                const cr = area.get_context();
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.setOperator(Cairo.Operator.OVER);
                draw(cr, w, h);
                cr.$dispose();
            });
            parent.add_child(area);
            return area;
        };
        const hist = this._history;
        const netMax = (s, w) => Math.max(NET_MIN_SCALE, ...s.slice(-w));
        const drawCpu = (cr, w, h) => drawColumns(cr, w, hist.cpu, 100, this._colors.cpu, h, h, true);
        const drawMem = (cr, w, h) => drawColumns(cr, w, hist.mem, 100, this._colors.mem, h, h, true);
        const drawNet = (cr, w, h) => {
            drawColumns(cr, w, hist.tx, netMax(hist.tx, w), this._colors.up, h / 2, h / 2, true);
            drawColumns(cr, w, hist.rx, netMax(hist.rx, w), this._colors.down, h / 2, h / 2, false);
        };
        this._cpuArea = addArea(box, drawCpu);
        this._memArea = addArea(box, drawMem);
        this._netArea = addArea(box, drawNet);
        this._areas = [this._cpuArea, this._memArea, this._netArea];

        // Left-click menu: the same charts, bigger, each under a label with details.
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        const scale = global.ui_scale;
        this._popupAreas = [];
        const addPopupChart = draw => {
            // Reactive so hovering it opens its details menu; activate: false keeps clicks from closing the menu.
            const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
            const vbox = new St.BoxLayout({ vertical: true, style: 'spacing: 4px' });
            item.label = new St.Label();
            vbox.add_child(item.label);
            const area = addArea(vbox, draw);
            area.set_size(POPUP_CHART_WIDTH * scale, POPUP_CHART_HEIGHT * scale);
            this._popupAreas.push(area);
            item.addActor(vbox);
            this.menu.addMenuItem(item);
            return item;
        };
        this._cpuItem = addPopupChart(drawCpu);
        this._memItem = addPopupChart(drawMem);
        this._netItem = addPopupChart(drawNet);

        // Hovering a popup chart opens a menu beside it with the top processes, refreshed every tick.
        // It is not given to menuManager, so it stays display-only and closing this.menu closes it too.
        const addDetails = (item, command, header, render) => {
            const menu = new PopupMenu.PopupMenu(this.menu.actor, St.Side.LEFT);
            Main.uiGroup.add_actor(menu.actor);
            menu.actor.hide();
            const label = new St.Label({ style: 'font-family: monospace' });
            const row = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            row.addActor(label);
            menu.addMenuItem(row);
            item.details = { menu, label, command, header, render };
        };
        // render(stdout, details) → [[score, name, pid, ...values]], or null while it only stored a baseline.
        addDetails(this._cpuItem, 'cat /proc/stat /proc/[0-9]*/stat', detailsLine('Process', 'PID', 'CPU'), (out, d) => {
            const cur = parseProcStats(out), prev = d.prev;
            d.prev = cur;
            // Share of all cores, like the CPU chart, so the rows add up to its value.
            return prev && growthByPid(prev.procs, cur.procs, ['ticks'])
                .map(p => [p.ticks, p.name, p.pid, `${(100 * p.ticks / (cur.total - prev.total)).toFixed(1)}%`]);
        });
        addDetails(this._memItem, 'ps -eo pid=,rss=,comm=', detailsLine('Process', 'PID', 'Memory'),
            out => parsePs(out).map(p => [p.rss, p.name, p.pid, size(p.rss * 1024)]));
        // shortcut: ss only sees TCP sockets of the user's own processes (no UDP/QUIC, no root daemons, no other netns); per-process totals need root (eBPF or pcap, like nethogs).
        addDetails(this._netItem, 'ss -tinpH', `TCP of your own processes only\n${detailsLine('Process', 'PID', '↑ Upload', '↓ Download')}`, (out, d) => {
            const cur = { time: GLib.get_monotonic_time(), sockets: parseSs(out) }, prev = d.prev;
            d.prev = cur;
            const seconds = prev && (cur.time - prev.time) / 1e6;
            return prev && growthByPid(prev.sockets, cur.sockets, ['tx', 'rx'])
                .map(p => [p.tx + p.rx, p.name, p.pid, `${size(p.tx / seconds)}/s`, `${size(p.rx / seconds)}/s`]);
        });
        this.menu.connect('active-changed', (menu, item) => {
            // null means the pointer left the item, maybe into its details menu, so keep that open.
            if (item)
                this._showDetails(item);
        });
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                this._showDetails(null);
        });
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);
        const addAction = (text, icon, callback) => {
            const item = new PopupMenu.PopupIconMenuItem(text, icon, St.IconType.SYMBOLIC);
            item.connect('activate', callback);
            this.menu.addMenuItem(item);
        };
        addAction('Settings', 'preferences-system-symbolic', () => this.configureApplet());
        addAction('About', 'help-about-symbolic', () => this.openAbout());

        // Shown only when every chart is off, so there is still something to right-click.
        // shortcut: fixed 16 px instead of the panel zone's symbolic icon size; follow getPanelIconSize() if it looks off.
        this._icon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 16,
        });
        box.add_child(this._icon);

        this._settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        const apply = () => this._applySettings();
        this._settings.bind('cpu-enabled', '_cpuEnabled', apply);
        this._settings.bind('cpu-color', '_cpuColor', apply);
        this._settings.bind('mem-enabled', '_memEnabled', apply);
        this._settings.bind('mem-color', '_memColor', apply);
        this._settings.bind('net-enabled', '_netEnabled', apply);
        this._settings.bind('net-up-color', '_netUpColor', apply);
        this._settings.bind('net-down-color', '_netDownColor', apply);
        this._applySettings();

        // this.panel is not set yet inside the constructor, so use the argument.
        this._resize(panelHeight);

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            try {
                this._tick();
            } catch (e) {
                global.logError(e);
            }
            // Returning anything else (or throwing) removes the timer for good.
            return GLib.SOURCE_CONTINUE;
        });
    }

    _tick() {
        const time = GLib.get_monotonic_time();
        const cpu = parseCpu(readProc('stat'));
        const mem = parseMem(readProc('meminfo'));
        const net = parseNet(readProc('net/dev'));

        // The first tick only stores a baseline.
        if (this._last) {
            const seconds = (time - this._last.time) / 1e6;
            const sample = {
                cpu: cpuPercent(this._last.cpu, cpu),
                mem: 100 * mem.used / mem.total,
                rx: rate(this._last.net.rx, net.rx, seconds),
                tx: rate(this._last.net.tx, net.tx, seconds),
            };
            for (const key in sample) {
                const series = this._history[key];
                series.push(sample[key]);
                if (series.length > MAX_SAMPLES)
                    series.shift();
            }

            const cpuLine = `CPU ${Math.round(sample.cpu)}%`;
            const memLine = `RAM ${Math.round(sample.mem)}% (${size(mem.used * 1024)} of ${size(mem.total * 1024)})`;
            const netLine = `↑ ${size(sample.tx)}/s   ↓ ${size(sample.rx)}/s`;
            this.set_applet_tooltip(`${cpuLine}\n${memLine}\n${netLine}`);
            this._cpuItem.label.text = `${cpuLine}\nLoad average ${readProc('loadavg').split(' ', 3).join(' ')}`;
            this._memItem.label.text = `${memLine}\nSwap ${size(mem.swapUsed * 1024)} of ${size(mem.swapTotal * 1024)}`;
            this._netItem.label.text = `Network ${netLine}\nTotal ↑ ${size(net.tx)}   ↓ ${size(net.rx)}`;
            this._repaint();
        }
        this._last = { time, cpu, net };
        this._updateDetails();
    }

    // Opens the details menu of the hovered popup chart; hovering any other item closes it.
    _showDetails(item) {
        const details = item?.details;
        if (details === this._details)
            return;
        this._details?.menu.close();
        this._details = details;
        if (!details)
            return;
        details.prev = null;
        details.label.text = `${details.header}\n…`;
        details.menu.shiftToPosition(item.actor.get_transformed_position()[1]);
        details.menu.open();
        this._updateDetails();
    }

    // Runs the open details menu's command off the main thread; ss alone takes ~80 ms.
    _updateDetails() {
        const details = this._details;
        if (!details || details.pending)
            return;
        details.pending = true;
        Util.spawnCommandLineAsyncIO(details.command, out => {
            details.pending = false;
            const rows = details.render(out, details);
            const lines = rows ? rows.filter(r => r[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, DETAILS_ROWS)
                .map(([, ...cells]) => detailsLine(...cells)) : ['…'];
            details.label.text = [details.header, ...(lines.length ? lines : ['(none)'])].join('\n');
        });
    }

    _applySettings() {
        this._colors = {
            cpu: parseColor(this._cpuColor),
            mem: parseColor(this._memColor),
            up: parseColor(this._netUpColor),
            down: parseColor(this._netDownColor),
        };
        this._cpuArea.visible = this._cpuEnabled;
        this._memArea.visible = this._memEnabled;
        this._netArea.visible = this._netEnabled;
        this._cpuItem.actor.visible = this._cpuEnabled;
        this._memItem.actor.visible = this._memEnabled;
        this._netItem.actor.visible = this._netEnabled;
        this._icon.visible = !(this._cpuEnabled || this._memEnabled || this._netEnabled);
        this._separator.actor.visible = !this._icon.visible;
        this._repaint();
    }

    _repaint() {
        // A hidden DrawingArea only flags itself dirty here and paints when shown.
        for (const area of [...this._areas, ...this._popupAreas])
            area.queue_repaint();
    }

    _resize(panelHeight) {
        const scale = global.ui_scale;
        for (const area of this._areas)
            area.set_size(CHART_WIDTH * scale, panelHeight - 4 * scale);
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_panel_height_changed() {
        this._resize(this._panelHeight);
    }

    on_applet_removed_from_panel() {
        GLib.source_remove(this._timerId);
        this._settings.finalize();
        this.menu.destroy();
        for (const item of [this._cpuItem, this._memItem, this._netItem])
            item.details.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new SystemMonitorApplet(metadata, orientation, panelHeight, instanceId);
}
