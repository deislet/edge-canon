export const API_BASELINE_DATE = "2026-09-04";

export function capabilityLock(standardVersion) {
  return {
    schemaVersion: 1,
    format: "edge-canon.web-platform-apis/v1",
    standardVersion,
    baselineDate: API_BASELINE_DATE,
    apis: {
      url: "whatwg-selected-subset",
      headers: "fetch-sort-and-combine",
      request: "fetch-selected-subset",
      response: "fetch-selected-subset",
      encoding: "utf-8",
      base64: "html-binary-string",
      abort: "controller-signal-event",
      crypto: "random-uuid-sha256",
      fetch: "http-https-fetch-redirect",
      timers: "timeout-interval-basic",
    },
    limits: {
      bodyReaderOctets: 1_000_000,
      headerNameAsciiCharacters: 128,
      headerValueAsciiCharacters: 4_095,
      randomValuesOctets: 65_536,
    },
    providerExtensions: "non-portable",
  };
}

export const URL_VECTORS = [
  {
    input: "HTTPS://ExAmPle.COM:443/a//b/../c?q=hello world&q=%2F#frag",
    expected: "https://example.com/a//c?q=hello%20world&q=%2F#frag",
  },
  {
    input: "../d e?x=✓",
    base: "https://EXAMPLE.com:443/a/b/",
    expected: "https://example.com/a/d%20e?x=%E2%9C%93",
  },
];

export const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const CAPACITY_BODY_BYTE = 0x61;
