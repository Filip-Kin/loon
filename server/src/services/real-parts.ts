// #region Real catalog parts
// Multi-pin parts transcribed from their datasheets as pin lists. They are
// generated into symbols at startup (see symbolgen), so the catalog can grow by
// typing a pinout instead of drawing S-expression artwork.
//
// Prices are qty-1 estimates in USD, good enough to cost a BOM to the nearest
// dollar. They are labelled as estimates everywhere they surface; live
// DigiKey/Mouser pricing replaces them when those keys exist.

import type { IcSymbolSpec } from "@loon/shared/symbolgen";

export interface RealPart {
  symbol: IcSymbolSpec;
  priceUsd?: number;
  priceNote?: string;
  mpn?: string;
  // false = through-hole/mechanical part a fab's pick-and-place will not place.
  assemblable?: boolean;
}

// ESP32-S3-WROOM-1, Table 3-1 of the Espressif datasheet v1.8. Pin names carry
// the alternate function that matters for design: ADC channel, USB, UART0.
const ESP32_S3_PINS: { n: number; name: string }[] = [
  { n: 1, name: "GND" },
  { n: 2, name: "3V3" },
  { n: 3, name: "EN" },
  { n: 4, name: "IO4/ADC1_3" },
  { n: 5, name: "IO5/ADC1_4" },
  { n: 6, name: "IO6/ADC1_5" },
  { n: 7, name: "IO7/ADC1_6" },
  { n: 8, name: "IO15/ADC2_4" },
  { n: 9, name: "IO16/ADC2_5" },
  { n: 10, name: "IO17/ADC2_6" },
  { n: 11, name: "IO18/ADC2_7" },
  { n: 12, name: "IO8/ADC1_7" },
  { n: 13, name: "IO19/USB_D-" },
  { n: 14, name: "IO20/USB_D+" },
  { n: 15, name: "IO3/ADC1_2" },
  { n: 16, name: "IO46" },
  { n: 17, name: "IO9/ADC1_8" },
  { n: 18, name: "IO10/ADC1_9" },
  { n: 19, name: "IO11/ADC2_0" },
  { n: 20, name: "IO12/ADC2_1" },
  { n: 21, name: "IO13/ADC2_2" },
  { n: 22, name: "IO14/ADC2_3" },
  { n: 23, name: "IO21" },
  { n: 24, name: "IO47" },
  { n: 25, name: "IO48" },
  { n: 26, name: "IO45" },
  { n: 27, name: "IO0" },
  { n: 28, name: "IO35" },
  { n: 29, name: "IO36" },
  { n: 30, name: "IO37" },
  { n: 31, name: "IO38" },
  { n: 32, name: "IO39" },
  { n: 33, name: "IO40" },
  { n: 34, name: "IO41" },
  { n: 35, name: "IO42" },
  { n: 36, name: "RXD0/IO44" },
  { n: 37, name: "TXD0/IO43" },
  { n: 38, name: "IO2/ADC1_1" },
  { n: 39, name: "IO1/ADC1_0" },
  { n: 40, name: "GND" },
  { n: 41, name: "EPAD" },
];

