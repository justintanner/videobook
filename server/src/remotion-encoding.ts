type HardwareAcceleration = "if-possible" | "disable";
type EncodedRender<T> = (hardwareAcceleration: HardwareAcceleration) => Promise<T>;

const HARDWARE_ENCODER = /\b(?:h264|hevc|av1)_(?:nvenc|videotoolbox|vaapi|qsv|amf)\b/u;

export function hardwareEncoderFailed(error: unknown): boolean {
  return error instanceof Error && HARDWARE_ENCODER.test(error.message);
}

export function createEncoderFallback(): <T>(render: EncodedRender<T>) => Promise<T> {
  let hardwareWorks = true;
  return async <T>(render: EncodedRender<T>): Promise<T> => {
    if (!hardwareWorks) return render("disable");
    try {
      return await render("if-possible");
    } catch (error) {
      if (!hardwareEncoderFailed(error)) throw error;
      hardwareWorks = false;
      return render("disable");
    }
  };
}

export const renderWithEncoderFallback = createEncoderFallback();
