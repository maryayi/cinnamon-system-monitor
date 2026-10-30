const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;

const { parseCpu, cpuPercent, parseMem, parseNet, rate } = require('./stats');

const CHART_WIDTH = 40;
const NET_MIN_SCALE = 16 * 1024;
const MAX_SAMPLES = 200;

function readProc(name) {
    const [, bytes] = GLib.file_get_contents(`/proc/${name}`);
    return new TextDecoder().decode(bytes);
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

        const addArea = draw => {
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
            box.add_child(area);
            return area;
        };
        const hist = this._history;
        const netMax = (s, w) => Math.max(NET_MIN_SCALE, ...s.slice(-w));
        this._cpuArea = addArea((cr, w, h) => drawColumns(cr, w, hist.cpu, 100, this._colors.cpu, h, h, true));
        this._memArea = addArea((cr, w, h) => drawColumns(cr, w, hist.mem, 100, this._colors.mem, h, h, true));
        this._netArea = addArea((cr, w, h) => {
            drawColumns(cr, w, hist.tx, netMax(hist.tx, w), this._colors.up, h / 2, h / 2, true);
            drawColumns(cr, w, hist.rx, netMax(hist.rx, w), this._colors.down, h / 2, h / 2, false);
        });
        this._areas = [this._cpuArea, this._memArea, this._netArea];

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
                mem: 100 * (mem.total - mem.available) / mem.total,
                rx: rate(this._last.net.rx, net.rx, seconds),
                tx: rate(this._last.net.tx, net.tx, seconds),
            };
            for (const key in sample) {
                const series = this._history[key];
                series.push(sample[key]);
                if (series.length > MAX_SAMPLES)
                    series.shift();
            }

            const size = n => GLib.format_size(Math.round(n));
            this.set_applet_tooltip(
                `CPU ${Math.round(sample.cpu)}%\n` +
                `RAM ${Math.round(sample.mem)}% (${size((mem.total - mem.available) * 1024)} of ${size(mem.total * 1024)})\n` +
                `↑ ${size(sample.tx)}/s   ↓ ${size(sample.rx)}/s`);
            this._repaint();
        }
        this._last = { time, cpu, net };
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
        this._icon.visible = !(this._cpuEnabled || this._memEnabled || this._netEnabled);
        this._repaint();
    }

    _repaint() {
        for (const area of this._areas) {
            if (area.visible)
                area.queue_repaint();
        }
    }

    _resize(panelHeight) {
        const scale = global.ui_scale;
        for (const area of this._areas)
            area.set_size(CHART_WIDTH * scale, panelHeight - 4 * scale);
    }

    on_panel_height_changed() {
        this._resize(this._panelHeight);
    }

    on_applet_removed_from_panel() {
        GLib.source_remove(this._timerId);
        this._settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new SystemMonitorApplet(metadata, orientation, panelHeight, instanceId);
}
