# ox mesh over radio: the architecture

October 19, 2026. The owner's brief: every machine has antennas; when there is
no internet, ox's multi-machine control must keep working over radio, with
open-source models as the fallback brain and everything under the owner's
control. This builds on `docs/MESH_DESIGN.md` (the mesh as it is) and
`docs/MESH_OFFLINE.md` (the first plan); sources are listed at the end.

## 1. The goal in one line

Any of the owner's machines can see, ask and direct the others, and think with
open models, whether the link between them is the internet, a router with no
internet, a cable, the machines' own Wi-Fi radios, Bluetooth, long-range Wi-Fi
or a LoRa radio a few kilometres away, and the owner never has to know which.

## 2. Principles (each one from the research)

| Principle | Source | What it means for ox |
|---|---|---|
| Design for "challenged" networks: links come and go, delays are long, nothing is end-to-end reliable | Fall, SIGCOMM 2003; RFC 9171 (Bundle Protocol v7) | Every message is a self-contained, signed, encrypted bundle with a lifetime; it can wait in a machine and be carried forward when a link appears |
| The data lives on the devices; sync, not servers | Kleppmann et al., "Local-first software", Onward! 2019 | Task board, org, skills, settings and the audit log are replicated CRDTs; every machine works alone and merges later |
| Encryption lives in the message, not the link | Noise Protocol Framework (Perrin); Yggdrasil; Reticulum | A radio is a dumb pipe; it never adds or removes permissions |
| Failure is a degree, not a timeout | φ-accrual detector (Hayashibara et al. 2004); SWIM (Das, Gupta, Motivala, DSN 2002) | Each link to each machine has a health score; membership spreads by gossip, so the cost does not grow with the number of machines |
| Match the message to the pipe | LoRaWAN limits (Adelantado et al., IEEE Comm. Mag. 2017) | Three classes: control (under 200 bytes), interactive (KB), bulk (MB+); slow links carry control only |
| Use open, readable implementations | OWL/OpenDrop (Stute et al.), Briar/Bramble, Meshtastic, Reticulum, Yggdrasil, exo, llama.cpp | ox reuses open protocols and code where licences allow, and says which |

## 3. The layers

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │ L6  Control and safety   grants · approvals · audit · lockdown        │
 ├────────────────────────────────────────────────────────────────────────┤
 │ L5  The brain offline    llama.cpp / Ollama per machine · exo or       │
 │                          llama.cpp RPC across machines · whisper.cpp · │
 │                          Piper/Kokoro · models shared peer to peer     │
 ├────────────────────────────────────────────────────────────────────────┤
 │ L4  Shared state         CRDT documents (board, org, skills, audit) ·  │
 │                          content-addressed files and models            │
 ├────────────────────────────────────────────────────────────────────────┤
 │ L3  ox mesh core         Ed25519 identities (pinned) · Noise-style     │
 │                          sessions · bundles (lifetime, priority,       │
 │                          custody) · SWIM + φ-accrual · replay counters │
 ├────────────────────────────────────────────────────────────────────────┤
 │ L2  Overlay routing      IP links: Yggdrasil (or Babel/batman-adv)     │
 │                          Slow links: Reticulum (LXMF-style transfer)   │
 ├────────────────────────────────────────────────────────────────────────┤
 │ L1  Link adapters        one small adapter per link: discover · send · │
 │                          MTU · rate · cost · health                    │
 ├────────────────────────────────────────────────────────────────────────┤
 │ L0  Radios and wires     Ethernet/Thunderbolt · Wi-Fi LAN · AWDL ·     │
 │                          ad hoc/802.11s · Wi-Fi HaLow · BLE · LoRa     │
 └────────────────────────────────────────────────────────────────────────┘
