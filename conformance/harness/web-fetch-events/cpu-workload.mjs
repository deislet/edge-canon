export function runCpuWorkload(iterations) {
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 100_000_000) {
    throw new TypeError("iterations must be a safe integer in 1..=100000000");
  }
  let checksum = 0x811c9dc5;
  for (let index = 0; index < iterations; index += 1) {
    checksum = Math.imul(checksum ^ index, 0x01000193) >>> 0;
  }
  return checksum;
}
