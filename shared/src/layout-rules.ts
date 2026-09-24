// #region Layout doctrine
// What a good board looks like, written down once, in one place: the placement
// engine follows these rules and the assistant is told them, so both do the
// same thing rather than each inventing a layout.
//
// Sources, and they are worth reading before changing any of this:
//   TI SLVA958 / SLVA773, buck and boost layout, the hot loop
//   Rohm "PCB Layout Techniques of Buck Converter"
//   Sierra Circuits, PCB layout for power electronics
//   JLCPCB high-current design guide (copper for 10A+)
//   Phil's Lab #84, aesthetic PCB design
//
// The aesthetic rules are last and they are not decoration. A board laid out on
// a grid, in zones, with repeated circuits repeating exactly, is a board you can
// probe, rework and hand to someone else.

export const LAYOUT_RULES = `PCB LAYOUT RULES (the placement engine follows these; so should you)

ELECTRICAL, in priority order:
1. Decoupling belongs at the pin. A bypass capacitor goes within ~2mm of the pin
   it serves, on the same layer, with its own via to the plane. Further than 5mm
   and it is decoration.
2. Close the hot loop. In a buck: input cap, high-side switch and the IC's PGND
   form a loop that must be as small as the design rules allow. Same for a boost
   and the output cap. This one decision is most of whether a converter works.
3. Zone the board. Power, digital, RF and connectors each get their own area,
   with a gutter between them. Never put a switching node next to a
   microcontroller or an analog input.
4. Current flows one way. Input at one end, converters in the middle, outputs at
   the other end. A path that doubles back is a path that couples.
5. A high-current path is copper, not a trace. 10A upwards wants a pour or a
   very wide trace; 30A wants a pour on both layers stitched with vias. Size
   connectors, fuse holders and terminals for the real current, not the nominal.
6. An RF module's antenna hangs off the board edge, with no copper under it, and
   its keepout zone is a rule, not a suggestion.
7. Every connector you plug into goes on a board edge, reachable, with the
   circuit it serves beside it. A programming port next to the MCU. A screw
   terminal where wire can enter it.
8. Bolt the board down: M3 holes at the corners, clear of copper. On a board
   with heavy wire, the connectors pull.

MECHANICAL AND AESTHETIC (they are the same thing here):
9. One grid. Every part lands on it. 0.5mm works.
10. Zones read as blocks, aligned and separated by a consistent gutter.
11. Repeated circuits repeat exactly. Eight identical channels look identical,
    same orientation, same pitch, same internal arrangement.
12. Two text orientations at most, readable left-to-right or bottom-to-top.
13. The board outline fits the content. Empty board area is money: OSH Park
    charges by the square inch.

THE SHEET, which is read by a person and has the same rules for the same reason:
14. A sub-circuit is a block: its parts sit 10-20mm apart, close enough to read
    as one thing.
15. Blocks sit 40mm apart while they are being written, then the sheet is packed
    with compact_sheet. A sheet that has to be scrolled across is a sheet nobody
    checks; the radio kiosk came out 918mm wide and was unreadable.
16. Anything further apart than a couple of blocks is joined by a label, not a
    wire drawn across the sheet.`;