```

### L0: the links

| Link | Hardware | Range | Throughput | Notes |
|---|---|---|---|---|
| Ethernet / Thunderbolt Bridge / USB-C | a cable | metres | 1–40 Gb/s | works today with ox mesh (link-local) |
| Wi-Fi LAN, router with no internet, phone hotspot with no data | a router or phone | building | 100+ Mb/s | works today |
| Apple peer-to-peer Wi-Fi (AWDL) | every Mac, iPhone, iPad | ~a room to tens of metres | tens of MB/s | macOS: Network.framework with `includePeerToPeer`; Linux: OWL, an open AWDL implementation (Stute et al.), used by OpenDrop |
| Wi-Fi Aware (NAN) | iPhone/iPad on iOS 26 | tens of metres | high | not on macOS (Apple DTS, Developer Forums); the phone becomes a controller |
| Ad hoc Wi-Fi / 802.11s mesh | most Wi-Fi cards (macOS: legacy "Create Network"; Linux: 802.11s) | tens of metres per hop | high | multi-hop with batman-adv or Babel; no encryption of its own (batman-adv) |
| Wi-Fi HaLow (802.11ah) | a sub-GHz adapter (e.g. Morse Micro based) | 1–3 km typical; 15.9 km in a vendor test | up to 32.5 Mb/s; 2 Mb/s at 15.9 km | licence-free sub-GHz bands, which vary by region |
| Bluetooth LE (L2CAP channels) | every Mac | 10–30 m | about 36–100 KB/s measured by developers | control and interactive only |
| LoRa (Meshtastic node or RNode) | a USB/BLE radio, about $25–40 each | 2–10 km open ground; multi-hop | 0.25–27 kb/s, duty-cycle limited | control only; AES-256-CTR per channel (Meshtastic) or Reticulum's own encryption |

### L1: link adapters

Each link is one small adapter with the same five calls: `discover()` (who is
reachable, as rotating tokens, never raw ids), `send(frame)`, `mtu`, `rate`
(measured), `cost` (battery, duty cycle, money). The adapters for cable and
Wi-Fi LAN exist (ox mesh uses TCP + a UDP announcement). The new adapters:
AWDL (a Swift helper inside OX Island, which already holds the right macOS
permissions with its stable signature), BLE (CoreBluetooth L2CAP, same
helper), HaLow (just IP once the adapter is up), LoRa (a Meshtastic or RNode
radio over USB serial).

### L2: overlay routing

- **IP-capable links** (cable, LAN, AWDL, ad hoc, HaLow): run the mesh over
  **Yggdrasil**, an end-to-end encrypted IPv6 overlay with key-derived
  addresses and spanning-tree greedy routing, peering over TCP/TLS on LANs and
  point-to-point links. ox's own sessions still encrypt inside it, so a bug in
  one layer does not expose anything. Alternatives with the same role:
  **Babel** (RFC 8966) or **batman-adv** (layer 2, adapts in a couple of
  seconds, no encryption of its own) for a multi-hop Wi-Fi mesh.
- **Slow links** (LoRa, serial, packet radio): **Reticulum**, a non-IP,
  self-configuring, encrypted, multi-hop stack built for exactly these links,
  with RNode as its open LoRa radio. Its licence is its own ("Reticulum
  License", with restrictions), so ox talks to it as a separate program
  rather than copying its code.

### L3: the ox mesh core (what ox adds)

- **Identity and sessions:** unchanged from ox mesh (Ed25519 keys pinned at
  pairing; X25519 + AES-256-GCM per session, signed by both sides; one-time
  pairing codes; a PAKE such as SPAKE2 is the upgrade path).
- **Bundles:** every message is a bundle (after RFC 9171): source, destination,
  creation time, lifetime, priority class, a counter for replay protection,
  the sealed payload. Encoded as CBOR. A control bundle fits one LoRa packet
  (under 200 bytes after sealing).
- **Store, carry, forward:** a machine keeps bundles for an unreachable peer
  until they expire, and hands them to any paired machine that can reach it
  (a relay cannot read them). Like Briar's Bramble sync and Briar Mailbox,
  but between the owner's own machines.
- **Membership and health:** SWIM-style gossip of who is up; φ-accrual per
  link; the router sends each bundle on the best healthy link that can carry
  its class and fails over without the owner noticing (the island says
  "Studio Mac reached over Bluetooth: control only").
- **Privacy on air:** beacons carry a token that changes every 15 minutes,
  derived from a key only paired machines share, so a stranger cannot follow
  a laptop by its signal (the weakness Stute et al. showed in AWDL and AirDrop).

### L4: shared state

- **CRDT documents** (Automerge-style) for the task board, org chart, skills
  index, settings and the audit log: each machine edits offline and merges on
  contact, with no server and no conflicts to resolve by hand.
- **Content-addressed files:** files, models and media move as hashed chunks;
  a chunk any machine has can be fetched from it, so a 4 GB model copied to
  one machine over a cable reaches the rest over AWDL without the internet.

### L5: the brain with no internet

| Need | Open-source choice | Where it runs |
|---|---|---|
| Tool calls, routing, short answers | a small instruct model (Qwen2.5 3B/7B, Llama 3.2 3B class) through llama.cpp / Ollama | every machine (ox already runs `ox-ollama:qwen2.5:3b`) |
| Bigger reasoning | the same model family at 14–32B split across machines: **exo** (peer-to-peer, automatic discovery, splits by topology; Apache-2.0 per its listing) or **llama.cpp RPC** (mainline; proof-of-concept, trusted networks only) | across the Macs, over cable, LAN or AWDL; never over LoRa or BLE |
| Speech in | whisper.cpp (already in ox) | every machine |
| Speech out | Kokoro / Piper (already in ox) | every machine |
| Knowledge | local RAG over the owner's files and the ox Library | every machine |

The router picks per request: the local small model when it is good enough,
a bigger split model when the machines are close, and a cloud model only when
the internet is there and the owner allows it. Over a slow link only
decisions travel ("run task 12", "approve", "stop"); the thinking happens on
the machine that does the work.

### L6: control and safety

Grants (viewer / helper / full), approvals, the audit log and `ox mesh
lockdown` stay exactly as they are. A link never adds a permission. Actions
that pay, send or delete still need the owner's OK, and that OK can travel
over any link, including LoRa, because it is a few bytes.

## 4. What travels where

| Class | Example | LoRa | BLE | AWDL / HaLow / LAN / cable |
|---|---|---|---|---|
| control (≤ 200 B) | status, stop, approve, "run task 12", an alert | ✓ | ✓ | ✓ |
| interactive (KB) | a reply, a log tail, a diff summary | ✗ | ✓ | ✓ |
| bulk (MB+) | files, models, screenshots, model streams | ✗ | ✗ | ✓ |

## 5. Four situations, walked through

1. **Router up, internet down.** Nothing changes: ox mesh already works on the
   LAN; local models answer.
2. **Two Macs, no network at all, same room.** AWDL comes up through the
   island's helper; the full mesh runs over it (files, models, split
   inference).
3. **Macs in different rooms, Wi-Fi off.** BLE carries control and short
   replies; anything bulky waits in the queue for a better link.
4. **Machines kilometres apart.** HaLow carries everything at a few Mb/s;
   without it, LoRa carries control only (status, stop, approve), and each
   machine thinks with its own model.

## 6. Rules that are not ox's to bend

- **Amateur (ham) bands forbid encryption that hides meaning** (US 47 CFR
  §97.113(a)(4); ITU RR 25.2A). ox never uses ham bands for its encrypted
  control; LoRa and HaLow run in licence-free ISM bands instead.
- **ISM limits:** each region sets its own bands, power and duty cycle (e.g.
  1 % on EU 868 MHz); the LoRa adapter reads the radio's region and keeps to it.
- **Meshtastic's default channel uses a publicly known key**; ox always sets
  its own channel key and never bridges to MQTT unencrypted.

## 7. How it gets built (each step proven before the next)

| Phase | What | Proof |
|---|---|---|
| 1 | Bundles, priority classes, store-and-forward and CRDT state on the existing TCP mesh | two machines, router unplugged mid-task: nothing lost, merges clean |
| 2 | AWDL adapter in OX Island (Swift helper) | two Macs, no network joined: pair, describe, pull a file |
| 3 | BLE adapter | Wi-Fi off: status, approvals, stop arrive; a big pull waits |
| 4 | Health, failover, rotating beacons | kill Wi-Fi mid-transfer: control continues on BLE; bulk resumes |
| 5 | Offline brain: model sharing and split inference (exo or llama.cpp RPC) | a model copied to one Mac reaches the other over AWDL; a 14B model answers across two Macs |
| 6 | Yggdrasil overlay for multi-hop IP; HaLow adapter (hardware) | three machines, A reaches C through B |
| 7 | LoRa adapter (Meshtastic or Reticulum/RNode; hardware) | two radios a few hundred metres apart: status and stop round trip within the duty cycle |

Phases 1–5 need no new hardware. Phases 6–7 need the owner's choice of radios
(HaLow adapters; a pair of LoRa nodes, about $50–80).

## 8. Sources

**Papers and standards**
- K. Fall, "A Delay-Tolerant Network Architecture for Challenged Internets", ACM SIGCOMM 2003. https://www2.cs.arizona.edu/classes/cs525/papers/DTN.pdf
- S. Burleigh, K. Fall, E. Birrane, RFC 9171, Bundle Protocol Version 7, 2022. https://www.rfc-editor.org/rfc/rfc9171.html
- S. Burleigh et al., "Delay-tolerant networking: an approach to interplanetary Internet", IEEE Communications Magazine 2003. https://resilinets.org/bib_burleigh_hooke_torgerson_fall_cerf_durst_scott_weiss_20031.html
- M. Kleppmann, A. Wiggins, P. van Hardenberg, M. McGranaghan, "Local-first software: you own your data, in spite of the cloud", Onward! 2019. https://martin.kleppmann.com/2019/10/23/local-first-at-onward.html
- A. Das, I. Gupta, A. Motivala, "SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol", DSN 2002. https://courses.grainger.illinois.edu/cs425/fa2022/dsn02-SWIM.pdf
- N. Hayashibara et al., "The φ Accrual Failure Detector", 2004 (already the basis of ox mesh's detector).
- T. Perrin, The Noise Protocol Framework. https://github.com/noiseprotocol/noise_spec
- F. Adelantado et al., "Understanding the Limits of LoRaWAN", IEEE Communications Magazine 55(9), 2017. https://ar5iv.arxiv.org/html/1607.08011
- M. Stute et al., "A Billion Open Interfaces for Eve and Mallory: MitM, DoS, and Tracking Attacks on iOS and macOS Through Apple Wireless Direct Link", USENIX Security 2019; and the OWL project. https://github.com/seemoo-lab/owl
- J. Chroboczek, D. Schinazi, RFC 8966, The Babel Routing Protocol, 2021.
- 47 CFR §97.113(a)(4) (no codes or ciphers that obscure meaning on amateur bands); ARRL comments on RM-11699. https://arrl.org/files/file/FCC%20Documents/Comments%20RM-11699%20FINAL%20Version%202.pdf

**Projects (licences as found; check each LICENSE before taking code)**
- OWL (open AWDL) and OpenDrop (GPL-3.0). https://github.com/seemoo-lab/opendrop/
- Briar / Bramble: Bluetooth, Wi-Fi and Tor sync for delay-tolerant networks; Briar Mailbox. https://en.wikipedia.org/wiki/Briar_(software)
- Meshtastic (firmware GPL-3.0; AES-256-CTR channels). https://meshtastic.org/docs/overview/encryption
- Reticulum, LXMF, RNode, Sideband (Reticulum License). https://github.com/markqvist/Reticulum
- Yggdrasil (encrypted IPv6 mesh). https://yggdrasil.link
- batman-adv on OpenWrt. https://openwrt.org/docs/guide-user/network/wifi/mesh/batman
- exo (peer-to-peer distributed inference). https://github.com/exo-explore/exo
- llama.cpp RPC backend. https://github.com/ggml-org/llama.cpp/pull/16441/files
- Wi-Fi HaLow 15.9 km test (Morse Micro). https://www.eenewseurope.com/en/halow-hits-record-16km-wifi-distance-at-900mhz

**Books**
- S. Farrell, V. Cahill, *Delay- and Disruption-Tolerant Networking*, Artech House, 2006.
- I. F. Akyildiz, X. Wang, *Wireless Mesh Networks*, Wiley, 2009.
- M. Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017 (replication, consistency, CRDTs).
- C. S. R. Murthy, B. S. Manoj, *Ad Hoc Wireless Networks: Architectures and Protocols*, Prentice Hall, 2004.
