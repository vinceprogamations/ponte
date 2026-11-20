# Private chat and calls Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. User authorized complete execution without another planning approval.

**Goal:** Restrict existing history, a chat and a call to two approved devices while preserving public calls and existing media quality.

**Architecture:** Separate pinned TLS transport for private control/chat/files, an authorization-aware networking facade, and physically separated public/private stores with a legacy archive. WebRTC capture, codecs, bitrate, resolution and audio processing remain unchanged.

**Tech Stack:** Electron, Node TLS 1.3, selfsigned certificate generation, existing vanilla renderer and WebRTC.

**Spec:** ../specs/2026-11-20-private-chat-and-calls-design.md

## Global Constraints

- No accounts or server; no embedded secrets or automatic messaging of invites.
- Existing history is private, backed up before networking and never sent through the public protocol.
- Private enrollment requires creator approval and pinned device identity.
- Screen/audio quality and capture settings are preserved.

## Review Focus

- Claimed LAN UUIDs cannot replace authenticated private sockets.
- Public packet references/collisions cannot publish private messages or attachments.
- Old clients and old state packets cannot reintroduce historical data.
- Reconnect/revocation and delayed signaling cannot carry media between rooms.
- File queue and history limits cannot silently lose or expose archived content.

### Task 1: Private storage and migration

Files: src/main/scoped-chat.js; src/main/chat.js; test/privacy.test.js.

Produces: ScopedChatStore with current ChatStore API plus isPrivateChannel(id), isPrivateMessage(id), canAccessFile(id, privateTransport), activatePrivate(), listChannels().

- [x] Write/run failing Node tests for legacy quarantine, activation, archive preservation, namespaces and file classification.
- [x] Implement separate stores, versioned migration marker and archive; private fixed rooms.
- [x] Verify migration idempotence, collision rejection, complete archive and whole suite.

### Task 2: Device enrollment and private TLS transport

Files: src/main/private-link.js; test/private-link.test.js; package.json.

Produces: PrivateLink EventEmitter, start/stop, createInvite(host), acceptInvite(code), approve(fingerprint), revoke(), status(), send/sendWait/broadcast, listPeers, setState.

- [x] Write/run failing real TLS tests for enrollment, required approval, pinned reconnect, third-device exclusion and revocation.
- [x] Implement protected identity persistence, short-lived single-use invites, connection-bound pins and bounded framing.
- [x] Verify actual TLS peers, malformed input and restart behavior.

### Task 3: Enforce routing throughout chat, files and calls

Files: src/main/privacy-network.js; src/main/main.js; src/main/media.js; src/main/lan.js; test/privacy-network.test.js.

Consumes: Tasks 1 and 2; produces facade matching LanNode API with scoped send/receive, scoped peer state and call session validation.

- [x] Write/run failing three-device tests for history/messages/files/state/signaling and forged IDs.
- [x] Route public packets through a new versioned envelope; never import legacy app packets. Route private content exclusively through pinned TLS. Authorize files at dispatch and every queued chunk.
- [x] Gate IPC, channel edits and voice transitions, validate session-tagged SDP/ICE and disconnect old room connections.
- [x] Run complete Node suite and compare media configuration against original source.

### Task 4: Pairing UI and end-to-end verification

Files: src/main/preload.js; src/renderer/privacy.js; src/renderer/app.js; src/renderer/index.html; README.md.

- [x] Add labeled settings controls for create/copy/accept invitation, approve device and revoke. No private keys exposed.
- [x] Reflect private membership and secure peer availability; close private calls on access loss; preserve screen/audio capture pipeline.
- [x] Verify Electron startup, settings and private/public calls with isolated profiles and existing media autotests where supported.
- [x] Obtain independent final review, fix important findings and rerun complete suite. Report distribution/pairing steps without claiming production rollout.

## Execution ledger

- Plan approved through user's instruction to do everything. Execute in current checkout to keep the existing desktop workspace; no commits/push/releases without a separate request.
- Task 1: complete — legacy archive and separate public/private stores; quarantine, idempotence, collision and orphan attachment tests passed. Private history has no truncation at 2,000 messages.
- Task 2: complete — protected device identity, TLS 1.3 with explicit certificate pinning, one-time enrollment plus creator approval, restart/reconnect and revocation tests.
- Task 3: complete — versioned public envelope, private socket-only routing, file ownership checks, public state redaction, call/session-tagged signaling and IPC/protocol gates. Three real network nodes tested.
- Task 4: complete — accessible pairing settings, README, installer 2.2.0. Actual Electron test verified private chat/files, legacy quarantine, interrupted 12 MiB transfer recovery, 1920×1080 capture at 60 fps and 7.2 Mbps, inbound audio/video, third-device exclusion and public-call recovery after revocation.
- Final review: two P2 findings fixed — unchanged history now requests missing attachments after reconnect, and history batches are bounded by UTF-8 byte size. Regression tests passed.
- Additional verification: production dependency audit found zero vulnerabilities. Installer generated after repairing only the Windows build-tool cache extraction (excluded unused macOS symlinks); system permissions unchanged.
- Delivery: keep changes locally on codex/private-chat-calls. Installer not published; installed profiles not migrated or paired by the agent.
- Publication subsequently authorized by the user: commit, fast-forward main, push and tag v2.2.0, with release notes customized and participant-specific addresses removed from public documentation. GitHub Actions now runs the privacy and LAN tests before building the release. Actual device pairing still requires the two participants.
