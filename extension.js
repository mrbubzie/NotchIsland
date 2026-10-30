import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

// ============================ Tweakable settings ============================
// Blur, background, clock hiding, notch overrides and calendar options are in the
// extension's settings (Extension Manager -> Notch Island -> gear icon).
const NOTCH_PHYS_HEIGHT = 64;         // notch height in physical pixels
const NOTCH_WIDTH_RATIO = 0.135;      // notch width as a fraction of physical screen width
const NOTCH_GAP = 22;                 // clear space kept on each side of the notch
// Framebuffer heights (physical px) that mean "the notch area is visible":
// Air 13" M2/M3, Air 15", Pro 14", Pro 16"
const NOTCHED_HEIGHTS = [1664, 1864, 1964, 2234];

const HOT_WIDTH = 260;                // hover zone width when no notch is visible
const HOT_HEIGHT = 3;                 // hover zone height when no notch is visible
const PANEL_WIDTH = 760;
const PANEL_PADDING = 22;             // must match stylesheet.css
const COLUMN_GAP = 22;                // must match stylesheet.css
const MIN_HEADER_HEIGHT = 44;
const OPEN_DELAY_MS = 150;
const HIDE_DELAY_MS = 450;

// Clicking a day runs this. {date} becomes YYYY-MM-DD.
const CALENDAR_COMMAND = ['gnome-calendar', '--date={date}'];

// ============================================================================

const BMS_UUID = 'blur-my-shell@aunetx';
const EXTENSION_ACTIVE = 1;

// libadwaita accent colors, keyed by org.gnome.desktop.interface accent-color
const ACCENTS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};

// Fragment shader that cuts a blurred layer to a rounded rectangle (all four corners).
const MASK_SHADER = `
uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float radius;
void main() {
    vec4 c = texture2D(tex, cogl_tex_coord_in[0].xy);
    vec2 size = vec2(width, height);
    vec2 p = cogl_tex_coord_in[0].xy * size;
    vec2 halfSize = size * 0.5;
    float r = min(radius, min(halfSize.x, halfSize.y));
    vec2 q = abs(p - halfSize) - (halfSize - vec2(r));
    float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
    float a = clamp(0.5 - d, 0.0, 1.0);
    cogl_color_out = c * a;
}`;

const RoundedMaskEffect = GObject.registerClass(
class NotchRoundedMaskEffect extends Clutter.ShaderEffect {
    constructor() {
        super({shader_type: Clutter.ShaderType.FRAGMENT_SHADER});
        this._w = 1;
        this._h = 1;
        this._r = 0;
        this.set_shader_source(MASK_SHADER);
    }

    setGeometry(w, h, r) {
        this._w = w;
        this._h = h;
        this._r = r;
        this.queue_repaint();
    }

    vfunc_paint_target(node, paintContext) {
        // The small fraction forces a float (not int) GValue for the float uniforms.
        this.set_uniform_value('tex', 0);
        this.set_uniform_value('width', this._w + 0.001);
        this.set_uniform_value('height', this._h + 0.001);
        this.set_uniform_value('radius', this._r + 0.001);
        super.vfunc_paint_target(node, paintContext);
    }
});

