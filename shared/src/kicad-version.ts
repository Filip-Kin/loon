// #region KiCad version
// One place for every number that has to match the KiCad we run. loon writes
// files that KiCad opens without an upgrade prompt, so the stamps here are the
// ones KiCad itself writes, read off `kicad-cli` in the pinned container:
//
//   docker run --rm ghcr.io/kicad/kicad:10.0 python3 -c \
//     "import pcbnew; print(pcbnew.SEXPR_BOARD_FILE_VERSION)"   -> 20260206
//   kicad-cli sch upgrade --force x.kicad_sch; head -2 x.kicad_sch -> 20260306
//
// Moving to a new KiCad means: pull the image, read both numbers again, set the
// library tag to the same release, and re-run scripts/kicadtest.ts.

/** Container that runs kicad-cli and pcbnew. */
export const KICAD_IMAGE = "ghcr.io/kicad/kicad:10.0";
/** Tag on kicad-footprints / kicad-packages3D matching that container. */
export const KICAD_LIB_REF = "10.0.6";
/** `(version ...)` in a .kicad_pcb, as KiCad 10 writes it. */
export const KICAD_PCB_VERSION = 20260206;
/** `(version ...)` in a .kicad_sch, as KiCad 10 writes it. */
export const KICAD_SCH_VERSION = 20260306;
/** `net_settings.meta.version` in a .kicad_pro, as KiCad 10 writes it. */
export const KICAD_NET_SETTINGS_VERSION = 4;
/** `meta.version` in a .kicad_pro. Unchanged since KiCad 7. */
export const KICAD_PRO_VERSION = 3;
/**
 * Path variables a footprint may use for its 3D model. KiCad keeps the older
 * names alive, and loon's footprint cache holds files from several library
 * tags, so both are read and both are set on a render.
 */
export const KICAD_3DMODEL_VARS = ["KICAD10_3DMODEL_DIR", "KICAD9_3DMODEL_DIR"] as const;
