---
name: cua-gui-automation
description: Perform owner-authorized GUI automation through a locally installed CUA client, using screenshot, action, and verification loops.
---

# CUA GUI automation in Ox

Use this skill only when the local `cua` command is installed and the owner has
selected an authorized CUA Space or desktop target. Before any action, inspect
the target and describe the intended effect. Use short observe → act → verify
cycles; do not infer success from a click or command exit alone.

Never disclose screen contents, use another person's session, bypass a login,
or complete consequential actions without the approval policy that applies in
Ox. If CUA is unavailable, report that fact and offer an Ox-native supported
path instead.

This is an Ox-owned safe adaptation of the upstream CUA GUI-automation
guidance. Install CUA only from the verified upstream project instructions; do
not pipe a remote installer directly into a shell.
