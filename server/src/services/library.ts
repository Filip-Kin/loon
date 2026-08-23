// #region Parts library service
// A starter set of common symbols authored as KiCad S-expressions, so the
// editor renders real symbol graphics and saved files embed valid lib_symbols
// that open in KiCad. Each catalog entry carries per-source availability that
// drives the source filter. DigiKey/Mouser/OSH Park availability here is
// seeded/mock for the prototype; the live supplier APIs replace it later.

import { parse, type SxList } from "@loon/shared/sexpr";
import { parseLibSymbol } from "@loon/shared/kicad-sch";
import type { LibSymbol } from "@loon/shared/schematic";
import type { PartSummary, PartSearchQuery, SourceAvailability } from "@loon/shared/parts";
import { partMatches } from "@loon/shared/parts";

// Effects helper text reused across pins to keep the definitions short.
const E = `(effects (font (size 1.27 1.27)))`;
const pin = (t: string, x: number, y: number, r: number, len: number, name: string, numb: string) =>
  `(pin ${t} line (at ${x} ${y} ${r}) (length ${len}) (name "${name}" ${E}) (number "${numb}" ${E}))`;

const SYMBOLS: string[] = [
  // Resistor
  `(symbol "Device:R"
    (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) ${E})
    (property "Value" "R" (at 0 0 90) ${E})
    (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "R res resistor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Resistor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" ${pin("passive", 0, 3.81, 270, 1.27, "~", "1")} ${pin("passive", 0, -3.81, 90, 1.27, "~", "2")}))`,

  // Capacitor (non-polarized)
  `(symbol "Device:C"
    (pin_numbers hide) (pin_names (offset 0.254)) (in_bom yes) (on_board yes)
    (property "Reference" "C" (at 0.635 2.54 0) ${E})
    (property "Value" "C" (at 0.635 -2.54 0) ${E})
    (property "Footprint" "" (at 0.9652 -3.81 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "cap capacitor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Unpolarized capacitor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "C_0_1"
      (polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
      (polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none))))
    (symbol "C_1_1" ${pin("passive", 0, 3.81, 270, 2.794, "~", "1")} ${pin("passive", 0, -3.81, 90, 2.794, "~", "2")}))`,

  // Polarized capacitor
  `(symbol "Device:C_Polarized"
    (pin_numbers hide) (pin_names (offset 0.254)) (in_bom yes) (on_board yes)
    (property "Reference" "C" (at 0.635 2.54 0) ${E})
    (property "Value" "C" (at 0.635 -2.54 0) ${E})
    (property "Footprint" "" (at 0.9652 -3.81 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "cap capacitor electrolytic polarized" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Polarized capacitor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "C_Polarized_0_1"
      (rectangle (start -2.286 0.508) (end 2.286 1.016) (stroke (width 0) (type default)) (fill (type outline)))
      (polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none))))
    (symbol "C_Polarized_1_1" ${pin("passive", 0, 3.81, 270, 2.794, "~", "1")} ${pin("passive", 0, -3.81, 90, 2.794, "~", "2")}))`,

  // Inductor
  `(symbol "Device:L"
    (pin_numbers hide) (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "L" (at -1.27 0 90) ${E})
    (property "Value" "L" (at 1.905 0 90) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "inductor choke coil reactor magnetic" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Inductor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "L_0_1"
      (arc (start 0 -2.54) (mid 0.635 -1.905) (end 0 -1.27) (stroke (width 0) (type default)) (fill (type none)))
      (arc (start 0 -1.27) (mid 0.635 -0.635) (end 0 0) (stroke (width 0) (type default)) (fill (type none)))
      (arc (start 0 0) (mid 0.635 0.635) (end 0 1.27) (stroke (width 0) (type default)) (fill (type none)))
      (arc (start 0 1.27) (mid 0.635 1.905) (end 0 2.54) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "L_1_1" ${pin("passive", 0, 3.81, 270, 1.27, "1", "1")} ${pin("passive", 0, -3.81, 90, 1.27, "2", "2")}))`,

  // LED
  `(symbol "Device:LED"
    (pin_numbers hide) (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "D" (at 0 2.54 0) ${E})
    (property "Value" "LED" (at 0 -2.54 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "LED diode light-emitting-diode" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Light emitting diode" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "LED_0_1"
      (polyline (pts (xy -1.27 -1.27) (xy -1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy -1.27 0) (xy 1.27 0)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 1.27 -1.27) (xy 1.27 1.27) (xy -1.27 0) (xy 1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy -1.778 -2.286) (xy -3.048 -3.556)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0.254 -2.286) (xy -1.016 -3.556)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "LED_1_1" ${pin("passive", -3.81, 0, 0, 2.54, "K", "1")} ${pin("passive", 3.81, 0, 180, 2.54, "A", "2")}))`,

  // Diode
  `(symbol "Device:D"
    (pin_numbers hide) (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "D" (at 0 2.54 0) ${E})
    (property "Value" "D" (at 0 -2.54 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "diode" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Diode" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "D_0_1"
      (polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy 1.27 0) (xy -1.27 0)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type outline))))
    (symbol "D_1_1" ${pin("passive", -3.81, 0, 0, 2.54, "K", "1")} ${pin("passive", 3.81, 0, 180, 2.54, "A", "2")}))`,

  // NPN transistor
  `(symbol "Device:Q_NPN_BCE"
    (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
    (property "Reference" "Q" (at 5.08 1.905 0) ${E})
    (property "Value" "Q_NPN_BCE" (at 5.08 0 0) ${E})
    (property "Footprint" "" (at 5.08 -1.905 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "transistor NPN" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "NPN transistor, base/collector/emitter" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "Q_NPN_BCE_0_1"
      (polyline (pts (xy 0.635 0.635) (xy 2.54 2.54)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0.635 -0.635) (xy 2.54 -2.54)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0.635 1.905) (xy 0.635 -1.905)) (stroke (width 0.508) (type default)) (fill (type none)))
      (polyline (pts (xy 1.778 -1.27) (xy 2.286 -2.032) (xy 1.524 -2.286) (xy 1.778 -1.27)) (stroke (width 0) (type default)) (fill (type outline))))
    (symbol "Q_NPN_BCE_1_1"
      ${pin("input", -2.54, 0, 0, 3.175, "B", "1")}
      ${pin("passive", 2.54, 5.08, 270, 2.54, "C", "2")}
      ${pin("passive", 2.54, -5.08, 90, 2.54, "E", "3")}))`,

  // Push button
  `(symbol "Switch:SW_Push"
    (pin_numbers hide) (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "SW" (at 0 3.81 0) ${E})
    (property "Value" "SW_Push" (at 0 -2.54 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "switch normally-open pushbutton push-button" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Push button switch, normally open" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "SW_Push_0_1"
      (circle (center -2.032 0) (radius 0.508) (stroke (width 0) (type default)) (fill (type none)))
      (circle (center 2.032 0) (radius 0.508) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy -2.54 1.27) (xy 2.54 1.27)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "SW_Push_1_1" ${pin("passive", -5.08, 0, 0, 2.54, "1", "1")} ${pin("passive", 5.08, 0, 180, 2.54, "2", "2")}))`,

  // 2-pin connector
  `(symbol "Connector:Conn_01x02"
    (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "J" (at 0 2.54 0) ${E})
    (property "Value" "Conn_01x02" (at 0 -5.08 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "connector header" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Generic 2-pin connector" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "Conn_01x02_1_1"
      (rectangle (start -1.27 -1.27) (end 0 -1.905) (stroke (width 0.1524) (type default)) (fill (type none)))
      (rectangle (start -1.27 1.27) (end 0 0.635) (stroke (width 0.1524) (type default)) (fill (type none)))
      ${pin("passive", -5.08, 0, 0, 3.81, "Pin_1", "1")}
      ${pin("passive", -5.08, -2.54, 0, 3.81, "Pin_2", "2")}))`,

  // Ground
  `(symbol "power:GND"
    (power) (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
    (property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (at 0 -3.81 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "power-flag global ground gnd" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Power symbol GND" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "GND_0_1"
      (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "GND_1_1" ${pin("power_in", 0, 0, 270, 0, "GND", "1")}))`,

  // +5V
  `(symbol "power:+5V"
    (power) (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
    (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "+5V" (at 0 3.556 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "power-flag +5V power" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Power symbol +5V" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "+5V_0_1"
      (polyline (pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "+5V_1_1" ${pin("power_in", 0, 0, 90, 0, "+5V", "1")}))`,

  // +3V3
  `(symbol "power:+3V3"
    (power) (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
    (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "+3V3" (at 0 3.556 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "power-flag +3V3 3.3V power" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Power symbol +3V3" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "+3V3_0_1"
      (polyline (pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "+3V3_1_1" ${pin("power_in", 0, 0, 90, 0, "+3V3", "1")}))`,
];

