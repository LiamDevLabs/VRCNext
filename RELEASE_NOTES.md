# 2026.10.10

## Friends Sidebar

The friends sidebar now has a collapse button to minimize it while maintaining important information such as friend status, your profile and current instance.

## Voice Fight

- Added support for `.wav` files as soundboard playback
  — Added by @LiamDevLabs

## Tool Startup Change

**Before:** Custom Chatbox, Media Relay, Space Flight, Youtube Fix, Voice Fight, Discord Presence, and VR Overlay were all started when VRCNext launches.

This caused unwanted behaviour — for example, launching Space Flight would automatically start SteamVR on desktop, which is not intended.

**Now:** Tools are no longer started on launch by default. Instead, each tool has two new toggle options:

- **Start with VRChat (Desktop)**
- **Start with VRChat (VR)**

## JSON Changes

Favorited images were previously stored inside `settings.json`. They are now stored in a dedicated `favorited_images.json` file.

**No action required** — the migration runs automatically and safely on first launch.

## Changes

- Moved the collapse/hamburger icon to the top of the sidebar for easier access
- Removed the "Beta" badge — VRCNext is now considered stable
