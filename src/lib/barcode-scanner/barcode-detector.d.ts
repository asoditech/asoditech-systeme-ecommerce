/**
 * Minimal ambient declaration for the native Shape Detection API's
 * `BarcodeDetector` — not yet in TypeScript's own `lib.dom.d.ts`. Declared
 * here rather than pulling in a third-party `@types` package (none is
 * needed for the handful of members this app actually calls). Shape
 * matches the spec: https://wicg.github.io/shape-detection-api/#barcode-detection-api
 */
interface DetectedBarcode {
  readonly rawValue: string;
  readonly format: string;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
  static getSupportedFormats(): Promise<string[]>;
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector;
}
