# Notch Island v1.1 — GNOME 48–51 Compatibility & Rounded Corners

Notch Island v1.1 updates the GNOME Shell extension for GNOME 50 and improves the blurred panel's rounded-corner handling.

### What's changed
- GNOME Shell 48–51 compatibility metadata and guards for changed Shell interfaces.
- Corrected blur/mask effect ordering to address square corners.
- Graceful fallback if the legacy rounded mask cannot run.
- New About page displaying **Version 1.1** and **Developer: Ryan**.
- Updated GitHub source and installation documentation.

### Installation
```bash
gnome-extensions install --force Notch-Island-1.1-GNOME-48-51-Install.zip
```
Log out and back in on Wayland, then run:
```bash
gnome-extensions enable notch-island@local
```

### Known limitations
GNOME 48–51 runtime compatibility and rounded blur are not yet verified on a live GNOME 48–51 sessions. On systems where the legacy mask is unavailable, blur is disabled to avoid square corners.

### Compatibility status
The extension declares GNOME Shell 48–51. JavaScript syntax and package structure can be checked statically, but all four GNOME versions still require runtime testing, particularly blur/mask effects and notification handling.
