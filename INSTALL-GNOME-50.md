# Notch Island — GNOME Shell 50

Install the ZIP directly (do not extract first):

```sh
gnome-extensions install --force notch-island-v1.1-gnome50.zip
```

Log out and back in (Wayland), then enable:

```sh
gnome-extensions enable notch-island@local
```

Open settings with `gnome-extensions prefs notch-island@local`.

If the extension does not load, inspect `journalctl --user -b | grep -i notch` and `gnome-extensions info notch-island@local`.

This build updates metadata and guards some changed Shell interfaces. Runtime operation on a GNOME 50 desktop has not been verified. The optional legacy shader mask may be unavailable on newer Mutter builds; the extension handles that case without crashing during module import.