// Seed sourcing data. `available` toggles per source drive the source filter.
type Seed = { digikey?: boolean; mouser?: boolean; oshpark?: boolean; footprints?: string[] };
const SEEDS: Record<string, Seed> = {
  "Device:R": { digikey: true, mouser: true, oshpark: true, footprints: ["Resistor_SMD:R_0603_1608Metric", "Resistor_SMD:R_0805_2012Metric", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"] },
  "Device:C": { digikey: true, mouser: true, oshpark: true, footprints: ["Capacitor_SMD:C_0603_1608Metric", "Capacitor_SMD:C_0805_2012Metric"] },
  "Device:C_Polarized": { digikey: true, mouser: true, oshpark: false, footprints: ["Capacitor_THT:CP_Radial_D5.0mm_P2.50mm"] },
  "Device:L": { digikey: true, mouser: true, oshpark: false, footprints: ["Inductor_SMD:L_0805_2012Metric"] },
  "Device:LED": { digikey: true, mouser: true, oshpark: true, footprints: ["LED_SMD:LED_0603_1608Metric", "LED_THT:LED_D5.0mm"] },
  "Device:D": { digikey: true, mouser: true, oshpark: true, footprints: ["Diode_SMD:D_SOD-123"] },
  "Device:Q_NPN_BCE": { digikey: true, mouser: true, oshpark: false, footprints: ["Package_TO_SOT_SMD:SOT-23"] },
  "Switch:SW_Push": { digikey: true, mouser: true, oshpark: false, footprints: ["Button_Switch_SMD:SW_SPST_B3U-1000P"] },
  "Connector:Conn_01x02": { digikey: true, mouser: true, oshpark: false, footprints: ["Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"] },
  "power:GND": {},
  "power:+5V": {},
  "power:+3V3": {},
};

export interface LibEntry {
  def: LibSymbol;
  raw: SxList;
  part: PartSummary;
}

function buildAvailability(libId: string, seed: Seed): SourceAvailability[] {
  const out: SourceAvailability[] = [
    { source: "kicad", available: true },
  ];
  if (seed.digikey) out.push({ source: "digikey", available: true });
  if (seed.mouser) out.push({ source: "mouser", available: true });
  if (seed.oshpark) out.push({ source: "oshpark", available: true });
  return out;
}

class Library {
  private entries = new Map<string, LibEntry>();

  constructor() {
    for (const raw of SYMBOLS) {
      const sx = parse(raw);
      const def = parseLibSymbol(sx);
      const seed = SEEDS[def.libId] ?? {};
      const part: PartSummary = {
        id: def.libId,
        libId: def.libId,
        name: def.libId.split(":")[1] ?? def.libId,
        description: def.description ?? "",
        refPrefix: def.refPrefix,
        keywords: def.keywords ?? "",
        footprints: seed.footprints ?? [],
        sources: buildAvailability(def.libId, seed),
      };
      this.entries.set(def.libId, { def, raw: sx, part });
    }
  }

  get(libId: string): LibEntry | undefined {
    return this.entries.get(libId);
  }

  rawMap(libIds: string[]): Record<string, SxList> {
    const out: Record<string, SxList> = {};
    for (const id of libIds) {
      const e = this.entries.get(id);
      if (e) out[id] = e.raw;
    }
    return out;
  }

  defMap(libIds: string[]): Record<string, LibSymbol> {
    const out: Record<string, LibSymbol> = {};
    for (const id of libIds) {
      const e = this.entries.get(id);
      if (e) out[id] = e.def;
    }
    return out;
  }

  allDefs(): Record<string, LibSymbol> {
    const out: Record<string, LibSymbol> = {};
    for (const [id, e] of this.entries) out[id] = e.def;
    return out;
  }

  search(q: PartSearchQuery): PartSummary[] {
    const out: PartSummary[] = [];
    for (const e of this.entries.values()) {
      if (partMatches(e.part, q)) out.push(e.part);
    }
    out.sort((a, b) => a.libId.localeCompare(b.libId));
    return q.limit ? out.slice(0, q.limit) : out;
  }
}

export const library = new Library();
