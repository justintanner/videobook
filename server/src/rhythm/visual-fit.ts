import type { ClipTransform } from "videobook-engine";

export function fittedTransform(fit: ClipTransform["fit"] = "fit"): ClipTransform {
  return { fit, positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5,
    rotationDegrees: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, opacity: 1, blendMode: "normal" };
}
