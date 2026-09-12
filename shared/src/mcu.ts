// #region MCU pin profiles
// Machine-readable capability data for MCU parts, so questions like "do I have
// enough ADC channels for current sensing, or do I need a multiplexer?" are
// answered from the pinout instead of guessed. Keyed by lib id.

export interface McuPin {
  number: string; // package pin number
  gpio?: number;
  adc?: { unit: 1 | 2; channel: number };
  // Strapping pins latch a boot mode at reset: usable as IO afterwards, but
  // only with the right idle level.
  strapping?: string;
  // Reserved by an on-module function (flash, PSRAM, USB, UART0 console).
  reserved?: string;
  note?: string;
}

export interface McuProfile {
  libId: string;
  name: string;
  logicVoltage: number;
  pins: McuPin[];
  // Design rules that change the answer to a capability question.
  rules: string[];
}

const S3: McuPin[] = [
  { number: "4", gpio: 4, adc: { unit: 1, channel: 3 } },
  { number: "5", gpio: 5, adc: { unit: 1, channel: 4 } },
  { number: "6", gpio: 6, adc: { unit: 1, channel: 5 } },
  { number: "7", gpio: 7, adc: { unit: 1, channel: 6 } },
  { number: "8", gpio: 15, adc: { unit: 2, channel: 4 } },
  { number: "9", gpio: 16, adc: { unit: 2, channel: 5 } },
  { number: "10", gpio: 17, adc: { unit: 2, channel: 6 } },
  { number: "11", gpio: 18, adc: { unit: 2, channel: 7 } },
  { number: "12", gpio: 8, adc: { unit: 1, channel: 7 } },
  { number: "13", gpio: 19, reserved: "USB D- (native USB / USB-Serial-JTAG)" },
  { number: "14", gpio: 20, reserved: "USB D+ (native USB / USB-Serial-JTAG)" },
  { number: "15", gpio: 3, adc: { unit: 1, channel: 2 }, strapping: "JTAG source select, floating by default" },
  { number: "16", gpio: 46, strapping: "ROM message printing, weak pull-down" },
  { number: "17", gpio: 9, adc: { unit: 1, channel: 8 } },
  { number: "18", gpio: 10, adc: { unit: 1, channel: 9 } },
  { number: "19", gpio: 11, adc: { unit: 2, channel: 0 } },
  { number: "20", gpio: 12, adc: { unit: 2, channel: 1 } },
  { number: "21", gpio: 13, adc: { unit: 2, channel: 2 } },
  { number: "22", gpio: 14, adc: { unit: 2, channel: 3 } },
  { number: "23", gpio: 21 },
  { number: "24", gpio: 47 },
  { number: "25", gpio: 48 },
  { number: "26", gpio: 45, strapping: "VDD_SPI voltage, weak pull-down" },
  { number: "27", gpio: 0, strapping: "boot mode, weak pull-up - this is the BOOT button pin" },
  { number: "28", gpio: 35, reserved: "octal PSRAM on R8/R16V modules" },
  { number: "29", gpio: 36, reserved: "octal PSRAM on R8/R16V modules" },
  { number: "30", gpio: 37, reserved: "octal PSRAM on R8/R16V modules" },
  { number: "31", gpio: 38 },
  { number: "32", gpio: 39 },
  { number: "33", gpio: 40 },
  { number: "34", gpio: 41 },
  { number: "35", gpio: 42 },
  { number: "36", gpio: 44, note: "UART0 RX, ROM console" },
  { number: "37", gpio: 43, note: "UART0 TX, ROM console" },
  { number: "38", gpio: 2, adc: { unit: 1, channel: 1 } },
  { number: "39", gpio: 1, adc: { unit: 1, channel: 0 } },
];

export const MCU_PROFILES: Record<string, McuProfile> = {
  "RF_Module:ESP32-S3-WROOM-1": {
    libId: "RF_Module:ESP32-S3-WROOM-1",
    name: "ESP32-S3-WROOM-1",
    logicVoltage: 3.3,
    pins: S3,
    rules: [
      "ADC1 has 10 channels (GPIO1-GPIO10). ADC2 has 10 more, but ADC2 is unusable while Wi-Fi is active - treat ADC2 as unavailable on any board that uses Wi-Fi or ESP-NOW.",
      "ADC input range is 0-3.1V at 12dB attenuation, and the ADC is noisy by SAR standards: for current measurement an I2C sensor (INA226) beats the internal ADC.",
      "GPIO0, GPIO3, GPIO45 and GPIO46 are strapping pins. They are usable as IO but must idle at the right level at reset.",
      "GPIO19/GPIO20 are the native USB pins. Using USB for programming costs those two pins.",
      "GPIO43/GPIO44 are the UART0 console. Free for other use, but you lose the serial log.",
      "GPIO35/36/37 are taken by octal PSRAM on -R8 and -R16V modules. On plain N4/N8 modules they are free.",
      "An I2C bus costs 2 pins total no matter how many sensors hang off it. INA226 has 16 addresses from A0/A1, so 16 current channels need no multiplexer.",
    ],
  },
};

export function mcuProfileFor(libId: string): McuProfile | undefined {
  return MCU_PROFILES[libId];
}
