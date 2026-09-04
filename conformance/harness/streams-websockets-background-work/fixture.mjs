export const STREAM_BASELINE_DATE = "2026-09-04";
export const STREAMED_OCTETS = 65_536;
export const FIXTURE_CHUNK_OCTETS = 4_096;

export function capabilityLock(standardVersion) {
  return {
    schemaVersion: 1,
    format: "edge-canon.streams-websockets-background-work/v1",
    standardVersion,
    baselineDate: STREAM_BASELINE_DATE,
    streams: {
      readable: "whatwg-selected-instance-subset",
      writable: "whatwg-selected-instance-subset",
      transform: "identity-only",
      body: "request-response-byte-stream",
      chunkType: "Uint8Array",
    },
    backgroundWork: {
      api: "context-wait-until",
      settlement: "all-settled-independent",
      reliability: "best-effort-no-retry",
    },
    webSockets: {
      portability: "unavailable-in-reference-intersection",
      sourcePolicy: "reject-before-deploy",
      excludedGlobals: ["WebSocket", "WebSocketPair", "WebSocketServer"],
      globalIsolation: "sealed-undefined-before-module-evaluation",
    },
    limits: {
      streamedOctets: STREAMED_OCTETS,
      fixtureChunkOctets: FIXTURE_CHUNK_OCTETS,
    },
    providerExtensions: "non-portable",
  };
}

export const STREAM_CHUNKS = [
  new Uint8Array([0x65, 0x64, 0x67, 0x65]),
  new Uint8Array([0x2d, 0x63, 0x61, 0x6e, 0x6f, 0x6e]),
  new Uint8Array([0x2d, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]),
];