function readText(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder().decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

export default class NotchIslandExtension extends Extension {
    enable() {
        this._open = false;
        this._openTimer = 0;
        this._hideTimer = 0;
        this._clockTimer = 0;
        this._sourceSignals = new Map();
        this._trayIds = [];
        this._themeSignals = [];
        this._blurEffect = null;
        this._maskEffect = null;
        this._accent = ACCENTS.blue;

        this._settings = this.getSettings();
        this._loadConfig();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._readAccent();

        this._notch = this._detectNotch();
        this._buildZone();
        this._buildPanel();
        this._position();
        this._connectNotifications();
        this._connectTheme();
        this._applyClockHiding();
        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSettingChanged(key));

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._relayout());
    }

    disable() {
        this._cancelTimers();

        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._restoreClock();

        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        for (const [obj, id] of this._themeSignals) {
            try { obj.disconnect(id); } catch (e) { /* gone */ }
        }
        this._themeSignals = [];

        for (const id of this._trayIds)
            Main.messageTray.disconnect(id);
        this._trayIds = [];

        for (const [source, ids] of this._sourceSignals) {
            for (const id of ids) {
                try { source.disconnect(id); } catch (e) { /* gone */ }
            }
        }
        this._sourceSignals.clear();

        this._destroyPanel();
        if (this._zone) {
            Main.layoutManager.removeChrome(this._zone);
            this._zone.destroy();
            this._zone = null;
        }
        this._iface = null;
        this._settings = null;
    }

    _cancelTimers() {
        for (const key of ['_openTimer', '_hideTimer', '_clockTimer']) {
            if (this[key]) {
                GLib.source_remove(this[key]);
                this[key] = 0;
            }
        }
    }

    // --------------------------------------------------------------- Settings

    _loadConfig() {
        const s = this._settings;
        this._cfg = {
            hideClock: s.get_boolean('hide-system-clock'),
            blurMode: s.get_string('blur-style'),
            panelOpacity: s.get_double('panel-opacity'),
            blurSigma: s.get_int('blur-sigma'),
            blurBrightness: s.get_double('blur-brightness'),
            blurOpacity: s.get_double('blur-opacity'),
            background: s.get_string('background-style'),
            notchWidth: s.get_int('notch-width'),
            notchHeight: s.get_int('notch-height'),
            monday: s.get_boolean('week-starts-monday'),
            clock24h: s.get_boolean('clock-24h'),
            cornerRadius: s.get_int('corner-radius'),
        };
    }

    _onSettingChanged(key) {
        this._loadConfig();
        switch (key) {
        case 'hide-system-clock':
            this._applyClockHiding();
            break;
        case 'blur-style':
        case 'panel-opacity':
        case 'blur-sigma':
        case 'blur-brightness':
        case 'blur-opacity':
        case 'background-style':
        case 'corner-radius':
            this._applyTheme();
            break;
        default:
            this._relayout();
        }
    }

    // Hide / restore the built-in date and time in the centre of the top bar
    _applyClockHiding() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu?.container)
            return;

        if (!this._cfg.hideClock) {
            this._restoreClock();
            return;
        }

        if (!this._clockContainer) {
            this._clockContainer = dateMenu.container;
            // The shell may re-show it (e.g. after unlocking); keep it hidden.
            this._clockVisId = this._clockContainer.connect('notify::visible', () => {
                if (this._cfg?.hideClock && this._clockContainer?.visible)
                    this._clockContainer.hide();
            });
        }
        this._clockContainer.hide();
    }

    _restoreClock() {
        if (!this._clockContainer)
            return;
        try {
            if (this._clockVisId)
                this._clockContainer.disconnect(this._clockVisId);
        } catch (e) { /* ignore */ }
        this._clockVisId = 0;
        try { this._clockContainer.show(); } catch (e) { /* ignore */ }
        this._clockContainer = null;
    }

    // ------------------------------------------------------- Notch detection

    _detectNotch() {
        const none = {visible: false, height: 0, width: 0};
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return none;

        let scale = 1;
        try {
            scale = global.display.get_monitor_scale(Main.layoutManager.primaryIndex);
        } catch (e) {
            scale = mon.geometry_scale ?? 1;
        }
        const physW = mon.width * scale;
        const physH = mon.height * scale;

        // 1) The framebuffer height tells us if the notch strip is part of the screen.
        let visible = NOTCHED_HEIGHTS.some(h => Math.abs(h - physH) <= 4);

        // 2) Asahi's appledrm module parameter, if readable.
        if (!visible) {
            for (const dir of ['appledrm', 'apple_drm', 'adpdrm']) {
                const v = readText(`/sys/module/${dir}/parameters/show_notch`);
                if (v !== null) {
                    visible = /^[Yy1]/.test(v);
                    break;
                }
            }
        }

        if (!visible)
            return none;

        const height = this._cfg.notchHeight > 0 ? this._cfg.notchHeight : Math.round(NOTCH_PHYS_HEIGHT / scale);
        const width = this._cfg.notchWidth > 0 ? this._cfg.notchWidth : Math.round(physW * NOTCH_WIDTH_RATIO / scale);
        return {visible: true, height, width};
    }

    // ------------------------------------------------------------ UI building

    _buildZone() {
        this._zone = new St.Widget({reactive: true, track_hover: true, opacity: 0});
        Main.layoutManager.addTopChrome(this._zone);
        this._zone.connect('notify::hover', () => this._onHoverChanged());
    }

    _destroyPanel() {
        if (!this._root)
            return;
        this._root.remove_all_transitions();
        Main.layoutManager.removeChrome(this._root);
        this._root.destroy();
        this._root = null;
        this._panel = null;
        this._blurBox = null;
        this._wall = null;
        this._blurEffect = null;
        this._maskEffect = null;
        this._probe = null;
    }

    _buildPanel() {
        const n = this._notch;
        const panelW = Math.max(PANEL_WIDTH, n.width + 2 * NOTCH_GAP + 520 + 2 * PANEL_PADDING);
        const inner = panelW - 2 * PANEL_PADDING;
        const headerH = Math.max(n.height, MIN_HEADER_HEIGHT);
        const spacerW = n.visible ? n.width + 2 * NOTCH_GAP : 0;
        const sideW = Math.floor((inner - spacerW) / 2);
        const colW = Math.floor((inner - 2 * COLUMN_GAP - 1) / 2);
        this._panelWidth = panelW;

        // root = what goes in the top chrome and gets animated.
        // It holds a blur layer (blurred wallpaper) underneath the content panel.
        this._root = new St.Widget({reactive: true, track_hover: true, visible: false});
        this._root.connect('notify::hover', () => this._onHoverChanged());

        this._blurBox = new Clutter.Actor({clip_to_allocation: true, visible: false});
        this._blurBox.set_size(panelW, 10);
        this._root.add_child(this._blurBox);

        this._wall = null;
        try {
            const mgr = Main.layoutManager._bgManagers?.[Main.layoutManager.primaryIndex];
            const src = mgr?.backgroundActor;
            if (src) {
                this._wall = new Clutter.Clone({source: src});
                this._blurBox.add_child(this._wall);
            }
        } catch (e) {
            console.warn(`notch-island: no wallpaper for blur: ${e.message}`);
        }

        this._panel = new St.BoxLayout({
            style_class: 'notch-island',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._panel.set_width(panelW);
        this._root.add_child(this._panel);
        this._panel.connect('notify::allocation', () => this._syncBlurBox());
        Main.layoutManager.addTopChrome(this._root);

        // ---- Header row: [clock] [gap for the notch] [notifications title]
        const header = new St.BoxLayout({style_class: 'notch-header'});
        header.set_height(headerH);

        const hLeft = new St.BoxLayout({style_class: 'notch-header-left', y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        hLeft.set_width(sideW);
        this._clockLabel = new St.Label({style_class: 'notch-clock', y_align: Clutter.ActorAlign.CENTER});
        this._dateLabel = new St.Label({style_class: 'notch-date', y_align: Clutter.ActorAlign.CENTER});
        hLeft.add_child(this._clockLabel);
        hLeft.add_child(this._dateLabel);

        const spacer = new St.Widget();
        spacer.set_width(spacerW);

        const hRight = new St.BoxLayout({style_class: 'notch-header-right', y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        hRight.set_width(sideW);
        hRight.add_child(new St.Label({
            text: 'Notifications',
            style_class: 'notch-notif-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const clear = new St.Button({label: 'Clear', style_class: 'notch-clear-btn', reactive: true, can_focus: true});
        clear.connect('clicked', () => this._clearAll());
        hRight.add_child(clear);

        header.add_child(hLeft);
        header.add_child(spacer);
        header.add_child(hRight);

        // ---- Body row: calendar | separator | notifications
        const body = new St.BoxLayout({style_class: 'notch-body'});

        const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'notch-col'});
        left.set_width(colW);

        const calHeader = new St.BoxLayout({style_class: 'notch-cal-header'});
        const prev = this._navButton('go-previous-symbolic', () => this._shiftMonth(-1));
        const next = this._navButton('go-next-symbolic', () => this._shiftMonth(1));
        this._monthLabel = new St.Label({
            style_class: 'notch-month',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        calHeader.add_child(prev);
        calHeader.add_child(this._monthLabel);
        calHeader.add_child(next);
        left.add_child(calHeader);

        this._gridLayout = new Clutter.GridLayout();
        this._grid = new St.Widget({layout_manager: this._gridLayout, x_align: Clutter.ActorAlign.CENTER});
        left.add_child(this._grid);

        const sep = new St.Widget({style_class: 'notch-sep', y_expand: true});

        const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'notch-col'});
        right.set_width(colW);
        this._scroll = new St.ScrollView({
            style_class: 'notch-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._notifBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._scroll.set_child(this._notifBox);
        right.add_child(this._scroll);

        body.add_child(left);
        body.add_child(sep);
        body.add_child(right);

        this._panel.add_child(header);
        this._panel.add_child(body);

        // Invisible widget used to read the shell theme's popup colours
        this._probe = new St.Widget({style_class: 'popup-menu-content', visible: false});
        this._panel.add_child(this._probe);

        const now = GLib.DateTime.new_now_local();
        this._viewYear = now.get_year();
        this._viewMonth = now.get_month();
        this._renderCalendar();
        this._refreshNotifications();
        this._updateClock();
        this._applyTheme();
    }

    _navButton(iconName, cb) {
        const btn = new St.Button({
            style_class: 'notch-nav-btn',
            reactive: true,
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        btn.connect('clicked', cb);
        return btn;
    }

    _relayout() {
        if (!this._panel)
            return;
        this._cancelTimers();
        this._open = false;
        this._notch = this._detectNotch();
        this._destroyPanel();
        this._buildPanel();
        this._position();
    }

    _position() {
        if (!this._zone || !this._root)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const n = this._notch;

        // With a visible notch the zone covers the notch itself plus a strip under it,
        // so both "push the pointer into the notch" and "rest just below it" work.
        const zw = n.visible ? n.width + 2 * NOTCH_GAP : HOT_WIDTH;
        const zh = n.visible ? n.height + 4 : HOT_HEIGHT;
        this._zone.set_size(zw, zh);
        this._zone.set_position(Math.round(mon.x + (mon.width - zw) / 2), mon.y);

        const rootX = Math.round(mon.x + (mon.width - this._panelWidth) / 2);
        this._root.set_position(rootX, mon.y);

        // Line the wallpaper clone up with the real wallpaper, so the blur shows what is behind.
        if (this._wall) {
            this._wall.set_size(mon.width, mon.height);
            this._wall.set_position(mon.x - rootX, 0);
        }
    }

    // ---------------------------------------------------------------- Theming

    _readAccent() {
        try {
            const schema = this._iface.settings_schema;
            if (schema.has_key('accent-color')) {
                const name = this._iface.get_string('accent-color');
                this._accent = ACCENTS[name] ?? ACCENTS.blue;
                return;
            }
        } catch (e) { /* older GNOME: no accent colours */ }
        this._accent = ACCENTS.blue;
    }

    _blurInfo() {
        const mode = this._cfg.blurMode;
        if (mode === 'off')
            return null;

        const ext = Main.extensionManager.lookup(BMS_UUID);
        const bmsActive = !!ext && ext.state === EXTENSION_ACTIVE;
        if (mode === 'auto' && !bmsActive)
            return null;

        let sigma = this._cfg.blurSigma;
        let brightness = this._cfg.blurBrightness;

        // Automatic mode copies Blur my Shell's panel blur so the island matches the top bar.
        if (mode === 'auto' && bmsActive) {
            try {
                const dir = Gio.File.new_for_path(ext.path).get_child('schemas').get_path();
                const src = Gio.SettingsSchemaSource.new_from_directory(
                    dir, Gio.SettingsSchemaSource.get_default(), false);
                const schema = src.lookup('org.gnome.shell.extensions.blur-my-shell.panel', false);
                if (schema) {
                    const s = new Gio.Settings({settings_schema: schema});
                    if (schema.has_key('sigma'))
                        sigma = s.get_int('sigma');
                    if (schema.has_key('brightness'))
                        brightness = s.get_double('brightness');
                }
            } catch (e) { /* keep our own values */ }
        }
        return {sigma: Math.max(1, Math.min(sigma, 60)), brightness};
    }

    // Blur the *wallpaper copy* inside our own layer. Unlike the shell's live backdrop blur,
    // this never reads the screen behind the panel, so it cannot feed back and corrupt itself.
    _setBlur(info) {
        if (!this._blurBox)
            return false;
        this._blurBox.clear_effects();
        this._blurEffect = null;
        this._maskEffect = null;

        if (!info || !this._wall) {
            this._blurBox.visible = false;
            return false;
        }

        // Effects added first sit outermost, so the rounded mask is applied to the blurred result.
        try {
            this._maskEffect = new RoundedMaskEffect();
            this._blurBox.add_effect(this._maskEffect);
        } catch (e) {
            console.warn(`notch-island: rounded mask unavailable: ${e.message}`);
            this._maskEffect = null;
        }

        const attempts = [
            {mode: Shell.BlurMode.ACTOR, sigma: info.sigma, brightness: info.brightness},
            {mode: Shell.BlurMode.ACTOR, radius: info.sigma * 2, brightness: info.brightness},
        ];
        let lastError = null;
        for (const props of attempts) {
            try {
                const effect = new Shell.BlurEffect(props);
                this._blurBox.add_effect(effect);
                this._blurEffect = effect;
                break;
            } catch (e) {
                lastError = e;
            }
        }

        if (!this._blurEffect) {
            console.warn(`notch-island: blur could not be enabled: ${lastError?.message}`);
            this._blurBox.clear_effects();
            this._maskEffect = null;
            this._blurBox.visible = false;
            return false;
        }

        this._blurBox.visible = true;
        this._syncBlurBox();
        return true;
    }

    _syncBlurBox() {
        if (!this._panel || !this._blurBox)
            return;
        const box = this._panel.get_allocation_box();
        const w = box.get_width();
        const h = box.get_height();
        if (w <= 0 || h <= 0)
            return;
        this._blurBox.set_size(w, h);
        if (this._maskEffect)
            this._maskEffect.setGeometry(w, h, this._cfg.cornerRadius);
    }

    // Background colour of the active shell theme (follows user-theme extensions)
    _themeBackground() {
        const candidates = [];
        try {
            const box = Main.panel?.statusArea?.quickSettings?.menu?.box;
            if (box)
                candidates.push(box);
        } catch (e) { /* ignore */ }
        if (this._probe)
            candidates.push(this._probe);

        for (const actor of candidates) {
            try {
                const c = actor.get_theme_node().get_background_color();
                if (c.alpha > 20)
                    return [c.red, c.green, c.blue, 255];
            } catch (e) { /* try next */ }
        }
        return [36, 36, 36, 255];
    }

    _applyTheme() {
        if (!this._panel)
            return;

        const blurOk = this._setBlur(this._blurInfo());

        let bg;
        let fg;
        if (this._cfg.background === 'black') {
            bg = [0, 0, 0, 255];
            fg = '#ffffff';
        } else {
            bg = this._themeBackground();
            const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
            fg = lum > 140 ? '#1e1e1e' : '#ffffff';
        }
        // With blur, this is a tint over the blurred wallpaper; without it, plain translucency.
        bg[3] = Math.round(255 * (blurOk ? this._cfg.blurOpacity : this._cfg.panelOpacity));

        this._panel.set_style(
            `background-color: rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${(bg[3] / 255).toFixed(2)}); ` +
            `color: ${fg}; border-radius: ${this._cfg.cornerRadius}px;`);

        this._readAccent();
        this._renderCalendar();
        this._syncBlurBox();
    }

    _connectTheme() {
        const reapply = () => this._applyTheme();
        try {
            const ctx = St.ThemeContext.get_for_stage(global.stage);
            this._themeSignals.push([ctx, ctx.connect('changed', reapply)]);
        } catch (e) { /* ignore */ }

        for (const key of ['accent-color', 'color-scheme', 'gtk-theme']) {
            try {
                this._themeSignals.push([this._iface, this._iface.connect(`changed::${key}`, reapply)]);
            } catch (e) { /* key missing on this GNOME version */ }
        }

        try {
            const mgr = Main.extensionManager;
            this._themeSignals.push([mgr, mgr.connect('extension-state-changed', reapply)]);
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------ Hover / animation

    _onHoverChanged() {
        if (!this._zone || !this._root)
            return;
        const hovering = this._zone.hover || this._root.hover;

        if (hovering) {
            if (this._hideTimer) {
                GLib.source_remove(this._hideTimer);
                this._hideTimer = 0;
            }
            if (!this._open && !this._openTimer) {
                this._openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_DELAY_MS, () => {
                    this._openTimer = 0;
                    if (this._zone && this._root && (this._zone.hover || this._root.hover))
                        this._show();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            if (this._openTimer) {
                GLib.source_remove(this._openTimer);
                this._openTimer = 0;
            }
            if (this._open && !this._hideTimer) {
                this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
                    this._hideTimer = 0;
                    if (this._zone && this._root && !this._zone.hover && !this._root.hover)
                        this._hide();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _show() {
        if (this._open)
            return;
        this._open = true;

        const now = GLib.DateTime.new_now_local();
        this._viewYear = now.get_year();
        this._viewMonth = now.get_month();
        this._renderCalendar();
        this._refreshNotifications();
        this._updateClock();

        this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });

        this._root.remove_all_transitions();
        this._root.show();
        this._syncBlurBox();
        const [, height] = this._root.get_preferred_height(-1);
        this._root.translation_y = -height;
        this._root.ease({
            translation_y: 0,
            duration: 240,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _hide() {
        if (!this._open || !this._root)
            return;
        this._open = false;

        if (this._clockTimer) {
            GLib.source_remove(this._clockTimer);
            this._clockTimer = 0;
        }

        const [, height] = this._root.get_preferred_height(-1);
        this._root.remove_all_transitions();
        this._root.ease({
            translation_y: -height,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                if (this._root && !this._open)
                    this._root.hide();
            },
        });
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        this._clockLabel.text = now.format(this._cfg.clock24h ? '%H:%M' : '%-I:%M %p');
        this._dateLabel.text = now.format('%a, %b %-d');
    }

    // --------------------------------------------------------------- Calendar

    _shiftMonth(delta) {
        let m = this._viewMonth + delta;
        let y = this._viewYear;
        if (m < 1) { m = 12; y--; }
        if (m > 12) { m = 1; y++; }
        this._viewMonth = m;
        this._viewYear = y;
        this._renderCalendar();
    }

    _renderCalendar() {
        if (!this._grid)
            return;
        this._grid.destroy_all_children();

        const y = this._viewYear;
        const m = this._viewMonth;
        const first = GLib.DateTime.new_local(y, m, 1, 0, 0, 0);
        const daysInMonth = first.add_months(1).add_days(-1).get_day_of_month();
        this._monthLabel.text = first.format('%B %Y');

        const dowSun0 = first.get_day_of_week() % 7;   // Sunday = 0
        const offset = this._cfg.monday ? (dowSun0 + 6) % 7 : dowSun0;

        const names = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        for (let i = 0; i < 7; i++) {
            const idx = this._cfg.monday ? (i + 1) % 7 : i;
            this._gridLayout.attach(
                new St.Label({text: names[idx], style_class: 'notch-weekday'}), i, 0, 1, 1);
        }

        const now = GLib.DateTime.new_now_local();
        for (let d = 1; d <= daysInMonth; d++) {
            const idx = offset + d - 1;
            const isToday = now.get_year() === y && now.get_month() === m &&
                now.get_day_of_month() === d;

            const btn = new St.Button({
                label: String(d),
                style_class: 'notch-day',
                reactive: true,
                can_focus: true,
            });
            if (isToday) {
                btn.add_style_class_name('notch-today');
                btn.set_style(`background-color: ${this._accent}; color: #ffffff;`);
            }
            btn.connect('clicked', () => this._openDay(y, m, d));
            this._gridLayout.attach(btn, idx % 7, 1 + Math.floor(idx / 7), 1, 1);
        }
    }

    _openDay(y, m, d) {
        const pad = v => String(v).padStart(2, '0');
        const iso = `${y}-${pad(m)}-${pad(d)}`;
        try {
            Util.spawn(CALENDAR_COMMAND.map(a => a.replace('{date}', iso)));
        } catch (e) {
            console.error(`notch-island: could not open calendar: ${e.message}`);
        }
        this._hide();
    }

    // ---------------------------------------------------------- Notifications

    _connectNotifications() {
        const tray = Main.messageTray;
        this._trayIds.push(tray.connect('source-added', (_t, source) => {
            this._watchSource(source);
            this._refreshNotifications();
        }));
        this._trayIds.push(tray.connect('source-removed', (_t, source) => {
            this._unwatchSource(source);
            this._refreshNotifications();
        }));
        for (const source of tray.getSources())
            this._watchSource(source);
    }

    _watchSource(source) {
        if (this._sourceSignals.has(source))
            return;
        const ids = [];
        for (const sig of ['notification-added', 'notification-removed']) {
            try {
                ids.push(source.connect(sig, () => this._refreshNotifications()));
            } catch (e) { /* signal missing on this version */ }
        }
        this._sourceSignals.set(source, ids);
    }

    _unwatchSource(source) {
        const ids = this._sourceSignals.get(source);
        if (!ids)
            return;
        for (const id of ids) {
            try { source.disconnect(id); } catch (e) { /* disposed */ }
        }
        this._sourceSignals.delete(source);
    }

    _collectNotifications() {
        const items = [];
        for (const source of Main.messageTray.getSources()) {
            let list = [];
            try { list = source.notifications ?? []; } catch (e) { /* ignore */ }
            for (const n of list)
                items.push({source, n});
        }
        const stamp = n => {
            try { return n.datetime.to_unix(); } catch (e) { return 0; }
        };
        items.sort((a, b) => stamp(b.n) - stamp(a.n));
        return items;
    }

    _refreshNotifications() {
        if (!this._notifBox)
            return;
        this._notifBox.destroy_all_children();

        const items = this._collectNotifications();
        if (items.length === 0) {
            this._notifBox.add_child(new St.Label({
                text: 'No notifications',
                style_class: 'notch-empty',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }
        for (const {source, n} of items)
            this._notifBox.add_child(this._buildNotifRow(source, n));
    }

    _buildNotifRow(source, n) {
        const strip = s => (s ?? '').toString().replace(/<[^>]*>/g, '');

        const row = new St.Button({
            style_class: 'notch-notif',
            reactive: true,
            can_focus: true,
            x_expand: true,
        });
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        row.set_child(box);

        let appName = '';
        try { appName = source.title ?? ''; } catch (e) { /* ignore */ }
        let when = '';
        try { when = n.datetime.format(this._cfg.clock24h ? '%H:%M' : '%-I:%M %p'); } catch (e) { /* ignore */ }

        const top = new St.BoxLayout();
        top.add_child(new St.Label({
            text: `${strip(appName)}${when ? '  ·  ' + when : ''}`.toUpperCase(),
            style_class: 'notch-notif-app',
            x_expand: true,
        }));
        const close = new St.Button({label: '✕', style_class: 'notch-notif-close', reactive: true});
        close.connect('clicked', () => {
            try { n.destroy(); } catch (e) { /* ignore */ }
            this._refreshNotifications();
        });
        top.add_child(close);
        box.add_child(top);

        const title = new St.Label({text: strip(n.title), style_class: 'notch-notif-head'});
        title.clutter_text.set({ellipsize: Pango.EllipsizeMode.END});
        box.add_child(title);

        let body = strip(n.body);
        if (body.length > 160)
            body = body.slice(0, 157) + '…';
        if (body) {
            const bodyLbl = new St.Label({text: body, style_class: 'notch-notif-body'});
            bodyLbl.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.END});
            box.add_child(bodyLbl);
        }

        row.connect('clicked', () => {
            try { n.activate(); } catch (e) { /* ignore */ }
            this._hide();
        });
        return row;
    }

    _clearAll() {
        for (const {n} of this._collectNotifications()) {
            try { n.destroy(); } catch (e) { /* ignore */ }
        }
        this._refreshNotifications();
    }
}
