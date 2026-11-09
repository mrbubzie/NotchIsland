# Notch Island v1.1 — GNOME 50 Compatibility & Rounded Corners

Notch Island v1.1 updates the GNOME Shell extension for GNOME 50 and improves the blurred panel's rounded-corner handling.

### What's changed
- GNOME Shell 50 compatibility metadata and guards for changed Shell interfaces.
- Corrected blur/mask effect ordering to address square corners.
- Graceful fallback if the legacy rounded mask cannot run.
- New About page displaying **Version 1.1** and **Developer: Ryan**.
- Updated GitHub source and installation documentation.

### Installation
```bash
gnome-extensions install --force notch-island-v1.1-gnome50.zip
```
Log out and back in on Wayland, then run:
```bash
gnome-extensions enable notch-island@local
```

### Known limitations
GNOME 50 runtime compatibility and rounded blur are not yet verified on a live GNOME 50 session. On systems where the legacy mask is unavailable, blur is disabled to avoid square corners.
