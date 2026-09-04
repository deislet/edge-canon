import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runCpuWorkload } from "./cpu-workload.mjs";

const MINIMUM_MILLISECONDS = 8;
const MAXIMUM_MILLISECONDS = 10;
const MAXIMUM_ITERATIONS = 100_000_000;

function measure(iterations) {
  const samples = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const start = process.cpuUsage();
    runCpuWorkload(iterations);
    const usage = process.cpuUsage(start);
    samples.push((usage.user + usage.system) / 1_000);
  }
  return samples.sort((left, right) => left - right)[1];
}

export function calibrate() {
  runCpuWorkload(10_000);
  let lowerIterations = 1;
  let upperIterations = 10_000;
  let measured = measure(upperIterations);
  while (measured < MINIMUM_MILLISECONDS && upperIterations < MAXIMUM_ITERATIONS) {
    lowerIterations = upperIterations;
    upperIterations = Math.min(upperIterations * 2, MAXIMUM_ITERATIONS);
    measured = measure(upperIterations);
  }
  if (measured < MINIMUM_MILLISECONDS) {
    throw new Error("could not calibrate the standard CPU workload to at least 8 ms");
  }

  let best = { iterations: upperIterations, milliseconds: measured };
  for (let attempt = 0; attempt < 24 && lowerIterations + 1 < upperIterations; attempt += 1) {
    const candidate = Math.floor((lowerIterations + upperIterations) / 2);
    const milliseconds = measure(candidate);
    if (milliseconds < MINIMUM_MILLISECONDS) {
      lowerIterations = candidate;
    } else {
      upperIterations = candidate;
      best = { iterations: candidate, milliseconds };
    }
  }
  if (best.milliseconds > MAXIMUM_MILLISECONDS) {
    throw new Error(
      `CPU calibration is too noisy: ${best.milliseconds.toFixed(3)} ms is outside 8..10 ms`,
    );
  }

  const workload = fs.readFileSync(new URL("./cpu-workload.mjs", import.meta.url));
  return {
    iterations: best.iterations,
    calibratedCpuMilliseconds: best.milliseconds,
    calibratedWorkSha256: createHash("sha256").update(workload).digest("hex"),
  };
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(calibrate(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`EC-WEB CPU calibration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
