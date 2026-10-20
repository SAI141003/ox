# ox mesh without the internet: a plan

October 18, 2026. The owner's idea: every machine has antennas (Wi-Fi,
Bluetooth). The multi-machine control system should keep working when there
is no internet, by talking machine to machine over radio.

## Where ox mesh stands today

ox mesh never needed the internet to work. Pairing (one-time code),
discovery (a UDP announcement on the local network) and every control message
(TCP, end-to-end encrypted and signed with the machines' pinned keys) go
directly between the machines. With no internet it still works whenever the
machines share **some** network:

- a Wi-Fi router whose internet line is down;
- a phone's personal hotspot (it makes a local network even with no data);
- a cable: Ethernet, or Thunderbolt/USB-C between two Macs (Thunderbolt Bridge).

**The gap:** two machines with no shared network at all (in a field, on a
plane, after a router dies). For that they have to make their own link over
radio. That is this plan.

## What radios a machine actually has

| Link | Hardware | Range | Speed | Good for |
|---|---|---|---|---|
| Apple peer-to-peer Wi-Fi (AWDL, what AirDrop uses) | every Mac's Wi-Fi | a room to ~30 m | tens of MB/s | everything: control, files, model replies |
| Ad hoc Wi-Fi network | every Mac's Wi-Fi (macOS: Wi-Fi › Advanced › "Show legacy networks and options", then Create Network); Linux and Windows too | ~30 m | high | everything, across Mac, Linux and Windows |
| Bluetooth LE (L2CAP channels) | every Mac | ~10–30 m | about 36–100 KB/s measured by developers | control: status, approvals, stop, small files |
| LoRa (Meshtastic or RNode radios) | **not built in**: a USB or Bluetooth radio, about $25–40 each | 2–10 km in the open, more with relays | 0.25–27 kbit/s | tiny control messages only: "status?", "stop", "run task 12", approvals |
| Wi-Fi Aware (NAN) | iPhone and iPad on iOS 26 | ~30 m | high | later: your phone as a controller (Apple has not brought it to macOS) |

## The design: one mesh, many links

ox's encryption already lives in the mesh messages themselves, not in the
link. So every new link is just a pipe that carries the same sealed frames.
Pairing, keys, grants, the audit log and the read-only limits stay exactly as
they are. A radio adds a way to reach a machine, never new permissions.

1. **Links ranked by what they can carry.** Each message has a class:
   *control* (under 200 bytes: status, stop, approve, a task id), *interactive*
   (a few KB: a reply, a log tail), *bulk* (files, model output streams). Each
   link says what it can carry: LoRa only control, Bluetooth up to
   interactive, Wi-Fi, cable and LAN everything.
2. **The best live link wins, per message.** ox keeps a health score for each
   link to each machine (the φ-accrual detector the mesh already uses) and sends
   on the fastest healthy link that can carry the class. If Wi-Fi drops mid-way,
   control falls back to Bluetooth or LoRa, and the island says so ("Studio Mac
   reached over Bluetooth: control only").
3. **Hold and forward.** With no link at all, control messages wait in a small
   queue (with an expiry) and go out when any link comes back.
4. **Relays.** A paired machine can carry sealed frames for two others it can
   both reach (A ↔ B ↔ C). It cannot read them: they stay end-to-end encrypted
   between A and C.

## Safety on radio

- **Nobody can follow your laptop by its signal.** Radio announcements never
  carry the machine's id. They carry a token that changes every 15 minutes,
  derived from a key only paired machines share (the idea Apple uses for Find
  My), so a stranger sees random noise.
- **No replays.** Every frame has a counter; old or repeated frames are dropped.
  This matters most on LoRa, where anyone in range hears every packet.
- **Pairing is still in person.** A radio link can only reach machines that are
  already paired; a code is still needed to add one.
- **Remote control stays as safe as today.** Over any link, the same grants
  apply (status, read-only file listing and pulls, agents' state). Running
  commands or typing on another machine remains off until you decide on it
  separately; radios do not change that.
- **Radio rules.** LoRa runs in licence-free ISM bands, but each region has its
  own band and limits (the EU allows sending only 1 % of the time on 868 MHz).
  ox would read the radio's region setting and keep to its duty cycle.

## How it gets built

| Phase | What | How it is proven | Needs |
|---|---|---|---|
| 1. No internet, shared network | Announce on every interface (Thunderbolt Bridge, Ethernet, hotspot), IPv6 link-local fallback; an "offline" badge on the island | Two Macs, router's internet unplugged; then a Thunderbolt cable only | two unlocked Macs |
| 2. Apple peer-to-peer Wi-Fi | A small Swift helper inside the OX Island app advertises and finds `_oxmesh._tcp` with peer-to-peer on (Network.framework, `includePeerToPeer`) and carries mesh frames over it | Two Macs with Wi-Fi on and **no network joined**: pair, `ox mesh describe`, `ox mesh pull` | two Macs. Apple's forums report that discovery can work while the connection hangs, so this must be tested on real hardware before it is called done |
| 3. Bluetooth | The same helper with CoreBluetooth L2CAP channels; control and interactive classes only | Wi-Fi off on both: status, approvals and stop arrive; a large pull is refused with a clear reason | two Macs |
| 4. Links that switch | Ranking, fallback, the hold-and-forward queue, relays | Kill Wi-Fi mid-task: control continues on Bluetooth; turn it back on: bulk resumes | phases 2–3 |
| 5. LoRa (optional) | A Meshtastic node over USB serial as a control-only link, encrypted the same way, within the region's duty cycle | Two radios a few hundred metres apart: "status?" and "stop" round trip | **two LoRa radios (your purchase, about $50–80 for a pair)** |
| 6. Phone as controller | Wi-Fi Aware from the iPhone app | Approve a run on a Mac from the phone with no network | an iOS app (later) |

Phases 1–4 need no new hardware and no internet. Phase 5 is the only one that
costs money, and it is optional.

## What I need from you

1. When you are back at your Macs, keep two of them unlocked for phases 1–3
   (the radios cannot be tested from a locked screen or one machine).
2. Whether to do phase 5, and if so, which region you are in (it decides
   which LoRa band to buy: 915 MHz in North America).

## Sources

- Apple Developer Forums on Network.framework peer-to-peer (`includePeerToPeer`, AWDL): https://developer.apple.com/forums/thread/718461 and https://developer.apple.com/forums/thread/817831
- Wi-Fi Aware framework (iOS 26, iPadOS 26): https://developer.apple.com/documentation/wifiaware.md; not on macOS Tahoe: https://developer.apple.com/forums/thread/787701
- macOS computer-to-computer networks (legacy option): https://support.apple.com/mr-in/guide/mac-help/mchl98b9beb6/13.0/mac/13.0
- CoreBluetooth L2CAP channels: https://developer.apple.com/documentation/corebluetooth/cbl2capchannel.md; measured throughput: https://developer.apple.com/forums/thread/89644
- Meshtastic and LoRa rates, range, ISM bands: https://hamradio.my/how-meshtastic-works/ and https://lwn.net/Articles/1009782
- Reticulum (an encrypted mesh stack for LoRa and packet radio): https://pypi.org/project/rns/
