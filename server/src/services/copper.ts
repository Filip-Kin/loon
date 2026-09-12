// #region Copper
// Everything that happens to a board once its parts are placed: route the
// signals, stitch the ground, and pour the copper that carries current. One
// place, because this lived in two procedures and they drifted - the
// assistant's own path routed a board and never poured it at all.

import { autoroute } from "@loon/shared/autoroute";
import { planPours, stitchVias } from "@loon/shared/pour";
import { padWorld } from "@loon/shared/pcbgen";
import type { Board } from "@loon/shared/board";
import type { Footprint } from "@loon/shared/footprint";
import type { Netlist } from "@loon/shared/netlist";

export function layCopper(board: Board, footprints: Record<string, Footprint>, nlIn: Netlist): string[] {
  const notes: string[] = [];

  const nl = nlIn;
  // Rails stay out of the router. Handing 3V3 to it - milliamps, so a trace is
  // electrically fine - produced a net with 22 pins whose escape stubs crossed
  // the pads they started next to, and 33 DRC errors with it. It goes in
  // copper with the rest.
  const r = autoroute(board, footprints, nl);
  board.tracks.push(...r.tracks);
  board.vias.push(...r.vias);
  notes.push(
    `routed ${r.routed} connections with ${r.tracks.length} tracks and ${r.vias.length} vias in ${r.seconds.toFixed(0)}s; ${r.failed} could not be routed and ${new Set(r.skipped).size} power nets were left for copper`,
  );

  // The copper the router deliberately skipped. Ground goes on the back
  // of the board and the battery rail on the front, which is what a two
  // layer power board looks like.
  // Every net the router left for copper gets a pour, bounded to the
  // area its own pads occupy, on the layer where most of them sit. The
  // smaller a pour's area, the higher its priority, so a channel output
  // wins its own corner from the rail it branches off.
  const padsOf = (net: string) => board2Pads.get(net) ?? [];
  const board2Pads = new Map<string, { x: number; y: number; smd: boolean }[]>();
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    for (const [padNum, net] of Object.entries(f.padNets)) {
      if (!net) continue;
      const pad = fp?.pads.find((x) => x.number === padNum);
      // The pad, not the footprint origin. On a 45mm terminal block the
      // origin is at one end, so a pour bounded by origins misses most of
      // the pads it is supposed to feed.
      const at = pad ? padWorld(f, pad.at) : f.at;
      const arr = board2Pads.get(net) ?? [];
      arr.push({ x: at.x, y: at.y, smd: (pad?.type ?? "smd") === "smd" });
      board2Pads.set(net, arr);
    }
  }
  const railNames = [...new Set(r.skipped)].filter((n) => n !== "GND" && padsOf(n).length > 1);
  const boundsOf = (net: string) => {
    const pts = padsOf(net);
    return {
      x1: Math.min(...pts.map((p) => p.x)) - 6,
      y1: Math.min(...pts.map((p) => p.y)) - 6,
      x2: Math.max(...pts.map((p) => p.x)) + 6,
      y2: Math.max(...pts.map((p) => p.y)) + 6,
    };
  };
  const areaOf = (net: string) => {
    const b = boundsOf(net);
    return (b.x2 - b.x1) * (b.y2 - b.y1);
  };
  // Ground on both layers: most pads are surface mount on the front, and a
  // pour they cannot reach connects nothing. The through-hole terminals
  // stitch the two together.
  const volts = (n: string) => {
    const m = /^\+(\d+)(?:V(\d+))?/.exec(n);
    return m ? parseFloat(`${m[1]}.${m[2] ?? 0}`) : 0;
  };
  const railName = [...railNames].sort((a, b) => volts(b) - volts(a))[0];
  // Ground owns the back. It also gets the front, unless the battery rail is
  // about to take the front - then a ground pour there is just fragments
  // between the rail and the tracks, and every fragment that touches a pad
  // without reaching the plane counts as an open connection. Each surface
  // mount ground pad gets its own via to the back instead.
  const boardArea =
    (Math.max(...board.outline.map((p2) => p2.x)) - Math.min(...board.outline.map((p2) => p2.x))) *
    (Math.max(...board.outline.map((p2) => p2.y)) - Math.min(...board.outline.map((p2) => p2.y)));
  // Measured both ways: dropping the front ground pour when the rail takes the
  // front loses 138 cm2 of copper and connects fewer pads, not more. Keep it.
  const railFront = false;
  void boardArea;
  const pourNets: { name: string; layer: string; priority?: number; bounds?: { x1: number; y1: number; x2: number; y2: number } }[] = [
    { name: "GND", layer: "B.Cu" },
    ...(railFront ? [] : [{ name: "GND", layer: "F.Cu" }]),
  ];
  // One layer each: the front when the net has surface mount pads to
  // reach, the back otherwise. Two zones for one small net just makes two
  // islands, and KiCad throws away an island that touches nothing.
  // A net whose pads are spread across the board is not a pour, it is a
  // wide trace, and it is left in the ratsnest until the router grows one.
  // Every skipped net gets copper, including the ones that span the whole board.
  // The battery rail is the most spread out net there is and the one that
  // carries the most current: excluding it for being large left the board with
  // no 24V copper anywhere.
  const ranked = railNames.sort((a, b) => areaOf(a) - areaOf(b));
  // Rails go on the front. The back is the ground plane, and a rail pour
  // carved out of it strands every ground pin it surrounds - which on a
  // terminal block is every other pin.
  // Priority decides who wins where two pours overlap. A channel output is
  // small and local, so it takes its own corner; the battery rail takes the
  // rest of the front; the low-current rails get what is left. Ranking purely
  // by area put 3V3 above the rail that feeds the whole board.
  ranked.forEach((net, i) => {
    const priority = areaOf(net) < 6000 ? 20 + i : net === railName ? 15 : 2 + i;
    pourNets.push({ name: net, layer: "F.Cu", priority, bounds: boundsOf(net) });
  });

  // Stitch only where the ground pour will actually be: outside the areas
  // another pour owns and outside every part's keepout.
  const avoid = pourNets.filter((n) => n.bounds).map((n) => n.bounds!);
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    for (const ring of fp?.keepouts ?? []) {
      const rad = (-f.rotation * Math.PI) / 180;
      const pts = ring.map((pt) => ({
        x: f.at.x + pt.x * Math.cos(rad) - pt.y * Math.sin(rad),
        y: f.at.y + pt.x * Math.sin(rad) + pt.y * Math.cos(rad),
      }));
      avoid.push({
        x1: Math.min(...pts.map((p2) => p2.x)),
        y1: Math.min(...pts.map((p2) => p2.y)),
        x2: Math.max(...pts.map((p2) => p2.x)),
        y2: Math.max(...pts.map((p2) => p2.y)),
      });
    }
  }
  const stitch = stitchVias(board, footprints, { net: "GND", avoid });
  notes.push(stitch.note);
  const p = planPours(board, nl, { nets: pourNets });
  board.zones.push(...p.zones);
  notes.push(...p.notes);
  return notes;
}
