import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NotchIslandPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;   // keep a reference alive

        const page = new Adw.PreferencesPage({
            title: 'Notch Island',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const switchRow = (group, title, subtitle, key) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const comboRow = (group, title, subtitle, key, items) => {
            const row = new Adw.ComboRow({
                title,
                subtitle,
                model: Gtk.StringList.new(items.map(i => i[1])),
            });
            const current = settings.get_string(key);
            row.selected = Math.max(0, items.findIndex(i => i[0] === current));
            row.connect('notify::selected', () => {
                settings.set_string(key, items[row.selected][0]);
            });
            group.add(row);
        };

        const spinRow = (group, title, subtitle, key, lower, upper, step, digits, isInt) => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                digits,
                adjustment: new Gtk.Adjustment({
                    lower,
                    upper,
                    step_increment: step,
                    page_increment: step * 5,
                    value: isInt ? settings.get_int(key) : settings.get_double(key),
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        // ---- Appearance
        const look = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Colours always follow your GNOME accent colour.',
        });
        page.add(look);

        comboRow(look, 'Background',
            'Follow the shell theme, or use solid black to blend with the notch.',
            'background-style', [['theme', 'Follow shell theme'], ['black', 'Solid black']]);

        comboRow(look, 'Blur',
            'Blurs a copy of your wallpaper behind the panel. Automatic only blurs when Blur my Shell is active and copies its settings; choose On to force it.',
            'blur-style', [['on', 'On'], ['auto', 'Automatic'], ['off', 'Off']]);

        spinRow(look, 'Blur strength',
            'Used when Blur is set to On.', 'blur-sigma', 1, 60, 1, 0, true);
        spinRow(look, 'Blur brightness',
            'Used when Blur is set to On. Lower is darker.', 'blur-brightness', 0.1, 1.0, 0.05, 2, false);
        spinRow(look, 'Tint opacity over the blur',
            'Opacity of the theme-coloured tint over the blurred wallpaper.',
            'blur-opacity', 0.2, 1.0, 0.05, 2, false);
        spinRow(look, 'Panel opacity without blur',
            'Lower values let the wallpaper show through.',
            'panel-opacity', 0.5, 1.0, 0.02, 2, false);
        spinRow(look, 'Corner radius',
            'Roundness of all four corners. 0 = square.', 'corner-radius', 0, 40, 1, 0, true);

        // ---- Top bar
        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        switchRow(bar, 'Hide the built-in date and time',
            'Hides the clock in the centre of the top bar while this extension is enabled.',
            'hide-system-clock');

        // ---- Calendar
        const cal = new Adw.PreferencesGroup({title: 'Calendar and clock'});
        page.add(cal);
        switchRow(cal, 'Week starts on Monday', null, 'week-starts-monday');
        switchRow(cal, '24-hour time', null, 'clock-24h');

        // ---- Notch
        const notch = new Adw.PreferencesGroup({
            title: 'Notch size',
            description: 'Detected automatically. If the gap does not line up with your notch, enter the size in logical pixels. 0 means automatic.',
        });
        page.add(notch);
        spinRow(notch, 'Notch width', null, 'notch-width', 0, 800, 5, 0, true);
        spinRow(notch, 'Notch height', null, 'notch-height', 0, 200, 1, 0, true);
    }
}
