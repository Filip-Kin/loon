// Does each channel's breaker sit with its own terminal?
import { library } from "../server/src/services/library";
import { getFootprints } from "../server/src/services/footprints";
import { buildOra } from "./build-ora";
import { buildNetlist } from "@loon/shared/netlist";
import { generateBoard } from "@loon/shared/pcbgen";
import { OSHPARK_2LAYER } from "@loon/shared/board";
const schem = buildOra();
const defs = (l: string) => library.get(l)?.def;
const specs = new Map<string, number>();
for (const s of schem.symbols) { const fp = s.properties.Footprint; if (fp) specs.set(fp, defs(s.libId)?.pins.length ?? 2); }
const footprints = await getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
const nl = buildNetlist(schem, defs);
const res = generateBoard(schem, defs, { rules: OSHPARK_2LAYER, footprints });
const at = (ref: string) => { const f = res.board.footprints.find((x) => x.ref === ref); return f ? `(${f.at.x.toFixed(0)},${f.at.y.toFixed(0)})` : "-"; };
// Which switch and fuse each channel terminal is actually connected to.
for (const t of res.board.footprints.filter((f) => /CH\d+ (OUT|ALWAYS)/.test(f.value))) {
  const outNet = nl.nets.find((n) => n.pins.some((p) => p.ref === t.ref) && !n.isPower);
  const partners = outNet ? outNet.pins.map((p) => p.ref).filter((r) => r !== t.ref) : [];
  const swRef = partners.find((r) => r.startsWith("U"));
  const swNet = swRef ? nl.nets.filter((n) => n.pins.some((p) => p.ref === swRef) && !n.isPower) : [];
  const fuseRef = swNet.flatMap((n) => n.pins.map((p) => p.ref)).find((r) => r.startsWith("F"))
    ?? partners.find((r) => r.startsWith("F"));
  console.log(`${t.value.padEnd(22)} terminal ${t.ref}${at(t.ref)}  switch ${swRef ?? "-"}${swRef ? at(swRef) : ""}  fuse ${fuseRef ?? "-"}${fuseRef ? at(fuseRef) : ""}`);
}
console.log("board", res.board.outline[1].x, "x", res.board.outline[2].y, "mm");
for (const n of res.notes) console.log("note:", n);
