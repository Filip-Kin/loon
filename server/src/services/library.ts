// #region Parts library service
// A starter set of common symbols authored as KiCad S-expressions, so the
// editor renders real symbol graphics and saved files embed valid lib_symbols
// that open in KiCad. Each catalog entry carries per-source availability that
// drives the source filter. DigiKey/Mouser/OSH Park availability here is
// seeded/mock for the prototype; the live supplier APIs replace it later.

import { parse, type SxList } from "@loon/shared/sexpr";
import { parseLibSymbol, emitLibSymbol } from "@loon/shared/kicad-sch";
import { buildIcSymbol, type IcSymbolSpec } from "@loon/shared/symbolgen";
import { REAL_PARTS } from "./real-parts";
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

// #region generated symbols
// Generic connectors are generated by pin count instead of hand-authored. XH/VH
// families in a BOM map onto these Conn_01xNN symbols; the Pi 40-pin header maps
// onto Conn_02x20.
function conn1x(n: number): string {
  const libId = `Connector_Generic:Conn_01x${String(n).padStart(2, "0")}`;
  const top = ((n - 1) * 2.54) / 2;
  const bt = (top + 1.27).toFixed(3);
  const bb = (-top - 1.27).toFixed(3);
  const pins = Array.from({ length: n }, (_, i) =>
    pin("passive", -5.08, +(top - i * 2.54).toFixed(3), 0, 3.81, `Pin_${i + 1}`, `${i + 1}`),
  ).join("\n      ");
  return `(symbol "${libId}"
    (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "J" (at 0 ${(top + 3.81).toFixed(3)} 0) ${E})
    (property "Value" "Conn_01x${String(n).padStart(2, "0")}" (at 0 ${(-top - 3.81).toFixed(3)} 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "connector" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Generic connector, single row, 1x${String(n).padStart(2, "0")}" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "${libId}_1_1"
      (rectangle (start -1.27 ${bt}) (end 1.27 ${bb}) (stroke (width 0.1524) (type default)) (fill (type none)))
      ${pins}))`;
}

function conn2x20(): string {
  const rows = 20;
  const libId = "Connector_Generic:Conn_02x20";
  const top = ((rows - 1) * 2.54) / 2;
  const pins: string[] = [];
  for (let i = 0; i < rows; i++) {
    const y = +(top - i * 2.54).toFixed(3);
    pins.push(pin("passive", -5.08, y, 0, 3.81, `Pin_${2 * i + 1}`, `${2 * i + 1}`));
    pins.push(pin("passive", 5.08, y, 180, 3.81, `Pin_${2 * i + 2}`, `${2 * i + 2}`));
  }
  return `(symbol "${libId}"
    (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" "J" (at 0 ${(top + 3.81).toFixed(3)} 0) ${E})
    (property "Value" "Conn_02x20" (at 0 ${(-top - 3.81).toFixed(3)} 0) ${E})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "connector header pin" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_description" "Generic connector, double row, 2x20 (e.g. Raspberry Pi GPIO header)" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "${libId}_1_1"
      (rectangle (start -1.27 ${(top + 1.27).toFixed(3)}) (end 1.27 ${(-top - 1.27).toFixed(3)}) (stroke (width 0.1524) (type default)) (fill (type none)))
      ${pins.join("\n      ")}))`;
}

const NMOS = `(symbol "Device:Q_NMOS_GSD"
  (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
  (property "Reference" "Q" (at 5.08 1.905 0) ${E})
  (property "Value" "Q_NMOS_GSD" (at 5.08 0 0) ${E})
  (property "Footprint" "" (at 5.08 -1.905 0) (effects (font (size 1.27 1.27)) hide))
  (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (property "ki_keywords" "mosfet n-channel transistor" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (property "ki_description" "N-channel MOSFET, gate/source/drain" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (symbol "Q_NMOS_GSD_0_1"
    (polyline (pts (xy -2.54 1.905) (xy -2.54 -1.905)) (stroke (width 0.254) (type default)) (fill (type none)))
    (polyline (pts (xy -1.524 1.905) (xy -1.524 -1.905)) (stroke (width 0.254) (type default)) (fill (type none)))
    (polyline (pts (xy -1.524 1.27) (xy 2.54 1.27) (xy 2.54 2.54)) (stroke (width 0) (type default)) (fill (type none)))
    (polyline (pts (xy -1.524 0) (xy 2.54 0)) (stroke (width 0) (type default)) (fill (type none)))
    (polyline (pts (xy -1.524 -1.27) (xy 2.54 -1.27) (xy 2.54 -2.54)) (stroke (width 0) (type default)) (fill (type none)))
    (polyline (pts (xy 0.5 0) (xy 1.5 0.5) (xy 1.5 -0.5) (xy 0.5 0)) (stroke (width 0) (type default)) (fill (type outline))))
  (symbol "Q_NMOS_GSD_1_1"
    ${pin("input", -5.08, 0, 0, 2.54, "G", "1")}
    ${pin("passive", 2.54, -5.08, 90, 2.54, "S", "2")}
    ${pin("passive", 2.54, 5.08, 270, 2.54, "D", "3")}))`;

const GENERATED: string[] = [conn1x(3), conn1x(4), conn1x(5), conn1x(6), conn1x(8), conn1x(15), conn2x20(), NMOS];

