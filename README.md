# Notch Island v1.1

A GNOME Shell extension for notched MacBooks. Hover just below the notch to open a drop-down panel with a calendar, clock, and notifications.

## Features

- Detects supported MacBook notch display dimensions, with manual width and height overrides.
- Opens a calendar and notification panel when hovering below the notch.
- Offers calendar navigation and lets you open a selected date in GNOME Calendar.
- Includes options for the panel background, wallpaper blur, opacity, brightness, and corner radius.
- Can hide the standard GNOME top-bar clock while the extension is enabled.
- Provides settings for Monday/Sunday week starts and 12/24-hour time.
- Includes a preferences window for configuring the extension.

## Source layout

- `extension.js` — GNOME Shell extension implementation.
- `prefs.js` — preferences window.
- `stylesheet.css` — panel and widget styling.
- `metadata.json` — extension metadata.
- `schemas/org.gnome.shell.extensions.notch-island.gschema.xml` — GSettings schema source.

The compiled `gschemas.compiled` file is intentionally not included; it is generated from the XML schema during packaging or installation.

## Install / test

Copy the extension directory to:

```sh
~/.local/share/gnome-shell/extensions/notch-island@local/
```

Compile the settings schema:

```sh
cd ~/.local/share/gnome-shell/extensions/notch-island@local
glib-compile-schemas schemas
```

Then enable it:

```sh
gnome-extensions enable notch-island@local
```

On Wayland, log out and back in to restart GNOME Shell. Check extension status and logs with:

```sh
gnome-extensions info notch-island@local
journalctl --user -b --no-pager | grep -iE 'notch-island|extension.*error'
```

## Compatibility

This release declares GNOME Shell 48–51 compatibility. Full runtime validation on GNOME 50 is still recommended.

## Notes

This project targets GNOME Shell on MacBook displays with a visible notch. Notch detection depends on display dimensions and, where available, Asahi DRM information. Some visual effects may depend on GNOME Shell internals or Blur my Shell being installed.

No license is specified in this source archive. Add a license file only after choosing the license under which you want to publish the project.

## Release information

Version: **1.1**  
Developer: **Ryan**  
Target: **GNOME Shell 48–51**

See [CHANGELOG.md](CHANGELOG.md) for details.
