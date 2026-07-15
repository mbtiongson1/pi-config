# Termux Voice Automation: Complete STT & TTS Setup Guide

This guide covers installing the Pi Voice STT extension, setting up Termux:API for Text-to-Speech, creating the background control scripts, and mapping them to your phone's hardware buttons.

## Phase 1: Install Core Dependencies (STT & TTS)
Open Termux and run the following command to update your packages and install the required runtimes, audio utilities, and API hooks:

```bash
pkg update && pkg upgrade -y
pkg install nodejs ffmpeg termux-api -y
```
Note: Make sure you have installed both the Termux:API and Termux:Tasker companion apps on your Android device (ideally from F-Droid to match your Termux signature).

## Phase 2: Install Pi & Voice STT Extension
Install Pi Coding Agent globally:
```bash
npm install -g @mariozechner/pi-coding-agent
```
Install the STT extension inside your Pi environment:
```bash
pi install npm:pi-voice-stt
```

## Phase 3: Create the Control Scripts
We will create two scripts inside the specialized termux/tasker directory so external Android apps (like Key Mapper) can call them.

1. Create the Tasker directory:
```bash
mkdir -p ~/.termux/tasker
```

2. Create the STT Trigger Script (`~/.termux/tasker/start_pi_voice.sh`):
```bash
#!/usr/bin/env bash
# Trigger Pi's STT dictation
pi --command "/stt"
```

3. Create the TTS Speak Script (`~/.termux/tasker/speak_summary.sh`):
```bash
#!/usr/bin/env bash
# Speaks the target text through Android TTS
echo "This is your Termux summary output." | termux-tts-speak
```

4. Create the TTS Stop/Interrupt Script (`~/.termux/tasker/stop_speak.sh`):
```bash
#!/usr/bin/env bash
# Instantly silences any running Termux TTS
termux-tts-speak ""
```

5. Make all scripts executable:
```bash
chmod +x ~/.termux/tasker/*.sh
```

## Phase 4: Hardware Button Routing (Key Mapper)
To map physical buttons (like your Lock/Power key or Volume keys) to trigger these scripts:

- **Grant Permission:** Go to Android Settings ➔ Apps ➔ Key Mapper ➔ Permissions ➔ Enable "Run commands in Termux environment".
- **Add Trigger:** Open Key Mapper, tap +, select Record Trigger, and press your hardware button (e.g., double-click Power).
- **Assign Speak Action:** Go to Actions ➔ Add Action ➔ Shortcut ➔ Termux shortcut. Set the target path to: `/data/data/com.termux/files/home/.termux/tasker/speak_summary.sh`.
- **Assign Interrupt Action:** Create a second mapping (e.g., single-press Volume Down) pointing to `/data/data/com.termux/files/home/.termux/tasker/stop_speak.sh`.