// Seed sourcing data. `available` toggles per source drive the source filter.
type Seed = { digikey?: boolean; mouser?: boolean; oshpark?: boolean; footprints?: string[]; priceUsd?: number };
const SEEDS: Record<string, Seed> = {
  "Device:R": { priceUsd: 0.02, digikey: true, mouser: true, oshpark: true, footprints: ["Resistor_SMD:R_0603_1608Metric", "Resistor_SMD:R_0805_2012Metric", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"] },
  "Device:C": { priceUsd: 0.03, digikey: true, mouser: true, oshpark: true, footprints: ["Capacitor_SMD:C_0603_1608Metric", "Capacitor_SMD:C_0805_2012Metric"] },
  "Device:C_Polarized": { priceUsd: 0.25, digikey: true, mouser: true, oshpark: false, footprints: ["Capacitor_THT:CP_Radial_D5.0mm_P2.50mm"] },
  "Device:L": { priceUsd: 0.35, digikey: true, mouser: true, oshpark: false, footprints: ["Inductor_SMD:L_0805_2012Metric"] },
  "Device:LED": { priceUsd: 0.1, digikey: true, mouser: true, oshpark: true, footprints: ["LED_SMD:LED_0603_1608Metric", "LED_THT:LED_D5.0mm"] },
  "Device:D": { priceUsd: 0.12, digikey: true, mouser: true, oshpark: true, footprints: ["Diode_SMD:D_SOD-123"] },
  "Device:Q_NPN_BCE": { priceUsd: 0.12, digikey: true, mouser: true, oshpark: false, footprints: ["Package_TO_SOT_SMD:SOT-23"] },
  "Device:Q_NMOS_GSD": { priceUsd: 0.1, digikey: true, mouser: true, oshpark: true, footprints: ["Package_TO_SOT_SMD:SOT-23"] },
  "Switch:SW_Push": { priceUsd: 0.22, digikey: true, mouser: true, oshpark: false, footprints: ["Button_Switch_SMD:SW_SPST_B3U-1000P"] },
  "Connector:Conn_01x02": { priceUsd: 0.35, digikey: true, mouser: true, oshpark: false, footprints: ["Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"] },
  "power:GND": {},
  "power:+5V": {},
  "power:+3V3": {},
};

export interface LibEntry {
  def: LibSymbol;
  raw: SxList;
  part: PartSummary;
}

function buildAvailability(libId: string, seed: Seed, priceUsd?: number, sku?: string): SourceAvailability[] {
  const out: SourceAvailability[] = [
    { source: "kicad", available: true },
  ];
  if (seed.digikey) out.push({ source: "digikey", available: true, priceUsd: priceUsd ?? seed.priceUsd, sku });
  if (seed.mouser) out.push({ source: "mouser", available: true, priceUsd: priceUsd ?? seed.priceUsd, sku });
  if (seed.oshpark) out.push({ source: "oshpark", available: true });
  return out;
}

class Library {
  private entries = new Map<string, LibEntry>();

  constructor() {
    // Real multi-pin parts (MCU modules, regulators, connectors, sensors) are
    // declared as pin lists and generated, rather than hand-drawn, so adding a
    // chip is a datasheet transcription instead of S-expr artwork.
    for (const spec of REAL_PARTS) {
      const def = buildIcSymbol(spec.symbol);
      const part: PartSummary = {
        id: def.libId,
        libId: def.libId,
        name: def.libId.split(":")[1] ?? def.libId,
        description: def.description ?? "",
        refPrefix: def.refPrefix,
        keywords: def.keywords ?? "",
        footprints: spec.symbol.footprint ? [spec.symbol.footprint] : [],
        sources: buildAvailability(def.libId, {
          digikey: true,
          mouser: true,
          oshpark: spec.assemblable !== false,
        }, spec.priceUsd, spec.mpn),
        priceUsd: spec.priceUsd,
        priceNote: spec.priceNote ?? "typical qty-1 estimate",
        mpn: spec.mpn,
      };
      this.entries.set(def.libId, { def, raw: emitLibSymbol(def), part });
    }
    for (const raw of [...SYMBOLS, ...GENERATED]) {
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
        sources: buildAvailability(def.libId, seed, seed.priceUsd),
        priceUsd: seed.priceUsd,
        priceNote: seed.priceUsd ? "typical qty-1 estimate" : undefined,
      };
      this.entries.set(def.libId, { def, raw: sx, part });
    }
  }

  get(libId: string): LibEntry | undefined {
    const hit = this.entries.get(libId);
    if (hit) return hit;
    // A power symbol is a named net flag and nothing more, so any power:NAME
    // the design asks for is generated rather than refused. Without this,
    // naming a signal net this way fails and every op that referenced it
    // fails behind it.
    if (libId.startsWith("power:")) {
      const name = libId.slice("power:".length);
      if (!name || !/^[A-Za-z0-9_+\-.]+$/.test(name)) return undefined;
      const def = buildIcSymbol({
        libId,
        refPrefix: "#PWR",
        value: name,
        description: `Net flag ${name}`,
        pins: [{ number: "1", name, type: "power_in", side: "left" }],
      });
      const part: PartSummary = {
        id: libId,
        libId,
        name,
        description: def.description ?? "",
        refPrefix: "#PWR",
        keywords: "power net flag",
        footprints: [],
        sources: [{ source: "kicad", available: true }],
      };
      const entry: LibEntry = { def, raw: emitLibSymbol(def), part };
      this.entries.set(libId, entry);
      return entry;
    }
    return undefined;
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