export const REAL_PARTS: RealPart[] = [
  {
    mpn: "ESP32-S3-WROOM-1-N8",
    priceUsd: 3.9,
    symbol: {
      libId: "RF_Module:ESP32-S3-WROOM-1",
      refPrefix: "U",
      value: "ESP32-S3-WROOM-1-N8",
      description:
        "Espressif ESP32-S3 module, dual-core 240MHz, Wi-Fi + BLE, 8MB flash, native USB. 41 pads. Needs a 3V3 rail, EN RC delay, and a PCB antenna keepout.",
      keywords: "esp32 esp32-s3 wroom mcu microcontroller wifi ble module",
      datasheet: "https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf",
      footprint: "RF_Module:ESP32-S3-WROOM-1",
      pins: ESP32_S3_PINS.map((p) => ({
        number: String(p.n),
        name: p.name,
        type: p.name === "GND" || p.name === "EPAD" ? ("power_in" as const) : p.name === "3V3" ? ("power_in" as const) : p.name === "EN" ? ("input" as const) : ("bidirectional" as const),
        side: (p.n <= 20 ? "left" : "right") as "left" | "right",
      })),
    },
  },
  {
    mpn: "USB4110-GF-A",
    priceUsd: 0.95,
    symbol: {
      libId: "Connector:USB_C_Receptacle_USB2.0",
      refPrefix: "J",
      value: "USB-C Receptacle",
      description: "USB Type-C receptacle, USB 2.0 only. CC1/CC2 each need a 5.1k pulldown to act as a device.",
      keywords: "usb usb-c type-c connector receptacle",
      footprint: "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12",
      pins: [
        { number: "A1", name: "GND", type: "power_in", side: "left" },
        { number: "A4", name: "VBUS", type: "power_out", side: "left" },
        { number: "A5", name: "CC1", type: "bidirectional", side: "left" },
        { number: "A6", name: "D+", type: "bidirectional", side: "left" },
        { number: "A7", name: "D-", type: "bidirectional", side: "left" },
        { number: "A8", name: "SBU1", type: "bidirectional", side: "left" },
        { number: "B1", name: "GND2", type: "power_in", side: "right" },
        { number: "B4", name: "VBUS2", type: "power_out", side: "right" },
        { number: "B5", name: "CC2", type: "bidirectional", side: "right" },
        { number: "B6", name: "D+2", type: "bidirectional", side: "right" },
        { number: "B7", name: "D-2", type: "bidirectional", side: "right" },
        { number: "B8", name: "SBU2", type: "bidirectional", side: "right" },
        { number: "S1", name: "SHIELD", type: "passive", side: "right" },
      ],
    },
  },
  {
    mpn: "USBLC6-2SC6",
    priceUsd: 0.55,
    symbol: {
      libId: "Power_Protection:USBLC6-2SC6",
      refPrefix: "U",
      value: "USBLC6-2SC6",
      description: "Dual-line USB ESD protection, SOT-23-6. Sits between the USB-C connector and the MCU data pins.",
      keywords: "esd protection usb tvs",
      datasheet: "https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
      footprint: "Package_TO_SOT_SMD:SOT-23-6",
      pins: [
        { number: "1", name: "I/O1", type: "bidirectional", side: "left" },
        { number: "2", name: "GND", type: "power_in", side: "left" },
        { number: "3", name: "I/O2", type: "bidirectional", side: "left" },
        { number: "4", name: "I/O2_OUT", type: "bidirectional", side: "right" },
        { number: "5", name: "VBUS", type: "power_in", side: "right" },
        { number: "6", name: "I/O1_OUT", type: "bidirectional", side: "right" },
      ],
    },
  },
  {
    mpn: "AP2112K-3.3TRG1",
    priceUsd: 0.45,
    symbol: {
      libId: "Regulator_Linear:AP2112K-3.3",
      refPrefix: "U",
      value: "AP2112K-3.3",
      description: "600mA 3.3V LDO, SOT-23-5, 6V max input. Feed it from the 5V rail, not from 24V.",
      keywords: "ldo regulator 3.3v linear",
      datasheet: "https://www.diodes.com/assets/Datasheets/AP2112.pdf",
      footprint: "Package_TO_SOT_SMD:SOT-23-5",
      pins: [
        { number: "1", name: "VIN", type: "power_in", side: "left" },
        { number: "2", name: "GND", type: "power_in", side: "left" },
        { number: "3", name: "EN", type: "input", side: "left" },
        { number: "5", name: "VOUT", type: "power_out", side: "right" },
        { number: "4", name: "NC", type: "no_connect", side: "right" },
      ],
    },
  },
  {
    mpn: "TPS54360DDAR",
    priceUsd: 4.2,
    symbol: {
      libId: "Regulator_Switching:TPS54360",
      refPrefix: "U",
      value: "TPS54360",
      description:
        "60V 3.5A step-down converter, SO-8 with thermal pad. The 60V rating is what survives a motor bus: a 24V battery under regen can spike far above 24V.",
      keywords: "buck switching regulator step-down 60v dc-dc",
      datasheet: "https://www.ti.com/lit/ds/symlink/tps54360.pdf",
      footprint: "Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.29x3mm",
      pins: [
        { number: "1", name: "BOOT", type: "passive", side: "left" },
        { number: "2", name: "VIN", type: "power_in", side: "left" },
        { number: "3", name: "EN", type: "input", side: "left" },
        { number: "4", name: "RT/CLK", type: "input", side: "left" },
        { number: "5", name: "FB", type: "input", side: "right" },
        { number: "6", name: "COMP", type: "passive", side: "right" },
        { number: "7", name: "GND", type: "power_in", side: "right" },
        { number: "8", name: "SW", type: "power_out", side: "right" },
        { number: "9", name: "PAD", type: "power_in", side: "right" },
      ],
    },
  },
  {
    mpn: "INA226AIDGSR",
    priceUsd: 2.6,
    symbol: {
      libId: "Sensor_Current:INA226",
      refPrefix: "U",
      value: "INA226",
      description:
        "I2C bidirectional current/power monitor, 36V common mode, 16-bit. Measures a channel over a shunt and costs zero MCU ADC pins; 16 I2C addresses from A0/A1, so 16 channels share two wires.",
      keywords: "current sense monitor i2c shunt power",
      datasheet: "https://www.ti.com/lit/ds/symlink/ina226.pdf",
      footprint: "Package_SO:VSSOP-10_3x3mm_P0.5mm",
      pins: [
        { number: "1", name: "IN+", type: "input", side: "left" },
        { number: "2", name: "IN-", type: "input", side: "left" },
        { number: "3", name: "ALERT", type: "output", side: "left" },
        { number: "4", name: "VBUS", type: "input", side: "left" },
        { number: "5", name: "GND", type: "power_in", side: "left" },
        { number: "10", name: "VS", type: "power_in", side: "right" },
        { number: "9", name: "SCL", type: "bidirectional", side: "right" },
        { number: "8", name: "SDA", type: "bidirectional", side: "right" },
        { number: "7", name: "A1", type: "input", side: "right" },
        { number: "6", name: "A0", type: "input", side: "right" },
      ],
    },
  },
  {
    mpn: "ACS724LLCTR-50AB-T",
    priceUsd: 3.4,
    symbol: {
      libId: "Sensor_Current:ACS724-50AB",
      refPrefix: "U",
      value: "ACS724-50AB",
      description:
        "Hall-effect current sensor, +/-50A, isolated, analog output. One MCU ADC channel per sensor, no shunt in the ground path.",
      keywords: "current sensor hall analog isolated",
      datasheet: "https://www.allegromicro.com/-/media/files/datasheets/acs724-datasheet.pdf",
      footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
      pins: [
        { number: "1", name: "IP+", type: "passive", side: "left" },
        { number: "2", name: "IP+_2", type: "passive", side: "left" },
        { number: "3", name: "IP-", type: "passive", side: "left" },
        { number: "4", name: "IP-_2", type: "passive", side: "left" },
        { number: "5", name: "GND", type: "power_in", side: "right" },
        { number: "6", name: "FILTER", type: "passive", side: "right" },
        { number: "7", name: "VIOUT", type: "output", side: "right" },
        { number: "8", name: "VCC", type: "power_in", side: "right" },
      ],
    },
  },
  {
    mpn: "nRF24L01+ module",
    priceUsd: 2.2,
    assemblable: false,
    symbol: {
      libId: "RF_Module:nRF24L01_Module",
      refPrefix: "U",
      value: "nRF24L01+",
      description:
        "2.4GHz transceiver module on the standard 2x4 header. Carries the remote e-stop heartbeat over SPI. A sub-GHz module (RFM69/LoRa) drops into the same SPI pins and is the better choice in a crowded 2.4GHz venue.",
      keywords: "rf transceiver 2.4ghz spi nrf24 module radio",
      footprint: "Connector_PinHeader_2.54mm:PinHeader_2x04_P2.54mm_Vertical",
      pins: [
        { number: "1", name: "GND", type: "power_in", side: "left" },
        { number: "2", name: "VCC", type: "power_in", side: "left" },
        { number: "3", name: "CE", type: "input", side: "left" },
        { number: "4", name: "CSN", type: "input", side: "left" },
        { number: "5", name: "SCK", type: "input", side: "right" },
        { number: "6", name: "MOSI", type: "input", side: "right" },
        { number: "7", name: "MISO", type: "output", side: "right" },
        { number: "8", name: "IRQ", type: "output", side: "right" },
      ],
    },
  },
  {
    mpn: "TPS27S100BPWP",
    priceUsd: 2.9,
    symbol: {
      libId: "Power_Switch:TPS27S100B",
      refPrefix: "U",
      value: "TPS27S100B",
      description:
        "40V single-channel smart high-side switch, 14-pin HTSSOP. Switches a 24V channel from a 3.3V logic pin, limits its own current, and reports load current on IMON - one analog pin per channel, no shunt in the load path.",
      keywords: "high side switch load driver current sense efuse imon",
      datasheet: "https://www.ti.com/lit/ds/symlink/tps27s100.pdf",
      footprint: "Package_SO:HTSSOP-14-1EP_4.4x5mm_P0.65mm_EP3x5mm",
      pins: [
        { number: "1", name: "NC1", type: "no_connect", side: "left" },
        { number: "2", name: "GND", type: "power_in", side: "left" },
        { number: "3", name: "EN", type: "input", side: "left" },
        { number: "4", name: "NC2", type: "no_connect", side: "left" },
        { number: "5", name: "OUT1", type: "power_out", side: "left" },
        { number: "6", name: "OUT2", type: "power_out", side: "left" },
        { number: "7", name: "OUT3", type: "power_out", side: "left" },
        { number: "8", name: "IN1", type: "power_in", side: "right" },
        { number: "9", name: "IN2", type: "power_in", side: "right" },
        { number: "10", name: "IN3", type: "power_in", side: "right" },
        { number: "11", name: "NC3", type: "no_connect", side: "right" },
        { number: "12", name: "DIAG_EN", type: "input", side: "right" },
        { number: "13", name: "ILIM", type: "passive", side: "right" },
        { number: "14", name: "IMON", type: "output", side: "right" },
      ],
    },
  },
];
