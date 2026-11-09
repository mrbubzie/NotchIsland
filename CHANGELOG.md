# Changelog

## 1.1 — GNOME Shell 50 update

- Declared GNOME Shell 50 support and retained the existing extension UUID.
- Added compatibility guards for changes in notification source access.
- Adjusted blur and rounded-mask effect ordering to address square corners when blur is enabled.
- Added a fallback that disables blur when the legacy mask is unavailable, rather than showing square blur corners.
- Added an About preferences page showing version **1.1** and developer **Ryan**.
- Updated installation and project documentation.

**Testing:** JavaScript syntax and packaging can be checked independently; GNOME 50 runtime behavior and blur masking still require testing on a GNOME 50 desktop.
