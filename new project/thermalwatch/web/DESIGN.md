# Dashboard design notes

**Subject.** A triage console for a duty analyst at a national technical / disaster-management
agency. Every shift they face thousands of satellite hot spots and must decide which ones
deserve a phone call. The interface's only job: make "what is this and how sure are we"
readable in about three seconds, and make the reasoning inspectable in about thirty.

**Direction.** Instrument panel, not data-viz showcase. Cool graphite/slate surfaces so the
class colours are the only saturated things on screen. Deliberately avoids the cream +
serif + terracotta look and the near-black + acid-green look; both would fight the map.

**Colour tokens**
- ink `#14202B`, panel `#EFF3F6`, surface `#FFFFFF`, line `#C6D2DC`, muted `#5C6B78`
- interactive accent: survey blue `#12608F`
- classes: industrial fire `#D23B2E`, persistent industrial `#7A3E9D`,
  agricultural `#C8891A`, wildfire `#1E7F5C`, other `#7C8A95`
  (chosen so the two "act now" classes read hot and the routine ones read cool; violet for
  persistent heat borrows the cool end of a thermal-camera ironbow ramp)

**Type.** Public Sans throughout, tabular numerals for every measurement. One family, three
weights. No all-caps labels, no monospace chrome.

**Layout.**
```
desktop                                   mobile
┌──────────┬───────────────────────┐      ┌───────────────┐
│ summary  │                       │      │ summary strip │
│ filters  │         MAP           │      ├───────────────┤
│ legend   │      ┌──────────────┐ │      │      MAP      │
│          │      │ event detail │ │      ├───────────────┤
└──────────┴──────┴──────────────┴─┘      │ detail sheet  │
```
Left rail 320 px, detail panel 380 px overlaying the map's right edge. On narrow screens the
filters collapse behind one button and the detail becomes a bottom sheet at 62 vh.

**The one bold element.** The heat barcode: 365 day-ticks under the event, each coloured by
that day's peak FRP. A persistent flare is a dense solid bar, stubble burning is two seasonal
clumps, a wildfire is a single mark. It answers "how persistent is it" faster than any number,
and it is the thing a judge will remember.

**Restraint.** No card shadows, no gradients, no entrance animations. Motion only where it
shows a change: the detail panel sliding in, the map easing to a selected event.
