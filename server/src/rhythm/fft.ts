export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n < 2 || imag.length !== n || (n & (n - 1)) !== 0) {
    throw new Error("FFT length must be a power of two");
  }
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const realSwap = real[i]!;
      real[i] = real[j]!;
      real[j] = realSwap;
      const imagSwap = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = imagSwap;
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      const half = length / 2;
      for (let offset = 0; offset < half; offset += 1) {
        const evenReal = real[start + offset]!;
        const evenImag = imag[start + offset]!;
        const oddIndex = start + offset + half;
        const oddReal = real[oddIndex]! * twiddleReal - imag[oddIndex]! * twiddleImag;
        const oddImag = real[oddIndex]! * twiddleImag + imag[oddIndex]! * twiddleReal;
        real[start + offset] = evenReal + oddReal;
        imag[start + offset] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}
